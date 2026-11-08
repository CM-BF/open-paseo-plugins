import { expect, it } from "vitest";
import { createPagesOutbox, samePagesRequest, samePagesTarget } from "./pages-outbox";
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
it("reads legacy preparation records unchanged and persists automatic publication only on an explicit save", () => {
  const db = storage(), key = `@paseo:board-pages:v1:${encodeURIComponent(JSON.stringify(["host", "board"]))}:${request.eventId}`;
  db.setItem(key, JSON.stringify(request));
  const outbox = createPagesOutbox("host", "board", db);
  expect(outbox.list()).toEqual([request]);
  expect(JSON.parse(db.getItem(key)!)).toEqual(request);
  outbox.save(request);
  expect(JSON.parse(db.getItem(key)!)).toEqual({ action: "publish", request });
  expect(createPagesOutbox("host", "board", db).list()).toEqual([request]);
});
it("keeps the same account and repository on different GitHub hosts as distinct immutable targets", () => {
  const db = storage(), outbox = createPagesOutbox("paseo-host", "board", db);
  const enterprise = { ...request, githubHost: "github.enterprise.example" };
  outbox.save(enterprise);
  expect(createPagesOutbox("paseo-host", "board", db).list()).toEqual([enterprise]);
  expect(samePagesTarget(enterprise, request)).toBe(false);
  expect(samePagesRequest(enterprise, request)).toBe(false);
  expect(() => outbox.save(request)).toThrow("同一次发布请求");
  expect(() => outbox.save({ ...enterprise, githubHost: "another.enterprise.example" })).toThrow("同一次发布请求");
  outbox.save({ ...request, eventId: "publish-public" });
  expect(outbox.list()).toEqual([enterprise, { ...request, eventId: "publish-public" }]);
});
it("treats a missing GitHub host as public without changing an original legacy retry", () => {
  const db = storage(), outbox = createPagesOutbox("paseo-host", "board", db);
  const explicitPublic = { ...request, githubHost: "github.com" };
  outbox.save(request);
  expect(samePagesRequest(request, explicitPublic)).toBe(true);
  expect(outbox.save(explicitPublic)).toEqual(request);
  expect(outbox.list()).toEqual([request]);
  expect(() => outbox.save({ ...request, githubHost: "github.enterprise.example" })).toThrow("同一次发布请求");
});
