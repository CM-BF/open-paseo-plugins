import { describe, expect, it } from "vitest";
import { COMMENT_IMAGE_LIMIT, COMMENT_LIMIT, COMMENT_TEXT_LIMIT, CommentsSchema, InteractInputSchema, InteractionSchema, SourceSnapshotSchema, type BoardComment } from "../shared/contracts";

const comment = (id = "one", imageLength = 0): BoardComment => ({
  id, text: "Please adjust this",
  ...(imageLength ? { anchor: { kind: "point", boardRevision: 0, canvasRevision: 0, image: { mimeType: "image/png", data: "A".repeat(imageLength) } } } : {}),
});
const request = { boardId: "board", intentId: "group", kind: "change", text: "Grouped changes", comments: [comment()] };

describe("grouped comment contracts", () => {
  it("accepts old single requests and bounded groups without rewriting the comments", () => {
    const { comments: _comments, ...single } = request;
    expect(InteractInputSchema.parse(single)).toEqual(single);
    const comments = Array.from({ length: COMMENT_LIMIT }, (_, index) => ({ ...comment(String(index)), text: "x".repeat(COMMENT_TEXT_LIMIT / COMMENT_LIMIT) }));
    expect(CommentsSchema.parse(comments)).toEqual(comments);
    expect(CommentsSchema.safeParse([comment("first", COMMENT_IMAGE_LIMIT / 2), comment("second", COMMENT_IMAGE_LIMIT / 2)]).success).toBe(true);
  });

  it("rejects empty, oversized, duplicate and blank comments", () => {
    const bad = [
      [], Array.from({ length: COMMENT_LIMIT + 1 }, (_, index) => comment(String(index))),
      [comment(), comment()], [{ ...comment(), text: " \n\t " }],
      [{ ...comment("first"), text: "a".repeat(COMMENT_TEXT_LIMIT) }, comment("second")],
      [comment("first", COMMENT_IMAGE_LIMIT / 2), comment("second", COMMENT_IMAGE_LIMIT / 2), comment("third", 4)],
      [{ ...comment(), anchor: { kind: "point", boardRevision: 0, canvasRevision: 0, image: { mimeType: "image/png", data: "汉字" } } }],
    ];
    for (const comments of bad) expect(CommentsSchema.safeParse(comments).success).toBe(false);
  });

  it("rejects ambiguous group anchors and source ancestry in both request and persistence schemas", () => {
    const anchor = { kind: "point", boardRevision: 0, canvasRevision: 0 };
    for (const extra of [{ anchor }, { sourceInteractionId: "previous" }]) {
      expect(InteractInputSchema.safeParse({ ...request, ...extra }).success).toBe(false);
      expect(InteractionSchema.safeParse({ ...request, ...extra, id: "group", status: "saved", createdAt: "now", updatedAt: "now" }).success).toBe(false);
    }
    expect(InteractionSchema.parse({ ...request, id: "group", status: "saved", createdAt: "now", updatedAt: "now" }).comments).toEqual(request.comments);
  });

  it("bounds frozen source groups with the same limits and never persists recursively nested snapshots", () => {
    const source = { id: "source", text: "Original question", responseRevision: 1, resultReferences: [] };
    expect(SourceSnapshotSchema.parse(source)).toEqual(source);
    const frozen = SourceSnapshotSchema.parse({ ...source, comments: [comment()], commentSourceId: "group", sourceSnapshot: { ...source, comments: [comment("nested")] } });
    expect(frozen.comments).toEqual([comment()]); expect(frozen).not.toHaveProperty("sourceSnapshot");
    expect(SourceSnapshotSchema.safeParse({ ...source, comments: Array.from({ length: COMMENT_LIMIT + 1 }, (_, index) => comment(String(index))) }).success).toBe(false);
    expect(SourceSnapshotSchema.safeParse({ ...source, comments: [comment("one", COMMENT_IMAGE_LIMIT / 2), comment("two", COMMENT_IMAGE_LIMIT / 2), comment("three", 4)] }).success).toBe(false);
  });
});
