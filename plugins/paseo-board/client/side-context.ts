import type { Interaction, SideContext } from "../shared/contracts";
import type { DraftStorage } from "./draft-store";
import { browserDraftStorage } from "./draft-storage-web";

/** One local UI preference per host and Board; only the non-default choice is stored. */
export const SIDE_CONTEXT_PREFIX = "@paseo:board-side-context:v1:";
export const SIDE_CONTEXT_LABELS: Record<SideContext, string> = { blank: "空白 Side", "owner-history": "带主 agent 记录" };
export const SIDE_CONTEXT_SCOPE = "冻结主 agent 当前对话（含 Board 回复和工具名，不含工具输出和思考），过长只带最近部分；仅作背景参考。";
export const sideContextExisting = (action = "Side 发送") => `「${action}」进入已有旁支，不受此项影响；新建 Side 时才按此项。`;

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

type ProvenanceSource = Pick<Interaction, "kind" | "status" | "sideContext" | "inheritedHistory">;
const STATE_NOTES = { frozen: " · 待送达", sent: "", uncertain: " · 未确认送达（这个 Side 可能没有拿到记录）", not_sent: " · 未送达（这个 Side 没有拿到记录）" } as const;
/** Shown only for Sides created with history; blank Sides and legacy forks make no claim. */
export function sideProvenance(item: ProvenanceSource): string | undefined {
  if (item.kind !== "fork" || item.sideContext !== "owner-history") return undefined;
  const history = item.inheritedHistory;
  if (!history) return item.status === "failed" ? "带主 agent 记录 · 未建立（没有创建 Side）" : "带主 agent 记录 · 读取中";
  const amount = history.entries === 0 && !history.omitted ? "主 agent 暂无可带的记录"
    : history.omitted ? `最近 ${history.messages} 条消息 · 更早的未带上` : `${history.messages} 条消息`;
  return `带主 agent 记录 · ${amount}${history.ownerBusy ? " · 含主 agent 进行中的一轮" : ""}${STATE_NOTES[history.state]}`;
}
