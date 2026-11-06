import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver, replaceEqualDeep } from "@tanstack/react-query";
import type { Board } from "../shared/contracts";
import { BoardCacheAuthority, BoardReadRecovery, boardFromCache, isBoardCacheEntry, isBoardReadRecovery, mergeBoardSnapshot, type BoardCacheEntry } from "./board-cache";
const board = (revision: number, seenUpdateIds: string[], updates = ["a", "b"]): Board => ({ id: "board", revision, title: `r${revision}`, seenUpdateIds, updates: updates.map(id => ({ id })) }) as Board;
describe("independent seen receipts", () => {
  it("preserves seen acknowledgements across an older in-flight read with the same content revision", () => {
    expect(mergeBoardSnapshot(board(3, ["b"]), board(3, []))).toMatchObject({ revision: 3, seenUpdateIds: ["b"] });
  });
  it("accepts a late seen receipt without reverting concurrent newer canvas content", () => {
    expect(mergeBoardSnapshot(board(4, ["b"]), board(3, ["a"]))).toMatchObject({ revision: 4, title: "r4", seenUpdateIds: ["b", "a"] });
  });
  it("prunes receipts outside the current bounded window", () => {
    expect(mergeBoardSnapshot(board(3, ["a"]), board(4, [], ["b"])).seenUpdateIds).toEqual([]);
  });
  it("never transfers receipts across Board identities", () => {
    expect(mergeBoardSnapshot(board(3, ["a"]), { ...board(1, []), id: "other" }).seenUpdateIds).toEqual([]);
  });
});

describe("failed Board read recovery boundary", () => {
  it("retries failures at event reconnect and compact recovery without requiring a commit", () => {
    expect(isBoardReadRecovery("recovering", "connected")).toBe(true);
    expect(isBoardReadRecovery("disconnected", "checking")).toBe(true);
    expect(isBoardReadRecovery("connecting", "connected")).toBe(true);
  });
  it("does not turn healthy idle checks or repeated recovery failures into whole-Board polling", () => {
    expect(isBoardReadRecovery("checking", "checking")).toBe(false);
    expect(isBoardReadRecovery("connected", "connected")).toBe(false);
    expect(isBoardReadRecovery("connected", "checking")).toBe(false);
    expect(isBoardReadRecovery("disconnected", "disconnected")).toBe(false);
    expect(isBoardReadRecovery("recovering", "disconnected")).toBe(false);
  });

  it("retries one final read failure that settles after recovery, coalescing several recovery edges", async () => {
    const cache = new QueryClient(), recovery = new BoardReadRecovery(), key = ["late-recovery"];
    let reject!: (error: Error) => void;
    const failed = cache.fetchQuery({ queryKey: key, queryFn: () => new Promise<Board>((_resolve, fail) => { reject = fail; }), retry: false });
    const query = cache.getQueryCache().find({ queryKey: key })!;
    let retried: Promise<Board> | undefined;
    const retry = vi.fn(() => { retried = cache.fetchQuery({ queryKey: key, queryFn: async () => board(2, []), retry: false }); });
    try {
      recovery.invalidate(); recovery.watch(query, () => true, retry);
      recovery.invalidate(); recovery.watch(query, () => true, retry);
      reject(new Error("Old read failed after connection recovered"));
      await expect(failed).rejects.toThrow("Old read failed");
      expect(retry).toHaveBeenCalledTimes(1);
      await expect(retried).resolves.toMatchObject({ revision: 2 });
      expect(cache.getQueryData(key)).toMatchObject({ revision: 2 });
    } finally { cache.clear(); }
  });

  it("does not repeat an in-flight read that succeeds after the connection recovers", async () => {
    const cache = new QueryClient(), recovery = new BoardReadRecovery(), key = ["successful-recovery"], retry = vi.fn();
    let resolve!: (value: Board) => void;
    const request = cache.fetchQuery({ queryKey: key, queryFn: () => new Promise<Board>(done => { resolve = done; }), retry: false });
    try {
      recovery.watch(cache.getQueryCache().find({ queryKey: key })!, () => true, retry);
      resolve(board(3, [])); await request;
      expect(retry).not.toHaveBeenCalled();
    } finally { cache.clear(); }
  });

  it("abandons late failures after a new connection generation or the query scope leaves", async () => {
    for (const stop of ["generation", "scope"] as const) {
      const cache = new QueryClient(), recovery = new BoardReadRecovery(), key = [stop], retry = vi.fn();
      let reject!: (error: Error) => void, current = true;
      const request = cache.fetchQuery({ queryKey: key, queryFn: () => new Promise<Board>((_resolve, fail) => { reject = fail; }), retry: false });
      try {
        recovery.watch(cache.getQueryCache().find({ queryKey: key })!, () => current, retry);
        if (stop === "generation") recovery.invalidate(); else current = false;
        reject(new Error("No longer this recovery")); await expect(request).rejects.toThrow("No longer");
        expect(retry).not.toHaveBeenCalled();
      } finally { cache.clear(); }
    }
  });

  it("does not revive a cancelled old request after its replacement has started", async () => {
    const cache = new QueryClient(), recovery = new BoardReadRecovery(), key = ["replaced-read"], retry = vi.fn();
    const old = cache.fetchQuery({ queryKey: key, queryFn: () => new Promise<Board>(() => {}), retry: false }).catch(() => undefined);
    try {
      recovery.watch(cache.getQueryCache().find({ queryKey: key })!, () => true, retry);
      await cache.cancelQueries({ queryKey: key });
      await cache.fetchQuery({ queryKey: key, queryFn: async () => board(4, []), retry: false });
      await old;
      expect(retry).not.toHaveBeenCalled();
      expect(cache.getQueryData(key)).toMatchObject({ revision: 4 });
    } finally { cache.clear(); }
  });
});

describe("Board cache epoch authority", () => {
  it("keeps the old cached first paint but adopts a lower authoritative revision and resets seen receipts in a new epoch", () => {
    const authority = new BoardCacheAuthority();
    authority.observe("old");
    const old = authority.merge(undefined, { epoch: authority.current(), board: board(90, ["a"]) });
    authority.observe("new");
    expect(boardFromCache(old)?.revision).toBe(90);
    const current = authority.merge(old, { epoch: authority.current(), board: board(1, []) });
    expect(current.board).toMatchObject({ revision: 1, title: "r1", seenUpdateIds: [] });
    expect(old.board?.revision).toBe(90);
  });

  it("refuses late old-epoch read, null and mutation responses after the new read committed", () => {
    const authority = new BoardCacheAuthority();
    authority.observe("old");
    const started = authority.current();
    authority.observe("new");
    const current = authority.merge(undefined, { epoch: authority.current(), board: board(2, []) });
    for (const late of [board(500, ["a"]), null, board(501, ["b"])]) {
      expect(authority.merge(current, { epoch: started, board: late })).toBe(current);
    }
    expect(authority.merge(current, { epoch: authority.current(), board: null }).board).toBeNull();
  });

  it("retains monotonic revisions and combines seen receipts within one epoch, including repeated snapshots", () => {
    const authority = new BoardCacheAuthority();
    authority.observe("stable");
    const started = authority.current();
    let current = authority.merge(undefined, { epoch: started, board: board(8, ["a"]) });
    authority.observe("stable");
    expect(authority.current()).toBe(started);
    current = authority.merge(current, { epoch: started, board: board(7, ["b"]) });
    expect(current.board).toMatchObject({ revision: 8, title: "r8", seenUpdateIds: ["a", "b"] });
    expect(authority.merge(current, { epoch: started, board: null, unchanged: true })).toBe(current);
  });

  it("does not infer new authority from unknown-start reads or an unchanged response", () => {
    const authority = new BoardCacheAuthority(), unknown = authority.current(), cached = board(50, ["a"]);
    authority.observe("known");
    expect(authority.merge(cached, { epoch: unknown, board: board(99, []) }).board).toBe(cached);
    expect(authority.merge(cached, { epoch: authority.current(), board: null, unchanged: true }).board).toBe(cached);
    expect(authority.merge(undefined, { epoch: unknown, board: board(99, []) }).board).toBeUndefined();
    expect(authority.merge(cached, { epoch: authority.current(), board: board(1, []) }).board?.revision).toBe(1);
  });

  it("rejects an earlier generation even if its epoch name is reused", () => {
    const authority = new BoardCacheAuthority();
    authority.observe("a"); const firstA = authority.current();
    authority.observe("b"); authority.observe("a");
    const current = authority.merge(undefined, { epoch: authority.current(), board: board(1, []) });
    expect(authority.merge(current, { epoch: firstA, board: board(99, ["a"]) })).toBe(current);
  });

  it("fences the actual Query cache commit while observers still receive a plain Board", () => {
    const authority = new BoardCacheAuthority(), cache = new QueryClient(), key = ["epoch-board"];
    authority.observe("old"); const oldEpoch = authority.current();
    const observer = new QueryObserver<BoardCacheEntry, Error, Board | null | undefined>(cache, {
      queryKey: key, enabled: false, select: boardFromCache,
      structuralSharing: (previous, incoming) => isBoardCacheEntry(incoming)
        ? authority.merge(previous as BoardCacheEntry | Board | null | undefined, incoming)
        : replaceEqualDeep(previous, incoming),
    });
    const dispose = observer.subscribe(() => {});
    try {
      cache.setQueryData(key, { epoch: oldEpoch, board: board(70, ["a"]) });
      const latePreparedResult = { epoch: oldEpoch, board: board(80, ["b"]) };
      authority.observe("new");
      cache.setQueryData(key, { epoch: authority.current(), board: board(1, []) });
      expect(observer.getCurrentResult().data).toMatchObject({ id: "board", revision: 1, seenUpdateIds: [] });
      expect(observer.getCurrentResult().data).not.toHaveProperty("epoch");
      cache.setQueryData(key, latePreparedResult);
      cache.setQueryData(key, { epoch: oldEpoch, board: null });
      expect(observer.getCurrentResult().data?.revision).toBe(1);
      expect(cache.getQueryData<BoardCacheEntry>(key)?.epoch).toBe(authority.current());
    } finally { dispose(); cache.clear(); }
  });
});

describe("Board cache entity authority", () => {
  const entity = (createdAt: string, revision: number, seen: string[] = []): Board => ({ ...board(revision, seen), createdAt });
  it("replaces a same-ID old high revision without transferring its seen receipts", () => {
    const authority = new BoardCacheAuthority();
    authority.observeIndex("stable", [{ id: "board", createdAt: "old" }]);
    const old = authority.merge(undefined, { ...authority.capture("board"), board: entity("old", 90, ["a"]) });
    authority.observeSummary("stable", { id: "board", createdAt: "new" });
    const current = authority.merge(old, { ...authority.capture("board"), board: entity("new", 1) });
    expect(current.board).toMatchObject({ createdAt: "new", revision: 1, seenUpdateIds: [] });
    expect(mergeBoardSnapshot(old.board, entity("new", 1)).seenUpdateIds).toEqual([]);
  });

  it("rejects delayed old snapshots, nulls and mutation acknowledgements in the same epoch", () => {
    const authority = new BoardCacheAuthority();
    authority.observeIndex("stable", [{ id: "board", createdAt: "old" }]);
    const started = authority.capture("board");
    authority.observeSummary("stable", { id: "board", createdAt: "new" });
    const current = authority.merge(undefined, { ...authority.capture("board"), board: entity("new", 1) });
    for (const late of [entity("old", 99), null, entity("old", 100, ["a"])]) {
      expect(authority.merge(current, { ...started, board: late })).toBe(current);
    }
    // Even a read started after the new index cannot return the old entity.
    expect(authority.merge(current, { ...authority.capture("board"), board: entity("old", 101) })).toBe(current);
  });

  it("treats authoritative absence and delete/recreate with the same timestamp as separate visits", () => {
    const authority = new BoardCacheAuthority();
    authority.observeIndex("stable", [{ id: "board", createdAt: "same-time" }]);
    const started = authority.capture("board");
    expect(authority.observeIndex("stable", [])).toEqual(["board"]);
    const absent = authority.merge(undefined, { ...authority.capture("board"), board: null });
    expect(authority.merge(absent, { ...started, board: entity("same-time", 90) })).toBe(absent);
    authority.observeSummary("stable", { id: "board", createdAt: "same-time" });
    const current = authority.merge(absent, { ...authority.capture("board"), board: entity("same-time", 1) });
    expect(current.board?.revision).toBe(1);
    expect(authority.merge(current, { ...started, board: entity("same-time", 99) })).toBe(current);
  });

  it("keeps unrelated reads valid and does not promote a mismatching response into metadata authority", () => {
    const authority = new BoardCacheAuthority();
    authority.observeIndex("stable", [{ id: "board", createdAt: "old" }, { id: "other", createdAt: "other-time" }]);
    const unrelated = authority.capture("other");
    authority.observeSummary("stable", { id: "board", createdAt: "new" });
    expect(authority.capture("other").entity).toBe(unrelated.entity);
    expect(authority.merge(undefined, { ...unrelated, board: { ...entity("other-time", 3), id: "other" } }).board?.revision).toBe(3);
    const captured = authority.capture("board");
    expect(authority.merge(undefined, { ...captured, board: entity("unobserved", 100) }).board).toBeUndefined();
    expect(authority.capture("board").entity).toBe(captured.entity);
  });

  it("fences a prepared old result at the real QueryObserver commit after same-epoch recreation", () => {
    const authority = new BoardCacheAuthority(), cache = new QueryClient(), key = ["entity-board"];
    authority.observeIndex("stable", [{ id: "board", createdAt: "old" }]);
    const captured = authority.capture("board");
    const observer = new QueryObserver<BoardCacheEntry, Error, Board | null | undefined>(cache, {
      queryKey: key, enabled: false, select: boardFromCache,
      structuralSharing: (previous, incoming) => isBoardCacheEntry(incoming)
        ? authority.merge(previous as BoardCacheEntry | Board | null | undefined, incoming)
        : replaceEqualDeep(previous, incoming),
    });
    const dispose = observer.subscribe(() => {});
    try {
      cache.setQueryData(key, { ...captured, board: entity("old", 90, ["a"]) });
      const latePrepared = { ...captured, board: entity("old", 100, ["b"]) };
      authority.observeSummary("stable", { id: "board", createdAt: "new" });
      cache.setQueryData(key, { ...authority.capture("board"), board: entity("new", 1) });
      cache.setQueryData(key, latePrepared);
      cache.setQueryData(key, { ...captured, board: null });
      expect(observer.getCurrentResult().data).toMatchObject({ createdAt: "new", revision: 1, seenUpdateIds: [] });
      expect(observer.getCurrentResult().data).not.toHaveProperty("entity");
    } finally { dispose(); cache.clear(); }
  });
});
