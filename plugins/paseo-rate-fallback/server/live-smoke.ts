/**
 * Live daemon smoke: disposable Codex session, real model configuration RPCs.
 * The rate event, recovered usage and continuation acknowledgement are simulated;
 * this script never sends a prompt to a model. Run only against a local daemon.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { createDaemonAdapter, localDaemonTarget, type DaemonAdapter } from "./daemon";
import { FallbackController, FALLBACK_MODEL, FALLBACK_THINKING } from "./controller";
import { StateStore } from "./store";
import { statusRpc, configureRpc } from "../shared/contracts";

const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
const lock = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")) as { listen?: unknown };
const target = localDaemonTarget(lock.listen);
const socketPath = target.startsWith("unix://") ? target.slice(7)
  : target.startsWith("pipe://") ? target.slice(7) : undefined;
const client = new DaemonClient({
  url: socketPath ? "ws://localhost/ws" : `ws://${target}/ws`,
  clientId: `rate-fallback-smoke-${randomUUID()}`,
  clientType: "cli", appVersion: "0.12.0", connectTimeoutMs: 10_000,
  reconnect: { enabled: false },
  localCredential: async () => (await readFile(join(home, "local-credential"), "utf8")).trim(),
  webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, {
    headers: options?.headers, ...(socketPath ? { socketPath } : {}),
  }) as unknown as WebSocketLike,
});

const fixture = await mkdtemp(join(tmpdir(), "paseo-rate-fallback-live-"));
let agentId: string | undefined;
let workspaceId: string | undefined;
let projectId: string | undefined;
let controller: FallbackController | undefined;
let originalEnabled: boolean | undefined;
let toggledSettings = false;
const cleanupErrors: string[] = [];
const result: Record<string, unknown> = {
  simulated: ["provider rate limit event", "quota recovery", "continuation acknowledgement"],
  real: ["local daemon authentication", "Codex session", "model and reasoning configuration", "plugin RPC"],
};

async function status() {
  return statusRpc.output.parse(await client.invokePluginRpc("paseo-rate-fallback", statusRpc.name, {}));
}
async function configure(enabled: boolean) {
  const response = await client.invokePluginRpc("paseo-rate-fallback", configureRpc.name, { enabled });
  assert.equal(configureRpc.output.parse(response).enabled, enabled);
}
async function cleanup(action: () => Promise<unknown>) {
  try { await action(); } catch (error) { cleanupErrors.push(String(error)); }
}

try {
  execFileSync("git", ["init", "--quiet", fixture], { stdio: "pipe" });
  await client.connect();
  const before = await status();
  originalEnabled = before.enabled;
  assert.equal(before.agents.length, 0, "Plugin setting verification requires no tracked real fallback agents");
  toggledSettings = true;
  await configure(false);
  assert.equal((await status()).enabled, false);
  await configure(true);
  assert.equal((await status()).enabled, true);
  await configure(originalEnabled);
  result.pluginRpc = "status and disable/enable passed; original enabled flag restored";

  const created = await client.createWorkspace({
    idempotencyKey: randomUUID(),
    source: { kind: "directory", path: fixture },
    title: "Rate fallback smoke (disposable)",
    agent: { config: { provider: "codex", cwd: fixture, model: "gpt-6-astra",
      thinkingOptionId: "high", title: "Rate fallback smoke (no prompt)" } },
  });
  workspaceId = created.workspace?.id;
  projectId = created.workspace?.projectId;
  agentId = created.agent?.id;
  assert.ok(created.workspace, created.error ?? "Workspace was not created");
  assert.equal(resolve(created.workspace.projectRootPath), resolve(fixture), "Cleanup must own the fixture project");
  assert.ok(agentId, "The disposable workspace has no agent");

  const real = createDaemonAdapter({ home });
  const continuations: Array<{ agentId: string; messageId: string; text: string }> = [];
  let clock = Date.now();
  const adapter: DaemonAdapter = {
    ...real,
    async send(id, text, messageId) { continuations.push({ agentId: id, text, messageId }); },
    async usage() {
      return { requestId: "simulated-recovery", reports: [{
        id: "codex:smoke", sourceId: "codex", sourceLabel: "Codex", account: {},
        fetchedAt: new Date(clock).toISOString(),
        report: { status: "available", windows: [{ id: "weekly", label: "Weekly", usedPct: 0 }] },
      }] };
    },
  };
  const store = new StateStore(join(fixture, "smoke-state.json"));
  await store.load();
  controller = new FallbackController(adapter, store, () => clock);
  const initial = await real.getAgent(agentId);
  assert.equal(initial?.model, "gpt-6-astra");
  assert.equal(initial?.thinkingOptionId, "high");
  assert.equal(initial?.status, "idle");
  await controller.endedTurn(agentId, "simulated-rate-limited-turn", {
    kind: "failed", error: { message: "Usage limit reached; try again in 1 second" },
  });
  const fallback = await real.getAgent(agentId);
  assert.equal(fallback?.model, FALLBACK_MODEL);
  assert.equal(fallback?.thinkingOptionId, FALLBACK_THINKING);
  assert.equal(continuations.length, 1);
  assert.equal(continuations[0]?.agentId, agentId);
  assert.ok(continuations[0]?.messageId);
  assert.ok(continuations[0]?.text.includes("继续"));
  assert.equal(store.state.agents[agentId]?.pendingResume, false);
  result.fallback = { model: fallback.model, thinking: fallback.thinkingOptionId,
    simulatedContinuationAcknowledgements: continuations.length };

  clock += 10_000;
  await controller.tick();
  const restored = await real.getAgent(agentId);
  assert.equal(restored?.model, "gpt-6-astra");
  assert.equal(restored?.thinkingOptionId, "high");
  assert.equal(Object.keys(store.state.agents).length, 0);
  assert.equal(continuations.length, 1);
  result.restored = { model: restored.model, thinking: restored.thinkingOptionId };
  result.agentId = agentId;
} finally {
  if (controller) await cleanup(() => controller!.close());
  if (toggledSettings && originalEnabled !== undefined) {
    await cleanup(async () => {
      const current = await status();
      assert.equal(current.agents.length, 0, "Refusing to modify settings while real fallbacks are tracked");
      if (current.enabled !== originalEnabled) await configure(originalEnabled!);
    });
  }
  if (agentId) await cleanup(async () => { assert.ok((await client.archiveAgent(agentId!)).archivedAt); });
  if (workspaceId) await cleanup(async () => {
    const archived = await client.archiveWorkspace(workspaceId!);
    assert.equal(archived.error, null);
    assert.ok(archived.archivedAt);
  });
  if (projectId) await cleanup(() => client.removeProject(projectId!));
  await cleanup(() => client.close());
  await cleanup(() => rm(fixture, { recursive: true, force: true }));
  result.cleanup = cleanupErrors.length ? { errors: cleanupErrors } : "fixture agent/workspace archived; fixture project and temporary files removed";
  console.log(JSON.stringify(result, null, 2));
  assert.equal(cleanupErrors.length, 0, `Smoke cleanup failed: ${cleanupErrors.join("; ")}`);
}
