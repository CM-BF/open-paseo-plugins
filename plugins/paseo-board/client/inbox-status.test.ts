import { describe, expect, it } from "vitest";
import { autoToggleLabel, guardReason, inboxSummary, sourceStateText, syncLine, wakeLine, wakeNotices } from "./inbox-status";
import type { InboxAutoStatus } from "../shared/inbox";

const at = (hours: number, minutes: number, seconds = 0) => new Date(2026, 10, 13, hours, minutes, seconds).toISOString();
const now = Date.parse(at(9, 0));
const source = (patch: Partial<InboxAutoStatus["sync"]["sources"][number]> = {}) => ({ sourceId: "app", label: "App", state: "idle" as const, lastAttemptAt: null, lastSuccessAt: at(8, 59, 58), nextAttemptAt: null, lastImportAt: null, failures: 0, lastError: null, repliesSupported: true, skipped: 0, sanitized: 0, ...patch });
const status = (wake: Partial<InboxAutoStatus["wake"]> = {}, sources = [source()], extra: Partial<InboxAutoStatus> = {}): InboxAutoStatus => ({
  revision: 3, sync: { paused: false, intervalSeconds: 5, sources },
  wake: { state: "idle", pausedReason: null, pausedAt: null, resumesAt: null, error: null, pendingComments: 0, nextWakeAt: null, wakesLastHour: 0, maxWakesPerHour: 6, hostWakesLastHour: 0, maxHostWakesPerHour: 20, lastWakeAt: null, lastWakeResult: null, lastBudgetPause: null, stale: false, staleSettledAt: null, skipped: { otherBoard: 0, unattributed: 0 }, ...wake },
  assistant: null, replies: { sending: 0, drafts: 0, failed: 0, items: [] }, ...extra,
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
  it("renders every wake state", () => {
    const lines: Array<[Partial<InboxAutoStatus["wake"]>, string]> = [
      [{ state: "off" }, "自动处理：未开启"],
      [{ state: "legacy-internal" }, "自动处理：未开启（仅允许内部处理）"],
      [{ state: "creating" }, "正在创建评论助手…"],
      [{ state: "idle" }, "自动处理：等待新评论"],
      [{ state: "batching", pendingComments: 3, nextWakeAt: at(9, 0, 2) }, "自动处理：3 条新评论，约 2 秒后交给评论助手"],
      [{ state: "queued" }, "自动处理：已交给评论助手，等它忙完当前工作"],
      [{ state: "running" }, "自动处理：评论助手正在处理"],
      [{ state: "waiting-permission" }, "自动处理：评论助手在等你批准一个操作。它只应该使用评论工具；不是你预期的请求请拒绝。"],
      [{ state: "waiting-host" }, "自动处理：等待 Paseo 连接后交给评论助手"],
      [{ state: "paused", pausedReason: "human" }, "自动处理已暂停。新评论仍会同步。"],
      [{ state: "paused", pausedReason: "budget", resumesAt: at(9, 42), pendingComments: 4 }, "自动处理已暂停：一小时内已唤醒 6 次，09:42 自动恢复。新评论仍会同步，4 条等待处理。"],
      [{ state: "paused", pausedReason: "host-budget", resumesAt: at(9, 30) }, "自动处理已暂停：这台电脑一小时内已唤醒评论助手 20 次，09:30 自动恢复。"],
      [{ state: "paused", pausedReason: "agent", error: "评论助手不存在或已归档。" }, "自动处理已暂停：评论助手不存在或已归档。"],
    ];
    for (const [wake, text] of lines) expect(wakeLine(status(wake), now)).toBe(text);
    expect(wakeNotices(status({ lastBudgetPause: { from: at(8, 1), to: at(8, 40) }, staleSettledAt: at(8, 50) }), now)).toEqual(["自动处理曾因频率上限暂停（08:01–08:40）。", "上次唤醒没有确认结束，已解除等待。"]);
  });
  it("raises the toolbar dot for problems that need the human, not for a human pause", () => {
    expect(inboxSummary(status({ state: "paused", pausedReason: "human" }))).toEqual({ attention: false, detail: "查看访客评论和回复，设置 agent 自动处理" });
    expect(inboxSummary(status({ state: "paused", pausedReason: "budget" }))).toEqual({ attention: true, detail: "自动处理已暂停或同步出错，点开查看" });
    expect(inboxSummary(status({}, [source({ state: "quota" })])).attention).toBe(true);
    expect(inboxSummary(status({}, [source()], { replies: { sending: 0, drafts: 0, failed: 1, items: [] } })).attention).toBe(true);
    expect(inboxSummary(undefined).attention).toBe(false);
  });
  it("extracts the guard reason for the override confirm", () => {
    expect(guardReason("回复看起来包含私密信息（令牌），未发送。")).toBe("令牌");
    expect(guardReason("别的错误")).toBeUndefined();
  });
});
