import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import { BINDING_ENV } from "../shared/ids";
import { renderMcp } from "./scripts";
import { writeAtomically } from "./util";

const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

async function fixture(agentId: string, bound = true) {
  const root = await mkdtemp(join(tmpdir(), "dwf-mcp-access-"));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "mcp.mjs"), renderMcp());
  const bind = () => writeAtomically(join(root, "bindings.json"), JSON.stringify({ bindings: { nonce: { agentId } } }), 0o600);
  if (bound) await bind();
  const access = (ids: string[]) => writeAtomically(join(root, "agent-access.json"), JSON.stringify({ version: 1, enabledAgentIds: ids }), 0o600);
  const child = spawn(process.execPath, [join(root, "mcp.mjs")], {
    env: { ...process.env, DYNAMIC_WORKFLOW_HOME: root, [BINDING_ENV]: "nonce", PASEO_AGENT_ID: "wrong-agent" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  disposals.push(async () => { child.kill(); await exited; });
  const messages: Array<{ id?: number; method?: string; result?: { tools?: Array<{ name: string }>; capabilities?: unknown } }> = [];
  createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
  let id = 0;
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const rpc = async (method: string, params?: unknown) => {
    const requestId = ++id;
    send({ jsonrpc: "2.0", id: requestId, method, params });
    await vi.waitFor(() => expect(messages.some((message) => message.id === requestId)).toBe(true));
    return messages.find((message) => message.id === requestId)!.result;
  };
  expect((await rpc("initialize", { protocolVersion: "2025-06-18" }))?.capabilities).toEqual({ tools: { listChanged: true } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const notifications = () => messages.filter((message) => message.method === "notifications/tools/list_changed").length;
  return { root, access, bind, rpc, notifications, child, exited };
}

it("publishes zero descriptions by default, exposes only the opted-in agent, and refreshes after disable", async () => {
  const f = await fixture("agent-a");
  expect((await f.rpc("tools/list"))?.tools).toEqual([]);
  await f.access(["agent-b"]);
  expect((await f.rpc("tools/list"))?.tools).toEqual([]);
  expect(f.notifications()).toBe(0);
  await f.access(["agent-a", "agent-b"]);
  await vi.waitFor(() => expect(f.notifications()).toBe(1));
  expect((await f.rpc("tools/list"))?.tools?.map((tool) => tool.name)).toEqual(["workflow", "workflow_status", "workflow_stop", "workflow_reference"]);
  await f.access(["agent-b"]);
  await vi.waitFor(() => expect(f.notifications()).toBe(2));
  expect((await f.rpc("tools/list"))?.tools).toEqual([]);
  f.child.stdin.end();
  expect(await f.exited).toBe(0);
});

it("fails closed without an identity or valid state and notices a late binding", async () => {
  const f = await fixture("agent-a", false);
  await f.access(["agent-a", "wrong-agent"]);
  expect((await f.rpc("tools/list"))?.tools).toEqual([]);
  await f.bind();
  await vi.waitFor(() => expect(f.notifications()).toBe(1));
  expect((await f.rpc("tools/list"))?.tools).toHaveLength(4);
  await writeAtomically(join(f.root, "agent-access.json"), JSON.stringify({ version: 1, enabledAgentIds: ["agent-a", 4] }), 0o600);
  await vi.waitFor(() => expect(f.notifications()).toBe(2));
  expect((await f.rpc("tools/list"))?.tools).toEqual([]);
  await writeAtomically(join(f.root, "agent-access.json"), JSON.stringify({ version: 2, enabledAgentIds: ["agent-a"] }), 0o600);
  expect((await f.rpc("tools/list"))?.tools).toEqual([]);
  await writeAtomically(join(f.root, "agent-access.json"), "invalid", 0o600);
  expect((await f.rpc("tools/list"))?.tools).toEqual([]);
});
