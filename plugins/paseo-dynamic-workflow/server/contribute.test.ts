import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, expect, it, vi } from "vitest";
import { serviceStatusRpc } from "../shared/contracts";
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dwf-contribute-"));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map<string, RpcHandler>();
  const host = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", values: DEFAULT_PREFERENCES, revision: "fixture" }),
      subscribe: () => () => {},
    }),
    before: () => {},
    on: () => {},
    handle: (contract: { name: string }, handler: RpcHandler) => handlers.set(contract.name, handler),
  };
  const dispose = contributeServer(host as unknown as PluginServerContext, { stateDir: root });
  disposals.push(dispose);
  const status = () => handlers.get(serviceStatusRpc.name)!({}, { paseo: {} as PaseoApi });
  return { dispose, status, paths: statePaths(root) };
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
