// Browser-only primitives. The rest of the host contribution uses React Native.
import { createElement, useLayoutEffect, useRef, type ReactElement, type ReactNode } from "react";
import { Platform } from "react-native";
import { FRAME_CHANNEL, readFrameEvent } from "./frame-protocol";

type FrameWindow = { postMessage(data: unknown, origin: string): void };
type FrameElement = { contentWindow: FrameWindow | null };
type MessageEvent = { source: unknown; data: unknown };
type KeyEvent = { key: string; shiftKey?: boolean; preventDefault(): void };
type BrowserWindow = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
};
const browser = globalThis as unknown as { window?: BrowserWindow };
export const canRenderSettingsFrame = Platform.OS === "web" && Boolean(browser.window);

export interface SettingsFrameHandle { requestClose(): void }
export interface SettingsFrameProps {
  document: string;
  init: { botId: string; host: { id: string; label: string }; theme: "dark" | "light"; locale: string };
  invoke(op: string, args: Record<string, unknown>): Promise<unknown>;
  onClose(): void;
  onChanged(): void;
  onNavigateAgent(agentId: string): void;
  onHandle(handle: SettingsFrameHandle | null): void;
  onReady(): void;
}

/** Source-checked bridge; the frame never receives daemon credentials or an HTTP endpoint. */
export function SettingsFrame(props: SettingsFrameProps): ReactElement | null {
  const frame = useRef<FrameElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  useLayoutEffect(() => {
    if (!canRenderSettingsFrame || !browser.window) return;
    const owner = browser.window;
    let disposed = false;
    let ready = false;
    let inFlight = 0;
    const seen = new Set<string>();
    const post = (value: Record<string, unknown>) => {
      if (!disposed) frame.current?.contentWindow?.postMessage({ channel: FRAME_CHANNEL, ...value }, "*");
    };
    const requestClose = () => {
      if (ready) post({ type: "request-close" });
      else latest.current.onClose();
    };
    const receive = (event: MessageEvent) => {
      if (disposed || !frame.current?.contentWindow || event.source !== frame.current.contentWindow) return;
      const message = readFrameEvent(event.data);
      if (!message) return;
      if (message.type === "ready") {
        ready = true;
        post({ type: "init", ...latest.current.init });
        latest.current.onReady();
      } else if (message.type === "close") latest.current.onClose();
      else if (message.type === "changed" || message.type === "profile-changed") latest.current.onChanged();
      else if (message.type === "navigate-agent") latest.current.onNavigateAgent(message.agentId);
      else if (message.type === "request") {
        if (seen.has(message.id) || seen.size >= 10000 || inFlight >= 16) {
          post({ type: "response", id: message.id, error: "Duplicate or excessive settings request" });
          return;
        }
        if (message.args !== undefined && (!message.args || typeof message.args !== "object" || Array.isArray(message.args))) {
          post({ type: "response", id: message.id, error: "Settings arguments must be an object" });
          return;
        }
        seen.add(message.id);
        inFlight++;
        const invoke = latest.current.invoke;
        Promise.resolve().then(() => disposed ? undefined : invoke(message.op, (message.args ?? {}) as Record<string, unknown>))
          .then(result => post({ type: "response", id: message.id, result }),
            error => post({ type: "response", id: message.id, error: error instanceof Error ? error.message : "Settings request failed" }))
          .finally(() => { inFlight--; });
      }
    };
    const keydown = (event: KeyEvent) => {
      if (event.key === "Escape") { event.preventDefault(); requestClose(); }
    };
    owner.addEventListener("message", receive);
    owner.addEventListener("keydown", keydown);
    latest.current.onHandle({ requestClose });
    return () => {
      disposed = true;
      owner.removeEventListener("message", receive);
      owner.removeEventListener("keydown", keydown);
      latest.current.onHandle(null);
    };
  }, [props.document, props.init.botId, props.init.host.id]);
  if (!canRenderSettingsFrame) return null;
  return createElement("iframe", {
    key: `${props.init.host.id}:${props.init.botId}`,
    ref: frame,
    title: "Cindy teammate settings",
    srcDoc: props.document,
    sandbox: "allow-scripts",
    referrerPolicy: "no-referrer",
    style: { width: "100%", height: "100%", display: "block", border: 0, colorScheme: props.init.theme },
  });
}

export function SettingsBackdrop({ onPress }: { onPress(): void }): ReactElement | null {
  if (!canRenderSettingsFrame) return null;
  return createElement("button", {
    type: "button",
    "aria-label": "Close teammate settings",
    onClick: onPress,
    style: {
      position: "absolute", inset: 0, border: 0, padding: 0,
      background: "rgba(0,0,0,.8)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
    },
  });
}

export function AvatarContext({ children, onOpen }: { children: ReactNode; onOpen(): void }): ReactElement | null {
  if (!canRenderSettingsFrame) return null;
  return createElement("div", {
    onContextMenu: (event: { preventDefault(): void }) => { event.preventDefault(); onOpen(); },
    onKeyDown: (event: KeyEvent) => {
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); onOpen(); }
    },
    style: { display: "flex", flexShrink: 0 },
  }, children);
}
