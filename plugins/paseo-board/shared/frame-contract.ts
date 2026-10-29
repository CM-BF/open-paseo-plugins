import type { Anchor, Canvas, JsonData } from "./contracts";

export const FRAME_CHANNEL = "paseo-board-frame-v1";
export type SelectionMode = "off" | "text" | "region" | "point";
export interface FrameTheme { scheme: "light" | "dark"; tokens: Record<string, string> }
export interface FrameError { code: string; message: string; patchId?: string }
export interface AskRequest { prompt: string; anchor?: Anchor; kind?: "question" | "change" | "fork" }
export interface ComposeRequest { kind: "question" | "change" | "fork"; anchor: Anchor }
export interface AskResult { status: "submitted" | "cancelled"; outcome?: string | null }
export interface FrameScope { channel: typeof FRAME_CHANNEL; boardId: string; sessionId: string }
export interface FrameSnapshot { canvas: Canvas; boardRevision: number; userState: JsonData; theme: FrameTheme }
export type FrameMessage = FrameScope & (
  | { type: "ready" }
  | { type: "anchor"; anchor: Anchor; selectionId?: string }
  | { type: "selection-lock"; id: string; active: boolean; dragging?: boolean }
  | { type: "compose"; selectionId: string; request: ComposeRequest }
  | { type: "ask"; id: string; request: AskRequest }
  | { type: "state"; state: JsonData }
  | { type: "error"; error: FrameError }
  | { type: "open-link"; url: string }
  | { type: "selection-end" }
  | { type: "selection-clear" }
);

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const short = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A frame can author arbitrary code, so every privileged bridge payload is checked again here. */
export function readFrameMessage(value: unknown, scope: Pick<FrameScope, "boardId" | "sessionId">): FrameMessage | null {
  if (!record(value) || value.channel !== FRAME_CHANNEL || value.boardId !== scope.boardId || value.sessionId !== scope.sessionId) return null;
  switch (value.type) {
    case "ready": case "selection-end": case "selection-clear": break;
    case "anchor": if (!validAnchor(value.anchor) || (value.selectionId !== undefined && !short(value.selectionId, 160))) return null; break;
    case "selection-lock": if (!short(value.id, 160) || typeof value.active !== "boolean" || (value.dragging !== undefined && typeof value.dragging !== "boolean")) return null; break;
    case "compose": {
      const request = value.request;
      if (!short(value.selectionId, 160) || !record(request) || !["question", "change", "fork"].includes(request.kind as string) || !validAnchor(request.anchor)) return null;
      break;
    }
    case "ask": {
      const request = value.request;
      if (!short(value.id, 160) || !record(request) || !short(request.prompt, 24000)) return null;
      if (request.anchor !== undefined && !validAnchor(request.anchor)) return null;
      if (request.kind !== undefined && !["question", "change", "fork"].includes(request.kind as string)) return null;
      break;
    }
    case "state": if (!record(value.state) || jsonSize(value.state) > 524288) return null; break;
    case "error": if (!record(value.error) || !short(value.error.code, 100) || !short(value.error.message, 4000) || (value.error.patchId !== undefined && !short(value.error.patchId, 160))) return null; break;
    case "open-link": if (!short(value.url, 8000) || !/^https?:\/\//i.test(value.url)) return null; break;
    default: return null;
  }
  return value as unknown as FrameMessage;
}

export function jsonSize(value: unknown): number {
  try { return JSON.stringify(value)?.length ?? Infinity; } catch { return Infinity; }
}

export function validAnchor(value: unknown): value is Anchor {
  if (!record(value) || !Number.isInteger(value.boardRevision) || Number(value.boardRevision) < 0 || !Number.isInteger(value.canvasRevision) || Number(value.canvasRevision) < 0) return false;
  if (!["board", "text", "region", "point", "element"].includes(value.kind as string)) return false;
  if (value.text !== undefined && (typeof value.text !== "string" || value.text.length > 12000)) return false;
  if (value.selector !== undefined && !short(value.selector, 1000)) return false;
  if (value.rect !== undefined) {
    const r = value.rect;
    if (!record(r) || !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height) || r.width < 0 || r.height < 0) return false;
  }
  if (value.viewport !== undefined) {
    const v = value.viewport;
    if (!record(v) || !finite(v.width) || !finite(v.height) || v.width <= 0 || v.height <= 0 || !finite(v.scrollX) || !finite(v.scrollY)) return false;
  }
  if (value.image !== undefined) {
    const i = value.image;
    if (!record(i) || i.mimeType !== "image/png" || !short(i.data, 3000000) || !/^iVBORw0KGgo[A-Za-z0-9+/=]*$/.test(i.data)) return false;
  }
  return true;
}
