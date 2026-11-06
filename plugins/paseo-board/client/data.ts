import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useQuery, useQueryClient, replaceEqualDeep, type QueryClient } from "@tanstack/react-query";
import { useBoardRpc, useBoardServices, type BoardServices } from "./transport";
import { boardChangesRpc, boardCheckRpc, readBoardRpc, type Board, type BoardChanges, type BoardEventCursor } from "../shared/contracts";
import { BoardCacheAuthority, BoardReadRecovery, boardFromCache, isBoardCacheEntry, isBoardReadRecovery, type BoardCacheEntry } from "./board-cache";
import { BoardEventReceiver, connectBoardEvents, type BoardIndexSnapshot, type BoardLiveStatus } from "./board-events";
import { BoardCompactSync, type BoardSyncVisibility } from "./compact-sync";
import { getBoardSyncVisibility } from "./web";

const visibility: BoardSyncVisibility = getBoardSyncVisibility() ?? {
  visible: () => AppState.currentState == null || AppState.currentState === "active",
  subscribe(listener) { const subscription = AppState.addEventListener("change", listener); return () => subscription.remove(); },
};

interface ConnectionState { liveError: Error | null; liveStatus: BoardLiveStatus }
const sessions = new WeakMap<QueryClient, Map<string, BoardQuerySession>>();
const scopedKey = (key: readonly string[], services?: BoardServices) => services ? [...key, services.generation] : key;
class BoardQuerySession {
  readonly receiver: BoardEventReceiver;
  readonly cacheAuthority = new BoardCacheAuthority();
  private readonly readRecovery = new BoardReadRecovery();
  private users = new Set<(state: ConnectionState) => void>();
  private disconnect?: () => void;
  private error: Error | null = null;
  private status: BoardLiveStatus = "connecting";
  private streamReady = false;
  private compact?: BoardCompactSync;
  private refreshing = new Map<string, { dirty: boolean; work: Promise<void> }>();
  private readonly cache: QueryClient;
  private readonly hostId: string;
  constructor(cache: QueryClient, hostId: string, fetchChanges: (cursor?: BoardEventCursor) => Promise<BoardChanges>, private readonly check: (cursor: BoardEventCursor) => Promise<{ changed: boolean }>, readonly services?: BoardServices) {
    this.cache = cache; this.hostId = hostId;
    this.receiver = new BoardEventReceiver({
      fetchChanges,
      changed: change => {
        if (services && !services.isCurrent()) return;
        if (this.cacheAuthority.observeSummary(change.cursor.epoch, change.summary)) this.clearReplacedBoard(change.summary.id);
        this.refreshBoard(change.summary.id);
      },
      updated: (snapshot, reset) => {
        // Advance authority before any observer or refreshed read can consume
        // this snapshot. A changed creation identity retires the old first paint;
        // same-entity content remains available while its refresh is pending.
        if (services && !services.isCurrent()) return;
        const replaced = this.cacheAuthority.observeIndex(snapshot.cursor.epoch, snapshot.boards);
        for (const boardId of replaced) this.clearReplacedBoard(boardId);
        cache.setQueryData(scopedKey(["paseo-board-list", hostId, "all"], services), snapshot);
        if (reset) for (const query of this.queries()) this.refreshBoard(String(query.queryKey[2]));
      },
    });
  }
  private clearReplacedBoard(boardId: string): void {
    const key = scopedKey(["paseo-board", this.hostId, boardId], this.services);
    if (!this.cache.getQueryCache().find({ queryKey: key, exact: true })) return;
    const captured = this.cacheAuthority.capture(boardId);
    this.cache.setQueryData<BoardCacheEntry>(key, previous => this.cacheAuthority.merge(previous, {
      ...captured, board: captured.entity?.createdAt === null ? null : undefined,
    }));
  }
  private queries() {
    return this.cache.getQueryCache().findAll({ queryKey: ["paseo-board", this.hostId] })
      .filter(query => query.queryKey[3] === this.services?.generation);
  }
  private report(error: unknown, status?: BoardLiveStatus): void {
    if (this.services && !this.services.isCurrent()) return;
    const nextError = error ? error instanceof Error ? error : new Error(String(error)) : null;
    const nextStatus = status ?? (nextError ? "disconnected" : this.status);
    if (nextError === this.error && nextStatus === this.status) return;
    const retryFailedReads = !nextError && isBoardReadRecovery(this.status, nextStatus);
    if (retryFailedReads || nextStatus !== "connected" && nextStatus !== "checking") this.readRecovery.invalidate();
    this.error = nextError; this.status = nextStatus;
    if (retryFailedReads) {
      for (const query of this.queries()) {
        // An unchanged cursor cannot prove that an independent read succeeded.
        // An old in-flight read may report its final failure after this edge.
        if (query.state.status === "error" && query.state.fetchStatus === "idle") this.refreshBoard(String(query.queryKey[2]));
        else this.readRecovery.watch(query,
          () => this.users.size > 0 && (this.status === "connected" || this.status === "checking")
            && this.cache.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query,
          () => this.refreshBoard(String(query.queryKey[2])));
      }
    }
    for (const listener of this.users) listener({ liveError: this.error, liveStatus: this.status });
  }
  private recovered = () => { if (this.streamReady) this.report(null, "connected"); };
  private startCompact(): void {
    if (this.compact || !this.users.size) return;
    this.compact = new BoardCompactSync({
      cursor: () => this.receiver.currentCursor(), check: this.check,
      recover: () => this.receiver.recover(), state: (status, error) => this.report(error, status),
      visibility,
    });
    this.compact.start();
  }
  attach(listener: (state: ConnectionState) => void): () => void {
    this.users.add(listener); listener({ liveError: this.error, liveStatus: this.status });
    if (!this.disconnect) {
      this.report(null, "connecting");
      const connect = this.services ? (_hostId: string, listener: Parameters<BoardServices["subscribeEvents"]>[0]) => this.services!.subscribeEvents(listener) : connectBoardEvents;
      const disconnect = connect(this.hostId, {
        change: event => {
          this.streamReady = true;
          const cursor = this.receiver.snapshot()?.cursor;
          if (!cursor || cursor.epoch !== event.cursor.epoch || event.cursor.sequence > cursor.sequence + 1) this.report(null, "recovering");
          void this.receiver.receive(event).then(this.recovered).catch(error => this.report(error));
        },
        reconnect: () => {
          this.streamReady = true; this.report(null, "recovering");
          void this.receiver.recover(true).then(this.recovered).catch(error => this.report(error));
        },
        error: error => {
          this.streamReady = false;
          if ((error as { code?: string })?.code === "plugin_events_unsupported") this.startCompact();
          else this.report(error, "disconnected");
        },
      });
      this.disconnect = () => { disconnect(); this.compact?.stop(); this.compact = undefined; };
      // Establish observation first, then close the snapshot/subscription race once.
      void this.receiver.recover(true).then(this.recovered).catch(error => this.report(error));
    }
    return () => {
      this.users.delete(listener);
      if (!this.users.size) { this.readRecovery.invalidate(); this.streamReady = false; this.disconnect?.(); this.disconnect = undefined; }
    };
  }
  async load(): Promise<BoardIndexSnapshot> {
    await this.receiver.recover();
    this.recovered();
    return this.receiver.snapshot()!;
  }
  private refreshBoard(boardId: string): void {
    const key = scopedKey(["paseo-board", this.hostId, boardId], this.services);
    const query = this.cache.getQueryCache().find({ queryKey: key, exact: true });
    if (!query) return;
    // Inactive Boards retain their cached first paint, but must refresh when
    // reopened. Infinity staleTime must not hide events received while away.
    const invalidate = () => { void this.cache.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" }); };
    invalidate();
    const current = this.refreshing.get(boardId);
    if (current) { current.dirty = true; return; }
    const pendingRead = query.state.fetchStatus === "fetching" ? query.promise : undefined;
    if (!query.isActive() && !pendingRead) return;
    const flight = { dirty: false, work: Promise.resolve() };
    this.refreshing.set(boardId, flight);
    flight.work = (async () => {
      if (pendingRead) {
        // That response may predate the event. Let it finish without aborting
        // the first paint, then retain invalidation even if its observer left.
        try { await pendingRead; } catch { /* The active refresh can retry. */ }
        invalidate();
      }
      do {
        flight.dirty = false;
        if (!query.isActive()) break;
        // A burst adds at most one follow-up read; unrelated Boards never refetch.
        await this.cache.refetchQueries({ queryKey: key, exact: true, type: "active" }, { cancelRefetch: false });
        if (flight.dirty) invalidate();
      } while (flight.dirty && query.isActive());
    })().catch(error => this.report(error)).finally(() => { this.refreshing.delete(boardId); });
  }
  dispose(): void {
    this.disconnect?.(); this.disconnect = undefined; this.readRecovery.invalidate(); this.receiver.dispose(); this.users.clear();
  }
}

function useBoardIndex(hostId: string) {
  const changes = useBoardRpc(boardChangesRpc, hostId);
  const check = useBoardRpc(boardCheckRpc, hostId);
  const services = useBoardServices(hostId);
  const cache = useQueryClient();
  let hosts = sessions.get(cache);
  if (!hosts) { hosts = new Map(); sessions.set(cache, hosts); }
  const sessionKey = JSON.stringify([hostId, services?.generation ?? null]);
  let session = hosts.get(sessionKey);
  if (!session) {
    for (const [key, old] of hosts) if (old.services && !old.services.isCurrent()) { old.dispose(); hosts.delete(key); }
    session = new BoardQuerySession(cache, hostId, cursor => changes({ cursor, compact: true }), cursor => check({ cursor }), services); hosts.set(sessionKey, session);
  }
  const [connection, setConnection] = useState<ConnectionState>({ liveError: null, liveStatus: "connecting" });
  useEffect(() => session.attach(setConnection), [session]);
  const query = useQuery({
    queryKey: scopedKey(["paseo-board-list", hostId, "all"], services), queryFn: () => session.load(),
    structuralSharing: (_previous, incoming) => session.receiver.snapshot() ?? incoming,
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false,
  });
  return { ...query, ...connection, cacheAuthority: session.cacheAuthority };
}

export function useBoardList(hostId: string, workspaceId?: string) {
  const query = useBoardIndex(hostId);
  return { ...query, data: query.data ? { ...query.data, boards: query.data.boards.filter(board => workspaceId === undefined || board.workspaceId === workspaceId) } : undefined };
}

export function useBoard(hostId: string, boardId: string) {
  const events = useBoardIndex(hostId);
  const read = useBoardRpc(readBoardRpc, hostId);
  const services = useBoardServices(hostId);
  const cache = useQueryClient();
  const key = scopedKey(["paseo-board", hostId, boardId], services);
  const authority = events.cacheAuthority;
  const query = useQuery<BoardCacheEntry, Error, Board | null | undefined>({
    queryKey: key,
    queryFn: async () => {
      // Attention changes have their own event sequence and can keep Board.revision.
      const captured = authority.capture(boardId);
      const result = await read({ boardId });
      return { ...captured, board: result.board, ...(result.unchanged ? { unchanged: true as const } : {}) };
    },
    select: boardFromCache,
    // React Query also invokes this for the selected (unwrapped) Board. That
    // second pass only shares equal structure; authority was checked at commit.
    structuralSharing: (previous, incoming) => isBoardCacheEntry(incoming)
      ? authority.merge(previous as BoardCacheEntry | Board | null | undefined, incoming)
      : replaceEqualDeep(previous, incoming),
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: 1,
  });
  // Async handlers retain this render's callback across their await. A receipt
  // from the previous daemon epoch cannot be adopted by a newer render.
  const { epoch: acceptanceEpoch, entity: acceptanceEntity } = authority.capture(boardId);
  const accept = useCallback((next: Board) => {
    if (services && !services.isCurrent()) return;
    cache.setQueryData<BoardCacheEntry>(scopedKey(["paseo-board", hostId, boardId], services), previous => authority.merge(previous, { epoch: acceptanceEpoch, entity: acceptanceEntity, board: next }));
  }, [cache, hostId, boardId, authority, acceptanceEpoch, acceptanceEntity, services]);
  return { ...query, accept, liveError: events.liveError, liveStatus: events.liveStatus };
}
