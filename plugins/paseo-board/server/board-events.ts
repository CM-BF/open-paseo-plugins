import { randomUUID } from "node:crypto";
import type { Board, BoardChange, BoardChanges, BoardEventCursor, BoardSummary } from "../shared/contracts";

/** Emitted only after a durable write. Carries no authored HTML, data, or messages. */
export interface BoardCommitNotice {
  summary: BoardSummary;
  canvasRevision: number;
  reason: BoardChange["reason"];
}

export function summarizeBoard(board: Board): BoardSummary {
  const { id, title, projectId, workspaceId, ownerAgentId, revision, createdAt, updatedAt } = board;
  const active = board.interactions.some(item => ["saved", "sending", "delivered", "processing"].includes(item.status));
  const failed = board.interactions.some(item => item.status === "failed") || board.feeds?.some(feed => !feed.closed && feed.lastError);
  return {
    id, title, projectId, workspaceId, ownerAgentId, revision, createdAt, updatedAt,
    decisionCount: board.decisions.filter(item => item.status !== "dismissed" && item.status !== "superseded").length,
    pendingCount: board.interactions.filter(item => !["answered", "applied", "rejected"].includes(item.status)).length,
    unreadUpdateCount: board.updates.filter(item => !board.seenUpdateIds.includes(item.id)).length,
    latestUpdateRevision: board.updates.at(-1)?.boardRevision ?? 0,
    status: failed ? "error" : active ? "processing" : "idle",
  };
}

export function sortBoardSummaries(boards: Iterable<BoardSummary>, filter: { workspaceId?: string } = {}): BoardSummary[] {
  return [...boards].filter(board => filter.workspaceId === undefined || board.workspaceId === filter.workspaceId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** Coordinator-owned compact index. Recovery transfers summaries, never full canvases. */
export class BoardEventHub {
  private readonly epoch: string;
  private readonly retention: number;
  private sequence = 0;
  private boards = new Map<string, BoardSummary>();
  private history: BoardChange[] = [];
  private listeners = new Set<(event: BoardChange) => void>();

  constructor(options: { epoch?: string; retention?: number } = {}) {
    this.epoch = options.epoch ?? randomUUID();
    this.retention = options.retention ?? 256;
    if (!Number.isInteger(this.retention) || this.retention < 1) throw new RangeError("Event retention must be a positive integer");
  }

  /** Startup partition snapshots can overlap commits; never replace a newer revision. */
  seed(summaries: readonly BoardSummary[]): void {
    for (const summary of summaries) {
      const previous = this.boards.get(summary.id);
      if (!previous || previous.revision < summary.revision) this.boards.set(summary.id, structuredClone(summary));
    }
  }

  accept(notice: BoardCommitNotice): BoardChange | undefined {
    const previous = this.boards.get(notice.summary.id);
    // A delayed worker cannot revert content. Same-revision attention changes are valid.
    if (previous && previous.revision > notice.summary.revision) return undefined;
    const summary = structuredClone(notice.summary);
    this.boards.set(summary.id, summary);
    const event: BoardChange = { cursor: { epoch: this.epoch, sequence: ++this.sequence }, summary, canvasRevision: notice.canvasRevision, reason: notice.reason };
    this.history.push(event);
    if (this.history.length > this.retention) this.history.shift();
    for (const listener of this.listeners) {
      try { listener(structuredClone(event)); } catch { /* Subscriber failure cannot undo a durable commit. */ }
    }
    return structuredClone(event);
  }

  snapshot(filter: { workspaceId?: string } = {}): { cursor: BoardEventCursor; boards: BoardSummary[] } {
    return { cursor: { epoch: this.epoch, sequence: this.sequence }, boards: structuredClone(sortBoardSummaries(this.boards.values(), filter)) };
  }

  changesSince(cursor?: BoardEventCursor): BoardChanges {
    const current = { epoch: this.epoch, sequence: this.sequence };
    const earliest = this.history[0]?.cursor.sequence ?? this.sequence + 1;
    if (!cursor || cursor.epoch !== this.epoch || cursor.sequence > this.sequence || cursor.sequence < earliest - 1) {
      return { mode: "snapshot", ...this.snapshot() };
    }
    return { mode: "delta", cursor: current, changes: structuredClone(this.history.filter(change => change.cursor.sequence > cursor.sequence)) };
  }

  subscribe(listener: (event: BoardChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
