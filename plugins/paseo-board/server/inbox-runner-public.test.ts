import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { ServiceJournal } from "./journal";
import { HIDDEN_PUBLIC, InboxStore } from "./inbox-store";
import { InboxConnections } from "./inbox-sync";
import { InboxAutomation, type AutoClock } from "./inbox-auto";
import { ALLOWED_TOOLS, PREFLIGHT_PROMPT } from "./inbox-lock";
import { RunnerBindings, SealedRunner, type RunnerBinding, type StreamExec } from "./inbox-runner";
import { startFakeBackend, type FakeBackend, type FakeRow } from "./inbox-fake-backend";
import type { InboxScope } from "../shared/inbox";

/*
 * The sealed comment runner and public comment threads together (merge of sw/board-page-comments and sw/bpc-public):
 * the real coordinator, store, sync, SealedRunner and BoardService.executeRunner (the bridge's runner path), with a
 * fake `claude -p` whose model acts only through executeRunner, as the MCP bridge would.
 */
const RELEASE = `release-${"a".repeat(64)}`;
const PAGE = "https://cm-bf.github.io/pages/boards/s0123456789abcdef0123/";
const PRIVATE_PAGE = "https://cm-bf.github.io/pages/boards/s0123456789abcdef9999/";
const PRIVATE_TEXT = "私密：我的电话是 13800000000，请只回复我";
const A = "aaaaaaaaaaaa", B = "bbbbbbbbbbbb", C = "cccccccccccc", D = "dddddddddddd", E = "eeeeeeeeeeee";
const tagOf = (visitor: string) => visitor.replace(/./g, (char, index) => "0123456789abcdef"[(char.charCodeAt(0) + index) % 16]);

class ManualClock implements AutoClock {
  time = Date.now();
  private timers: Array<{ at: number; id: number; callback: () => void }> = [];
  private nextId = 0;
  now = () => this.time;
  setTimer = (callback: () => void, ms: number) => { const id = ++this.nextId; this.timers.push({ at: this.time + Math.max(0, ms), id, callback }); return id; };
  clearTimer = (handle: unknown) => { this.timers = this.timers.filter(timer => timer.id !== handle); };
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

type WakeComment = { commentId: string; revision: number; visitorTag: string | null; canSeeReply: boolean; visibility: "public" | "private" };
type Wake = { boardId: string; expectedCreatedAt: string; inboxRevision: number; comments: WakeComment[] };
type View = { id: string; revision: number; text: string; visibility: "public" | "private"; parentCommentId?: string; thread?: { root: { commentId: string; text: string }; replies: Array<{ kind: string; text: string; commentId?: string }> } | null };
type Run = { stdin: string; wake: Wake; binding: RunnerBinding; reads: View[]; outcomes: Array<{ commentId: string; status?: string; error?: { code: string; message: string } }> };
type Model = (run: Run, call: (operation: "inbox_list" | "inbox_read" | "inbox_triage" | "inbox_reply", input: Record<string, unknown>) => Promise<unknown>) => Promise<void>;

describe("the sealed runner in public comment threads", () => {
  let root: string, clock: ManualClock, backend: FakeBackend, store: BoardStore, journal: ServiceJournal, service: BoardService;
  let inbox: InboxStore, connections: InboxConnections, bindings: RunnerBindings, automation: InboxAutomation, scope: InboxScope;
  let runs: Run[], model: Model;
  const human = { kind: "user" as const, id: "paseo-client" };

  /** The model of a run: reads every comment of its batch through the runner path and replies to each. */
  const replying = (text = (view: View) => `谢谢，关于「${view.text.slice(0, 6)}」我们会补充说明。`): Model => async (run, call) => {
    for (const item of run.wake.comments) {
      const view = (await call("inbox_read", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId }) as { comment: View }).comment;
      run.reads.push(view);
      try {
        const result = await call("inbox_reply", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId, expectedCommentRevision: view.revision, eventId: `reply-${item.commentId}-${runs.length}`, text: text(view) }) as { status: string };
        run.outcomes.push({ commentId: item.commentId, status: result.status });
      } catch (error) { run.outcomes.push({ commentId: item.commentId, error: { code: (error as { code: string }).code, message: (error as Error).message } }); }
    }
  };
  /** A fake `claude -p` launched by the real SealedRunner: a locked init, then the model through executeRunner. */
  const exec: StreamExec = (argv, options) => {
    const emit = (value: unknown) => options.onLine(JSON.stringify(value));
    const token = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]).mcpServers.paseo_board.env.PASEO_BOARD_BINDING as string;
    const preflight = options.stdin === PREFLIGHT_PROMPT;
    const work = (async () => {
      emit({ type: "system", subtype: "init", cwd: options.cwd, original_cwd: options.cwd, tools: ALLOWED_TOOLS, mcp_servers: [{ name: "paseo_board", status: "connected" }], model: argv[argv.indexOf("--model") + 1], permissionMode: "dontAsk", slash_commands: [], skills: [], plugins: [], output_style: "default", claude_code_version: "2.1.325" });
      if (!preflight) {
        await Promise.resolve();
        const binding = bindings.get(token)!;
        const wake = JSON.parse(options.stdin.split("<board-inbox-wake-json>\n")[1].split("\n</board-inbox-wake-json>")[0]) as Wake;
        const run: Run = { stdin: options.stdin, wake, binding, reads: [], outcomes: [] };
        runs.push(run);
        await model(run, (operation, input) => service.executeRunner(operation, input, binding));
      }
      emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: preflight ? 0.0005 : 0.004, num_turns: 2, result: "ok" });
      return { code: 0, signal: null };
    })();
    return { kill: () => undefined, exited: work };
  };
  const host = {
    agents: { create: vi.fn(async () => { throw new Error("agents.create must not be called"); }) },
    providers: { listModels: vi.fn(async (provider: string) => ({ provider, models: [{ provider: "claude", id: "claude-haiku-5-5", label: "Haiku 5.5" }], error: null, fetchedAt: "", requestId: "" })) },
    config: { get: vi.fn(async () => ({ requestId: "r", config: { providers: {} } })) },
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "board-runner-public-")); clock = new ManualClock(); backend = await startFakeBackend(); runs = []; model = replying();
    store = new BoardStore(root); await store.init(); journal = new ServiceJournal(join(root, "service.json")); await journal.init();
    service = new BoardService(store, journal, () => undefined);
    const board = await store.create({ id: "board", title: "公开讨论", ownerAgentId: "owner", html: "<main>x</main>" });
    scope = { boardId: board.id, expectedCreatedAt: board.createdAt };
    bindings = new RunnerBindings();
    inbox = new InboxStore(root, {
      resolveBoard: id => store.read(id),
      authorizeAssistant: async (s, agentId) => Boolean(await automation?.isAssistant(s, agentId)),
      assistantComments: async (s, agentId) => automation.assistantComments(s, agentId),
      assistantPublicDirect: async s => automation.publicDirect(s),
    });
    connections = new InboxConnections(root, inbox);
    service.useInbox(inbox); service.useInboxConnections(connections); service.useRunnerBindings(bindings);
    const runner = new SealedRunner({ bindings, mcpCommand: "/opt/paseo/paseo-board/bin/paseo-board-mcp", exec, env: { HOME: "/h" } });
    automation = new InboxAutomation({
      rootDir: root, inbox, connections, readBoard: id => store.read(id), runner, bindings, clock, random: () => 0.5, limits: { syncIntervalMs: 1_000, jitter: 0 },
      service: { hasHost: () => true, host: () => host as never },
      releases: { meta: async id => id === RELEASE ? { source: { boardId: scope.boardId, boardCreatedAt: scope.expectedCreatedAt } } : undefined },
    });
    await connections.connect({ ...scope, expectedRevision: 0, eventId: "connect", expectedConnectionEventId: null, sourceId: "app", deploymentId: backend.deploymentId, label: "演示后端", endpoint: backend.endpoint, token: backend.token, enabled: true });
    await automation.start();
  });
  afterEach(async () => { await automation.close(); await service.dispose(); await backend.close(); await rm(root, { recursive: true, force: true }); });

  const enable = async (replyMode: "publish" | "review" = "publish", extra: Record<string, unknown> = {}) => {
    const revision = (await inbox.list(scope, human)).revision;
    return automation.enable({ ...scope, expectedRevision: revision, eventId: `enable-${revision}-${clock.now()}`, replyMode, modelId: "claude-haiku-5-5", ...extra });
  };
  /** A visitor's comment on the backend: public ones carry the page tag, a reply its root's external ID. */
  const post = (visitor: string, text: string, extra: Partial<FakeRow> & { public?: boolean } = {}) => {
    const { public: isPublic, ...rest } = extra;
    return backend.add({ text, visitorTag: visitor, pageUrl: isPublic === false ? PRIVATE_PAGE : PAGE, anchor: rest.parentId ? { releaseId: RELEASE } : { quote: "第二步", releaseId: RELEASE }, ...(isPublic === false ? {} : { visibility: "public" as const, publicTag: tagOf(visitor) }), ...rest });
  };
  const settle = async () => { await clock.advance(1_000, automation); await clock.advance(15_000, automation); };
  const byText = async (text: string) => (await inbox.list({ ...scope, limit: 100 }, human)).comments.find(comment => comment.text === text)!;
  const runTexts = async () => Promise.all(runs.map(async run => Promise.all(run.wake.comments.map(async item => (await inbox.read({ ...scope, commentId: item.commentId }, human)).comment.text))));

  it("never mixes private and public comments in one run, wakes for visible visitor replies, and never for hidden ones", async () => {
    await enable("publish");
    const root1 = post(A, "第二步看不懂，能解释一下吗？");
    post(A, PRIVATE_TEXT, { public: false });
    post(A, "第三步也看不懂");
    post(A, "再问一个私密问题", { public: false });
    post(B, "我也不懂第二步", { parentId: root1.externalId });
    const hiddenRoot = post(C, "广告：点这里", { hidden: true });
    post(D, "回复被隐藏的讨论", { parentId: hiddenRoot.externalId });
    post(E, "我撤回了这条", { parentId: root1.externalId, withdrawn: true, hidden: true });
    post(A, "补充：第二步是指保存吗？", { parentId: root1.externalId });
    await settle();
    // One visitor and one visibility per run, in order; hidden, withdrawn and hidden-thread comments never run.
    expect(await runTexts()).toEqual([["第二步看不懂，能解释一下吗？"], [PRIVATE_TEXT], ["第三步也看不懂"], ["再问一个私密问题"], ["我也不懂第二步"], ["补充：第二步是指保存吗？"]]);
    for (const run of runs) expect(new Set(run.wake.comments.map(item => item.visibility)).size).toBe(1);
    expect(runs.map(run => run.wake.comments[0].visibility)).toEqual(["public", "private", "public", "private", "public", "public"]);
    // The stdin holds IDs only, and the run's prompt tells the model what a public comment means.
    for (const run of runs) for (const text of ["第二步看不懂", "13800000000", "广告"]) expect(run.stdin).not.toContain(text);
    expect(runs[0].stdin).toContain('A comment with visibility "public" is part of a public discussion');
    for (const text of ["广告：点这里", "回复被隐藏的讨论", "我撤回了这条"]) expect((await byText(text)).status).toBe("new");
    // A public comment the human hides after its import (before the debounce) is skipped as well.
    const before = runs.length;
    post(C, "又一条广告");
    await clock.advance(1_000, automation);
    const spam = await byText("又一条广告");
    await inbox.setPublicState({ ...scope, eventId: "hide-spam", sourceId: "app", externalId: spam.externalId, hidden: true }, human);
    await clock.advance(15_000, automation);
    expect(runs).toHaveLength(before);
    expect((await automation.status(scope)).wake).toMatchObject({ state: "idle", pendingComments: 0 });
  }, 30_000);

  it("reads the visible public thread, never a private or hidden comment, and cannot quote private text into a public reply", async () => {
    await enable("publish");
    const root1 = post(A, "第二步看不懂，能解释一下吗？");
    post(A, PRIVATE_TEXT, { public: false });
    await settle();
    // The private comment was answered directly (publish mode); the public root's reply is a draft the human publishes.
    expect(runs.map(run => run.outcomes.map(outcome => outcome.status))).toEqual([["draft"], ["published"]]);
    const rootComment = await byText("第二步看不懂，能解释一下吗？");
    const published = await connections.replyPending({ ...scope, eventId: "publish-draft", commentId: rootComment.id, key: rootComment.pendingReply!.key, action: "publish" });
    expect(published.status).toBe("published");
    const HIDDEN_TEXT = "这条回复后来被作者隐藏了，里面写着不该公开的内容";
    post(C, HIDDEN_TEXT, { parentId: root1.externalId, hidden: true });
    model = async (run, call) => {
      const item = run.wake.comments[0];
      const view = (await call("inbox_read", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId }) as { comment: View }).comment;
      run.reads.push(view);
      // A private comment of the same visitor (or any hidden one) may not be quoted into a public reply.
      for (const text of [`你说过“${PRIVATE_TEXT}”`, `关于“${HIDDEN_TEXT}”这件事`, "谢谢，第二步是指先保存草稿。"]) {
        await call("inbox_reply", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId, expectedCommentRevision: view.revision, eventId: `reply-${item.commentId}-${text.length}`, text }).then(
          result => run.outcomes.push({ commentId: item.commentId, status: (result as { status: string }).status }),
          error => run.outcomes.push({ commentId: item.commentId, error: { code: error.code, message: error.message } }));
      }
    };
    // Explicit times keep the thread's order independent of the millisecond the draft was published in.
    post(A, "补充：第二步是指保存吗？", { parentId: root1.externalId, createdAt: new Date(Date.now() + 60_000).toISOString() });
    post(B, "我也不懂第二步", { parentId: root1.externalId, createdAt: new Date(Date.now() + 61_000).toISOString() });
    await settle();
    const [mine, theirs] = runs.slice(2);
    expect([mine, theirs].map(run => run.reads[0].text)).toEqual(["补充：第二步是指保存吗？", "我也不懂第二步"]);
    const view = theirs.reads[0];
    expect(view).toMatchObject({ visibility: "public", parentCommentId: rootComment.id });
    expect(view.thread!.root).toMatchObject({ commentId: rootComment.id, text: "第二步看不懂，能解释一下吗？" });
    // Root, the visible visitor replies and the assistant's published reply: what every visitor already sees.
    expect(view.thread!.replies.map(item => [item.kind, item.text])).toEqual([["agent", "谢谢，关于「第二步看不懂」我们会补充说明。"], ["visitor", "补充：第二步是指保存吗？"], ["visitor", "我也不懂第二步"]]);
    // Public runs never see the private comment (the private run reads its own batch) or the hidden reply.
    for (const run of runs.filter(item => item.wake.comments[0].visibility === "public")) for (const read of run.reads) for (const text of ["13800000000", "不该公开的内容"]) expect(JSON.stringify(read)).not.toContain(text);
    for (const read of runs[1].reads) expect(JSON.stringify(read)).not.toContain("不该公开的内容");
    // Quoting the visitor's own private comment or a hidden reply is refused with the exact text; the plain reply is a draft.
    const QUOTE_REFUSAL = "回复里有一段和私密或已隐藏评论相同（连续 16 个字以上）。公开讨论里所有访客都能看到回复，请换一种说法。";
    for (const run of [mine, theirs]) expect(run.outcomes.map(outcome => outcome.status ?? outcome.error!.message)).toEqual([QUOTE_REFUSAL, QUOTE_REFUSAL, "draft"]);
    expect(backend.requests.filter(request => request.method === "POST").map(request => JSON.stringify(request.body)).join("\n")).not.toContain("13800000000");
    // A private comment's view has no thread and says it is private.
    const privateRead = runs[1].reads[0];
    expect(privateRead).toMatchObject({ visibility: "private" }); expect(privateRead).not.toHaveProperty("thread");
    const status = await automation.status(scope);
    expect(status.runs[0]).toMatchObject({ state: "done", actions: { replied: 0, drafted: 1 } });
  }, 30_000);

  it("public replies are drafts by default and go out directly only with the owner's per-Board opt-in, in 直接公开 mode", async () => {
    await enable("publish");
    expect((await automation.status(scope)).publicDirect).toBe(false);
    post(A, "公开问题一");
    await settle();
    expect(runs.at(-1)!.outcomes.map(outcome => outcome.status)).toEqual(["draft"]);
    // The human's opt-in (auto-set, a host-user RPC): stored per Board and shown in the status.
    expect((await automation.set({ ...scope, publicDirect: true })).publicDirect).toBe(true);
    post(B, "公开问题二");
    post(B, "私密问题二", { public: false });
    await settle();
    expect(runs.slice(-2).map(run => [run.wake.comments[0].visibility, run.outcomes[0].status])).toEqual([["public", "published"], ["private", "published"]]);
    expect((await byText("公开问题二")).replies?.[0]).toMatchObject({ authorKind: "agent" });
    // 先给我审核 keeps every assistant reply a draft, the opt-in notwithstanding.
    const revision = (await inbox.list(scope, human)).revision;
    await inbox.setPolicy({ ...scope, expectedRevision: revision, eventId: "review", policy: { read: true, triage: true, auto: "review" } }, human);
    automation.onPolicy(scope); await clock.advance(0, automation);
    post(C, "公开问题三");
    await settle();
    expect(runs.at(-1)!.outcomes.map(outcome => outcome.status)).toEqual(["draft"]);
    // Every enable confirms the choice again: off unless the dialog's box was ticked.
    await enable("publish");
    expect((await automation.status(scope)).publicDirect).toBe(false);
    post(D, "公开问题四");
    await settle();
    expect(runs.at(-1)!.outcomes.map(outcome => outcome.status)).toEqual(["draft"]);
    await enable("publish", { publicDirect: true });
    expect((await automation.status(scope)).publicDirect).toBe(true);
    await automation.set({ ...scope, publicDirect: false });
    expect((await automation.status(scope)).publicDirect).toBe(false);
  }, 30_000);

  it("cannot change what visitors see: its 不处理 stays internal, public state is human-only, and a comment hidden mid-run cannot be answered", async () => {
    await enable("publish");
    model = async (run, call) => {
      const item = run.wake.comments[0];
      const view = (await call("inbox_read", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId }) as { comment: View }).comment;
      run.reads.push(view);
      await call("inbox_triage", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, expectedRevision: run.wake.inboxRevision, eventId: `dismiss-${item.commentId}`, commentId: item.commentId, expectedCommentRevision: view.revision, status: "dismissed", labels: ["spam"], note: "像广告" });
      // No operation reaches public state; the store refuses the runner identity outright.
      for (const operation of ["publish", "emit", "read", "list"] as const) await expect(service.executeRunner(operation, { boardId: run.wake.boardId }, run.binding)).rejects.toHaveProperty("code", "forbidden");
      const comment = (await inbox.read({ ...scope, commentId: item.commentId }, human)).comment;
      await expect(inbox.setPublicState({ ...scope, eventId: "runner-hide", sourceId: "app", externalId: comment.externalId, hidden: true }, { kind: "agent", agentId: run.binding.actorId })).rejects.toHaveProperty("code", "forbidden");
      // The human hides it while the run is still going: the runner's reply is refused and its thread is gone.
      await inbox.setPublicState({ ...scope, eventId: "human-hide", sourceId: "app", externalId: comment.externalId, hidden: true }, human);
      const again = (await call("inbox_read", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId }) as { comment: View }).comment;
      run.reads.push(again);
      await call("inbox_reply", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId, expectedCommentRevision: again.revision, eventId: "after-hide", text: "我们会看看。" }).then(
        () => run.outcomes.push({ commentId: item.commentId, status: "sent" }),
        error => run.outcomes.push({ commentId: item.commentId, error: { code: error.code, message: error.message } }));
    };
    post(A, "买便宜的东西请加我");
    await settle();
    const [run] = runs;
    const comment = await byText("买便宜的东西请加我");
    // The runner's 不处理 stayed internal: only the human's later hide changed the page state.
    expect(comment).toMatchObject({ status: "dismissed", labels: ["spam"], publicState: { hidden: true, hiddenBy: "hide" } });
    expect(run.reads[0].thread).not.toBeNull(); expect(run.reads[1].thread).toBeNull();
    expect(run.outcomes).toEqual([{ commentId: comment.id, error: { code: "invalid_input", message: HIDDEN_PUBLIC } }]);
    expect(HIDDEN_PUBLIC).toBe("这条公开评论已经不在页面上显示（已隐藏、已撤回或所在讨论已隐藏），评论助手不能回复它。");
    expect(backend.requests.some(request => request.method === "POST" && request.url.includes("/replies"))).toBe(false);
    expect(host.agents.create).not.toHaveBeenCalled();
  }, 30_000);
});
