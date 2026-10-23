import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, expect, it, vi } from "vitest";
import { getAgentAccessRpc, serviceStatusRpc, setAgentAccessRpc } from "../shared/contracts";
import { BINDING_ENV, CHILD_ENV, ENABLE_ENV, LABEL_RUN } from "../shared/ids";
import { DEFAULT_PREFERENCES } from "../shared/settings";
import { contributeServer } from "./contribute";
import type { PaseoApi } from "./gate";
import { statePaths } from "./paths";

const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  try { for (const dispose of disposals.splice(0).reverse()) await dispose(); }
  finally { vi.useRealTimers(); }
});

type RpcHandler = (input: unknown, context: { paseo: PaseoApi }) => unknown | Promise<unknown>;

async function fixture(paseo = {} as PaseoApi) {
  const root = await mkdtemp(join(tmpdir(), "dwf-contribute-"));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map<string, RpcHandler>();
  const before = new Map<string, RpcHandler>();
  const host = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", values: DEFAULT_PREFERENCES, revision: "fixture" }),
      subscribe: () => () => {},
    }),
    before: (name: string, handler: RpcHandler) => before.set(name, handler),
    on: () => {},
    handle: (contract: { name: string }, handler: RpcHandler) => handlers.set(contract.name, handler),
  };
  const dispose = contributeServer(host as unknown as PluginServerContext, { stateDir: root });
  disposals.push(dispose);
  const invoke = (name: string, input: unknown) => Promise.resolve(handlers.get(name)!(input, { paseo }));
  const status = () => invoke(serviceStatusRpc.name, {});
  const sessionOpen = (request: unknown) => Promise.resolve(before.get("agent.session_open")!({ request }, { paseo }));
  return { dispose, status, invoke, sessionOpen, paths: statePaths(root) };
}

function health(socketPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method: "GET", path: "/v1/health", agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end();
  });
}

it("does not open the bridge or retain timers when cleanup overtakes startup", async () => {
  vi.useFakeTimers();
  const listeners = process.listenerCount("unhandledRejection");
  const f = await fixture();
  await f.dispose();
  // This RPC joins initialization, so the assertion cannot race a delayed startup task.
  expect(await f.status()).toMatchObject({ bridgeListening: false, paseoReady: false, activeRuns: 0 });
  await expect(health(f.paths.socket)).rejects.toMatchObject({ code: expect.stringMatching(/ENOENT|ECONNREFUSED/) });
  expect(vi.getTimerCount()).toBe(0);
  expect(process.listenerCount("unhandledRejection")).toBe(listeners);
});

it("closes an already-listening bridge and its reconciliation timers", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  expect(await f.status()).toMatchObject({ bridgeListening: true, paseoReady: true });
  expect(await health(f.paths.socket)).toBe(200);
  await f.dispose();
  expect(await f.status()).toMatchObject({ bridgeListening: false, paseoReady: false });
  await expect(health(f.paths.socket)).rejects.toMatchObject({ code: expect.stringMatching(/ENOENT|ECONNREFUSED/) });
  expect(vi.getTimerCount()).toBe(0);
});

function apiFixture() {
  const agents = new Map<string, { provider: string; archivedAt: string | null; labels: Record<string, string> }>([
    ["a", { provider: "codex", archivedAt: null, labels: {} }],
    ["b", { provider: "claude", archivedAt: null, labels: {} }],
    ["child", { provider: "codex", archivedAt: null, labels: { [LABEL_RUN]: "wf_abcdef" } }],
    ["archived", { provider: "codex", archivedAt: "2026-10-22T00:00:00Z", labels: {} }],
  ]);
  const refresh = vi.fn(async (id: string) => agents.has(id) ? { agent: agents.get(id)! } : null);
  const api = { agents: { ref: (id: string) => ({ refresh: () => refresh(id) }) } } as unknown as PaseoApi;
  return { api, refresh };
}

it("changes access only for the selected active agent and refuses workflow child opt-in", async () => {
  const { api } = apiFixture();
  const f = await fixture(api);
  expect(await f.invoke(getAgentAccessRpc.name, { agentId: "a" })).toMatchObject({ enabled: false, providerFamily: "codex", isWorkflowChild: false, cliPath: f.paths.cli });
  expect(await f.invoke(setAgentAccessRpc.name, { agentId: "a", enabled: true })).toMatchObject({ enabled: true });
  expect(await f.invoke(getAgentAccessRpc.name, { agentId: "b" })).toMatchObject({ enabled: false });
  expect(await f.invoke(getAgentAccessRpc.name, { agentId: "child" })).toMatchObject({ enabled: false, isWorkflowChild: true });
  await expect(f.invoke(setAgentAccessRpc.name, { agentId: "child", enabled: true })).rejects.toThrow("children cannot enable");
  for (const agentId of ["missing", "archived"]) {
    await expect(f.invoke(getAgentAccessRpc.name, { agentId })).rejects.toThrow("was not found");
    await expect(f.invoke(setAgentAccessRpc.name, { agentId, enabled: true })).rejects.toThrow("was not found");
  }
  expect(await f.invoke(setAgentAccessRpc.name, { agentId: "a", enabled: false })).toMatchObject({ enabled: false });
});

it("honors explicit creation opt-in, but never inherited refresh flags or workflow children", async () => {
  const { api } = apiFixture();
  const f = await fixture(api);
  const open = (agentId: string, reason: string, extra: Record<string, string> = {}) => f.sessionOpen({
    agentId, reason, workspaceId: null, provider: "codex", cwd: "/tmp", purpose: "interactive",
    env: { [ENABLE_ENV]: "1", [BINDING_ENV]: `nonce-${agentId}`, ...extra },
  });
  expect(await open("a", "create")).toMatchObject({ env: {} });
  expect(await f.invoke(getAgentAccessRpc.name, { agentId: "a" })).toMatchObject({ enabled: true });
  expect(await open("b", "refresh")).toMatchObject({ env: {} });
  expect(await f.invoke(getAgentAccessRpc.name, { agentId: "b" })).toMatchObject({ enabled: false });
  expect(await open("child", "create", { [CHILD_ENV]: "1" })).toMatchObject({ env: {} });
  expect(await f.invoke(getAgentAccessRpc.name, { agentId: "child" })).toMatchObject({ enabled: false });
});

it("does not persist a toggle whose agent refresh completes after shutdown", async () => {
  const { api, refresh } = apiFixture();
  let entered!: () => void;
  let release!: () => void;
  const refreshing = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  refresh.mockImplementationOnce(async () => { entered(); await pending; return { agent: { provider: "codex", archivedAt: null, labels: {} } }; });
  const f = await fixture(api);
  const toggle = f.invoke(setAgentAccessRpc.name, { agentId: "a", enabled: true });
  const rejected = expect(toggle).rejects.toThrow("stopping");
  await refreshing;
  await f.dispose();
  release();
  await rejected;
});
