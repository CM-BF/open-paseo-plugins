import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PaseoApi } from "./gate";
import { describeError, log, SerialWriter, unref } from "./util";

export interface OutboxEntry {
  id: string;
  agentId: string;
  text: string;
  createdAt: string;
  attempts: number;
  lastError: string | null;
  retryAfter?: number;
  uncertain?: boolean;
  /** A newer payload uses a fresh receipt id; this attempted receipt is never replayed. */
  superseded?: boolean;
  logicalId?: string;
}

const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const RECONCILE_MS = 20_000;

/**
 * Delivers task notifications to launching agents. A message waits while its agent is mid-turn
 * and goes out when the agent is idle; the outbox is saved so a plugin restart loses nothing.
 */
export class Notifier {
  private entries: OutboxEntry[] = [];
  private readonly writer: SerialWriter;
  private readonly busy = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private loaded = false;
  private paused = false;
  private readonly deliveries = new Set<Promise<void>>();
  private readonly sending = new Set<string>();
  private readonly replacements = new Map<string, { id: string; text: string }>();

  constructor(
    private readonly file: string,
    private readonly paseo: () => PaseoApi | null,
    private readonly onDelivered: (entry: OutboxEntry) => void = () => undefined,
  ) {
    this.writer = new SerialWriter(file);
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as { entries?: OutboxEntry[] };
      const loaded = Array.isArray(parsed.entries) ? parsed.entries : [];
      const known = new Set(this.entries.map((entry) => entry.id));
      this.entries.push(...loaded.filter((entry) => !known.has(entry.id)));
    } catch {
      // No outbox yet.
    }
    this.loaded = true;
    this.timer = unref(setInterval(() => this.kickAll(), RECONCILE_MS));
  }

  add(entry: Omit<OutboxEntry, "attempts" | "lastError" | "createdAt">): void {
    const existing = this.entries.find((candidate) => candidate.id === entry.id);
    if (existing) {
      if (existing.attempts === 0 && existing.text !== entry.text) {
        existing.text = entry.text;
        this.persist();
      }
      return;
    }
    this.entries.push({ ...entry, createdAt: new Date().toISOString(), attempts: 0, lastError: null });
    this.persist();
    this.kick(entry.agentId);
  }

  updatePending(id: string, text: string): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry || entry.attempts !== 0 || entry.text === text) return;
    entry.text = text;
    this.persist();
  }

  /** Retire stale payloads without changing or replaying attempted message ids. */
  supersede(prefix: string): void {
    this.entries = this.entries.filter((entry) => {
      if (!entry.id.startsWith(prefix)) return true;
      if (entry.attempts === 0) return false;
      entry.superseded = true;
      return true;
    });
    this.persist();
  }

  pendingIds(agentId?: string): string[] {
    return [...new Set(this.entries
      .filter((entry) => !entry.superseded && (agentId === undefined || entry.agentId === agentId))
      .map((entry) => entry.logicalId ?? entry.id))];
  }

  /** Known failed receipts can be superseded; an uncertain receipt must be reconciled first. */
  replacePending(id: string, text: string): void {
    const entry = this.entries.find((candidate) => !candidate.superseded && (candidate.logicalId ?? candidate.id) === id);
    if (!entry || entry.text === text || entry.uncertain) return;
    if (this.sending.has(entry.id)) {
      this.replacements.set(entry.id, { id, text });
      return;
    }
    if (entry.attempts === 0) {
      this.updatePending(entry.id, text);
      return;
    }
    entry.superseded = true;
    this.add({ id: `${id}-revision-${randomUUID()}`, logicalId: id, agentId: entry.agentId, text });
  }

  pendingFor(agentId: string): number {
    return this.entries.filter((entry) => entry.agentId === agentId).length;
  }

  kickAll(): void {
    for (const agentId of new Set(this.entries.map((entry) => entry.agentId))) this.kick(agentId);
  }

  kick(agentId: string): void {
    if (!this.loaded || this.paused || this.busy.has(agentId)) return;
    if (!this.entries.some((entry) => entry.agentId === agentId)) return;
    this.busy.add(agentId);
    const delivery = this.deliver(agentId)
      .catch((error) => log(`notification delivery to ${agentId} failed: ${describeError(error)}`))
      .finally(() => { this.busy.delete(agentId); this.deliveries.delete(delivery); });
    this.deliveries.add(delivery);
  }

  dropFor(agentId: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.agentId !== agentId);
    if (this.entries.length !== before) this.persist();
  }

  private async deliver(agentId: string): Promise<void> {
    const paseo = this.paseo();
    if (!paseo) return;
    const now = Date.now();
    const expired = this.entries.filter((entry) => entry.agentId === agentId && now - Date.parse(entry.createdAt) > MAX_AGE_MS);
    if (expired.length > 0) {
      this.entries = this.entries.filter((entry) => !expired.includes(entry));
      this.persist();
    }
    const handle = paseo.agents.ref(agentId);
    // A transport failure says nothing about whether the agent still exists.
    const fresh = await handle.refresh();
    if (this.paused) return;
    if (!fresh || fresh.agent.archivedAt) {
      this.dropFor(agentId);
      return;
    }
    const status = fresh.agent.status;
    if (status === "running" || status === "initializing") return;
    if (fresh.agent.activeTurn) return;
    const next = this.entries.find((entry) => entry.agentId === agentId && !entry.uncertain && !entry.superseded && (entry.retryAfter ?? 0) <= now);
    if (!next) return;
    next.attempts++;
    this.sending.add(next.id);
    try {
      await handle.send(next.text, { messageId: next.id, activeTurnBehavior: "steer" });
      this.entries = this.entries.filter((entry) => entry !== next);
      this.persist();
      this.onDelivered(next);
    } catch (error) {
      next.lastError = describeError(error);
      // Paseo retains pending receipts after an ambiguous send. Replaying that key can
      // never succeed; retain it for inspection without blocking later results.
      next.uncertain = /agent_request_(outcome_unknown|key_conflict)/.test(next.lastError);
      next.retryAfter = Date.now() + Math.min(300_000, RECONCILE_MS * 2 ** Math.min(next.attempts - 1, 4));
      if (next.uncertain) log(`notification ${next.id} has an uncertain delivery receipt; retained in ${this.file}`);
      this.persist();
    } finally {
      this.sending.delete(next.id);
      const replacement = this.replacements.get(next.id);
      this.replacements.delete(next.id);
      // A successful send already delivered the result; an ambiguous receipt must not be
      // bypassed with another id. A later mode-change notice carries the current guidance.
      if (replacement && next.lastError && !next.uncertain && !next.superseded) this.replacePending(replacement.id, replacement.text);
    }
  }

  private persist(): void {
    void this.writer.write(`${JSON.stringify({ version: 1, entries: this.entries }, null, 1)}\n`);
  }

  pause(): void {
    this.paused = true;
    if (this.timer) clearInterval(this.timer);
  }

  async dispose(): Promise<void> {
    this.pause();
    await Promise.allSettled([...this.deliveries]);
    await this.writer.idle();
  }
}
