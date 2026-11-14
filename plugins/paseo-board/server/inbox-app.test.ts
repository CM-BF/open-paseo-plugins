import { expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The editable standalone application runtime is JavaScript with no plugin dependencies.
// @ts-expect-error standalone runtime
import { initializeApp } from "../backend/scaffold.mjs";
// @ts-expect-error standalone runtime
import { loadApp } from "../backend/files.mjs";
// @ts-expect-error standalone runtime
import { startApp } from "../backend/server.mjs";
// @ts-expect-error standalone runtime
import { normalizeCommentInput } from "../backend/comments.mjs";
// @ts-expect-error test fixture module
import { LegacyInboxPageSchema } from "../scripts/fixtures/legacy-inbox-page.mjs";
import { InboxStore } from "./inbox-store";
import { InboxConnections } from "./inbox-sync";
import { normalizeExternalComment } from "../shared/inbox";

it("takes a real visitor comment from an independently generated app into a permissioned Board inbox", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "board-app-inbox-"))), appDir = join(root, "app");
  const previousToken = process.env.BOARD_INBOX_EXPORT_TOKEN;
  const token = "integration-only-export-token-0123456789abcdef";
  let running: { port: number; deploymentId: string; close(): Promise<void> } | undefined;
  try {
    await initializeApp(appDir, "free-backend");
    const configPath = join(appDir, "board-app.json"), config = JSON.parse(await readFile(configPath, "utf8"));
    config.port = 0; config.comments.enabled = true;
    await writeFile(configPath, JSON.stringify(config));
    process.env.BOARD_INBOX_EXPORT_TOKEN = token;
    running = await startApp(await loadApp(appDir));
    const endpoint = `http://127.0.0.1:${running!.port}/_board/comments`;
    const body = { text: "The result needs an explanation. <script>not trusted</script>", authorName: "Visitor", pageUrl: "https://site.example.test/report" };
    const send = () => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "visitor-intent-1" }, body: JSON.stringify(body) });
    const first = await send(); expect(first.ok).toBe(true); const receipt = await first.json() as Record<string, unknown>;
    const duplicate = await send(); expect(duplicate.ok).toBe(true); expect(await duplicate.json()).toEqual({ ...receipt, replayed: true });
    expect((await fetch(endpoint)).status).toBe(401);
    const scope = { boardId: "test-inbox", expectedCreatedAt: new Date().toISOString() };
    const human = { kind: "user" as const, id: "paseo-client" }, agent = { kind: "agent" as const, agentId: "owner" };
    const inbox = new InboxStore(join(root, "paseo-data"), { resolveBoard: async () => ({ id: scope.boardId, createdAt: scope.expectedCreatedAt, ownerAgentId: "owner" }) });
    const connections = new InboxConnections(join(root, "paseo-data"), inbox);
    await connections.connect({ ...scope, expectedRevision: 0, eventId: "connect-app", expectedConnectionEventId: null, sourceId: "app", deploymentId: running!.deploymentId, label: "My app", endpoint, enabled: true, token });
    expect(await connections.sync({ ...scope, expectedRevision: 1, eventId: "sync", sourceId: "app" })).toMatchObject({ imported: 1 });
    await expect(inbox.list(scope, agent)).rejects.toHaveProperty("code", "forbidden");
    await inbox.setPolicy({ ...scope, expectedRevision: 2, eventId: "read-only", policy: { read: true, triage: false } }, human);
    const page = await inbox.list(scope, agent), comment = page.comments[0];
    expect(page.total).toBe(1); expect(comment).toMatchObject({ text: body.text, authorName: body.authorName, contentTrust: "external-untrusted" });
    const triage = { ...scope, expectedRevision: 3, eventId: "review", commentId: comment.id, expectedCommentRevision: comment.revision, status: "reviewing" as const, labels: ["clarity"], note: "Check the explanation" };
    await expect(inbox.triage(triage, agent)).rejects.toHaveProperty("code", "forbidden");
    await inbox.setPolicy({ ...scope, expectedRevision: 3, eventId: "triage-allowed", policy: { read: true, triage: true } }, human);
    await inbox.triage({ ...triage, expectedRevision: 4 }, agent);
    await running!.close(); running = await startApp(await loadApp(appDir));
    const exported = await fetch(`http://127.0.0.1:${running!.port}/_board/comments?cursor=0&limit=100`, { headers: { Authorization: `Bearer ${token}` } }).then(result => result.json()) as { comments: Array<Record<string, unknown>> };
    expect(exported.comments).toHaveLength(1); expect(exported.comments[0].text).toBe(body.text);
    expect(exported.comments[0]).not.toHaveProperty("note"); expect(exported.comments[0]).not.toHaveProperty("status");
    expect(JSON.stringify(exported)).not.toContain("Check the explanation");
    await inbox.setPolicy({ ...scope, expectedRevision: 5, eventId: "revoke", policy: { read: false, triage: false } }, human);
    await expect(inbox.list(scope, agent)).rejects.toHaveProperty("code", "forbidden");
  } finally {
    await running?.close();
    if (previousToken === undefined) delete process.env.BOARD_INBOX_EXPORT_TOKEN; else process.env.BOARD_INBOX_EXPORT_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

type Fixture = { visitorSecret: string; post: { accepted: Array<{ name: string; visitor: boolean; body: Record<string, unknown>; stored: Record<string, unknown> }> } };
const expand = (value: unknown): unknown => typeof value === "string" ? value.replace(/<<repeat:(.):(\d+)>>/g, (_, char: string, count: string) => char.repeat(Number(count)))
  : Array.isArray(value) ? value.map(expand) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : value;

it("imports every comment the backend accepts on POST unchanged, with nothing sanitized (shared contract fixture)", async () => {
  const fixture = expand(JSON.parse(await readFile(new URL("../scripts/fixtures/page-comments-contract.json", import.meta.url), "utf8"))) as Fixture;
  expect(fixture.post.accepted.length).toBeGreaterThan(5);
  for (const item of fixture.post.accepted) {
    const stored = normalizeCommentInput(item.body, { visitor: item.visitor }) as Record<string, unknown>;
    expect(stored, item.name).toEqual(item.stored);
    const row = { externalId: "00000000-0000-4000-8000-000000000001", createdAt: "2026-11-13T08:00:00.000Z", ...stored, ...(item.visitor ? { visitorTag: "a1b2c3d4e5f6" } : {}) };
    const imported = normalizeExternalComment(row, 0);
    expect(imported, item.name).toEqual({ ok: true, comment: row, dropped: [] });
  }
});

it("carries a visitor thread from the real runtime through v2 sync and an assistant reply back to that visitor only", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "board-app-thread-"))), appDir = join(root, "app");
  const previousToken = process.env.BOARD_INBOX_EXPORT_TOKEN;
  const token = "integration-only-export-token-thread-0123456789abcdef";
  let running: { port: number; deploymentId: string; close(): Promise<void> } | undefined;
  try {
    await initializeApp(appDir, "thread-backend");
    const configPath = join(appDir, "board-app.json"), config = JSON.parse(await readFile(configPath, "utf8"));
    config.port = 0; config.comments.enabled = true; config.origins = ["https://cm-bf.github.io"];
    await writeFile(configPath, JSON.stringify(config));
    process.env.BOARD_INBOX_EXPORT_TOKEN = token;
    running = await startApp(await loadApp(appDir));
    const base = `http://127.0.0.1:${running!.port}`, endpoint = `${base}/_board/comments`;
    const fixture = expand(JSON.parse(await readFile(new URL("../scripts/fixtures/page-comments-contract.json", import.meta.url), "utf8"))) as Fixture;
    const rich = fixture.post.accepted.find(item => item.name === "rich anchor from a page")!;
    const visitorA = "a".repeat(64), visitorB = "b".repeat(64);
    const post = (key: string, body: unknown, visitor?: string) => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key, ...(visitor ? { "X-Board-Visitor": visitor } : {}) }, body: JSON.stringify(body) });
    const mine = async (visitor: string) => { const response = await fetch(`${endpoint}/mine?page=${encodeURIComponent(String(rich.body.pageUrl))}`, { headers: { "X-Board-Visitor": visitor } }); expect(response.status).toBe(200); return await response.json() as { threads: Array<{ id: string; status: string; text: string; replies: Array<{ text: string; authorKind: string }> }> }; };
    expect((await post("pc-thread-0001", rich.body, visitorA)).status).toBe(201);
    expect((await post("pc-thread-0002", { text: "不带访客编号的旧表单评论" })).status).toBe(201);
    expect((await mine(visitorA)).threads).toMatchObject([{ status: "sent", text: "第二步看不懂", replies: [] }]);

    // The plugin side: real store and connections; the assistant identity is what the automation would report.
    const scope = { boardId: "thread-board", expectedCreatedAt: new Date().toISOString() };
    const human = { kind: "user" as const, id: "paseo-client" }, assistant = { kind: "agent" as const, agentId: "assistant-1" }, owner = { kind: "agent" as const, agentId: "owner" };
    const inbox = new InboxStore(join(root, "paseo-data"), { resolveBoard: async () => ({ id: scope.boardId, createdAt: scope.expectedCreatedAt, ownerAgentId: "owner" }), authorizeAssistant: async (_scope, agentId) => agentId === assistant.agentId });
    const connections = new InboxConnections(join(root, "paseo-data"), inbox);
    await connections.connect({ ...scope, expectedRevision: 0, eventId: "connect-app", expectedConnectionEventId: null, sourceId: "app", deploymentId: running!.deploymentId, label: "Thread app", endpoint, enabled: true, token });
    expect(await connections.sync({ ...scope, expectedRevision: 1, eventId: "sync-1", sourceId: "app" })).toMatchObject({ imported: 2 });
    // The next export's cursor acknowledges the comment: the visitor now sees 作者已收到.
    await connections.sync({ ...scope, expectedRevision: 2, eventId: "sync-2", sourceId: "app" });
    expect((await mine(visitorA)).threads[0].status).toBe("received");
    const page = await inbox.list(scope, human);
    const visitorComment = page.comments.find(comment => comment.text === "第二步看不懂")!, formComment = page.comments.find(comment => comment.text !== "第二步看不懂")!;
    expect(visitorComment).toMatchObject({ anchor: rich.body.anchor, pageUrl: rich.body.pageUrl, contentTrust: "external-untrusted" });
    expect(visitorComment.visitorTag).toMatch(/^[a-f0-9]{12}$/);
    expect(formComment.visitorTag).toBeUndefined();

    await inbox.setPolicy({ ...scope, expectedRevision: page.revision, eventId: "auto-on", policy: { read: true, triage: true, auto: "publish" } }, human, { allowAutoEnable: true });
    const replyInput = { ...scope, commentId: visitorComment.id, expectedCommentRevision: visitorComment.revision, eventId: "reply-1", text: "谢谢！第二步指的是先保存再提交。" };
    await expect(connections.reply({ ...replyInput, eventId: "owner-try" }, owner)).rejects.toHaveProperty("code", "forbidden");
    const published = await connections.reply(replyInput, assistant);
    expect(published).toMatchObject({ status: "published", recorded: true, reply: { authorKind: "agent", text: replyInput.text } });
    expect(JSON.stringify(published)).not.toContain(token);
    expect(await connections.reply(replyInput, assistant)).toMatchObject({ status: "published", replayed: true });
    await expect(connections.reply({ ...replyInput, commentId: formComment.id, expectedCommentRevision: formComment.revision, eventId: "reply-form" }, assistant)).rejects.toMatchObject({ code: "invalid_input", message: "这位访客看不到回复（评论不是从页面评论功能发出的），只能内部处理。" });

    const seen = await mine(visitorA);
    expect(seen.threads).toMatchObject([{ status: "replied", replies: [{ text: replyInput.text, authorKind: "agent" }] }]);
    expect(seen.threads[0].replies).toHaveLength(1);
    expect((await mine(visitorB)).threads).toEqual([]);
    expect(JSON.stringify(seen)).not.toMatch(/visitor_hash|aaaaaaaaaaaaaaaa/);
    expect((await inbox.list(scope, human)).comments.find(comment => comment.id === visitorComment.id)).toMatchObject({ status: "resolved", replies: [{ authorKind: "agent", text: replyInput.text }] });

    // An old plugin reading the same runtime without format=2 still parses the page with its own schema.
    const legacy = await fetch(`${endpoint}?cursor=0&limit=100`, { headers: { Authorization: `Bearer ${token}` } }).then(response => response.json()) as { comments: Array<{ text: string; anchor?: unknown }> };
    const parsed = LegacyInboxPageSchema.safeParse(legacy);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(legacy.comments.find(comment => comment.text === "第二步看不懂")!.anchor).toEqual({ label: "结果", selector: "#result" });
    const v2 = await fetch(`${endpoint}?cursor=0&limit=100&format=2`, { headers: { Authorization: `Bearer ${token}` } }).then(response => response.json()) as Record<string, unknown>;
    expect(Object.keys(v2).sort()).toEqual(["comments", "cursor", "deploymentId", "format", "nextCursor"]);
  } finally {
    await running?.close();
    if (previousToken === undefined) delete process.env.BOARD_INBOX_EXPORT_TOKEN; else process.env.BOARD_INBOX_EXPORT_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});
