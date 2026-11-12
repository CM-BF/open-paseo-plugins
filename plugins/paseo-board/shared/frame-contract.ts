import type { Anchor, Canvas, CanvasBase, CanvasUpdate, Interaction, JsonData } from "./contracts";
import { createComponentLayoutTools, type ComponentLayout } from "./component-layout";

export const FRAME_CHANNEL = "paseo-board-frame-v1";
export type SelectionMode = "off" | "text" | "region" | "point" | "component";
export interface FrameTheme { scheme: "light" | "dark"; tokens: Record<string, string> }
export interface FrameError { code: string; message: string; patchId?: string }
/** CSS pixels relative to the iframe viewport (not document coordinates). */
export interface FramePosition { x: number; y: number }
/** Local reading position only: never author state, an edit identity or a send authority. */
export interface CanvasViewState {
  documentVersion: number;
  canvasRevision: number;
  x: number;
  y: number;
  anchor?: { selector: string; offsetX: number; offsetY: number };
  scrolls: Array<{ selector: string; x: number; y: number }>;
}
export type CanvasViewRestoreStatus = "restored" | "cancelled" | "unavailable";
export type InteractionLocation = "component" | "collapsed" | "ancestor" | "snapshot" | "hidden";
export interface FocusUpdateRequest { update: CanvasUpdate; token: number; targetIndex?: number; automatic?: boolean }
export interface UpdatePosition {
  requestId: string; id: string; token: number; targetIndex: number; documentVersion: number;
  status: "focused" | "unavailable" | "deferred";
  position?: FramePosition; location?: "target" | "ancestor" | "document"; reason?: string;
}
export interface AskRequest { prompt: string; anchor?: Anchor; kind?: "question" | "change" | "fork"; position?: FramePosition }
export type CaptureStatus = "pending" | "ready" | "failed";
export const CAPTURE_FAILURE_REASONS = ["content-changed", "too-complex", "unsupported-layout", "too-large", "timeout", "generation-failed"] as const;
export type CaptureFailureReason = typeof CAPTURE_FAILURE_REASONS[number];
export interface SelectionCapture { selectionId: string; anchor: Anchor; status: "ready" | "failed"; reason?: CaptureFailureReason }
export interface ComposeRequest { selectionId?: string; captureStatus?: CaptureStatus; kind: "question" | "change" | "fork"; anchor: Anchor; position?: FramePosition }
export interface InteractionMarker { id: string; interactionId?: string; commentId?: string; text: string; status: Interaction["status"]; anchor?: Anchor; number: number; label?: string }
export interface ComponentEditIdentity { tag: string; id?: string; fingerprint: string; authoredHtml?: string }
export interface ComponentEditRequest {
  canvasBase: CanvasBase;
  patch: {
    operation: "move" | "copy" | "text" | "layout"; selector: string; sourceIdentity: ComponentEditIdentity;
    destination?: string; destinationIdentity?: ComponentEditIdentity; position?: "before" | "after" | "append" | "prepend";
    text?: string; expectedText?: string; textNodeIndex?: number;
    layout?: ComponentLayout;
  };
  sourceLabel?: string; destinationLabel?: string;
}
export interface ComponentEditResult { status: "applied" | "rejected" | "cancelled" | "unknown"; message?: string; canvasRevision?: number }
export interface AskResult { status: "submitted" | "queued" | "cancelled"; outcome?: string | null }
export interface FrameScope { channel: typeof FRAME_CHANNEL; boardId: string; sessionId: string }
export interface FrameSnapshot { canvas: Canvas; boardRevision: number; userState: JsonData; theme: FrameTheme }
export interface FrameCompositionSlot {
  id: string; hostId: string; boardId: string; view: "interactive" | "preview"; snapshotId?: string;
  frameIndex: number; frameToken: string; rect: { x: number; y: number; width: number; height: number }; visible: boolean;
}
export type FrameMessage = FrameScope & (
  | { type: "ready"; capabilities?: { frameDelta: 1; viewState?: 1; viewPort?: 1 } }
  | { type: "view-state"; view: CanvasViewState; capturedAt?: number }
  | { type: "composition-slots"; slots: FrameCompositionSlot[] }
  | { type: "composition-open"; id: string }
  | { type: "composition-drafts"; id: string }
  | { type: "view-restored"; requestId: string; documentVersion: number; status: CanvasViewRestoreStatus }
  | { type: "snapshot-request"; documentVersion: number; version: number; reason: string }
  | { type: "canvas-pointer" }
  | { type: "canvas-activity"; busy: boolean; interacting?: boolean }
  | ({ type: "update-position" } & UpdatePosition)
  | { type: "component-edit"; id: string; request: ComponentEditRequest }
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
  // Liquid-glass preset replies to a host-forwarded "/" (see client/preset-keys.ts).
  | { type: "preset-key-ack"; opened: boolean }
  | { type: "preset-focus-return" }
);

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const short = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const position = (v: unknown): v is FramePosition => record(v) && finite(v.x) && finite(v.y) && Math.abs(v.x) < 1000000 && Math.abs(v.y) < 1000000;

export function isCanvasViewState(value: unknown): value is CanvasViewState {
  const coordinate = (n: unknown) => finite(n) && Math.abs(n) <= 10000000;
  const selector = (s: unknown) => short(s, 1000);
  if (!record(value) || Object.keys(value).some(key => !["documentVersion", "canvasRevision", "x", "y", "anchor", "scrolls"].includes(key))
    || !Number.isSafeInteger(value.documentVersion) || Number(value.documentVersion) < 0
    || !Number.isSafeInteger(value.canvasRevision) || Number(value.canvasRevision) < 0
    || !coordinate(value.x) || !coordinate(value.y) || !Array.isArray(value.scrolls) || value.scrolls.length > 32) return false;
  if (value.anchor !== undefined && (!record(value.anchor) || !selector(value.anchor.selector)
    || !coordinate(value.anchor.offsetX) || !coordinate(value.anchor.offsetY)
    || Object.keys(value.anchor).some(key => !["selector", "offsetX", "offsetY"].includes(key)))) return false;
  const seen = new Set<string>();
  for (const item of value.scrolls) {
    if (!record(item) || !selector(item.selector) || !coordinate(item.x) || !coordinate(item.y)
      || Object.keys(item).some(key => !["selector", "x", "y"].includes(key)) || seen.has(String(item.selector))) return false;
    seen.add(String(item.selector));
  }
  return true;
}

/** The reserved prefix excludes business IDs; the parent length excludes comment collisions. */
export function interactionMarkerId(interactionId: string, commentId: string): string {
  return `@comment:${interactionId.length}:${interactionId}:${commentId}`;
}

/** Resolve only known comments. An unrecognized marker remains unknown to membership guards. */
export function markerInteractionId(markerId: string, interactions: readonly Interaction[]): string {
  if (interactions.some(item => item.id === markerId)) return markerId;
  for (const item of interactions) {
    if (item.comments?.some(comment => interactionMarkerId(item.id, comment.id) === markerId)) return item.id;
  }
  return markerId;
}

/** Follow-ups retain the original question's locations; transport excludes large image/reply data. */
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
  return Array.from(roots.values()).flatMap(({ root, latest }, index): InteractionMarker[] => {
    const number = index + 1;
    if (root.comments?.length) return root.comments.map((comment, commentIndex) => ({
      id: interactionMarkerId(root.id, comment.id), interactionId: root.id, commentId: comment.id,
      text: comment.text.slice(0, 240), status: latest.status, number, label: `${number}.${commentIndex + 1}`,
      ...(comment.anchor ? { anchor: { ...comment.anchor, image: undefined } } : {}),
    }));
    return [{
      id: root.id, text: root.text.slice(0, 240), status: latest.status, number,
      ...(root.anchor ? { anchor: { ...root.anchor, image: undefined } } : {}),
    }];
  });
}

/** A frame can author arbitrary code, so every privileged bridge payload is checked again here. */
export function readFrameMessage(value: unknown, scope: Pick<FrameScope, "boardId" | "sessionId">): FrameMessage | null {
  if (!record(value) || value.channel !== FRAME_CHANNEL || value.boardId !== scope.boardId || value.sessionId !== scope.sessionId) return null;
  switch (value.type) {
    case "composition-slots":
      if (!Array.isArray(value.slots) || value.slots.length > 16 || value.slots.some(slot => !record(slot)
        || !short(slot.id, 160) || !short(slot.hostId, 256) || !short(slot.boardId, 160)
        || !["interactive", "preview"].includes(String(slot.view)) || slot.snapshotId !== undefined && !short(slot.snapshotId, 200)
        || !short(slot.frameToken, 160) || !Number.isSafeInteger(slot.frameIndex) || Number(slot.frameIndex) < 0 || Number(slot.frameIndex) > 1000
        || !record(slot.rect) || !finite(slot.rect.x) || !finite(slot.rect.y) || Math.abs(slot.rect.x) > 1000000 || Math.abs(slot.rect.y) > 1000000 || !finite(slot.rect.width) || !finite(slot.rect.height) || slot.rect.width < 0 || slot.rect.height < 0 || slot.rect.width > 100000 || slot.rect.height > 100000 || typeof slot.visible !== "boolean")
        || new Set(value.slots.map(slot => slot.id)).size !== value.slots.length) return null;
      break;
    case "composition-open": case "composition-drafts": if (!short(value.id, 160)) return null; break;
    case "ready":
      if (value.capabilities !== undefined && (!record(value.capabilities) || value.capabilities.frameDelta !== 1 || value.capabilities.viewState !== undefined && value.capabilities.viewState !== 1 || value.capabilities.viewPort !== undefined && value.capabilities.viewPort !== 1)) return null;
      break;
    case "view-state": if (!isCanvasViewState(value.view) || value.capturedAt !== undefined && (!finite(value.capturedAt) || value.capturedAt < 0)) return null; break;
    case "view-restored":
      if (!short(value.requestId, 160) || !Number.isSafeInteger(value.documentVersion) || Number(value.documentVersion) < 0 || !["restored", "cancelled", "unavailable"].includes(value.status as string)) return null;
      break;
    case "snapshot-request":
      if (!Number.isSafeInteger(value.documentVersion) || Number(value.documentVersion) < 0 || !Number.isSafeInteger(value.version) || Number(value.version) < 0 || !short(value.reason, 100)) return null;
      break;
    case "canvas-pointer": case "selection-end": case "selection-clear": case "preset-focus-return": break;
    case "preset-key-ack": if (typeof value.opened !== "boolean") return null; break;
    case "canvas-activity":
      if (typeof value.busy !== "boolean" || value.interacting !== undefined && typeof value.interacting !== "boolean" || value.interacting === true && !value.busy) return null;
      break;
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
    case "component-edit": if (!short(value.id, 160) || !validComponentEditRequest(value.request)) return null; break;
    case "anchor": if (!validAnchor(value.anchor) || (value.selectionId !== undefined && !short(value.selectionId, 160))) return null; break;
    case "selection-capture":
      if (!short(value.selectionId, 160) || !validAnchor(value.anchor) || !["ready", "failed"].includes(value.status as string)) return null;
      if (value.status === "ready" ? !value.anchor.image : value.anchor.image !== undefined) return null;
      if (value.reason !== undefined && (value.status !== "failed" || !CAPTURE_FAILURE_REASONS.includes(value.reason as CaptureFailureReason))) return null;
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
      if (!short(value.id, 512) || !position(value.position)) return null;
      if (value.location !== undefined && !["component", "collapsed", "ancestor", "snapshot", "hidden"].includes(value.location as string)) return null;
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
  // A restored/frozen anchor may have passed through schema validation, which
  // changes key insertion order. Pixels arrive separately from this identity.
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]));
    return value;
  };
  return JSON.stringify(ordered({ ...a, image: undefined })) === JSON.stringify(ordered({ ...b, image: undefined }));
}

/** Editing proposals are inert until the user saves through the host-owned control. */
export function validComponentEditRequest(value: unknown): value is ComponentEditRequest {
  if (!record(value) || !record(value.canvasBase) || !record(value.patch) || jsonSize(value) > 550000) return false;
  const base = value.canvasBase, patch = value.patch;
  if (!Number.isSafeInteger(base.revision) || Number(base.revision) < 0 || !Number.isSafeInteger(base.documentVersion) || Number(base.documentVersion) < 0) return false;
  const identity = (v: unknown) => record(v) && short(v.tag, 100) && (v.id === undefined || short(v.id, 1000)) && typeof v.fingerprint === "string" && /^[a-f0-9]{8}$/.test(v.fingerprint)
    && (v.authoredHtml === undefined || typeof v.authoredHtml === "string" && v.authoredHtml.length <= 240000)
    && (v.id !== undefined || typeof v.authoredHtml === "string")
    && Object.keys(v).every(key => ["tag", "id", "fingerprint", "authoredHtml"].includes(key));
  if (!["move", "copy", "text", "layout"].includes(patch.operation as string) || !short(patch.selector, 1000) || !identity(patch.sourceIdentity)) return false;
  if (value.sourceLabel !== undefined && !short(value.sourceLabel, 160) || value.destinationLabel !== undefined && !short(value.destinationLabel, 160)) return false;
  // No HTML, script, event ID or caller-controlled copy prefix crosses this bridge.
  if (Object.keys(value).some(key => !["canvasBase", "patch", "sourceLabel", "destinationLabel"].includes(key)) || Object.keys(base).some(key => !["revision", "documentVersion"].includes(key))) return false;
  if (Object.keys(patch).some(key => !["operation", "selector", "sourceIdentity", "destination", "destinationIdentity", "position", "text", "expectedText", "textNodeIndex", "layout"].includes(key))) return false;
  if (patch.operation === "layout") return createComponentLayoutTools().validate(patch.layout) && patch.destination === undefined && patch.destinationIdentity === undefined && patch.position === undefined && patch.text === undefined && patch.expectedText === undefined && patch.textNodeIndex === undefined;
  if (patch.layout !== undefined) return false;
  if (patch.operation === "text") return typeof patch.text === "string" && patch.text.length <= 24000 && typeof patch.expectedText === "string" && patch.expectedText.length <= 24000
    && (patch.textNodeIndex === undefined || Number.isSafeInteger(patch.textNodeIndex) && Number(patch.textNodeIndex) >= 0 && Number(patch.textNodeIndex) <= 10000)
    && patch.destination === undefined && patch.destinationIdentity === undefined && patch.position === undefined;
  return short(patch.destination, 1000) && identity(patch.destinationIdentity) && ["before", "after", "append", "prepend"].includes(patch.position as string)
    && patch.text === undefined && patch.expectedText === undefined && patch.textNodeIndex === undefined;
}
