import { describe, expect, it } from "vitest";
import { compositionSourceSignal, hasCompositionSource, mergeCompositionSources, newerSourceReceipt } from "./composition-source-cache";
import type { CompositionSourcesState } from "../shared/composition";
import type { BoardSummary } from "../shared/contracts";
const ref = { hostId: "remote", boardId: "source" };
const time = "2026-11-05T00:00:00.000Z";
const state = (revision: number, selected = true): CompositionSourcesState => ({ boardId: "parent", boardCreatedAt: time, revision, sources: selected ? [{ ref, grantedAt: time }] : [] });
const receipt = (revision: number) => ({ sourceCreatedAt: time, revision, canvasRevision: revision, documentVersion: 1, observedAt: time, receivedAt: time });
describe("composition source cache authority", () => {
  it("keeps revocation when a pre-save read completes later and never syncs its removed source", () => {
    const revoked = state(2, false), delayed = state(1);
    expect(mergeCompositionSources(revoked, delayed)).toEqual(revoked);
    expect(hasCompositionSource(revoked, 1, ref)).toBe(false);
    expect(hasCompositionSource(revoked, 2, ref)).toBe(false);
    expect(hasCompositionSource(state(3), 2, ref)).toBe(false);
  });
  it("keeps the newest observation when the grant query or another sync returns stale receipts", () => {
    const existing = state(1); existing.sources[0].snapshot = receipt(8);
    const delayed = state(1); delayed.sources[0].snapshot = receipt(7);
    expect(mergeCompositionSources(existing, delayed).sources[0].snapshot).toEqual(receipt(8));
    expect(newerSourceReceipt(receipt(8), receipt(7))).toEqual(receipt(8));
    expect(newerSourceReceipt(receipt(8), { ...receipt(8), observedAt: "2020-01-01T00:00:00.000Z" })).toEqual(receipt(8));
  });
  it("does not inherit snapshots across revoke/regrant or a recreated parent", () => {
    const old = state(1); old.sources[0].snapshot = receipt(8);
    expect(mergeCompositionSources(old, state(3)).sources[0].snapshot).toBeUndefined();
    const recreated = { ...state(0, false), boardCreatedAt: "2026-11-06T00:00:00.000Z" };
    expect(mergeCompositionSources(old, recreated)).toEqual(recreated);
    expect(mergeCompositionSources(recreated, old)).toEqual(recreated);
  });
  it("keeps a bound source identity through delayed unbound or conflicting responses", () => {
    const bound = state(1); bound.sources[0] = { ...bound.sources[0], sourceCreatedAt: time, snapshot: receipt(8) };
    expect(mergeCompositionSources(bound, state(1)).sources[0]).toEqual(bound.sources[0]);
    const conflicting = state(1); conflicting.sources[0] = { ...conflicting.sources[0], sourceCreatedAt: "2030-01-01T00:00:00.000Z", snapshot: { ...receipt(9), sourceCreatedAt: "2030-01-01T00:00:00.000Z" } };
    expect(mergeCompositionSources(bound, conflicting).sources[0]).toEqual(bound.sources[0]);
    expect(newerSourceReceipt(receipt(8), conflicting.sources[0].snapshot)).toEqual(receipt(8));
    expect(mergeCompositionSources(state(1), bound).sources[0]).toEqual(bound.sources[0]);
  });
  it("invalidates source observations for attention changes even when content revision stays equal", () => {
    const summary = { id: "source", revision: 5, updatedAt: time, unreadUpdateCount: 2, pendingCount: 1, status: "processing" } as BoardSummary;
    expect(compositionSourceSignal(summary)).not.toBe(compositionSourceSignal({ ...summary, unreadUpdateCount: 0 }));
    expect(compositionSourceSignal(summary)).not.toBe(compositionSourceSignal({ ...summary, pendingCount: 0, status: "idle" }));
    expect(compositionSourceSignal(summary)).toBe(compositionSourceSignal({ ...summary }));
  });
});
