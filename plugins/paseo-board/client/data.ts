import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { boardChangesRpc, boardCheckRpc, readBoardRpc, type Board, type BoardChanges, type BoardEventCursor } from "../shared/contracts";
import { mergeBoardSnapshot } from "./board-cache";
import { BoardEventReceiver, connectBoardEvents, type BoardIndexSnapshot, type BoardLiveStatus } from "./board-events";
import { BoardCompactSync, type BoardSyncVisibility } from "./compact-sync";
import { getBoardSyncVisibility } from "./web";

const visibility: BoardSyncVisibility = getBoardSyncVisibility() ?? {
  visible: () => AppState.currentState == null || AppState.currentState === "active",
  subscribe(listener) { const subscription = AppState.addEventListener("change", listener); return () => subscription.remove(); },
};

interface ConnectionState { liveError: Error | null; liveStatus: BoardLiveStatus }
const sessions = new WeakMap<QueryClient, Map<string, BoardQuerySession>>();
class BoardQuerySession {
  readonly receiver: BoardEventReceiver;
  private users = new Set<(state: ConnectionState) => void>();
  private disconnect?: () => void;
  private error: Error | null = null;
  private status: BoardLiveStatus = "connecting";
  private streamReady = false;
  private compact?: BoardCompactSync;
  private refreshing = new Map<string, { dirty: boolean; work: Promise<void> }>();
  private readonly cache: QueryClient;
  private readonly hostId: string;
  constructor(cache: QueryClient, hostId: string, fetchChanges: (cursor?: BoardEventCursor) => Promise<BoardChanges>, private readonly check: (cursor: BoardEventCursor) => Promise<{ changed: boolean }>) {
    this.cache = cache; this.hostId = hostId;
    this.receiver = new BoardEventReceiver({
      fetchChanges,
      changed: change => this.refreshBoard(change.summary.id),
      updated: (snapshot, reset) => {
        cache.setQueryData(["paseo-board-list", hostId, "all"], snapshot);
        if (reset) for (const query of cache.getQueryCache().findAll({ queryKey: ["paseo-board", hostId], type: "active" })) this.refreshBoard(String(query.queryKey[2]));
      },
    });
  }
  private report(error: unknown, status?: BoardLiveStatus): void {
    const nextError = error ? error instanceof Error ? error : new Error(String(error)) : null;
    const nextStatus = status ?? (nextError ? "disconnected" : this.status);
    if (nextError === this.error && nextStatus === this.status) return;
    this.error = nextError; this.status = nextStatus;
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
      const disconnect = connectBoardEvents(this.hostId, {
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
      if (!this.users.size) { this.streamReady = false; this.disconnect?.(); this.disconnect = undefined; }
    };
  }
  async load(): Promise<BoardIndexSnapshot> {
    await this.receiver.recover();
    this.recovered();
    return this.receiver.snapshot()!;
  }
  private refreshBoard(boardId: string): void {
    const key = ["paseo-board", this.hostId, boardId];
    if (!this.cache.getQueryCache().find({ queryKey: key, exact: true, type: "active" })) return;
    const current = this.refreshing.get(boardId);
    if (current) { current.dirty = true; return; }
    const flight = { dirty: false, work: Promise.resolve() };
    this.refreshing.set(boardId, flight);
    flight.work = (async () => {
      do {
        flight.dirty = false;
        // A burst adds at most one follow-up read; unrelated Boards never refetch.
        await this.cache.refetchQueries({ queryKey: key, exact: true, type: "active" }, { cancelRefetch: false });
      } while (flight.dirty && this.users.size);
    })().catch(error => this.report(error)).finally(() => { this.refreshing.delete(boardId); });
  }
}

function useBoardIndex(hostId: string) {
  const changes = useRpc(boardChangesRpc);
  const check = useRpc(boardCheckRpc);
  const cache = useQueryClient();
  let hosts = sessions.get(cache);
  if (!hosts) { hosts = new Map(); sessions.set(cache, hosts); }
  let session = hosts.get(hostId);
  if (!session) { session = new BoardQuerySession(cache, hostId, cursor => changes({ cursor, compact: true }), cursor => check({ cursor })); hosts.set(hostId, session); }
  const [connection, setConnection] = useState<ConnectionState>({ liveError: null, liveStatus: "connecting" });
  useEffect(() => session.attach(setConnection), [session]);
  const query = useQuery({
    queryKey: ["paseo-board-list", hostId, "all"], queryFn: () => session.load(),
    structuralSharing: (_previous, incoming) => session.receiver.snapshot() ?? incoming,
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false,
  });
  return { ...query, ...connection };
}

export function useBoardList(hostId: string, workspaceId?: string) {
  const query = useBoardIndex(hostId);
  return { ...query, data: query.data ? { ...query.data, boards: query.data.boards.filter(board => workspaceId === undefined || board.workspaceId === workspaceId) } : undefined };
}

export function useBoard(hostId: string, boardId: string) {
  const events = useBoardIndex(hostId);
  const read = useRpc(readBoardRpc);
  const cache = useQueryClient();
  const key = ["paseo-board", hostId, boardId] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      // Attention changes have their own event sequence and can keep Board.revision.
      const result = await read({ boardId });
      const latest = cache.getQueryData<Board | null>(key);
      if (result.unchanged) return latest ?? null;
      return result.board ? mergeBoardSnapshot(latest, result.board) : result.board;
    },
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false, retry: 1,
  });
  const accept = useCallback((next: Board) => {
    cache.setQueryData<Board | null>(["paseo-board", hostId, boardId], previous => mergeBoardSnapshot(previous, next));
  }, [cache, hostId, boardId]);
  return { ...query, accept, liveError: events.liveError, liveStatus: events.liveStatus };
}
