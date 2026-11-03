import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeAuthoring, type AuthoringCanvas } from "./authored-source";
import { BoardStore } from "./store";
import { BoardCopies } from "./board-copy";
import { buildRelease } from "./static-release";
import type { Board, CanvasPatch } from "../shared/contracts";

const fragment = 'Lead<!-- retained --><section id="a"><input value="keep"></section>';
const additions: CanvasPatch[] = [
  { id: "old-body-append", selector: "body", operation: "append", html: '<article id="b"><p id="message">Appended</p></article>' },
  { id: "old-body-prepend", selector: "body", operation: "prepend", html: '<header id="first">First</header>' },
  { id: "later-edit", selector: "#message", operation: "replace", html: '<p id="message">Updated after root append</p>' },
];
const base = (board: Board) => ({ revision: board.canvas.revision, documentVersion: board.canvas.documentVersion });
const oldCanvas = (): AuthoringCanvas => ({ html: fragment, patches: structuredClone(additions), revision: 4, documentVersion: 1 });

describe("fragment root journal recovery", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "board-root-patches-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("recovers existing body append/prepend entries and later patches without rewriting their identities or the base", () => {
    const canvas = oldCanvas(), before = structuredClone(canvas);
    const result = describeAuthoring(canvas, "#b");
    expect(result.replay).toEqual({ complete: true, appliedPatchIds: additions.map(p => p.id) });
    expect(result.materializedAuthoredHtml).toBe('<header id="first">First</header>' + fragment + '<article id="b"><p id="message">Updated after root append</p></article>');
    expect(result.target?.html).toContain("Updated after root append");
    expect(result.materializedAuthoredHtml).not.toMatch(/<(?:html|head|body)[ >]/);
    expect(canvas).toEqual(before);
  });

  it("accepts new root additions, preserves exact retry receipts and cold-recovers authoring, export and editable copy", async () => {
    const store = new BoardStore(join(directory, "store"));
    let board = await store.create({ id: "root-recovery", title: "Root recovery", html: fragment, data: { secret: "not-public" } });
    const requests = [];
    for (const patch of additions) {
      const request = { boardId: board.id, expectedRevision: board.revision, canvasBase: base(board), eventId: patch.id, patch };
      requests.push(request); board = await store.publish(request);
    }
    const path = join(directory, "store", "boards", board.id + ".json"), bytes = await readFile(path, "utf8");
    const reopened = new BoardStore(join(directory, "store"));
    expect(await reopened.publish(requests[0])).toEqual(board);
    const restored = (await reopened.read(board.id))!;
    const authoring = describeAuthoring(restored.canvas);
    expect(authoring.replay.complete).toBe(true);
    expect(restored.canvas.html).toBe(fragment);
    expect(restored.canvas.patches).toEqual(additions);
    const release = buildRelease({ board: restored, boardId: board.id, expectedCanvasBase: base(restored), publicData: {} });
    expect(release.files["index.html"]).toContain("Updated after root append");
    expect(JSON.stringify(release.files)).not.toContain("not-public");
    const copy = await new BoardCopies(join(directory, "copies"), reopened).copy({ boardId: board.id, canvasBase: base(restored), eventId: "copy-recovered", title: "Independent copy" });
    expect(copy.canvas.html).toBe(authoring.materializedAuthoredHtml);
    expect(copy.canvas.patches).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(bytes);
  });

  it.each(["body", "html", "head", ":root", "html > body", ":is(body)"])("rejects root replace/remove at publish time without a receipt or source mutation: %s", async selector => {
    for (const html of [fragment, '<!doctype html><html><head></head><body>' + fragment + '</body></html>']) {
      const store = new BoardStore(join(directory, "store-" + (html === fragment ? "fragment" : "document")));
      const board = await store.create({ id: "root-boundary", title: "Root boundary", html });
      for (const operation of ["replace", "remove"] as const) {
        await expect(store.publish({ boardId: board.id, expectedRevision: board.revision, canvasBase: base(board), eventId: operation, patch: { id: operation, selector, operation, html: "Wrong" } })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("document root") });
        expect(await store.read(board.id)).toEqual(board);
      }
    }
  });

  it("allows empty fragment body insertions and full-document head/body additions while retaining authored root attributes", () => {
    expect(describeAuthoring({ ...oldCanvas(), html: "", patches: additions.slice(0, 2) }).materializedAuthoredHtml).toBe('<header id="first">First</header><article id="b"><p id="message">Appended</p></article>');
    const document = { ...oldCanvas(), html: '<!doctype html><html lang="zh"><head data-theme="authored"></head><body class="page"></body></html>', patches: [
      { id: "style", selector: "head", operation: "append" as const, html: '<style id="custom">.page{color:red}</style>' },
      ...additions,
    ] };
    const source = describeAuthoring(document);
    expect(source.replay.complete).toBe(true);
    expect(source.materializedAuthoredHtml).toContain('<html lang="zh">');
    expect(source.materializedAuthoredHtml).toContain('<head data-theme="authored"><style id="custom">');
    expect(source.materializedAuthoredHtml).toContain('<body class="page"><header id="first">');
  });

  it("protects response roots too, accepts response body additions, and rejects fragment html/head insertions", async () => {
    const store = new BoardStore(join(directory, "store"));
    const board = await store.create({ id: "responses", title: "Responses", html: fragment });
    await store.addInteraction({ boardId: board.id, intentId: "question", kind: "question", text: "Visual answer" }, "owner");
    const answer = await store.respond({ boardId: board.id, interactionId: "question", expectedResponseRevision: 0, eventId: "answer", response: "Here", html: fragment });
    const appended = await store.respond({ boardId: board.id, interactionId: "question", expectedResponseRevision: answer.responseRevision!, eventId: "append", response: "Extended", patch: additions[0] });
    expect(describeAuthoring(appended.responseCanvas!).replay.complete).toBe(true);
    const before = await store.read(board.id);
    for (const selector of ["body", "html", "head", ":root"]) {
      await expect(store.respond({ boardId: board.id, interactionId: "question", expectedResponseRevision: appended.responseRevision!, eventId: "bad-" + selector, response: "Wrong", patch: { id: "bad-" + selector, selector, operation: "remove" } })).rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const selector of ["html", "head", ":root"]) for (const operation of ["append", "prepend"] as const) {
      await expect(store.publish({ boardId: board.id, expectedRevision: board.revision, canvasBase: base(board), eventId: "bad-" + selector + operation, patch: { id: "bad-" + selector + operation, selector, operation, html: "Wrong" } })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringContaining("host document wrapper") });
    }
    expect(await store.read(board.id)).toEqual(before);
  });

  it("checks root aliases against prior authored edits instead of spelling or first-element guesses", async () => {
    const store = new BoardStore(join(directory, "store"));
    let board = await store.create({ id: "root-alias", title: "Root alias", html: fragment });
    board = await store.publish({ boardId: board.id, expectedRevision: board.revision, canvasBase: base(board), eventId: "append", patch: additions[0] });
    await expect(store.publish({ boardId: board.id, expectedRevision: board.revision, canvasBase: base(board), eventId: "alias", patch: { id: "alias", selector: "body:has(#b)", operation: "remove" } })).rejects.toMatchObject({ code: "invalid_input" });
    const replacement = await store.publish({ boardId: board.id, expectedRevision: board.revision, canvasBase: base(board), eventId: "authored-root", patch: { id: "authored-root", selector: "body > #a", operation: "replace", html: '<main id="a">Authored replacement is allowed</main>' } });
    expect(describeAuthoring(replacement.canvas).materializedAuthoredHtml).toContain("Authored replacement is allowed");
  });

  it("still accepts runtime-generated selectors and later safe authored writes when static replay cannot observe the generated DOM", async () => {
    const store = new BoardStore(join(directory, "store"));
    let board = await store.create({ id: "dynamic", title: "Dynamic", html: '<main id="stable"></main><script>document.querySelector("#stable").innerHTML=\'<p id="dynamic">Runtime</p>\'</script>' });
    board = await store.publish({ boardId: board.id, expectedRevision: board.revision, canvasBase: base(board), eventId: "runtime", patch: { id: "runtime", selector: "#dynamic", operation: "append", html: " retained" } });
    board = await store.publish({ boardId: board.id, expectedRevision: board.revision, canvasBase: base(board), eventId: "safe", patch: { id: "safe", selector: "body", operation: "append", html: '<aside id="later">Later</aside>' } });
    expect(board.canvas.patches.map(p => p.id)).toEqual(["runtime", "safe"]);
    expect(describeAuthoring(board.canvas).replay.failedPatch?.id).toBe("runtime");
    await expect(store.publish({ boardId: board.id, expectedRevision: board.revision, canvasBase: base(board), eventId: "unsafe", patch: { id: "unsafe", selector: "body", operation: "remove" } })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await store.read(board.id)).toEqual(board);
  });

  it("measures 100 incremental root publications and recovers the full unchanged journal", async () => {
    const store = new BoardStore(join(directory, "store"));
    let board = await store.create({ id: "hundred-patches", title: "Hundred patches", html: fragment });
    const started = performance.now();
    for (let i = 0; i < 100; i++) board = await store.publish({ boardId: board.id, expectedRevision: board.revision, canvasBase: base(board), eventId: `card-${i}`, patch: { id: `card-${i}`, selector: "body", operation: i % 2 ? "prepend" : "append", html: `<article id="card-${i}"><h2>Card ${i}</h2><p>${"Bounded authored content. ".repeat(20)}</p></article>` } });
    const elapsedMs = performance.now() - started, before = structuredClone(board.canvas);
    const replayStarted = performance.now();
    const source = describeAuthoring(board.canvas);
    const replayMs = performance.now() - replayStarted;
    expect(source.replay.complete).toBe(true);
    expect(source.replay.appliedPatchIds).toEqual(Array.from({ length: 100 }, (_, i) => `card-${i}`));
    expect(source.materializedAuthoredHtml).toContain('id="card-99"');
    expect(board.canvas).toEqual(before);
    console.log("MEASURE root-patch-history", JSON.stringify({ patches: 100, totalPublishMs: Math.round(elapsedMs), finalReplayMs: Math.round(replayMs), authoredBytes: Buffer.byteLength(source.materializedAuthoredHtml!) }));
  });

  it("names the failing patch and selector and gives a guarded recovery route for exports and copies", async () => {
    const store = new BoardStore(join(directory, "store"));
    let board = await store.create({ id: "unresolved", title: "Unresolved", html: fragment });
    board = await store.publish({ boardId: board.id, expectedRevision: board.revision, canvasBase: base(board), eventId: "missing", patch: { id: "runtime-card-40", selector: "#runtime-card", operation: "append", html: "Missing" } });
    const error = /patch "runtime-card-40".*selector "#runtime-card".*canvas\.html.*canvas\.patches.*replaceDocument:true/s;
    expect(() => buildRelease({ board, boardId: board.id, expectedCanvasBase: base(board), publicData: {} })).toThrow(error);
    await expect(new BoardCopies(join(directory, "copies"), store).copy({ boardId: board.id, canvasBase: base(board), eventId: "failed-copy", title: "Copy" })).rejects.toThrow(error);
    expect((await store.list()).map(b => b.id)).toEqual([board.id]);
  });
});
