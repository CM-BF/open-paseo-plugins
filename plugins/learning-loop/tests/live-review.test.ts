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
import { REVIEW_SYSTEM_PROMPT, reviewInput } from "../server/prompts";
import { installShim } from "../server/shim";
import { SkillLibrary } from "../server/skills/library";
import { callTool, TOOL_DEFINITIONS, TOOL_DEFINITIONS_V2, TOOL_DEFINITIONS_V3, TOOL_DEFINITIONS_V4, TOOL_NAMES, toolsForBinding } from "../server/tools";

describe.skipIf(process.env.LL_LIVE !== "1")("live review run", () => {
  it.each([
    {
      name: "leaves one-off requests and assistant guesses out of memory",
      digest: "USER: Compare two clinic scheduling packages for a surgeon. Use a table just for this answer.\nASSISTANT: You are probably a surgeon and generally prefer tables.\nUSER: Thanks, that is all for today.",
      durable: false,
    },
    {
      name: "saves an explicit standing preference without inferred identity",
      digest: "USER: From now on, I prefer concise answers. Compare two clinic scheduling packages for a surgeon, using a table just for this answer.\nASSISTANT: You are probably a surgeon and generally prefer tables.\nUSER: Thanks, that is all for today.",
      durable: true,
    },
  ])("$name", async ({ digest, durable }) => {
    const root = await mkdtemp(join(tmpdir(), "ll-live-"));
    const paths = statePaths(root);
    const memory = new MemoryStore(paths, () => ({ user: 1375, memory: 2200, project: 2000 }));
    const skills = new SkillLibrary(paths);
    const bridge = new Bridge({
      tools: toolsForBinding,
      call: (name, args) =>
        callTool(name, args, { actor: { kind: "review", agentId: "x", title: null, runId: "r" }, reader: "review-r", project: null, selfAgentId: null, version: 4 }, {
          memory,
          skills,
          sessions: null,
          stage: () => false,
          onMemoryChange: () => undefined,
          onSkillChange: () => undefined,
        }),
    });
    await installShim(paths, TOOL_DEFINITIONS, { execPath: process.execPath, electron: false }, TOOL_DEFINITIONS_V2, TOOL_DEFINITIONS_V3, TOOL_DEFINITIONS_V4);
    await bridge.start(paths.socket);
    try {
      const result = await complete({
        route: { providerId: "claude", command: ["claude"], env: {} },
        model: "haiku",
        maxBudgetUsd: 0.2,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        stdin: reviewInput(digest, "This is a synthetic verification conversation. Both memory stores and the skill library start empty; no project is associated."),
        mcpConfig: JSON.stringify({ mcpServers: { learning: { type: "stdio", command: paths.mcp, args: [], env: { LEARNING_LOOP_BINDING: "review-r" } } } }),
        allowedTools: TOOL_NAMES.map((t) => `mcp__learning__${t}`),
        role: "learning-loop-live-test",
        timeoutMs: 180_000,
      });
      console.log("live result", JSON.stringify({ ok: result.ok, cost: result.costUsd, models: result.models, text: result.ok ? result.text : result.error }));
      expect(result.ok).toBe(true);
      const user = await memory.entries("user");
      const environment = await memory.entries("memory");
      console.log("fixture entries", { user, environment });
      if (durable) expect(user.join(" ")).toMatch(/concise|short|brief/i);
      else expect(user).toEqual([]);
      expect(environment).toEqual([]);
      // These are asserted identities/preferences, not harmless negation text: no such entries belong here.
      expect(user.join(" ")).not.toMatch(/surgeon|table|clinic/i);
      expect(await skills.list()).toEqual([]);
    } finally {
      await bridge.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 200_000);
});
