import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import type { FeedInput } from "../shared/contracts";
const open = (sourceId = "worker", path = "/live/a", expectedGeneration = 0): Extract<FeedInput, {action:"open"}> => ({ action: "open", boardId: "test", sourceId, path, requestId: `open-${sourceId}-${expectedGeneration}`, expectedGeneration, focusSelectors: ["#a"] });
const set = (seq: number, value: unknown, extra = {}): Extract<FeedInput, {action:"set"}> => ({ action: "set", boardId: "test", sourceId: "worker", generation: 1, seq, value, ...extra });
describe("durable latest-state feeds", () => {
  let root: string, store: BoardStore;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "board-feed-")); store = new BoardStore(root); await store.create({ id: "test", title: "Feeds", ownerAgentId: "owner", html: "<input id='keep'>", data: { untouched: 1 } }); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("commits arbitrary data, provenance and ACK atomically; only milestones gain attention", async () => {
    const initial = (await store.read("test"))!;
    await store.feed(open(), "owner");
    const first = await store.feed(set(1, { arbitrary: [true, 3, null] }), "owner");
    const board = (await store.read("test"))!;
    expect(board.canvas.data).toEqual({ untouched: 1, live: { a: { arbitrary: [true, 3, null] } } });
    expect(board.canvas.html).toBe(initial.canvas.html); expect(board.canvas.revision).toBe(initial.canvas.revision + 1); expect(board.updates).toEqual([]);
    const raw = JSON.parse(await readFile(join(root, "boards/test.json"), "utf8"));
    expect(raw.board.feeds[0].lastAck).toEqual(first.ack);
    expect(raw.history.at(-1)).toMatchObject({ operation: "feed", payload: { actorAgentId: "owner", seq: 1, value: { arbitrary: [true, 3, null] } } });
    await store.feed(set(2, null, { attention: "milestone" }), "owner");
    expect((await store.read("test"))!.updates).toMatchObject([{ kind: "data", actorAgentId: "owner", targets: [{ selector: "#a" }] }]);
    await store.feed(set(3, null, { attention: "milestone" }), "owner"); expect((await store.read("test"))!.updates).toHaveLength(1);
    const current = (await store.read("test"))!;
    await store.emit({ boardId: "test", eventId: "old-emit", source: "external", summary: "existing behavior", canvasBase: { revision: current.canvas.revision, documentVersion: current.canvas.documentVersion }, data: { legacy: true } }, "owner");
    expect((await store.read("test"))!.updates).toHaveLength(2);
  });
  it("persists exact ACK replay across restart and refuses changed values or sequence gaps", async () => {
    const opened = await store.feed(open(), "owner"); expect((await new BoardStore(root).feed(open(), "owner")).ack).toEqual(opened.ack);
    const accepted = await store.feed(set(1, { score: 2 }), "owner"); await store.feed(set(2, { score: 3 }), "owner");
    const before = (await store.read("test"))!.revision;
    expect((await new BoardStore(root).feed(set(1, { score: 2 }), "owner")).ack).toEqual(accepted.ack); expect((await store.read("test"))!.revision).toBe(before);
    await expect(store.feed(set(1, { score: 9 }), "owner")).rejects.toHaveProperty("code", "idempotency_conflict");
    await expect(store.feed(set(4, true), "owner")).rejects.toHaveProperty("code", "sequence_conflict");
    expect((await store.read("test"))!.feeds![0]).toMatchObject({ seq: 2, lastError: { code: "sequence_conflict" } });
  });
  it("allows independent producers in parallel but only one competing sequence commits", async () => {
    await store.feed(open(), "owner"); await store.feed(open("worker-b", "/live/b"), "owner");
    const results = await Promise.allSettled([store.feed(set(1, "left"), "owner"), new BoardStore(root).feed(set(1, "right"), "owner"), store.feed({ ...set(1, "other"), sourceId: "worker-b" }, "owner")]);
    expect(results.map(x => x.status)).toEqual(["fulfilled", "rejected", "fulfilled"]); expect((results[1] as PromiseRejectedResult).reason.code).toBe("idempotency_conflict");
    expect((await store.read("test"))!.canvas.data.live).toEqual({ a: "left", b: "other" });
  });
  it("rejects overlapping claims, stale generations, foreign identities and new IDs bypassing claims", async () => {
    await store.feed(open(), "owner"); await store.addInteraction({ boardId: "test", intentId: "side", kind: "fork", text: "Side" }, "side");
    for (const path of ["/live/a", "/live", "/live/a/x"]) await expect(store.feed(open("sneaky", path), "side")).rejects.toHaveProperty("code", "path_conflict");
    await expect(store.feed(open("worker", "/else", 1), "side")).rejects.toHaveProperty("code", "forbidden");
    await store.feed(open("worker", "/live/a", 1), "owner");
    await expect(store.feed(set(1, "old"), "owner")).rejects.toHaveProperty("code", "generation_conflict");
    await expect(store.feed({ ...set(1, "wrong"), generation: 2 }, "side")).rejects.toHaveProperty("code", "forbidden");
    await store.feed({ ...set(1, "new"), generation: 2 }, "owner");
    await store.feed({ action: "close", boardId: "test", sourceId: "worker", generation: 2 }, "owner");
    await expect(store.feed({ ...set(2, "late"), generation: 2 }, "owner")).rejects.toHaveProperty("code", "source_closed");
    await store.feed(open("replacement", "/live/a"), "side"); await store.feed({ ...set(1, "replacement"), sourceId: "replacement" }, "side");
    expect((await store.read("test"))!.canvas.data.live).toEqual({ a: "replacement" });
  });
  it("detects ordinary edits and adopts a new base only after explicit reopen", async () => {
    await store.feed(open(), "owner"); await store.feed(set(1, "feed"), "owner"); const current = (await store.read("test"))!;
    await store.publish({ boardId: "test", expectedRevision: current.revision, eventId: "manual", dataPatch: [{ operation: "set", path: "/live/a", expected: { exists: true, value: "feed" }, value: "manual" }] }, "owner");
    await expect(store.feed(set(2, "stale"), "owner")).rejects.toHaveProperty("code", "data_conflict"); expect((await store.read("test"))!.canvas.data.live).toEqual({ a: "manual" });
    await store.feed(open("worker", "/live/a", 1), "owner"); await store.feed({ ...set(1, "acknowledged"), generation: 2 }, "owner");
    expect((await store.read("test"))!.canvas.data.live).toEqual({ a: "acknowledged" });
  });
  it("rechecks revoked writer rights before writes and receipt replay", async () => {
    await store.feed(open(), "owner"); await store.feed(set(1, true), "owner"); const board = (await store.read("test"))!;
    await store.publish({ boardId: "test", expectedRevision: board.revision, eventId: "rebind", ownerAgentId: "new-owner" });
    const before = await readFile(join(root, "boards/test.json"), "utf8");
    for (const value of [set(1, true), set(2, false), open("worker", "/live/a", 1)]) await expect(store.feed(value, "owner")).rejects.toHaveProperty("code", "forbidden");
    expect(await readFile(join(root, "boards/test.json"), "utf8")).toBe(before);
  });
  it("bounds value and receipt retention and rejects unsafe pointers", async () => {
    for (const path of ["/constructor/x", "/__proto__/x", "wrong", "/x~3"]) await expect(store.feed(open("bad", path), "owner")).rejects.toHaveProperty("code", "invalid_input");
    await store.feed(open(), "owner"); await expect(store.feed(set(1, "x".repeat(256001)), "owner")).rejects.toHaveProperty("code", "size_limit");
    await expect(store.feed(set(1, undefined), "owner")).rejects.toHaveProperty("code", "invalid_input");
    for (let seq = 1; seq <= 34; seq++) await store.feed(set(seq, seq), "owner");
    expect((await store.read("test"))!.feeds![0].receipts).toHaveLength(32); await expect(store.feed(set(1, 1), "owner")).rejects.toHaveProperty("code", "sequence_conflict");
  });
  it("rejects overflow without accumulating an unbounded source queue", async () => {
    const work = Array.from({ length: 33 }, () => store.feed(open(), "owner"));
    const results = await Promise.allSettled(work);
    expect(results.slice(0, 32).every(result => result.status === "fulfilled")).toBe(true);
    expect(results[32]).toMatchObject({ status: "rejected", reason: { code: "backpressure" } });
    expect((await store.read("test"))!.feeds).toHaveLength(1);
    expect((await store.read("test"))!.revision).toBe(2);
  });
  it("will not create parents through existing scalar or array values", async () => {
    await store.feed(open(), "owner"); await store.feed(set(1, [1, 2]), "owner");
    await store.feed({ action: "close", boardId: "test", sourceId: "worker", generation: 1 }, "owner");
    await expect(store.feed(open("child", "/live/a/0/x"), "owner")).rejects.toHaveProperty("code", "data_conflict");
    expect((await store.read("test"))!.canvas.data.live).toEqual({ a: [1, 2] });
  });

});
