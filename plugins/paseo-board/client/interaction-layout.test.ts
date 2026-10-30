import { describe, expect, it } from "vitest";
import type { Interaction } from "../shared/contracts";
import { anchorPoint, interactionThread, mergeInteractions, popoverPlacement } from "./interaction-layout";

const item = (id: string, sourceInteractionId?: string): Interaction => ({ id, sourceInteractionId, kind: sourceInteractionId ? "reply" : "fork", text: id, status: "delivered", resultReferences: [], createdAt: "2026-10-29", updatedAt: "2026-10-29" });

describe("in-place conversation layout", () => {
  it("uses document coordinates minus the captured scroll for a toolbar fallback", () => {
    expect(anchorPoint({ kind: "point", boardRevision: 5, canvasRevision: 2, rect: { x: 230, y: 750, width: 0, height: 0 }, viewport: { width: 900, height: 600, scrollX: 20, scrollY: 500 } })).toEqual({ x: 210, y: 250 });
  });
  it("flips near viewport edges and contains the composer on narrow canvases", () => {
    for (const viewport of [{ width: 900, height: 600 }, { width: 300, height: 180 }]) {
      for (const point of [{ x: 0, y: 0 }, { x: 890, y: 590 }, { x: -40, y: 3000 }]) {
        const box = popoverPlacement(point, viewport, 450);
        expect(box.left).toBeGreaterThanOrEqual(8);
        expect(box.top).toBeGreaterThanOrEqual(8);
        expect(box.left + box.width).toBeLessThanOrEqual(viewport.width - 8);
        expect(box.top + Math.min(450, box.maxHeight)).toBeLessThanOrEqual(viewport.height - 8);
      }
    }
  });
  it("keeps later replies and returns attached to the original question", () => {
    const all = [item("first"), item("unrelated"), item("later", "first"), { ...item("return", "later"), kind: "return" as const }];
    expect(interactionThread("later", all).map(item => item.id)).toEqual(["first", "later", "return"]);
    expect(interactionThread("unrelated", all).map(item => item.id)).toEqual(["unrelated"]);
  });
  it("lets persisted status replace optimistic status without duplicating markers", () => {
    const saved = { ...item("first"), status: "answered" as const };
    expect(mergeInteractions([saved], [{ ...item("first"), status: "sending" }, item("pending")])).toEqual([saved, item("pending")]);
  });
});
