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
import { InboxStore } from "./inbox-store";
import { InboxConnections } from "./inbox-sync";

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
