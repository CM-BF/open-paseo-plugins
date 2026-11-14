import type { InboxAutoSourceStatus, InboxAutoStatus, InboxPolicy } from "../shared/inbox";

const pad = (value: number) => String(value).padStart(2, "0");
export const clockTime = (iso: string, seconds = false) => { const at = new Date(iso); return `${pad(at.getHours())}:${pad(at.getMinutes())}${seconds ? `:${pad(at.getSeconds())}` : ""}`; };
const secondsUntil = (iso: string | null, now: number) => iso ? Math.max(1, Math.ceil((Date.parse(iso) - now) / 1000)) : 0;

/** `Agent 自动处理并公开回复：…` (DESIGN §11.12). */
export function autoToggleLabel(policy: InboxPolicy): string {
  const auto = policy.auto ?? "off";
  if (auto === "publish") return "Agent 自动处理并公开回复：已开启（直接回复）";
  if (auto === "review") return "Agent 自动处理并公开回复：已开启（回复需你审核）";
  return policy.triage ? "Agent 自动处理并公开回复：未开启（仍允许内部处理）" : "Agent 自动处理并公开回复：未开启";
}
/** One source's auto-sync state, for the source card (`自动同步：…`). */
export function sourceStateText(source: InboxAutoSourceStatus, now = Date.now(), intervalSeconds = 5): string {
  switch (source.state) {
    case "off": return "未启用";
    case "paused": return "已暂停";
    case "syncing": return "正在同步…";
    case "backoff": return `出错：${source.lastError ?? "未知错误"}。${secondsUntil(source.nextAttemptAt, now)} 秒后重试`;
    case "blocked": return `需要处理：${source.lastError ?? "未知错误"}`;
    case "quota": return source.lastError ?? "导入的评论超过上限，稍后自动继续。";
    default: return `每 ${intervalSeconds} 秒检查一次${source.lastSuccessAt ? ` · 上次成功 ${clockTime(source.lastSuccessAt, true)}` : ""}`;
  }
}
/** The automation block's sync line (DESIGN §4.10). Blocked needs the human first, then backoff, quota, idle. */
export function syncLine(status: InboxAutoStatus, now = Date.now()): string {
  const sources = status.sync.sources.filter(source => source.state !== "off");
  if (!status.sync.sources.length) return "还没有后端来源。在「后端来源」里连接后会自动同步。";
  if (status.sync.paused) return "自动同步已暂停";
  const blocked = sources.find(source => source.state === "blocked");
  if (blocked) return `自动同步需要处理：${blocked.lastError ?? "未知错误"}`;
  const backoff = sources.find(source => source.state === "backoff");
  if (backoff) return `自动同步出错：${backoff.lastError ?? "未知错误"}。${secondsUntil(backoff.nextAttemptAt, now)} 秒后重试`;
  const quota = sources.find(source => source.state === "quota");
  if (quota) return `自动同步：${quota.lastError ?? "导入的评论超过上限，稍后自动继续。"}`;
  if (!sources.length) return "自动同步：没有已启用的来源";
  const last = sources.map(source => source.lastSuccessAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  return `自动同步：每 ${status.sync.intervalSeconds} 秒检查一次${last ? ` · 上次成功 ${clockTime(last, true)}` : ""}`;
}
/** The wake line for each state (exact, DESIGN §11.12). */
export function wakeLine(status: InboxAutoStatus, now = Date.now()): string {
  const wake = status.wake;
  switch (wake.state) {
    case "off": return "自动处理：未开启";
    case "legacy-internal": return "自动处理：未开启（仅允许内部处理）";
    case "creating": return "正在创建评论助手…";
    case "idle": return "自动处理：等待新评论";
    case "batching": return `自动处理：${wake.pendingComments} 条新评论，约 ${secondsUntil(wake.nextWakeAt, now)} 秒后交给评论助手`;
    case "queued": return "自动处理：已交给评论助手，等它忙完当前工作";
    case "running": return "自动处理：评论助手正在处理";
    case "waiting-permission": return "自动处理：评论助手在等你批准一个操作。它只应该使用评论工具；不是你预期的请求请拒绝。";
    case "waiting-host": return "自动处理：等待 Paseo 连接后交给评论助手";
    default:
      if (wake.pausedReason === "budget") return `自动处理已暂停：一小时内已唤醒 ${wake.maxWakesPerHour} 次，${wake.resumesAt ? clockTime(wake.resumesAt) : "稍后"} 自动恢复。新评论仍会同步，${wake.pendingComments} 条等待处理。`;
      if (wake.pausedReason === "host-budget") return `自动处理已暂停：这台电脑一小时内已唤醒评论助手 ${wake.maxHostWakesPerHour} 次，${wake.resumesAt ? clockTime(wake.resumesAt) : "稍后"} 自动恢复。`;
      if (wake.pausedReason === "agent" || wake.pausedReason === "mode") return `自动处理已暂停：${wake.error ?? "评论助手不可用。"}`;
      return "自动处理已暂停。新评论仍会同步。";
  }
}
/** Notices after an automatic budget resume or a stale settle (the last day only). */
export function wakeNotices(status: InboxAutoStatus, now = Date.now()): string[] {
  const notices: string[] = [];
  const pause = status.wake.lastBudgetPause;
  if (pause && now - Date.parse(pause.to) < 86_400_000) notices.push(`自动处理曾因频率上限暂停（${clockTime(pause.from)}–${clockTime(pause.to)}）。`);
  if (status.wake.staleSettledAt && now - Date.parse(status.wake.staleSettledAt) < 86_400_000) notices.push("上次唤醒没有确认结束，已解除等待。");
  return notices;
}
/** The 更多 dot (DESIGN §11.12 Toolbar). */
export function inboxSummary(status?: InboxAutoStatus): { attention: boolean; detail: string } {
  const attention = Boolean(status && (status.wake.state === "paused" && status.wake.pausedReason !== "human"
    || status.sync.sources.some(source => source.state === "blocked" || source.state === "quota") || status.replies.failed > 0));
  return { attention, detail: attention ? "自动处理已暂停或同步出错，点开查看" : "查看访客评论和回复，设置 agent 自动处理" };
}
/** `回复看起来包含私密信息（reason），未发送。` → reason, for the human override confirm. */
export function guardReason(message: string): string | undefined {
  return /^回复看起来包含私密信息（(.+)），未发送。$/.exec(message)?.[1];
}
