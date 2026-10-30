import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../shared/contracts";
import { BindingStore } from "../server/bindings";
import { Bridge } from "../server/bridge";
import { MemoryStore } from "../server/memory/store";
import { statePaths, type StatePaths } from "../server/paths";
import { installShim } from "../server/shim";
import { SkillLibrary } from "../server/skills/library";
import { callTool, TOOL_DEFINITIONS, TOOL_DEFINITIONS_V2, TOOL_DEFINITIONS_V3, bindingVersion, toolsForBinding, type CallContext, type ToolDeps } from "../server/tools";

let root: string;
let paths: StatePaths;
let bridge: Bridge;
let deps: ToolDeps;
const seen: CallContext[] = [];

class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, (value: any) => void>();
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    });
  }
  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  async tool(name: string, args: unknown): Promise<{ isError: boolean; body: any }> {
    const reply = await this.request("tools/call", { name, arguments: args });
    return { isError: reply.result.isError === true, body: JSON.parse(reply.result.content[0].text) };
  }
}

function startShim(binding: string): { client: McpClient; child: ChildProcessWithoutNullStreams } {
  const child = spawn(paths.mcp, [], { env: { ...process.env, LEARNING_LOOP_BINDING: binding, PASEO_AGENT_ID: "" }, stdio: ["pipe", "pipe", "pipe"] });
  return { client: new McpClient(child), child };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ll-mcp-"));
  paths = statePaths(root);
  const bindings = new BindingStore(paths.bindings);
  await bindings.bind("nonce-1", { agentId: "agent-1", cwd: root, workspaceId: null, provider: "claude" });
  deps = {
    memory: new MemoryStore(paths, () => ({ user: 1375, memory: 2200, project: 2000 })),
    skills: new SkillLibrary(paths),
    sessions: null,
    stage: () => false,
    onMemoryChange: () => undefined,
    onSkillChange: () => undefined,
  };
  bridge = new Bridge({
    tools: toolsForBinding,
    async call(name, args, headers) {
      const bound = headers.binding ? await bindings.get(headers.binding) : null;
      const actor: Actor = { kind: "agent", agentId: bound?.agentId ?? null, title: null, runId: null };
      const context: CallContext = { actor, reader: headers.binding ?? "anon", project: { key: "p-1", root, name: "fixture" }, selfAgentId: actor.agentId, version: bindingVersion(headers.binding) };
      seen.push(context);
      return callTool(name, args, context, deps);
    },
  });
  // Process's own Node runs the script (no Electron here).
  await installShim(paths, TOOL_DEFINITIONS, { execPath: process.execPath, electron: false }, TOOL_DEFINITIONS_V2, TOOL_DEFINITIONS_V3);
  await bridge.start(paths.socket);
});

afterEach(async () => {
  await bridge.stop();
  await rm(root, { recursive: true, force: true });
  seen.length = 0;
});

describe("stdio MCP shim ↔ bridge", () => {
  it("initializes, lists tools and routes calls with the agent's binding", async () => {
    const { client, child } = startShim("nonce-1");
    try {
      const init = await client.request("initialize", { protocolVersion: "2025-06-18" });
      expect(init.result.serverInfo.name).toBe("learning");
      const list = await client.request("tools/list");
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["memory", "skills_list", "skill_view", "skill_manage", "session_search"]);

      const saved = await client.tool("memory", { target: "project", operations: [{ action: "add", content: "Fixture repo runs tests with npm test" }] });
      expect(saved.isError).toBe(false);
      expect(await deps.memory.entries("project", { key: "p-1", root, name: "fixture" })).toEqual(["Fixture repo runs tests with npm test"]);
      expect(seen.at(-1)!.actor.agentId).toBe("agent-1");

      const content = "---\nname: run-tests\ndescription: Use when testing the fixture. Runs npm test.\n---\n# Run tests\n\n1. npm test\n";
      expect((await client.tool("skill_manage", { operations: [{ name: "run-tests", action: "create", content, category: "dev" }] })).isError).toBe(false);
      const view = await client.tool("skill_view", { name: "run-tests" });
      expect(view.body.content).toContain("npm test");
      const patched = await client.tool("skill_manage", { operations: [{ name: "run-tests", action: "patch", old_string: "1. npm test", new_string: "1. npm test -- --run" }] });
      expect(patched.isError).toBe(false);

      const disabled = await client.tool("session_search", { query: "anything" });
      expect(disabled.isError).toBe(true);
      expect(disabled.body.error).toMatch(/turned off/);
    } finally {
      child.kill();
    }
  });

  it("serves new library-boundary descriptions only to new bindings over the real shim", async () => {
    for (const binding of ["v2-old", "v3-new"]) {
      const { client, child } = startShim(binding);
      try {
        const reply = await client.request("tools/list");
        const skill = reply.result.tools.find((t: { name: string }) => t.name === "skill_view");
        expect(skill.description.includes("provider's full skill catalog")).toBe(binding.startsWith("v3-"));
        const missing = await client.tool("skill_view", { name: "native-only-fixture" });
        expect(missing.body).toMatchObject({ success: false, library: "learning-loop" });
        expect(missing.isError).toBe(true);
      } finally { child.kill(); }
    }
  });

  it("reports a tool error without failing the protocol", async () => {
    const { client, child } = startShim("nonce-1");
    try {
      const reply = await client.tool("memory", { target: "user", action: "replace", old_text: "x", content: "y" });
      expect(reply.isError).toBe(true);
      expect(reply.body.error).toMatch(/no 'replace' action/);
    } finally {
      child.kill();
    }
  });

  it("answers a tool call with a clear error when the plugin is not running", async () => {
    await bridge.stop();
    const { client, child } = startShim("nonce-1");
    try {
      const started = Date.now();
      const reply = await client.request("tools/call", { name: "skills_list", arguments: {} });
      expect(reply.result.isError).toBe(true);
      expect(reply.result.content[0].text).toMatch(/not reachable/);
      expect(Date.now() - started).toBeGreaterThan(10_000);
    } finally {
      child.kill();
    }
  }, 30_000);
});
