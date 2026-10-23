import { execFile } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { BindingStore } from "./bindings";
import { AgentAccessStore } from "./agent-access";
import { Bridge } from "./bridge";
import { renderCli } from "./scripts";
import type { WorkflowService } from "./service";

const execFileAsync = promisify(execFile);
const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dwf-bridge-"));
  disposals.push(() => rm(dir, { recursive: true, force: true }));
  const status = vi.fn(async () => "status-ok");
  const launch = vi.fn(async () => "launch-ok");
  const stop = vi.fn(async () => "stop-ok");
  const reference = vi.fn(() => "reference-ok");
  const accessFile = join(dir, "agent-access.json");
  const access = new AgentAccessStore(accessFile);
  await access.load();
  const bindings = new BindingStore(join(dir, "bindings.json"));
  const bridge = new Bridge({ service: { status, launch, stop, reference } as unknown as WorkflowService, bindings, access });
  const socketPath = join(dir, "bridge.sock");
  await bridge.start(socketPath);
  disposals.push(() => bridge.close());
  const cli = join(dir, "cli.mjs");
  await writeFile(cli, renderCli());
  return { socketPath, status, launch, stop, reference, bridge, access, accessFile, bindings, run: (args: string[]) => execFileAsync(process.execPath, [cli, ...args], {
    env: { ...process.env, DYNAMIC_WORKFLOW_HOME: dir, PASEO_AGENT_ID: "fixture-parent" }, timeout: 5000,
  }) };
}

function post(socketPath: string, payload: string, tool = "workflow", headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: `/v1/tools/${tool}`, method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(payload) } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

it("returns a useful 413 for oversized bridge bodies and remains reachable", async () => {
  const f = await fixture();
  const response = await post(f.socketPath, JSON.stringify({ arguments: { script: "x".repeat(2 * 1024 * 1024) } }));
  expect(response.status).toBe(413);
  expect(JSON.parse(response.body).error.code).toBe("too_large");
  expect(f.launch).not.toHaveBeenCalled();
  expect((await f.run(["status"])).stdout).toContain("status-ok");
});

it("parses status flags in either order and rejects unknown or misplaced arguments", async () => {
  const f = await fixture();
  await f.run(["status", "--wait", "1", "wf_abcdef"]);
  expect(f.status).toHaveBeenCalledWith("fixture-parent", "wf_abcdef", 1);
  for (const args of [["run", "--name", "test", "--typo", "1"], ["status", "extra", "extra"], ["status", "--wait", "NaN"], ["stop", "--help"]]) {
    await expect(f.run(args)).rejects.toMatchObject({ code: 2 });
  }
});

it("fails startup when its socket cannot listen", async () => {
  const f = await fixture();
  const broken = new Bridge({ service: {} as WorkflowService, bindings: new BindingStore("unused"), access: f.access });
  await expect(broken.start(join(f.socketPath, "missing", "bridge.sock"))).rejects.toThrow();
  expect(broken.listening).toBe(false);
});

it("lists tool descriptions only for the opted-in caller and updates the same MCP binding after toggles", async () => {
  const f = await fixture();
  await f.bindings.bind("nonce-a", "agent-a");
  const a = { "x-dynamic-workflow-binding": "nonce-a" };
  const b = { "x-dynamic-workflow-agent": "agent-b" };
  expect(JSON.parse((await post(f.socketPath, "{}", "list", a)).body)).toEqual({ tools: [] });
  await f.access.set("agent-a", true);
  const tools = JSON.parse((await post(f.socketPath, "{}", "list", a)).body).tools;
  expect(tools.map((tool: { name: string }) => tool.name)).toEqual(["workflow", "workflow_status", "workflow_stop", "workflow_reference"]);
  expect(tools.every((tool: { description?: string }) => Boolean(tool.description))).toBe(true);
  expect(JSON.parse((await post(f.socketPath, "{}", "list", b)).body)).toEqual({ tools: [] });
  expect(JSON.parse((await post(f.socketPath, "{}", "list")).body)).toEqual({ tools: [] });
  const unknownBinding = { "x-dynamic-workflow-binding": "missing", "x-dynamic-workflow-agent": "agent-a" };
  expect(JSON.parse((await post(f.socketPath, "{}", "list", unknownBinding)).body)).toEqual({ tools: [] });
  expect((await post(f.socketPath, '{"arguments":{"script":"return 1"}}', "workflow", unknownBinding)).status).toBe(400);
  expect(f.launch).not.toHaveBeenCalled();
  await f.access.set("agent-a", false);
  expect(JSON.parse((await post(f.socketPath, "{}", "list", a)).body)).toEqual({ tools: [] });
});

it("denies launch and reference while disabled, preserving status and stop for existing runs", async () => {
  const f = await fixture();
  const headers = { "x-dynamic-workflow-agent": "agent-a" };
  for (const tool of ["workflow", "workflow_reference"]) {
    const response = await post(f.socketPath, '{"arguments":{"script":"return 1"}}', tool, headers);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body).error).toMatchObject({ code: "workflow_disabled", message: expect.stringContaining("enable workflows for this agent") });
  }
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.reference).not.toHaveBeenCalled();
  await f.access.set("agent-a", true);
  expect(JSON.parse((await post(f.socketPath, '{"arguments":{"script":"return 1"}}', "workflow", headers)).body)).toEqual({ text: "launch-ok" });
  expect(JSON.parse((await post(f.socketPath, "{}", "workflow_reference", headers)).body)).toEqual({ text: "reference-ok" });
  await f.access.set("agent-a", false);
  expect(JSON.parse((await post(f.socketPath, '{"arguments":{"runId":"wf_abcdef"}}', "workflow_status", headers)).body)).toEqual({ text: "status-ok" });
  expect(JSON.parse((await post(f.socketPath, '{"arguments":{"runId":"wf_abcdef"}}', "workflow_stop", headers)).body)).toEqual({ text: "stop-ok" });
  expect(f.stop).toHaveBeenCalledWith("wf_abcdef", { agentId: "agent-a" });
});

it("does not expose an MCP tool that enables the calling agent", async () => {
  const f = await fixture();
  const response = await post(f.socketPath, '{"arguments":{"enabled":true}}', "workflow_enable", { "x-dynamic-workflow-agent": "agent-a" });
  expect(JSON.parse(response.body).error.code).toBe("not_found");
  expect(f.access.enabled("agent-a")).toBe(false);
});

it("keeps the caller's opt-in after the bridge and access store restart", async () => {
  const f = await fixture();
  await f.access.set("agent-a", true);
  await f.bridge.close();
  const access = new AgentAccessStore(f.accessFile);
  await access.load();
  const restarted = new Bridge({ service: {} as WorkflowService, bindings: f.bindings, access });
  disposals.push(() => restarted.close());
  await restarted.start(f.socketPath);
  expect(JSON.parse((await post(f.socketPath, "{}", "list", { "x-dynamic-workflow-agent": "agent-a" })).body).tools).toHaveLength(4);
  expect(JSON.parse((await post(f.socketPath, "{}", "list", { "x-dynamic-workflow-agent": "agent-b" })).body).tools).toEqual([]);
});
