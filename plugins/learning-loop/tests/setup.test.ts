import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../shared/settings";
import { resolveFamily, transformCreate, type CreateRequest } from "../server/agent-setup";
import { callArgs, extractJsonObject, routeFrom } from "../server/kit/complete";
import { buildSystemBlock, withBlock } from "../server/prompts";
import { redact } from "../server/redact";
import { buildDigest } from "../server/review/digest";
import { parseTimeBound } from "../server/tools";

const paths = { mcp: "/state/bin/learning-loop-mcp" };
const block = async (tools: boolean) => buildSystemBlock({ tools, memorySnapshot: "MEMORY\nfact", skillsIndex: tools ? "  general:\n    - a: b" : "" });

const request = (provider: string, extra: Partial<CreateRequest["config"]> = {}): CreateRequest => ({
  config: { provider, cwd: "/repo", ...extra } as CreateRequest["config"],
});

describe("transformCreate", () => {
  it("adds the MCP server, a binding, preapprovals and the prompt block for Claude", async () => {
    const out = await transformCreate({ request: request("claude"), family: "claude", settings: DEFAULT_PREFERENCES, paths, block, nonce: () => "n1" });
    expect(out!.config.mcpServers!.learning).toEqual({ type: "stdio", command: paths.mcp, args: [], env: { LEARNING_LOOP_BINDING: "v3-n1" } });
    expect(out!.env).toEqual({ LEARNING_LOOP_BINDING: "v3-n1" });
    expect(out!.config.toolPolicy!.preapproved.map((g) => g.tool)).toEqual(["memory", "skills_list", "skill_view", "skill_manage", "session_search"]);
    expect(out!.config.systemPrompt).toContain("<learning_loop_skills>");
    expect(out!.config.systemPrompt).toContain("not the provider's full skill catalog");
    expect(out!.config.systemPrompt).toContain("SKILL.md path advertised in its native catalog");
  });

  it("gives a copied config a fresh nonce and replaces the stale prompt block", async () => {
    const copied = request("codex", {
      mcpServers: { learning: { type: "stdio", command: paths.mcp, env: { LEARNING_LOOP_BINDING: "old" } } },
      systemPrompt: "Be terse.\n\n<learning-loop>\nOLD-BLOCK-7f3\n</learning-loop>",
    });
    const out = await transformCreate({ request: copied, family: "codex", settings: DEFAULT_PREFERENCES, paths, block, nonce: () => "new" });
    expect((out!.config.mcpServers!.learning as { env: Record<string, string> }).env.LEARNING_LOOP_BINDING).toBe("v3-new");
    expect(out!.config.systemPrompt!.startsWith("Be terse.\n\n<learning-loop>")).toBe(true);
    expect(out!.config.systemPrompt).not.toContain("OLD-BLOCK-7f3");
  });

  it("never adds a toolPolicy on OpenCode and only a read-only prompt for providers without MCP", async () => {
    const open = await transformCreate({ request: request("opencode"), family: "opencode", settings: DEFAULT_PREFERENCES, paths, block, nonce: () => "n" });
    expect(open!.config.toolPolicy).toBeUndefined();
    const pi = await transformCreate({ request: request("pi"), family: "pi", settings: DEFAULT_PREFERENCES, paths, block });
    expect(pi!.config.mcpServers).toBeUndefined();
    expect(pi!.config.systemPrompt).toContain("This session cannot write to it");
  });

  it("leaves internal and unknown providers alone, and strips the block when injection is off", async () => {
    expect(await transformCreate({ request: request("claude", { internal: true }), family: "claude", settings: DEFAULT_PREFERENCES, paths, block })).toBeUndefined();
    expect(await transformCreate({ request: request("acme"), family: null, settings: DEFAULT_PREFERENCES, paths, block })).toBeUndefined();
    const off = { ...DEFAULT_PREFERENCES, injectPrompt: false, injectTools: false };
    const out = await transformCreate({ request: request("claude", { systemPrompt: "Keep.\n\n<learning-loop>\nx\n</learning-loop>" }), family: "claude", settings: off, paths, block });
    expect(out!.config.systemPrompt).toBe("Keep.");
    expect(out!.config.mcpServers).toBeUndefined();
  });

  it("follows provider extends chains", () => {
    expect(resolveFamily("work-claude", { "work-claude": { extends: "claude" } })).toBe("claude");
    expect(resolveFamily("loop", { loop: { extends: "loop" } })).toBeNull();
  });
});

describe("prompt block", () => {
  it("appends to an existing prompt once", () => {
    expect(withBlock("A", "<learning-loop>\nB\n</learning-loop>")).toBe("A\n\n<learning-loop>\nB\n</learning-loop>");
  });
});

describe("buildDigest", () => {
  const entry = (seq: number, item: AgentTimelineItem) => ({ item, timestamp: "2026-10-22T00:00:00Z", seqStart: seq, seqEnd: seq });
  it("keeps new turns in full, shortens older ones, counts and redacts", () => {
    const entries = [
      entry(1, { type: "user_message", text: "old task " + "x".repeat(600) }),
      entry(2, { type: "tool_call", callId: "c", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "ls" } }),
      entry(3, { type: "user_message", text: "deploy with token sk-ant-abcdefghijklmnopqrstuvwxyz" }),
      entry(4, { type: "tool_call", callId: "d", name: "Bash", status: "failed", error: "boom", detail: { type: "shell", command: "make deploy", exitCode: 2 } }),
      entry(5, { type: "assistant_message", text: "Deployed." }),
    ];
    const digest = buildDigest(entries, { reviewedSeq: 2 });
    expect([digest.userTurns, digest.toolCalls, digest.newEntries]).toEqual([1, 1, 3]);
    expect(digest.text).toContain("[1 tool call]");
    expect(digest.text).toContain("--- since the last review ---");
    expect(digest.text).toContain("TOOL: $ make deploy (exit 2) (failed) — boom");
    expect(digest.text).not.toContain("sk-ant-abcdef");
    expect(digest.text).toMatch(/old task x+ …\[\d+ more chars\]/);
  });
});

describe("kit", () => {
  it("routes only Claude-family providers and refuses credential env", () => {
    expect(routeFrom({}, "claude").ok).toBe(true);
    expect(routeFrom({ codex: {} }, "codex").ok).toBe(false);
    const secret = routeFrom({ work: { extends: "claude", env: { ANTHROPIC_API_KEY: "x" } } }, "work");
    expect(secret.ok ? null : secret.error).toBe("route_env_secret");
  });

  it("builds a call with only the given MCP tools allowed", () => {
    const args = callArgs({ model: "haiku", maxBudgetUsd: 0.25, systemPrompt: "s", mcpConfig: '{"mcpServers":{"a":{}}}', allowedTools: ["mcp__a__x", "mcp__a__y"] });
    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__a__x,mcp__a__y");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  it("extracts the JSON object from fenced or chatty model output", () => {
    expect(extractJsonObject('```json\n{"verdict":"done"}\n```')).toEqual({ verdict: "done" });
    expect(extractJsonObject('Sure! {"a": {"b": "}"}} trailing')).toEqual({ a: { b: "}" } });
  });
});

describe("helpers", () => {
  it("parses relative time bounds", () => {
    expect(parseTimeBound("7d", Date.parse("2026-10-22T00:00:00Z"))).toBe("2026-10-15T00:00:00.000Z");
    expect(parseTimeBound("nope")).toBeNull();
  });

  it("redacts credential shapes", () => {
    expect(redact("ghp_abcdefghijklmnopqrstuvwxyz123456 and https://u:pw@host/x and API_KEY=abcd1234efgh")).toBe(
      "[REDACTED TOKEN] and https://u:[REDACTED]@host/x and API_KEY=[REDACTED]",
    );
  });
});

describe("parseRemember", () => {
  it("routes prefixes to stores, English or Chinese", async () => {
    const { parseRemember } = await import("../shared/remember");
    expect(parseRemember("project: tests run with npm test")).toEqual({ target: "project", text: "tests run with npm test" });
    expect(parseRemember("用户：喜欢简短的回答")).toEqual({ target: "user", text: "喜欢简短的回答" });
    expect(parseRemember("staging uses port 2222")).toEqual({ target: "memory", text: "staging uses port 2222" });
  });
});
