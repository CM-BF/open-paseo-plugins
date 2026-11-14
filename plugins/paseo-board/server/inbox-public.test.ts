import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { InboxStore, type InboxPublicOutboxItem } from "./inbox-store";
import { InboxConnections, normalizePage } from "./inbox-sync";
import { PublicStateOutbox, PUBLIC_RETRY_MS } from "./inbox-public";
import { normalizeExternalComment, type InboxActor, type InboxExternalComment, type InboxPublicRow } from "../shared/inbox";
import { InboxPublicThreadsSchema } from "../shared/inbox-public";
import { publicThreadContext } from "../shared/inbox-thread";

const createdAt = "2026-11-14T08:00:00.000Z";
const scope = { boardId: "thread-board", expectedCreatedAt: createdAt };
const human: InboxActor = { kind: "user", id: "paseo-client" };
const automation: InboxActor = { kind: "user", id: "paseo-board-automation" };
const credential = "public-fixture-credential-0123456789abcdef";
const ingress: InboxActor = { kind: "ingress", sourceId: "source-1", deploymentId: "deployment-1", credential };
const assistant: InboxActor = { kind: "agent", agentId: "assistant" };
const PAGE = "https://cm-bf.github.io/pages/boards/s0123456789abcdef0123/";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const commentId = (externalId: string) => `comment-${createHash("sha256").update(`source-1\0${externalId}`).digest("hex").slice(0, 40)}`;
const expandFixture = (value: unknown): unknown => typeof value === "string" ? value.replace(/<<repeat:(.):(\d+)>>/gu, (_, c, n) => c.repeat(Number(n))) : Array.isArray(value) ? value.map(expandFixture) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandFixture(v)])) : value;
const FIXTURE = expandFixture(JSON.parse(readFileSync(join(__dirname, "..", "scripts", "fixtures", "public-threads-contract.json"), "utf8"))) as {
  import: { accepted: Array<{ name: string; row: unknown; expected: unknown; public: unknown }>; sanitized: Array<{ name: string; row: unknown; dropped: string[]; public: unknown }>; quarantined: Array<{ name: string; row: unknown; field: string }> };
};
/** The comment keys and audit operations of the 77ca22a ledger: an older build must keep loading ours. */
const OLD_COMMENT_KEYS = new Set(["externalId", "text", "authorName", "createdAt", "pageUrl", "anchor", "visitorTag", "id", "sourceId", "deploymentId", "contentTrust", "importedAt", "revision", "status", "labels", "note", "updatedAt", "seq", "replies", "pendingReply"]);
const OLD_OPERATIONS = new Set(["policy", "source", "import", "triage", "reply", "archive"]);

describe("public-threads import normalization (shared fixture)", () => {
  it("keeps the public extension apart from the stored comment, sanitizes bad optional fields and quarantines bad parents", () => {
    for (const item of FIXTURE.import.accepted) {
      const result = normalizeExternalComment(item.row, 0);
      expect(result.ok, item.name).toBe(true);
      if (!result.ok) continue;
      expect(result.comment, item.name).toEqual(item.expected); expect(result.dropped, item.name).toEqual([]);
      const { externalId: _id, ...extension } = result.public!;
      expect(extension, item.name).toEqual(item.public);
    }
    for (const item of FIXTURE.import.sanitized) {
      const result = normalizeExternalComment(item.row, 0);
      expect(result.ok, item.name).toBe(true);
      if (!result.ok) continue;
      expect(result.dropped.sort(), item.name).toEqual([...item.dropped].sort());
      if (item.public === null) expect(result.public, item.name).toBeUndefined();
      else { const { externalId: _id, ...extension } = result.public!; expect(extension, item.name).toEqual(item.public); }
    }
    for (const item of FIXTURE.import.quarantined) expect(normalizeExternalComment(item.row, 0), item.name).toMatchObject({ ok: false, field: item.field });
    const page = normalizePage(FIXTURE.import.accepted.map(item => item.row));
    expect(page.publicRows.map(row => row.externalId)).toEqual(FIXTURE.import.accepted.map(item => (item.row as { externalId: string }).externalId));
  });
});

describe("public threads in the inbox ledger (public-threads §5.4, §12)", () => {
  let root: string, store: InboxStore, now: number, cursor = 0;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-inbox-public-")); now = Date.parse("2026-11-14T09:00:00.000Z"); cursor = 0;
    store = new InboxStore(root, { resolveBoard: async () => ({ createdAt, ownerAgentId: "owner" }), authorizeAssistant: async (_scope, agentId) => agentId === "assistant", now: () => now });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const row = (n: number, text: string, extra: Partial<InboxExternalComment> = {}): InboxExternalComment => ({ externalId: id(n), text, createdAt: new Date(Date.parse(createdAt) + n * 1000).toISOString(), pageUrl: PAGE, visitorTag: `${String(n).padStart(2, "0")}b2c3d4e5f6`.slice(0, 12), ...extra });
  const pub = (n: number, extra: Partial<InboxPublicRow> = {}): InboxPublicRow => ({ externalId: id(n), visibility: "public", publicTag: `0${n}`.padStart(12, "a").slice(-12), ...extra });
  async function seed(comments: InboxExternalComment[], publicRows: InboxPublicRow[] = []) {
    if (cursor === 0) await store.setSource({ ...scope, expectedRevision: 0, eventId: "register-source", sourceId: "source-1", deploymentId: "deployment-1", label: "测试后端", enabled: true, credential }, human);
    const next = cursor + comments.length;
    const result = await store.importPage({ ...scope, eventId: `import-${cursor}`, sourceId: "source-1", deploymentId: "deployment-1", cursor: String(cursor), nextCursor: String(next), comments, ...(publicRows.length ? { publicRows } : {}) }, ingress);
    cursor = next;
    return result;
  }
  const list = () => store.list({ ...scope, limit: 100 }, human);
  const find = async (externalId: string) => (await list()).comments.find(comment => comment.externalId === externalId)!;
  const ledgerFiles = async () => (await readdir(join(root, "inbox"))).filter(name => name.endsWith(".json"));
  const enable = async (auto: "publish" | "review" = "publish") => { const state = await list(); return store.setPolicy({ ...scope, expectedRevision: state.revision, eventId: `enable-${state.revision}`, policy: { read: true, triage: true, auto } }, human, { allowAutoEnable: true }); };
  const replyInput = (comment: { id: string; revision: number }, eventId: string, text: string) => ({ ...scope, commentId: comment.id, expectedCommentRevision: comment.revision, eventId, text, resolve: true, key: `ir-${createHash("sha256").update(eventId).digest("hex").slice(0, 48)}` });
  const ready = { readySources: [{ sourceId: "source-1", deploymentId: "deployment-1" }] };
  const seedThread = () => seed([row(1, "第二步看不懂，能解释一下吗？"), row(2, "我也是，第二步写得太简略了"), row(3, "私密：我的手机号是 13800000000 请联系我"), row(4, "另一个公开讨论")], [pub(1), pub(2, { parentId: id(1) }), pub(4)]);

  it("imports public rows into a sidecar: the main ledger keeps only 77ca22a keys and operations; reads decorate comments", async () => {
    await seedThread();
    const root1 = await find(id(1)), reply = await find(id(2)), privateRow = await find(id(3));
    expect(root1).toMatchObject({ visibility: "public", publicTag: pub(1).publicTag, publicState: { hidden: false, resolved: false } });
    expect(reply).toMatchObject({ visibility: "public", parentCommentId: commentId(id(1)) });
    expect(privateRow.visibility).toBeUndefined(); expect(privateRow.publicState).toBeUndefined();
    expect((await store.read({ ...scope, commentId: reply.id }, human)).comment.parentCommentId).toBe(root1.id);
    // Triage, a public state change and a reply attempt later, the stored ledger still has only the old shape.
    await store.triage({ ...scope, expectedRevision: (await list()).revision, eventId: "dismiss-1", commentId: reply.id, expectedCommentRevision: reply.revision, status: "dismissed", labels: [], note: "" }, human);
    await store.setPublicState({ ...scope, eventId: "hide-4", sourceId: "source-1", externalId: id(4), hidden: true }, human);
    const files = await ledgerFiles();
    expect(files.sort()).toHaveLength(2);
    const main = JSON.parse(await readFile(join(root, "inbox", files.find(name => !name.endsWith(".public.json"))!), "utf8"));
    for (const comment of main.comments) for (const key of Object.keys(comment)) expect(OLD_COMMENT_KEYS.has(key), key).toBe(true);
    for (const entry of main.audit) expect(OLD_OPERATIONS.has(entry.operation), entry.operation).toBe(true);
    for (const word of ["visibility", "publicState", "parentCommentId", "publicTag", "hiddenBy"]) expect(JSON.stringify(main)).not.toContain(word);
    const sidecar = JSON.parse(await readFile(join(root, "inbox", files.find(name => name.endsWith(".public.json"))!), "utf8"));
    expect(sidecar.records.map((record: { externalId: string }) => record.externalId)).toEqual([id(1), id(2), id(4)]);
  });

  it("treats a newly seen public extension on an existing row as an upgrade, and a changed parent as a conflict", async () => {
    await seed([row(1, "根"), row(2, "回复")]);
    expect((await find(id(2))).visibility).toBeUndefined();
    // The same rows exported again with threads=1 (after a reconcile): the public extension is filled in.
    await store.importPage({ ...scope, eventId: "again", sourceId: "source-1", deploymentId: "deployment-1", cursor: "2", nextCursor: "3", comments: [row(1, "根"), row(2, "回复"), row(5, "新的")], publicRows: [pub(1), pub(2, { parentId: id(1) })] }, ingress);
    cursor = 3;
    expect(await find(id(2))).toMatchObject({ visibility: "public", parentCommentId: commentId(id(1)) });
    await expect(store.importPage({ ...scope, eventId: "moved", sourceId: "source-1", deploymentId: "deployment-1", cursor: "3", nextCursor: "4", comments: [row(2, "回复")], publicRows: [pub(2, { parentId: id(5) })] }, ingress)).rejects.toHaveProperty("code", "idempotency_conflict");
    expect((await list()).sources[0].cursor).toBe("3");
  });

  it("only the human changes what visitors see; withdrawn comments stay hidden; resolving needs a thread", async () => {
    await seedThread();
    const input = { ...scope, eventId: "hide-1", sourceId: "source-1", externalId: id(1), hidden: true };
    for (const actor of [automation, assistant, { kind: "agent" as const, agentId: "owner" }, { kind: "user" as const, id: "someone-else" }]) await expect(store.setPublicState(input, actor)).rejects.toHaveProperty("code", "forbidden");
    await expect(store.setPublicState(input, ingress)).rejects.toHaveProperty("code", "forbidden");
    const before = (await list()).revision;
    const hidden = await store.setPublicState(input, human);
    expect(hidden).toMatchObject({ replayed: false, state: { hidden: true, resolved: false, hiddenBy: "hide", pending: { hidden: true } } });
    expect((await list()).revision, "public state lives in the sidecar; the inbox revision does not move").toBe(before);
    expect((await store.setPublicState(input, human)).replayed).toBe(true);
    await expect(store.setPublicState({ ...input, hidden: false }, human)).rejects.toHaveProperty("code", "idempotency_conflict");
    await expect(store.setPublicState({ ...scope, eventId: "resolve-2", sourceId: "source-1", externalId: id(2), resolved: true }, human)).rejects.toMatchObject({ code: "invalid_input", message: "只能把整个讨论标为已解决。" });
    // A comment the inbox never imported (a flood) can still be hidden from the thread view; a withdrawn one cannot be shown.
    const unknown = await store.setPublicState({ ...scope, eventId: "hide-9", sourceId: "source-1", externalId: id(9), hidden: true, known: { hidden: false, resolved: false, publicTag: "abcdefabcdef" } }, human);
    expect(unknown.state).toMatchObject({ hidden: true, pending: { hidden: true } });
    await store.setPublicState({ ...scope, eventId: "w-8", sourceId: "source-1", externalId: id(8), resolved: true, known: { hidden: true, resolved: false, withdrawn: true } }, human);
    await expect(store.setPublicState({ ...scope, eventId: "show-8", sourceId: "source-1", externalId: id(8), hidden: false }, human)).rejects.toMatchObject({ code: "invalid_input", message: "访客已撤回这条评论，不能再在页面上显示。" });
  });

  it("the human's 不处理 hides a public comment and leaving it shows it again; an explicit hide survives; an agent's 不处理 changes nothing", async () => {
    await seedThread();
    const triage = async (externalId: string, status: "dismissed" | "reviewing", actor: InboxActor = human, eventId = `t-${externalId}-${status}-${now++}`) => {
      const comment = await find(externalId);
      return store.triage({ ...scope, expectedRevision: (await list()).revision, eventId, commentId: comment.id, expectedCommentRevision: comment.revision, status, labels: [], note: "" }, actor);
    };
    await triage(id(1), "dismissed");
    expect((await find(id(1))).publicState).toEqual({ hidden: true, resolved: false, hiddenBy: "dismiss", pending: { hidden: true } });
    await triage(id(1), "reviewing");
    expect((await find(id(1))).publicState).toEqual({ hidden: false, resolved: false, pending: { hidden: false } });
    await store.setPublicState({ ...scope, eventId: "explicit", sourceId: "source-1", externalId: id(4), hidden: true }, human);
    await triage(id(4), "dismissed"); await triage(id(4), "reviewing");
    expect((await find(id(4))).publicState).toMatchObject({ hidden: true, hiddenBy: "hide" });
    await enable("publish");
    await triage(id(2), "dismissed", assistant);
    expect((await find(id(2))).publicState).toEqual({ hidden: false, resolved: false });
    await triage(id(2), "dismissed", automation).catch(() => undefined);
    expect((await find(id(2))).publicState?.hidden).toBe(false);
  });

  it("outcomes come only from the comment's own source; a confirm clears only values still wanted; a failure stops until retry", async () => {
    await seedThread();
    await store.setPublicState({ ...scope, eventId: "hide-1", sourceId: "source-1", externalId: id(1), hidden: true, resolved: true }, human);
    const [item] = await store.publicOutbox(scope, automation);
    expect(item).toEqual({ kind: "state", sourceId: "source-1", externalId: id(1), send: { hidden: true, resolved: true } });
    await expect(store.confirmPublic(scope, item, { hidden: true, resolved: true }, human)).rejects.toHaveProperty("code", "forbidden");
    await expect(store.confirmPublic(scope, item, { hidden: true, resolved: true }, { ...ingress, credential: "x".repeat(40) })).rejects.toHaveProperty("code", "forbidden");
    // The human changed their mind while the request was in flight: the stale confirm keeps the new pending value.
    await store.setPublicState({ ...scope, eventId: "show-1", sourceId: "source-1", externalId: id(1), hidden: false }, human);
    const revision = (await list()).revision;
    await store.confirmPublic(scope, item, { hidden: true, resolved: true }, ingress);
    expect((await find(id(1))).publicState).toEqual({ hidden: false, resolved: true, pending: { hidden: false } });
    expect((await list()).revision, "outcomes never bump the inbox or comment revision").toBe(revision);
    const [next] = await store.publicOutbox(scope, automation);
    await store.failPublic(scope, next, "后端没有这条评论（后端可能已更换或恢复了旧数据）。", ingress);
    expect(await store.publicOutbox(scope, automation)).toEqual([]);
    expect((await find(id(1))).publicState?.error).toBe("后端没有这条评论（后端可能已更换或恢复了旧数据）。");
    await store.setPublicState({ ...scope, eventId: "retry-1", sourceId: "source-1", externalId: id(1), retry: true }, human);
    expect(await store.publicOutbox(scope, automation)).toEqual([{ kind: "state", sourceId: "source-1", externalId: id(1), send: { hidden: false } }]);
  });

  it("the waker sees public visitor replies and hidden comments as not new; public roots may wake", async () => {
    await seedThread();
    await store.setPublicState({ ...scope, eventId: "hide-4", sourceId: "source-1", externalId: id(4), hidden: true }, human);
    const snapshot = await store.snapshotAfter(scope, 0, 50, automation);
    expect(snapshot.comments.map(row => [row.id, row.status])).toEqual([[commentId(id(1)), "new"], [commentId(id(2)), "dismissed"], [commentId(id(3)), "new"], [commentId(id(4)), "dismissed"]]);
  });

  it("assistant replies to public comments are drafts; private and hidden text cannot be quoted into them, even the same visitor's", async () => {
    await seed([row(1, "第二步看不懂，能解释一下吗？"), row(2, "我也是，第二步写得太简略了"), row(3, "私密：我的手机号是 13800000000 请联系我", { visitorTag: "01b2c3d4e5f6" }), row(4, "这一段已隐藏的内容不能被引用出来")], [pub(1), pub(2, { parentId: id(1) }), pub(4)]);
    await store.setPublicState({ ...scope, eventId: "hide-4", sourceId: "source-1", externalId: id(4), hidden: true }, human);
    await enable("publish");
    const target = await find(id(1));
    const privateQuote = store.prepareReply(replyInput(target, "q1", "你提到“私密：我的手机号是 13800000000 请联系我”"), assistant, ready);
    await expect(privateQuote).rejects.toMatchObject({ code: "invalid_input", message: "回复里有一段和私密或已隐藏评论相同（连续 16 个字以上）。公开讨论里所有访客都能看到回复，请换一种说法。" });
    await expect(store.prepareReply(replyInput(target, "q2", "关于“这一段已隐藏的内容不能被引用出来”"), assistant, ready)).rejects.toHaveProperty("code", "invalid_input");
    const quoted = await store.prepareReply(replyInput(target, "q3", "回复“我也是，第二步写得太简略了”：第二步是指先保存草稿。"), assistant, ready);
    expect(quoted).toMatchObject({ kind: "pending", pending: { state: "draft", authorKind: "agent" } });
    // A private comment keeps the old rule and the publish mode: no draft.
    const privateTarget = await find(id(3));
    expect(await store.prepareReply(replyInput(privateTarget, "p1", "谢谢，我们会尽快联系你。"), assistant, ready)).toMatchObject({ kind: "pending", pending: { state: "sending" } });
  });

  it("counts owner and assistant replies across a public thread (20)", async () => {
    await seedThread();
    const root1 = await find(id(1)), reply = await find(id(2));
    for (let i = 0; i < 20; i++) {
      const target = i % 2 ? root1 : reply, current = await find(target.externalId);
      const prepared = await store.prepareReply(replyInput(current, `h${i}`, `作者回复 ${i}`), human, ready);
      if (prepared.kind !== "pending") throw new Error("expected pending");
      await store.confirmReply(scope, current.id, prepared.pending.key, { replyId: `r-${i}`, createdAt: new Date(now + i).toISOString() }, ingress);
    }
    await expect(store.prepareReply(replyInput(await find(id(1)), "h21", "第 21 条"), human, ready)).rejects.toMatchObject({ code: "size_limit", message: "这个讨论的作者回复已达 20 条上限。" });
    expect(await store.prepareReply(replyInput(await find(id(4)), "other", "另一个讨论不受影响"), human, ready)).toMatchObject({ kind: "pending" });
  });

  it("publicThreadContext returns only what every visitor can already see", async () => {
    await seedThread();
    const reply = await find(id(2));
    await store.prepareReply(replyInput(reply, "ctx", "作者对回复的说明"), human, ready).then(prepared => prepared.kind === "pending" ? store.confirmReply(scope, reply.id, prepared.pending.key, { replyId: "ctx-r", createdAt: "2026-11-14T08:00:10.000Z" }, ingress) : undefined);
    const comments = (await list()).comments;
    const context = publicThreadContext(comments, commentId(id(2)))!;
    expect(context.root).toMatchObject({ commentId: commentId(id(1)), kind: "visitor", text: "第二步看不懂，能解释一下吗？" });
    expect(context.replies.map(item => [item.kind, item.text])).toEqual([["visitor", "我也是，第二步写得太简略了"], ["owner", "作者对回复的说明"]]);
    expect(JSON.stringify(context)).not.toContain("13800000000");
    expect(publicThreadContext(comments, commentId(id(3)))).toBeNull();
    await store.setPublicState({ ...scope, eventId: "hide-2", sourceId: "source-1", externalId: id(2), hidden: true }, human);
    expect(publicThreadContext((await list()).comments, commentId(id(1)))!.replies).toEqual([]);
  });

  it("the outbox flushes on a change, backs off on transient failures, stops on refusals and re-pushes explicit values", async () => {
    await seedThread();
    const timers = new Map<number, { at: number; run: () => void }>(); let clock = 0, next = 0;
    const fakeClock = { now: () => clock, setTimeout: (run: () => void, ms: number) => { const key = ++next; timers.set(key, { at: clock + ms, run }); return key; }, clearTimeout: (key: unknown) => { timers.delete(key as number); } };
    const advance = async (ms: number) => { clock += ms; for (const [key, timer] of [...timers].filter(([, entry]) => entry.at <= clock)) { timers.delete(key); timer.run(); } await new Promise(resolve => setTimeout(resolve, 20)); };
    const posts: InboxPublicOutboxItem[] = [], outcomes: Array<"ok" | "transient" | "fail"> = [];
    const connections = {
      scopes: async () => [scope],
      runtimeSources: async () => [{ sourceId: "source-1", deploymentId: "deployment-1", label: "测试后端", endpoint: "https://api.example.test/_board/comments", token: "t".repeat(40), credential, enabled: true, ready: true }],
      withSourceLock: <T,>(_scope: unknown, _source: string, work: () => Promise<T>) => work(),
      postPublic: async (_source: unknown, item: InboxPublicOutboxItem) => {
        posts.push(item);
        const kind = outcomes.shift() ?? "ok";
        return kind === "ok" ? { kind, echo: item.kind === "state" ? { ...item.send } : { changed: 2 } } : kind === "fail" ? { kind, message: "后端认为这条评论不是公开评论。" } : { kind, error: "后端返回 HTTP 503" };
      },
    } as unknown as InboxConnections;
    const outbox = new PublicStateOutbox({ inbox: store, connections, log: () => undefined, clock: fakeClock });
    await outbox.start();
    expect(posts).toEqual([]);
    outcomes.push("transient", "transient");
    await store.setPublicState({ ...scope, eventId: "hide-1", sourceId: "source-1", externalId: id(1), hidden: true }, human);
    await advance(50);
    expect(posts).toHaveLength(1);
    await advance(PUBLIC_RETRY_MS[0] - 1); expect(posts).toHaveLength(1);
    await advance(1); expect(posts).toHaveLength(2);
    await advance(PUBLIC_RETRY_MS[1]); expect(posts).toHaveLength(3);
    expect((await find(id(1))).publicState).toEqual({ hidden: true, resolved: false, hiddenBy: "hide" });
    outcomes.push("fail");
    await store.setPublicState({ ...scope, eventId: "hide-4", sourceId: "source-1", externalId: id(4), hidden: true }, human);
    await advance(50);
    expect((await find(id(4))).publicState?.error).toBe("后端认为这条评论不是公开评论。");
    await advance(PUBLIC_RETRY_MS[5]); expect(posts, "a refused item is not retried").toHaveLength(4);
    await store.setPublicAction({ ...scope, eventId: "pause", sourceId: "source-1", page: PAGE, paused: true }, "pause", human);
    await advance(50);
    expect(posts.at(-1)).toMatchObject({ kind: "action", action: { kind: "pause", page: PAGE, value: true } });
    expect((await store.publicLedger(scope, automation)).actions[0]).not.toHaveProperty("pending");
    // Hourly: values the human set are sent again, nothing new is recorded.
    const count = posts.length;
    await advance(3_600_000);
    expect(posts.slice(count).map(item => item.kind === "state" ? item.externalId : item.action.kind)).toEqual([id(1), "pause"]);
    outbox.close();
    await advance(10_000_000);
    expect(timers.size).toBe(0);
  });

  it("the thread view schema accepts the merged moderation listing", () => {
    expect(InboxPublicThreadsSchema.safeParse({ revision: 1, sources: [{ sourceId: "source-1", label: "x", state: "ok", error: null, publicThreads: true, pages: [{ page: PAGE, paused: false, pending: false, error: null }], threads: [{ id: id(1), by: "visitor", tag: "abcdefabcdef", text: "x", createdAt, page: PAGE, resolved: false, hidden: false, replies: [{ id: "r", by: "agent", text: "y", createdAt }], omitted: 0, state: { hidden: false, resolved: false } }], total: 1, truncated: false }] }).success).toBe(true);
  });
});

describe("public-threads HTTP calls (inbox-sync)", () => {
  const source = { endpoint: "https://api.example.test/_board/comments", token: "t".repeat(40), deploymentId: "deployment-1" };
  const item: InboxPublicOutboxItem = { kind: "state", sourceId: "source-1", externalId: id(1), send: { hidden: true } };
  const answer = (status: number, body: unknown) => async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return new Response(JSON.stringify(body), { status }); };
  let calls: Array<{ url: string; init: RequestInit }> = [];
  beforeEach(() => { calls = []; });
  it("posts state with the bearer token and no Origin, and maps every answer", async () => {
    const make = (status: number, body: unknown) => new InboxConnections("/nonexistent", {} as InboxStore, answer(status, body) as typeof fetch);
    expect(await make(200, { deploymentId: "deployment-1", state: { externalId: id(1), hidden: true, resolved: false }, changed: true }).postPublic(source, item)).toEqual({ kind: "ok", echo: { hidden: true, resolved: false } });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe(`https://api.example.test/_board/comments/${id(1)}/state`); expect(headers.Authorization).toBe(`Bearer ${"t".repeat(40)}`); expect(headers).not.toHaveProperty("Origin"); expect(calls[0].init.body).toBe('{"hidden":true}');
    expect(await make(200, { deploymentId: "other", state: { externalId: id(1), hidden: true } }).postPublic(source, item)).toMatchObject({ kind: "fail" });
    expect(await make(200, { deploymentId: "deployment-1", state: { externalId: id(1), hidden: false } }).postPublic(source, item)).toMatchObject({ kind: "fail" });
    for (const [status, body] of [[503, {}], [429, {}], [401, {}], [403, {}], [404, { code: "export_disabled" }], [404, { code: "comments_disabled" }]] as const) expect((await make(status, body).postPublic(source, item)).kind, `${status}`).toBe("transient");
    expect(await make(404, { code: "comment_not_found" }).postPublic(source, item)).toEqual({ kind: "fail", message: "后端没有这条评论（后端可能已更换或恢复了旧数据）。" });
    expect(await make(404, { code: "not_found" }).postPublic(source, item)).toEqual({ kind: "fail", message: "后端版本过旧，不支持隐藏或标为已解决：在应用目录运行 paseo-board-app update-runtime，然后重新部署。" });
    expect(await make(409, { code: "not_public" }).postPublic(source, item)).toEqual({ kind: "fail", message: "后端认为这条评论不是公开评论。" });
    expect(await make(409, { code: "withdrawn" }).postPublic(source, item)).toEqual({ kind: "fail", message: "访客已撤回这条评论，不能再在页面上显示。" });
    expect(await make(400, { code: "invalid_input" }).postPublic(source, item)).toEqual({ kind: "fail", message: "后端拒绝了这次更新（HTTP 400：invalid_input）。" });
    const network = new InboxConnections("/nonexistent", {} as InboxStore, (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    expect((await network.postPublic(source, item)).kind).toBe("transient");
    const action: InboxPublicOutboxItem = { kind: "action", sourceId: "source-1", id: "x", action: { id: "x", sourceId: "source-1", kind: "hide-visitor", page: PAGE, tag: "abcdefabcdef", value: true, pending: true, updatedAt: createdAt } };
    calls = [];
    expect(await make(200, { deploymentId: "deployment-1", changed: 3 }).postPublic(source, action)).toEqual({ kind: "ok", echo: { changed: 3 } });
    expect(calls[0].url).toBe("https://api.example.test/_board/comments/public/hide-visitor"); expect(JSON.parse(String(calls[0].init.body))).toEqual({ page: PAGE, tag: "abcdefabcdef", hidden: true });
  });
});
