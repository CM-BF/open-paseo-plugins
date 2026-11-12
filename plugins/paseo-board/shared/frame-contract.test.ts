import { describe, expect, it } from "vitest";
import { CAPTURE_FAILURE_REASONS, FRAME_CHANNEL, interactionMarkerId, interactionMarkers, markerInteractionId, readFrameMessage, sameSelectionAnchor, validAnchor, isCanvasViewState } from "./frame-contract";
import { AnchorSchema, IdSchema, type Interaction } from "./contracts";
const scope = { boardId: "board", sessionId: "session" };
const message = (fields: object) => ({ channel: FRAME_CHANNEL, ...scope, ...fields });
describe("frame bridge validation", () => {
  it("distinguishes internal work from user interaction while accepting legacy activity reports", () => {
    for (const fields of [{ busy: false }, { busy: true }, { busy: false, interacting: false }, { busy: true, interacting: false }, { busy: true, interacting: true }]) {
      const report = message({ type: "canvas-activity", ...fields });
      expect(readFrameMessage(report, scope)).toEqual(report);
    }
    for (const fields of [{ busy: false, interacting: true }, { busy: true, interacting: "true" }, { busy: true, interacting: null }, { busy: 1, interacting: false }, { interacting: false }]) {
      expect(readFrameMessage(message({ type: "canvas-activity", ...fields }), scope)).toBeNull();
    }
    expect(readFrameMessage(message({ type: "canvas-activity", busy: true, interacting: false, sessionId: "old" }), scope)).toBeNull();
  });
  it("scopes liquid-glass key acknowledgements and focus returns to the exact session", () => {
    for (const fields of [{ type: "preset-key-ack", opened: true }, { type: "preset-key-ack", opened: false }, { type: "preset-focus-return" }]) {
      expect(readFrameMessage(message(fields), scope)).toEqual(message(fields));
      expect(readFrameMessage(message({ ...fields, sessionId: "old" }), scope)).toBeNull();
      expect(readFrameMessage(message({ ...fields, boardId: "other" }), scope)).toBeNull();
    }
    for (const opened of [undefined, "true", 1, null]) expect(readFrameMessage(message({ type: "preset-key-ack", opened }), scope)).toBeNull();
    // The host never accepts its own forward type back from a frame.
    expect(readFrameMessage(message({ type: "preset-key", key: "/" }), scope)).toBeNull();
  });
  it("accepts only bounded reading positions and scopes both state and restore acknowledgements", () => {
    const view = { documentVersion: 2, canvasRevision: 8, x: -15, y: 800,
      anchor: { selector: "#section", offsetX: 10, offsetY: -50 }, scrolls: [{ selector: "#log", x: 20, y: 300 }] };
    expect(isCanvasViewState(view)).toBe(true);
    expect(readFrameMessage(message({ type: "view-state", view }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "view-state", view, capturedAt: 1793940000123.5 }), scope)).not.toBeNull();
    for (const capturedAt of [-1, Infinity, NaN, "1793940000123"]) expect(readFrameMessage(message({ type: "view-state", view, capturedAt }), scope)).toBeNull();
    expect(isCanvasViewState({ ...view, capturedAt: 1793940000123.5 })).toBe(false);
    for (const change of [{ documentVersion: -1 }, { canvasRevision: 1.5 }, { y: Infinity }, { x: 10000001 },
      { scrolls: Array.from({ length: 33 }, (_, i) => ({ selector: `#log-${i}`, x: 0, y: 0 })) },
      { scrolls: [...view.scrolls, ...view.scrolls] }, { scrolls: [{ selector: "", x: 0, y: 0 }] },
      { scrolls: [{ selector: "#log", x: 0, y: NaN }] }, { anchor: { ...view.anchor, offsetY: NaN } },
      { html: "<script>not a reading position</script>" }, { anchor: { ...view.anchor, html: "no" } }]) {
      expect(readFrameMessage(message({ type: "view-state", view: { ...view, ...change } }), scope)).toBeNull();
    }
    const ack = message({ type: "view-restored", requestId: "restore-1", documentVersion: 2, status: "restored" });
    for (const status of ["restored", "cancelled", "unavailable"]) expect(readFrameMessage({ ...ack, status }, scope)).not.toBeNull();
    for (const change of [{ status: "saved" }, { requestId: "" }, { documentVersion: -1 }, { sessionId: "old" }, { boardId: "other" }]) expect(readFrameMessage({ ...ack, ...change }, scope)).toBeNull();
    expect(readFrameMessage(message({ type: "ready", capabilities: { frameDelta: 1, viewState: 1 } }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "ready", capabilities: { frameDelta: 1, viewState: 2 } }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "ready", capabilities: { frameDelta: 1, viewState: 1, viewPort: 1 } }), scope)).not.toBeNull();
    expect(readFrameMessage(message({ type: "ready", capabilities: { frameDelta: 1, viewState: 1, viewPort: 2 } }), scope)).toBeNull();
  });
  it("accepts bounded semantic edit proposals and rejects arbitrary code, IDs and cross-scope payloads", () => {
    const request = { canvasBase: { revision: 3, documentVersion: 2 }, patch: { operation: "text", selector: "#title", sourceIdentity: { tag: "h1", id: "title", fingerprint: "abcd1234" }, text: "", expectedText: "Old" } };
    const edit = message({ type: "component-edit", id: "proposal-1", request });
    expect(readFrameMessage(edit, scope)).not.toBeNull();
    for (const bad of [{ html: "<script>bad()</script>" }, { id: "forged" }, { copyIdPrefix: "forged" }, { expectedText: undefined }, { text: "x".repeat(24001) }, { textNodeIndex: -1 }, { sourceIdentity: { tag: "h1", fingerprint: "old-binding" } }]) {
      expect(readFrameMessage({ ...edit, request: { ...request, patch: { ...request.patch, ...bad } } }, scope)).toBeNull();
    }
    expect(readFrameMessage({ ...edit, request: { ...request, patch: { ...request.patch, sourceIdentity: { tag: "h1", fingerprint: "abcd1234" } } } }, scope)).toBeNull();
    const anonymous = { tag: "h1", fingerprint: "abcd1234", authoredHtml: "<h1>Old</h1>" };
    expect(readFrameMessage({ ...edit, request: { ...request, patch: { ...request.patch, sourceIdentity: anonymous } } }, scope)).not.toBeNull();
    expect(readFrameMessage({ ...edit, request: { ...request, patch: { ...request.patch, sourceIdentity: { ...anonymous, authoredHtml: "x".repeat(240001) } } } }, scope)).toBeNull();
    const move = { ...request, patch: { operation: "move", selector: "#title", sourceIdentity: request.patch.sourceIdentity, destination: "#other", destinationIdentity: { tag: "section", id: "other", fingerprint: "abcd5678" }, position: "append" } };
    expect(readFrameMessage({ ...edit, request: move }, scope)).not.toBeNull();
    const layout = { ...request, patch: { operation: "layout", selector: "#title", sourceIdentity: request.patch.sourceIdentity, layout: { collapse: "group", maxHeight: 320, title: "Logs" } } };
    expect(readFrameMessage({ ...edit, request: layout }, scope)).not.toBeNull();
    for (const bad of [{ html: "<b>no</b>" }, { destination: "#other" }, { copyIdPrefix: "caller-key" }, { layout: { collapse: "group", maxHeight: 4000 } }, { layout: { collapse: "group", maxHeight: null, originalStyle: "forged" } }]) expect(readFrameMessage({ ...edit, request: { ...layout, patch: { ...layout.patch, ...bad } } }, scope)).toBeNull();
    for (const bad of [{ destination: "" }, { destinationIdentity: undefined }, { position: "replace" }, { text: "no" }]) expect(readFrameMessage({ ...edit, request: { ...move, patch: { ...move.patch, ...bad } } }, scope)).toBeNull();
    for (const other of [{ boardId: "other" }, { sessionId: "expired" }]) expect(readFrameMessage({ ...edit, ...other }, scope)).toBeNull();
    expect(readFrameMessage({ ...edit, request: { ...request, eventId: "forged" } }, scope)).toBeNull();
  });
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
    const reordered = Object.fromEntries(Object.entries(anchor).reverse()) as typeof anchor;
    expect(sameSelectionAnchor(anchor, reordered)).toBe(true);
    expect(sameSelectionAnchor(anchor, { ...reordered, rect: { height: anchor.rect.height, width: anchor.rect.width, y: anchor.rect.y, x: anchor.rect.x }, image })).toBe(true);
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
    for (const location of ["collapsed", "component", "hidden"]) {
      expect(readFrameMessage(message({ type: "interaction-position", id: "q1", position: { x: 12, y: 34 }, location }), scope)).not.toBeNull();
    }
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
  it("keeps each batch location under one stable discussion number and follows the latest thread status", () => {
    const anchor = { kind: "point" as const, boardRevision: 2, canvasRevision: 1, rect: { x: 40, y: 80, width: 0, height: 0 }, image: { mimeType: "image/png" as const, data: "iVBORw0KGgoAAAA" } };
    const base = { kind: "change" as const, text: "One group", status: "answered" as const, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", resultReferences: [] };
    const comments = [{ id: "first", text: "Move the heading", anchor }, { id: "second", text: "Shorten the footer", anchor: { ...anchor, rect: { ...anchor.rect, y: 240 } } }, { id: "general", text: "Keep it consistent" }];
    const items: Interaction[] = [
      { ...base, id: "batch", comments, response: "A response that must stay outside the iframe" },
      { ...base, id: "followup", kind: "reply", sourceInteractionId: "batch", createdAt: "2026-01-01T00:01:00Z", anchor: { ...anchor, rect: { ...anchor.rect, y: 600 } } },
      { ...base, id: "next", kind: "reply", sourceInteractionId: "followup", createdAt: "2026-01-01T00:02:00Z", status: "processing" },
      { ...base, id: "unrelated", anchor },
    ];
    const markers = interactionMarkers(items);
    expect(markers).toHaveLength(4);
    expect(markers.slice(0, 3).map(marker => [marker.id, marker.interactionId, marker.commentId, marker.number, marker.label, marker.status])).toEqual(comments.map((comment, index) => [interactionMarkerId("batch", comment.id), "batch", comment.id, 1, `1.${index + 1}`, "processing"]));
    expect(markers.slice(0, 3).map(marker => marker.anchor?.rect?.y)).toEqual([80, 240, undefined]);
    expect(markers[3]).toMatchObject({ id: "unrelated", number: 2 });
    expect(JSON.stringify(markers)).not.toContain("image");
    expect(JSON.stringify(markers)).not.toContain("response");
    expect(comments[0].anchor?.image.data).toBe("iVBORw0KGgoAAAA");
    expect(interactionMarkers(JSON.parse(JSON.stringify(items)))).toEqual(markers);
  });
  it("resolves only exact known comment markers and never infers a parent from a forged marker", () => {
    const base = { kind: "change" as const, text: "Batch", status: "answered" as const, createdAt: "2026-01-01", updatedAt: "2026-01-01", resultReferences: [] };
    const items: Interaction[] = [
      { ...base, id: "batch", comments: [{ id: "first:comment:second", text: "One" }] },
      { ...base, id: "batch:comment:first", comments: [{ id: "second", text: "Two" }] },
      { ...base, id: "1:a:comment:b" },
      { ...base, id: "a", comments: [{ id: "b", text: "Three" }] },
    ];
    const first = interactionMarkerId("batch", "first:comment:second");
    const second = interactionMarkerId("batch:comment:first", "second");
    expect(first).not.toBe(second);
    expect(markerInteractionId(first, items)).toBe("batch");
    expect(markerInteractionId(second, items)).toBe("batch:comment:first");
    expect(markerInteractionId("batch", items)).toBe("batch");
    expect(markerInteractionId(interactionMarkerId("a", "b"), items)).toBe("a");
    expect(markerInteractionId("1:a:comment:b", items)).toBe("1:a:comment:b");
    expect(IdSchema.safeParse(interactionMarkerId("a", "b")).success).toBe(false);
    const currentMarkers = interactionMarkers(items);
    for (const forged of [interactionMarkerId("batch", "missing"), interactionMarkerId("missing", "second"), "batch:comment:first:comment:second", first + ":extra"]) {
      expect(markerInteractionId(forged, items)).toBe(forged);
      expect(currentMarkers.some(marker => marker.id === forged)).toBe(false);
    }
    expect(markerInteractionId(first, [])).toBe(first);
    expect(markerInteractionId(first, [{ ...base, id: "batch" }])).toBe(first);
  });
  it("allows bounded composite marker IDs without widening business IDs or scope checks", () => {
    const id = interactionMarkerId("p".repeat(160), "c".repeat(160));
    expect(id.length).toBeGreaterThan(160);
    expect(IdSchema.safeParse(id).success).toBe(false);
    for (const type of ["open-interaction", "interaction-position"]) {
      const event = message({ type, id, position: { x: 12, y: 34 } });
      expect(readFrameMessage(event, scope)).toEqual(event);
      for (const change of [{ id: "x".repeat(513) }, { boardId: "other" }, { sessionId: "expired" }, { channel: "other" }]) expect(readFrameMessage({ ...event, ...change }, scope)).toBeNull();
    }
    expect(readFrameMessage(message({ type: "ask", id, request: { prompt: "No business ID widening" } }), scope)).toBeNull();
    expect(readFrameMessage(message({ type: "selection-lock", id, active: true }), scope)).toBeNull();
  });
});
