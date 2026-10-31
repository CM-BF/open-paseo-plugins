import { expect, it } from "vitest";
import { createPagesOutbox } from "./pages-outbox";
import type { DraftStorage } from "./draft-store";
function storage(): DraftStorage {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: key => { map.delete(key); }, subscribe: () => () => {} };
}
const request = { eventId: "publish-1", releaseId: `release-${"a".repeat(64)}`, artifactHash: "b".repeat(64), account: "example", repository: "example/site" };
it("retains the immutable account/repository/version after a fresh client and isolates Board/host scopes", () => {
  const db = storage(); createPagesOutbox("host:a", "board", db).save(request);
  expect(createPagesOutbox("host:a", "board", db).list()).toEqual([request]);
  expect(createPagesOutbox("host", "a:board", db).list()).toEqual([]);
  expect(createPagesOutbox("other", "board", db).list()).toEqual([]);
  expect(() => createPagesOutbox("host:a", "board", db).save({ ...request, repository: "example/elsewhere" })).toThrow();
});
it("does not discard other unfinished requests when one succeeds", () => {
  const outbox = createPagesOutbox("host", "board", storage());
  outbox.save(request); outbox.save({ ...request, eventId: "publish-2" }); outbox.remove(request.eventId);
  expect(outbox.list().map(item => item.eventId)).toEqual(["publish-2"]);
});
it("reports storage refusal before the caller can send", () => {
  const db = storage(); db.setItem = () => { throw new Error("Quota exceeded"); };
  expect(() => createPagesOutbox("host", "board", db).save(request)).toThrow("Quota exceeded");
  expect(() => createPagesOutbox("host", "board", null).save(request)).toThrow("发布重试记录");
});
