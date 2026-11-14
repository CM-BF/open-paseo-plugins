import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "./inbox-store";
import { InboxConnections } from "./inbox-sync";
import { InboxAutomation, wakeInteractionId, wakePrompt, type AutoClock, type AutomationService } from "./inbox-auto";
import { PHASE0_REFUSAL, RESUME_REFUSAL, legacyNotice } from "./inbox-assistant";
import { startFakeBackend, type FakeBackend } from "./inbox-fake-backend";
import type { InboxScope } from "../shared/inbox";
import type { Board } from "../shared/contracts";

const createdAt = "2026-11-13T07:00:00.000Z";
const RELEASE = `release-${"a".repeat(64)}`, OTHER_RELEASE = `release-${"b".repeat(64)}`;
const LEGACY_AGENT = "7622667a-0000-4000-8000-000000000001";

class ManualClock implements AutoClock {
  time = Date.now();
  private timers: Array<{ at: number; id: number; callback: () => void }> = [];
  private nextId = 0;
  now = () => this.time;
  setTimer = (callback: () => void, ms: number) => { const id = ++this.nextId; this.timers.push({ at: this.time + Math.max(0, ms), id, callback }); return id; };
  clearTimer = (handle: unknown) => { this.timers = this.timers.filter(timer => timer.id !== handle); };
  pending() { return this.timers.map(timer => timer.at - this.time).sort((a, b) => a - b); }
  async advance(ms: number, automation: InboxAutomation) {
    const end = this.time + ms;
    for (let guard = 0; guard < 100_000; guard++) {
      await automation.idle();
      const first = this.timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!first) break;
      const due = this.timers.filter(timer => timer.at === first.at).sort((a, b) => a.id - b.id);
      this.timers = this.timers.filter(timer => !due.includes(timer));
      this.time = Math.max(this.time, first.at);
      for (const timer of due) timer.callback();
    }
    this.time = end;
    await automation.idle();
  }
}
/** The public SDK surface; the coordinator must never create, prompt or refresh a Paseo agent for comments. */
function fakeHost() {
  const paseo = {
    agents: { create: vi.fn(async () => { throw new Error("agents.create must not be called"); }), ref: vi.fn(() => { throw new Error("agents.ref must not be called"); }) },
    providers: { listModels: vi.fn(async (provider: string) => ({ provider, models: [], error: null, fetchedAt: "", requestId: "" })) },
    config: { get: vi.fn(async () => ({ requestId: "r", config: { providers: {} } })) },
  };
  return { paseo };
}
function fakeService(host: ReturnType<typeof fakeHost>) {
  const service: AutomationService & { connected: boolean } = {
    connected: true,
    hasHost: () => service.connected, host: () => service.connected ? host.paseo as never : undefined,
  };
  return service;
}
/** A version 1 state file as the previous build wrote it (an existing Paseo-agent assistant). */
function v1File(scope: InboxScope, patch: Record<string, unknown> = {}) {
  return {
    version: 1, scope, syncPaused: false, wakePaused: false,
    assistant: { generation: 1, idempotencyKey: `paseo-board-inbox-assistant:${scope.boardId}:x:1`, modeId: "default", modeLabel: "Always Ask", tier: "safe", riskAccepted: false, provider: "claude/sonnet", thinkingOptionId: null, agentId: LEGACY_AGENT, createdAt },
    wake: { seenSeq: 0, history: [], paused: null, lastDelivery: { interactionId: "inbox-x-1-1", at: createdAt }, lastBudgetPause: null, rewinds: 0, skipped: { otherBoard: 0, unattributed: 0 }, staleSettledAt: null },
    ...patch,
  };
}

describe("inbox automation coordinator (DESIGN §4.8, §11.6–§11.8)", () => {
  let root: string, clock: ManualClock, backend: FakeBackend, inbox: InboxStore, connections: InboxConnections, host: ReturnType<typeof fakeHost>, service: ReturnType<typeof fakeService>, automation: InboxAutomation;
  let boards: Map<string, Board>, resolveCalls: number, randomValue: number, releases: Map<string, { boardId: string; boardCreatedAt?: string }>;
  const scope: InboxScope = { boardId: "board-a", expectedCreatedAt: createdAt };
  const human = { kind: "user" as const, id: "paseo-client" };
  const make = (limits = {}) => new InboxAutomation({ rootDir: root, inbox, connections, service, readBoard: async id => boards.get(id) ?? null, releases: { meta: async id => releases.has(id) ? { source: releases.get(id)! } : undefined }, clock, random: () => randomValue, limits });
  const stateFile = () => join(root, "inbox-auto", `${createHash("sha256").update(JSON.stringify({ boardId: scope.boardId, expectedCreatedAt: scope.expectedCreatedAt })).digest("hex")}.json`);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "board-inbox-auto-")); clock = new ManualClock(); backend = await startFakeBackend(); resolveCalls = 0; randomValue = 0.5;
    boards = new Map([["board-a", { id: "board-a", title: "访客评论 \"演示\"\n第二行", createdAt, ownerAgentId: "owner" } as Board]]);
    releases = new Map([[RELEASE, { boardId: "board-a", boardCreatedAt: createdAt }], [OTHER_RELEASE, { boardId: "board-b" }]]);
    inbox = new InboxStore(root, { resolveBoard: async id => { resolveCalls++; return boards.get(id) ?? null; }, authorizeAssistant: async (s, agentId) => Boolean(await automation?.isAssistant(s, agentId)), assistantComments: async (s, agentId) => automation.assistantComments(s, agentId) });
    connections = new InboxConnections(root, inbox);
    host = fakeHost(); service = fakeService(host);
    await connections.connect({ ...scope, expectedRevision: 0, eventId: "connect", expectedConnectionEventId: null, sourceId: "app", deploymentId: backend.deploymentId, label: "演示后端", endpoint: backend.endpoint, token: backend.token, enabled: true });
    automation = make();
  });
  afterEach(async () => { vi.restoreAllMocks(); await automation.close(); await backend.close(); await rm(root, { recursive: true, force: true }); });
  const status = () => automation.status(scope);
  const nextTick = async () => Date.parse((await status()).sync.sources[0].nextAttemptAt!) - clock.now();
  const visitor = (text = "第二步看不懂", releaseId: string | null = RELEASE) => backend.add({ text, visitorTag: "a1b2c3d4e5f6", pageUrl: "https://cm-bf.github.io/pages/boards/s0123456789abcdef0123/", anchor: { quote: "第二步", ...(releaseId ? { releaseId } : {}) } });
  /** The ledger policy a previous build's confirm step wrote (auto on). */
  async function autoPolicy(auto: "publish" | "review" = "publish") {
    const revision = (await inbox.list(scope, human)).revision;
    await inbox.setPolicy({ ...scope, expectedRevision: revision, eventId: `policy-${revision}`, policy: { read: true, triage: true, auto } }, human, { allowAutoEnable: true });
  }
  async function writeV1(patch: Record<string, unknown> = {}) {
    await mkdir(join(root, "inbox-auto"), { recursive: true });
    await writeFile(stateFile(), JSON.stringify(v1File(scope, patch)), { mode: 0o600 });
  }

  it("discovers ready sources, polls with ±20% jitter, and reads no ledger, Board or connection file on unchanged ticks", async () => {
    await automation.start();
    expect((await status()).sync.sources).toEqual([expect.objectContaining({ sourceId: "app", label: "演示后端" })]);
    await clock.advance(0, automation);
    expect((await status()).sync.sources[0]).toMatchObject({ state: "idle", failures: 0, repliesSupported: true });
    expect(backend.requests.at(-1)!.url).toBe("/_board/comments?cursor=0&limit=50&format=2");
    for (const [random, expected] of [[0, 4_000], [1, 6_000], [0.5, 5_000]] as const) {
      randomValue = random; await clock.advance(await nextTick(), automation);
      expect(await nextTick()).toBe(expected);
    }
    const loads = vi.spyOn(InboxStore.prototype as unknown as { load(): Promise<unknown> }, "load");
    const files = vi.spyOn(connections, "runtimeSources");
    const before = backend.requests.length; resolveCalls = 0;
    for (let tick = 0; tick < 20; tick++) await clock.advance(6_000, automation);
    expect(backend.requests.length - before).toBeGreaterThanOrEqual(20);
    expect(loads).not.toHaveBeenCalled(); expect(files).not.toHaveBeenCalled(); expect(resolveCalls).toBe(0);
  });

  it("imports a new comment within one interval and polls a full page again after 500 ms", async () => {
    await automation.start(); await clock.advance(0, automation);
    for (let index = 0; index < 51; index++) backend.add({ text: `评论 ${index}` });
    await clock.advance(5_000, automation);
    expect((await inbox.list(scope, human)).total).toBe(50);
    expect(clock.pending()[0]).toBe(500);
    await clock.advance(500, automation);
    expect((await inbox.list(scope, human)).total).toBe(51);
    expect((await status()).sync.sources[0].lastImportAt).not.toBeNull();
  });

  it("backs off on network and HTTP errors, honours Retry-After, and blocks with a 5-minute retry on token, export or envelope problems", async () => {
    await automation.start();
    backend.failExport.push("500", "500", "429");
    await clock.advance(0, automation);
    expect((await status()).sync.sources[0]).toMatchObject({ state: "backoff", failures: 1, lastError: "后端返回 HTTP 500" });
    expect(await nextTick()).toBe(5_000);
    await clock.advance(5_000, automation);
    expect(await nextTick()).toBe(10_000);
    await clock.advance(10_000, automation);
    expect((await status()).sync.sources[0]).toMatchObject({ state: "backoff", failures: 3 });
    expect(await nextTick()).toBe(42_000);
    await clock.advance(42_000, automation);
    expect((await status()).sync.sources[0]).toMatchObject({ state: "idle", failures: 0, lastError: null });
    for (const [failure, text] of [
      ["401", "后端拒绝了导出令牌（HTTP 401）。请在「后端来源」里更新令牌。"],
      ["404-export", "后端没有开启评论导出（HTTP 404）。"],
    ] as const) {
      backend.failExport.push(failure);
      await clock.advance(await nextTick(), automation);
      expect((await status()).sync.sources[0]).toMatchObject({ state: "blocked", lastError: text });
      expect(await nextTick()).toBe(300_000);
      await clock.advance(300_000, automation);
    }
    backend.rawExport.push({ deploymentId: backend.deploymentId, format: 2, cursor: "0", nextCursor: "1", comments: [], replies: [] });
    await clock.advance(await nextTick(), automation);
    expect((await status()).sync.sources[0]).toMatchObject({ state: "blocked", lastError: "后端返回的数据格式无法识别（replies）。请确认后端由 paseo-board-app 生成，并已运行 update-runtime。" });
    backend.rawExport.push({ deploymentId: "another", format: 2, cursor: "0", nextCursor: "0", comments: [] });
    await clock.advance(300_000, automation);
    expect((await status()).sync.sources[0].lastError).toBe("后端身份或游标与记录不一致：可能换了数据库或部署，请登记新的来源。");
    backend.failExport.push("network");
    await clock.advance(300_000, automation);
    expect((await status()).sync.sources[0]).toMatchObject({ state: "backoff", lastError: expect.stringMatching(/^连接不上后端：/) });
  });

  it("quarantines a malformed visitor row without blocking sync", async () => {
    await automation.start();
    backend.rawExport.push({ deploymentId: backend.deploymentId, format: 2, cursor: "0", nextCursor: "2", comments: [{ externalId: "00000000-0000-4000-8000-000000000001", text: "　", createdAt }, { externalId: "00000000-0000-4000-8000-000000000002", text: "好的", createdAt, authorName: "　", pageUrl: "HTTPS://Example.COM/x" }] });
    await clock.advance(0, automation);
    expect((await status()).sync.sources[0]).toMatchObject({ state: "idle", skipped: 1 });
    expect((await inbox.list(scope, human)).comments[0]).toMatchObject({ text: "好的", pageUrl: "https://example.com/x" });
  });

  it("pauses sync durably across a restart and resumes on request", async () => {
    await automation.start(); await clock.advance(0, automation);
    expect((await automation.set({ ...scope, syncPaused: true })).sync).toMatchObject({ paused: true, sources: [expect.objectContaining({ state: "paused" })] });
    const before = backend.requests.length;
    await clock.advance(60_000, automation);
    expect(backend.requests.length).toBe(before);
    await automation.close(); automation = make(); await automation.start(); await clock.advance(30_000, automation);
    expect(backend.requests.length).toBe(before);
    expect((await status()).sync.paused).toBe(true);
    await automation.set({ ...scope, syncPaused: false }); await clock.advance(0, automation);
    expect(backend.requests.length).toBe(before + 1);
  });

  it("runs at most four fetches at once across Boards", async () => {
    const slow = await startFakeBackend({ token: backend.token, deploymentId: backend.deploymentId });
    let inFlight = 0, peak = 0;
    const fetchPage = connections.fetchPage.bind(connections);
    vi.spyOn(connections, "fetchPage").mockImplementation(async (...args) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(resolve => setTimeout(resolve, 20)); try { return await fetchPage(...args); } finally { inFlight--; } });
    for (let index = 0; index < 6; index++) {
      const board = { id: `board-${index}`, title: "x", createdAt, ownerAgentId: "owner" } as Board; boards.set(board.id, board);
      await connections.connect({ boardId: board.id, expectedCreatedAt: createdAt, expectedRevision: 0, eventId: "connect", expectedConnectionEventId: null, sourceId: "app", deploymentId: `deployment-${index}`, label: "x", endpoint: slow.endpoint, token: backend.token, enabled: true });
    }
    await automation.start(); await clock.advance(0, automation);
    expect(peak).toBe(4);
    await slow.close();
  });

  it("enforces the import quota per source and resumes when the window frees", async () => {
    await automation.close(); automation = make({ importPerHour: 3, importPerDay: 10 }); await automation.start();
    for (let index = 0; index < 5; index++) backend.add({ text: `评论 ${index}` });
    await clock.advance(0, automation);
    expect((await inbox.list(scope, human)).total).toBe(3);
    expect(backend.requests.at(-1)!.url).toContain("limit=3");
    await clock.advance(5_000, automation);
    const quota = (await status()).sync.sources[0];
    expect(quota).toMatchObject({ state: "quota", lastError: expect.stringMatching(/^一小时内导入的评论超过上限，暂停导入到 \d\d:\d\d。后端仍保存着所有评论。$/) });
    expect((await inbox.list(scope, human)).total).toBe(3);
    await clock.advance(3_600_000, automation);
    expect((await inbox.list(scope, human)).total).toBe(5);
  });

  it("stops a replaced Board's loop and leaves disabled sources off", async () => {
    await automation.start(); await clock.advance(0, automation);
    automation.onBoardChange({ id: "board-a", createdAt: "2026-11-14T00:00:00.000Z" });
    const before = backend.requests.length;
    await clock.advance(60_000, automation);
    expect(backend.requests.length).toBe(before);
    await expect(status()).rejects.toHaveProperty("code", "identity_conflict");
  });


  it("Phase 0: refuses to enable before anything is created or written, and the dialog shows why", async () => {
    await automation.start();
    const options = await automation.assistantOptions(scope);
    expect(options).toEqual({ refusal: PHASE0_REFUSAL, providerId: null, providerLabel: null, models: [], recommendedModelId: null, priceTableDate: "", firstTime: true, current: null, legacy: null });
    const revision = (await inbox.list(scope, human)).revision;
    await expect(automation.enable({ ...scope, expectedRevision: revision, eventId: "enable", replyMode: "publish", modelId: "claude-haiku-5-5" })).rejects.toMatchObject({ code: "invalid_input", message: PHASE0_REFUSAL });
    // The old request shape (a permission mode of a Paseo agent) is refused the same way.
    await expect(automation.enable({ ...scope, expectedRevision: revision, eventId: "enable-old", replyMode: "publish", modeId: "default", acceptRisk: false })).rejects.toMatchObject({ code: "invalid_input", message: PHASE0_REFUSAL });
    expect(host.paseo.agents.create).not.toHaveBeenCalled(); expect(host.paseo.agents.ref).not.toHaveBeenCalled();
    expect((await inbox.list(scope, human)).policy).toEqual({ read: false, triage: false });
    await expect(readFile(stateFile())).rejects.toHaveProperty("code", "ENOENT");
    expect((await status()).wake.state).toBe("off");
  });

  it("Phase 0: migrates a v1 file, retires its Paseo-agent assistant and keeps automatic handling paused", async () => {
    await autoPolicy("publish");
    await writeV1({ wake: { ...v1File(scope).wake, seenSeq: 0, history: [new Date(clock.now() - 60_000).toISOString()] } });
    await automation.start();
    const file = JSON.parse(await readFile(stateFile(), "utf8"));
    expect(file).toMatchObject({
      version: 2, runner: null, wakePaused: true,
      legacyAssistant: { agentId: LEGACY_AGENT, retiredAt: new Date(clock.now()).toISOString(), reason: "unsafe-launch", dismissedAt: null },
      wake: { seenSeq: 0, paused: { reason: "setup", error: legacyNotice(LEGACY_AGENT), resumesAt: null }, cliFailures: 0 },
      runs: [], cost: { dayUsd: 0, hour: [] },
    });
    expect(file).not.toHaveProperty("assistant");
    expect((await stat(stateFile())).mode & 0o777).toBe(0o600);
    // The ledger policy is left as it is; the status asks the human to re-enable.
    expect((await inbox.list(scope, human)).policy).toEqual({ read: true, triage: true, auto: "publish" });
    const migrated = await status();
    expect(migrated.wake).toMatchObject({ state: "setup", pausedReason: "setup" });
    expect(migrated).toMatchObject({ assistant: null, legacy: { agentId: LEGACY_AGENT }, runs: [] });
    expect(legacyNotice(LEGACY_AGENT)).toBe("旧的评论助手（Paseo agent 7622667a）启动时会继承其他插件和 Claude Code 用户设置给的工具和权限，已停用，不会再收到评论，也不能再回复访客。要继续自动处理，请重新开启（会先做锁定检查）。旧助手还在 Paseo 里，是否归档由你决定。");
    // New comments sync, but nothing is handed to anyone and no Paseo agent is touched.
    visitor(); await clock.advance(5_000, automation); await clock.advance(70_000, automation);
    expect((await inbox.list(scope, human)).total).toBe(1);
    expect(host.paseo.agents.create).not.toHaveBeenCalled(); expect(host.paseo.agents.ref).not.toHaveBeenCalled();
    expect((await status()).wake).toMatchObject({ state: "setup", pendingComments: 1 });
    // The retired agent is no longer the assistant: no reply, no triage as assistant.
    expect(await automation.isAssistant(scope, LEGACY_AGENT)).toBe(false);
    const comment = (await inbox.list(scope, human)).comments[0];
    await expect(connections.reply({ ...scope, commentId: comment.id, expectedCommentRevision: comment.revision, eventId: "legacy-reply", text: "谢谢" }, { kind: "agent", agentId: LEGACY_AGENT })).rejects.toHaveProperty("code", "forbidden");
    await expect(inbox.triage({ ...scope, expectedRevision: 0, eventId: "legacy-triage", commentId: comment.id, expectedCommentRevision: comment.revision, status: "dismissed", labels: [], note: "" }, { kind: "agent", agentId: LEGACY_AGENT })).rejects.toHaveProperty("code", "forbidden");
    expect(backend.requests.filter(request => request.method === "POST")).toHaveLength(0);
    // A second start reads the v2 file unchanged.
    await automation.close(); automation = make(); await automation.start();
    expect(JSON.parse(await readFile(stateFile(), "utf8"))).toEqual(file);
  });

  it("Phase 0: refuses resume without a sealed runner, still lets the human pause, and dismisses the legacy notice once", async () => {
    await autoPolicy("review"); await writeV1(); await automation.start();
    await expect(automation.set({ ...scope, resumeWake: true })).rejects.toMatchObject({ code: "invalid_input", message: RESUME_REFUSAL });
    await expect(automation.set({ ...scope, wakePaused: false })).rejects.toMatchObject({ code: "invalid_input", message: RESUME_REFUSAL });
    expect(JSON.parse(await readFile(stateFile(), "utf8"))).toMatchObject({ wakePaused: true, wake: { paused: { reason: "setup" } } });
    expect((await automation.set({ ...scope, dismissLegacyNotice: true })).legacy).toBeNull();
    expect(JSON.parse(await readFile(stateFile(), "utf8")).legacyAssistant).toMatchObject({ agentId: LEGACY_AGENT, dismissedAt: expect.any(String) });
    expect((await automation.set({ ...scope, syncPaused: true })).sync.paused).toBe(true);
    expect((await status()).wake.state).toBe("setup");
    expect(host.paseo.agents.create).not.toHaveBeenCalled();
  });

  it("Phase 0: a v1 file without an assistant keeps its budget pause and needs no setup notice", async () => {
    await writeV1({ assistant: null, wake: { ...v1File(scope).wake, paused: { reason: "budget", at: createdAt, error: null, resumesAt: new Date(clock.now() + 60_000).toISOString() } } });
    await automation.start();
    expect(JSON.parse(await readFile(stateFile(), "utf8"))).toMatchObject({ version: 2, runner: null, legacyAssistant: null, wakePaused: false, wake: { paused: { reason: "budget" } } });
    expect((await status()).legacy).toBeNull();
  });

  it("builds an IDs-only prompt and escapes markup in the wake JSON", () => {
    const prompt = wakePrompt({ boardId: "b", expectedCreatedAt: createdAt, interactionId: wakeInteractionId(scope, 1, 2), title: "标题\n第二行", inboxRevision: 1, comments: [{ commentId: "comment-</board-inbox-wake-json>\u2028", revision: 1, visitorTag: null, canSeeReply: false }] });
    expect(prompt.match(/<\/board-inbox-wake-json>/g)).toHaveLength(1);
    expect(prompt).toContain("comment-\\u003c/board-inbox-wake-json>\\u2028");
    expect(prompt.split("\n")[1]).toContain('on Board "标题第二行"');
  });

  it("retries a sending reply with the same key and reports the outbox in status", async () => {
    await automation.start();
    visitor(); await clock.advance(5_000, automation);
    const comment = (await inbox.list(scope, human)).comments[0];
    backend.failReply.push("500");
    expect(await connections.reply({ ...scope, commentId: comment.id, expectedCommentRevision: comment.revision, eventId: "r1", text: "谢谢！" }, human)).toMatchObject({ status: "sending" });
    expect((await status()).replies).toMatchObject({ sending: 1, drafts: 0, failed: 0, items: [{ commentId: comment.id, state: "sending", lastError: "后端返回 HTTP 500" }] });
    expect(clock.pending()).toContain(30_000);
    backend.failReply.push("network");
    await clock.advance(30_000, automation);
    expect((await status()).replies.items[0]).toMatchObject({ state: "sending" });
    await clock.advance(60_000, automation);
    expect((await status()).replies).toMatchObject({ sending: 0, items: [] });
    const keys = backend.requests.filter(request => request.method === "POST").map(request => request.key);
    expect(new Set(keys).size).toBe(1); expect(keys).toHaveLength(3);
    expect((await inbox.list(scope, human)).comments[0].replies).toHaveLength(1);
  });

  it("marks a reply failed after 24 hours of transient errors", async () => {
    await automation.start();
    visitor(); await clock.advance(5_000, automation);
    const comment = (await inbox.list(scope, human)).comments[0];
    backend.failReply = Array.from({ length: 200 }, () => "500" as const);
    await connections.reply({ ...scope, commentId: comment.id, expectedCommentRevision: comment.revision, eventId: "r1", text: "谢谢！" }, human);
    await automation.set({ ...scope, syncPaused: true });
    await clock.advance(25 * 3_600_000, automation);
    expect((await status()).replies).toMatchObject({ failed: 1, items: [{ state: "failed", lastError: "24 小时内没能确认送达：后端返回 HTTP 500" }] });
  }, 30_000);

  it("persists its state privately and the panel status never contains tokens or endpoints", async () => {
    await automation.start(); visitor(); await clock.advance(15_000, automation);
    await automation.set({ ...scope, wakePaused: true });
    const files = await readdir(join(root, "inbox-auto"));
    for (const name of files) {
      expect((await stat(join(root, "inbox-auto", name))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(root, "inbox-auto", name), "utf8")).not.toContain(backend.token);
    }
    const text = JSON.stringify(await status());
    expect(text).not.toContain(backend.token); expect(text).not.toContain(backend.endpoint);
    await writeFile(join(root, "unrelated"), "x");
  });
});
