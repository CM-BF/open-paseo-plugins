import type { FrameScope } from "../shared/frame-contract";

export interface CompositionRect { x: number; y: number; width: number; height: number }
export interface CompositionSlot {
  id: string;
  hostId: string;
  boardId: string;
  view: "interactive" | "preview";
  snapshotId?: string;
  rect: CompositionRect;
  visible: boolean;
}
export interface CompositionPort {
  postMessage(message: unknown, transfer?: CompositionPort[]): void;
  addEventListener(type: "message", listener: (event: CompositionMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: CompositionMessageEvent) => void): void;
  start(): void;
  close(): void;
}
export interface CompositionFrameWindow {
  postMessage(message: unknown, origin: string, transfer?: CompositionPort[]): void;
}
export interface CompositionMessageEvent {
  data: unknown;
  source: unknown;
  isTrusted: boolean;
  /** Set only by the host's private MessagePort receiver, never from payload data. */
  compositionAuthenticated?: true;
}
export interface CompositionAttachment {
  readonly contentWindow: CompositionFrameWindow;
  send(message: unknown, transfer?: CompositionPort[]): void;
  dispose(): void;
}
/** Host-owned capability. This object and child source never enter the author frame. */
export interface CompositionMount {
  readonly id: string;
  getSnapshot(): CompositionSlot;
  subscribe(listener: () => void): () => void;
  attach(input: {
    scope: FrameScope;
    document(secret: string): string;
    receive(event: CompositionMessageEvent): void;
    /** Freeze read-only view delivery before destroying this loaded document. */
    beforeDispose?(): void;
  }): CompositionAttachment;
  setStatus(text: string): void;
  setPresentation(value: { title: string; hostLabel: string; unread: number; queued?: number; onOpen?(): void; onDrafts?(): void }): void;
}
export interface CanvasComposition {
  hostId: string;
  onSlots(slots: readonly CompositionMount[]): void;
}
