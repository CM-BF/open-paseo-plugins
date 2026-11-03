import type { Board } from "../shared/contracts";
import type { BoardLiveStatus } from "./board-events";

/** A successful connection edge can retry failed reads even when its event
 * cursor is unchanged. Repeated healthy compact probes are not recovery edges. */
export function isBoardReadRecovery(previous: BoardLiveStatus, next: BoardLiveStatus): boolean {
  const healthy = (status: BoardLiveStatus) => status === "connected" || status === "checking";
  return healthy(next) && !healthy(previous);
}

interface RecoveringBoardRead {
  readonly promise?: Promise<unknown>;
  readonly state: { status: string; fetchStatus: string; error: unknown };
}

/** A connection can recover before the last failed read settles. Observe only
 * the read already present at that edge, never subsequent healthy polling. */
export class BoardReadRecovery {
  private generation = 0;
  private pending = new WeakMap<RecoveringBoardRead, {
    promise: Promise<unknown>; generation: number; current(): boolean; retry(): void;
  }>();

  invalidate(): void { this.generation++; }

  watch(query: RecoveringBoardRead, current: () => boolean, retry: () => void): void {
    const promise = query.promise;
    if (!promise || query.state.fetchStatus !== "fetching") return;
    const previous = this.pending.get(query);
    // Reconnect bursts share the same outstanding read and one settlement callback.
    if (previous?.promise === promise) {
      Object.assign(previous, { generation: this.generation, current, retry }); return;
    }
    const watched = { promise, generation: this.generation, current, retry };
    this.pending.set(query, watched);
    void promise.then(() => {
      if (this.pending.get(query) === watched) this.pending.delete(query);
    }, error => {
      if (this.pending.get(query) !== watched) return;
      this.pending.delete(query);
      // Query commits its final error before notifying this observer. A newer
      // read, cancellation, cache replacement or connection generation wins.
      if (watched.generation !== this.generation || !watched.current()
        || query.promise && query.promise !== promise || query.state.status !== "error"
        || query.state.fetchStatus !== "idle" || query.state.error !== error) return;
      watched.retry();
    });
  }
}

/** Seen receipts are monotonic within the bounded update window, independently of content revision. */
export function mergeBoardSnapshot(previous: Board | null | undefined, incoming: Board): Board {
  if (!previous || previous.id !== incoming.id) return incoming;
  const current = previous.revision > incoming.revision ? previous : incoming;
  const live = new Set((current.updates ?? []).map(update => update.id));
  const seen = new Set([...(previous.seenUpdateIds ?? []), ...(incoming.seenUpdateIds ?? [])]);
  return { ...current, seenUpdateIds: [...seen].filter(id => live.has(id)) };
}

/** A read/mutation keeps the authority that existed when it started. Epoch
 * names may be reused after another reset, so identity also carries a local
 * generation. The wrapper references the existing Board; it is not a second cache. */
export interface BoardCacheEpochToken { readonly name?: string; readonly generation: number }
export interface BoardCacheEntry {
  epoch: BoardCacheEpochToken | undefined;
  board: Board | null | undefined;
  unchanged?: true;
}
type PreviousBoardCache = BoardCacheEntry | Board | null | undefined;
export const isBoardCacheEntry = (value: unknown): value is BoardCacheEntry => !!value && typeof value === "object" && "epoch" in value && "board" in value;

/** Also allows a cached first paint from a previous client version. Such a
 * legacy Board has no epoch provenance and cannot defeat a current read. */
export function boardFromCache(value: PreviousBoardCache): Board | null | undefined {
  return isBoardCacheEntry(value) ? value.board : value;
}

export class BoardCacheAuthority {
  private token: BoardCacheEpochToken = Object.freeze({ generation: 0 });
  current(): BoardCacheEpochToken { return this.token; }
  observe(name: string): void {
    if (name !== this.token.name) this.token = Object.freeze({ name, generation: this.token.generation + 1 });
  }
  /** Called at the final React Query commit, not just before resolving the RPC.
   * This also fences late null/deletion replies and mutation acknowledgements. */
  merge(previous: PreviousBoardCache, incoming: BoardCacheEntry): BoardCacheEntry {
    const prior = isBoardCacheEntry(previous) ? previous : previous === undefined ? undefined : { epoch: undefined, board: previous };
    if (incoming.epoch !== this.token || incoming.unchanged) return prior ?? { epoch: undefined, board: undefined };
    if (prior?.epoch !== this.token || !prior.board || !incoming.board) return incoming;
    return { epoch: this.token, board: mergeBoardSnapshot(prior.board, incoming.board) };
  }
}
