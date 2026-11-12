import type { Interaction, SideContext } from "../shared/contracts";
import type { DraftStorage } from "./draft-store";
import { browserDraftStorage } from "./draft-storage-web";

/** One local UI preference per host and Board; only the non-default choice is stored. */
export const SIDE_CONTEXT_PREFIX = "@paseo:board-side-context:v1:";
export const SIDE_CONTEXT_LABELS: Record<SideContext, string> = { blank: "空白 Side", "owner-history": "带主 agent 记录" };
/** Full scope, shown on hover/focus of the 带主 agent 记录 option and read by screen readers; the visible note stays one line. */
export const SIDE_CONTEXT_SCOPE = "冻结主 agent 当前对话（含 Board 回复、工具名和命令输出摘要：每次输出只留开头和结尾，共约 600 字，图片和二进制内容不带；不含思考），过长只带最近部分；仅作背景参考。";
/** One visible line under the choice, only when 带主 agent 记录 is chosen (blank needs no explanation). */
export const SIDE_CONTEXT_NOTE = "带上主 agent 最近的对话和命令输出摘要，仅作参考。";
/** Replaces SIDE_CONTEXT_NOTE while a Side exists, so sending to it is not mistaken for passing it history. */
export const SIDE_CONTEXT_NOTE_EXISTING = "只有新建的 Side 带上记录；已有旁支不变。";
export const SIDE_CONTEXT_FROZEN_NOTE = "重试沿用原发送的选择，不会改变。";
export function sideContextNotes(value: SideContext, options: { frozen: boolean; sideExists: boolean }): string[] {
  if (options.frozen) return [SIDE_CONTEXT_FROZEN_NOTE];
  return value === "owner-history" ? [options.sideExists ? SIDE_CONTEXT_NOTE_EXISTING : SIDE_CONTEXT_NOTE] : [];
}
/** The value every new-Side control shows and the hotkeys use: a retry keeps its frozen choice, a new send uses the preference. */
export function visibleSideContext(compose: { intentId?: string; sideContext?: SideContext }, preference: SideContext): SideContext {
  return compose.intentId ? compose.sideContext ?? "blank" : preference;
}

export interface SideContextStore { read(): SideContext; write(value: SideContext): void }
// Hermes has no browser storage and writes can fail (quota, SecurityError): keep the
// choice for this client session instead of silently reverting what the user sees.
const memory = new Map<string, SideContext>();
export const sideContextKey = (hostId: string, boardId: string) => SIDE_CONTEXT_PREFIX + JSON.stringify([hostId, boardId]);

export function createSideContextStore(scope: { hostId: string; boardId: string }, storage: DraftStorage | null = browserDraftStorage()): SideContextStore {
  const key = sideContextKey(scope.hostId, scope.boardId);
  return {
    read() {
      const local = memory.get(key);
      if (local) return local;
      try {
        const raw = storage?.getItem(key);
        if (!raw) return "blank";
        const parsed = JSON.parse(raw) as { v?: unknown; choice?: unknown };
        return parsed?.v === 1 && parsed.choice === "owner-history" ? "owner-history" : "blank";
      } catch { return "blank"; }
    },
    write(value) {
      try {
        if (!storage) throw new Error("unavailable");
        if (value === "owner-history") storage.setItem(key, JSON.stringify({ v: 1, choice: value }));
        else storage.removeItem(key);
        memory.delete(key);
      } catch { memory.set(key, value); }
    },
  };
}

type ProvenanceSource = Pick<Interaction, "kind" | "status" | "sideContext" | "inheritedHistory" | "sideNotCreated">;
// Delivery warnings come right after the label: a two-line clamp (Side picker, narrow widths) must never cut them off.
const STATE_NOTES = { frozen: "待送达", sent: "", uncertain: "未确认送达（这个 Side 可能没有拿到记录）", not_sent: "未送达（这个 Side 没有拿到记录）" } as const;
const historyOf = (item: ProvenanceSource) => item.kind === "fork" && item.sideContext === "owner-history" ? { history: item.inheritedHistory } : undefined;
/** Shown only for Sides created with history; blank Sides and legacy forks make no claim. */
export function sideProvenance(item: ProvenanceSource): string | undefined {
  const found = historyOf(item);
  if (!found) return undefined;
  const history = found.history;
  if (item.sideNotCreated || !history) return item.sideNotCreated || item.status === "failed" ? "带主 agent 记录 · 未建立（没有创建 Side）" : "带主 agent 记录 · 读取中";
  // A frozen snapshot on a failed item is a create whose result is still being reconciled.
  const state = history.state === "frozen" && item.status === "failed" ? "创建结果待核对" : STATE_NOTES[history.state];
  const amount = history.entries === 0 && !history.omitted ? "主 agent 暂无可带的记录"
    : history.omitted ? `最近 ${history.messages} 条消息 · 更早的未带上` : `${history.messages} 条消息`;
  // Claimed only when the snapshot recorded excerpts; snapshots from before excerpts existed say nothing either way.
  const outputs = history.toolOutputs ? "含命令输出摘要" : "";
  return ["带主 agent 记录", state, amount, outputs, history.ownerBusy ? "含主 agent 进行中的一轮" : ""].filter(Boolean).join(" · ");
}
/** A few characters for the always-visible discussion rail; undefined for blank Sides and Sides never created. */
export function sideHistoryTag(item: ProvenanceSource): string | undefined {
  const found = historyOf(item);
  if (!found) return undefined;
  const state = found.history?.state;
  if (item.sideNotCreated || !found.history) return item.sideNotCreated || item.status === "failed" ? undefined : "带记录";
  if (state === "frozen" && item.status === "failed") return "创建待核对";
  return state === "uncertain" ? "记录未确认" : state === "not_sent" ? "未带上记录" : "带记录";
}
