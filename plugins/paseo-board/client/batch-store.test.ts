import { describe, expect, it } from "vitest";
import type { DraftStorage, StoredDraft } from "./draft-store";
import { createDraftStore } from "./draft-store";
import { acceptedBatchInteraction, createBatchStore, createCommentBatch, prepareCommentBatch, queuedDrafts, reconcileBatchDrafts } from "./batch-store";
import { withBatchPreparationLock, type BatchLockManager } from "./batch-lock-web";
import type { Interaction } from "../shared/contracts";

const scope = { hostId: "host", boardId: "board" };
function memory() {
  const data = new Map<string, string>();
  const storage: DraftStorage = { get length() { return data.size; }, key: index => [...data.keys()][index] ?? null, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
  return { data, storage };
}
function draft(id: string, queuedAt = 1): StoredDraft {
  return { id, revision: `${id}-revision`, updatedAt: 3, open: false, queuedAt, position: { x: 1, y: 2 }, compose: { kind: "question", text: `Comment ${id}`, anchor: { kind: "element", boardRevision: 3, canvasRevision: 2, selector: `#${id}`, image: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } } } };
}
describe("durable comment batch", () => {
  it("retains the source entity in an immutable outbox and refuses mixed replacement comments", () => {
    const { storage } = memory(), store = createBatchStore(scope, storage);
    const original = { ...draft("original"), compose: { ...draft("original").compose, expectedCreatedAt: "entity-one" } };
    const batch = createCommentBatch([original], "entity-intent", "main", "entity-one");
    expect(store.put(batch)).toEqual({ ok: true });
    const restored = createBatchStore(scope, storage).list().batches[0];
    expect(restored.expectedCreatedAt).toBe("entity-one");
    expect(store.put({ ...restored, expectedCreatedAt: "entity-two" })).toMatchObject({ ok: false });
    expect(() => createCommentBatch([original], "replacement-intent", "main", "entity-two")).toThrow("画板已被替换");
    const receipt: Interaction = { id: batch.intentId, expectedCreatedAt: "entity-two", kind: "change", destination: "main", text: batch.text, comments: batch.comments, status: "saved", resultReferences: [], createdAt: "now", updatedAt: "now" };
    expect(acceptedBatchInteraction(batch, [receipt])).toBeUndefined();
    expect(acceptedBatchInteraction(batch, [{ ...receipt, expectedCreatedAt: "entity-one" }])).toBeDefined();
  });
  it("reads after acquiring the browser lock so competing preparations cannot claim the same source revisions", async () => {
    const { storage } = memory(), drafts = createDraftStore(scope, storage), batches = createBatchStore(scope, storage);
    const saved = drafts.put(draft("one")); if (!saved.ok) throw new Error("fixture");
    const grants: Array<() => void> = [];
    const locks: BatchLockManager = { request: (_name, callback) => new Promise((resolve, reject) => { grants.push(() => { try { resolve(callback()); } catch (error) { reject(error); } }); }) };
    const reviewed = [{ id: saved.draft.id, revision: saved.draft.revision }];
    const first = prepareCommentBatch(scope, drafts, batches, "main", "first-intent", reviewed, locks);
    const second = prepareCommentBatch(scope, drafts, batches, "side", "second-intent", reviewed, locks).then(() => "unexpected success", error => String(error));
    expect(batches.list().batches).toEqual([]);
    grants.shift()!(); expect((await first).comments[0].text).toBe("Comment one");
    grants.shift()!(); expect(await second).toContain("这些评论已在另一窗口发送");
    expect(batches.list().batches.map(batch => batch.intentId)).toEqual(["first-intent"]);
  });
  it.each(["edit", "add", "delete"])("rejects a queue %s while waiting for the lock without expanding the reviewed request", async action => {
    const { storage } = memory(), drafts = createDraftStore(scope, storage), batches = createBatchStore(scope, storage);
    const saved = drafts.put(draft("one")); if (!saved.ok) throw new Error("fixture");
    let grant!: () => void;
    const locks: BatchLockManager = { request: (_name, callback) => new Promise((resolve, reject) => { grant = () => { try { resolve(callback()); } catch (error) { reject(error); } }; }) };
    const prepared = prepareCommentBatch(scope, drafts, batches, "main", "waiting", [saved.draft], locks).then(() => "unexpected success", error => String(error));
    if (action === "edit") drafts.put({ ...saved.draft, compose: { ...saved.draft.compose, text: "Unreviewed words" } }, saved.draft.revision);
    else if (action === "add") drafts.put(draft("another", 2));
    else drafts.remove(saved.draft.id, saved.draft.revision);
    grant(); expect(await prepared).toContain("待发送评论已在另一窗口更新，请重新核对后再统一发送");
    expect(batches.list().batches).toEqual([]);
  });
  it("refuses first-send preparation without atomic browser locks", async () => {
    let called = false;
    await expect(withBatchPreparationLock(scope, () => { called = true; })).rejects.toThrow("此浏览器暂不支持统一发送");
    expect(called).toBe(false);
  });
  it("freezes stable order, all locations and exact source revisions before an immutable send", () => {
    const { storage } = memory(), store = createBatchStore(scope, storage);
    const drafts = [draft("second", 2), draft("first", 1)];
    const batch = createCommentBatch(drafts, "intent", "side");
    expect(store.put(batch)).toEqual({ ok: true });
    drafts[0].compose.anchor!.image!.data = "changed";
    const restored = createBatchStore(scope, storage).list();
    expect(restored.issues).toEqual([]);
    expect(restored.batches[0].comments.map(item => item.id)).toEqual(["first", "second"]);
    expect(restored.batches[0].comments[1].anchor?.image?.data).toBe(draft("second").compose.anchor!.image!.data);
    expect(restored.batches[0].drafts[0]).toEqual({ id: "first", revision: "first-revision" });
    expect(store.put({ ...batch, destination: "main" })).toMatchObject({ ok: false });
    expect(store.put({ ...batch, intentId: "another-intent" })).toMatchObject({ ok: false });
    expect(createBatchStore({ ...scope, hostId: "elsewhere" }, storage).list().batches).toEqual([]);
  });
  it("does not enroll ordinary, empty, conflicted or uncertain drafts and hides captured revisions", () => {
    const staged = draft("staged"), unknown = { ...draft("unknown"), compose: { ...draft("unknown").compose, intentId: "single", destination: "main" as const } };
    const all = [staged, { ...draft("ordinary"), queuedAt: undefined }, { ...draft("empty"), compose: { kind: "question" as const, text: " " } }, { ...draft("conflicted"), conflicted: true }, unknown];
    expect(queuedDrafts(all, []).map(item => item.id)).toEqual(["staged"]);
    const batch = createCommentBatch([staged], "intent", "main");
    expect(queuedDrafts(all, [batch])).toEqual([]);
    expect(queuedDrafts([{ ...staged, revision: "newer" }], [batch])).toHaveLength(1);
    expect(() => createCommentBatch([unknown], "bad", "main")).toThrow();
  });
  it("only accepts an exact whole-batch receipt and keeps newer edits during cleanup", () => {
    const { storage } = memory(), drafts = createDraftStore(scope, storage);
    const put = drafts.put(draft("first")); if (!put.ok) throw new Error("fixture");
    const batch = createCommentBatch([put.draft], "intent", "main");
    const item: Interaction = { id: batch.intentId, kind: "change", destination: "main", text: batch.text, comments: batch.comments, status: "saved", resultReferences: [], createdAt: "now", updatedAt: "now" };
    expect(acceptedBatchInteraction(batch, [item])).toBe(item);
    const reordered: Interaction = { ...item, comments: [{ anchor: { selector: "#first", image: { data: batch.comments[0].anchor!.image!.data, mimeType: "image/png" }, canvasRevision: 2, boardRevision: 3, kind: "element" }, text: batch.comments[0].text, id: "first" }] };
    expect(acceptedBatchInteraction(batch, [reordered])).toBe(reordered);
    const optional = createCommentBatch([{ ...put.draft, compose: { ...put.draft.compose, anchor: { ...put.draft.compose.anchor!, image: undefined } } }], "without-image", "main");
    expect(acceptedBatchInteraction(optional, [{ ...item, id: optional.intentId, comments: JSON.parse(JSON.stringify(optional.comments)) }])).toBeDefined();
    expect(acceptedBatchInteraction(batch, [{ ...item, comments: [{ ...item.comments![0], text: "Different" }] }])).toBeUndefined();
    expect(acceptedBatchInteraction(batch, [{ ...item, destination: "side" }])).toBeUndefined();
    const newer = drafts.put({ ...put.draft, compose: { ...put.draft.compose, text: "New words" } }, put.draft.revision); expect(newer.ok).toBe(true);
    expect(reconcileBatchDrafts(batch, drafts)).toEqual({ ok: true });
    expect(drafts.list().drafts[0].compose.text).toBe("New words");
  });
  it("retains damaged records and refuses storage failures without inventing successful staging", () => {
    const { data, storage } = memory(), store = createBatchStore(scope, storage), batch = createCommentBatch([draft("one")], "intent", "main");
    storage.setItem = () => { throw new Error("disk full"); };
    expect(store.put(batch)).toMatchObject({ ok: false }); expect(data.size).toBe(0);
    expect(createBatchStore(scope, null).put(batch)).toMatchObject({ ok: false });
  });
  it("freezes the new-Side choice with the destination and requires it on a created Side", () => {
    const { storage } = memory(), store = createBatchStore(scope, storage);
    const batch = createCommentBatch([draft("first")], "history-intent", "new-side", undefined, "owner-history");
    expect(batch.sideContext).toBe("owner-history");
    expect(store.put(batch)).toEqual({ ok: true }); expect(createBatchStore(scope, storage).list().batches[0].sideContext).toBe("owner-history");
    expect(createCommentBatch([draft("first")], "main-intent", "main", undefined, "owner-history").sideContext).toBeUndefined();
    expect(createCommentBatch([draft("first")], "blank-intent", "side", undefined, "blank").sideContext).toBeUndefined();
    const item: Interaction = { id: batch.intentId, kind: "fork", destination: "new-side", text: batch.text, comments: batch.comments, sideContext: "owner-history", status: "saved", resultReferences: [], createdAt: "now", updatedAt: "now" };
    expect(acceptedBatchInteraction(batch, [item])).toBe(item);
    expect(acceptedBatchInteraction(batch, [{ ...item, sideContext: undefined }])).toBeUndefined();
    const side = createCommentBatch([draft("first")], "side-intent", "side", undefined, "owner-history");
    const reply: Interaction = { ...item, id: side.intentId, destination: "side", kind: "reply", sideContext: undefined };
    expect(acceptedBatchInteraction(side, [reply])).toBe(reply);
  });
});
