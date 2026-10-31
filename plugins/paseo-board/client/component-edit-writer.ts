import type { Board, CanvasBase, EditInput } from "../shared/contracts";
import type { ComponentEditRequest, ComponentEditResult } from "../shared/frame-contract";

export interface EditDraft {
  request: EditInput; sourceLabel?: string; destinationLabel?: string;
  status: "review" | "saving" | "unknown" | "rejected"; error?: string;
}
const sameBase = (a: CanvasBase, b: CanvasBase) => a.revision === b.revision && a.documentVersion === b.documentVersion;
const confirmedRefusals = new Set(["invalid_input", "revision_conflict", "edit_conflict", "idempotency_conflict", "unauthorized", "forbidden", "board_not_found"]);
function immutable<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}

/** One user save at a time. Unknown outcomes retain their exact receipt/CAS across view remounts. */
export class ComponentEditWriter {
  private draft: EditDraft | null = null;
  private resolve?: (result: ComponentEditResult) => void;
  private listeners = new Set<() => void>();
  snapshot = () => this.draft;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) listener(); }
  propose(boardId: string, input: ComponentEditRequest, eventId: string): Promise<ComponentEditResult> {
    if (this.draft) return Promise.resolve({ status: "rejected", message: "请先保存或取消当前修改。" });
    const proposed = JSON.parse(JSON.stringify(input)) as ComponentEditRequest;
    this.draft = {
      status: "review", sourceLabel: proposed.sourceLabel, destinationLabel: proposed.destinationLabel,
      request: immutable({ boardId, canvasBase: proposed.canvasBase, eventId,
        patch: { ...proposed.patch, id: eventId, ...(proposed.patch.operation === "copy" ? { copyIdPrefix: eventId } : {}) } }),
    };
    const result = new Promise<ComponentEditResult>(resolve => { this.resolve = resolve; });
    this.changed(); return result;
  }
  editText(text: string) {
    if (this.draft?.status !== "review" || this.draft.request.patch.operation !== "text" || text.length > 24000) return;
    this.draft = { ...this.draft, request: immutable({ ...this.draft.request, patch: { ...this.draft.request.patch, text } }) };
    this.changed();
  }
  invalidate(base?: CanvasBase) {
    if (this.draft?.status !== "review" || base && sameBase(base, this.draft.request.canvasBase)) return;
    const message = "画布已更新，这次修改尚未保存。请重新选择组件。";
    this.draft = { ...this.draft, status: "rejected", error: message };
    this.resolve?.({ status: "rejected", message }); this.resolve = undefined; this.changed();
  }
  cancel() {
    if (!this.draft || this.draft.status === "saving" || this.draft.status === "unknown") return;
    this.resolve?.({ status: "cancelled" }); this.resolve = undefined; this.draft = null; this.changed();
  }
  async save(commit: (input: EditInput) => Promise<Board>, accepted: (board: Board) => void, refresh: () => Promise<unknown>) {
    const draft = this.draft;
    if (!draft || draft.status === "saving" || draft.status === "rejected") return;
    this.draft = { ...draft, status: "saving", error: undefined }; this.changed();
    try {
      const board = await commit(draft.request);
      accepted(board);
      this.resolve?.({ status: "applied", canvasRevision: board.canvas.revision }); this.resolve = undefined;
      this.draft = null; this.changed();
    } catch (error) {
      const code = (error as { code?: string })?.code;
      const known = typeof code === "string" && confirmedRefusals.has(code);
      const detail = error instanceof Error ? error.message : String(error);
      const message = known ? `修改未保存：${detail}。请重新选择组件。` : `还未确认保存结果：${detail}。重试会核对同一次修改，不会重复执行。`;
      this.draft = { ...draft, status: known ? "rejected" : "unknown", error: message };
      if (known) { this.resolve?.({ status: "rejected", message }); this.resolve = undefined; }
      this.changed();
      void refresh().catch(() => undefined);
    }
  }
}
