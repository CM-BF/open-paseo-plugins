export const STORE_METHODS = ["read", "create", "publish", "respond", "emit", "feed", "rename", "edit", "recordDecision", "saveState", "markUpdatesSeen", "addInteraction", "updateInteraction", "projectSideAgent", "updateExtraction"] as const;
export type StoreMethod = typeof STORE_METHODS[number];

/** Stable across restarts; every access to a Board reaches the same process. */
export function boardPartition(id: string, count: number): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return (hash >>> 0) % count;
}
