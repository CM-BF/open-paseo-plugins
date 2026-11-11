export const STORE_METHODS = ["read", "create", "publish", "respond", "emit", "feed", "rename", "edit", "recordDecision", "saveState", "markUpdatesSeen", "addInteraction", "updateInteraction", "projectSideAgent", "updateExtraction", "projectPublic"] as const;
export type StoreMethod = typeof STORE_METHODS[number];

/** Pure CPU work shares the same bounded queue without enlarging BoardStoreApi. */
export const COMPUTE_METHODS = ["buildRelease", "releaseZip", "materializeAuthoredHtml"] as const;
export type ComputeMethod = typeof COMPUTE_METHODS[number];
export type WorkerMethod = StoreMethod | ComputeMethod;
export function isComputeMethod(method: unknown): method is ComputeMethod {
  return typeof method === "string" && (COMPUTE_METHODS as readonly string[]).includes(method);
}

/** Stable across restarts; every access to a Board reaches the same process. */
export function boardPartition(id: string, count: number): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return (hash >>> 0) % count;
}
