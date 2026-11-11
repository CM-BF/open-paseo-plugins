import { createHash } from "node:crypto";
import type { JsonData } from "../shared/contracts";
import type { LiveMark, LiveWithheld } from "../shared/live-data";
import { LIVE_LIMITS } from "../shared/release-contracts";
import { pointer } from "./data-patch";
import { canonicalJson } from "./store-format";

const owns = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value: unknown): value is JsonData => !!value && typeof value === "object" && !Array.isArray(value);
// Containers in the document, as the backend counts them: the document itself is depth 1.
const MAX_DOCUMENT_DEPTH = 64;

export interface LiveProjection {
  /** Canonical JSON of the public values; omitted when the document is over the limit. */
  body?: string;
  digest?: string;
  bytes: number;
  overLimit: boolean;
  withheld: LiveWithheld[];
  pathBytes: Record<string, number>;
}
export interface LiveBoardProjection extends LiveProjection { createdAt: string; canvasRevision: number }

export function sortLiveMarks(marks: readonly LiveMark[]): LiveMark[] {
  return [...marks].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function resolve(data: JsonData, path: string): { value: unknown } | { reason: LiveWithheld["reason"] } {
  let current: unknown = data;
  for (const key of pointer(path)) {
    if (!isObject(current)) return { reason: "non-object-parent" };
    if (!owns(current, key)) return { reason: "absent" };
    current = current[key];
  }
  return { value: current };
}

/** An object can grow keys, so it is public only by explicit subtree consent, even inside an array. */
const holdsObject = (value: unknown): boolean => Array.isArray(value) ? value.some(holdsObject) : !!value && typeof value === "object";
const tooDeep = (value: unknown, depth: number): boolean => !!value && typeof value === "object" && (depth > MAX_DOCUMENT_DEPTH || Object.values(value).some(item => tooDeep(item, depth + 1)));

/** Pure allow-list over canvas data. Never throws on absent or array parents: it withholds them. */
export function projectLive(data: JsonData, marks: readonly LiveMark[]): LiveProjection {
  const values: JsonData = {}, withheld: LiveWithheld[] = [], pathBytes: Record<string, number> = {};
  for (const { path, subtree } of sortLiveMarks(marks)) {
    const found = resolve(data, path);
    if ("reason" in found) { withheld.push({ path, reason: found.reason }); continue; }
    if (!subtree && holdsObject(found.value)) { withheld.push({ path, reason: "object-without-subtree" }); continue; }
    values[path] = found.value;
    pathBytes[path] = Buffer.byteLength(canonicalJson(found.value), "utf8");
  }
  const body = canonicalJson(values), bytes = Buffer.byteLength(body, "utf8");
  const overLimit = bytes > LIVE_LIMITS.documentBytes || Object.values(values).some(value => tooDeep(value, 2));
  if (overLimit) return { bytes, overLimit, withheld, pathBytes };
  return { body, digest: createHash("sha256").update(body).digest("hex"), bytes, overLimit, withheld, pathBytes };
}
