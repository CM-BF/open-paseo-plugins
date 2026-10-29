import { afterEach, describe, expect, it, vi } from "vitest";
import { createStateWriter } from "./state-writer";
import type { JsonData } from "../shared/contracts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); });

describe("canvas state persistence", () => {
  it("debounces rapid edits, merges distinct keys and snapshots mutable nested values", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_state: JsonData) => {});
    const writer = createStateWriter(save, vi.fn());
    const first = { input: { text: "first" } };
    writer.schedule(first);
    first.input.text = "mutated after scheduling";
    await vi.advanceTimersByTimeAsync(200);
    writer.schedule({ slider: 0.5 });
    await vi.advanceTimersByTimeAsync(299);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledExactlyOnceWith({ input: { text: "first" }, slider: 0.5 });
    writer.dispose();
  });

  it("serializes a slow save with a newer value and never lets an old write land last", async () => {
    const first = deferred();
    const received: JsonData[] = [];
    const save = vi.fn(async (state: JsonData) => {
      if (state.value === "old") await first.promise;
      received.push(state);
    });
    const writer = createStateWriter(save, vi.fn());
    writer.schedule({ value: "old" });
    const flushing = writer.flush();
    writer.schedule({ value: "new" });
    writer.schedule({ value: "newest" });
    const latestFlush = writer.flush();
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.all([flushing, latestFlush]);
    expect(received).toEqual([{ value: "old" }, { value: "newest" }]);
    writer.dispose();
  });

  it("flushes the last edit on dispose and refuses later edits from the old surface", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_state: JsonData) => {});
    const writer = createStateWriter(save, vi.fn());
    writer.schedule({ input: "typed before navigating away" });
    writer.dispose();
    writer.schedule({ input: "late event from destroyed frame" });
    await writer.flush();
    expect(save).toHaveBeenCalledExactlyOnceWith({ input: "typed before navigating away" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps pending state bound to its original board while a new board begins saving", async () => {
    const first = deferred();
    const records: Array<{ board: string; state: JsonData }> = [];
    const oldBoard = createStateWriter(async state => { await first.promise; records.push({ board: "old", state }); }, vi.fn());
    const newBoard = createStateWriter(async state => { records.push({ board: "new", state }); }, vi.fn());
    oldBoard.schedule({ input: "old surface" });
    oldBoard.dispose();
    newBoard.schedule({ input: "new surface" });
    await newBoard.flush();
    first.resolve();
    await oldBoard.flush();
    expect(records).toEqual([{ board: "new", state: { input: "new surface" } }, { board: "old", state: { input: "old surface" } }]);
    newBoard.dispose();
  });

  it("reports failures without discarding pending state and retries it with subsequent changes", async () => {
    const save = vi.fn<(state: JsonData) => Promise<void>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const onError = vi.fn();
    const writer = createStateWriter(save, onError);
    writer.schedule({ value: "not yet saved", other: 1 });
    await writer.flush();
    expect(onError).toHaveBeenCalledOnce();
    writer.schedule({ value: "edited while offline" });
    await writer.flush();
    expect(save).toHaveBeenLastCalledWith({ value: "edited while offline", other: 1 });
    writer.dispose();
  });

  it("finishes queued edits when disposed during an in-flight save", async () => {
    const first = deferred();
    const save = vi.fn(async (_state: JsonData) => { if (save.mock.calls.length === 1) await first.promise; });
    const writer = createStateWriter(save, vi.fn());
    writer.schedule({ value: 1 });
    void writer.flush();
    writer.schedule({ value: 2 });
    writer.dispose();
    first.resolve();
    await writer.flush();
    expect(save.mock.calls.map(([state]) => state)).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it("does not strand a final edit scheduled at the save-completion microtask boundary", async () => {
    const first = deferred();
    const save = vi.fn(async (_state: JsonData) => { if (save.mock.calls.length === 1) await first.promise; });
    const writer = createStateWriter(save, vi.fn());
    writer.schedule({ value: 1 });
    const flushed = writer.flush();
    const savePromise = save.mock.results[0].value;
    void savePromise.then(() => { writer.schedule({ value: 2 }); writer.dispose(); });
    first.resolve();
    await flushed;
    expect(save.mock.calls.map(([state]) => state)).toEqual([{ value: 1 }, { value: 2 }]);
  });
});
