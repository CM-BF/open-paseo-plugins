import type { DataPatch, JsonData } from "../shared/contracts";
import { assertJson, BoardStoreError, canonicalJson } from "./store-format";

const owns = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const dangerous = new Set(["__proto__", "prototype", "constructor"]);

export function pointer(path: string): string[] {
  if (!path.startsWith("/") || /~(?:[^01]|$)/.test(path)) throw new BoardStoreError("invalid_input", "Data paths must be valid non-root JSON Pointers", { path });
  const parts = path.slice(1).split("/").map(part => part.replace(/~[01]/g, escape => escape === "~0" ? "~" : "/"));
  if (parts.length > 64 || parts.some(part => dangerous.has(part))) throw new BoardStoreError("invalid_input", "Unsafe or excessively deep data path", { path });
  return parts;
}

function parent(data: JsonData, parts: string[], path: string): JsonData {
  let value: unknown = data;
  for (const part of parts.slice(0, -1)) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !owns(value, part)) throw new BoardStoreError("data_conflict", "Data patch parent is missing or is not an object; arrays must be replaced as a whole", { path, reason: "unavailable_parent" });
    value = (value as JsonData)[part];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BoardStoreError("data_conflict", "Data patches cannot traverse arrays or non-object parents", { path, reason: "unavailable_parent" });
  return value as JsonData;
}

/** Every precondition refers to the same committed snapshot. No partial writes escape. */
export function applyDataPatch(data: JsonData, patches: DataPatch[]): JsonData {
  const paths = patches.map(patch => pointer(patch.path));
  for (let index = 0; index < paths.length; index++) {
    const parts = paths[index];
    for (let earlier = 0; earlier < index; earlier++) {
      const other = paths[earlier];
      if (parts.slice(0, Math.min(parts.length, other.length)).every((part, at) => part === other[at])) throw new BoardStoreError("invalid_input", "A data patch batch cannot contain duplicate or overlapping paths", { path: patches[index].path, overlaps: patches[earlier].path });
    }
    const patch = patches[index];
    if (patch.expected.exists) assertJson(patch.expected.value, "Expected data value");
    if (patch.operation === "set") assertJson(patch.value, "New data value");
    const object = parent(data, parts, patch.path);
    const key = parts.at(-1)!;
    const exists = owns(object, key);
    const actual = { exists, ...(exists ? { value: object[key] } : {}) };
    if (exists !== patch.expected.exists || exists && canonicalJson(object[key]) !== canonicalJson(patch.expected.value)) throw new BoardStoreError("data_conflict", "Data changed at the requested path; reread and reconcile before retrying", { path: patch.path, expected: patch.expected, actual, reason: "precondition_failed" });
  }
  const next = structuredClone(data);
  for (let index = 0; index < patches.length; index++) {
    const patch = patches[index];
    const object = parent(next, paths[index], patch.path);
    const key = paths[index].at(-1)!;
    if (patch.operation === "set") object[key] = structuredClone(patch.value);
    else delete object[key];
  }
  assertJson(next, "Canvas data");
  return next;
}
