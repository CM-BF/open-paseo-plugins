import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardEventCursor } from "../shared/contracts";
import { BoardCompactSync } from "./compact-sync";

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(value => { resolve = value; }); return { promise, resolve }; };
const visible = () => {
  let showing = true; let listener = () => {};
  return { visible: () => showing, subscribe: (next: () => void) => { listener = next; return () => { listener = () => {}; }; }, set(value: boolean) { showing = value; listener(); } };
};

describe("shared compact Board sync", () => {
  afterEach(() => vi.useRealTimers());

  it("loads one initial summary, probes without reading history, and recovers only a real change", async () => {
    vi.useFakeTimers();
    let cursor: BoardEventCursor | undefined;
    const recover = vi.fn(async () => { cursor = { epoch: "one", sequence: (cursor?.sequence ?? -1) + 1 }; });
    const check = vi.fn(async () => ({ changed: false }));
    const state = vi.fn();
    const sync = new BoardCompactSync({ cursor: () => cursor, recover, check, state, visibility: visible() });
    sync.start(); await vi.advanceTimersByTimeAsync(0);
    expect(recover).toHaveBeenCalledTimes(1); expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);
    expect(check).toHaveBeenCalledTimes(3); expect(recover).toHaveBeenCalledTimes(1);
    check.mockResolvedValueOnce({ changed: true }); await vi.advanceTimersByTimeAsync(2000);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(state).toHaveBeenLastCalledWith("checking");
    sync.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one request in flight, pauses hidden tabs, resumes immediately and does not reschedule after teardown", async () => {
    vi.useFakeTimers(); const visibility = visible();
    const pending = deferred<{ changed: boolean }>();
    const check = vi.fn(() => pending.promise); const recover = vi.fn(async () => {});
    const sync = new BoardCompactSync({ cursor: () => ({ epoch: "one", sequence: 0 }), check, recover, state: vi.fn(), visibility });
    sync.start(); await vi.advanceTimersByTimeAsync(20_000);
    expect(check).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    visibility.set(false); pending.resolve({ changed: false }); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    visibility.set(true); await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(2);
    const held = deferred<{ changed: boolean }>(); check.mockImplementationOnce(() => held.promise);
    await vi.advanceTimersByTimeAsync(2000); expect(check).toHaveBeenCalledTimes(3);
    sync.stop(); held.resolve({ changed: true }); await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(3); expect(recover).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("backs failures off to thirty seconds and resets the delay after success", async () => {
    vi.useFakeTimers(); const check = vi.fn(async () => { throw new Error("offline"); });
    const state = vi.fn();
    const sync = new BoardCompactSync({ cursor: () => ({ epoch: "one", sequence: 0 }), check, recover: vi.fn(), state, visibility: visible() });
    sync.start(); await vi.advanceTimersByTimeAsync(0);
    expect(state).toHaveBeenLastCalledWith("disconnected", expect.any(Error));
    for (const delay of [2000, 4000, 8000, 16000, 30000]) {
      const calls = check.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1); expect(check).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1); expect(check).toHaveBeenCalledTimes(calls + 1);
    }
    check.mockResolvedValueOnce({ changed: false } as never);
    await vi.advanceTimersByTimeAsync(30000); expect(state).toHaveBeenLastCalledWith("checking");
    const calls = check.mock.calls.length; await vi.advanceTimersByTimeAsync(2000); expect(check).toHaveBeenCalledTimes(calls + 1);
    sync.stop();
  });
});
