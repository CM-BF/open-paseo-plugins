import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardChange, BoardChanges, BoardEventCursor, BoardSummary } from "../shared/contracts";
import { BoardEventReceiver, connectBoardEvents, installBoardEventTransport } from "./board-events";

const summary = (id = "one", revision = 1): BoardSummary => ({ id, title: id, revision, createdAt: "2026-10-31", updatedAt: "2026-10-31", decisionCount: 0, pendingCount: 0, unreadUpdateCount: 0, latestUpdateRevision: 0, status: "idle" });
const event = (sequence: number, id = "one", revision = sequence): BoardChange => ({ cursor: { epoch: "live", sequence }, summary: summary(id, revision), canvasRevision: revision, reason: "content" });
const snapshot = (sequence = 0, epoch = "live"): BoardChanges => ({ mode: "snapshot", cursor: { epoch, sequence }, boards: [summary()] });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(value => { resolve = value; }); return { promise, resolve }; };

describe("Board event client", () => {
  afterEach(() => vi.useRealTimers());

  it("updates only the committed summary and makes no requests or timers while idle", async () => {
    vi.useFakeTimers();
    const fetchChanges = vi.fn(async () => snapshot());
    const changed = vi.fn();
    const receiver = new BoardEventReceiver({ fetchChanges, changed, updated: vi.fn() });
    await receiver.recover();
    await receiver.receive(event(1, "two"));
    await receiver.receive(event(1, "two"));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][0].summary.id).toBe("two");
    expect(receiver.snapshot()?.boards.map(board => board.id)).toEqual(["one", "two"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("recovers a missing event once and does not apply a duplicate arriving in flight", async () => {
    const held = deferred<BoardChanges>();
    const fetchChanges = vi.fn<(cursor?: BoardEventCursor) => Promise<BoardChanges>>()
      .mockResolvedValueOnce(snapshot()).mockImplementationOnce(() => held.promise);
    const changed = vi.fn();
    const receiver = new BoardEventReceiver({ fetchChanges, changed, updated: vi.fn() });
    await receiver.recover();
    await receiver.receive(event(1));
    const missing = receiver.receive(event(3));
    const duplicate = receiver.receive(event(3));
    held.resolve({ mode: "delta", cursor: { epoch: "live", sequence: 3 }, changes: [event(2), event(3)] });
    await Promise.all([missing, duplicate]);
    expect(changed.mock.calls.map(call => call[0].cursor.sequence)).toEqual([1, 2, 3]);
    expect(fetchChanges).toHaveBeenCalledTimes(2);
  });

  it("retains a commit that arrives while the initial snapshot is loading", async () => {
    const held = deferred<BoardChanges>();
    const changed = vi.fn();
    const receiver = new BoardEventReceiver({ fetchChanges: () => held.promise, changed, updated: vi.fn() });
    const loading = receiver.recover();
    const receiving = receiver.receive(event(1));
    held.resolve(snapshot());
    await Promise.all([loading, receiving]);
    expect(receiver.snapshot()?.cursor.sequence).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("accepts same-revision attention changes and reinitializes after a server restart", async () => {
    const fetchChanges = vi.fn<(cursor?: BoardEventCursor) => Promise<BoardChanges>>()
      .mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot(0, "restarted"));
    const receiver = new BoardEventReceiver({ fetchChanges, changed: vi.fn(), updated: vi.fn() });
    await receiver.recover();
    await receiver.receive({ ...event(1, "one", 1), reason: "attention", summary: { ...summary(), unreadUpdateCount: 3 } });
    await receiver.receive({ ...event(2, "one", 1), reason: "attention", summary: { ...summary(), unreadUpdateCount: 0 } });
    expect(receiver.snapshot()?.boards[0]).toMatchObject({ revision: 1, unreadUpdateCount: 0 });
    await receiver.recover(true);
    expect(receiver.snapshot()?.cursor).toEqual({ epoch: "restarted", sequence: 0 });
  });

  it("rejects incomplete recovery and ignores outstanding work after disposal", async () => {
    const fetchChanges = vi.fn<(cursor?: BoardEventCursor) => Promise<BoardChanges>>()
      .mockResolvedValueOnce(snapshot()).mockResolvedValueOnce({ mode: "delta", cursor: { epoch: "live", sequence: 3 }, changes: [event(3)] });
    const updated = vi.fn();
    const receiver = new BoardEventReceiver({ fetchChanges, changed: vi.fn(), updated });
    await receiver.recover();
    await expect(receiver.receive(event(3))).rejects.toThrow("sequence gap");
    const held = deferred<BoardChanges>(); fetchChanges.mockImplementationOnce(() => held.promise);
    const loading = receiver.recover(); receiver.dispose(); held.resolve(snapshot(5)); await loading;
    expect(updated).toHaveBeenCalledTimes(1);
    expect(receiver.snapshot()?.cursor.sequence).toBe(0);
  });

  it("requires an explicit authenticated transport and releases its subscription", () => {
    const error = vi.fn(); const listener = { change: vi.fn(), reconnect: vi.fn(), error };
    connectBoardEvents("host", listener)();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("配套宿主更新") }));
    const cleanup = vi.fn(); const factory = vi.fn(() => cleanup);
    const uninstall = installBoardEventTransport(factory);
    connectBoardEvents("host", listener)();
    expect(factory).toHaveBeenCalledWith("host", listener);
    expect(cleanup).toHaveBeenCalledTimes(1);
    uninstall();
  });

  it("applies a coalesced coverage interval once per changed Board and rejects false coverage", async () => {
    const fetchChanges = vi.fn<(cursor?: BoardEventCursor) => Promise<BoardChanges>>()
      .mockResolvedValueOnce(snapshot()).mockResolvedValueOnce({ mode: "compact", fromCursor: { epoch: "live", sequence: 0 }, cursor: { epoch: "live", sequence: 200 }, changes: [event(200)] })
      .mockResolvedValueOnce({ mode: "compact", fromCursor: { epoch: "live", sequence: 0 }, cursor: { epoch: "live", sequence: 201 }, changes: [event(201)] });
    const changed = vi.fn(); const updated = vi.fn();
    const receiver = new BoardEventReceiver({ fetchChanges, changed, updated });
    await receiver.recover(); await receiver.recover();
    expect(receiver.currentCursor()).toEqual({ epoch: "live", sequence: 200 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(2);
    await expect(receiver.recover()).rejects.toThrow("invalid coverage");
    expect(receiver.currentCursor()?.sequence).toBe(200);
  });
});
