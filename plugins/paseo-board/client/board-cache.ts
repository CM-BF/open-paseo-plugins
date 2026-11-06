import type { Board, BoardSummary } from "../shared/contracts";
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
  if (!previous || previous.id !== incoming.id || previous.createdAt !== incoming.createdAt) return incoming;
  const current = previous.revision > incoming.revision ? previous : incoming;
  const live = new Set((current.updates ?? []).map(update => update.id));
  const seen = new Set([...(previous.seenUpdateIds ?? []), ...(incoming.seenUpdateIds ?? [])]);
  return { ...current, seenUpdateIds: [...seen].filter(id => live.has(id)) };
}

/** A read/mutation keeps the authority that existed when it started. Epoch
 * names may be reused after another reset, so identity also carries a local
 * generation. The wrapper references the existing Board; it is not a second cache. */
export interface BoardCacheEpochToken { readonly name?: string; readonly generation: number }
export interface BoardCacheEntityToken {
  readonly boardId: string;
  /** undefined = not indexed yet; null = absent from an authoritative index. */
  readonly createdAt: string | null | undefined;
}
export interface BoardCacheEntry {
  entity?: BoardCacheEntityToken;
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
  private entities = new Map<string, BoardCacheEntityToken>();
  private indexed = false;
  current(): BoardCacheEpochToken { return this.token; }
  capture(boardId: string): Pick<BoardCacheEntry, "epoch" | "entity"> {
    let entity = this.entities.get(boardId);
    if (!entity) { entity = Object.freeze({ boardId, createdAt: this.indexed ? null : undefined }); this.entities.set(boardId, entity); }
    return { epoch: this.token, entity };
  }
  /** Only the cursor-ordered metadata stream may change entity identity. A
   * read result can confirm it, but may not elect itself over a newer index. */
  observeSummary(name: string, summary: Pick<BoardSummary, "id" | "createdAt">): boolean {
    this.observe(name);
    return this.setEntity(summary.id, summary.createdAt);
  }
  observeIndex(name: string, boards: readonly Pick<BoardSummary, "id" | "createdAt">[]): string[] {
    this.observe(name);
    const present = new Set(boards.map(board => board.id)), changed: string[] = [];
    for (const board of boards) if (this.setEntity(board.id, board.createdAt)) changed.push(board.id);
    for (const id of this.entities.keys()) if (!present.has(id) && this.setEntity(id, null)) changed.push(id);
    this.indexed = true;
    return changed;
  }
  private setEntity(boardId: string, createdAt: string | null): boolean {
    const prior = this.entities.get(boardId);
    if (prior && prior.createdAt === createdAt) return false;
    this.entities.set(boardId, Object.freeze({ boardId, createdAt }));
    return true;
  }
  observe(name: string): void {
    if (name !== this.token.name) {
      this.token = Object.freeze({ name, generation: this.token.generation + 1 });
      for (const id of this.entities.keys()) this.entities.set(id, Object.freeze({ boardId: id, createdAt: undefined }));
      this.indexed = false;
    }
  }
  /** Called at the final React Query commit, not just before resolving the RPC.
   * This also fences late null/deletion replies and mutation acknowledgements. */
  merge(previous: PreviousBoardCache, incoming: BoardCacheEntry): BoardCacheEntry {
    const prior = isBoardCacheEntry(previous) ? previous : previous === undefined ? undefined : { epoch: undefined, board: previous };
    const entity = incoming.entity;
    const identified = entity ? this.entities.get(entity.boardId) : incoming.board ? this.entities.get(incoming.board.id) : undefined;
    const wrongEntity = identified !== entity || Boolean(entity && incoming.board && (
      incoming.board.id !== entity.boardId || entity.createdAt !== undefined && incoming.board.createdAt !== entity.createdAt
    ));
    if (incoming.epoch !== this.token || wrongEntity || incoming.unchanged) return prior ?? { epoch: undefined, board: undefined };
    if (prior?.epoch !== this.token || prior.entity !== entity || !prior.board || !incoming.board) return incoming;
    return { epoch: this.token, ...(entity ? { entity } : {}), board: mergeBoardSnapshot(prior.board, incoming.board) };
  }
}
