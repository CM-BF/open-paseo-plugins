// Browser DOM access lives only in this module. Native callers use their compatibility view.
import { createElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { Platform } from "react-native";
import type { Anchor, Canvas, Interaction, JsonData } from "../shared/contracts";
import { buildBoardDocument } from "../shared/document";
import { FRAME_CHANNEL, interactionMarkers, readFrameMessage, type AskRequest, type AskResult, type ComposeRequest, type FrameError, type FramePosition, type FrameSnapshot, type FrameTheme, type InteractionLocation, type SelectionMode } from "../shared/frame-contract";

type FrameWindow = { postMessage(message: unknown, origin: string): void };
type Frame = { contentWindow: FrameWindow | null };
type MessageEvent = { source: unknown; data: unknown };
type OuterPointerEvent = { isTrusted: boolean; target?: { closest?(selector: string): unknown }; preventDefault(): void };
type BrowserWindow = {
  addEventListener(name: "message", fn: (event: MessageEvent) => void): void;
  removeEventListener(name: "message", fn: (event: MessageEvent) => void): void;
  addEventListener(name: "pointerdown" | "pointerup" | "pointercancel", fn: (event: OuterPointerEvent) => void, capture: boolean): void;
  removeEventListener(name: "pointerdown" | "pointerup" | "pointercancel", fn: (event: OuterPointerEvent) => void, capture: boolean): void;
};
const browser = globalThis as unknown as {
  window?: BrowserWindow;
  document?: { activeElement: unknown };
  navigator?: { userActivation?: { isActive: boolean } };
  crypto?: { getRandomValues(bytes: Uint8Array): Uint8Array };
};
export const canRenderFrames = Platform.OS === "web" && Boolean(browser.window && browser.document);
export interface CanvasFrameProps extends FrameSnapshot {
  boardId: string;
  title: string;
  canvas: Canvas;
  boardRevision: number;
  userState: JsonData;
  theme: FrameTheme;
  height: number;
  selectionMode: SelectionMode;
  selectionClearToken?: number;
  interactions?: Interaction[];
  selectedInteractionId?: string;
  focusInteraction?: { id: string; token: number };
  onAnchor(anchor: Anchor): void;
  onAsk(request: AskRequest): Promise<AskResult>;
  onCompose?(request: ComposeRequest): void;
  onCanvasPointer?(): void;
  onOpenInteraction?(id: string, position: FramePosition, location?: InteractionLocation): void;
  onInteractionPosition?(id: string, position: FramePosition, location?: InteractionLocation): void;
  onState(state: JsonData): void;
  onError(error: FrameError): void;
  onOpenLink?(url: string): void;
  onReady?(): void;
  onSelectionEnd?(): void;
  onSelectionClear?(): void;
}

function nonce(): string {
  const bytes = new Uint8Array(16);
  if (browser.crypto) browser.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function documentFor(props: CanvasFrameProps) {
  const sessionId = nonce();
  return { boardId: props.boardId, version: props.canvas.documentVersion, sessionId, html: buildBoardDocument({ ...props, sessionId }) };
}

/** Retains the iframe and its JS heap across data, patch, theme and UI-state updates. */
export function CanvasFrame(props: CanvasFrameProps): ReactElement | null {
  const frame = useRef<Frame | null>(null);
  const latest = useRef(props);
  latest.current = props;
  // Keep a save received from the live document across a document replacement even while its
  // debounced server write is still in flight. Only an actual matching prop snapshot is an ack.
  const localState = useRef<{ boardId: string; state: JsonData; dirty: boolean } | null>(null);
  if (localState.current?.boardId === props.boardId && JSON.stringify(localState.current.state) === JSON.stringify(props.userState)) localState.current.dirty = false;
  const effectiveState = () => localState.current?.boardId === latest.current.boardId && localState.current.dirty ? localState.current.state : latest.current.userState;
  const document = useRef<ReturnType<typeof documentFor> | null>(null);
  const interactionLock = useRef<{ boardId: string; sessionId: string; id: string; dragging: boolean; anchor?: Anchor } | null>(null);
  const [, redraw] = useState(0);
  if (interactionLock.current?.boardId !== props.boardId) interactionLock.current = null;
  const ready = useRef(false);
  const focused = useRef<string | undefined>(undefined);
  if (!document.current || document.current.boardId !== props.boardId || (document.current.version !== props.canvas.documentVersion && props.selectionMode === "off" && !interactionLock.current)) {
    document.current = documentFor({ ...props, userState: effectiveState() });
    ready.current = false;
  }
  const rendered = document.current;
  const send = (payload: Record<string, unknown>) => {
    const current = document.current!;
    frame.current?.contentWindow?.postMessage({ ...payload, channel: FRAME_CHANNEL, boardId: current.boardId, sessionId: current.sessionId }, "*");
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
  useLayoutEffect(() => {
    if (!canRenderFrames || !browser.window) return;
    const waiting = new Set<string>();
    const cancelledSelections = new Set<string>();
    const composedSelections = new Set<string>();
    let disposed = false;
    let lastLink = 0;
    const sync = () => {
      const current = latest.current;
      send({ type: "selection", mode: current.selectionMode });
      send({ type: "snapshot", snapshot: { canvas: current.canvas, boardRevision: current.boardRevision, userState: effectiveState(), theme: current.theme } });
      send({ type: "interactions", markers: interactionMarkers(current.interactions || []), selectedId: current.selectedInteractionId });
      focusRequestedInteraction();
    };
    const userActing = () => browser.document?.activeElement === frame.current && browser.navigator?.userActivation?.isActive === true;
    const onMessage = (event: MessageEvent) => {
      if (disposed || event.source !== frame.current?.contentWindow || !document.current) return;
      const message = readFrameMessage(event.data, document.current);
      if (!message) return;
      const current = latest.current;
      switch (message.type) {
        case "ready": ready.current = true; sync(); current.onReady?.(); break;
        case "canvas-pointer": if (userActing()) current.onCanvasPointer?.(); break;
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
            interactionLock.current = { boardId: current.boardId, sessionId: document.current.sessionId, id: message.id, dragging: message.dragging === true };
          } else {
            if (interactionLock.current?.id !== message.id) break;
            interactionLock.current = null;
          }
          redraw(n => n + 1);
          break;
        }
        case "anchor":
          // The picture can take seconds to encode; user activation may have expired, but a
          // local selection must still own its lease. Legacy anchors without a lease require
          // an explicit host selection mode; cancelling a lease rejects late captures at once.
          if ((message.selectionId !== undefined ? message.selectionId === interactionLock.current?.id : current.selectionMode !== "off") && message.anchor.boardRevision <= current.boardRevision && message.anchor.canvasRevision <= current.canvas.revision) {
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
            current.onCompose?.(message.request);
          }
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
    browser.window.addEventListener("message", onMessage);
    browser.window.addEventListener("pointerup", onOuterRelease, true);
    browser.window.addEventListener("pointercancel", onOuterRelease, true);
    return () => {
      disposed = true;
      browser.window?.removeEventListener("message", onMessage);
      browser.window?.removeEventListener("pointerup", onOuterRelease, true);
      browser.window?.removeEventListener("pointercancel", onOuterRelease, true);
    };
  }, []);

  useEffect(() => {
    if (!ready.current) return;
    send({ type: "snapshot", snapshot: { canvas: props.canvas, boardRevision: props.boardRevision, userState: effectiveState(), theme: props.theme } });
  }, [props.canvas, props.boardRevision, props.userState, props.theme]);
  useEffect(() => {
    if (ready.current) send({ type: "interactions", markers: interactionMarkers(props.interactions || []), selectedId: props.selectedInteractionId });
  }, [props.interactions, props.selectedInteractionId]);
  useEffect(() => { focusRequestedInteraction(); }, [props.focusInteraction, props.selectedInteractionId, props.interactions]);
  useEffect(() => {
    if (ready.current) send({ type: "selection", mode: props.selectionMode });
  }, [props.selectionMode]);
  const cleared = useRef(props.selectionClearToken);
  useEffect(() => {
    if (cleared.current === props.selectionClearToken) return;
    cleared.current = props.selectionClearToken;
    send({ type: "clear-selection" });
  }, [props.selectionClearToken]);
  if (!canRenderFrames) return null;
  return createElement("iframe", {
    ref: frame, title: props.title, srcDoc: rendered.html,
    // Never allow-same-origin, popups or top navigation. The opaque frame cannot touch the app.
    sandbox: "allow-scripts", allow: "clipboard-write; fullscreen", referrerPolicy: "no-referrer",
    "data-testid": "paseo-board-canvas", "data-board-id": props.boardId,
    style: { display: "block", width: "100%", height: props.height, border: 0, background: "transparent", colorScheme: props.theme.scheme },
  });
}

export interface WebMessageInputProps {
  value: string;
  onChange(value: string): void;
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
      if (event.target?.closest?.('[data-testid="board-discussion-rail"]')) {
        // A disabled navigation row must not blur an unsent draft: Enter/Escape should
        // still address that input after an incidental rail click.
        if (preserveInput) event.preventDefault();
        return;
      }
      if (!event.target?.closest?.('[data-testid="board-local-popover"]')) latest.current();
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
    onKeyDown: (event: { key: string; keyCode: number; nativeEvent?: { isComposing?: boolean; keyCode?: number }; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; preventDefault(): void; stopPropagation(): void }) => {
      if (composing.current || event.nativeEvent?.isComposing || event.keyCode === 229 || event.nativeEvent?.keyCode === 229 || Date.now() - compositionEnded.current < 50) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
      else if (event.key === "Enter" && !event.shiftKey) {
        const side = event.ctrlKey || event.metaKey;
        if (event.altKey && !side) return;
        event.preventDefault(); event.stopPropagation();
        if (!props.disabled) props.onSubmit(side ? event.altKey ? "new-side" : "side" : "main");
      }
    },
    style: { boxSizing: "border-box", width: "100%", minHeight: 88, maxHeight: 220, resize: "vertical", font: "inherit", lineHeight: 1.5, padding: 10, borderRadius: 8, ...props.style },
  });
}
