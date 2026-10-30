import { describe, expect, it } from "vitest";
import { FRAME_CHANNEL, interactionMarkers, readFrameMessage, validAnchor } from "./frame-contract";
import type { Interaction } from "./contracts";
const scope = { boardId: "board", sessionId: "session" };
const message = (fields: object) => ({ channel: FRAME_CHANNEL, ...scope, ...fields });
describe("frame bridge validation", () => {
  it("separates a blank native composer from nonempty generated asks", () => {
    const anchor = { boardRevision: 1, canvasRevision: 1, kind: "point", rect: { x: 20, y: 30, width: 0, height: 0 } };
    expect(readFrameMessage(message({ type: "compose", selectionId: "selected", request: { kind: "question", anchor } }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "compose", selectionId: "selected", request: { kind: "execute", anchor } }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "compose", request: { kind: "question", anchor } }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "ask", id: "blank", request: { prompt: "" } }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "selection-lock", id: "selected", active: true }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "selection-lock", id: "selected", active: true, dragging: true }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "selection-lock", id: "selected", active: true, dragging: "true" }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "selection-lock", id: "selected", active: "true" }), scope)).toBeNull();
  });
  it("limits the frame to the selected board and document session", () => {
    expect(readFrameMessage(message({ type: "ready" }), scope)).not.toBeNull();
    for (const other of [{ boardId: "other" }, { sessionId: "old" }, { channel: "sdk" }, { type: "agents.create" }]) {
      expect(readFrameMessage({ ...message({ type: "ready" }), ...other }, scope)).toBeNull();
    }
  });
  it("rejects unknown actions, oversized state, external schemes and malformed anchors", () => {
    expect(readFrameMessage(message({ type: "state", state: { text: "x".repeat(524289) } }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "open-link", url: "javascript:alert(1)" }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "open-link", url: "https://example.com" }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "ask", id: "one", request: { prompt: "Question", kind: "execute" } }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "anchor", anchor: { boardRevision: 1, canvasRevision: 2, kind: "region", rect: { x: Infinity, y: 0, width: 10, height: 10 } } }), scope)).toBeNull();
  });
  it("accepts text and geometric anchors only with finite versioned context", () => {
    const anchor = { kind: "text", boardRevision: 10, canvasRevision: 8, text: "quoted content", rect: { x: 10, y: 20, width: 150, height: 30 }, viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0 } };
    expect(validAnchor(anchor)).toBe(true);
    expect(validAnchor({ ...anchor, image: { mimeType: "image/png", data: "bad content" } })).toBe(false);
    expect(validAnchor({ ...anchor, canvasRevision: 1.5 })).toBe(false);
  });
  it("validates frame-relative positions and marker message scope", () => {
    for (const type of ["open-interaction", "interaction-position"]) {
      expect(readFrameMessage(message({ type, id: "q1", position: { x: 12, y: 34 } }), scope)).not.toBeNull();
      expect(readFrameMessage(message({ type, id: "q1", position: { x: NaN, y: 34 } }), scope)).toBeNull();
      expect(readFrameMessage(message({ type, id: "q1", position: { x: 1, y: "34" } }), scope)).toBeNull();
      expect(readFrameMessage(message({ type, id: "q1", sessionId: "previous", position: { x: 12, y: 34 } }), scope)).toBeNull();
    }
    expect(readFrameMessage(message({ type: "ask", id: "ask", request: { prompt: "Hello", position: { x: Infinity, y: 1 } } }), scope)).toBeNull();
  });
  it("keeps one durable marker per thread with its original location and latest reply status", () => {
    const anchor = { kind: "point" as const, boardRevision: 2, canvasRevision: 1, rect: { x: 40, y: 80, width: 0, height: 0 }, image: { mimeType: "image/png" as const, data: "iVBORw0KGgoAAAA" } };
    const base = { text: "Question", status: "answered" as const, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", resultReferences: [] };
    const items: Interaction[] = [
      { ...base, id: "question", kind: "fork", anchor },
      { ...base, id: "reply", kind: "reply", sourceInteractionId: "question", createdAt: "2026-01-01T00:01:00Z" },
      { ...base, id: "return", kind: "return", sourceInteractionId: "reply", status: "processing", createdAt: "2026-01-01T00:02:00Z" },
      { ...base, id: "second", kind: "change", status: "sending", anchor },
    ];
    const markers = interactionMarkers(items);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ id: "question", status: "processing", anchor: { rect: anchor.rect }, number: 1 });
    expect(markers[0].anchor?.image).toBeUndefined();
    expect(markers[1]).toMatchObject({ id: "second", status: "sending", number: 2 });
    expect(interactionMarkers(JSON.parse(JSON.stringify(items)))).toEqual(markers);
  });
});
