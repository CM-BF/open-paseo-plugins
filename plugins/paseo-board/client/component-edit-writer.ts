import type { Board, CanvasBase, EditInput, EditResult } from "../shared/contracts";
import type { ComponentEditRequest, ComponentEditResult } from "../shared/frame-contract";

export interface EditDraft {
  request: EditInput; sourceLabel?: string; destinationLabel?: string;
  status: "review" | "saving" | "unknown" | "rejected"; error?: string;
}
const sameBase = (a: CanvasBase, b: CanvasBase) => a.revision === b.revision && a.documentVersion === b.documentVersion;
const refusalMessages = {
  invalid_input: "这次修改无法保存，请重新选择组件。",
  revision_conflict: "画布已更新，这次修改未保存。请重新选择组件。",
  edit_conflict: "组件与已保存内容不一致，这次修改未保存。请重新选择组件。",
  idempotency_conflict: "这次修改与已有保存记录冲突，请重新选择组件。",
  unauthorized: "当前无法修改这块画板，请确认访问权限。",
  forbidden: "当前无法修改这块画板，请确认访问权限。",
  board_not_found: "画板已不存在，这次修改未保存。",
  not_found: "画板已不存在，这次修改未保存。",
  size_limit: "修改内容过大，这次修改未保存。请缩小范围。",
};
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
  async save(commit: (input: EditInput) => Promise<EditResult>, accepted: (board: Board) => void, refresh: () => Promise<unknown>) {
    const draft = this.draft;
    if (!draft || draft.status === "saving" || draft.status === "rejected") return;
    this.draft = { ...draft, status: "saving", error: undefined }; this.changed();
    try {
      const result = await commit(draft.request);
      // Do not release an uncertain request for an unrelated/malformed receipt.
      if (!result || result.eventId !== draft.request.eventId) throw new Error("Mismatched component edit receipt");
      if (result.status === "rejected" && Object.hasOwn(refusalMessages, result.code)) {
        const message = result.code === "edit_conflict" && result.componentTarget
          ? `${result.componentTarget === "destination" ? "目标容器" : "所选组件"}与已保存内容不一致，这次修改未保存。请重新选择${result.componentTarget === "destination" ? "目标" : "组件"}。`
          : refusalMessages[result.code];
        this.draft = { ...draft, status: "rejected", error: message };
        this.resolve?.({ status: "rejected", message }); this.resolve = undefined;
        this.changed(); void refresh().catch(() => undefined); return;
      }
      if (result.status !== "applied" || result.board?.id !== draft.request.boardId) throw new Error("Invalid component edit receipt");
      const board = result.board;
      accepted(board);
      this.resolve?.({ status: "applied", canvasRevision: board.canvas.revision }); this.resolve = undefined;
      this.draft = null; this.changed();
    } catch {
      // In particular, handler_error is not a domain refusal. It can wrap a
      // failure after commit, and matching its English message is unsafe.
      const message = "保存结果待确认。重试只核对这次修改，不会重复执行。";
      this.draft = { ...draft, status: "unknown", error: message };
      this.changed();
      void refresh().catch(() => undefined);
    }
  }
}
