import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import { BINDING_ENV } from "../shared/ids";
import { mcpInstructions } from "./prompts";
import { renderMcp, toolDefinitions } from "./scripts";
import { writeAtomically } from "./util";

const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

interface Message { id?: number; method?: string; result?: { tools?: unknown[]; instructions?: string } }

async function shim(state: { enabled: string[]; ultracode?: string[]; size?: string; rawGuidance?: string }) {
  const root = await mkdtemp(join(tmpdir(), "dwf-mcp-guidance-"));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "mcp.mjs"), renderMcp());
  await writeAtomically(join(root, "bindings.json"), JSON.stringify({ bindings: { nonce: { agentId: "agent-a" } } }), 0o600);
  const write = (next: typeof state) => Promise.all([
    writeAtomically(join(root, "agent-access.json"), JSON.stringify({ version: 1, enabledAgentIds: next.enabled, ...(next.ultracode ? { ultracodeAgentIds: next.ultracode } : {}) }), 0o600),
    next.size ? writeAtomically(join(root, "guidance.json"), JSON.stringify({ version: 1, workflowSize: next.size }), 0o600) : Promise.resolve(),
  ]);
  await write(state);
  if (state.rawGuidance !== undefined) await writeAtomically(join(root, "guidance.json"), state.rawGuidance, 0o600);
  const child = spawn(process.execPath, [join(root, "mcp.mjs")], {
    env: { ...process.env, DYNAMIC_WORKFLOW_HOME: root, [BINDING_ENV]: "nonce" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  disposals.push(async () => { child.kill(); await exited; });
  const messages: Message[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
  let id = 0;
  const rpc = async (method: string, params?: unknown) => {
    const requestId = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    // A new node process can take seconds to start on a loaded machine.
    await vi.waitFor(() => expect(messages.some((message) => message.id === requestId)).toBe(true), { timeout: 15_000 });
    return messages.find((message) => message.id === requestId)!.result!;
  };
  const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const notifications = () => messages.filter((message) => message.method === "notifications/tools/list_changed").length;
  return { init, rpc, write, notifications };
}

it("serves the same per-agent catalog as the bridge, with instructions only for enabled agents", async () => {
  const ultra = await shim({ enabled: ["agent-a"], ultracode: ["agent-a"], size: "small" });
  expect((await ultra.rpc("tools/list")).tools).toEqual(toolDefinitions({ ultracode: true, size: "small" }));
  expect(ultra.init.instructions).toBe(mcpInstructions({ ultracode: true, size: "small" }));

  const sized = await shim({ enabled: ["agent-a"], size: "medium" });
  expect((await sized.rpc("tools/list")).tools).toEqual(toolDefinitions({ ultracode: false, size: "medium" }));
  expect(sized.init.instructions).toBe(mcpInstructions({ ultracode: false, size: "medium" }));

  const defaults = await shim({ enabled: ["agent-a"] });
  expect((await defaults.rpc("tools/list")).tools).toEqual(toolDefinitions({ ultracode: false, size: "unrestricted" }));

  const off = await shim({ enabled: ["agent-b"], ultracode: ["agent-a"] });
  expect((await off.rpc("tools/list")).tools).toEqual([]);
  expect(off.init.instructions).toBeUndefined();
});

it("announces an Ultracode toggle, but keeps the size guideline it started with", async () => {
  const f = await shim({ enabled: ["agent-a"], size: "medium" });
  await f.rpc("tools/list");
  // An agent enabled at startup may get one announcement on initialized; count from a settled baseline.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const base = f.notifications();
  await f.write({ enabled: ["agent-a"], ultracode: ["agent-a"] });
  await vi.waitFor(() => expect(f.notifications()).toBe(base + 1), { timeout: 10_000 });
  expect(JSON.stringify((await f.rpc("tools/list")).tools)).toContain("Ultracode is ON for this agent");
  await f.write({ enabled: ["agent-a"], size: "large" });
  await vi.waitFor(() => expect(f.notifications()).toBe(base + 2), { timeout: 10_000 });
  // A settings change reaches running agents through launch results and notifications, not by
  // rewriting their tool list (and prompt cache).
  await f.write({ enabled: ["agent-a"], size: "small" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(f.notifications()).toBe(base + 2);
  expect(JSON.stringify((await f.rpc("tools/list")).tools)).toContain("Size guideline (set by the user): medium");
  const fresh = await shim({ enabled: ["agent-a"], size: "small" });
  expect(JSON.stringify((await fresh.rpc("tools/list")).tools)).toContain("Size guideline (set by the user): small");
});

it("falls back to the default size when guidance.json holds null", async () => {
  const f = await shim({ enabled: ["agent-a"], rawGuidance: "null" });
  expect((await f.rpc("tools/list")).tools).toEqual(toolDefinitions({ ultracode: false, size: "unrestricted" }));
  expect(f.init.instructions).toBeTruthy();
});

it("asks Claude Code to load the workflow description instead of deferring it, and keeps the spec small", () => {
  for (const guidance of [{ ultracode: true, size: "unrestricted" as const }, { ultracode: false, size: "medium" as const }]) {
    const workflow = toolDefinitions(guidance).find((tool) => tool.name === "workflow")!;
    expect(workflow._meta).toMatchObject({ "anthropic/alwaysLoad": true });
    expect(JSON.stringify(workflow).length).toBeLessThan(8000);
  }
});

it("keeps the opt-in rule and the per-agent guidance inside Claude Code's 2048-character cut", () => {
  const CLAUDE_CUT = 2048;
  for (const guidance of [
    { ultracode: true, size: "unrestricted" as const },
    ...(["unrestricted", "small", "medium", "large"] as const).map((size) => ({ ultracode: false, size })),
  ]) {
    const head = toolDefinitions(guidance).find((tool) => tool.name === "workflow")!.description.slice(0, CLAUDE_CUT);
    expect(head, JSON.stringify(guidance)).toContain(guidance.ultracode ? "Ultracode is ON for this agent" : "Size guideline");
    for (const part of ["Launch one only after the user opted in", "Never turn workflows or Ultracode on for yourself", "call workflow_reference", "verify-claims"]) {
      expect(head, `${JSON.stringify(guidance)}: ${part}`).toContain(part);
    }
    expect(mcpInstructions(guidance).length).toBeLessThanOrEqual(CLAUDE_CUT);
  }
  expect(mcpInstructions({ ultracode: true, size: "unrestricted" })).toContain("Stay solo for conversation");
});
