import type { InboxScope } from "../shared/inbox";
import { chronological, type InboxPublicOutboxItem, type InboxStore } from "./inbox-store";
import { AUTOMATION_ACTOR, type InboxConnections } from "./inbox-sync";

/**
 * Pushes the human's public-thread decisions to the backend (public-threads DESIGN §5.4.2, §12 A14): hide, show,
 * resolve, reopen, page pauses and bulk hides. Independent of the comment coordinator (server/inbox-auto.ts).
 * Values are absolute, so a retry or an hourly re-push after a backend restore is harmless.
 */
export const PUBLIC_RETRY_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000] as const;
export const PUBLIC_REPUSH_MS = 3_600_000;
type Clock = { now(): number; setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
const realClock: Clock = { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export class PublicStateOutbox {
  private readonly scopes = new Map<string, { scope: InboxScope; failures: number; timer?: unknown; running?: Promise<void>; again?: boolean }>();
  private readonly clock: Clock;
  private repush?: unknown;
  private closed = false;
  private unsubscribe?: () => void;
  constructor(private readonly options: { inbox: InboxStore; connections: InboxConnections; log(line: string): void; clock?: Clock }) { this.clock = options.clock ?? realClock; }

  /** Flushes every Board with a connection once, re-pushes explicit values, and listens for new decisions. */
  async start(): Promise<void> {
    if (this.closed) return;
    this.unsubscribe = this.options.inbox.onPublicChange(scope => this.kick(scope));
    for (const scope of await this.options.connections.scopes()) { await this.flush(scope).catch(error => this.options.log(`public outbox: ${String(error)}`)); await this.repushScope(scope); }
    this.scheduleRepush();
  }
  /** Flush soon (debounced 50 ms). */
  kick(scope: InboxScope): void {
    if (this.closed) return;
    const entry = this.entry(scope);
    if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer);
    entry.failures = 0;
    entry.timer = this.clock.setTimeout(() => { entry.timer = undefined; void this.flush(scope).catch(error => this.options.log(`public outbox: ${String(error)}`)); }, 50);
  }
  /** One pass over the scope's pending items; concurrent calls coalesce into one more pass. Resolves when done. */
  flush(scope: InboxScope): Promise<void> {
    const entry = this.entry(scope);
    if (entry.running) { entry.again = true; return entry.running; }
    entry.running = (async () => {
      try {
        do { entry.again = false; await this.pass(entry); } while (entry.again && !this.closed);
      } finally { entry.running = undefined; }
    })();
    return entry.running;
  }
  close(): void {
    this.closed = true; this.unsubscribe?.();
    for (const entry of this.scopes.values()) if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer);
    if (this.repush !== undefined) this.clock.clearTimeout(this.repush);
  }

  private entry(scope: InboxScope) {
    const key = JSON.stringify([scope.boardId, scope.expectedCreatedAt]);
    let entry = this.scopes.get(key);
    if (!entry) { entry = { scope, failures: 0 }; this.scopes.set(key, entry); }
    return entry;
  }
  private async pass(entry: { scope: InboxScope; failures: number; timer?: unknown }): Promise<void> {
    const { inbox, connections } = this.options, scope = entry.scope;
    let items: InboxPublicOutboxItem[];
    try { items = await inbox.publicOutbox(scope, AUTOMATION_ACTOR); } catch { return; }
    if (!items.length || this.closed) return;
    const sources = new Map((await connections.runtimeSources(scope)).map(source => [source.sourceId, source]));
    let transient = false, waitMs = 0;
    for (const item of items) {
      if (this.closed) return;
      const source = sources.get(item.sourceId);
      if (!source || !source.ready || !source.enabled) { transient = true; continue; }
      await connections.withSourceLock(scope, source.sourceId, async () => {
        const outcome = await connections.postPublic(source, item);
        const ingress = { kind: "ingress" as const, sourceId: source.sourceId, deploymentId: source.deploymentId, credential: source.credential };
        if (outcome.kind === "ok") await inbox.confirmPublic(scope, item, outcome.echo, ingress);
        // The visitor withdrew it meanwhile: record that (it stays hidden) instead of a failure to retry.
        else if (outcome.kind === "fail" && outcome.code === "withdrawn" && item.kind === "state") await inbox.confirmPublic(scope, item, { withdrawn: true }, ingress);
        else if (outcome.kind === "fail") await inbox.failPublic(scope, item, outcome.message, ingress);
        else { transient = true; waitMs = Math.max(waitMs, outcome.retryAfterMs ?? 0); this.options.log(`public outbox: ${outcome.error}`); }
      }).catch(error => { transient = true; this.options.log(`public outbox: ${String(error)}`); });
    }
    if (transient && !this.closed) {
      const delay = Math.max(PUBLIC_RETRY_MS[Math.min(entry.failures, PUBLIC_RETRY_MS.length - 1)], waitMs);
      entry.failures++;
      if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer);
      entry.timer = this.clock.setTimeout(() => { entry.timer = undefined; void this.flush(scope).catch(error => this.options.log(`public outbox: ${String(error)}`)); }, delay);
    } else entry.failures = 0;
  }
  /**
   * After a backend restore the page may show what the human hid: send every value a human set again (§12 A14), in the
   * order the human set them. Bulk hides mirror into the visitor's records (inbox-public-ledger.ts), so a record re-sent
   * after its bulk hide carries hidden: true and nothing hidden is shown, not even between two requests. Bulk shows
   * (隐藏这位访客… undone) are not re-sent: after a restore their known comments are shown again one by one, and
   * the rest stays hidden, which errs on the side of hiding.
   */
  private async repushScope(scope: InboxScope): Promise<void> {
    if (this.closed) return;
    try {
      const ledger = await this.options.inbox.publicLedger(scope, AUTOMATION_ACTOR);
      const sources = new Map((await this.options.connections.runtimeSources(scope)).map(source => [source.sourceId, source]));
      const records = ledger.records.filter(record => record.explicit && !record.pending && !record.error && !(record.withdrawn && !record.hidden))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0)).slice(-500);
      const items = chronological([
        ...records.map(record => ({ at: record.updatedAt, rank: 1, item: { kind: "state" as const, sourceId: record.sourceId, externalId: record.externalId, send: { hidden: record.hidden, ...(record.parentId === undefined ? { resolved: record.resolved } : {}) } } })),
        ...ledger.actions.filter(action => !action.pending && !action.error && !(action.kind === "hide-visitor" && !action.value)).map(action => ({ at: action.updatedAt, rank: 0, item: { kind: "action" as const, sourceId: action.sourceId, id: action.id, action } })),
      ]);
      for (const item of items) {
        const source = sources.get(item.sourceId);
        if (this.closed || !source?.ready || !source.enabled) continue;
        // Re-pushed values were confirmed before; nothing is recorded unless the visitor withdrew the comment since.
        await this.options.connections.withSourceLock(scope, source.sourceId, async () => {
          const outcome = await this.options.connections.postPublic(source, item);
          if (outcome.kind === "fail" && outcome.code === "withdrawn" && item.kind === "state")
            await this.options.inbox.confirmPublic(scope, item, { withdrawn: true }, { kind: "ingress", sourceId: source.sourceId, deploymentId: source.deploymentId, credential: source.credential });
        }).catch(() => undefined);
      }
    } catch (error) { this.options.log(`public re-push: ${String(error)}`); }
  }
  private scheduleRepush() {
    if (this.closed) return;
    this.repush = this.clock.setTimeout(() => {
      void (async () => { for (const scope of await this.options.connections.scopes().catch(() => [])) await this.repushScope(scope); })().finally(() => this.scheduleRepush());
    }, PUBLIC_REPUSH_MS);
  }
}
