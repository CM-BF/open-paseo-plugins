import { describe, expect, it } from "vitest";
import { COST_NOTE, SETUP_LINE, assistantLine, autoToggleLabel, capLine, costLine, deniedNotice, guardReason, inboxSummary, modelButtonLabel, runLines, sourceStateText, syncLine, usd, wakeLine, wakeNotices } from "./inbox-status";
import type { InboxRunRecord } from "../shared/inbox";
import type { InboxAutoStatus } from "../shared/inbox";

const at = (hours: number, minutes: number, seconds = 0) => new Date(2026, 10, 13, hours, minutes, seconds).toISOString();
const now = Date.parse(at(9, 0));
const source = (patch: Partial<InboxAutoStatus["sync"]["sources"][number]> = {}) => ({ sourceId: "app", label: "App", state: "idle" as const, lastAttemptAt: null, lastSuccessAt: at(8, 59, 58), nextAttemptAt: null, lastImportAt: null, failures: 0, lastError: null, repliesSupported: true, skipped: 0, sanitized: 0, ...patch });
const status = (wake: Partial<InboxAutoStatus["wake"]> = {}, sources = [source()], extra: Partial<InboxAutoStatus> = {}): InboxAutoStatus => ({
  revision: 3, sync: { paused: false, intervalSeconds: 5, sources },
  wake: { state: "idle", pausedReason: null, pausedAt: null, resumesAt: null, error: null, findings: [], pendingComments: 0, runningComments: 0, nextWakeAt: null, wakesLastHour: 0, maxWakesPerHour: 12, hostWakesLastHour: 0, maxHostWakesPerHour: 30, lastWakeAt: null, lastBudgetPause: null, cliFailures: 0, skipped: { otherBoard: 0, unattributed: 0 }, ...wake },
  assistant: null, legacy: null, runs: [], reviewing: 0, publicDirect: false, replies: { sending: 0, drafts: 0, failed: 0, items: [] }, ...extra,
});

describe("inbox automation texts (DESIGN §4.10, §11.12)", () => {
  it("labels the automatic-handling toggle, including the legacy internal grant", () => {
    expect(autoToggleLabel({ read: true, triage: true, auto: "publish" })).toBe("Agent 自动处理并公开回复：已开启（直接回复）");
    expect(autoToggleLabel({ read: true, triage: true, auto: "review" })).toBe("Agent 自动处理并公开回复：已开启（回复需你审核）");
    expect(autoToggleLabel({ read: true, triage: true })).toBe("Agent 自动处理并公开回复：未开启（仍允许内部处理）");
    expect(autoToggleLabel({ read: false, triage: false })).toBe("Agent 自动处理并公开回复：未开启");
  });
  it("prioritises blocked, then backoff, quota and idle sync lines", () => {
    expect(syncLine(status({}, []), now)).toBe("还没有后端来源。在「后端来源」里连接后会自动同步。");
    expect(syncLine(status(), now)).toBe(`自动同步：每 5 秒检查一次 · 上次成功 08:59:58`);
    expect(syncLine({ ...status(), sync: { paused: true, intervalSeconds: 5, sources: [source()] } }, now)).toBe("自动同步已暂停");
    expect(syncLine(status({}, [source({ state: "backoff", lastError: "后端返回 HTTP 500", nextAttemptAt: at(9, 0, 12) })]), now)).toBe("自动同步出错：后端返回 HTTP 500。12 秒后重试");
    expect(syncLine(status({}, [source({ state: "backoff", lastError: "x" }), source({ state: "blocked", lastError: "后端没有开启评论导出（HTTP 404）。" })]), now)).toBe("自动同步需要处理：后端没有开启评论导出（HTTP 404）。");
    expect(sourceStateText(source({ state: "blocked", lastError: "令牌错误" }), now)).toBe("需要处理：令牌错误");
    expect(sourceStateText(source(), now)).toBe("每 5 秒检查一次 · 上次成功 08:59:58");
  });
  it("renders every wake state, including the sealed runner's states and pauses", () => {
    const lines: Array<[Partial<InboxAutoStatus["wake"]>, string]> = [
      [{ state: "off" }, "自动处理：未开启"],
      [{ state: "legacy-internal" }, "自动处理：未开启（仅允许内部处理）"],
      [{ state: "setup", pausedReason: "setup" }, SETUP_LINE],
      [{ state: "checking" }, "正在做锁定检查…"],
      [{ state: "idle" }, "自动处理：等待新评论"],
      [{ state: "batching", pendingComments: 3, nextWakeAt: at(9, 0, 2) }, "自动处理：3 条新评论，约 2 秒后交给评论助手"],
      [{ state: "running", runningComments: 2 }, "自动处理：评论助手正在处理 2 条评论"],
      [{ state: "waiting-host" }, "自动处理：等待 Paseo 连接后交给评论助手"],
      [{ state: "paused", pausedReason: "human" }, "自动处理已暂停。新评论仍会同步。"],
      [{ state: "paused", pausedReason: "budget", resumesAt: at(9, 42), pendingComments: 4 }, "自动处理已暂停：一小时内已处理 12 批，09:42 自动恢复。新评论仍会同步，4 条等待处理。"],
      [{ state: "paused", pausedReason: "host-budget", resumesAt: at(9, 30) }, "自动处理已暂停：这台电脑一小时内已处理 30 批评论，09:30 自动恢复。"],
      [{ state: "paused", pausedReason: "lockdown", findings: ["工具 Bash、Read", "MCP 服务 learning"] }, "自动处理已暂停：评论助手启动时没通过锁定检查（工具 Bash、Read；MCP 服务 learning），这批评论没有交给它。"],
      [{ state: "paused", pausedReason: "cli", error: "Claude Code 启动失败（退出码 1）" }, "自动处理已暂停：评论助手连续 3 次没能启动（Claude Code 启动失败（退出码 1））。"],
    ];
    for (const [wake, text] of lines) expect(wakeLine(status(wake), now)).toBe(text);
    expect(SETUP_LINE).toBe("自动处理：需要重新开启（新版会先做锁定检查）");
    const sealed = { kind: "sealed" as const, modelId: "claude-haiku-5-5", modelLabel: "Haiku 5.5", effort: "low" as const, providerId: "claude", lastCheck: null, costLastHourUsd: 0, costTodayUsd: 0.5, dailyCapUsd: 0.5, avgCostPerCommentUsd: null };
    expect(wakeLine(status({ state: "paused", pausedReason: "cost" }, [source()], { assistant: sealed }), now)).toBe("自动处理已暂停：今天的花费已到上限 $0.5，明天 0 点自动恢复。");
    expect(wakeNotices(status({ lastBudgetPause: { from: at(8, 1), to: at(8, 40) } }), now)).toEqual(["自动处理曾因频率或花费上限暂停（08:01–08:40）。"]);
    expect([usd(0.00231), usd(0.0306), usd(0.045), usd(0.5), usd(5), usd(12.5)]).toEqual(["0.0023", "0.031", "0.045", "0.5", "5", "12.50"]);
  });
  it("raises the toolbar dot for problems that need the human and for comments handed to the user, never per run", () => {
    expect(inboxSummary(status({ state: "paused", pausedReason: "human" }))).toEqual({ attention: false, detail: "查看访客评论和回复，设置 agent 自动处理" });
    expect(inboxSummary(status({ state: "paused", pausedReason: "budget" }))).toEqual({ attention: true, detail: "自动处理已暂停或同步出错，点开查看" });
    expect(inboxSummary(status({ state: "setup", pausedReason: "setup" })).attention).toBe(true);
    expect(inboxSummary(status({}, [source({ state: "quota" })])).attention).toBe(true);
    expect(inboxSummary(status({}, [source()], { replies: { sending: 0, drafts: 0, failed: 1, items: [] } })).attention).toBe(true);
    expect(inboxSummary(status({}, [source()], { reviewing: 2 }))).toEqual({ attention: true, detail: "2 条评论等你处理" });
    expect(inboxSummary(status({ state: "running", runningComments: 3 })).attention).toBe(false);
    expect(inboxSummary(undefined).attention).toBe(false);
  });
  it("shows the sealed runner, its cost, the run log and denied tool attempts (lockdown design §3.8)", () => {
    const run = (patch: Partial<InboxRunRecord>): InboxRunRecord => ({ runId: "inbox-x-1-2", at: at(8, 30), endedAt: at(8, 30, 9), state: "done", model: "claude-haiku-5-5", cliVersion: "2.1.325", commentIds: ["c1", "c2"], firstSeq: 1, lastSeq: 2, actions: { replied: 1, drafted: 0, triaged: 1, dismissed: 0 }, deniedAttempts: [], costUsd: 0.0031, durationMs: 8_600, error: null, findings: [], ...patch });
    const assistant = { kind: "sealed" as const, modelId: "claude-haiku-5-5", modelLabel: "Haiku 5.5", effort: "low" as const, providerId: "claude", lastCheck: { at: at(8, 12), ok: true, cliVersion: "2.1.325", findings: [] }, costLastHourUsd: 0.0031, costTodayUsd: 0.0125, dailyCapUsd: 0.5, avgCostPerCommentUsd: 0.00156 };
    const value = status({}, [source()], { assistant, runs: [run({ state: "running", endedAt: null, at: at(8, 40), commentIds: ["c3"], costUsd: null, durationMs: null }), run({}), run({ state: "lockdown", findings: ["工具 Bash", "MCP 服务 paseo"], at: at(8, 20) }), run({ state: "unsupported", error: "Claude Code 启动失败（退出码 1）", at: at(8, 10) }), run({ deniedAttempts: ["Bash", "WebFetch"], at: at(8, 5) }), run({ state: "failed", error: "工具调用超过 10 次，已停止", costUsd: 0.02, costEstimated: true, at: at(8, 1) }), run({ costUsd: 0.02, costEstimated: true, at: at(8, 0) })] });
    expect(assistantLine(value)).toBe("评论助手：Haiku 5.5 · 每批新会话 · 锁定检查 08:12 通过（Claude Code 2.1.325）");
    expect(assistantLine({ ...value, assistant: { ...assistant, lastCheck: { at: at(8, 20), ok: false, cliVersion: "2.1.325", findings: ["工具 Bash"] } } })).toBe("评论助手：Haiku 5.5 · 每批新会话 · 锁定检查 08:20 没通过");
    expect(costLine(value)).toBe("花费：最近一小时 $0.0031 · 今天 $0.013 / 上限 $0.5（按 API 价格估算） · 平均每条 $0.0016");
    expect(runLines(value)).toEqual([
      "08:40 处理中 1 条",
      "08:30 处理 2 条（回复 1，草稿 0，分类 1）· $0.0031 · 9 秒",
      "08:20 锁定检查没通过：工具 Bash；MCP 服务 paseo",
      "08:10 没能启动：Claude Code 启动失败（退出码 1）",
      "08:05 处理 2 条（回复 1，草稿 0，分类 1）· $0.0031 · 9 秒",
      // A run killed before the CLI reported its cost is charged its --max-budget-usd, and the log says so.
      "08:01 失败：工具调用超过 10 次，已停止 · 费用按单次上限计 $0.02",
      "08:00 处理 2 条（回复 1，草稿 0，分类 1）· 费用按单次上限计 $0.02 · 9 秒",
    ]);
    expect(deniedNotice(value)).toBe("评论助手在处理这批评论时试图使用不存在的工具（Bash、WebFetch），已被拒绝。这些评论可能含有诱导内容，建议看一下。");
    expect(deniedNotice(status())).toBeNull(); expect(assistantLine(status())).toBeNull(); expect(costLine(status())).toBeNull();
    expect(modelButtonLabel({ id: "claude-haiku-5-5", label: "Haiku 5.5", priced: true, perComment: { lo: 0.00226, hi: 0.003825 }, dailyCapUsd: 0.5, effort: true }, true)).toBe("Haiku 5.5（推荐，最便宜） · 约 $0.0023–0.0038/条");
    expect(modelButtonLabel({ id: "proxy", label: "Proxy", priced: false, perComment: null, dailyCapUsd: 10, effort: true }, false)).toBe("Proxy · 无法估算");
    expect(capLine(0.5)).toBe("每天最多 $0.5，到上限后暂停到第二天。");
    expect(COST_NOTE).toBe("费用按 Claude API 标价估算（价格表 2026-11）；使用 Claude 订阅时计入订阅额度。实际花费通常更低（有缓存）。");
  });
  it("extracts the guard reason for the override confirm", () => {
    expect(guardReason("回复看起来包含私密信息（令牌），未发送。")).toBe("令牌");
    expect(guardReason("别的错误")).toBeUndefined();
  });
});
