import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { InboxConnections } from "./inbox-sync";
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
    expect(requests).toEqual([{ url: "/_board/comments?cursor=0&limit=100", token: `Bearer ${secret}` }]);
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
    for (const body of ["not JSON", { deploymentId: "other", cursor: "0", nextCursor: "1", comments: [comment] }, { deploymentId: "deployment-1", cursor: "other", nextCursor: "1", comments: [comment] }, { deploymentId: "deployment-1", cursor: "0", nextCursor: "1", comments: [{ ...comment, command: "execute" }] }, "x".repeat(500_001)]) {
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
    const results = await Promise.allSettled([sync(), sync(1, "another-sync")]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(requests).toHaveLength(1); expect((await state()).total).toBe(1);
    await connections.connect({ ...input(), expectedRevision: 2, expectedConnectionEventId: "source-connect", eventId: "disable", enabled: false, token: undefined });
    await expect(sync(3)).rejects.toThrow("enabled"); expect(requests).toHaveLength(1);
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
    expect(requests[0]).toEqual({ url: "/_board/comments/new?cursor=0&limit=100", token: "Bearer new-private-token-0123456789abcdef01234567" });
  });
});
