import { describe, expect, it } from "vitest";
import { BoardSchema, ReadInputSchema } from "../shared/contracts";
import { inspectBoard } from "./inspection";

const fixture = () => BoardSchema.parse({
  schemaVersion: 1, id: "inspect", title: "Free canvas", ownerAgentId: "owner", revision: 4,
  createdAt: "2026-01-01", updatedAt: "2026-01-02",
  canvas: { revision: 3, documentVersion: 1, html: '<main><p id="metric">old</p></main>', data: { live: { a: { score: 0.8 } }, "a/b": { "~": null }, huge: "x".repeat(50000) }, patches: [{ id: "patch", selector: "#metric", operation: "replace", html: '<p id="metric">new</p>' }] },
  decisions: [], interactions: [
    { id: "first", kind: "question", text: "Explain", status: "answered", response: "Done", responseRevision: 2, createdAt: "2026-01-01", updatedAt: "2026-01-01", anchor: { kind: "point", boardRevision: 1, canvasRevision: 1, image: { mimeType: "image/png", data: "private-pixels".repeat(10000) } } },
    { id: "latest", kind: "question", text: "Current", status: "processing", response: "Working", responseRevision: 1, createdAt: "2026-01-02", updatedAt: "2026-01-02" },
  ], events: [], observations: [], userState: {}, extraction: {},
});
const inspect = (input: Record<string, unknown> = {}) => inspectBoard(fixture(), ReadInputSchema.parse({ boardId: "inspect", view: "inspect", ...input }));

describe("compact persisted Board inspection", () => {
  it("omits old pixels and full canvas, returns exact selected values and response revisions", () => {
    const result = inspect({ dataPaths: ["/live/a", "/a~1b/~0", "/missing"], interactionIds: ["first", "absent"] });
    expect(result.data).toEqual([
      { path: "/live/a", exists: true, value: { score: 0.8 }, bytes: 13 },
      { path: "/a~1b/~0", exists: true, value: null, bytes: 4 },
      { path: "/missing", exists: false },
    ]);
    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0]).toMatchObject({ id: "first", responseRevision: 2, anchor: { hasImage: true } });
    expect(result.missingInteractionIds).toEqual(["absent"]);
    expect(result.pendingCount).toBe(1);
    expect(result.observation.liveBrowser).toBe("not-observed");
    expect(JSON.stringify(result)).not.toContain("private-pixels");
    expect(JSON.stringify(result).length).toBeLessThan(4000);
    expect(result).not.toHaveProperty("canvas");
    expect(result.source).toBeUndefined();
  });
  it("replays requested authored target but does not confuse source with running rendering", () => {
    expect(inspect({ selector: "#metric" }).source).toMatchObject({
      canvasBase: { revision: 3, documentVersion: 1 }, replay: { complete: true, appliedPatchCount: 1 },
      target: { text: '<p id="metric">new</p>', truncated: false },
    });
    expect(inspect({ selector: "#created-by-js" }).source).toMatchObject({ replay: { complete: false }, target: null });
  });
  it("bounds selected values, strings and result count and clearly reports omissions", () => {
    const result = inspect({ dataPaths: ["/huge"], recentLimit: 1 });
    expect(result.data[0]).toMatchObject({ exists: true, omitted: true, bytes: 50002 });
    expect(result.data[0]).not.toHaveProperty("value");
    expect(result.interactions.map(item => item.id)).toEqual(["latest"]);
    expect(result.interactionCount).toBe(2);
    const board = fixture(); board.interactions[0].response = "large".repeat(10000);
    const bounded = inspectBoard(board, ReadInputSchema.parse({ boardId: "inspect", view: "inspect", interactionIds: ["first"] }));
    expect(bounded.interactions[0].response).toMatchObject({ truncated: true, totalCharacters: 50000 });
    expect(bounded.interactions[0].response?.text).toHaveLength(2400);
    board.canvas.data["long-key".repeat(100000)] = 1;
    const hugeKey = inspectBoard(board, ReadInputSchema.parse({ boardId: board.id, view: "inspect" }));
    expect(hugeKey.dataKeysOmitted).toBe(1);
    expect(hugeKey.dataKeys.every(key => key.length <= 500)).toBe(true);
    expect(JSON.stringify(hugeKey).length).toBeLessThan(12000);
  });
  it("supports array reads without walking array properties or inherited names", () => {
    const board = fixture(); board.canvas.data.list = [{ phase: "ready" }];
    const result = inspectBoard(board, ReadInputSchema.parse({ boardId: board.id, view: "inspect", dataPaths: ["/list/0/phase", "/list/length", "/list/01", "/toString"] }));
    expect(result.data.map(item => item.exists)).toEqual([true, false, false, false]);
    for (const path of ["not-a-pointer", "/bad~2", "/__proto__/polluted", "/constructor", "/prototype"]) expect(ReadInputSchema.safeParse({ boardId: board.id, view: "inspect", dataPaths: [path] }).success).toBe(false);
    expect(ReadInputSchema.safeParse({ boardId: board.id, view: "inspect", recentLimit: 21 }).success).toBe(false);
  });
});
