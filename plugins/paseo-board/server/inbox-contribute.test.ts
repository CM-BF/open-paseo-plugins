import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { contributeServer } from "./contribute";
import { PROMPT_MARKER } from "./prompts";
import { NO_CLAUDE_REFUSAL } from "./inbox-assistant";

type Handler = (input: unknown, context: { paseo: unknown }) => Promise<unknown>;
type Hook = (event: { request: Record<string, unknown> }, context: { paseo: unknown }) => Promise<{ config: Record<string, unknown> } | undefined>;

describe("contribute wiring for page comments", () => {
  let dir: string, handlers: Map<string, Handler>, hooks: Map<string, Hook>, dispose: () => Promise<void>;
  const paseo = { agents: { ref: () => ({ refresh: async () => null, current: () => null, timeline: { subscribe: () => Object.assign(() => undefined, { ready: Promise.resolve() }) } }) } };
  beforeEach(async () => {
    dir = await mkdtemp("/tmp/pbc-");
    handlers = new Map(); hooks = new Map();
    const server = {
      handle: (contract: { name: string }, handler: Handler) => { handlers.set(contract.name, handler); },
      before: (name: string, hook: Hook) => { hooks.set(name, hook); return () => hooks.delete(name); },
      on: () => () => undefined,
    } as unknown as PluginServerContext;
    dispose = contributeServer(server, { rootDir: join(dir, "data"), runtimeDir: join(dir, "rt"), home: join(dir, "home"), linkSkills: false }) as unknown as () => Promise<void>;
  });
  afterEach(async () => { await dispose(); await rm(dir, { recursive: true, force: true }); });

  it("keeps a caller's toolPolicy and mode while injecting the Board MCP server and instructions", async () => {
    const toolPolicy = { preapproved: ["board_inbox_list", "board_inbox_read", "board_inbox_triage", "board_inbox_reply"].map(tool => ({ kind: "mcp", server: "paseo_board", tool })) };
    const result = await hooks.get("agent.create")!({ request: { cwd: dir, env: {}, config: { provider: "claude/sonnet", modeId: "default", systemPrompt: "You are the comment assistant.", toolPolicy } } }, { paseo });
    expect(result!.config.toolPolicy).toEqual(toolPolicy);
    expect(result!.config.modeId).toBe("default");
    expect((result!.config.mcpServers as Record<string, { type: string }>).paseo_board.type).toBe("stdio");
    expect(String(result!.config.systemPrompt)).toMatch(new RegExp(`^You are the comment assistant\\.[^]*${PROMPT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("registers the human-only automation, reply and archive RPCs and serves auto-status for a Board", async () => {
    for (const name of ["board.inbox.assistant-options", "board.inbox.auto-enable", "board.inbox.auto-status", "board.inbox.auto-set", "board.inbox.reply", "board.inbox.reply-pending", "board.inbox.archive"]) expect(handlers.has(name), name).toBe(true);
    const board = await handlers.get("board.create")!({ title: "评论演示", html: "<main>x</main>", data: {} }, { paseo }) as { id: string; createdAt: string };
    const scope = { boardId: board.id, expectedCreatedAt: board.createdAt };
    expect(await handlers.get("board.inbox.auto-status")!(scope, { paseo })).toMatchObject({ revision: 0, sync: { paused: false, intervalSeconds: 5, sources: [] }, wake: { state: "off", pausedReason: null }, assistant: null, replies: { sending: 0 } });
    // A host whose config cannot be read has no usable Claude route: refused before any process is started.
    expect(await handlers.get("board.inbox.assistant-options")!(scope, { paseo })).toMatchObject({ refusal: NO_CLAUDE_REFUSAL, models: [] });
    await expect(handlers.get("board.inbox.auto-enable")!({ ...scope, expectedRevision: 0, eventId: "enable", replyMode: "publish", modelId: "claude-haiku-5-5" }, { paseo })).rejects.toMatchObject({ code: "invalid_input", message: NO_CLAUDE_REFUSAL });
    await expect(handlers.get("board.inbox.policy")!({ ...scope, expectedRevision: 0, eventId: "sneak", policy: { read: true, triage: true, auto: "publish" } }, { paseo })).rejects.toMatchObject({ message: "开启自动处理需要通过确认步骤。" });
    expect(await handlers.get("board.inbox.auto-set")!({ ...scope, syncPaused: true }, { paseo })).toMatchObject({ sync: { paused: true } });
  });
});
