import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DOMParser } from "linkedom";
import { BoardStore } from "./store";
import { describeAuthoring } from "./authored-source";
import { componentIdentityFor } from "../shared/component-identity";
import { EditInputSchema, type Board, type EditInput } from "../shared/contracts";
import type { ComponentLayout } from "../shared/component-layout";
import { buildRelease } from "./static-release";
import { z } from "zod";
import { ComponentLayoutSchema } from "../shared/contracts";

const html = '<main id="board"><section id="log" style="color:red"><h3 id="title">Logs</h3><input id="field" value="original"><button id="run" onclick="run()">Run</button><pre id="lines">one\ntwo\nthree</pre></section></main>';
const source = (board: Board) => {
  const result = describeAuthoring(board.canvas); expect(result.replay.complete).toBe(true);
  return new DOMParser().parseFromString(`<html><head></head><body>${result.materializedAuthoredHtml}</body></html>`, "text/html");
};
const edit = (board: Board, layout: ComponentLayout, selector = "#log"): EditInput => ({
  boardId: board.id, canvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, eventId: `layout-${board.canvas.revision}`,
  patch: { id: `layout-${board.canvas.revision}`, operation: "layout", selector, sourceIdentity: componentIdentityFor(source(board).querySelector(selector)!), layout },
});

it("describes bounded layout options in the actual CLI/MCP JSON schema", () => {
  const schema = z.toJSONSchema(ComponentLayoutSchema, { io: "input" });
  expect(schema).toMatchObject({ type: "object", additionalProperties: false, properties: { collapse: { enum: ["none", "contents", "group"] }, title: { type: "string", maxLength: 120 } } });
  expect(schema.properties?.maxHeight).toMatchObject({ anyOf: [{ type: "integer", minimum: 80, maximum: 2000 }, { type: "null" }] });
  expect(() => z.toJSONSchema(EditInputSchema, { io: "input" })).not.toThrow();
});

describe("durable component layout edits", () => {
  let root: string, store: BoardStore;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "board-layout-")); store = new BoardStore(root); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const create = (value = html) => store.create({ id: "layout-fixture", title: "Layout", ownerAgentId: "owner", html: value, data: { count: 4 } });

  it("persists contents, scroll and restore as replayable semantic patches across restart", async () => {
    const initial = await create(); await store.saveState({ boardId: initial.id, state: { input: "typed", other: true } });
    let board = await store.edit(edit(initial, { collapse: "contents", maxHeight: 240 }));
    const reopened = await new BoardStore(root).read(initial.id);
    expect(reopened!.canvas).toEqual(board.canvas); expect(reopened!.userState).toEqual({ input: "typed", other: true });
    expect(source(reopened!).querySelector("summary #title")!.textContent).toBe("Logs");
    expect(source(board).querySelector("[data-paseo-layout-part=body]")!.getAttribute("style")).toContain("max-height:240px");
    board = await store.edit(edit(board, { collapse: "contents", maxHeight: null }));
    expect(source(board).querySelector("details")!.id).toBe("paseo-layout-layout-1");
    board = await store.edit(edit(board, { collapse: "none", maxHeight: null }));
    expect(describeAuthoring(board.canvas).materializedAuthoredHtml).toBe(html);
    expect(board.canvas.html).toBe(html); expect(board.canvas.data).toEqual({ count: 4 }); expect(board.canvas.documentVersion).toBe(1);
  });

  it("retains group placement and original authored handlers in cold materialization", async () => {
    const initial = await create();
    const board = await store.edit(edit(initial, { collapse: "group", maxHeight: 320, title: "日志分组", placement: { "grid-column": "2 / span 2", order: "2", width: "420px" } }));
    const document = source(board);
    expect(document.querySelector("details > summary")!.textContent).toBe("日志分组");
    expect(document.querySelector("details")!.getAttribute("style")).toContain("grid-column:2 / span 2");
    expect(document.querySelector("#run")!.getAttribute("onclick")).toBe("run()");
    expect(document.querySelector("#log")!.parentElement!.getAttribute("data-paseo-layout-part")).toBe("body");
    const release = buildRelease({ board, boardId: board.id, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, publicData: {} });
    expect(JSON.stringify(release.files)).toContain("data-paseo-layout-key");
    expect(JSON.stringify(release.files)).toContain("日志分组");
  });

  it("guards immutable retries, stale canvas and source identity without committing failed layouts", async () => {
    const initial = await create(), request = edit(initial, { collapse: "group", maxHeight: null });
    const board = await store.edit(request);
    expect(await new BoardStore(root).edit(request)).toEqual(board);
    await expect(store.edit({ ...request, eventId: "stale", patch: { ...request.patch, id: "stale" } })).rejects.toMatchObject({ code: "revision_conflict" });
    const next = edit(board, { collapse: "none", maxHeight: null }); next.patch.sourceIdentity!.fingerprint = "00000000";
    await expect(store.edit(next)).rejects.toMatchObject({ code: "edit_conflict" });
    expect((await store.read(initial.id))!.canvas.patches).toHaveLength(1);
    const forged = source(board), target = forged.querySelector("#log")!;
    const metadata = JSON.parse(target.getAttribute("data-paseo-layout")!); metadata.properties.width.value = "999px";
    target.setAttribute("data-paseo-layout", JSON.stringify(metadata));
    const changedMetadata = edit(board, { collapse: "none", maxHeight: null }); changedMetadata.patch.sourceIdentity = componentIdentityFor(target);
    await expect(store.edit(changedMetadata)).rejects.toMatchObject({ code: "edit_conflict" });
  });

  it("rejects special targets and forged configuration/HTML before a write", async () => {
    const initial = await create();
    await expect(store.edit(edit(initial, { collapse: "contents", maxHeight: 120 }, "#field"))).rejects.toMatchObject({ code: "edit_conflict" });
    const request = edit(initial, { collapse: "group", maxHeight: 240 });
    for (const patch of [
      { ...request.patch, html: "<b>untrusted</b>" }, { ...request.patch, destination: "#board" },
      { ...request.patch, layout: { collapse: "group", maxHeight: 0 } },
      { ...request.patch, layout: { collapse: "group", maxHeight: 240, metadata: { savedStyle: "malicious" } } },
    ]) expect(EditInputSchema.safeParse({ ...request, patch }).success).toBe(false);
    expect((await store.read(initial.id))!.canvas.patches).toEqual([]);
  });

  it("refuses copies with managed metadata and moves that would detach a group's source", async () => {
    const initial = await create();
    const board = await store.edit(edit(initial, { collapse: "group", maxHeight: 200 })), document = source(board);
    const sourceIdentity = componentIdentityFor(document.querySelector("#log")!), destinationIdentity = componentIdentityFor(document.querySelector("#board")!);
    for (const operation of ["move", "copy"] as const) {
      await expect(store.edit({ boardId: board.id, canvasBase: { revision: board.canvas.revision, documentVersion: 1 }, eventId: `unsafe-${operation}`,
        patch: { id: `unsafe-${operation}`, operation, selector: "#log", sourceIdentity, destination: "#board", destinationIdentity, position: "append", ...(operation === "copy" ? { copyIdPrefix: "copied" } : {}) } })).rejects.toMatchObject({ code: "edit_conflict" });
    }
    expect((await store.read(board.id))!.canvas.patches).toHaveLength(1);
  });

  it("rejects transfers that break managed slots before saving and allows ordinary contents transfers", async () => {
    const initial = await create(html.replace("</main>", '<section id="destination"><p id="extra">Extra</p></section></main>'));
    let board = await store.edit(edit(initial, { collapse: "contents", maxHeight: 200 })), serial = 0;
    const transfer = (selector: string, destination: string, position: "before" | "after" | "append" | "prepend" = "append"): EditInput => {
      const document = source(board), id = `slot-${++serial}`;
      return { boardId: board.id, canvasBase: { revision: board.canvas.revision, documentVersion: 1 }, eventId: id,
        patch: { id, operation: "move", selector, sourceIdentity: componentIdentityFor(document.querySelector(selector)!), destination, destinationIdentity: componentIdentityFor(document.querySelector(destination)!), position } };
    };
    for (const selector of ["#paseo-layout-layout-1", "#paseo-layout-layout-1 > summary", "#paseo-layout-layout-1 > div", "#title"]) await expect(store.edit(transfer(selector, "#destination"))).rejects.toMatchObject({ code: "edit_conflict" });
    for (const [destination, position] of [["#log", "append"], ["#paseo-layout-layout-1", "prepend"], ["#title", "before"], ["#paseo-layout-layout-1 > div", "after"]] as const) await expect(store.edit(transfer("#extra", destination, position))).rejects.toMatchObject({ code: "edit_conflict" });
    expect((await store.read(board.id))!.canvas).toEqual(board.canvas);
    board = await store.edit(transfer("#extra", "#paseo-layout-layout-1 > div"));
    board = await store.edit(transfer("#lines", "#destination"));
    board = await store.edit(edit(board, { collapse: "none", maxHeight: null }));
    const restored = source((await new BoardStore(root).read(board.id))!);
    expect(restored.querySelector("#log > #extra")!.textContent).toBe("Extra");
    expect(restored.querySelector("#destination > #lines")).not.toBeNull();
    expect(restored.querySelector("#log > #title")).not.toBeNull();
  });

  it("moves a complete group, cold replays it and restores the source at its new location", async () => {
    const initial = await create(html.replace("</main>", '<section id="destination"></section></main>'));
    let board = await store.edit(edit(initial, { collapse: "group", maxHeight: 200 }));
    const document = source(board), selector = "#paseo-layout-layout-1";
    board = await store.edit({ boardId: board.id, canvasBase: { revision: board.canvas.revision, documentVersion: 1 }, eventId: "whole-group", patch: { id: "whole-group", operation: "move", selector,
      sourceIdentity: componentIdentityFor(document.querySelector(selector)!), destination: "#destination", destinationIdentity: componentIdentityFor(document.querySelector("#destination")!), position: "append" } });
    expect(source((await new BoardStore(root).read(board.id))!).querySelector("#destination > details")).not.toBeNull();
    board = await store.edit(edit(board, { collapse: "none", maxHeight: null }));
    expect(source(board).querySelector("#destination > #log > #title")!.textContent).toBe("Logs");
    expect(source(board).querySelector("details")).toBeNull();
  });
});
