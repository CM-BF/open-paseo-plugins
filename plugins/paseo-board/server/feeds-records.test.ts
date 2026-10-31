import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { inspectBoard } from "./inspection";
import { ReadInputSchema, type FeedInput } from "../shared/contracts";

const open = (extra = {}): Extract<FeedInput, {action:"open"}> => ({ action: "open", boardId: "test", sourceId: "records", path: "/live/records", requestId: "records-open-1", expectedGeneration: 0, mode: "records", ...extra });
const append = (seq: number, records: unknown[], extra = {}): Extract<FeedInput, {action:"append"}> => ({ action: "append", boardId: "test", sourceId: "records", generation: 1, seq, records, ...extra });
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("bounded ordered records feeds", () => {
  let root: string, store: BoardStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "board-records-")); store = new BoardStore(root);
    await store.create({ id: "test", title: "Records", ownerAgentId: "owner", data: { untouched: true } });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const readRecords = async () => (await store.read("test"))!.canvas.data.live as { records: unknown[] };

  it("appends arbitrary records in order, exposes bounded counts and keeps history compact", async () => {
    const opened = await store.feed(open({ focusSelectors: ["#records"] }), "owner");
    expect(opened.source).toMatchObject({ mode: "records", capacity: { maxRecords: 10000, maxBytes: 1000000 }, recordCount: 0, recordBytes: 2 });
    expect((await store.read("test"))!.canvas.data).not.toHaveProperty("live");
    const records = [{ step: 1, metric: 0.5 }, [true, null], "中文", 42, false, null];
    const first = await store.feed(append(1, records), "owner");
    expect(first.ack).toMatchObject({ generation: 1, seq: 1, recordCount: 6, recordBytes: bytes(records) });
    expect((await store.read("test"))!.updates).toEqual([]);
    await store.feed(append(2, [{ free: "x".repeat(32000) }], { attention: "milestone" }), "owner");
    const board = (await store.read("test"))!;
    expect((await readRecords()).records).toEqual([...records, { free: "x".repeat(32000) }]);
    expect(board.canvas.data.untouched).toBe(true); expect(board.updates).toMatchObject([{ targets: [{ selector: "#records" }] }]);
    expect(board.interactions).toEqual([]);
    const inspected = inspectBoard(board, ReadInputSchema.parse({ boardId: "test", view: "inspect" }));
    expect(inspected.feeds[0]).toMatchObject({ mode: "records", recordCount: 7, recordBytes: bytes((await readRecords()).records), capacity: { maxRecords: 10000, maxBytes: 1000000 } });
    expect(inspected.feeds[0]).not.toHaveProperty("receipts");
    const raw = JSON.parse(await readFile(join(root, "boards/test.json"), "utf8"));
    const history = raw.history.filter((item: any) => item.operation === "feed" && item.payload.action === "append");
    expect(history).toHaveLength(2);
    expect(history[1].payload).toMatchObject({ appendedCount: 1, valueBytes: 32013, payloadFingerprint: expect.any(String), ack: { recordCount: 7 } });
    expect(history.every((item: any) => bytes(item) < 1600 && item.payload.records === undefined)).toBe(true);
  });

  it("replays the exact ACK without duplicating points across restarts and receipt-window expiry", async () => {
    const opened = await store.feed(open(), "owner");
    const first = await store.feed(append(1, ["one"]), "owner");
    await store.feed(append(2, ["two"]), "owner");
    const before = (await store.read("test"))!.revision;
    expect((await new BoardStore(root).feed(append(1, ["one"]), "owner")).ack).toEqual(first.ack);
    expect((await new BoardStore(root).feed(open(), "owner")).ack).toEqual(opened.ack);
    expect((await store.read("test"))!.revision).toBe(before);
    for (const changed of [append(1, ["other"]), append(1, ["one"], { attention: "milestone" })]) await expect(store.feed(changed, "owner")).rejects.toHaveProperty("code", "idempotency_conflict");
    await expect(store.feed(append(4, ["gap"]), "owner")).rejects.toHaveProperty("code", "sequence_conflict");
    for (let seq = 3; seq <= 34; seq++) await store.feed(append(seq, [seq]), "owner");
    await expect(store.feed(append(1, ["one"]), "owner")).rejects.toHaveProperty("code", "sequence_conflict");
    expect((await readRecords()).records).toEqual(["one", "two", ...Array.from({ length: 32 }, (_, i) => i + 3)]);
    expect((await store.read("test"))!.feeds![0].receipts).toHaveLength(32);
  });

  it("rejects the entire overflowing batch before sequence or data changes and preserves replay at capacity", async () => {
    await store.feed(open({ capacity: { maxRecords: 3, maxBytes: 100 } }), "owner");
    await store.feed(append(1, [1, 2]), "owner");
    const before = (await store.read("test"))!;
    await expect(store.feed(append(2, [3, 4]), "owner")).rejects.toMatchObject({ code: "capacity_exceeded", details: { recordCount: 2, attemptedRecordCount: 4, maxRecords: 3, maxBytes: 100 } });
    const failed = (await store.read("test"))!;
    expect(failed.canvas).toEqual(before.canvas); expect(failed.revision).toBe(before.revision); expect(failed.feeds![0].seq).toBe(1);
    const final = await store.feed(append(2, [3]), "owner");
    expect((await store.feed(append(2, [3]), "owner")).ack).toEqual(final.ack);
    await expect(store.feed(append(3, [4]), "owner")).rejects.toHaveProperty("code", "capacity_exceeded");
    expect((await readRecords()).records).toEqual([1, 2, 3]);
  });

  it("counts UTF-8 bytes including array punctuation and adopts only compatible existing arrays", async () => {
    const board = (await store.read("test"))!;
    await store.publish({ boardId: "test", expectedRevision: board.revision, canvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, eventId: "seed", data: { live: { records: ["中"] } } }, "owner");
    await expect(store.feed(open({ capacity: { maxBytes: 6 } }), "owner")).rejects.toHaveProperty("code", "capacity_exceeded");
    await store.feed(open({ capacity: { maxBytes: bytes(["中", "文"]) } }), "owner");
    const ack = (await store.feed(append(1, ["文"]), "owner")).ack;
    expect(ack).toMatchObject({ recordCount: 2, recordBytes: 13 });
    await expect(store.feed(append(2, [null]), "owner")).rejects.toMatchObject({ code: "capacity_exceeded", details: { recordBytes: 13, attemptedRecordBytes: 18, maxBytes: 13 } });
    await expect(store.feed(open({ sourceId: "wrong", path: "/untouched", requestId: "bad" }), "owner")).rejects.toHaveProperty("code", "data_conflict");
  });

  it("retains records through generation changes and rejects mode, path and immutable-open mismatches", async () => {
    await store.feed(open(), "owner"); await store.feed(append(1, ["retained"]), "owner");
    await expect(store.feed(open({ capacity: { maxRecords: 5 } }), "owner")).rejects.toHaveProperty("code", "idempotency_conflict");
    const next = { expectedGeneration: 1, requestId: "next" };
    await expect(store.feed(open({ ...next, mode: "latest" }), "owner")).rejects.toHaveProperty("code", "mode_conflict");
    await expect(store.feed(open({ ...next, path: "/new" }), "owner")).rejects.toHaveProperty("code", "path_conflict");
    await store.feed(open(next), "owner");
    await expect(store.feed(append(2, ["old"]), "owner")).rejects.toHaveProperty("code", "generation_conflict");
    await store.feed(append(1, ["next"], { generation: 2 }), "owner");
    expect((await readRecords()).records).toEqual(["retained", "next"]);
    await expect(store.feed({ action: "set", boardId: "test", sourceId: "records", generation: 2, seq: 2, value: [] }, "owner")).rejects.toHaveProperty("code", "mode_conflict");
    await store.feed(open({ sourceId: "latest", path: "/latest", mode: undefined }), "owner");
    await expect(store.feed(append(1, [1], { sourceId: "latest" }), "owner")).rejects.toHaveProperty("code", "mode_conflict");
    await expect(store.feed(open({ sourceId: "latest", path: "/latest", ...next }), "owner")).rejects.toHaveProperty("code", "mode_conflict");
  });

  it("stops after a manual edit and explicitly adopts the edited array without erasing it", async () => {
    await store.feed(open(), "owner"); await store.feed(append(1, [1]), "owner");
    const board = (await store.read("test"))!;
    await store.publish({ boardId: "test", expectedRevision: board.revision, eventId: "manual", dataPatch: [{ path: "/live/records", operation: "set", expected: { exists: true, value: [1] }, value: [1, "manual"] }] }, "owner");
    await expect(store.feed(append(2, [2]), "owner")).rejects.toHaveProperty("code", "data_conflict");
    await expect(store.feed(open({ sourceId: "bypass", requestId: "bypass" }), "owner")).rejects.toHaveProperty("code", "path_conflict");
    await store.feed(open({ expectedGeneration: 1, requestId: "reopen" }), "owner");
    await store.feed(append(1, [2], { generation: 2 }), "owner");
    expect((await readRecords()).records).toEqual([1, "manual", 2]);
  });

  it("serializes competing writers and blocks foreign source identities and overlapping paths", async () => {
    await store.addInteraction({ boardId: "test", intentId: "side", kind: "fork", text: "Side" }, "side");
    await store.feed(open(), "owner");
    await expect(store.feed(append(1, ["foreign"]), "side")).rejects.toHaveProperty("code", "forbidden");
    for (const path of ["/live", "/live/records", "/live/records/0"]) await expect(store.feed(open({ sourceId: "other", path }), "side")).rejects.toHaveProperty("code", "path_conflict");
    const concurrent = await Promise.allSettled([store.feed(append(1, ["a"]), "owner"), new BoardStore(root).feed(append(1, ["b"]), "owner")]);
    expect(concurrent.map(item => item.status)).toEqual(["fulfilled", "rejected"]);
    expect((await readRecords()).records).toEqual(["a"]);
    await store.feed({ action: "close", boardId: "test", sourceId: "records", generation: 1 }, "owner");
    await expect(store.feed(append(2, ["closed"]), "owner")).rejects.toHaveProperty("code", "source_closed");
    await store.feed(open({ sourceId: "successor", requestId: "successor" }), "side");
    await store.feed(append(1, ["b"], { sourceId: "successor" }), "side");
    expect((await readRecords()).records).toEqual(["a", "b"]);
  });

  it("validates empty, unsafe, oversized and deeply nested requests without consuming sequences", async () => {
    for (const path of ["/constructor/x", "/__proto__/x", "/a~2"]) {
      await expect(store.feed(open({ path }), "owner")).rejects.toHaveProperty("code", "invalid_input");
    }
    for (const capacity of [{ maxRecords: 0 }, { maxRecords: 50001 }, { maxBytes: 1 }, { maxBytes: 1500001 }, { keepLast: 2 }]) await expect(store.feed(open({ capacity }), "owner")).rejects.toHaveProperty("code", "invalid_input");
    await store.feed(open(), "owner");
    for (const records of [[], Array(1001).fill(1), [undefined], [Infinity], [() => 1], [new Date()]]) await expect(store.feed(append(1, records), "owner")).rejects.toHaveProperty("code", "invalid_input");
    await expect(store.feed(append(1, ["x".repeat(256000)]), "owner")).rejects.toHaveProperty("code", "size_limit");
    let deep: unknown = 0; for (let i = 0; i < 65; i++) deep = [deep];
    await expect(store.feed(append(1, [deep]), "owner")).rejects.toHaveProperty("code", "size_limit");
    expect((await store.read("test"))!.feeds![0].seq).toBe(0);
    await store.feed(append(1, ["valid"]), "owner"); expect((await readRecords()).records).toEqual(["valid"]);
  });

  it("rolls back staged history when complete canvas depth or global byte limits reject an otherwise valid batch", async () => {
    await store.feed(open(), "owner");
    let deep: unknown = 0; for (let i = 0; i < 63; i++) deep = [deep];
    await expect(store.feed(append(1, [deep]), "owner")).rejects.toHaveProperty("code", "size_limit");
    let board = (await new BoardStore(root).read("test"))!; expect(board.feeds![0].seq).toBe(0);
    await store.publish({ boardId: "test", expectedRevision: board.revision, canvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, eventId: "large", data: { unrelated: "x".repeat(1900000) } }, "owner");
    await expect(store.feed(append(1, ["x".repeat(200000)]), "owner")).rejects.toHaveProperty("code", "size_limit");
    board = (await new BoardStore(root).read("test"))!; expect(board.feeds![0].seq).toBe(0); expect(board.canvas.data).not.toHaveProperty("live");
    await store.feed(append(1, ["small"]), "owner"); expect((await readRecords()).records).toEqual(["small"]);
  });

  it("reads legacy latest sources without a mode and replays their existing open identity", async () => {
    const legacy = open({ sourceId: "latest", mode: undefined });
    const accepted = await store.feed(legacy, "owner");
    const path = join(root, "boards/test.json"), raw = JSON.parse(await readFile(path, "utf8"));
    delete raw.board.feeds[0].mode;
    await writeFile(path, JSON.stringify(raw));
    expect((await new BoardStore(root).feed({ ...legacy, mode: "latest" }, "owner")).ack).toEqual(accepted.ack);
  });
});
