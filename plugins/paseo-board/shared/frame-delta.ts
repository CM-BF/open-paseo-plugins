import type { CanvasPatch, JsonData } from "./contracts";
import type { FrameSnapshot, FrameTheme } from "./frame-contract";

export type FrameDataChange =
  | { op: "set"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "append"; path: string; offset: number; values: unknown[] };
export type TransportSnapshot = Omit<FrameSnapshot, "canvas"> & { canvas: Omit<FrameSnapshot["canvas"], "html"> };
export interface FrameBaseline { version: number; documentVersion: number; boardRevision: number; canvasRevision: number; patchCount: number }
export interface FrameDelta {
  protocol: 1;
  base: FrameBaseline;
  version: number;
  boardRevision: number;
  canvasRevision: number;
  data: FrameDataChange[];
  patches: CanvasPatch[];
  userState?: JsonData;
  theme?: FrameTheme;
}

export function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && equalJson(left[key], right[key]));
}

/** HTML belongs to document creation, never to an ordinary snapshot or delta. */
export function transportSnapshot(snapshot: FrameSnapshot): TransportSnapshot {
  const { html: _html, ...canvas } = snapshot.canvas;
  return { ...snapshot, canvas };
}

export function frameBaseline(snapshot: TransportSnapshot, version: number): FrameBaseline {
  return { version, documentVersion: snapshot.canvas.documentVersion, boardRevision: snapshot.boardRevision, canvasRevision: snapshot.canvas.revision, patchCount: snapshot.canvas.patches.length };
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const pointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const unsafe = (key: string) => ["__proto__", "prototype", "constructor"].includes(key);

/** Input snapshots are immutable host values. Only changed branches cross postMessage. */
export function dataChanges(previous: JsonData, next: JsonData): FrameDataChange[] {
  const changes: FrameDataChange[] = [];
  const walk = (a: unknown, b: unknown, path: string, depth: number) => {
    if (a === b) return;
    if (depth >= 64 || path.length > 1800) { if (!equalJson(a, b)) changes.push({ op: "set", path, value: b }); return; }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length <= b.length && a.every((value, index) => equalJson(value, b[index]))) {
        if (a.length === b.length) return;
        const values = b.slice(a.length);
        // Tiny prefixes can cost less as a replacement than an append envelope.
        if (a.length >= 8 || JSON.stringify(a).length > 128) changes.push({ op: "append", path, offset: a.length, values });
        else changes.push({ op: "set", path, value: b });
      } else changes.push({ op: "set", path, value: b });
      return;
    }
    if (object(a) && object(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      // Unsafe property names remain representable in JSON, but never become pointer steps.
      if ([...keys].some(unsafe)) { if (!equalJson(a, b)) changes.push({ op: "set", path, value: b }); return; }
      for (const key of keys) {
        const child = path + "/" + pointer(key);
        if (!Object.prototype.hasOwnProperty.call(b, key)) changes.push({ op: "remove", path: child });
        else if (!Object.prototype.hasOwnProperty.call(a, key)) changes.push({ op: "set", path: child, value: b[key] });
        else walk(a[key], b[key], child, depth + 1);
      }
      return;
    }
    changes.push({ op: "set", path, value: b });
  };
  walk(previous, next, "", 0);
  return changes.length > 10000 ? [{ op: "set", path: "", value: next }] : changes;
}

/** A changed journal prefix requires recovery; only an append-only suffix is a delta. */
export function createFrameDelta(previous: TransportSnapshot, next: TransportSnapshot, version: number): FrameDelta | null {
  const before = previous.canvas, after = next.canvas;
  if (before.documentVersion !== after.documentVersion || next.boardRevision < previous.boardRevision || after.revision < before.revision
    || before.patches.length > after.patches.length || !before.patches.every((patch, index) => equalJson(patch, after.patches[index]))) return null;
  return {
    protocol: 1, base: frameBaseline(previous, version), version: version + 1,
    boardRevision: next.boardRevision, canvasRevision: after.revision,
    data: dataChanges(before.data, after.data), patches: after.patches.slice(before.patches.length),
    ...(!equalJson(previous.userState, next.userState) ? { userState: next.userState } : {}),
    ...(!equalJson(previous.theme, next.theme) ? { theme: next.theme } : {}),
  };
}

export function emptyFrameDelta(delta: FrameDelta): boolean {
  return delta.boardRevision === delta.base.boardRevision && delta.canvasRevision === delta.base.canvasRevision
    && !delta.data.length && !delta.patches.length && delta.userState === undefined && delta.theme === undefined;
}
