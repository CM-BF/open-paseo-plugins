import { LIVE_LIMITS, LIVE_RUNTIME_OUTDATED, type LiveChannel, type LiveGetOutput, type LiveMark, type LiveWithheld } from "../shared/live-data";
import { LivePathSchema, PublicApiOriginSchema, isLoopbackOrigin, livePathSegments, livePathsDisjoint, type LiveState } from "../shared/release-contracts";

export { LIVE_RUNTIME_OUTDATED };
export const liveStateNames: Record<LiveState, string> = {
  off: "未开启", pending: "等待首次推送", syncing: "正在推送", live: "实时公开中", retrying: "推送失败，正在重试", paused: "已暂停推送",
  "too-large": "数据超过上限，已停止更新", blocked: "已停止推送，需要你处理", revoking: "正在清除后端副本", revoked: "已停止公开",
};
const withheldReasons: Record<LiveWithheld["reason"], string> = {
  absent: "这个路径目前不存在，暂不公开",
  "object-without-subtree": "这里是对象或含对象的数组；只有勾选「包含以后新增的字段」才会公开",
  "non-object-parent": "上级不是对象，无法公开",
};
export const liveWithheldText = (item: LiveWithheld) => `${item.path}：${withheldReasons[item.reason]}`;

type Live = Pick<LiveGetOutput, "channel" | "status">;
/** One line for the More menu; only a state the owner has to act on raises the toolbar dot. */
export function liveSummary(live?: Live): { attention: boolean; detail: string } {
  const state = live?.status.state ?? "off";
  return { attention: state === "blocked" || state === "retrying", detail: state === "off" ? "把勾选的字段实时公开到分享页" : liveStateNames[state] };
}
/** A channel that can back a release: the server applies the same rule when it builds one. */
export const liveReleasable = (channel?: LiveChannel | null): channel is LiveChannel => channel?.state === "ready" || channel?.state === "paused";
export const liveIsLoopback = (origin: string) => { try { return isLoopbackOrigin(origin); } catch { return false; } };

export type LiveField = { path: string; key: string; depth: number; summary: string; kind: "object" | "array" | "value" };
const MAX_FIELDS = 300, MAX_DEPTH = 12, SUMMARY_CHARS = 48;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const encodeSegment = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const validPath = (path: string) => LivePathSchema.safeParse(path).success;
function fieldSummary(value: unknown): string {
  if (isObject(value)) return `对象 · ${Object.keys(value).length} 个字段`;
  if (Array.isArray(value)) return `数组 · ${value.length} 项`;
  const text = JSON.stringify(value) ?? "null";
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text;
}
/** The tree of canvas data the owner can mark. Arrays are one value: marks never index into them. */
export function liveFields(data: unknown): { fields: LiveField[]; truncated: boolean } {
  const fields: LiveField[] = [];
  let truncated = false;
  const walk = (value: Record<string, unknown>, parent: string, depth: number) => {
    for (const key of Object.keys(value)) {
      if (fields.length >= MAX_FIELDS) { truncated = true; return; }
      const path = `${parent}/${encodeSegment(key)}`, child = value[key];
      if (!validPath(path)) continue;
      fields.push({ path, key, depth, summary: fieldSummary(child), kind: isObject(child) ? "object" : Array.isArray(child) ? "array" : "value" });
      if (isObject(child)) { if (depth + 1 < MAX_DEPTH) walk(child, path, depth + 1); else truncated = true; }
    }
  };
  if (isObject(data)) walk(data, "", 0);
  return { fields, truncated };
}

/** Follows the same object-only resolution as the server projection. */
export function liveValueAt(data: unknown, path: string): { found: boolean; value?: unknown } {
  let current = data;
  for (const key of livePathSegments(path)) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, key)) return { found: false };
    current = current[key];
  }
  return { found: true, value: current };
}
const holdsObject = (value: unknown): boolean => Array.isArray(value) ? value.some(holdsObject) : !!value && typeof value === "object";
/** An object can grow keys, so publishing one takes the explicit subtree consent. */
export const liveNeedsSubtree = (data: unknown, mark: LiveMark) => { const { found, value } = liveValueAt(data, mark.path); return found && !mark.subtree && holdsObject(value); };
export const liveIsArray = (data: unknown, path: string) => { const { found, value } = liveValueAt(data, path); return found && Array.isArray(value); };
export const liveMayGrowKeys = (data: unknown, mark: LiveMark) => { const { found, value } = liveValueAt(data, mark.path); return mark.subtree || !found || holdsObject(value); };

/** The mark that contains or sits under this path; marks may never overlap. */
export function overlappingLiveMark(marks: readonly LiveMark[], path: string): string | undefined {
  const parts = livePathSegments(path);
  return marks.find(mark => {
    if (mark.path === path) return false;
    const other = livePathSegments(mark.path), shared = Math.min(other.length, parts.length);
    return other.slice(0, shared).every((part, index) => part === parts[index]);
  })?.path;
}
const byPath = (a: LiveMark, b: LiveMark) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
export const liveMarksKey = (marks: readonly LiveMark[]) => JSON.stringify([...marks].sort(byPath));
export function addLiveMark(marks: readonly LiveMark[], path: string): LiveMark[] | string {
  if (marks.some(mark => mark.path === path)) return [...marks];
  if (!validPath(path)) return "路径应为 JSON Pointer，例如 /live/score，不能是根路径或含危险键。";
  if (marks.length >= LIVE_LIMITS.paths) return `最多公开 ${LIVE_LIMITS.paths} 个路径。`;
  const overlap = overlappingLiveMark(marks, path);
  if (overlap || !livePathsDisjoint([...marks.map(mark => mark.path), path])) return `这个路径与已勾选的 ${overlap ?? "路径"} 重叠。`;
  return [...marks, { path, subtree: false }];
}
export const removeLiveMark = (marks: readonly LiveMark[], path: string) => marks.filter(mark => mark.path !== path);
export const setLiveMarkSubtree = (marks: readonly LiveMark[], path: string, subtree: boolean) => marks.map(mark => mark.path === path ? { ...mark, subtree } : mark);
/** A path dropped from public view: the backend keeps it until the next push lands. */
export const liveMarksNarrowed = (before: readonly LiveMark[], after: readonly LiveMark[]) => before.some(mark => !after.some(item => item.path === mark.path));

/** Origins of the pages already shared, so the owner sees a missing CORS entry before a visitor does. */
export function sharePageOrigins(links: readonly (string | undefined)[]): string[] {
  const origins = new Set<string>();
  for (const link of links) {
    const origin = link?.match(/^https?:\/\/[^/?#]+/i)?.[0];
    if (origin && PublicApiOriginSchema.safeParse(origin).success) origins.add(origin);
  }
  return [...origins].slice(0, 8);
}
/** Whether the release's frozen public data already holds values at live paths: they outlive a stop. */
export function publicDataAtLivePaths(publicData: string, paths: readonly string[]): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(publicData); } catch { return false; }
  return paths.some(path => liveValueAt(parsed, path).found);
}
