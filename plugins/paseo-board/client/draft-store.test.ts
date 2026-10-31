import { describe, expect, it, vi } from "vitest";
import type { Anchor } from "../shared/contracts";
import { createDraftStore, DRAFT_STORAGE_PREFIX, type DraftInput, type DraftStorage, type DraftWriteResult, type StoredDraft } from "./draft-store";

function memory() {
  const data = new Map<string, string>();
  const writes: Array<{ key: string; value: string }> = [];
  const storage: DraftStorage = {
    get length() { return data.size; }, key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null,
    setItem(key, value) { writes.push({ key, value }); data.set(key, value); },
    removeItem(key) { data.delete(key); },
  };
  return { data, writes, storage };
}
const scope = { hostId: "local-host", boardId: "test-board" };
const anchor = (): Anchor => ({ boardRevision: 8, canvasRevision: 3, kind: "element", selector: "#card", text: "Frozen caption",
  rect: { x: 15, y: 25, width: 70, height: 40 }, image: { mimeType: "image/png", data: "iVBORw0KGgoABC123=" },
  binding: { documentVersion: 1, key: "binding-key", target: { selector: "#card", tag: "article", id: "card", fingerprint: "abcdef01" }, ancestors: [], relative: { x: 0.2, y: 0.3 } } });
const input = (id = "draft-one"): DraftInput => ({ id, compose: { kind: "question", text: "Words not sent", anchor: anchor() }, position: { x: 80, y: 40 }, open: true });
function saved(result: DraftWriteResult): StoredDraft { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.issue.message); return result.draft; }

describe("durable contextual message drafts", () => {
  it("survives a fresh store with the exact frozen component, image, route and coordinates, excluding executable callbacks and capture leases", () => {
    const { storage } = memory(), store = createDraftStore(scope, storage), draft = input();
    Object.assign(draft.compose, { intentId: "intent-frozen", destination: "side", captureStatus: "pending", selectionId: "expired-lease", resolve: vi.fn() });
    const first = saved(store.put(draft));
    draft.compose.text = "changed after saving"; draft.compose.anchor!.selector = "#another";
    const restored = createDraftStore(scope, storage).list();
    expect(restored.issues).toEqual([]); expect(restored.drafts).toHaveLength(1);
    expect(restored.drafts[0]).toMatchObject({ id: draft.id, revision: first.revision, position: { x: 80, y: 40 }, compose: {
      text: "Words not sent", intentId: "intent-frozen", destination: "side", captureStatus: "omitted", anchor: anchor(),
    } });
    expect(restored.drafts[0].compose).not.toHaveProperty("selectionId"); expect(restored.drafts[0].compose).not.toHaveProperty("resolve");
    expect(Object.isFrozen(restored.drafts[0].compose.anchor!.binding!.target)).toBe(true);
  });
  it("isolates both host and Board even for colliding IDs and does not need a daemon connection", () => {
    const { storage } = memory();
    saved(createDraftStore(scope, storage).put(input()));
    expect(createDraftStore({ ...scope, hostId: "remote-host" }, storage).list().drafts).toEqual([]);
    expect(createDraftStore({ ...scope, boardId: "other-board" }, storage).list().drafts).toEqual([]);
    saved(createDraftStore({ ...scope, boardId: "other-board" }, storage).put(input()));
    expect(createDraftStore(scope, storage).list().drafts).toHaveLength(1);
  });
  it("retains separate hidden drafts and bounds normal typing to one small revision and one PNG write per reference", () => {
    const { storage, data, writes } = memory(), store = createDraftStore(scope, storage);
    const draft = input(); let current = saved(store.put(draft));
    for (let i = 0; i < 100; i++) current = saved(store.put({ ...draft, compose: { ...draft.compose, text: "Typed " + i } }, current.revision));
    expect([...data.keys()].filter(key => key.includes(":draft:"))).toHaveLength(1);
    expect(writes.filter(write => write.key.includes(":anchor:"))).toHaveLength(1);
    expect(writes.filter(write => write.key.includes(":draft:")).every(write => !write.value.includes("iVBOR"))).toBe(true);
    saved(store.put({ ...current, open: false }, current.revision)); saved(store.put(input("draft-two")));
    const restored = createDraftStore(scope, storage).list().drafts;
    expect(restored).toHaveLength(2); expect(restored.find(item => item.id === draft.id)).toMatchObject({ open: false, compose: { text: "Typed 99" } });
  });
  it("keeps the last durable version if a full disk rejects the new text or PNG and does not advertise success", () => {
    const { storage, data } = memory(), store = createDraftStore(scope, storage), first = saved(store.put(input()));
    const before = new Map(data);
    storage.setItem = () => { throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); };
    expect(store.put({ ...first, compose: { ...first.compose, text: "New words" } }, first.revision)).toMatchObject({ ok: false, issue: { code: "quota" } });
    expect(store.put(input("draft-new"))).toMatchObject({ ok: false, issue: { code: "quota" } });
    expect(data).toEqual(before); expect(createDraftStore(scope, storage).list().drafts[0].compose.text).toBe("Words not sent");
  });
  it("refuses stale writes and clears without removing words saved since the caller read its version", () => {
    const { storage } = memory(), store = createDraftStore(scope, storage), old = saved(store.put(input()));
    const current = saved(store.put({ ...old, compose: { ...old.compose, text: "Newer words" } }, old.revision));
    expect(store.remove(old.id, old.revision)).toMatchObject({ ok: false, issue: { code: "conflict" } });
    expect(store.put({ ...old, compose: { ...old.compose, text: "Stale words" } }, old.revision)).toMatchObject({ ok: false, issue: { code: "conflict" } });
    expect(store.list().drafts.map(item => item.revision)).toEqual([current.revision]);
    expect(store.remove(current.id, current.revision)).toEqual({ ok: true }); expect(createDraftStore(scope, storage).list().drafts).toEqual([]);
  });
  it("keeps both interleaved window branches and removing one cannot delete the other", () => {
    const { storage } = memory(), a = createDraftStore(scope, storage), b = createDraftStore(scope, storage);
    const old = saved(a.put(input())); let second!: StoredDraft;
    const set = storage.setItem;
    let interleave = true;
    storage.setItem = (key, value) => {
      if (interleave && key.includes(":draft:")) {
        interleave = false; second = saved(b.put({ ...old, compose: { ...old.compose, text: "Window B" } }, old.revision));
      }
      set(key, value);
    };
    const first = saved(a.put({ ...old, compose: { ...old.compose, text: "Window A" } }, old.revision));
    const reopened = createDraftStore(scope, storage);
    expect(reopened.list().drafts.map(item => item.compose.text).sort()).toEqual(["Window A", "Window B"]);
    expect(reopened.list().drafts.every(item => item.conflicted)).toBe(true);
    expect(reopened.remove(first.id, first.revision)).toEqual({ ok: true });
    expect(reopened.list().drafts.map(item => item.revision)).toEqual([second.revision]);
  });
  it("repairs a reference discarded by another window after a writer read its parent", () => {
    const { storage } = memory(), writer = createDraftStore(scope, storage), remover = createDraftStore(scope, storage);
    const old = saved(writer.put(input())), set = storage.setItem;
    let interleave = true;
    storage.setItem = (key, value) => {
      if (interleave && key.includes(":draft:")) {
        interleave = false; expect(remover.remove(old.id, old.revision)).toEqual({ ok: true });
      }
      set(key, value);
    };
    const latest = saved(writer.put({ ...old, compose: { ...old.compose, text: "Still typing in the other window" } }, old.revision));
    expect(createDraftStore(scope, storage).list()).toMatchObject({ issues: [], drafts: [{ revision: latest.revision, compose: { anchor: anchor() } }] });
  });
  it("the remover repairs a new branch committed between its unused check and the reference deletion", () => {
    const { storage, data } = memory(), store = createDraftStore(scope, storage), old = saved(store.put(input()));
    const oldKey = [...data.keys()].find(key => key.includes(":draft:"))!, oldRecord = JSON.parse(data.get(oldKey)!);
    const remove = storage.removeItem;
    let interleave = true;
    storage.removeItem = key => {
      if (interleave && key.includes(":anchor:")) {
        interleave = false;
        const revision = "other-window-committed";
        storage.setItem(oldKey.replace(old.revision, revision), JSON.stringify({ ...oldRecord, revision, parent: old.revision, supersedes: [old.revision], compose: { ...oldRecord.compose, text: "Concurrent words" } }));
      }
      remove(key);
    };
    expect(store.remove(old.id, old.revision)).toEqual({ ok: true });
    expect(createDraftStore(scope, storage).list()).toMatchObject({ issues: [], drafts: [{ compose: { text: "Concurrent words", anchor: anchor() } }] });
  });
  it("explicit discard releases PNG capacity immediately so a full store can accept a new reference", () => {
    const { storage, data } = memory(), set = storage.setItem, store = createDraftStore(scope, storage);
    storage.setItem = (key, value) => {
      const size = [...data.entries()].reduce((sum, [entry, raw]) => sum + (entry === key ? 0 : entry.length + raw.length), key.length + value.length);
      if (size > 180000) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
      set(key, value);
    };
    const first = input(); first.compose.anchor!.image!.data = "A".repeat(100000);
    const old = saved(store.put(first)), second = { ...first, id: "new-reference" };
    expect(store.put(second)).toMatchObject({ ok: false, issue: { code: "quota" } });
    expect(store.remove(old.id, old.revision)).toEqual({ ok: true }); expect(data.size).toBe(0);
    expect(store.put(second).ok).toBe(true);
  });
  it("cold-loads a large PNG once, then text edits and shelf refreshes neither reread nor rewrite it", () => {
    const { storage, writes } = memory(), draft = input(); draft.compose.anchor!.image!.data = "A".repeat(1000000);
    saved(createDraftStore(scope, storage).put(draft));
    let imageReads = 0;
    const get = storage.getItem;
    storage.getItem = key => { if (key.includes(":anchor:")) imageReads++; return get(key); };
    const reloaded = createDraftStore(scope, storage); let current = reloaded.list().drafts[0];
    expect(imageReads).toBe(1);
    for (let i = 0; i < 100; i++) {
      current = saved(reloaded.put({ ...current, compose: { ...current.compose, text: "Typed " + i } }, current.revision));
      expect(reloaded.list().issues).toEqual([]);
    }
    expect(imageReads).toBe(1); expect(writes.filter(write => write.key.includes(":anchor:"))).toHaveLength(1);
  });
  it("can discard with zero quota headroom, and retains the live head if old ancestor deletion fails", () => {
    const { storage, data } = memory(), store = createDraftStore(scope, storage), first = saved(store.put(input()));
    const remove = storage.removeItem;
    storage.removeItem = () => { throw new Error("temporary remove failure"); };
    const latest = saved(store.put({ ...first, compose: { ...first.compose, text: "Latest unsent words" } }, first.revision));
    storage.setItem = () => { throw Object.assign(new Error("zero free bytes"), { name: "QuotaExceededError" }); };
    expect(store.remove(latest.id, latest.revision)).toMatchObject({ ok: false, issue: { code: "failed" } });
    expect(createDraftStore(scope, storage).list().drafts.map(item => item.compose.text)).toEqual(["Latest unsent words"]);
    storage.removeItem = remove;
    expect(store.remove(latest.id, latest.revision)).toEqual({ ok: true });
    expect(createDraftStore(scope, storage).list()).toEqual({ drafts: [], issues: [] }); expect(data.size).toBe(0);
  });
  it("does not resurrect an ancestor when cleanup fails across edits or after a confirmed discard", () => {
    const { storage } = memory(), store = createDraftStore(scope, storage), old = saved(store.put(input()));
    const remove = storage.removeItem;
    storage.removeItem = () => { throw new Error("temporary remove failure"); };
    const newer = saved(store.put({ ...old, compose: { ...old.compose, text: "second" } }, old.revision));
    const latest = saved(store.put({ ...newer, compose: { ...newer.compose, text: "third" } }, newer.revision));
    expect(createDraftStore(scope, storage).list().drafts.map(item => item.compose.text)).toEqual(["third"]);
    expect(store.remove(latest.id, latest.revision)).toEqual({ ok: true });
    expect(createDraftStore(scope, storage).list().drafts).toEqual([]);
    storage.removeItem = remove;
  });
  it("reports damaged records without overwriting them or substituting a current component reference", () => {
    const { storage, data } = memory(), store = createDraftStore(scope, storage); saved(store.put(input()));
    const recordKey = [...data.keys()].find(key => key.includes(":draft:"))!;
    const brokenKey = recordKey.slice(0, recordKey.lastIndexOf(":") + 1) + "bad-record";
    data.set(brokenKey, "{broken");
    const snapshot = createDraftStore(scope, storage).list();
    expect(snapshot.drafts).toHaveLength(1); expect(snapshot.issues).toMatchObject([{ code: "corrupt" }]);
    expect(data.get(brokenKey)).toBe("{broken");
    data.delete([...data.keys()].find(key => key.includes(":anchor:"))!);
    expect(store.list().drafts).toEqual([]); // A warm cached image cannot hide external clearing.
    const missing = createDraftStore(scope, storage).list();
    expect(missing.drafts).toEqual([]); expect(missing.issues.every(item => item.code === "corrupt")).toBe(true);
    expect(data.has(recordKey)).toBe(true);
  });
  it("makes unavailable native/browser storage explicit and validates untrusted stored identifiers", () => {
    const store = createDraftStore(scope, null);
    expect(store.list()).toMatchObject({ drafts: [], issues: [{ code: "unavailable" }] });
    expect(store.put(input())).toMatchObject({ ok: false, issue: { code: "unavailable" } });
    const { storage, data } = memory();
    expect(createDraftStore(scope, storage).put(input("bad/path"))).toMatchObject({ ok: false, issue: { code: "invalid" } }); expect(data.size).toBe(0);
    const invalid = input(); invalid.compose.intentId = "intent-without-route";
    expect(createDraftStore(scope, storage).put(invalid)).toMatchObject({ ok: false, issue: { code: "invalid" } });
  });
  it("notifies mounted stores in the same scope, unsubscribes, and namespaces only its own keys", () => {
    const { storage, data } = memory(), a = createDraftStore(scope, storage), listener = vi.fn(), other = vi.fn();
    const off = a.subscribe(listener), offOther = createDraftStore({ ...scope, boardId: "other" }, storage).subscribe(other);
    saved(createDraftStore(scope, storage).put(input())); expect(listener).toHaveBeenCalledOnce(); expect(other).not.toHaveBeenCalled();
    off(); offOther(); saved(a.put(input("second"))); expect(listener).toHaveBeenCalledOnce();
    expect([...data.keys()].every(key => key.startsWith(DRAFT_STORAGE_PREFIX))).toBe(true);
  });
  it("does not turn an observer exception into a failed commit", () => {
    const { storage } = memory(), store = createDraftStore(scope, storage), off = store.subscribe(() => { throw new Error("observer failed"); });
    const result = saved(store.put(input())); expect(store.remove(result.id, result.revision)).toEqual({ ok: true }); off();
  });
});
