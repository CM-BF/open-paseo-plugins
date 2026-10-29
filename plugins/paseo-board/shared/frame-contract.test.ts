import { describe, expect, it } from "vitest";
import { FRAME_CHANNEL, readFrameMessage, validAnchor } from "./frame-contract";
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
});
