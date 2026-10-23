import type { PaseoAccess } from "./access";
import type { OutboxEntry, Store } from "./store";
import { describeError, log } from "./util";

const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

export interface OutboxDeps {
  store: Store;
  access: PaseoAccess;
  onDelivered(entry: OutboxEntry): void;
  onDropped(entry: OutboxEntry, reason: string): void;
  /** The assistant agent is gone (archived or deleted). */
  onAssistantGone(): void;
}

/**
 * Messages from the plugin to the assistant chat. One goes out at a time and only while the chat
 * is idle with no approval pending, so the plugin never interrupts the user or the assistant; the
 * next one waits for the turn it started to end. Entries are saved, so a restart loses nothing.
 */
export class Outbox {
  private delivering: Promise<void> | null = null;
  private paused = false;

  constructor(private readonly deps: OutboxDeps) {}

  add(entry: Omit<OutboxEntry, "createdAt" | "attempts" | "lastError" | "retryAfter">): boolean {
    const state = this.deps.store.state;
    if (state.outbox.some((existing) => existing.id === entry.id)) return false;
    state.outbox.push({ ...entry, createdAt: new Date().toISOString(), attempts: 0, lastError: null, retryAfter: null });
    this.deps.store.save();
    this.kick();
    return true;
  }

  get pending(): readonly OutboxEntry[] {
    return this.deps.store.state.outbox;
  }

  kick(): void {
    if (this.paused || this.delivering || this.deps.store.state.outbox.length === 0) return;
    this.delivering = this.deliver()
      .catch((error) => log(`delivery to the assistant failed: ${describeError(error)}`))
      .finally(() => {
        this.delivering = null;
      });
  }

  private async deliver(): Promise<void> {
    const state = this.deps.store.state;
    const assistant = state.assistant;
    if (!assistant || assistant.archivedAt) return;
    const now = Date.now();
    for (const entry of state.outbox.filter((candidate) => now - Date.parse(candidate.createdAt) > MAX_AGE_MS)) {
      state.outbox = state.outbox.filter((candidate) => candidate !== entry);
      this.deps.onDropped(entry, "it waited more than two days for the chat to be free");
    }
    const next = state.outbox.find((entry) => (entry.retryAfter ?? 0) <= now);
    if (!next) return;
    const paseo = await this.deps.access.get();
    const handle = paseo.agents.ref(assistant.agentId);
    const fresh = await handle.refresh();
    if (this.paused) return;
    if (!fresh || fresh.agent.archivedAt) {
      this.deps.onAssistantGone();
      return;
    }
    const agent = fresh.agent;
    if (agent.status === "running" || agent.status === "initializing" || agent.activeTurn) return;
    if ((agent.pendingPermissions ?? []).length > 0) return;
    next.attempts++;
    try {
      // The message id makes a retried send idempotent on the daemon.
      await handle.send(next.text, { messageId: next.id, activeTurnBehavior: "steer" });
      state.outbox = state.outbox.filter((entry) => entry !== next);
      this.deps.store.save();
      this.deps.onDelivered(next);
    } catch (error) {
      const message = describeError(error);
      if (/agent_request_(outcome_unknown|key_conflict)/.test(message)) {
        // The daemon holds a receipt for this id; replaying it can never succeed.
        state.outbox = state.outbox.filter((entry) => entry !== next);
        this.deps.store.save();
        this.deps.onDropped(next, `the delivery outcome is unknown (${message})`);
        return;
      }
      next.lastError = message;
      next.retryAfter = Date.now() + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(next.attempts - 1, 6));
      this.deps.store.save();
      log(`could not deliver ${next.id} (attempt ${next.attempts}): ${message}`);
    }
  }

  async dispose(): Promise<void> {
    this.paused = true;
    await this.delivering;
  }
}
