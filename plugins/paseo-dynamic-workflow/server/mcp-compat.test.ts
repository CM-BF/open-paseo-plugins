import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import { BINDING_ENV } from "../shared/ids";
import { AgentAccessStore } from "./agent-access";
import { renderMcp } from "./scripts";
import { writeAtomically } from "./util";

const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

interface Message { id?: number; method?: string; result?: { tools?: Array<{ name: string; description: string }> } }

/** Starts one shim program against a fresh state directory written by the current server code. */
async function start(program: "current" | "fa7e41f") {
  const root = await mkdtemp(join(tmpdir(), "dwf-mcp-compat-"));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "mcp.mjs");
  if (program === "current") await writeFile(file, renderMcp());
  else await copyFile(join(__dirname, "fixtures", "mcp-fa7e41f.mjs"), file);
  await writeAtomically(join(root, "bindings.json"), JSON.stringify({ bindings: { nonce: { agentId: "agent-a" } } }), 0o600);
  const store = new AgentAccessStore(join(root, "agent-access.json"));
  await store.load();
  const child = spawn(process.execPath, [file], { env: { ...process.env, DYNAMIC_WORKFLOW_HOME: root, [BINDING_ENV]: "nonce" }, stdio: ["pipe", "pipe", "pipe"] });
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
  await rpc("initialize", { protocolVersion: "2025-06-18" });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const notifications = () => messages.filter((message) => message.method === "notifications/tools/list_changed").length;
  const guidance = (size: string) => writeAtomically(join(root, "guidance.json"), JSON.stringify({ version: 1, workflowSize: size }), 0o600);
  return { root, store, rpc, notifications, guidance };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

it("the shim already running in agents created before this release keeps working with the new state files", async () => {
  const f = await start("fa7e41f");
  expect((await f.rpc("tools/list")).tools).toEqual([]);
  await f.store.update("agent-a", { ultracode: true });
  await vi.waitFor(() => expect(f.notifications()).toBe(1));
  const tools = (await f.rpc("tools/list")).tools!;
  expect(tools.map((tool) => tool.name)).toEqual(["workflow", "workflow_status", "workflow_stop", "workflow_reference"]);
  // That generation never shows the Ultracode notice; launch results and notifications carry it.
  expect(JSON.stringify(tools)).not.toContain("Ultracode is ON");
  await f.guidance("small");
  await f.store.update("agent-a", { ultracode: false });
  await settle();
  expect(f.notifications()).toBe(1);
  await f.store.set("agent-a", false);
  await vi.waitFor(() => expect(f.notifications()).toBe(2));
  expect((await f.rpc("tools/list")).tools).toEqual([]);
});

it.each([
  ["valid with ultracode", { version: 1, enabledAgentIds: ["agent-a"], ultracodeAgentIds: ["agent-a"] }, true, true],
  ["ultracode list of numbers", { version: 1, enabledAgentIds: ["agent-a"], ultracodeAgentIds: [4] }, true, false],
  ["ultracode not a list", { version: 1, enabledAgentIds: ["agent-a"], ultracodeAgentIds: "agent-a" }, true, false],
  ["ultracode for an agent that is not enabled", { version: 1, enabledAgentIds: ["agent-b"], ultracodeAgentIds: ["agent-a"] }, false, false],
  ["future version", { version: 2, enabledAgentIds: ["agent-a"] }, false, false],
  ["a non-string enabled id", { version: 1, enabledAgentIds: ["agent-a", 7] }, false, false],
])("the store and the current shim agree on %s", async (_name, content, enabled, ultracode) => {
  const f = await start("current");
  await writeAtomically(join(f.root, "agent-access.json"), JSON.stringify(content), 0o600);
  const store = new AgentAccessStore(join(f.root, "agent-access.json"));
  await store.load();
  expect([store.enabled("agent-a"), store.ultracode("agent-a")]).toEqual([enabled, ultracode]);
  const tools = (await f.rpc("tools/list")).tools!;
  expect(tools.length > 0).toBe(enabled);
  expect(JSON.stringify(tools).includes("Ultracode is ON")).toBe(ultracode);
});
