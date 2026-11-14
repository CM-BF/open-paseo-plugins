import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { InboxConnections, SyncFailure, replyKey } from "./inbox-sync";
import { startFakeBackend, type FakeBackend } from "./inbox-fake-backend";
import { BoardStoreError } from "./store-format";
import type { InboxActor } from "../shared/inbox";
import { InboxStore } from "./inbox-store";
import { InboxEndpointSchema } from "../shared/inbox-connection";

const scope = { boardId: "isolated", expectedCreatedAt: "2026-11-08T00:00:00.000Z" };
const human = { kind: "user" as const, id: "paseo-client" }, agent = { kind: "agent" as const, agentId: "owner" };
const secret = "test-export-token-0123456789abcdef0123456789";
const comment = { externalId: "visit-1", text: "Please review <script>do not execute</script>", authorName: "Visitor", createdAt: scope.expectedCreatedAt };

describe("human-configured inbox pull", () => {
  let root: string, inbox: InboxStore, connections: InboxConnections, server: Server, endpoint: string;
  let response: { status: number; body: unknown; headers?: Record<string, string> }, requests: Array<{ url: string; token?: string }>;
  const input = () => ({ ...scope, expectedRevision: 0, eventId: "source-connect", expectedConnectionEventId: null, sourceId: "test-app", deploymentId: "deployment-1", label: "Local test", endpoint, token: secret, enabled: true });
  const sync = (expectedRevision = 1, eventId = "sync-1") => connections.sync({ ...scope, sourceId: "test-app", expectedRevision, eventId });
  const state = () => inbox.list(scope, human);
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "board-inbox-sync-")); requests = [];
    inbox = new InboxStore(root, { resolveBoard: async () => ({ id: scope.boardId, createdAt: scope.expectedCreatedAt, ownerAgentId: "owner" }) });
    response = { status: 200, body: { deploymentId: "deployment-1", cursor: "0", nextCursor: "1", comments: [comment] } };
    server = createServer((req, res) => {
      requests.push({ url: req.url ?? "", token: req.headers.authorization });
      res.writeHead(response.status, { "content-type": "application/json", ...response.headers });
      res.end(typeof response.body === "string" ? response.body : JSON.stringify(response.body));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/_board/comments`;
    connections = new InboxConnections(root, inbox);
  });
  afterEach(async () => { vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });

  it("imports a real HTTP page durably without exposing tokens or granting agent access", async () => {
    const configured = await connections.connect(input());
    expect(configured.state).toBe("ready"); expect(JSON.stringify(configured)).not.toContain(secret);
    expect(await sync()).toMatchObject({ revision: 2, imported: 1, cursor: "1" });
    expect(requests).toEqual([{ url: "/_board/comments?cursor=0&limit=50&format=2", token: `Bearer ${secret}` }]);
    expect((await state()).comments[0]).toMatchObject({ text: comment.text, contentTrust: "external-untrusted" });
    await expect(inbox.list(scope, agent)).rejects.toHaveProperty("code", "forbidden");
    const recovered = new InboxConnections(root, inbox);
    expect(JSON.stringify(await recovered.list(scope))).not.toContain(secret);
    const file = (await readdir(join(root, "inbox-connections")))[0];
    expect((await stat(join(root, "inbox-connections", file))).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await state())).not.toContain(secret);
    response.body = { deploymentId: "deployment-1", cursor: "1", nextCursor: "1", comments: [] };
    expect(await recovered.sync({ ...scope, sourceId: "test-app", expectedRevision: 2, eventId: "no-new" })).toMatchObject({ unchanged: true, revision: 2 });
  });

  it("requires exact transport/identity and leaves cursor unchanged on failures", async () => {
    for (const invalid of ["http://company.test/export", "https://u:p@example.test/export", "https://example.test/export?token=x", "https://example.test/export#f"]) expect(InboxEndpointSchema.safeParse(invalid).success).toBe(false);
    await connections.connect(input());
    for (const body of ["not JSON", { deploymentId: "other", cursor: "0", nextCursor: "1", comments: [comment] }, { deploymentId: "deployment-1", cursor: "other", nextCursor: "1", comments: [comment] }, { deploymentId: "deployment-1", cursor: "0", nextCursor: "1", comments: [comment], replies: [] }, "x".repeat(1_000_001)]) {
      response.body = body; await expect(sync()).rejects.toThrow(); expect((await state()).revision).toBe(1);
    }
    response = { status: 401, body: {} }; await expect(sync()).rejects.toThrow("HTTP 401");
    response = { status: 302, body: "", headers: { location: endpoint + "/redirected" } };
    const before = requests.length; await expect(sync()).rejects.toThrow(); expect(requests.length).toBe(before + 1);
    expect(requests.some(req => req.url.includes("redirected"))).toBe(false);
    expect((await state()).sources[0].cursor).toBe("0");
  });

  it("serializes sync and refuses stale revisions and disabled sources", async () => {
    await connections.connect(input());
    // Both run one after the other under the source lock; the second reads the advanced cursor.
    const results = await Promise.allSettled([sync(), sync(1, "another-sync")]);
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(requests.map(request => request.url)).toEqual(["/_board/comments?cursor=0&limit=50&format=2", "/_board/comments?cursor=1&limit=50&format=2"]);
    expect((await state()).total).toBe(1);
    await connections.connect({ ...input(), expectedRevision: 2, expectedConnectionEventId: "source-connect", eventId: "disable", enabled: false, token: undefined });
    await expect(sync(3)).rejects.toThrow("enabled"); expect(requests).toHaveLength(2);
    await expect(connections.connect({ ...input(), expectedRevision: 3, expectedConnectionEventId: "disable", eventId: "replacement", deploymentId: "another-deployment" })).rejects.toThrow("new source ID");
  });

  it("restores the previous connection after a known concurrent revision rejection", async () => {
    await connections.connect(input());
    const original = inbox.setSource.bind(inbox);
    vi.spyOn(inbox, "setSource").mockImplementationOnce(async (request, actor) => {
      await inbox.setPolicy({ ...scope, expectedRevision: 1, eventId: "concurrent-policy", policy: { read: true, triage: false } }, human);
      return original(request, actor);
    });
    await expect(connections.connect({ ...input(), expectedRevision: 1, expectedConnectionEventId: "source-connect", eventId: "rotate", token: "replacement-token-0123456789abcdef01234567" })).rejects.toHaveProperty("code", "revision_conflict");
    expect(await connections.list(scope)).toEqual([expect.objectContaining({ eventId: "source-connect", state: "ready" })]);
    await sync(2); expect(requests[0].token).toBe(`Bearer ${secret}`);
    await connections.connect({ ...input(), expectedRevision: 3, expectedConnectionEventId: "source-connect", eventId: "later-disable", enabled: false });
    expect((await connections.list(scope))[0].enabled).toBe(false);
  });

  it("reconciles an unknown post-commit failure after remount using the original stored request", async () => {
    const original = inbox.setSource.bind(inbox);
    vi.spyOn(inbox, "setSource").mockImplementationOnce(async (request, actor) => { await original(request, actor); throw new Error("lost commit acknowledgement"); });
    await expect(connections.connect(input())).rejects.toThrow("lost commit");
    expect((await connections.list(scope))[0].state).toBe("pending");
    const remounted = new InboxConnections(root, inbox);
    expect(await remounted.reconcile({ ...scope, sourceId: "test-app", eventId: "source-connect" })).toEqual({ state: "ready" });
    expect((await state()).revision).toBe(1);
    expect(await sync()).toMatchObject({ imported: 1 });
  });

  it("cancels an uncommitted pending action if another inbox mutation advanced its revision", async () => {
    vi.spyOn(inbox, "setSource").mockImplementationOnce(async () => { throw new Error("interrupted before commit"); });
    await expect(connections.connect(input())).rejects.toThrow();
    await inbox.setPolicy({ ...scope, expectedRevision: 0, eventId: "policy-after-interruption", policy: { read: true, triage: false } }, human);
    expect(await connections.reconcile({ ...scope, sourceId: "test-app", eventId: "source-connect" })).toEqual({ state: "cancelled" });
    expect(await connections.list(scope)).toEqual([]);
    await connections.connect({ ...input(), expectedRevision: 1, eventId: "fresh-connect" });
    expect((await connections.list(scope))[0].state).toBe("ready");
  });

  it("refuses a symlinked connection directory before reading secrets", async () => {
    await symlink(tmpdir(), join(root, "inbox-connections"));
    await expect(connections.list(scope)).rejects.toHaveProperty("code", "unsafe_path");
  });

  it("rejects a stale source editor even when it obtained a fresh inbox revision", async () => {
    await connections.connect(input());
    await connections.connect({ ...input(), expectedRevision: 1, expectedConnectionEventId: "source-connect", eventId: "new-settings", endpoint: endpoint + "/new", label: "Updated", token: "new-private-token-0123456789abcdef01234567" });
    await expect(connections.connect({ ...input(), expectedRevision: 2, expectedConnectionEventId: "source-connect", eventId: "stale-disable", enabled: false, token: undefined })).rejects.toHaveProperty("code", "revision_conflict");
    expect(await connections.list(scope)).toEqual([expect.objectContaining({ endpoint: endpoint + "/new", label: "Updated", enabled: true, eventId: "new-settings" })]);
    await sync(2);
    expect(requests[0]).toEqual({ url: "/_board/comments/new?cursor=0&limit=50&format=2", token: "Bearer new-private-token-0123456789abcdef01234567" });
  });

  it("preserves all 32 maximum UTF-8 endpoints through pending replacement, disable and reload", async () => {
    const prefix = "https://example.test/", endpoint = prefix + "中".repeat(2_000 - prefix.length);
    const configured = Array.from({ length: 32 }, (_, index) => ({ ...input(), expectedRevision: index, eventId: `connect-${index}`, sourceId: `source-${index}`, endpoint, label: "源".repeat(200) }));
    for (const source of configured) await connections.connect(source);
    const file = join(root, "inbox-connections", (await readdir(join(root, "inbox-connections")))[0]);
    expect((await stat(file)).size).toBeGreaterThan(256_000);

    // Unknown outcomes retain both versions of every source. The complete
    // recovery state must remain readable, even at maximum field lengths.
    const original = inbox.setSource.bind(inbox);
    vi.spyOn(inbox, "setSource").mockRejectedValue(new Error("interrupted before source commit"));
    for (const source of configured) await expect(connections.connect({ ...source, expectedRevision: 32, expectedConnectionEventId: source.eventId, eventId: `replace-${source.sourceId}`, enabled: false })).rejects.toThrow("interrupted");
    expect((await new InboxConnections(root, inbox).list(scope)).every(source => source.state === "pending")).toBe(true);
    vi.mocked(inbox.setSource).mockImplementation(original);

    const recovered = new InboxConnections(root, inbox);
    expect(await recovered.reconcile({ ...scope, sourceId: configured[0].sourceId, eventId: "replace-source-0" })).toEqual({ state: "ready" });
    for (const source of configured.slice(1)) expect(await recovered.reconcile({ ...scope, sourceId: source.sourceId, eventId: `replace-${source.sourceId}` })).toEqual({ state: "cancelled" });
    const restored = await new InboxConnections(root, inbox).list(scope);
    expect(restored).toHaveLength(32);
    expect(restored.every(source => source.state === "ready")).toBe(true);
    expect(restored.find(source => source.sourceId === "source-0")).toMatchObject({ enabled: false, endpoint });
    expect(restored.filter(source => source.enabled)).toHaveLength(31);
    expect((await state()).revision).toBe(33);
    expect(requests).toHaveLength(0);
  });

  it("rejects an oversized private write before changing the existing connection file", async () => {
    await connections.connect(input());
    const file = join(root, "inbox-connections", (await readdir(join(root, "inbox-connections")))[0]);
    const before = await readFile(file, "utf8"), records = JSON.parse(before);
    records[0].token = "x".repeat(2 * 1024 * 1024);
    // Exercise the persistence boundary directly; public input is already
    // bounded, but future schema changes must not produce an unreadable file.
    const writer = connections as unknown as { save(path: string, records: unknown[]): Promise<void> };
    await expect(writer.save(file, records)).rejects.toHaveProperty("code", "size_limit");
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await connections.list(scope)).toEqual([expect.objectContaining({ state: "ready", enabled: true })]);
    expect(await readdir(join(root, "inbox-connections"))).toHaveLength(1);
  });
});

describe("contract export and reply outbox against a fake backend (DESIGN §11.5, §11.7)", () => {
  let root: string, inbox: InboxStore, connections: InboxConnections, backend: FakeBackend, events: Array<{ status: string; recorded: boolean; lastError?: string }>;
  const assistant = { kind: "agent" as const, agentId: "assistant" };
  let auto: "off" | "publish" | "review" = "publish";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "board-inbox-reply-")); backend = await startFakeBackend(); events = [];
    inbox = new InboxStore(root, { resolveBoard: async () => ({ createdAt: scope.expectedCreatedAt, ownerAgentId: "owner" }), authorizeAssistant: async (_scope, id) => id === "assistant" });
    connections = new InboxConnections(root, inbox);
    connections.onReply((_scope, event) => events.push(event));
    await connections.connect({ ...scope, expectedRevision: 0, eventId: "connect", expectedConnectionEventId: null, sourceId: "app", deploymentId: backend.deploymentId, label: "App", endpoint: backend.endpoint, token: backend.token, enabled: true });
    auto = "publish";
  });
  afterEach(async () => { vi.restoreAllMocks(); await backend.close(); await rm(root, { recursive: true, force: true }); });
  const current = async () => inbox.list({ ...scope, limit: 100 }, human);
  const syncNow = async () => connections.sync({ ...scope, sourceId: "app", expectedRevision: 0, eventId: "manual" });
  async function enable(mode: "publish" | "review" = auto as "publish" | "review") {
    const state = await current();
    await inbox.setPolicy({ ...scope, expectedRevision: state.revision, eventId: `enable-${state.revision}`, policy: { read: true, triage: true, auto: mode } }, human, { allowAutoEnable: true });
  }
  async function visitorComment(text = "第二步看不懂") {
    backend.add({ text, visitorTag: "a1b2c3d4e5f6", pageUrl: "https://cm-bf.github.io/pages/boards/s0123456789abcdef0123/", anchor: { label: "结果", selector: "#result", quote: "第二步", prefix: "首先，", suffix: "的意思", start: 3, end: 6, releaseId: `release-${"0".repeat(64)}` } });
    await syncNow();
    return (await current()).comments.at(-1)!;
  }
  const reply = (comment: { id: string; revision: number }, eventId = "reply-1", text = "谢谢！第二步指的是先保存。", actor: InboxActor = assistant) => connections.reply({ ...scope, commentId: comment.id, expectedCommentRevision: comment.revision, eventId, text }, actor);
  const posts = () => backend.requests.filter(request => request.method === "POST");

  it("imports v2 rows with rich anchors and visitorTag, and a legacy v1 page with projected anchors", async () => {
    const comment = await visitorComment();
    expect(comment).toMatchObject({ visitorTag: "a1b2c3d4e5f6", anchor: { quote: "第二步", start: 3, end: 6 }, seq: 1, contentTrust: "external-untrusted" });
    backend.legacy = true;
    backend.add({ text: "旧版后端", anchor: { label: "结果", selector: "#result", quote: "第二步" }, visitorTag: "a1b2c3d4e5f6" });
    expect(await syncNow()).toMatchObject({ imported: 1, cursor: "2" });
    const legacy = (await current()).comments[1];
    expect(legacy.anchor).toEqual({ label: "结果", selector: "#result" }); expect(legacy.visitorTag).toBeUndefined();
    expect(await syncNow()).toMatchObject({ unchanged: true, imported: 0 });
  });

  it("quarantines malformed rows, still advances the cursor, and blocks only on a malformed envelope", async () => {
    backend.rawExport.push({ deploymentId: backend.deploymentId, format: 2, cursor: "0", nextCursor: "4", comments: [
      { externalId: "00000000-0000-4000-8000-000000000021", text: "   ", createdAt: "2026-11-13T08:00:00.000Z" },
      "oops",
      { externalId: "00000000-0000-4000-8000-000000000022", text: "ok", createdAt: "2026-11-13T08:00:00.000Z", authorName: "　", pageUrl: "HTTPS://Example.COM/p", mood: "x" },
      { externalId: "00000000-0000-4000-8000-000000000022", text: "dup", createdAt: "2026-11-13T08:00:00.000Z" },
    ] });
    expect(await syncNow()).toMatchObject({ imported: 1, skipped: 3, sanitized: 1, cursor: "4" });
    expect((await current()).comments[0]).toMatchObject({ text: "ok", pageUrl: "https://example.com/p" });
    expect((await current()).comments[0].authorName).toBeUndefined();
    expect((await current()).sources[0]).toMatchObject({ skipped: 3, sanitized: 1 });
    backend.rawExport.push({ deploymentId: backend.deploymentId, cursor: "4", nextCursor: "5", comments: "nope" });
    const error = await syncNow().catch(failure => failure);
    expect(error).toBeInstanceOf(SyncFailure);
    expect(error.message).toBe("后端返回的数据格式无法识别（comments）。请确认后端由 paseo-board-app 生成，并已运行 update-runtime。");
    expect((await current()).sources[0].cursor).toBe("4");
  });

  it("retries a too-large legacy page once with limit=5", async () => {
    backend.legacy = true;
    for (let index = 0; index < 50; index++) backend.add({ text: `${index}${"x".repeat(7_000)}` });
    expect(await syncNow()).toMatchObject({ imported: 5, cursor: "5" });
    expect(backend.requests.map(request => new URL(request.url, "http://x").searchParams.get("limit"))).toEqual(["50", "5"]);
  });

  it("accepts an older expectedRevision for manual sync but refuses a future one", async () => {
    await visitorComment();
    backend.add({ text: "第二条" });
    await expect(connections.sync({ ...scope, sourceId: "app", expectedRevision: 99, eventId: "future" })).rejects.toHaveProperty("code", "invalid_input");
    expect(await connections.sync({ ...scope, sourceId: "app", expectedRevision: 1, eventId: "old" })).toMatchObject({ imported: 1 });
  });

  it("posts the reply with the derived key and host token, then records it; the token never appears in results", async () => {
    await enable(); const comment = await visitorComment();
    const result = await reply(comment);
    expect(result).toMatchObject({ status: "published", recorded: true, replayed: false, message: "已回复，访客页面会在十几秒内显示。", reply: { authorKind: "agent", text: "谢谢！第二步指的是先保存。" } });
    expect(JSON.stringify(result)).not.toContain(backend.token);
    const [post] = posts();
    const externalId = backend.rows[0].externalId;
    expect(post).toMatchObject({ url: `/_board/comments/${externalId}/replies`, authorization: `Bearer ${backend.token}`, key: replyKey(scope, comment.id, "reply-1"), body: { text: "谢谢！第二步指的是先保存。", authorKind: "agent" } });
    expect(post.origin).toBeUndefined();
    expect(post.key).toMatch(/^ir-[a-f0-9]{48}$/);
    const stored = (await current()).comments[0];
    expect(stored).toMatchObject({ status: "resolved", replies: [{ replyId: backend.replies.get(post.key!)!.reply.replyId, key: post.key }] });
    expect(await reply(comment)).toMatchObject({ status: "published", replayed: true });
    expect(posts()).toHaveLength(1);
    // A human reply is posted as the owner and needs no automatic handling.
    const state = await current();
    await inbox.setPolicy({ ...scope, expectedRevision: state.revision, eventId: "all-off", policy: { read: false, triage: false } }, human);
    expect(await reply(stored, "human-1", "作者亲自回复。\r\n第二行", human)).toMatchObject({ status: "published", reply: { authorKind: "owner", text: "作者亲自回复。\n第二行" } });
    expect(posts().at(-1)!.body).toEqual({ text: "作者亲自回复。\n第二行", authorKind: "owner" });
    await expect(reply(stored, "assistant-off", "x")).rejects.toHaveProperty("code", "forbidden");
  });

  it("keeps a transient failure as sending and the retry with the same key confirms it", async () => {
    await enable(); const comment = await visitorComment();
    backend.failReply = ["network"];
    expect(await reply(comment)).toMatchObject({ status: "sending", recorded: true, message: "回复已排队，系统会用同一编号自动重试。不要用新的 eventId 重试。", pending: { state: "sending" } });
    for (const failure of ["500", "429", "403", "401"] as const) {
      backend.failReply.push(failure);
      expect(await connections.retryPending(scope, comment.id, replyKey(scope, comment.id, "reply-1"))).toMatchObject({ status: "sending" });
    }
    expect(events.at(-1)).toMatchObject({ status: "sending", lastError: "后端拒绝了收件箱令牌，请在「后端来源」里更新。" });
    const keys = new Set(posts().map(post => post.key));
    expect(await connections.retryPending(scope, comment.id, replyKey(scope, comment.id, "reply-1"))).toMatchObject({ status: "published", recorded: true });
    expect(keys.size).toBe(1); expect(new Set(posts().map(post => post.key)).size).toBe(1);
    expect(backend.replies.size).toBe(1);
  });

  it.each([
    ["404-export-disabled", "后端没有设置收件箱令牌（BOARD_INBOX_EXPORT_TOKEN），回复暂停发送；设置后重新部署即可继续。"],
    ["404-comments-disabled", "后端关闭了评论功能（board-app.json 的 comments.enabled），回复暂停发送；重新开启并部署后即可继续。"],
  ] as const)("keeps a reply sending while the backend is configured without %s", async (failure, lastError) => {
    await enable(); const comment = await visitorComment();
    backend.failReply.push(failure);
    expect(await reply(comment)).toMatchObject({ status: "sending", recorded: true, pending: { state: "sending" } });
    expect(events.at(-1)).toMatchObject({ status: "sending", lastError });
    expect((await current()).comments[0].pendingReply).toMatchObject({ state: "sending", failedReason: null });
    expect(await connections.retryPending(scope, comment.id, replyKey(scope, comment.id, "reply-1"))).toMatchObject({ status: "published", recorded: true });
  });

  it.each([
    ["404-old", "backend_outdated", "后端版本过旧，不支持回复：在应用目录运行 paseo-board-app update-runtime，然后重新部署。"],
    ["409-key", "idempotency_conflict", "这个回复编号已用于另一条回复。"],
    ["409-limit", "size_limit", "这条评论的回复已达 20 条上限。"],
  ] as const)("maps a definitive %s to a failed pending", async (failure, code, message) => {
    await enable(); const comment = await visitorComment();
    backend.failReply.push(failure);
    await expect(reply(comment)).rejects.toMatchObject({ code, message });
    expect((await current()).comments[0].pendingReply).toMatchObject({ state: "failed", failedReason: message });
    expect(await reply(comment)).toMatchObject({ status: "failed", replayed: true, message: `回复没能送达：${message}` });
  });

  it("maps an unknown comment to not_found", async () => {
    await enable(); const comment = await visitorComment();
    backend.rows.length = 0;
    await expect(reply(comment)).rejects.toMatchObject({ code: "not_found", message: "后端没有这条评论（后端可能已更换或恢复了旧数据）。" });
  });

  it("lets exactly one of two concurrent callers reach the backend", async () => {
    await enable(); const comment = await visitorComment();
    let release!: () => void; backend.holdReplies = new Promise(resolve => { release = resolve; });
    const settled = Promise.allSettled([reply(comment), reply(comment), reply(comment, "reply-other", "另一条")]);
    await new Promise(resolve => setTimeout(resolve, 100)); release();
    const results = await settled;
    // Whichever eventId takes the per-comment lease first wins; its callers all see the one published reply.
    const sameStatus = results.slice(0, 2).map(result => result.status);
    expect(sameStatus[0]).toBe(sameStatus[1]);
    const winners = results.filter(result => result.status === "fulfilled");
    expect(winners.length).toBeGreaterThan(0);
    for (const result of winners) expect(result).toMatchObject({ value: { status: "published" } });
    for (const result of results.filter(item => item.status === "rejected")) expect(result).toMatchObject({ reason: { code: "revision_conflict" } });
    expect(winners.length === 2 ? results[2].status : results[0].status).toBe("rejected");
    expect(posts()).toHaveLength(1);
  });

  it("returns published with recorded:false when the confirm write fails, and the outbox confirms it later", async () => {
    await enable(); const comment = await visitorComment();
    vi.spyOn(inbox, "confirmReply").mockRejectedValueOnce(new BoardStoreError("size_limit", "Inbox storage limit reached"));
    expect(await reply(comment)).toMatchObject({ status: "published", recorded: false, message: "已发送给访客；本地记录稍后自动补上。不要用新的 eventId 重试。" });
    expect((await current()).comments[0].pendingReply).toMatchObject({ state: "sending" });
    expect(await connections.retryPending(scope, comment.id, replyKey(scope, comment.id, "reply-1"))).toMatchObject({ status: "published", recorded: true });
    expect(backend.replies.size).toBe(1); expect(posts().map(post => post.key)).toEqual([replyKey(scope, comment.id, "reply-1"), replyKey(scope, comment.id, "reply-1")]);
    expect((await current()).comments[0].replies).toHaveLength(1);
  });

  it("recovers a reply the backend stored before its pending expired: a human retry replays the same key", async () => {
    await enable(); const comment = await visitorComment();
    vi.spyOn(inbox, "confirmReply").mockRejectedValueOnce(new BoardStoreError("size_limit", "Inbox storage limit reached"));
    expect(await reply(comment)).toMatchObject({ status: "published", recorded: false });
    const key = replyKey(scope, comment.id, "reply-1");
    await connections.expirePending(scope, comment.id, key, "后端返回 HTTP 500");
    expect((await current()).comments[0].pendingReply).toMatchObject({ state: "failed" });
    expect(await connections.replyPending({ ...scope, eventId: "retry-after-expiry", commentId: comment.id, key, action: "retry" })).toMatchObject({ status: "published", recorded: true });
    expect(backend.replies.size).toBe(1); expect(new Set(posts().map(post => post.key))).toEqual(new Set([key]));
    expect((await current()).comments[0]).toMatchObject({ replies: [{ key }] });
    expect((await current()).comments[0].pendingReply).toBeUndefined();
  });

  it("refuses replies that look like secrets; only the human may override", async () => {
    await enable(); const comment = await visitorComment();
    for (const text of [`token ${backend.token}`, `后端在 ${backend.endpoint}`, "-----BEGIN PRIVATE KEY-----", "看 /Users/me/.ssh", `hex ${"ab".repeat(20)}`]) {
      await expect(reply(comment, `guard-${text.length}`, text)).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^回复看起来包含私密信息（.+），未发送。$/) });
    }
    expect(posts()).toHaveLength(0);
    await expect(connections.reply({ ...scope, commentId: comment.id, expectedCommentRevision: comment.revision, eventId: "agent-override", text: "-----BEGIN", allowSensitive: true }, assistant)).rejects.toHaveProperty("code", "invalid_input");
    expect(await connections.reply({ ...scope, commentId: comment.id, expectedCommentRevision: comment.revision, eventId: "human-override", text: "-----BEGIN 示例", allowSensitive: true }, human)).toMatchObject({ status: "published", reply: { authorKind: "owner" } });
    expect(await reply({ ...comment, revision: 3 }, "ordinary", "谢谢反馈，页面 https://cm-bf.github.io/pages/boards/s0123456789abcdef0123/ 已更新。")).toMatchObject({ status: "published" });
  });

  it("counts the assistant's hourly reply budget by the host clock even when the backend clock runs behind", async () => {
    await enable();
    backend.skewMs = -2 * 3_600_000;
    for (let index = 0; index < 31; index++) backend.add({ text: `评论 ${index}`, visitorTag: "a1b2c3d4e5f6" });
    await syncNow();
    const comments = (await current()).comments;
    for (const [index, comment] of comments.slice(0, 30).entries()) expect(await reply(comment, `budget-${index}`, "谢谢反馈。"), String(index)).toMatchObject({ status: "published", recorded: true });
    const stored = (await current()).comments[0].replies![0];
    expect(Date.parse(stored.createdAt)).toBeLessThan(Date.now() - 3_600_000);
    expect(Math.abs(Date.parse(stored.confirmedAt!) - Date.now())).toBeLessThan(60_000);
    await expect(reply(comments[30], "budget-30", "谢谢反馈。")).rejects.toMatchObject({ code: "rate_limited", message: "回复过于频繁：每张 Board 每小时最多 30 条 AI 助手回复。" });
    expect(posts()).toHaveLength(30);
  });

  it("lets the assistant reply only to comments from its own wakes, and never repeat another visitor's comment", async () => {
    await enable();
    backend.add({ text: "我的电话是 138-0013-8000，住在幸福路 12 号，请不要公开。", visitorTag: "aaaaaaaaaaaa" });
    backend.add({ text: "第二步看不懂", visitorTag: "bbbbbbbbbbbb" });
    backend.add({ text: "第三步也看不懂", visitorTag: "bbbbbbbbbbbb" });
    await syncNow();
    const [private_, mine, later] = (await current()).comments;
    const woken = new Set([mine.id]);
    const scoped = new InboxStore(root, { resolveBoard: async () => ({ createdAt: scope.expectedCreatedAt, ownerAgentId: "owner" }), authorizeAssistant: async (_scope, id) => id === "assistant", assistantComments: async () => woken });
    const scopedConnections = new InboxConnections(root, scoped);
    const scopedReply = (comment: { id: string; revision: number }, eventId: string, text: string, actor: InboxActor = assistant) => scopedConnections.reply({ ...scope, commentId: comment.id, expectedCommentRevision: comment.revision, eventId, text }, actor);
    await expect(scopedReply(later, "not-woken", "谢谢。")).rejects.toMatchObject({ code: "forbidden", message: "评论助手只能回复唤醒它时列出的评论。" });
    await expect(scopedReply(private_, "other-thread", "请看 https://example.com/offer")).rejects.toMatchObject({ code: "forbidden" });
    await expect(scopedReply(mine, "leak", "另一位访客说：我的电话是 138-0013-8000，住在幸福路 12 号。")).rejects.toMatchObject({ code: "invalid_input", message: "回复里有一段和其他访客的评论相同（连续 16 个字以上）。访客之间互相看不到评论，请换一种说法。" });
    await expect(scopedReply(mine, "leak-spaced", "另一位访客说：我的电话是   138-0013-8000，\n住在幸福路 12 号。")).rejects.toMatchObject({ code: "invalid_input" });
    expect(posts()).toHaveLength(0);
    expect(await scopedReply(mine, "own-thread", "第三步也看不懂的话，可以先看第一节。第二步看不懂没关系。")).toMatchObject({ status: "published" });
    // The human may reply anywhere and is not checked for quotes.
    expect(await scopedReply(later, "human", "作者回复：我的电话是 138-0013-8000，住在幸福路", human)).toMatchObject({ status: "published", reply: { authorKind: "owner" } });
  });

  it("stores review-mode drafts, publishes them unchanged as agent text and edited as owner text", async () => {
    await enable("review"); const comment = await visitorComment();
    const draft = await reply(comment);
    expect(draft).toMatchObject({ status: "draft", message: "回复已保存为草稿，等用户审核后发布。" });
    expect(posts()).toHaveLength(0);
    const published = await connections.replyPending({ ...scope, eventId: "publish", commentId: comment.id, key: draft.pending!.key, action: "publish", text: "作者修改后的回复" });
    expect(published).toMatchObject({ status: "published", reply: { authorKind: "owner", text: "作者修改后的回复" } });
    expect(posts()[0].body).toEqual({ text: "作者修改后的回复", authorKind: "owner" });
  });

  it("expires a pending after 24 hours of failed delivery", async () => {
    await enable(); const comment = await visitorComment();
    backend.failReply.push("500");
    expect(await reply(comment)).toMatchObject({ status: "sending" });
    await connections.expirePending(scope, comment.id, replyKey(scope, comment.id, "reply-1"), "后端返回 HTTP 500");
    expect((await current()).comments[0].pendingReply).toMatchObject({ state: "failed", failedReason: "24 小时内没能确认送达：后端返回 HTTP 500" });
  });
});
