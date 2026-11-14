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
/** Phase 0 caption (lockdown design §4 item 5) until the sealed runner exists. */
export const SETUP_LINE = "评论助手的旧版本没能把权限限制在评论工具上，自动处理暂时停用。";
/** The wake line for each state (exact, DESIGN §11.12 and lockdown design §3.8). */
export function wakeLine(status: InboxAutoStatus, now = Date.now()): string {
  const wake = status.wake;
  switch (wake.state) {
    case "off": return "自动处理：未开启";
    case "legacy-internal": return "自动处理：未开启（仅允许内部处理）";
    case "setup": return SETUP_LINE;
    case "checking": return "正在做锁定检查…";
    case "idle": return "自动处理：等待新评论";
    case "batching": return `自动处理：${wake.pendingComments} 条新评论，约 ${secondsUntil(wake.nextWakeAt, now)} 秒后交给评论助手`;
    case "running": return `自动处理：评论助手正在处理 ${wake.runningComments} 条评论`;
    case "waiting-host": return "自动处理：等待 Paseo 连接后交给评论助手";
    default:
      if (wake.pausedReason === "budget") return `自动处理已暂停：一小时内已处理 ${wake.maxWakesPerHour} 批，${wake.resumesAt ? clockTime(wake.resumesAt) : "稍后"} 自动恢复。新评论仍会同步，${wake.pendingComments} 条等待处理。`;
      if (wake.pausedReason === "host-budget") return `自动处理已暂停：这台电脑一小时内已处理 ${wake.maxHostWakesPerHour} 批评论，${wake.resumesAt ? clockTime(wake.resumesAt) : "稍后"} 自动恢复。`;
      if (wake.pausedReason === "lockdown") return `自动处理已暂停：评论助手启动时没通过锁定检查（${wake.findings.length ? wake.findings.join("；") : wake.error ?? "原因未知"}），这批评论没有交给它。`;
      if (wake.pausedReason === "cli") return `自动处理已暂停：评论助手连续 3 次没能启动（${wake.error ?? "原因未知"}）。`;
      if (wake.pausedReason === "cost") return `自动处理已暂停：今天的花费已到上限 $${status.assistant ? usd(status.assistant.dailyCapUsd) : "?"}，明天 0 点自动恢复。`;
      if (wake.pausedReason === "setup") return SETUP_LINE;
      return "自动处理已暂停。新评论仍会同步。";
  }
}
/** Dollar amounts: two significant digits below $1 (`0.0023`), cents above. */
export function usd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1) return value.toFixed(2).replace(/\.00$/, "");
  return String(Number(value.toPrecision(2)));
}
/** Notices after an automatic budget resume (the last day only). */
export function wakeNotices(status: InboxAutoStatus, now = Date.now()): string[] {
  const notices: string[] = [];
  const pause = status.wake.lastBudgetPause;
  if (pause && now - Date.parse(pause.to) < 86_400_000) notices.push(`自动处理曾因频率或花费上限暂停（${clockTime(pause.from)}–${clockTime(pause.to)}）。`);
  return notices;
}
/** The 更多 dot (DESIGN §11.12 Toolbar; lockdown design §3.7): aggregated, never per comment. */
export function inboxSummary(status?: InboxAutoStatus): { attention: boolean; detail: string } {
  if (!status) return { attention: false, detail: "查看访客评论和回复，设置 agent 自动处理" };
  const problem = status.wake.state === "setup" || status.wake.state === "paused" && status.wake.pausedReason !== "human"
    || status.sync.sources.some(source => source.state === "blocked" || source.state === "quota") || status.replies.failed > 0;
  if (problem) return { attention: true, detail: "自动处理已暂停或同步出错，点开查看" };
  if (status.reviewing > 0) return { attention: true, detail: `${status.reviewing} 条评论等你处理` };
  return { attention: false, detail: "查看访客评论和回复，设置 agent 自动处理" };
}
/** `回复看起来包含私密信息（reason），未发送。` → reason, for the human override confirm. */
export function guardReason(message: string): string | undefined {
  return /^回复看起来包含私密信息（(.+)），未发送。$/.exec(message)?.[1];
}
