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
    if (this.entries.some((existing) => existing.id === entry.id)) return;
    this.entries.push({ ...entry, createdAt: new Date().toISOString(), attempts: 0, lastError: null });
    this.persist();
    this.kick(entry.agentId);
  }

  pendingFor(agentId: string): number {
    return this.entries.filter((entry) => entry.agentId === agentId).length;
  }

  kickAll(): void {
    for (const agentId of new Set(this.entries.map((entry) => entry.agentId))) this.kick(agentId);
  }

  kick(agentId: string): void {
    if (!this.loaded || this.busy.has(agentId)) return;
    if (!this.entries.some((entry) => entry.agentId === agentId)) return;
    this.busy.add(agentId);
    void this.deliver(agentId)
      .catch((error) => log(`notification delivery to ${agentId} failed: ${describeError(error)}`))
      .finally(() => this.busy.delete(agentId));
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
    const fresh = await handle.refresh().catch(() => null);
    if (!fresh || fresh.agent.archivedAt) {
      this.dropFor(agentId);
      return;
    }
    const status = fresh.agent.status;
    if (status === "running" || status === "initializing") return;
    if (fresh.agent.activeTurn) return;
    const next = this.entries.find((entry) => entry.agentId === agentId);
    if (!next) return;
    next.attempts++;
    try {
      await handle.send(next.text, { messageId: next.id });
      this.entries = this.entries.filter((entry) => entry !== next);
      this.persist();
      this.onDelivered(next);
    } catch (error) {
      next.lastError = describeError(error);
      this.persist();
    }
  }

  private persist(): void {
    void this.writer.write(`${JSON.stringify({ version: 1, entries: this.entries }, null, 1)}\n`);
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.writer.idle();
  }
}
