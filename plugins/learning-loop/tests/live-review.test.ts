// Opt-in (LL_LIVE=1): a real headless Claude run with only the learning MCP tools, through the real
// shim and bridge, on a throwaway state directory. Costs a cent or two of haiku.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bridge } from "../server/bridge";
import { complete } from "../server/kit/complete";
import { MemoryStore } from "../server/memory/store";
import { statePaths } from "../server/paths";
import { REVIEW_SYSTEM_PROMPT } from "../server/prompts";
import { installShim } from "../server/shim";
import { SkillLibrary } from "../server/skills/library";
import { callTool, TOOL_DEFINITIONS, TOOL_NAMES } from "../server/tools";

describe.skipIf(process.env.LL_LIVE !== "1")("live review run", () => {
  it("saves a memory entry through the MCP tools with no built-in tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "ll-live-"));
    const paths = statePaths(root);
    const memory = new MemoryStore(paths, () => ({ user: 1375, memory: 2200, project: 2000 }));
    const bridge = new Bridge({
      tools: () => TOOL_DEFINITIONS,
      call: (name, args) =>
        callTool(name, args, { actor: { kind: "review", agentId: "x", title: null, runId: "r" }, reader: "review-r", project: null, selfAgentId: null }, {
          memory,
          skills: new SkillLibrary(paths),
          sessions: null,
          stage: () => false,
          onMemoryChange: () => undefined,
          onSkillChange: () => undefined,
        }),
    });
    await installShim(paths, TOOL_DEFINITIONS, { execPath: process.execPath, electron: false });
    await bridge.start(paths.socket);
    try {
      const result = await complete({
        route: { providerId: "claude", command: ["claude"], env: {} },
        model: "haiku",
        maxBudgetUsd: 0.2,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        stdin:
          "<conversation-digest>\nUSER: from now on, never use emoji in commit messages. I am Ada, a backend engineer.\nASSISTANT: Understood.\n</conversation-digest>\n\n" +
          "Save who the user is to the user store with the memory tool (one entry). Then reply 'done'.",
        mcpConfig: JSON.stringify({ mcpServers: { learning: { type: "stdio", command: paths.mcp, args: [], env: { LEARNING_LOOP_BINDING: "review-r" } } } }),
        allowedTools: TOOL_NAMES.map((t) => `mcp__learning__${t}`),
        role: "learning-loop-live-test",
        timeoutMs: 180_000,
      });
      console.log("live result", JSON.stringify({ ok: result.ok, cost: result.costUsd, models: result.models, text: result.ok ? result.text : result.error }));
      expect(result.ok).toBe(true);
      const entries = await memory.entries("user");
      console.log("user entries", entries);
      expect(entries.join(" ")).toMatch(/Ada/);
    } finally {
      await bridge.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 200_000);
});
