import type { Anchor, Canvas, CanvasUpdate, Interaction, JsonData } from "./contracts";

export const FRAME_CHANNEL = "paseo-board-frame-v1";
export type SelectionMode = "off" | "text" | "region" | "point";
export interface FrameTheme { scheme: "light" | "dark"; tokens: Record<string, string> }
export interface FrameError { code: string; message: string; patchId?: string }
/** CSS pixels relative to the iframe viewport (not document coordinates). */
export interface FramePosition { x: number; y: number }
export type InteractionLocation = "component" | "collapsed" | "ancestor" | "snapshot";
export interface FocusUpdateRequest { update: CanvasUpdate; token: number; targetIndex?: number; automatic?: boolean }
export interface UpdatePosition {
  requestId: string; id: string; token: number; targetIndex: number; documentVersion: number;
  status: "focused" | "unavailable" | "deferred";
  position?: FramePosition; location?: "target" | "ancestor" | "document"; reason?: string;
}
export interface AskRequest { prompt: string; anchor?: Anchor; kind?: "question" | "change" | "fork"; position?: FramePosition }
export type CaptureStatus = "pending" | "ready" | "failed";
export interface SelectionCapture { selectionId: string; anchor: Anchor; status: "ready" | "failed" }
export interface ComposeRequest { selectionId?: string; captureStatus?: CaptureStatus; kind: "question" | "change" | "fork"; anchor: Anchor; position?: FramePosition }
export interface InteractionMarker { id: string; text: string; status: Interaction["status"]; anchor?: Anchor; number: number }
export interface AskResult { status: "submitted" | "cancelled"; outcome?: string | null }
export interface FrameScope { channel: typeof FRAME_CHANNEL; boardId: string; sessionId: string }
export interface FrameSnapshot { canvas: Canvas; boardRevision: number; userState: JsonData; theme: FrameTheme }
export type FrameMessage = FrameScope & (
  | { type: "ready" }
  | { type: "canvas-pointer" }
  | { type: "canvas-activity"; busy: boolean }
  | ({ type: "update-position" } & UpdatePosition)
  | { type: "anchor"; anchor: Anchor; selectionId?: string }
  | ({ type: "selection-capture" } & SelectionCapture)
  | { type: "selection-lock"; id: string; active: boolean; dragging?: boolean }
  | { type: "compose"; selectionId: string; automatic?: boolean; request: ComposeRequest }
  | { type: "open-interaction"; id: string; position: FramePosition; location?: InteractionLocation }
  | { type: "interaction-position"; id: string; position: FramePosition; location?: InteractionLocation }
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
const position = (v: unknown): v is FramePosition => record(v) && finite(v.x) && finite(v.y) && Math.abs(v.x) < 1000000 && Math.abs(v.y) < 1000000;

/** Follow-ups retain the original question's location; transport excludes large image/reply data. */
export function interactionMarkers(interactions: readonly Interaction[]): InteractionMarker[] {
  const byId = new Map(interactions.map(item => [item.id, item]));
  const roots = new Map<string, { root: Interaction; latest: Interaction }>();
  for (const item of interactions) {
    let root = item;
    const seen = new Set([item.id]);
    while (root.sourceInteractionId && byId.has(root.sourceInteractionId) && !seen.has(root.sourceInteractionId)) {
      seen.add(root.sourceInteractionId);
      root = byId.get(root.sourceInteractionId)!;
    }
    const existing = roots.get(root.id);
    if (!existing) roots.set(root.id, { root, latest: item });
    else if (item.createdAt >= existing.latest.createdAt) existing.latest = item;
  }
  return Array.from(roots.values()).map(({ root, latest }, index) => ({
    id: root.id, text: root.text.slice(0, 240), status: latest.status, number: index + 1,
    ...(root.anchor ? { anchor: { ...root.anchor, image: undefined } } : {}),
  }));
}

/** A frame can author arbitrary code, so every privileged bridge payload is checked again here. */
export function readFrameMessage(value: unknown, scope: Pick<FrameScope, "boardId" | "sessionId">): FrameMessage | null {
  if (!record(value) || value.channel !== FRAME_CHANNEL || value.boardId !== scope.boardId || value.sessionId !== scope.sessionId) return null;
  switch (value.type) {
    case "ready": case "canvas-pointer": case "selection-end": case "selection-clear": break;
    case "canvas-activity": if (typeof value.busy !== "boolean") return null; break;
    case "update-position":
      if (!short(value.requestId, 160) || !short(value.id, 160)
        || !Number.isSafeInteger(value.token) || Number(value.token) < 0
        || !Number.isSafeInteger(value.targetIndex) || Number(value.targetIndex) < 0 || Number(value.targetIndex) > 100
        || !Number.isSafeInteger(value.documentVersion) || Number(value.documentVersion) < 0
        || !["focused", "unavailable", "deferred"].includes(value.status as string)) return null;
      if (value.position !== undefined && !position(value.position)) return null;
      if (value.location !== undefined && !["target", "ancestor", "document"].includes(value.location as string)) return null;
      if (value.reason !== undefined && !short(value.reason, 500)) return null;
      if (value.status === "focused" && (!position(value.position) || !value.location)) return null;
      break;
    case "anchor": if (!validAnchor(value.anchor) || (value.selectionId !== undefined && !short(value.selectionId, 160))) return null; break;
    case "selection-capture":
      if (!short(value.selectionId, 160) || !validAnchor(value.anchor) || !["ready", "failed"].includes(value.status as string)) return null;
      if (value.status === "ready" ? !value.anchor.image : value.anchor.image !== undefined) return null;
      break;
    case "selection-lock": if (!short(value.id, 160) || typeof value.active !== "boolean" || (value.dragging !== undefined && typeof value.dragging !== "boolean")) return null; break;
    case "compose": {
      const request = value.request;
      if (!short(value.selectionId, 160) || !record(request) || !["question", "change", "fork"].includes(request.kind as string) || !validAnchor(request.anchor)) return null;
      if (request.position !== undefined && !position(request.position)) return null;
      if (request.captureStatus !== undefined && !["pending", "ready", "failed"].includes(request.captureStatus as string)) return null;
      if (request.captureStatus === "pending" && request.anchor.image !== undefined) return null;
      if (value.automatic !== undefined && typeof value.automatic !== "boolean") return null;
      break;
    }
    case "open-interaction": case "interaction-position":
      if (!short(value.id, 160) || !position(value.position)) return null;
      if (value.location !== undefined && !["component", "collapsed", "ancestor", "snapshot"].includes(value.location as string)) return null;
      break;
    case "ask": {
      const request = value.request;
      if (!short(value.id, 160) || !record(request) || !short(request.prompt, 24000)) return null;
      if (request.anchor !== undefined && !validAnchor(request.anchor)) return null;
      if (request.position !== undefined && !position(request.position)) return null;
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
  if (value.binding !== undefined) {
    const b = value.binding;
    const identity = (v: unknown): boolean => record(v) && short(v.selector, 1000) && short(v.tag, 100)
      && (v.id === undefined || short(v.id, 1000)) && typeof v.fingerprint === "string" && /^[a-f0-9]{8}$/.test(v.fingerprint);
    if (!record(b) || !Number.isInteger(b.documentVersion) || Number(b.documentVersion) < 0 || !short(b.key, 160)
      || !identity(b.target) || !Array.isArray(b.ancestors) || b.ancestors.length > 8 || !b.ancestors.every(identity)
      || !record(b.relative) || !finite(b.relative.x) || !finite(b.relative.y)
      || b.relative.x < 0 || b.relative.x > 1 || b.relative.y < 0 || b.relative.y > 1) return false;
  }
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

/** Late pixels may add only an image to the exact reference opened by the user. */
export function sameSelectionAnchor(a: Anchor, b: Anchor): boolean {
  return JSON.stringify({ ...a, image: undefined }) === JSON.stringify({ ...b, image: undefined });
}
