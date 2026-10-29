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
  init: { botId: string; host: { id: string; label: string }; theme: "dark" | "light"; locale: string;
    view?: 'settings' | 'presets' | 'teammate-create' | 'group-create' | 'group'; packageId?: string; groupId?: string };
  invoke(op: string, args: Record<string, unknown>): Promise<unknown>;
  onClose(): void;
  onChanged(): void;
  onNavigateAgent(agentId: string): void;
  onNavigateGroup?(groupId: string): void;
  onOpenWorkFile?(input: { workspaceId: string; path: string; serverId: string }): void | Promise<void>;
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
      else if (message.type === "changed" || message.type === "profile-changed" || message.type === "groups-changed") latest.current.onChanged();
      else if (message.type === "navigate-agent") latest.current.onNavigateAgent(message.agentId);
      else if (message.type === "navigate-group") latest.current.onNavigateGroup?.(message.groupId);
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
        const openWorkFile = latest.current.onOpenWorkFile;
        const scope = latest.current.init;
        Promise.resolve().then(async () => {
          if (disposed) return;
          const args = (message.args ?? {}) as Record<string, unknown>;
          const artifactOp = message.op === 'paseo.openWorkArtifact' ? 'groups.plans.artifact'
            : message.op === 'paseo.openTaskArtifact' ? 'companion.tasks.artifact' : undefined;
          if (!artifactOp) return invoke(message.op, args);
          if (!openWorkFile) throw new Error('Update the Paseo app to open work files from this card.');
          if (scope.view !== 'group' || !scope.groupId || args.groupId !== scope.groupId) throw new Error('The work file belongs to another group.');
          const result = await invoke(artifactOp, args) as { ok?: boolean; value?: { workspaceId?: unknown; path?: unknown }; message?: string };
          if (disposed) return;
          if (!result?.ok) return result;
          const { workspaceId, path } = result.value ?? {};
          if (typeof workspaceId !== 'string' || !workspaceId || typeof path !== 'string' || !path ||
            /[\\\u0000-\u001f]/.test(path) || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
            throw new Error('The host returned an invalid work file location.');
          }
          await openWorkFile({ workspaceId, path, serverId: scope.host.id });
          return { ok: true, value: null };
        })
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
  }, [props.document, props.init.botId, props.init.host.id, props.init.view, props.init.groupId]);
  if (!canRenderSettingsFrame) return null;
  return createElement("iframe", {
    key: `${props.init.host.id}:${props.init.botId}:${props.init.view ?? 'settings'}:${props.init.groupId ?? ''}`,
    ref: frame,
    title: props.init.view === 'teammate-create' ? 'Create Cindy teammate' : props.init.view === 'group' ? 'Cindy group chat' : props.init.view === 'presets' ? 'Cindy preset teammates' : props.init.view === 'group-create' ? 'Create Cindy group chat' : 'Cindy teammate settings',
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
