import { describe, expect, it } from "vitest";
import { CAPTURE_FAILURE_REASONS, FRAME_CHANNEL, interactionMarkers, readFrameMessage, sameSelectionAnchor, validAnchor } from "./frame-contract";
import { AnchorSchema, type Interaction } from "./contracts";
const scope = { boardId: "board", sessionId: "session" };
const message = (fields: object) => ({ channel: FRAME_CHANNEL, ...scope, ...fields });
describe("frame bridge validation", () => {
  it("negotiates deltas without requiring them from older runtimes and scopes recovery requests", () => {
    expect(readFrameMessage(message({ type: "ready", capabilities: { frameDelta: 1 } }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "ready" }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "ready", capabilities: { frameDelta: 2 } }), scope)).toBeNull();
    const request = message({ type: "snapshot-request", documentVersion: 2, version: 5, reason: "baseline-mismatch" });
    expect(readFrameMessage(request, scope)).not.toBeNull();
    for (const bad of [{ boardId: "wrong" }, { sessionId: "old" }, { version: -1 }, { version: 1.5 }, { documentVersion: NaN }, { reason: "" }]) expect(readFrameMessage({ ...request, ...bad }, scope)).toBeNull();
  });
  it("separates a blank native composer from nonempty generated asks", () => {
    const anchor = { boardRevision: 1, canvasRevision: 1, kind: "point", rect: { x: 20, y: 30, width: 0, height: 0 } };
    expect(readFrameMessage(message({ type: "compose", selectionId: "selected", request: { kind: "question", anchor } }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "compose", automatic: true, selectionId: "selected", request: { kind: "question", anchor } }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "compose", automatic: "true", selectionId: "selected", request: { kind: "question", anchor } }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "compose", selectionId: "selected", request: { kind: "execute", anchor } }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "compose", request: { kind: "question", anchor } }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "ask", id: "blank", request: { prompt: "" } }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "selection-lock", id: "selected", active: true }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "selection-lock", id: "selected", active: true, dragging: true }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "selection-lock", id: "selected", active: true, dragging: "true" }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "selection-lock", id: "selected", active: "true" }), scope)).toBeNull();
  });
  it("accepts image completion only as a scoped, finite result and preserves legacy composition", () => {
    const anchor = { boardRevision: 1, canvasRevision: 1, kind: "point" as const, rect: { x: 20, y: 30, width: 0, height: 0 } };
    const image = { mimeType: "image/png" as const, data: "iVBORw0KGgoAAAA" };
    expect(readFrameMessage(message({ type: "compose", selectionId: "one", request: { kind: "question", anchor, captureStatus: "pending" } }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "compose", selectionId: "one", request: { kind: "question", anchor: { ...anchor, image }, captureStatus: "pending" } }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "selection-capture", selectionId: "one", anchor: { ...anchor, image }, status: "ready" }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "selection-capture", selectionId: "one", anchor, status: "failed" }), scope)).not.toBeNull();
    for (const bad of [{ selectionId: "" }, { status: "pending" }, { anchor }]) {
      expect(readFrameMessage(message({ type: "selection-capture", selectionId: "one", anchor: { ...anchor, image }, status: "ready", ...bad }), scope)).toBeNull();
    }
    for (const reason of CAPTURE_FAILURE_REASONS) {
      expect(readFrameMessage(message({ type: "selection-capture", selectionId: "one", anchor, status: "failed", reason }), scope)).not.toBeNull();
      expect(readFrameMessage(message({ type: "selection-capture", selectionId: "one", anchor: { ...anchor, image }, status: "ready", reason }), scope)).toBeNull();
    }
    for (const reason of ["", "other", "x".repeat(10000), {}, null, 1]) {
      expect(readFrameMessage(message({ type: "selection-capture", selectionId: "one", anchor, status: "failed", reason }), scope)).toBeNull();
    }
    expect(sameSelectionAnchor(anchor, { ...anchor, image })).toBe(true);
    expect(sameSelectionAnchor(anchor, { ...anchor, canvasRevision: 2, image })).toBe(false);
    expect(sameSelectionAnchor(anchor, { ...anchor, rect: { ...anchor.rect, x: 21 }, image })).toBe(false);
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
  it("round-trips optional component bindings and rejects malformed identity metadata", () => {
    const identity = { selector: "#panel > p", tag: "p", fingerprint: "1234abcd" };
    const binding = { documentVersion: 2, key: "binding-a", target: identity, ancestors: [{ ...identity, id: "panel", selector: "#panel", tag: "section" }], relative: { x: 0.2, y: 0.8 } };
    const anchor = { kind: "point", boardRevision: 8, canvasRevision: 4, rect: { x: 10, y: 20, width: 0, height: 0 }, binding };
    expect(validAnchor(anchor)).toBe(true);
    expect(AnchorSchema.parse(anchor).binding).toEqual(binding);
    expect(validAnchor({ ...anchor, binding: undefined })).toBe(true);
    for (const invalid of [
      { ...binding, documentVersion: -1 }, { ...binding, key: "x".repeat(161) },
      { ...binding, target: { ...identity, fingerprint: "bad" } }, { ...binding, ancestors: Array(9).fill(identity) },
      { ...binding, relative: { x: Infinity, y: 0 } }, { ...binding, relative: { x: 0, y: -0.01 } },
    ]) {
      expect(validAnchor({ ...anchor, binding: invalid })).toBe(false);
      expect(AnchorSchema.safeParse({ ...anchor, binding: invalid }).success).toBe(false);
    }
  });
  it("validates frame-relative positions and marker message scope", () => {
    for (const type of ["open-interaction", "interaction-position"]) {
      expect(readFrameMessage(message({ type, id: "q1", position: { x: 12, y: 34 } }), scope)).not.toBeNull();
      expect(readFrameMessage(message({ type, id: "q1", position: { x: NaN, y: 34 } }), scope)).toBeNull();
      expect(readFrameMessage(message({ type, id: "q1", position: { x: 1, y: "34" } }), scope)).toBeNull();
      expect(readFrameMessage(message({ type, id: "q1", sessionId: "previous", position: { x: 12, y: 34 } }), scope)).toBeNull();
    }
    expect(readFrameMessage(message({ type: "interaction-position", id: "q1", position: { x: 12, y: 34 }, location: "collapsed" }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "interaction-position", id: "q1", position: { x: 12, y: 34 }, location: "guessed" }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "ask", id: "ask", request: { prompt: "Hello", position: { x: Infinity, y: 1 } } }), scope)).toBeNull();
  });
  it("validates update navigation receipts and activity without granting arbitrary seen state", () => {
    const receipt = { type: "update-position", requestId: "request-1", id: "update-1", token: 1, targetIndex: 0, documentVersion: 2, status: "focused", position: { x: 8, y: 12 }, location: "target" };
    expect(readFrameMessage(message(receipt), scope)).not.toBeNull();
    expect(readFrameMessage(message({ ...receipt, status: "deferred", position: undefined, location: undefined }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ ...receipt, status: "unavailable", reason: "Removed" }), scope)).not.toBeNull();
    for (const bad of [{ requestId: "" }, { token: NaN }, { token: -1 }, { targetIndex: 101 }, { documentVersion: -1 }, { status: "seen" }, { position: undefined }, { location: "guessed" }, { reason: "x".repeat(501) }]) {
      expect(readFrameMessage(message({ ...receipt, ...bad }), scope)).toBeNull();
    }
    expect(readFrameMessage(message({ type: "canvas-activity", busy: true }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "canvas-activity", busy: "false" }), scope)).toBeNull();
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
