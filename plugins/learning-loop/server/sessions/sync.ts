// Keeps the session index current from a read-only history source. Reading history must never
// resume an agent/provider. One queue bounds work across startup, lifecycle and manual requests.

import { describeError } from "../files";
import type { SessionIndex, SessionMeta } from "./index";
import { toIndexed, type TimelineEntryLike } from "./transcript";

export interface TimelineCursor {
  epoch: string;
  seq: number;
}

export interface TimelinePage {
  epoch: string;
  reset: boolean;
  staleCursor: boolean;
  gap: boolean;
  window: { minSeq: number; maxSeq: number; nextSeq: number };
  endCursor: TimelineCursor | null;
  hasNewer: boolean;
  entries: readonly TimelineEntryLike[];
  error: string | null;
}

export interface SyncSource {
  fetch(agentId: string, options: { direction: "tail" | "after"; cursor?: TimelineCursor; limit: number }): Promise<TimelinePage>;
  listAgents(): Promise<SessionMeta[]>;
  release?(agentId: string): void;
}

const PAGE = 100;
// Up to 40,000 entries plus one probe when an existing index changes epoch.
const MAX_PAGES = 401;

export class SessionSync {
  private running = new Map<string, Promise<number>>();
  private again = new Map<string, { meta: SessionMeta; generation: number; signal?: AbortSignal }>();
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private stopped = false;
  lastSyncAt: string | null = null;
  backfilling = false;

  constructor(
    private readonly index: SessionIndex,
    private readonly source: SyncSource,
    private readonly enabled: () => boolean = () => true,
    private readonly retentionDays: () => number = () => 0,
  ) {}

  /** Coalesces concurrent requests for one agent: at most one run plus one follow-up. */
  sync(meta: SessionMeta, signal?: AbortSignal): Promise<number> {
    if (this.stopped || signal?.aborted || !this.enabled()) return Promise.resolve(0);
    const current = this.running.get(meta.agentId);
    if (current) {
      this.again.set(meta.agentId, { meta, generation: this.generation, signal });
      return current;
    }
    const generation = this.generation;
    const run = this.queue.then(() => {
      if (!this.canContinue(generation, signal)) return 0;
      return this.syncNow(meta, generation, signal);
    })
      .catch((error) => {
        console.error(`[learning-loop] indexing ${meta.agentId} failed: ${describeError(error)}`);
        return 0;
      })
      .finally(() => {
        this.source.release?.(meta.agentId);
        this.running.delete(meta.agentId);
        const next = this.again.get(meta.agentId);
        this.again.delete(meta.agentId);
        if (next && this.canContinue(next.generation, next.signal)) void this.sync(next.meta, next.signal);
      });
    this.queue = run.then(() => undefined);
    this.running.set(meta.agentId, run);
    return run;
  }

  private canContinue(generation: number, signal?: AbortSignal): boolean {
    return !this.stopped && !signal?.aborted && generation === this.generation && this.enabled();
  }

  private async syncNow(meta: SessionMeta, generation: number, signal?: AbortSignal): Promise<number> {
    this.index.upsertSession(meta);
    const state = this.index.syncState(meta.agentId);
    let cursor: TimelineCursor | null = state?.epoch ? { epoch: state.epoch, seq: state.lastSeq } : null;
    let reset = false;
    let restarted = false;
    let indexed = 0;
    if (!cursor) {
      const head = await this.source.fetch(meta.agentId, { direction: "tail", limit: 1 });
      if (!this.canContinue(generation, signal)) return 0;
      if (head.error) throw new Error(head.error);
      cursor = { epoch: head.epoch, seq: Math.max(-1, head.window.minSeq - 1) };
      reset = true;
    }
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (!this.canContinue(generation, signal)) return indexed;
      const result = await this.source.fetch(meta.agentId, { direction: "after", cursor, limit: PAGE });
      if (!this.canContinue(generation, signal)) return indexed;
      if (result.error) throw new Error(result.error);
      if (result.reset || result.staleCursor || result.gap) {
        if (restarted) break;
        restarted = true;
        reset = true;
        cursor = { epoch: result.epoch, seq: Math.max(-1, result.window.minSeq - 1) };
        continue;
      }
      const messages = result.entries.flatMap((entry) => {
        const message = toIndexed(entry);
        return message ? [message] : [];
      });
      const last = result.endCursor?.seq ?? cursor.seq;
      this.index.applyPage(meta.agentId, result.epoch, messages, last, reset);
      indexed += messages.length;
      reset = false;
      if (!result.hasNewer || !result.endCursor || result.endCursor.seq <= cursor.seq) break;
      cursor = result.endCursor;
    }
    this.index.prune(this.retentionDays());
    this.lastSyncAt = new Date().toISOString();
    return indexed;
  }

  async stop(): Promise<void> { this.stopped = true; this.generation += 1; this.again.clear(); await Promise.allSettled(this.running.values()); }

  clear(): void { this.generation += 1; this.again.clear(); this.index.clear(); }

  /** Scans persisted history sequentially without opening any agent runtime. */
  async backfill(signal?: AbortSignal): Promise<number> {
    if (this.backfilling || this.stopped || signal?.aborted || !this.enabled()) return 0;
    const generation = this.generation;
    this.backfilling = true;
    let total = 0;
    try {
      const agents = await this.source.listAgents();
      for (const meta of agents) {
        if (signal?.aborted || !this.canContinue(generation)) break;
        total += await this.sync(meta, signal);
      }
    } finally {
      this.backfilling = false;
    }
    return total;
  }
}
