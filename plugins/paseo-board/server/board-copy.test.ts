import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BoardStore } from "./store";
import { BoardCopies } from "./board-copy";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "board-copy-")); directories.push(root);
  const store = new BoardStore(join(root, "boards"));
  const source = await store.create({ id: "source", title: "Work", ownerAgentId: "owner", html: '<main><p id="text">Private old text</p></main>', data: { publicValue: 4 } });
  await store.publish({ boardId: source.id, expectedRevision: source.revision, canvasBase: { revision: 1, documentVersion: 1 }, eventId: "edit", patch: { id: "patch", operation: "replace", selector: "#text", html: '<p id="text">Release text</p>' } });
  const current = (await store.read(source.id))!;
  const request = { boardId: source.id, canvasBase: { revision: current.canvas.revision, documentVersion: 1 }, title: "Release copy", eventId: "copy-event" };
  return { root, store, request, copies: new BoardCopies(join(root, "copies"), store) };
}
it("copies materialized content and data into an editable Board without discussions, history or saved controls", async () => {
  const { copies, store, request } = await fixture();
  await store.saveState({ boardId: "source", state: { secret: "private saved draft" } });
  const copy = await copies.copy(request);
  expect(copy.canvas.html).toContain("Release text"); expect(copy.canvas.html).not.toContain("Private old text");
  expect(copy.canvas.patches).toEqual([]); expect(copy.canvas.data).toEqual({ publicValue: 4 });
  expect(copy.interactions).toEqual([]); expect(copy.decisions).toEqual([]); expect(copy.userState).toEqual({});
  expect(copy.ownerAgentId).toBe("owner"); expect(copy.id).not.toBe("source");
});
it("replays a durable copy request after source changes and preserves manual copy edits", async () => {
  const { copies, store, request, root } = await fixture();
  const copy = await copies.copy(request);
  await store.rename({ boardId: copy.id, title: "Manual release title", expectedTitle: copy.title, eventId: "rename-copy" });
  await store.publish({ boardId: "source", expectedRevision: 2, canvasBase: request.canvasBase, replaceDocument: true, html: "New private work", eventId: "later" });
  const replay = await new BoardCopies(join(root, "copies"), store).copy(request);
  expect(replay.id).toBe(copy.id); expect(replay.title).toBe("Manual release title"); expect(replay.canvas.html).toContain("Release text");
  await expect(copies.copy({ ...request, title: "Different" })).rejects.toMatchObject({ code: "idempotency_conflict" });
});
it("rejects a stale source without creating a Board", async () => {
  const { copies, store, request } = await fixture();
  await expect(copies.copy({ ...request, canvasBase: { revision: 1, documentVersion: 1 } })).rejects.toMatchObject({ code: "revision_conflict" });
  expect(await store.list()).toHaveLength(1);
});
