import type { Board } from "../shared/contracts";

/** Seen receipts are monotonic within the bounded update window, independently of content revision. */
export function mergeBoardSnapshot(previous: Board | null | undefined, incoming: Board): Board {
  if (!previous || previous.id !== incoming.id) return incoming;
  const current = previous.revision > incoming.revision ? previous : incoming;
  const live = new Set((current.updates ?? []).map(update => update.id));
  const seen = new Set([...(previous.seenUpdateIds ?? []), ...(incoming.seenUpdateIds ?? [])]);
  return { ...current, seenUpdateIds: [...seen].filter(id => live.has(id)) };
}
