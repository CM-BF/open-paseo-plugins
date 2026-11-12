// Browser DOM access lives only in this module. Native callers use their compatibility view.
import { createElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { Platform } from "react-native";
import { messageShortcut } from "./message-shortcuts";
import type { BoardSyncVisibility } from "./compact-sync";
import type { CanvasComposition, CompositionAttachment, CompositionMessageEvent, CompositionMount, CompositionPort } from "./composition-mount";
import { createCompositionController, type CompositionController } from "./composition-web";
import type { Anchor, Canvas, Interaction, JsonData } from "../shared/contracts";
import { buildBoardDocument } from "../shared/document";
import { createLiquidGlassTracker, type LiquidGlassUsage } from "../shared/liquid-glass";
import { presetFocusAllowed, presetKeyIntent, type PresetKeyEvent } from "./preset-keys";
import { createFrameDelta, emptyFrameDelta, transportSnapshot, type TransportSnapshot } from "../shared/frame-delta";
import { FRAME_CHANNEL, interactionMarkers, readFrameMessage, sameSelectionAnchor, isCanvasViewState, type CanvasViewState, type CanvasViewRestoreStatus, type SelectionCapture, type AskRequest, type AskResult, type ComposeRequest, type FrameError, type FramePosition, type FrameSnapshot, type FrameTheme, type InteractionLocation, type FocusUpdateRequest, type UpdatePosition, type SelectionMode, type ComponentEditRequest, type ComponentEditResult } from "../shared/frame-contract";

type ViewPort = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start(): void; close(): void;
};
type ViewReader = { receive(event: MessageEvent): void; close(): void };
type FrameWindow = { postMessage(message: unknown, origin: string, transfer?: ViewPort[]): void };
type Frame = { contentWindow: FrameWindow | null; isConnected?: boolean; getBoundingClientRect?(): { width: number; height: number }; focus?(options?: { preventScroll?: boolean }): void; blur?(): void; closest?(selector: string): unknown };
type Focusable = { isConnected?: boolean; focus?(options?: { preventScroll?: boolean }): void };
type HostKeyEvent = PresetKeyEvent & { preventDefault(): void };
type MessageEvent = { source: unknown; data: unknown; isTrusted: boolean; compositionAuthenticated?: true };
type OuterPointerEvent = { isTrusted: boolean; target?: { closest?(selector: string): unknown }; preventDefault(): void };
type BrowserWindow = {
  addEventListener(name: "message", fn: (event: MessageEvent) => void): void;
  removeEventListener(name: "message", fn: (event: MessageEvent) => void): void;
  addEventListener(name: "pointerdown" | "pointerup" | "pointercancel", fn: (event: OuterPointerEvent) => void, capture: boolean): void;
  removeEventListener(name: "pointerdown" | "pointerup" | "pointercancel", fn: (event: OuterPointerEvent) => void, capture: boolean): void;
  addEventListener(name: "keydown", fn: (event: HostKeyEvent) => void): void;
  removeEventListener(name: "keydown", fn: (event: HostKeyEvent) => void): void;
};
const browser = globalThis as unknown as {
  window?: BrowserWindow;
  document?: { activeElement: unknown; hidden: boolean; body?: unknown; documentElement?: unknown; visibilityState?: string; addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void };
  navigator?: { userActivation?: { isActive: boolean } };
  crypto?: { getRandomValues(bytes: Uint8Array): Uint8Array };
  MessageChannel?: new () => { port1: ViewPort; port2: ViewPort };
};
export const canRenderFrames = Platform.OS === "web" && Boolean(browser.window && browser.document);

// This registry owns only brief, read-only handoffs. Live frames keep their usual
// independent source/session checks even when several tabs show the same Board.
const VIEW_HANDOFF_MS = 250;
const viewLeases = new Map<string, { revoke(): void }>();
function acquireViewLease(scope: string) {
  viewLeases.get(scope)?.revoke();
  let stop: (() => void) | undefined;
  const lease = {
    current: () => viewLeases.get(scope) === lease,
    retire(cleanup: () => void) { stop = cleanup; },
    revoke() {
      stop?.(); stop = undefined;
      if (viewLeases.get(scope) === lease) viewLeases.delete(scope);
    },
  };
  viewLeases.set(scope, lease);
  while (viewLeases.size > 64) viewLeases.values().next().value?.revoke();
  return lease;
}

type ViewDelivery = {
  boardId: string; sessionId: string; version: number; scope?: string;
  canvasRevision: number; sink?: (view: CanvasViewState) => void;
  frame: Frame | null; window: FrameWindow | null; visibleAt: number | null; settled: boolean;
  portCapable?: boolean; reader?: ViewReader;
  retiredAt?: number;
};
function capturedBeforeRetirement(delivery: ViewDelivery, capturedAt?: number) {
  return delivery.retiredAt === undefined || capturedAt !== undefined && capturedAt <= delivery.retiredAt;
}
function observeViewVisibility(delivery: ViewDelivery) {
  const target = delivery.frame;
  if (browser.document?.hidden || target?.isConnected === false) { delivery.visibleAt = null; return false; }
  const bounds = target?.getBoundingClientRect?.();
  const visible = Boolean(bounds && bounds.width > 0 && bounds.height > 0);
  delivery.visibleAt = visible ? performance.now() : null;
  return visible;
}
export function getBoardSyncVisibility(): BoardSyncVisibility | undefined {
  const page = Platform.OS === "web" ? browser.document : undefined;
  if (!page) return undefined;
  return {
    visible: () => !page.hidden,
    subscribe(listener) {
      page.addEventListener("visibilitychange", listener);
      return () => page.removeEventListener("visibilitychange", listener);
    },
  };
}
export interface CanvasFrameProps extends FrameSnapshot {
  composition?: CanvasComposition;
  embeddedMount?: CompositionMount;
  boardId: string;
  title: string;
  canvas: Canvas;
  boardRevision: number;
  userState: JsonData;
  theme: FrameTheme;
  height: number;
  selectionMode: SelectionMode;
  selectionClearToken?: number;
  selectionCaptureCancelId?: string;
  interactions?: Interaction[];
  selectedInteractionId?: string;
  focusInteraction?: { id: string; token: number };
  focusUpdate?: FocusUpdateRequest;
  composerActive?: boolean;
  onUpdatePosition?(position: UpdatePosition): void;
  onCanvasActivity?(busy: boolean, interacting?: boolean): void;
  onAnchor(anchor: Anchor): void;
  onAsk(request: AskRequest): Promise<AskResult>;
  onCompose?(request: ComposeRequest): void;
  onComponentEdit?(request: ComponentEditRequest): Promise<ComponentEditResult>;
  onEditScopeChange?(): void;
  onSelectionCapture?(capture: SelectionCapture): void;
  onCanvasPointer?(): void;
  onOpenInteraction?(id: string, position: FramePosition, location?: InteractionLocation): void;
  onInteractionPosition?(id: string, position: FramePosition, location?: InteractionLocation): void;
  onState(state: JsonData): void;
  onError(error: FrameError): void;
  onOpenLink?(url: string): void;
  onReady?(): void;
  resumeView?: CanvasViewState;
  viewScope?: string;
  onViewState?(view: CanvasViewState): void;
  /** A pure local-store sink, frozen for the document being removed. */
  onFinalViewState?(view: CanvasViewState): void;
  onViewRestored?(result: { status: CanvasViewRestoreStatus }): void;
  onSelectionEnd?(): void;
  onSelectionClear?(): void;
  /**
   * Forward a bare "/" from Paseo to this canvas's liquid-glass palette (web only). fromBody: also
   * when nothing is focused, which is right only for the route screen; panels beside chat or
   * terminals pass false so only focus inside their own Board root counts.
   */
  presetKeys?: { fromBody: boolean };
}

function nonce(): string {
  const bytes = new Uint8Array(16);
  if (browser.crypto) browser.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function documentFor(props: CanvasFrameProps, glass: LiquidGlassUsage) {
  const sessionId = nonce();
  // `preset` records what this document was built with (buildBoardDocument derives the same flag).
  return { boardId: props.boardId, viewScope: props.viewScope, version: props.canvas.documentVersion, sessionId, preset: glass.preset, html: buildBoardDocument({ ...props, sessionId, compositionHostId: props.embeddedMount ? undefined : props.composition?.hostId }) };
}

/** Retains the iframe and its JS heap across data, patch, theme and UI-state updates. */
export function CanvasFrame(props: CanvasFrameProps): ReactElement | null {
  const frame = useRef<Frame | null>(null);
  const embeddedConnection = useRef<CompositionAttachment | undefined>(undefined);
  const embeddedReceive = useRef<((event: CompositionMessageEvent) => void) | undefined>(undefined);
  const compositionController = useRef<{ sessionId: string; controller: CompositionController } | undefined>(undefined);
  const compositionControl = useRef<{ sessionId: string; close(): void } | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  // Keep a save received from the live document across a document replacement even while its
  // debounced server write is still in flight. Only an actual matching prop snapshot is an ack.
  const localState = useRef<{ boardId: string; state: JsonData; dirty: boolean } | null>(null);
  if (localState.current?.boardId === props.boardId && JSON.stringify(localState.current.state) === JSON.stringify(props.userState)) localState.current.dirty = false;
  const effectiveState = () => localState.current?.boardId === latest.current.boardId && localState.current.dirty ? localState.current.state : latest.current.userState;
  const document = useRef<ReturnType<typeof documentFor> | null>(null);
  const interactionLock = useRef<{ boardId: string; sessionId: string; id: string; dragging: boolean; anchor?: Anchor; capturePending?: boolean } | null>(null);
  const [, redraw] = useState(0);
  if (interactionLock.current?.boardId !== props.boardId || document.current?.viewScope !== props.viewScope) interactionLock.current = null;
  const ready = useRef(false);
  const transport = useRef<{ sessionId: string; capable: boolean; version: number; snapshot: TransportSnapshot } | null>(null);
  const focused = useRef<string | undefined>(undefined);
  const updateSent = useRef<string | undefined>(undefined);
  const glassUsageRef = useRef<LiquidGlassUsage | undefined>(undefined);
  const updatePending = useRef<{ requestId: string; id: string; token: number; targetIndex: number; documentVersion: number } | undefined>(undefined);
  const viewRestore = useRef<{ sessionId: string; requestId: string; version: number; settled: boolean; resume?: CanvasViewState } | undefined>(undefined);
  // Liquid-glass preset: usage over base + patches (incremental), the latest reading position this
  // document reported, whether the canvas is mid-interaction, and a one-shot rebuild key.
  const glass = useRef(createLiquidGlassTracker());
  const glassUsage = glass.current.update(props.canvas);
  const lastView = useRef<CanvasViewState | undefined>(undefined);
  const canvasInteracting = useRef(false);
  const presetRebuilt = useRef<string | undefined>(undefined);
  const presetKey = `${props.boardId}:${props.canvas.documentVersion}`;
  // A live patch introduced the marker into a document built without the preset: rebuild once,
  // when the canvas is idle, restoring the current reading position (same document version).
  const presetRebuild = Boolean(document.current && glassUsage.preset && !document.current.preset && presetRebuilt.current !== presetKey
    && document.current.boardId === props.boardId && document.current.viewScope === props.viewScope && document.current.version === props.canvas.documentVersion
    && props.selectionMode === "off" && !interactionLock.current && !canvasInteracting.current);
  if (!document.current || document.current.boardId !== props.boardId || document.current.viewScope !== props.viewScope || (document.current.version !== props.canvas.documentVersion && props.selectionMode === "off" && !interactionLock.current) || presetRebuild) {
    const previous = presetRebuild ? document.current : null;
    document.current = documentFor({ ...props, userState: effectiveState() }, glassUsage);
    ready.current = false;
    canvasInteracting.current = false;
    const resume = previous && lastView.current?.documentVersion === document.current.version ? lastView.current : props.resumeView;
    viewRestore.current = { sessionId: document.current.sessionId, requestId: `${document.current.sessionId}:view`, version: document.current.version,
      settled: false, resume: isCanvasViewState(resume) && resume.documentVersion === document.current.version ? resume : undefined };
    if (previous) {
      presetRebuilt.current = presetKey;
      // Highlights already shown in the replaced session are not replayed by the new one. An
      // update request the old session never answered is sent again to the new one.
      const swap = (key: string | undefined) => key?.startsWith(previous.sessionId + ":") ? document.current!.sessionId + key.slice(previous.sessionId.length) : key;
      updateSent.current = updatePending.current ? undefined : swap(updateSent.current); focused.current = swap(focused.current);
    } else lastView.current = undefined;
  }
  const rendered = document.current;
  glassUsageRef.current = glassUsage;
  // A forwarded "/" moved focus into the canvas: where to hand it back (Esc, no palette, timeout).
  // A session that let a forward time out is muted (no further "/" is taken from Paseo) until it
  // answers; `presetExpired` lets a late "opened" reply keep focus only if nobody moved on
  // (`movedTo`: a host element focused since; Chromium lets the late palette pull focus in).
  const presetHandoff = useRef<{ sessionId: string; element: unknown; timer?: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const presetMuted = useRef<string | undefined>(undefined);
  const presetExpired = useRef<{ sessionId: string; element: unknown; at: number; movedTo?: unknown } | undefined>(undefined);
  const dropPresetHandoff = () => { clearTimeout(presetHandoff.current?.timer); presetHandoff.current = undefined; };
  const expirePresetHandoff = () => {
    const handoff = presetHandoff.current;
    if (!handoff) return;
    presetMuted.current = handoff.sessionId;
    presetExpired.current = { sessionId: handoff.sessionId, element: handoff.element, at: Date.now() };
    restorePresetFocus();
  };
  const restorePresetFocus = () => {
    const handoff = presetHandoff.current;
    if (!handoff) return;
    dropPresetHandoff();
    const page = browser.document, target = frame.current;
    if (!page) return;
    // The user already moved on (focused something else): leave focus where it is. A removed
    // frame leaves focus on the body, which still restores.
    const active = page.activeElement;
    if (active && active !== page.body && active !== target) return;
    const element = handoff.element as Focusable | null;
    if (element && element !== page.body && element.isConnected !== false && typeof element.focus === "function") element.focus({ preventScroll: true });
    else if (active === target) target?.blur?.();
  };
  const viewDelivery = useRef<ViewDelivery | undefined>(undefined);
  if (viewDelivery.current?.sessionId !== rendered.sessionId || viewDelivery.current.scope !== props.viewScope) {
    viewDelivery.current = { boardId: rendered.boardId, sessionId: rendered.sessionId, version: rendered.version,
      scope: props.viewScope, canvasRevision: props.canvas.revision, frame: null, window: null, visibleAt: null, settled: false };
  }
  const delivery = viewDelivery.current;
  // A locked old document must never acquire a new document's callback or revision.
  if (rendered.boardId === props.boardId && rendered.version === props.canvas.documentVersion) {
    delivery.canvasRevision = props.canvas.revision;
    delivery.sink = props.onFinalViewState;
  }
  const observeCurrentView = () => {
    const current = viewDelivery.current;
    if (!current || current.sessionId !== document.current?.sessionId) return;
    current.frame = frame.current;
    current.window = frame.current?.contentWindow ?? null;
    current.settled = Boolean(ready.current && viewRestore.current?.settled);
    observeViewVisibility(current);
  };
  const acceptView = (target: ViewDelivery, view: CanvasViewState) => {
    const current = latest.current;
    if (viewDelivery.current !== target || document.current?.sessionId !== target.sessionId) return;
    observeCurrentView();
    if (!ready.current || !viewRestore.current?.settled || browser.document?.hidden || target.visibleAt === null
      || target.version !== current.canvas.documentVersion || view.documentVersion !== target.version) return;
    // Kept even when a patch has since advanced the revision: it only restores a same-version
    // preset rebuild of this canvas (the runtime accepts a slightly older reading position).
    lastView.current = view;
    if (view.canvasRevision !== current.canvas.revision) return;
    current.onViewState?.(view);
  };
  const connectViewPort = () => {
    const target = viewDelivery.current;
    if (!target?.scope || !target.portCapable || !target.settled || target.reader || !target.window || !browser.MessageChannel) return;
    let channel: { port1: ViewPort; port2: ViewPort } | undefined;
    try {
      channel = new browser.MessageChannel();
      const port = channel.port1;
      const reader: ViewReader = {
        receive(event) {
          if (!event.isTrusted || !event.data || typeof event.data !== "object" || (event.data as { type?: unknown }).type !== "view-state") return;
          const message = readFrameMessage(event.data, target);
          if (message?.type === "view-state" && capturedBeforeRetirement(target, message.capturedAt)) acceptView(target, message.view);
        },
        close() { port.removeEventListener("message", onPortMessage); port.close(); },
      };
      const onPortMessage = (event: MessageEvent) => reader.receive(event);
      port.addEventListener("message", onPortMessage); port.start();
      target.reader = reader;
      // The original ready event has already authenticated this exact source and
      // session. Possession of this transferred port authenticates later positions.
      const message = { type: "view-port", channel: FRAME_CHANNEL, boardId: target.boardId, sessionId: target.sessionId };
      if (latest.current.embeddedMount) embeddedConnection.current?.send(message, [channel.port2 as CompositionPort]);
      else target.window.postMessage(message, "*", [channel.port2]);
    } catch {
      target.reader?.close(); target.reader = undefined;
      channel?.port1.close(); channel?.port2.close();
      // Older hosts retain the ordinary source-checked live bridge, without an
      // unmount handoff. A null-source window message is never accepted.
    }
  };
  const send = (payload: Record<string, unknown>) => {
    const current = document.current!;
    if (latest.current.embeddedMount) { embeddedConnection.current?.send({ ...payload, channel: FRAME_CHANNEL, boardId: current.boardId, sessionId: current.sessionId }); return; }
    frame.current?.contentWindow?.postMessage({ ...payload, channel: FRAME_CHANNEL, boardId: current.boardId, sessionId: current.sessionId }, "*");
  };
  const syncSnapshot = (force = false) => {
    const current = latest.current;
    // A locked old document must not receive the replacement document's data or patches.
    if (document.current?.version !== current.canvas.documentVersion) return;
    const next = transportSnapshot({ canvas: current.canvas, boardRevision: current.boardRevision, userState: effectiveState(), theme: current.theme });
    const previous = transport.current;
    if (!previous?.capable) { send({ type: "snapshot", snapshot: next }); return; }
    const delta = force ? null : createFrameDelta(previous.snapshot, next, previous.version);
    if (delta && emptyFrameDelta(delta)) return;
    const version = previous.version + 1;
    send(delta ? { type: "delta", delta } : { type: "snapshot", protocol: 1, version, snapshot: next });
    transport.current = { ...previous, version, snapshot: next };
  };
  const focusRequestedInteraction = () => {
    const current = latest.current;
    const request = current.focusInteraction;
    if (!ready.current || !request || request.id !== current.selectedInteractionId || !interactionMarkers(current.interactions || []).some(item => item.id === request.id)) return;
    const key = `${document.current!.sessionId}:${request.token}:${request.id}`;
    if (focused.current === key) return;
    focused.current = key;
    send({ type: "focus-interaction", id: request.id });
  };
  const focusRequestedUpdate = () => {
    const current = latest.current;
    const request = current.focusUpdate;
    if (!request) { updatePending.current = undefined; return; }
    if (!ready.current || current.composerActive || interactionLock.current || current.selectionMode !== "off") return;
    const requestId = `${document.current!.sessionId}:update:${request.token}`;
    if (updateSent.current === requestId) return;
    updateSent.current = requestId;
    updatePending.current = { requestId, id: request.update.id, token: request.token, targetIndex: request.targetIndex ?? 0, documentVersion: request.update.documentVersion };
    send({ type: "focus-update", ...request, requestId });
  };
  useLayoutEffect(() => {
    if (!canRenderFrames || !browser.window) return;
    const waiting = new Set<string>();
    const pendingEdits = new Set<string>();
    const cancelledSelections = new Set<string>();
    const composedSelections = new Set<string>();
    let disposed = false;
    let lastLink = 0;
    const sync = () => {
      const current = latest.current;
      send({ type: "selection", mode: current.selectionMode });
      syncSnapshot(true);
      send({ type: "interactions", markers: interactionMarkers(current.interactions || []), selectedId: current.selectedInteractionId });
      send({ type: "host-activity", composing: Boolean(current.composerActive) });
      focusRequestedInteraction();
      focusRequestedUpdate();
    };
    let authenticatedEmbeddedMessage = false;
    const userActing = () => (latest.current.embeddedMount ? authenticatedEmbeddedMessage : browser.document?.activeElement === frame.current) && browser.navigator?.userActivation?.isActive === true;
    const onMessage = (event: MessageEvent) => {
      if (disposed || !event.isTrusted || event.source !== frame.current?.contentWindow || !document.current) return;
      if (latest.current.embeddedMount && !event.compositionAuthenticated) return;
      authenticatedEmbeddedMessage = event.compositionAuthenticated === true;
      const message = readFrameMessage(event.data, document.current);
      if (!message) return;
      const current = latest.current;
      switch (message.type) {
        case "composition-slots": {
          if (!current.composition || current.embeddedMount || !event.compositionAuthenticated) break;
          if (compositionController.current?.sessionId !== document.current.sessionId) {
            compositionController.current?.controller.dispose();
            compositionController.current = { sessionId: document.current.sessionId, controller: createCompositionController({ scope: { ...document.current, channel: FRAME_CHANNEL }, owner: () => frame.current?.contentWindow ?? null, send, changed: mounts => latest.current.composition?.onSlots(mounts) }) };
          }
          compositionController.current.controller.update(message.slots);
          break;
        }
        case "composition-open": if (event.compositionAuthenticated && userActing()) compositionController.current?.controller.open(message.id); break;
        case "composition-drafts": if (event.compositionAuthenticated && userActing()) compositionController.current?.controller.drafts(message.id); break;
        case "ready":
          if (current.composition && !current.embeddedMount && browser.MessageChannel && compositionControl.current?.sessionId !== document.current.sessionId) {
            compositionControl.current?.close();
            const channel = new browser.MessageChannel(), source = frame.current?.contentWindow;
            const receive = (message: MessageEvent) => onMessage({ data: message.data, isTrusted: message.isTrusted, source, compositionAuthenticated: true });
            channel.port1.addEventListener("message", receive); channel.port1.start();
            compositionControl.current = { sessionId: document.current.sessionId, close() { channel.port1.removeEventListener("message", receive); channel.port1.close(); channel.port2.close(); } };
            source?.postMessage({ channel: FRAME_CHANNEL, type: "composition-control-connect", boardId: document.current.boardId, sessionId: document.current.sessionId }, "*", [channel.port2]);
          }
          ready.current = true;
          transport.current = { sessionId: document.current.sessionId, capable: message.capabilities?.frameDelta === 1,
            version: transport.current?.sessionId === document.current.sessionId ? transport.current.version : 0,
            snapshot: transportSnapshot({ canvas: current.canvas, boardRevision: current.boardRevision, userState: effectiveState(), theme: current.theme }) };
          sync(); current.onReady?.();
          if (viewRestore.current && !viewRestore.current.settled) {
            const request = viewRestore.current;
            if (request.resume && message.capabilities?.viewState === 1 && document.current.version === current.canvas.documentVersion) {
              send({ type: "restore-view", requestId: request.requestId, view: request.resume });
            } else { request.settled = true; current.onViewRestored?.({ status: "unavailable" }); }
          }
          observeCurrentView();
          if (viewDelivery.current) viewDelivery.current.portCapable = message.capabilities?.viewPort === 1;
          connectViewPort();
          break;
        case "view-state": {
          const target = viewDelivery.current;
          if (target && !target.reader && capturedBeforeRetirement(target, message.capturedAt)) acceptView(target, message.view);
          break;
        }
        case "view-restored": {
          const request = viewRestore.current;
          if (!request || request.settled || request.sessionId !== document.current.sessionId || request.requestId !== message.requestId
            || request.version !== message.documentVersion || current.canvas.documentVersion !== request.version) break;
          request.settled = true; current.onViewRestored?.({ status: message.status });
          observeCurrentView();
          // Window and MessagePort events need not be ordered with one another.
          // Install the position port only after this restore receipt is accepted;
          // the runtime then forces a fresh capture on that authenticated channel.
          connectViewPort();
          break;
        }
        case "snapshot-request":
          if (ready.current && transport.current?.capable && message.documentVersion === document.current.version) syncSnapshot(true);
          break;
        case "canvas-pointer": if (userActing()) current.onCanvasPointer?.(); break;
        case "canvas-activity":
          canvasInteracting.current = message.interacting === true;
          current.onCanvasActivity?.(message.busy, message.interacting);
          // A pending preset rebuild waits for the canvas to go idle.
          if (!canvasInteracting.current && glassUsageRef.current?.preset && !document.current.preset && presetRebuilt.current !== `${current.boardId}:${current.canvas.documentVersion}`) redraw(n => n + 1);
          break;
        case "preset-key-ack": {
          const sessionId = document.current.sessionId, handoff = presetHandoff.current;
          if (presetMuted.current === sessionId) presetMuted.current = undefined;
          if (handoff?.sessionId === sessionId) {
            if (message.opened) { clearTimeout(handoff.timer); handoff.timer = undefined; } else restorePresetFocus();
            break;
          }
          if (!message.opened) break;
          // A late reply: the fallback already gave focus back. If the user has not focused
          // anything else in Paseo since, the palette keeps focus; otherwise it closes and focus
          // returns to what the user chose.
          const expired = presetExpired.current, page = browser.document, target = frame.current;
          presetExpired.current = undefined;
          if (expired?.sessionId === sessionId && Date.now() - expired.at < 5000 && page && target?.focus && !expired.movedTo) {
            if (page.activeElement !== target) target.focus({ preventScroll: true });
            presetHandoff.current = { sessionId, element: expired.element };
            break;
          }
          send({ type: "preset-close" });
          const moved = expired?.movedTo as Focusable | undefined;
          if (moved?.focus && moved.isConnected !== false && page?.activeElement === target) moved.focus({ preventScroll: true });
          break;
        }
        case "preset-focus-return":
          if (presetHandoff.current?.sessionId === document.current.sessionId) restorePresetFocus();
          break;
        case "preset-handoff-end":
          // A result was chosen (focus stays at its target) or focus already left the canvas.
          if (presetHandoff.current?.sessionId === document.current.sessionId) dropPresetHandoff();
          break;
        case "update-position": {
          const expected = updatePending.current;
          const requested = current.focusUpdate;
          if (!expected || !requested || requested.token !== expected.token || requested.update.id !== expected.id || current.composerActive || message.requestId !== expected.requestId || message.id !== expected.id || message.token !== expected.token || message.targetIndex !== expected.targetIndex || message.documentVersion !== expected.documentVersion || message.status === "focused" && current.canvas.documentVersion !== expected.documentVersion) break;
          updatePending.current = undefined;
          current.onUpdatePosition?.(message);
          break;
        }
        case "error": current.onError(message.error); break;
        case "selection-end": current.onSelectionEnd?.(); break;
        case "selection-clear": current.onSelectionClear?.(); break;
        case "selection-lock": {
          if (message.active) {
            const leaseKey = document.current.sessionId + ":" + message.id;
            if (cancelledSelections.has(leaseKey)) break;
            // A long drag can outlive transient activation. Updating its existing lease is
            // allowed; acquiring a new lease still requires a real current user gesture.
            if (interactionLock.current?.id !== message.id && !userActing()) break;
            interactionLock.current = { ...(interactionLock.current?.id === message.id ? interactionLock.current : {}), boardId: current.boardId, sessionId: document.current.sessionId, id: message.id, dragging: message.dragging === true };
          } else {
            if (interactionLock.current?.id !== message.id) break;
            interactionLock.current = null;
          }
          redraw(n => n + 1);
          break;
        }
        case "component-edit": {
          const origin = document.current;
          const key = origin.sessionId + ":" + message.id;
          if (pendingEdits.has(key)) break;
          const answer = (result: ComponentEditResult) => {
            if (disposed || document.current?.sessionId !== origin.sessionId) return;
            send({ type: "component-edit-result", id: message.id, result });
          };
          // Arbitrary authored code shares the sandbox. A frame message may only stage
          // a proposal: the host's own Save control is the sole commit authority.
          if (!current.onComponentEdit || pendingEdits.size || message.request.canvasBase.documentVersion !== origin.version || message.request.canvasBase.revision !== current.canvas.revision) {
            answer({ status: "rejected", message: "当前编辑不可用或画布已更新，请重新选择组件。" }); break;
          }
          pendingEdits.add(key);
          Promise.resolve().then(() => current.onComponentEdit!(message.request)).catch(() => ({ status: "rejected", message: "无法准备这次修改，请重新选择组件。" } as ComponentEditResult))
            .then(result => { pendingEdits.delete(key); answer(result); });
          break;
        }
        case "anchor":
          // The picture can take seconds to encode; user activation may have expired, but a
          // local selection must still own its lease. Legacy anchors without a lease require
          // an explicit host selection mode; cancelling a lease rejects late captures at once.
          if ((message.selectionId !== undefined ? message.selectionId === interactionLock.current?.id : current.selectionMode !== "off") && message.anchor.boardRevision <= current.boardRevision && message.anchor.canvasRevision <= current.canvas.revision) {
            if (interactionLock.current?.anchor) break;
            if (interactionLock.current) interactionLock.current.anchor = message.anchor;
            current.onAnchor(message.anchor);
          }
          break;
        case "compose": {
          // A completed trusted selection opens one blank composer. A slow screenshot may
          // outlive transient activation, but it must retain the lease and exact frozen anchor.
          // This cannot send a message; the user still submits through the host input.
          const lock = interactionLock.current;
          const key = document.current.sessionId + ":" + message.selectionId;
          const automatic = message.automatic === true && browser.document?.activeElement === frame.current && lock?.dragging === false && lock.anchor && JSON.stringify(lock.anchor) === JSON.stringify(message.request.anchor);
          if ((userActing() || automatic) && message.selectionId === lock?.id && !composedSelections.has(key) && message.request.anchor.boardRevision <= current.boardRevision && message.request.anchor.canvasRevision <= current.canvas.revision) {
            composedSelections.add(key);
            lock.capturePending = message.request.captureStatus === "pending";
            current.onCompose?.({ ...message.request, selectionId: message.selectionId });
          }
          break;
        }
        case "selection-capture": {
          const lock = interactionLock.current;
          const key = document.current.sessionId + ":" + message.selectionId;
          if (lock?.id !== message.selectionId || !lock.capturePending || !lock.anchor || !composedSelections.has(key) || !sameSelectionAnchor(lock.anchor, message.anchor)) break;
          lock.capturePending = false;
          current.onSelectionCapture?.(message);
          break;
        }
        case "open-interaction":
          if (userActing() && interactionMarkers(current.interactions || []).some(item => item.id === message.id)) current.onOpenInteraction?.(message.id, message.position, message.location);
          break;
        case "interaction-position":
          if (message.id === current.selectedInteractionId && interactionMarkers(current.interactions || []).some(item => item.id === message.id)) current.onInteractionPosition?.(message.id, message.position, message.location);
          break;
        case "state":
          localState.current = { boardId: current.boardId, state: message.state, dirty: true };
          // The caller owns debounce/durability. Deliver before it can switch boards and dispose
          // its writer; a second debounce here could strand a save under the next board's props.
          current.onState(message.state);
          break;
        case "open-link":
          if (userActing() && Date.now() - lastLink > 1000) { lastLink = Date.now(); current.onOpenLink?.(message.url); }
          break;
        case "ask": {
          const origin = document.current;
          const key = origin.sessionId + ":" + message.id;
          if (waiting.has(key)) break;
          const answer = (result: AskResult) => {
            if (disposed || document.current?.sessionId !== origin.sessionId) return;
            send({ type: "ask-result", id: message.id, result });
          };
          if (waiting.size >= 8 || !userActing() || current.selectionMode !== "off") { answer({ status: "cancelled", outcome: null }); break; }
          waiting.add(key);
          Promise.resolve().then(() => current.onAsk(message.request)).catch((e) => {
            current.onError({ code: "ask-failed", message: e instanceof Error ? e.message : String(e) });
            return { status: "cancelled", outcome: null } as const;
          }).then((result) => { waiting.delete(key); answer(result); });
          break;
        }
      }
    };
    const onOuterRelease = (event: OuterPointerEvent) => {
      if (!event.isTrusted || !interactionLock.current?.dragging) return;
      // Pointer capture inside an iframe does not reliably receive releases over the parent.
      // Frame events never bubble here: a release here cancels an unfinished local gesture.
      // Completed anchors remain usable by host toolbar buttons. Invalidate the lease before
      // the async clear so late screenshots are rejected.
      const cancelled = interactionLock.current;
      cancelledSelections.add(cancelled.sessionId + ":" + cancelled.id);
      interactionLock.current = null;
      send({ type: "clear-selection" });
      latest.current.onSelectionClear?.();
      latest.current.onSelectionEnd?.();
      redraw(n => n + 1);
    };
    const onOuterStart = (event: OuterPointerEvent) => {
      // Flush before the following click can switch an agent and remove this frame.
      if (event.isTrusted && ready.current) { observeCurrentView(); send({ type: "flush-view" }); }
    };
    embeddedReceive.current = onMessage;
    browser.window.addEventListener("message", onMessage);
    browser.window.addEventListener("pointerdown", onOuterStart, true);
    browser.window.addEventListener("pointerup", onOuterRelease, true);
    browser.window.addEventListener("pointercancel", onOuterRelease, true);
    return () => {
      // Best effort: the runtime also flushes synchronously on blur/pagehide before removal.
      if (ready.current) send({ type: "flush-view" });
      disposed = true;
      embeddedReceive.current = undefined;
      compositionController.current?.controller.dispose(); compositionController.current = undefined;
      compositionControl.current?.close(); compositionControl.current = undefined;
      latest.current.onEditScopeChange?.();
      browser.window?.removeEventListener("message", onMessage);
      browser.window?.removeEventListener("pointerdown", onOuterStart, true);
      browser.window?.removeEventListener("pointerup", onOuterRelease, true);
      browser.window?.removeEventListener("pointercancel", onOuterRelease, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!props.embeddedMount || !canRenderFrames) return;
    const mount = props.embeddedMount;
    try {
      const connection = mount.attach({
        scope: { channel: FRAME_CHANNEL, boardId: rendered.boardId, sessionId: rendered.sessionId },
        document: secret => buildBoardDocument({ ...latest.current, sessionId: rendered.sessionId, compositionSecret: secret }),
        receive: event => embeddedReceive.current?.(event),
        beforeDispose: () => { delivery.retiredAt ??= performance.timeOrigin + performance.now(); },
      });
      embeddedConnection.current = connection;
      frame.current = { contentWindow: connection.contentWindow, isConnected: true, getBoundingClientRect: () => mount.getSnapshot().rect };
      return () => { connection.dispose(); if (embeddedConnection.current === connection) { embeddedConnection.current = undefined; frame.current = null; } };
    } catch (error) {
      latest.current.onError({ code: "composition-mount-failed", message: error instanceof Error ? error.message : String(error) });
    }
  }, [props.embeddedMount, rendered.sessionId]);

  useLayoutEffect(() => {
    if (!canRenderFrames || !browser.window || !delivery.scope) return;
    const lease = acquireViewLease(delivery.scope);
    delivery.frame = frame.current;
    delivery.window = frame.current?.contentWindow ?? null;
    observeViewVisibility(delivery);
    return () => {
      if (!lease.current()) { delivery.reader?.close(); return; }
      // React may already have cleared the ref or detached the element. Only a
      // recent pre-removal observation may substitute for its now-empty bounds.
      const recentlyVisible = delivery.frame?.isConnected === false
        ? delivery.visibleAt !== null && performance.now() - delivery.visibleAt <= VIEW_HANDOFF_MS
        : observeViewVisibility(delivery);
      const reader = delivery.reader, sink = delivery.sink;
      if (!recentlyVisible || browser.document?.hidden || !delivery.settled || !reader || !sink) { reader?.close(); lease.revoke(); return; }
      const scope = { boardId: delivery.boardId, sessionId: delivery.sessionId };
      const version = delivery.version, canvasRevision = delivery.canvasRevision;
      const deadline = performance.now() + VIEW_HANDOFF_MS;
      reader.receive = (event: MessageEvent) => {
        // The deadline is checked here too: a suspended event loop may delay timers.
        if (!lease.current() || performance.now() >= deadline) { lease.revoke(); return; }
        if (!event.isTrusted) return;
        if (!event.data || typeof event.data !== "object" || (event.data as { type?: unknown }).type !== "view-state") return;
        const message = readFrameMessage(event.data, scope);
        if (message?.type !== "view-state" || message.view.documentVersion !== version || message.view.canvasRevision !== canvasRevision || !capturedBeforeRetirement(delivery, message.capturedAt)) return;
        sink(message.view);
      };
      const timer = setTimeout(() => lease.revoke(), VIEW_HANDOFF_MS);
      lease.retire(() => { clearTimeout(timer); reader.close(); });
    };
  }, [rendered.sessionId, props.viewScope]);

  // "/" forwarding to a liquid-glass palette while this Board (not a text field) has host focus.
  const forwardsPresetKeys = Boolean(props.presetKeys) && !props.embeddedMount;
  useEffect(() => {
    if (!forwardsPresetKeys || !canRenderFrames || !browser.window) return;
    const onKey = (event: HostKeyEvent) => {
      const current = latest.current, page = browser.document, target = frame.current, built = document.current;
      // The document carries the preset, the live source still uses it (not handed over to an
      // old kit) with a palette, and this session has not stopped answering.
      if (!current.presetKeys || !page || !target || !built?.preset || !glassUsageRef.current?.preset || !glassUsageRef.current.palette || presetMuted.current === built.sessionId) return;
      if (!ready.current || current.selectionMode !== "off" || current.composerActive || interactionLock.current) return;
      if (!presetKeyIntent(event, page) || !presetFocusAllowed(page.activeElement, target, current.presetKeys.fromBody, page)) return;
      const bounds = target.getBoundingClientRect?.();
      if (!bounds || bounds.width < 1 || bounds.height < 1 || typeof target.focus !== "function") return;
      event.preventDefault();
      if (presetHandoff.current) clearTimeout(presetHandoff.current.timer);
      // Without a reply within 250 ms (no palette, kit gone, error) Paseo gets focus back.
      presetHandoff.current = { sessionId: built.sessionId, element: page.activeElement, timer: setTimeout(expirePresetHandoff, 250) };
      target.focus({ preventScroll: true });
      send({ type: "preset-key", key: "/" });
    };
    // After a fallback, note where the user moves focus in Paseo (a late reply must not keep it).
    const onFocusIn = (event: { target?: unknown }) => {
      const expired = presetExpired.current;
      if (expired && event.target !== frame.current && event.target !== expired.element) expired.movedTo = event.target;
    };
    browser.window.addEventListener("keydown", onKey);
    browser.document?.addEventListener("focusin", onFocusIn as () => void);
    return () => { browser.window?.removeEventListener("keydown", onKey); browser.document?.removeEventListener("focusin", onFocusIn as () => void); };
  }, [forwardsPresetKeys]);
  // A replaced session (or unmount) cannot answer: hand focus back now.
  useEffect(() => () => restorePresetFocus(), [rendered.sessionId]);

  const editScope = useRef(rendered.sessionId);
  useEffect(() => {
    if (editScope.current !== rendered.sessionId) { editScope.current = rendered.sessionId; latest.current.onEditScopeChange?.(); }
  }, [rendered.sessionId]);

  useEffect(() => {
    if (!ready.current) return;
    syncSnapshot();
  }, [props.canvas, props.boardRevision, props.userState, props.theme]);
  useEffect(() => {
    if (ready.current) send({ type: "interactions", markers: interactionMarkers(props.interactions || []), selectedId: props.selectedInteractionId });
  }, [props.interactions, props.selectedInteractionId]);
  useEffect(() => { focusRequestedInteraction(); }, [props.focusInteraction, props.selectedInteractionId, props.interactions]);
  useEffect(() => {
    if (ready.current) send({ type: "host-activity", composing: Boolean(props.composerActive) });
    focusRequestedUpdate();
  }, [props.focusUpdate, props.composerActive, props.selectionMode]);
  useEffect(() => {
    if (ready.current) send({ type: "selection", mode: props.selectionMode });
  }, [props.selectionMode]);
  const cleared = useRef(props.selectionClearToken);
  useEffect(() => {
    if (cleared.current === props.selectionClearToken) return;
    cleared.current = props.selectionClearToken;
    interactionLock.current = null;
    send({ type: "clear-selection" });
    redraw(n => n + 1);
  }, [props.selectionClearToken]);
  useEffect(() => {
    const selectionId = props.selectionCaptureCancelId;
    if (!selectionId || selectionId !== interactionLock.current?.id) return;
    interactionLock.current = null;
    send({ type: "cancel-capture", selectionId });
    redraw(n => n + 1);
  }, [props.selectionCaptureCancelId]);
  if (!canRenderFrames || props.embeddedMount) return null;
  return createElement("iframe", {
    // A replacement document owns a new browsing context and bridge session.
    // Ordinary data, patch and theme updates retain this exact key and heap.
    key: rendered.sessionId, ref: frame, title: props.title, srcDoc: rendered.html,
    // Never allow-same-origin, popups or top navigation. The opaque frame cannot touch the app.
    sandbox: "allow-scripts", allow: "clipboard-write; fullscreen", referrerPolicy: "no-referrer",
    "data-testid": "paseo-board-canvas", "data-board-id": props.boardId,
    style: { display: "block", width: "100%", height: props.height, border: 0, background: "transparent", colorScheme: props.theme.scheme },
  });
}

export interface WebMessageInputProps {
  value: string;
  onChange(value: string): void;
  onStage(): void;
  onSubmit(destination: "main" | "side" | "new-side"): void;
  onClose(): void;
  disabled?: boolean;
  placeholder?: string;
  style?: Record<string, unknown>;
  focusToken?: number;
}

/** Host clicks outside the floating conversation dismiss it; iframe clicks arrive via the bridge. */
export function usePopoverDismiss(active: boolean, onDismiss: () => void, preserveInput = false): void {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  useEffect(() => {
    if (!active || !canRenderFrames || !browser.window) return;
    const dismiss = (event: OuterPointerEvent) => {
      if (!event.isTrusted) return;
      if (event.target?.closest?.('[data-testid="board-discussion-rail"], [data-testid="board-update-navigation"]')) {
        // A disabled navigation row must not blur an unsent draft: Enter/Escape should
        // still address that input after an incidental rail click.
        if (preserveInput) event.preventDefault();
        return;
      }
      if (!event.target?.closest?.('[data-testid="board-local-popover"], [data-testid="board-offline-draft"]')) latest.current();
    };
    browser.window.addEventListener("pointerdown", dismiss, true);
    return () => browser.window?.removeEventListener("pointerdown", dismiss, true);
  }, [active, preserveInput]);
}

/** Native DOM composition events preserve IME confirmation; RNW onKeyPress drops that detail. */
export function WebMessageInput(props: WebMessageInputProps): ReactElement | null {
  const input = useRef<{ focus(): void } | null>(null);
  const composing = useRef(false);
  const compositionEnded = useRef(0);
  useEffect(() => { if (!props.disabled) input.current?.focus(); }, [props.focusToken]);
  if (!canRenderFrames) return null;
  return createElement("textarea", {
    ref: input, value: props.value, autoFocus: true, disabled: props.disabled, placeholder: props.placeholder, maxLength: 24000,
    "aria-label": "发给 agent 的消息", "data-testid": "board-message-input",
    onChange: (event: { target: { value: string } }) => props.onChange(event.target.value),
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; compositionEnded.current = Date.now(); },
    onKeyDown: (event: { key: string; keyCode: number; repeat?: boolean; nativeEvent?: { isComposing?: boolean; keyCode?: number }; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; preventDefault(): void; stopPropagation(): void }) => {
      if (composing.current || event.nativeEvent?.isComposing || event.keyCode === 229 || event.nativeEvent?.keyCode === 229 || Date.now() - compositionEnded.current < 50) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
      else {
        const action = messageShortcut(event);
        if (!action) return;
        event.preventDefault(); event.stopPropagation();
        if (!props.disabled && !event.repeat) {
          if (action === "stage") props.onStage();
          else props.onSubmit(action);
        }
      }
    },
    style: { boxSizing: "border-box", width: "100%", minHeight: 88, maxHeight: 220, resize: "vertical", font: "inherit", lineHeight: 1.5, padding: 10, borderRadius: 8, ...props.style },
  });
}
