import { describe, expect, it } from "vitest";
import type { Interaction } from "../shared/contracts";
import type { DraftCompose } from "./draft-store";
import { acceptedDraftInteraction } from "./message-draft";

const draft: DraftCompose = { kind: "question", text: " Original question ", intentId: "intent-1", destination: "main", sourceInteractionId: "parent",
  anchor: { kind: "element", boardRevision: 5, canvasRevision: 3, selector: "#original", rect: { x: 10, y: 20, width: 30, height: 40 }, image: { mimeType: "image/png", data: "original-pixels" } } };
function receipt(overrides: Partial<Interaction> = {}): Interaction {
  return { id: "intent-1", kind: "question", text: "Original question", destination: "main", sourceInteractionId: "parent", anchor: draft.anchor,
    status: "delivered", resultReferences: [], createdAt: "now", updatedAt: "now", ...overrides };
}
describe("durable message acknowledgement", () => {
  it("keeps a frozen draft when an equal intent is reported for a different source entity", () => {
    const frozen = { ...draft, expectedCreatedAt: "entity-one" };
    expect(acceptedDraftInteraction(frozen, [receipt()])).toBeUndefined();
    expect(acceptedDraftInteraction(frozen, [receipt({ expectedCreatedAt: "entity-two" })])).toBeUndefined();
    const original = receipt({ expectedCreatedAt: "entity-one" });
    expect(acceptedDraftInteraction(frozen, [original])).toBe(original);
  });
  it("matches a frozen reference despite transport key ordering", () => {
    const item = receipt({ anchor: { canvasRevision: 3, boardRevision: 5, selector: "#original", kind: "element", image: { data: "original-pixels", mimeType: "image/png" }, rect: { height: 40, width: 30, y: 20, x: 10 } } });
    expect(acceptedDraftInteraction(draft, [item])).toBe(item);
  });
  it("keeps an unknown or different payload instead of discarding the draft", () => {
    expect(acceptedDraftInteraction(draft, [receipt({ comments: [{ id: "comment", text: "Different grouped payload" }] })])).toBeUndefined();
    expect(acceptedDraftInteraction({ ...draft, intentId: undefined }, [receipt()])).toBeUndefined();
    for (const item of [receipt({ text: "Changed" }), receipt({ destination: "side" }), receipt({ sourceInteractionId: undefined }), receipt({ kind: "change" }), receipt({ anchor: { ...draft.anchor!, image: { mimeType: "image/png", data: "different-pixels" } } }), receipt({ anchor: undefined })]) {
      expect(acceptedDraftInteraction(draft, [item])).toBeUndefined();
    }
  });
  it("recognizes server-normalized Side kinds without accepting a different route", () => {
    const fork = receipt({ destination: "new-side", kind: "fork" });
    expect(acceptedDraftInteraction({ ...draft, destination: "new-side" }, [fork])).toBe(fork);
    expect(acceptedDraftInteraction({ ...draft, destination: "side" }, [fork])).toBeUndefined();
    const reply = receipt({ destination: "side", kind: "reply" });
    expect(acceptedDraftInteraction({ ...draft, destination: "side" }, [reply])).toBe(reply);
  });
  it("requires the frozen new-Side choice on a created Side but not on a reply to an existing one", () => {
    const history = { ...draft, destination: "side" as const, sideContext: "owner-history" as const };
    const fork = receipt({ destination: "side", kind: "fork", sideContext: "owner-history" });
    expect(acceptedDraftInteraction(history, [fork])).toBe(fork);
    expect(acceptedDraftInteraction(history, [receipt({ destination: "side", kind: "fork" })])).toBeUndefined();
    expect(acceptedDraftInteraction({ ...history, sideContext: undefined }, [fork])).toBeUndefined();
    const reply = receipt({ destination: "side", kind: "reply" });
    expect(acceptedDraftInteraction(history, [reply])).toBe(reply);
  });
});
