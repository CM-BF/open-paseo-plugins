// Keeps the session index current: one agent after each of its turns, every listed agent at start.
// Pages forward through the daemon's projected timeline with an `after` cursor; an epoch change
// (the daemon rebuilt the timeline) re-indexes that agent from the start.

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
}

const PAGE = 100;
const MAX_PAGES = 400;

export class SessionSync {
  private running = new Map<string, Promise<number>>();
  private again = new Set<string>();
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
  sync(meta: SessionMeta): Promise<number> {
    if (this.stopped || !this.enabled()) return Promise.resolve(0);
    const current = this.running.get(meta.agentId);
    if (current) {
      this.again.add(meta.agentId);
      return current;
    }
    const run = this.syncNow(meta)
      .catch((error) => {
        console.error(`[learning-loop] indexing ${meta.agentId} failed: ${describeError(error)}`);
        return 0;
      })
      .finally(() => {
        this.running.delete(meta.agentId);
        if (this.again.delete(meta.agentId)) void this.sync(meta);
      });
    this.running.set(meta.agentId, run);
    return run;
  }

  private async syncNow(meta: SessionMeta): Promise<number> {
    const generation = this.generation;
    this.index.upsertSession(meta);
    const state = this.index.syncState(meta.agentId);
    let cursor: TimelineCursor | null = state?.epoch ? { epoch: state.epoch, seq: state.lastSeq } : null;
    let reset = false;
    let restarted = false;
    let indexed = 0;
    if (!cursor) {
      const head = await this.source.fetch(meta.agentId, { direction: "tail", limit: 1 });
      if (head.error) throw new Error(head.error);
      cursor = { epoch: head.epoch, seq: Math.max(-1, head.window.minSeq - 1) };
      reset = true;
    }
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.source.fetch(meta.agentId, { direction: "after", cursor, limit: PAGE });
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
      if (this.stopped || generation !== this.generation || !this.enabled()) return indexed;
      this.index.applyPage(meta.agentId, result.epoch, messages, last, reset);
      this.index.prune(this.retentionDays());
      indexed += messages.length;
      reset = false;
      if (!result.hasNewer || !result.endCursor || result.endCursor.seq <= cursor.seq) break;
      cursor = result.endCursor;
    }
    this.lastSyncAt = new Date().toISOString();
    return indexed;
  }

  async stop(): Promise<void> { this.stopped = true; this.generation += 1; this.again.clear(); await Promise.allSettled(this.running.values()); }

  clear(): void { this.generation += 1; this.again.clear(); this.index.clear(); }

  /** Indexes every listed agent, one at a time, so the daemon is never flooded. */
  async backfill(signal?: AbortSignal): Promise<number> {
    if (this.backfilling || !this.enabled()) return 0;
    this.backfilling = true;
    let total = 0;
    try {
      const agents = await this.source.listAgents();
      for (const meta of agents) {
        if (signal?.aborted) break;
        total += await this.sync(meta);
      }
    } finally {
      this.backfilling = false;
    }
    return total;
  }
}
