import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { BoardService, RUNNER_REPLIES_STOPPED } from "./service";
import { ServiceJournal } from "./journal";
import { HIDDEN_PUBLIC, InboxStore } from "./inbox-store";
import { InboxConnections, PUBLIC_CHECK_FAILED } from "./inbox-sync";
import { InboxAutomation, type AutoClock } from "./inbox-auto";
import { ALLOWED_TOOLS, PREFLIGHT_PROMPT } from "./inbox-lock";
import { RunnerBindings, SealedRunner, type RunnerBinding, type StreamExec } from "./inbox-runner";
import { startFakeBackend, type FakeBackend, type FakeRow } from "./inbox-fake-backend";
import type { InboxScope } from "../shared/inbox";
import { ReleaseRepository } from "./static-release";
import { PageContexts } from "./inbox-page-context";

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
type View = { page?: Record<string, unknown>; id: string; revision: number; text: string; visibility: "public" | "private"; parentCommentId?: string; offPage?: true; notice?: string; authorName?: string; anchor?: unknown; replies?: unknown[]; thread?: { root: { commentId: string; text: string }; replies: Array<{ kind: string; text: string; commentId?: string }> } | null };
type Run = { stdin: string; wake: Wake; binding: RunnerBinding; reads: View[]; outcomes: Array<{ commentId: string; status?: string; error?: { code: string; message: string } }> };
type Model = (run: Run, call: (operation: "inbox_list" | "inbox_read" | "inbox_triage" | "inbox_reply", input: Record<string, unknown>) => Promise<unknown>) => Promise<void>;

describe("the sealed runner in public comment threads", () => {
  let root: string, clock: ManualClock, backend: FakeBackend, store: BoardStore, journal: ServiceJournal, service: BoardService;
  let inbox: InboxStore, connections: InboxConnections, bindings: RunnerBindings, automation: InboxAutomation, scope: InboxScope;
  let runs: Run[], model: Model, ownReleases: Set<string>;
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
    root = await mkdtemp(join(tmpdir(), "board-runner-public-")); clock = new ManualClock(); backend = await startFakeBackend(); runs = []; model = replying(); ownReleases = new Set([RELEASE]);
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
      releases: { meta: async id => ownReleases.has(id) ? { source: { boardId: scope.boardId, boardCreatedAt: scope.expectedCreatedAt } } : undefined },
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

  it("reads the author's page text around the thread's passage, for a public root and a visitor reply in its thread (polish P3)", async () => {
    const board = (await store.read(scope.boardId))!;
    const repository = new ReleaseRepository(join(root, "releases"));
    const html = "<main><h1>评论测试页</h1><h2>评论存在哪里</h2><p>网页本身不保存评论。评论存在作者自己部署的评论后端里，作者的电脑关机以后访客仍然可以发评论。</p></main>";
    const release = await repository.create({ board: { ...board, canvas: { ...board.canvas, html, patches: [] } }, boardId: board.id, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, publicData: {}, comments: { apiBase: "https://api.example.internal", appKey: "0123456789abcdef", visibility: "public" } });
    const releaseId = release.manifest.releaseId;
    ownReleases.add(releaseId); service.usePageContexts(new PageContexts(repository));
    await enable("review");
    const root1 = post(A, "网页本身不保存评论，那评论存在哪里？", { anchor: { quote: "网页本身不保存评论", suffix: "。评论存在", releaseId } });
    post(B, "我也想知道：作者的电脑没开，新评论会不会丢？", { parentId: root1.externalId, anchor: { releaseId } });
    await settle();
    expect(runs.map(run => run.reads.map(view => view.text))).toEqual([["网页本身不保存评论，那评论存在哪里？"], ["我也想知道：作者的电脑没开，新评论会不会丢？"]]);
    // Both reads carry the author's text around the passage the thread is about (the reply via its root's anchor).
    for (const run of runs) expect(run.reads[0].page).toEqual({
      contentTrust: "author-published", notice: expect.stringContaining("author's local copy"), title: "公开讨论", section: "评论存在哪里",
      passageFound: true, before: "评论测试页\n评论存在哪里\n", passage: "网页本身不保存评论", after: "。评论存在作者自己部署的评论后端里，作者的电脑关机以后访客仍然可以发评论。",
    });
    expect(runs.map(run => run.outcomes.map(outcome => outcome.status))).toEqual([["draft"], ["draft"]]);
  }, 30_000);

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
      // A private comment of the same visitor (or any hidden one) may not be quoted into a public reply; the model
      // rephrases once (a second refusal would end the run's replies, see the oracle test below).
      for (const text of [runs.length === 3 ? `你说过“${PRIVATE_TEXT}”` : `关于“${HIDDEN_TEXT}”这件事`, "谢谢，第二步是指先保存草稿。"]) {
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
    for (const run of [mine, theirs]) expect(run.outcomes.map(outcome => outcome.status ?? outcome.error!.message)).toEqual([QUOTE_REFUSAL, "draft"]);
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
  /* ---------- merge review fixes: the backend's current page state, offPage views, the quote-rule oracle ---------- */
  const QUOTE_REFUSAL = "回复里有一段和私密或已隐藏评论相同（连续 16 个字以上）。公开讨论里所有访客都能看到回复，请换一种说法。";
  const SECRET = "我的手机号是 13912345678，住在朝阳区某某小区 5 号楼，请别外传";
  const replyCalls = () => backend.requests.filter(request => request.method === "POST" && request.url.includes("/replies")).map(request => JSON.stringify(request.body)).join("\n");
  /** Reads every comment of the batch, then replies to the first one with `text(views)`. */
  const quoting = (text: (views: View[]) => string): Model => async (run, call) => {
    const views: View[] = [];
    for (const item of run.wake.comments) { const view = (await call("inbox_read", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId }) as { comment: View }).comment; run.reads.push(view); views.push(view); }
    const target = views[0];
    await call("inbox_reply", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: target.id, expectedCommentRevision: target.revision, eventId: `q-${target.id}-${runs.length}`, text: text(views) }).then(
      result => run.outcomes.push({ commentId: target.id, status: (result as { status: string }).status }),
      error => run.outcomes.push({ commentId: target.id, error: { code: error.code, message: error.message } }));
  };
  const silent: Model = async (run, call) => {
    for (const item of run.wake.comments) run.reads.push((await call("inbox_read", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId }) as { comment: View }).comment);
  };

  it("a visitor reply withdrawn after import never reaches the runner's thread and cannot be quoted, even with direct publishing on", async () => {
    await enable("publish", { publicDirect: true });
    model = silent;
    const root1 = post(B, "第二步看不懂，能解释一下吗？");
    const leaked = post(A, SECRET, { parentId: root1.externalId });
    await settle();
    expect(runs).toHaveLength(2);
    // The visitor withdraws on the backend (hidden=1, hidden_by='author', seq unchanged): no export ever carries it again.
    leaked.withdrawn = true; leaked.hidden = true;
    await clock.advance(5_000, automation);
    expect((await byText(SECRET)).publicState).toEqual({ hidden: false, resolved: false });
    model = quoting(() => `有人提到：${SECRET.slice(0, 30)}`);
    post(C, "我也想知道第二步", { parentId: root1.externalId });
    await settle();
    const run = runs.at(-1)!;
    // The run read the page state from the backend: the withdrawn reply is not in the thread, and quoting it is refused.
    expect(run.reads[0].thread!.replies.map(item => item.text)).toEqual(["我也想知道第二步"]);
    expect(JSON.stringify(run.reads)).not.toContain("13912345678");
    expect(run.outcomes).toEqual([{ commentId: run.wake.comments[0].commentId, error: { code: "invalid_input", message: QUOTE_REFUSAL } }]);
    expect(replyCalls()).not.toContain("13912345678");
    // The withdrawal reached the sidecar: the inbox shows it as withdrawn now.
    expect((await byText(SECRET)).publicState).toEqual({ hidden: true, resolved: false, withdrawn: true });
    expect(backend.requests.some(request => request.url.startsWith("/_board/comments/public/moderation?page=") && request.url.includes(encodeURIComponent(PAGE)))).toBe(true);
  }, 30_000);

  it("a public comment withdrawn, or hidden on the backend, after import never wakes the runner and leaves no run on the budget", async () => {
    await enable("publish", { publicDirect: true });
    model = quoting(() => "谢谢你的评论，我们会看看。");
    const withdrawn = post(A, "这条我很快就撤回了");
    await clock.advance(1_000, automation);
    withdrawn.withdrawn = true; withdrawn.hidden = true;
    await clock.advance(15_000, automation);
    // Hidden on the backend by something this inbox did not see (another Board on the same backend, a restore).
    const hidden = post(B, "这条在后端被隐藏了");
    await clock.advance(1_000, automation);
    hidden.hidden = true;
    await clock.advance(15_000, automation);
    expect(runs).toHaveLength(0);
    expect((await byText("这条我很快就撤回了"))).toMatchObject({ status: "new", publicState: { hidden: true, withdrawn: true } });
    expect((await byText("这条在后端被隐藏了")).status).toBe("new");
    const status = await automation.status(scope);
    expect(status.runs).toEqual([]); expect(status.wake).toMatchObject({ state: "idle", pendingComments: 0 });
    // Later comments are not held up.
    post(C, "第二步是什么意思？");
    await settle();
    expect(runs).toHaveLength(1);
    expect(runs[0].outcomes[0].status).toBe("published");
  }, 30_000);

  it("fails closed when the backend's page state cannot be read: a public batch waits without a run, then is left to the owner", async () => {
    await enable("publish");
    model = replying();
    backend.failModeration.push("500", "network", "404-old");
    post(A, "公开问题：第二步是什么？");
    await settle();
    expect(runs).toHaveLength(0);
    expect((await automation.status(scope)).runs).toEqual([]);
    // Maintenance retries every minute; once the page state reads again the batch runs.
    await clock.advance(60_000, automation); await clock.advance(60_000, automation);
    expect(runs).toHaveLength(0);
    await clock.advance(60_000, automation);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcomes.map(outcome => outcome.status)).toEqual(["draft"]);
    // A backend that never answers: after publicCheckWaitMs the batch is left to the owner and a private comment after it runs.
    for (let i = 0; i < 40; i++) backend.failModeration.push("500");
    post(B, "公开问题：第三步呢？");
    post(C, "私密问题", { public: false });
    await settle();
    expect(runs).toHaveLength(1);
    for (let minute = 0; minute < 11; minute++) await clock.advance(60_000, automation);
    expect(runs.map(run => run.wake.comments[0].visibility)).toEqual(["public", "private"]);
    expect((await byText("公开问题：第三步呢？")).status).toBe("new");
    // During a run, a read or reply of a public comment whose page state cannot be read is refused.
    backend.failModeration.length = 0;
    model = async (run, call) => {
      backend.failModeration.push("network", "network");
      const item = run.wake.comments[0];
      const base = { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId };
      for (const [operation, input] of [["inbox_read", base], ["inbox_reply", { ...base, expectedCommentRevision: item.revision, eventId: "unverified", text: "谢谢。" }]] as const) await call(operation, input).then(
        () => run.outcomes.push({ commentId: item.commentId, status: "ok" }),
        error => run.outcomes.push({ commentId: item.commentId, error: { code: error.code, message: error.message } }));
    };
    post(D, "公开问题：第四步呢？");
    await settle();
    expect(runs.at(-1)!.outcomes.map(outcome => outcome.error)).toEqual([{ code: "unavailable", message: PUBLIC_CHECK_FAILED }, { code: "unavailable", message: PUBLIC_CHECK_FAILED }]);
    expect(replyCalls()).not.toContain("谢谢。");
  }, 30_000);

  it("a comment hidden during the run is shown to the runner without its text, name, anchor or replies", async () => {
    await enable("publish", { publicDirect: true });
    const hiddenText = "我的身份证号是 110101199001011234，别让别人看到";
    model = async (run, call) => {
      const [first, second] = run.wake.comments;
      const firstComment = (await inbox.read({ ...scope, commentId: first.commentId }, human)).comment;
      await inbox.setPublicState({ ...scope, eventId: "human-hide-mid-run", sourceId: "app", externalId: firstComment.externalId, hidden: true }, human);
      const view = (await call("inbox_read", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: first.commentId }) as { comment: View }).comment;
      run.reads.push(view);
      const listed = (await call("inbox_list", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt }) as { comments: View[] }).comments;
      run.reads.push(...listed);
      const other = listed.find(item => item.id === second.commentId)!;
      await call("inbox_reply", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: second.commentId, expectedCommentRevision: other.revision, eventId: "mid-run", text: `你之前说${hiddenText}` }).then(
        result => run.outcomes.push({ commentId: second.commentId, status: (result as { status: string }).status }),
        error => run.outcomes.push({ commentId: second.commentId, error: { code: error.code, message: error.message } }));
    };
    post(A, hiddenText, { authorName: "小明" });
    post(A, "另外第三步是什么意思？");
    await settle();
    const [run] = runs;
    expect(run.wake.comments).toHaveLength(2);
    const offPage = { offPage: true, notice: HIDDEN_PUBLIC, text: "", replies: [], thread: null, visibility: "public" };
    expect(run.reads[0]).toMatchObject(offPage); expect(run.reads[0]).not.toHaveProperty("authorName"); expect(run.reads[0]).not.toHaveProperty("anchor");
    expect(run.reads.slice(1).map(view => view.offPage ?? false)).toEqual([true, false]);
    expect(JSON.stringify(run.reads)).not.toContain("110101199001011234"); expect(JSON.stringify(run.reads)).not.toContain("小明");
    expect(run.outcomes[0].error).toEqual({ code: "invalid_input", message: QUOTE_REFUSAL });
  }, 30_000);

  it("the quote rule cannot be used as a repeated oracle: two refusals end a run's replies (public and private runs)", async () => {
    await enable("publish", { publicDirect: true });
    model = async () => undefined;
    post(D, "我的订单号是 2026-1114-8848，收货人张三，电话保密", { public: false });
    await settle();
    const probes = (guesses: string[]): Model => async (run, call) => {
      const item = run.wake.comments[0];
      for (const [index, guess] of guesses.entries()) {
        const current = (await call("inbox_read", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId }) as { comment: View }).comment;
        await call("inbox_reply", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId, expectedCommentRevision: current.revision, eventId: `probe-${runs.length}-${index}`, text: `x：${guess}` }).then(
          result => run.outcomes.push({ commentId: item.commentId, status: (result as { status: string }).status }),
          error => run.outcomes.push({ commentId: item.commentId, error: { code: error.code, message: error.message } }));
      }
    };
    model = probes(["是 2026-1114-8848", "是 2026-1114-8848", "是 2026-1114-8840", "是 2026-1114-8848"]);
    post(A, "请帮我看看第二步");
    await settle();
    expect(runs.at(-1)!.outcomes.map(outcome => outcome.status ?? outcome.error!.message)).toEqual([QUOTE_REFUSAL, QUOTE_REFUSAL, RUNNER_REPLIES_STOPPED, RUNNER_REPLIES_STOPPED]);
    // A private run's other-visitor refusals count the same way.
    model = probes(["的订单号是 2026-1114-8848，", "的订单号是 2026-1114-8848，", "谢谢，我们会联系你。"]);
    post(E, "私密：请帮我查订单", { public: false });
    await settle();
    expect(runs.at(-1)!.wake.comments[0].visibility).toBe("private");
    expect(runs.at(-1)!.outcomes.map(outcome => outcome.error?.code === "invalid_input" ? "refused" : outcome.status ?? outcome.error!.message)).toEqual(["refused", "refused", RUNNER_REPLIES_STOPPED]);
    expect(replyCalls()).not.toContain("8848");
  }, 30_000);

  /* ---------- P3 review fixes: quoting the page under the quote rule; which release a comment can name ---------- */

  const PAGE_HTML = "<main><h1>评论测试页</h1><h2>评论存在哪里</h2><p>网页本身不保存评论。评论存在作者自己部署的评论后端里，作者的电脑关机以后访客仍然可以发评论。</p><h2>多久回复</h2><p>评论助手通常在一分钟左右写好回复，作者每天晚上会再看一遍所有评论。</p></main>";
  const makeRelease = async (html: string, visibility?: "public", repository = new ReleaseRepository(join(root, "releases"))) => {
    const board = (await store.read(scope.boardId))!;
    const release = await repository.create({ board: { ...board, canvas: { ...board.canvas, html, patches: [] } }, boardId: board.id, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, publicData: {}, comments: { apiBase: "https://api.example.internal", appKey: "0123456789abcdef", ...(visibility ? { visibility } : {}) } });
    ownReleases.add(release.manifest.releaseId);
    return { repository, releaseId: release.manifest.releaseId };
  };
  /** The model answers from the page context, quoting the passage and the rest of its line, as the prompt asks. */
  const quotingPage = (fallback = "谢谢，我们会补充。"): Model => replying(view => {
    const page = view.page as { passageFound?: boolean; passage?: string; after?: string } | undefined;
    return page?.passageFound ? `页面上写着：「${page.passage}${String(page.after).split("\n")[0]}」` : fallback;
  });

  it("a reply may quote the author's page even where another visitor's private comment pasted the same words (P3 review)", async () => {
    const pub = await makeRelease(PAGE_HTML, "public"), priv = await makeRelease(PAGE_HTML, undefined, pub.repository);
    service.usePageContexts(new PageContexts(pub.repository));
    await enable("review");
    model = async () => undefined;
    // Visitor A pastes two page sentences into a private comment, with something of their own.
    const secret = "我的手机号 13800001111，千万别公开给别人看";
    post(A, `评论存在作者自己部署的评论后端里，作者的电脑关机以后访客仍然可以发评论。评论助手通常在一分钟左右写好回复，作者每天晚上会再看一遍所有评论。${secret}`, { public: false, anchor: { quote: "网页本身不保存评论", releaseId: priv.releaseId } });
    await settle();
    // Before the fix: two PRIVATE_IN_PUBLIC refusals, then RUNNER_REPLIES_STOPPED for an unrelated third question.
    model = quotingPage();
    post(B, "评论存在哪里？", { anchor: { quote: "网页本身不保存评论", suffix: "。评论存在", releaseId: pub.releaseId } });
    post(B, "多久能收到回复？", { anchor: { quote: "评论助手通常", releaseId: pub.releaseId } });
    post(B, "这页叫什么？", { anchor: { quote: "评论测试页", releaseId: pub.releaseId } });
    await settle();
    expect(runs.at(-1)!.reads.map(view => view.page?.passageFound)).toEqual([true, true, true]);
    expect(runs.at(-1)!.outcomes.map(outcome => outcome.status ?? outcome.error!.message)).toEqual(["draft", "draft", "draft"]);
    // The visitor's own words are still protected: only the page's text is exempt.
    model = replying(() => `另一位访客说：${secret}`);
    post(C, "有人留过手机号吗？", { anchor: { quote: "网页本身不保存评论", releaseId: pub.releaseId } });
    await settle();
    expect(runs.at(-1)!.outcomes.map(outcome => outcome.error?.message ?? outcome.status)).toEqual([QUOTE_REFUSAL]);
    // A private run quoting the page is not refused either (the other-visitor rule).
    model = quotingPage();
    post(E, "私密：评论存在哪里？", { public: false, anchor: { quote: "网页本身不保存评论", suffix: "。评论存在", releaseId: priv.releaseId } });
    await settle();
    expect(runs.at(-1)!.wake.comments[0].visibility).toBe("private");
    expect(runs.at(-1)!.outcomes.map(outcome => outcome.status ?? outcome.error!.message)).toEqual(["draft"]);
    expect(replyCalls()).not.toContain("13800001111");
  }, 30_000);

  it("a comment that names an older release its share link replaced, or a release of the other kind, gets no page text (P3 review)", async () => {
    const old = await makeRelease("<main><h2>价格</h2><p>旧版本：内部渠道报价每单 9800 元，只给合作伙伴。</p></main>", "public");
    const current = await makeRelease("<main><h2>价格</h2><p>价格请联系作者。</p></main>", "public", old.repository);
    const priv = await makeRelease("<main><h2>价格</h2><p>私密版本：内部渠道报价每单 9800 元。</p></main>", undefined, old.repository);
    // The share link now shows `current`; `old` was not kept online (publication-rpc.ts releaseStillOnline).
    service.usePageContexts(new PageContexts(old.repository, { online: async id => id !== old.releaseId }));
    await enable("review");
    model = async (run, call) => { for (const item of run.wake.comments) run.reads.push((await call("inbox_read", { boardId: run.wake.boardId, expectedCreatedAt: run.wake.expectedCreatedAt, commentId: item.commentId }) as { comment: View }).comment); };
    // Posted on the current page, but the anchor names the old release (or a private one) and quotes its text.
    post(B, "内部渠道报价是多少？", { anchor: { quote: "内部渠道报价", releaseId: old.releaseId } });
    post(B, "私密版本写了什么？", { anchor: { quote: "内部渠道报价", releaseId: priv.releaseId } });
    post(B, "价格怎么算？", { anchor: { quote: "价格请联系作者", releaseId: current.releaseId } });
    await settle();
    const reads = runs.at(-1)!.reads;
    expect(reads.map(view => view.text)).toEqual(["内部渠道报价是多少？", "私密版本写了什么？", "价格怎么算？"]);
    expect(reads[0].page).toBeUndefined(); expect(reads[1].page).toBeUndefined();
    expect(reads[2].page).toMatchObject({ contentTrust: "author-published", passageFound: true, passage: "价格请联系作者" });
    expect(JSON.stringify(reads)).not.toContain("9800");
  }, 30_000);
});
