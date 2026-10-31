import { BoardChangeSchema, BoardChangesSchema, type BoardChange, type BoardChanges, type BoardEventCursor, type BoardSummary } from "../shared/contracts";

export interface BoardEventListener {
  change(event: BoardChange): void;
  reconnect(): void;
  error(error: unknown): void;
}
/** Supplied by a host that supports authenticated plugin events. No private SDK access. */
export type BoardEventTransport = (hostId: string, listener: BoardEventListener) => () => void;
let transport: BoardEventTransport | undefined;
export function installBoardEventTransport(next: BoardEventTransport): () => void {
  transport = next;
  return () => { if (transport === next) transport = undefined; };
}
export function connectBoardEvents(hostId: string, listener: BoardEventListener): () => void {
  if (!transport) {
    listener.error(new Error("此 Paseo 版本尚未提供 Board 事件订阅；需要配套宿主更新才能实时同步。"));
    return () => undefined;
  }
  return transport(hostId, listener);
}

export interface BoardIndexSnapshot { cursor: BoardEventCursor; boards: BoardSummary[] }

/** Orders compact commit events and recovers only on a real gap or connection event. */
export class BoardEventReceiver {
  private cursor?: BoardEventCursor;
  private boards = new Map<string, BoardSummary>();
  private pending: BoardChange[] = [];
  private flight?: Promise<void>;
  private disposed = false;
  private recoverAgain = false;
  private forceSnapshot = false;
  private readonly fetchChanges: (cursor?: BoardEventCursor) => Promise<BoardChanges>;
  private readonly changed: (change: BoardChange) => void;
  private readonly updated: (snapshot: BoardIndexSnapshot, reset: boolean) => void;

  constructor(options: {
    fetchChanges(cursor?: BoardEventCursor): Promise<BoardChanges>;
    changed(change: BoardChange): void;
    updated(snapshot: BoardIndexSnapshot, reset: boolean): void;
  }) {
    this.fetchChanges = options.fetchChanges;
    this.changed = options.changed;
    this.updated = options.updated;
  }

  snapshot(): BoardIndexSnapshot | undefined {
    return this.cursor ? { cursor: { ...this.cursor }, boards: [...this.boards.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)) } : undefined;
  }

  receive(raw: BoardChange): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const event = BoardChangeSchema.parse(raw);
    if (this.cursor?.epoch === event.cursor.epoch && event.cursor.sequence <= this.cursor.sequence) return Promise.resolve();
    if (this.flight || !this.cursor || event.cursor.epoch !== this.cursor.epoch || event.cursor.sequence !== this.cursor.sequence + 1) {
      this.pending.push(event);
      if (this.pending.length > 256) { this.pending = []; this.forceSnapshot = true; }
      return this.recover();
    }
    this.apply(event);
    return Promise.resolve();
  }

  /** Reconnect is an explicit transport event, never a periodic timer. */
  recover(reconnect = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.flight) { this.recoverAgain ||= reconnect; return this.flight; }
    this.flight = this.recoverNow().finally(() => { this.flight = undefined; });
    return this.flight;
  }

  private async recoverNow(): Promise<void> {
    let attempts = 0;
    do {
      // A malformed or lagging transport must not turn gap recovery into polling.
      if (++attempts > 3) throw new Error("Board event recovery did not reach the observed sequence");
      this.recoverAgain = false;
      const requested = this.forceSnapshot ? undefined : this.cursor;
      this.forceSnapshot = false;
      const result = BoardChangesSchema.parse(await this.fetchChanges(requested));
      if (this.disposed) return;
      if (result.mode === "snapshot") {
        this.cursor = result.cursor;
        this.boards = new Map(result.boards.map(board => [board.id, board]));
        this.updated(this.snapshot()!, true);
      } else {
        if (!this.cursor || result.cursor.epoch !== this.cursor.epoch) throw new Error("Board event recovery requires a matching snapshot");
        for (const event of result.changes) {
          if (event.cursor.epoch !== this.cursor.epoch || event.cursor.sequence !== this.cursor.sequence + 1) throw new Error("Board event recovery contains a sequence gap");
          this.apply(event);
        }
        if (result.cursor.sequence !== this.cursor.sequence) throw new Error("Board event recovery is incomplete");
      }
      const pending = this.pending; this.pending = [];
      for (const event of pending) {
        if (event.cursor.epoch !== this.cursor!.epoch) { this.recoverAgain = true; continue; }
        if (event.cursor.sequence <= this.cursor!.sequence) continue;
        if (event.cursor.sequence === this.cursor!.sequence + 1) this.apply(event);
        else { this.pending.push(event); this.recoverAgain = true; }
      }
      this.recoverAgain ||= this.forceSnapshot;
    } while (this.recoverAgain && !this.disposed);
  }

  private apply(event: BoardChange): void {
    this.cursor = event.cursor;
    this.boards.set(event.summary.id, event.summary);
    this.changed(event);
    this.updated(this.snapshot()!, false);
  }

  dispose(): void { this.disposed = true; this.pending = []; }
}
