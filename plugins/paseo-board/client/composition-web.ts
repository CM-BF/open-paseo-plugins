import type { FrameCompositionSlot, FrameScope } from "../shared/frame-contract";
import type { CompositionAttachment, CompositionFrameWindow, CompositionMessageEvent, CompositionMount, CompositionPort, CompositionSlot } from "./composition-mount";

type ChildWindow = CompositionFrameWindow & { location: string; parent: CompositionFrameWindow };
type NativeMessage = CompositionMessageEvent & { ports?: CompositionPort[] };
const browser = globalThis as unknown as {
  window?: { addEventListener(type: "message", fn: (event: NativeMessage) => void): void; removeEventListener(type: "message", fn: (event: NativeMessage) => void): void };
  crypto: { getRandomValues(value: Uint8Array): Uint8Array };
  Blob: new (parts: string[], options: { type: string }) => unknown;
  URL: { createObjectURL(value: unknown): string; revokeObjectURL(value: string): void };
  MessageChannel: new () => { port1: CompositionPort; port2: CompositionPort };
};
function secret() { return Array.from(browser.crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join(""); }

export interface CompositionController {
  update(slots: FrameCompositionSlot[]): void;
  open(id: string): void;
  drafts(id: string): void;
  dispose(): void;
}
/** All methods stay in the trusted plugin realm. Only status text crosses to the parent. */
export function createCompositionController(input: {
  scope: FrameScope;
  owner(): CompositionFrameWindow | null;
  send(message: Record<string, unknown>): void;
  changed(mounts: readonly CompositionMount[]): void;
}): CompositionController {
  const mounts = new Map<string, ReturnType<typeof makeMount>>();
  const windows = new Map<string, ChildWindow>();
  let descriptions: FrameCompositionSlot[] = [];
  let disposed = false;
  const discover = (event: NativeMessage) => {
    const data = event.data as { type?: unknown; boardId?: unknown; sessionId?: unknown; frameToken?: unknown } | null;
    if (disposed || !event.isTrusted || data?.type !== "composition-slot-ready" || data.boardId !== input.scope.boardId || data.sessionId !== input.scope.sessionId || typeof data.frameToken !== "string" || !descriptions.some(slot => slot.frameToken === data.frameToken) || windows.has(data.frameToken)) return;
    const child = event.source as ChildWindow | null;
    try { if (!child || child === input.owner() || child.parent !== input.owner()) return; } catch { return; }
    windows.set(data.frameToken, child);
    publish();
  };
  browser.window?.addEventListener("message", discover);
  function publish() {
    const ids = new Set(descriptions.map(slot => slot.id));
    for (const [id, item] of mounts) if (!ids.has(id)) { item.dispose(); mounts.delete(id); }
    for (const slot of descriptions) {
      const existing = mounts.get(slot.id);
      if (existing?.matches(slot)) existing.update(slot);
      else {
        existing?.dispose(); mounts.delete(slot.id);
        if (windows.has(slot.frameToken)) mounts.set(slot.id, makeMount(slot));
      }
    }
    input.changed(descriptions.flatMap(slot => { const item = mounts.get(slot.id); return item ? [item.mount] : []; }));
  }
  function makeMount(first: FrameCompositionSlot) {
    let current = first, publicSnapshot: CompositionSlot = first, attached: CompositionAttachment | undefined, onOpen: (() => void) | undefined, onDrafts: (() => void) | undefined;
    let refreshLayout: (() => void) | undefined;
    const listeners = new Set<() => void>();
    const mount: CompositionMount = {
      id: first.id,
      getSnapshot: () => publicSnapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      setStatus(text) { if (!disposed && mounts.get(first.id)?.mount === mount) input.send({ type: "composition-status", id: first.id, text: text.slice(0, 300) }); },
      setPresentation(value) {
        onOpen = value.onOpen;
        onDrafts = value.onDrafts;
        if (!disposed && mounts.get(first.id)?.mount === mount) input.send({ type: "composition-presentation", id: first.id, title: value.title.slice(0, 200), hostLabel: value.hostLabel.slice(0, 200), unread: Math.max(0, Math.min(9999, Math.floor(value.unread))), queued: Math.max(0, Math.min(9999, Math.floor(value.queued ?? 0))), canOpen: Boolean(onOpen), canDrafts: Boolean(onDrafts) });
      },
      attach(options) {
        if (disposed || mounts.get(first.id)?.mount !== mount) throw new Error("The embedded Board slot is no longer available");
        attached?.dispose();
        const child = windows.get(current.frameToken);
        if (!child) throw new Error("The embedded Board browsing context is unavailable");
        const token = secret();
        const html = options.document(token);
        const url = browser.URL.createObjectURL(new browser.Blob([html], { type: "text/html" }));
        const channel = new browser.MessageChannel();
        let closed = false, connected = false;
        const queue: Array<{ message: unknown; transfer?: CompositionPort[] }> = [];
        const receive = (event: NativeMessage) => {
          if (closed || !event.isTrusted) return;
          options.receive({ data: event.data, source: child, isTrusted: true, compositionAuthenticated: true });
        };
        const ready = (event: NativeMessage) => {
          const data = event.data as { type?: unknown; secret?: unknown; boardId?: unknown; sessionId?: unknown } | null;
          if (closed || connected || !event.isTrusted || event.source !== child || data?.type !== "composition-ready" || data.secret !== token || data.boardId !== options.scope.boardId || data.sessionId !== options.scope.sessionId) return;
          connected = true;
          browser.window?.removeEventListener("message", ready);
          channel.port1.addEventListener("message", receive); channel.port1.start();
          child.postMessage({ ...options.scope, type: "composition-connect", secret: token }, "*", [channel.port2]);
          for (const queued of queue.splice(0)) channel.port1.postMessage(queued.message, queued.transfer);
          mount.setStatus("");
        };
        browser.window?.addEventListener("message", ready);
        const connection: CompositionAttachment = {
          contentWindow: child,
          send(message, transfer) {
            if (closed) return;
            if (connected) channel.port1.postMessage(message, transfer);
            else if (queue.length < 128) queue.push({ message, transfer });
          },
          dispose() {
            if (closed) return; closed = true;
            options.beforeDispose?.();
            browser.window?.removeEventListener("message", ready);
            channel.port1.removeEventListener("message", receive); channel.port1.close(); channel.port2.close();
            queue.length = 0; browser.URL.revokeObjectURL(url);
            if (attached === connection) {
              attached = undefined;
              refreshLayout = undefined;
              // Revoking a blob URL does not stop an already loaded document.
              // Only this current lease may destroy it; a late old cleanup must
              // not navigate a new attachment's browsing context.
              try { child.location = "about:blank"; } catch { /* Removed frame. */ }
            }
          },
        };
        attached = connection;
        refreshLayout = () => connection.send({ ...options.scope, type: "composition-layout" });
        try {
          // Initiating navigation from the host is essential. The opaque parent
          // cannot navigate an iframe to a host-owned blob, and never receives it.
          child.location = url;
        } catch (error) { connection.dispose(); throw error; }
        return connection;
      },
    };
    return {
      mount,
      matches(next: FrameCompositionSlot) { return current.frameToken === next.frameToken && current.hostId === next.hostId && current.boardId === next.boardId && current.view === next.view && current.snapshotId === next.snapshotId; },
      open() { onOpen?.(); },
      drafts() { onDrafts?.(); },
      update(next: FrameCompositionSlot) {
        const moved = current.rect.x !== next.rect.x || current.rect.y !== next.rect.y
          || current.rect.width !== next.rect.width || current.rect.height !== next.rect.height;
        current = next;
        if (moved) refreshLayout?.();
        if (JSON.stringify(publicSnapshot) !== JSON.stringify(next)) { publicSnapshot = next; for (const listener of listeners) listener(); }
      },
      dispose() { attached?.dispose(); listeners.clear(); },
    };
  }
  return {
    open(id) { if (!disposed) mounts.get(id)?.open(); },
    drafts(id) { if (!disposed) mounts.get(id)?.drafts(); },
    update(slots) {
      if (disposed) return;
      descriptions = slots;
      publish();
      const tokens = new Set(slots.map(slot => slot.frameToken));
      for (const token of windows.keys()) if (!tokens.has(token)) windows.delete(token);
      for (const slot of slots) if (!windows.has(slot.frameToken)) input.send({ type: "composition-discover", id: slot.id, frameToken: slot.frameToken });
    },
    dispose() {
      if (disposed) return; disposed = true;
      browser.window?.removeEventListener("message", discover); windows.clear();
      for (const item of mounts.values()) item.dispose(); mounts.clear(); input.changed([]);
    },
  };
}
