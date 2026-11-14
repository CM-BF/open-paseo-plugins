import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "./inbox-store";
import { InboxConnections, MODERATION_TOO_LARGE } from "./inbox-sync";
import { PublicStateOutbox } from "./inbox-public";
import { publicThreads, shownState } from "./public-threads-rpc";

/*
 * Public threads in the inbox against the real backend runtime (backend/*.mjs) in temporary directories: what the
 * thread view shows, the outbox and its hourly re-push after bulk hides and withdrawals, and the moderation listing
 * size. Regression tests for the public-threads review (2026-11-14).
 */
const TOKEN = "q".repeat(48);
const ORIGIN = "https://example.github.io", PAGE = `${ORIGIN}/pages/a/`, RELEASE = `release-${"c".repeat(64)}`;
const human = { kind: "user" as const, id: "paseo-client" };
type Listed = { threads: Array<{ id: string; text: string; replies: Array<{ id: string; text: string }> }> };
type Running = { port: number; deploymentId: string; close(): Promise<void> };

describe("public threads with the real backend runtime", () => {
  let dir: string, running: Running, base: string, endpoint: string, original: string | undefined;
  let inbox: InboxStore, connections: InboxConnections, failRoute: string | null, hugeRoute: string | null, watch: ((url: string) => Promise<void>) | null;
  const scope = { boardId: "review-board", expectedCreatedAt: "2026-11-14T08:00:00.000Z" };
  let key = 0;
  const post = (visitor: number, body: Record<string, unknown>) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `review-key-${++key}`, "x-board-visitor": (visitor + 1).toString(16).padStart(64, "0"), "x-forwarded-for": `198.51.${100 + (visitor >> 8)}.${visitor & 255}` }, body: JSON.stringify(body) });
  const posted = async (visitor: number, body: Record<string, unknown>) => { const response = await post(visitor, body); expect(response.status, await response.clone().text()).toBe(201); return (await response.json() as { comment: { externalId: string; tag: string } }).comment; };
  const root = (text: string) => ({ text, pageUrl: PAGE, visibility: "public", anchor: { selector: "body", quote: "x", releaseId: RELEASE } });
  const listed = async () => (await (await fetch(`${endpoint}/public?page=${encodeURIComponent(PAGE)}&release=${RELEASE}`)).json() as Listed).threads.map(thread => thread.text);
  const sync = async (eventId: string) => { const revision = (await inbox.list({ ...scope, limit: 1 }, human)).revision; await connections.sync({ ...scope, expectedRevision: revision, eventId, sourceId: "app" }); };
  const view = async () => (await publicThreads(inbox, connections, scope)).sources[0];

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "pbc-public-backend-")));
    original = process.env.BOARD_INBOX_EXPORT_TOKEN; process.env.BOARD_INBOX_EXPORT_TOKEN = TOKEN;
    // @ts-expect-error JavaScript runtime modules.
    const { initializeApp } = await import("../backend/scaffold.mjs"); const { loadApp, readJson } = await import("../backend/files.mjs"); const { startApp } = await import("../backend/server.mjs");
    const appDir = join(dir, "app"); await initializeApp(appDir, "review-app");
    const config = await readJson(join(appDir, "board-app.json"));
    await writeFile(join(appDir, "board-app.json"), JSON.stringify({ ...config, port: 0, origins: [ORIGIN], comments: { enabled: true, limits: { requestsPerIpMinute: 3000, postPerIpMinute: 100, postPerIpHour: 600, postPerVisitorMinute: 50, postPerVisitorHour: 300, postGlobalMinute: 1200, publicPostsGlobalHour: 1500, publicRootsPerVisitorPageDay: 100, publicPostsPerPageDay: 1000, postPerPageDay: 5000, listPerIpMinute: 6000 } } }));
    running = await startApp(await loadApp(appDir)) as Running;
    base = `http://127.0.0.1:${running.port}`; endpoint = `${base}/_board/comments`;
    expect((await fetch(`${endpoint}/public-releases/${RELEASE}`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: "{}" })).status).toBe(200);
    failRoute = null; hugeRoute = null; watch = null;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (failRoute && url.includes(failRoute)) return new Response(JSON.stringify({ error: "x" }), { status: 503 });
      if (hugeRoute && url.includes(hugeRoute)) return new Response("x".repeat(1_100_000), { status: 200 });
      const response = await fetch(input, init);
      if (watch) await watch(url);
      return response;
    }) as typeof fetch;
    inbox = new InboxStore(join(dir, "paseo-data"), { resolveBoard: async () => ({ createdAt: scope.expectedCreatedAt, ownerAgentId: "owner" }) });
    connections = new InboxConnections(join(dir, "paseo-data"), inbox, fetcher);
    await connections.connect({ ...scope, expectedRevision: 0, eventId: "connect-app", expectedConnectionEventId: null, sourceId: "app", deploymentId: running.deploymentId, label: "My app", endpoint, enabled: true, token: TOKEN });
  });
  afterEach(async () => {
    await running.close();
    if (original === undefined) delete process.env.BOARD_INBOX_EXPORT_TOKEN; else process.env.BOARD_INBOX_EXPORT_TOKEN = original;
    await rm(dir, { recursive: true, force: true });
  });

  it("a bulk hide is never undone by the re-push, not even between two requests or when the bulk request fails; the view shows the backend's state", async () => {
    const spam = await posted(1, root("垃圾广告 SPAM"));
    await sync("sync-1");
    const outbox = new PublicStateOutbox({ inbox, connections, log: () => undefined });
    await inbox.setPublicState({ ...scope, eventId: "resolve-1", sourceId: "app", externalId: spam.externalId, resolved: true }, human);
    await outbox.flush(scope);
    await inbox.setPublicAction({ ...scope, eventId: "hide-visitor-1", sourceId: "app", page: PAGE, tag: spam.tag, hidden: true }, "hide-visitor", human);
    await outbox.flush(scope);
    outbox.close();
    expect(await listed()).toEqual([]);
    const shown = (await view()).threads.find(thread => thread.id === spam.externalId)!;
    expect(shown.state).toMatchObject({ hidden: true, resolved: true, hiddenBy: "hide" });
    expect(shown.state).not.toHaveProperty("pending");
    // The hourly re-push (also at every plugin start) with the bulk request failing: the comment stays hidden.
    failRoute = "/public/hide-visitor";
    const restarted = new PublicStateOutbox({ inbox, connections, log: () => undefined });
    await restarted.start(); restarted.close();
    failRoute = null;
    expect(await listed()).toEqual([]);
    // A clean re-push: hidden at every step in between.
    const seen: string[][] = [];
    watch = async url => { if (url.includes("/state") || url.includes("/public/")) seen.push(await listed()); };
    const again = new PublicStateOutbox({ inbox, connections, log: () => undefined });
    await again.start(); again.close();
    watch = null;
    expect(seen.length).toBeGreaterThan(0);
    for (const step of seen) expect(step).toEqual([]);
    // Leaving 不处理 after a bulk hide does not show it again either.
    const comment = (await inbox.list({ ...scope, limit: 10 }, human)).comments.find(item => item.externalId === spam.externalId)!;
    const dismissed = await inbox.triage({ ...scope, expectedRevision: (await inbox.list({ ...scope, limit: 1 }, human)).revision, eventId: "dismiss", commentId: comment.id, expectedCommentRevision: comment.revision, status: "dismissed", labels: [], note: "" }, human);
    const afterDismiss = (await inbox.list({ ...scope, limit: 10 }, human)).comments.find(item => item.id === comment.id)!;
    await inbox.triage({ ...scope, expectedRevision: dismissed.revision, eventId: "undismiss", commentId: comment.id, expectedCommentRevision: afterDismiss.revision, status: "reviewing", labels: [], note: "" }, human);
    const later = new PublicStateOutbox({ inbox, connections, log: () => undefined });
    await later.start(); await later.flush(scope); later.close();
    expect(await listed()).toEqual([]);
  });

  it("the outbox sends decisions in the order they were made: an explicit show after a pending bulk hide wins; bulk shows are not re-pushed", async () => {
    const first = await posted(2, root("第一条")), second = await posted(2, root("第二条"));
    await sync("sync-2");
    // The backend is unreachable while the human hides the visitor, then shows one comment again.
    failRoute = "/_board/comments/";
    const outbox = new PublicStateOutbox({ inbox, connections, log: () => undefined });
    await inbox.setPublicAction({ ...scope, eventId: "bulk", sourceId: "app", page: PAGE, tag: first.tag, hidden: true }, "hide-visitor", human);
    await inbox.setPublicState({ ...scope, eventId: "show-second", sourceId: "app", externalId: second.externalId, hidden: false }, human);
    await outbox.flush(scope);
    failRoute = null;
    await outbox.flush(scope);
    outbox.close();
    expect(await listed()).toEqual(["第二条"]);
    // Undoing the bulk hide shows every comment; a restore-time re-push does not repeat that undo.
    await inbox.setPublicAction({ ...scope, eventId: "unbulk", sourceId: "app", page: PAGE, tag: first.tag, hidden: false }, "hide-visitor", human);
    const again = new PublicStateOutbox({ inbox, connections, log: () => undefined });
    await again.flush(scope);
    expect((await listed()).sort()).toEqual(["第一条", "第二条"]);
    const sent: string[] = [];
    watch = async url => { sent.push(url.replace(endpoint, "")); };
    await again.start(); again.close();
    watch = null;
    expect(sent.filter(path => path.startsWith("/public/hide-visitor"))).toEqual([]);
  });

  it("a comment the visitor withdrew is recorded as withdrawn when the re-push meets it, and shown as withdrawn", async () => {
    const thread = await posted(3, root("后来撤回的讨论"));
    await sync("sync-3");
    const outbox = new PublicStateOutbox({ inbox, connections, log: () => undefined });
    await inbox.setPublicState({ ...scope, eventId: "resolve", sourceId: "app", externalId: thread.externalId, resolved: true }, human);
    await outbox.flush(scope);
    expect((await fetch(`${endpoint}/${thread.externalId}/withdraw`, { method: "POST", headers: { "x-board-visitor": (4).toString(16).padStart(64, "0") } })).status).toBe(200);
    expect((await view()).threads[0].state).toMatchObject({ hidden: true, withdrawn: true, resolved: true });
    await outbox.start(); outbox.close();
    const record = (await inbox.publicLedger(scope, human)).records.find(item => item.externalId === thread.externalId)!;
    expect(record).toMatchObject({ withdrawn: true, hidden: true }); expect(record).not.toHaveProperty("error");
    expect(await listed()).toEqual([]);
  });

  it("a moderation listing full of long CJK comments stays readable: the 公开讨论 view loads", async () => {
    const big = "评".repeat(2000), quote = "论".repeat(1000);
    let first = "";
    for (let i = 0; i < 100; i++) { const comment = await posted(100 + i, { text: big, pageUrl: PAGE, visibility: "public", anchor: { selector: "body", quote, releaseId: RELEASE } }); first ||= comment.externalId; }
    for (let i = 0; i < 20; i++) await posted(300 + i, { text: big, pageUrl: PAGE, visibility: "public", parentId: first, anchor: { releaseId: RELEASE } });
    const raw = await (await fetch(`${endpoint}/public/moderation`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(900_000);
    const source = await view();
    expect(source.state).toBe("ok"); expect(source.error).toBeNull();
    expect(source.truncated).toBe(true); expect(source.threads.length).toBeGreaterThan(10);
    // A backend from before the byte budget: the tab says what to do instead of claiming that auto-sync stopped.
    hugeRoute = "/public/moderation";
    expect(await view()).toMatchObject({ state: "error", error: MODERATION_TOO_LARGE });
    expect(MODERATION_TOO_LARGE).not.toContain("自动同步");
  }, 30_000);

  it("withdrawing a share's release through the inbox source closes the share's page to every release; registering for it reopens the page", async () => {
    await posted(5, root("公开中的讨论"));
    const other = `release-${"d".repeat(64)}`;
    await connections.publicRelease(scope, running.deploymentId, other, true, [PAGE]);
    await connections.publicRelease(scope, running.deploymentId, other, false, [PAGE]);
    expect((await fetch(`${endpoint}/public?page=${encodeURIComponent(PAGE)}&release=${RELEASE}`)).status).toBe(404);
    expect((await post(6, root("关了以后"))).status).toBe(403);
    await connections.publicRelease(scope, running.deploymentId, other, true, [PAGE]);
    expect(await listed()).toEqual(["公开中的讨论"]);
    await connections.publicRelease(scope, running.deploymentId, other, false);
    expect(await listed()).toEqual(["公开中的讨论"]);
  });

  it("the shown state is the backend's, overlaid only by an unconfirmed, unrefused decision", () => {
    const record = { sourceId: "app", externalId: "x", hidden: false, resolved: true, explicit: true as const, updatedAt: scope.expectedCreatedAt };
    expect(shownState({ hidden: true, resolved: true }, record)).toEqual({ hidden: true, resolved: true });
    expect(shownState({ hidden: false, resolved: false }, { ...record, hidden: true, hiddenBy: "hide", pending: { hidden: true } })).toEqual({ hidden: true, resolved: false, hiddenBy: "hide", pending: { hidden: true } });
    expect(shownState({ hidden: false, resolved: false }, { ...record, hidden: true, hiddenBy: "hide", pending: { hidden: true }, error: "后端认为这条评论不是公开评论。" })).toEqual({ hidden: false, resolved: false, pending: { hidden: true }, error: "后端认为这条评论不是公开评论。" });
    expect(shownState({ hidden: true, withdrawn: true, resolved: false }, record)).toEqual({ hidden: true, resolved: false, withdrawn: true });
    expect(shownState({ hidden: false, resolved: false }, undefined)).toEqual({ hidden: false, resolved: false });
  });
});
