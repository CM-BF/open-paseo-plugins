import { boardRefKey, type BoardRef, type CompositionSourcesState } from "../shared/composition";
import type { BoardSummary } from "../shared/contracts";
type Receipt = NonNullable<CompositionSourcesState["sources"][number]["snapshot"]>;

export function newerSourceReceipt(previous: Receipt | undefined, incoming: Receipt | undefined): Receipt | undefined {
  if (!previous) return incoming;
  if (!incoming || incoming.sourceCreatedAt !== previous.sourceCreatedAt || incoming.revision < previous.revision || incoming.canvasRevision < previous.canvasRevision || incoming.documentVersion < previous.documentVersion) return previous;
  if (incoming.revision === previous.revision && incoming.observedAt < previous.observedAt) return previous;
  return incoming;
}
/** A delayed read cannot resurrect a revoked grant or replace a newer observation. */
export function mergeCompositionSources(previous: CompositionSourcesState | undefined, incoming: CompositionSourcesState): CompositionSourcesState {
  if (!previous || previous.boardId !== incoming.boardId) return incoming;
  if (previous.boardCreatedAt !== incoming.boardCreatedAt) return incoming.boardCreatedAt > previous.boardCreatedAt ? incoming : previous;
  if (incoming.revision < previous.revision) return previous;
  if (incoming.revision > previous.revision) return incoming;
  return { ...incoming, sources: incoming.sources.map(source => {
    const old = previous.sources.find(item => boardRefKey(item.ref) === boardRefKey(source.ref));
    if (old?.grantedAt !== source.grantedAt) return source;
    if (old.sourceCreatedAt && source.sourceCreatedAt && old.sourceCreatedAt !== source.sourceCreatedAt) return old;
    const sourceCreatedAt = old.sourceCreatedAt ?? source.sourceCreatedAt;
    const snapshot = newerSourceReceipt(old.snapshot, source.snapshot);
    return { ...source, ...(sourceCreatedAt ? { sourceCreatedAt } : {}), ...(snapshot ? { snapshot } : {}) };
  }) };
}
export function hasCompositionSource(state: CompositionSourcesState | undefined, revision: number, ref: BoardRef): boolean {
  return state?.revision === revision && state.sources.some(source => boardRefKey(source.ref) === boardRefKey(ref));
}
/** Attention receipts may change unread/status without a content revision. */
export const compositionSourceSignal = (summary: BoardSummary | undefined): string | undefined => summary ? JSON.stringify(summary) : undefined;
