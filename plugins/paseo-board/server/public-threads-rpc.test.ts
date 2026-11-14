import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { contributeServer } from "./contribute";
import { toolDefinitions } from "./runtime";
import { InboxStore } from "./inbox-store";
import type { InboxConnections, ModerationListing, RuntimeSource } from "./inbox-sync";
import { publicThreads } from "./public-threads-rpc";
import { InboxPublicThreadsSchema } from "../shared/inbox-public";

type Handler = (input: unknown, context: { paseo: unknown }) => Promise<unknown>;
const PUBLIC_RPCS = ["board.inbox.public-threads", "board.inbox.public-state", "board.inbox.public-page", "board.inbox.public-hide-visitor"];

describe("public-threads wiring (public-threads DESIGN §5.4.3, §12 A11)", () => {
  let dir: string, handlers: Map<string, Handler>, dispose: () => Promise<void>;
  const paseo = { agents: { ref: () => ({ refresh: async () => null, current: () => null, timeline: { subscribe: () => Object.assign(() => undefined, { ready: Promise.resolve() }) } }) } };
  beforeEach(async () => {
    dir = await mkdtemp("/tmp/pbc-pt-");
    handlers = new Map();
    const server = { handle: (contract: { name: string }, handler: Handler) => { handlers.set(contract.name, handler); }, before: () => () => undefined, on: () => () => undefined } as unknown as PluginServerContext;
    dispose = contributeServer(server, { rootDir: join(dir, "data"), runtimeDir: join(dir, "rt"), home: join(dir, "home"), linkSkills: false }) as unknown as () => Promise<void>;
  });
  afterEach(async () => { await dispose(); await rm(dir, { recursive: true, force: true }); });

  it("registers the public-thread RPCs for the human UI only; agents get no new tool, and the reply tool says public replies are drafts", async () => {
    for (const name of PUBLIC_RPCS) expect(handlers.has(name), name).toBe(true);
    const tools = toolDefinitions().map(tool => tool.name);
    for (const name of tools) expect(name).not.toMatch(/public|hide|moderat/);
    expect(tools.filter(name => name.startsWith("board_inbox_"))).toEqual(["board_inbox_list", "board_inbox_read", "board_inbox_triage", "board_inbox_reply"]);
    expect(toolDefinitions().find(tool => tool.name === "board_inbox_reply")!.description).toContain('For a comment with visibility "public", every visitor of that page sees the reply, so it always becomes a draft the user reviews; parentCommentId names the thread a visitor reply belongs to.');
    const board = await handlers.get("board.create")!({ title: "公开评论", html: "<main>x</main>", data: {} }, { paseo }) as { id: string; createdAt: string };
    const scope = { boardId: board.id, expectedCreatedAt: board.createdAt };
    expect(await handlers.get("board.inbox.public-threads")!(scope, { paseo })).toEqual({ revision: 0, sources: [] });
    await expect(handlers.get("board.inbox.public-state")!({ ...scope, eventId: "hide", sourceId: "nope", externalId: "00000000-0000-4000-8000-000000000001", hidden: true }, { paseo })).rejects.toMatchObject({ message: "这个后端来源已不存在。" });
  });
});

describe("the thread view merges the backend listing with the inbox's wanted state and ledger IDs", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp("/tmp/pbc-ptv-"); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("shows pending and failed decisions, ledger comment IDs and page pauses", async () => {
    const createdAt = "2026-11-14T08:00:00.000Z", scope = { boardId: "view-board", expectedCreatedAt: createdAt }, credential = "view-credential-0123456789abcdef01234567";
    const human = { kind: "user" as const, id: "paseo-client" }, ingress = { kind: "ingress" as const, sourceId: "s1", deploymentId: "d1", credential };
    const inbox = new InboxStore(root, { resolveBoard: async () => ({ createdAt }) });
    await inbox.setSource({ ...scope, expectedRevision: 0, eventId: "src", sourceId: "s1", deploymentId: "d1", label: "后端", enabled: true, credential }, human);
    const rootId = "00000000-0000-4000-8000-000000000001", replyId = "00000000-0000-4000-8000-000000000002", page = "https://example.test/p/";
    await inbox.importPage({ ...scope, eventId: "imp", sourceId: "s1", deploymentId: "d1", cursor: "0", nextCursor: "1", comments: [{ externalId: rootId, text: "根", createdAt, visitorTag: "aaaaaaaaaaaa" }], publicRows: [{ externalId: rootId, visibility: "public", publicTag: "bbbbbbbbbbbb" }] }, ingress);
    await inbox.setPublicState({ ...scope, eventId: "hide-r", sourceId: "s1", externalId: replyId, hidden: true, known: { hidden: false, resolved: false, parentId: rootId } }, human);
    await inbox.setPublicAction({ ...scope, eventId: "pause", sourceId: "s1", page, paused: true }, "pause", human);
    const listing: ModerationListing = { deploymentId: "d1", publicThreads: true, pages: [{ page, version: 3, paused: false }], releases: [], total: 1, truncated: false, threads: [{ id: rootId, page, tag: "bbbbbbbbbbbb", text: "根", createdAt, resolved: false, hidden: false, replies: [{ id: replyId, by: "visitor", tag: "cccccccccccc", text: "回复", createdAt, hidden: false }, { id: "owner-1", by: "owner", text: "作者", createdAt }], omitted: 0 }] };
    const source = { sourceId: "s1", deploymentId: "d1", label: "后端", endpoint: "https://example.test/_board/comments", token: "t", credential, enabled: true, ready: true } as RuntimeSource;
    const connections = { moderation: async () => [{ source, listing }, { source: { ...source, sourceId: "s2", label: "旧后端" }, unsupported: true }] } as unknown as InboxConnections;
    const view = InboxPublicThreadsSchema.parse(await publicThreads(inbox, connections, scope));
    const [ok, old] = view.sources;
    expect(ok.threads[0]).toMatchObject({ commentId: expect.stringMatching(/^comment-/), state: { hidden: false, resolved: false } });
    expect(ok.threads[0].replies[0]).toMatchObject({ state: { hidden: true, hiddenBy: "hide", pending: { hidden: true } } });
    expect(ok.threads[0].replies[0].commentId).toBeUndefined();
    expect(ok.threads[0].replies[1].state).toBeUndefined();
    expect(ok.pages).toEqual([{ page, paused: true, pending: true, error: null }]);
    expect(old).toMatchObject({ state: "unsupported", error: "后端版本过旧，不支持公开评论：在应用目录运行 paseo-board-app update-runtime，然后重新部署。" });
  });
});
