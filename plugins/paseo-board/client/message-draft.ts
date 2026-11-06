import { AnchorSchema, type Interaction } from "../shared/contracts";
import type { DraftCompose } from "./draft-store";

/** A captured reference is compared as data, not by object key insertion order. */
export function acceptedDraftInteraction(draft: DraftCompose, interactions: Interaction[]): Interaction | undefined {
  if (!draft.intentId) return undefined;
  const item = interactions.find(candidate => candidate.id === draft.intentId);
  if (!item || item.expectedCreatedAt !== draft.expectedCreatedAt || item.comments || item.text !== draft.text.trim() || item.destination !== draft.destination || item.sourceInteractionId !== draft.sourceInteractionId) return undefined;
  const kinds = draft.destination === "main" ? [draft.kind === "change" ? "change" : "question"]
    : draft.destination === "new-side" ? ["fork"] : draft.destination === "side" ? ["fork", "reply"] : [draft.kind];
  if (!kinds.includes(item.kind)) return undefined;
  if (!item.anchor || !draft.anchor) return item.anchor === draft.anchor ? item : undefined;
  const received = AnchorSchema.safeParse(item.anchor), frozen = AnchorSchema.safeParse(draft.anchor);
  return received.success && frozen.success && JSON.stringify(received.data) === JSON.stringify(frozen.data) ? item : undefined;
}
