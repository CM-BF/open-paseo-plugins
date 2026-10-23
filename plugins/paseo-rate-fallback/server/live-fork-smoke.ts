/**
 * Live cross-provider fork smoke. Real disposable Claude and Codex sessions and
 * native Paseo fork attachments; simulated rate/usage and acknowledged sends.
 * Default: no inference. PASEO_RATE_FORK_REAL_INFERENCE=1 sends one minimal GPT
 * transport prompt; return-to-Claude delivery stays stubbed. Global journals are untouched.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { createDaemonAdapter, localDaemonTarget, FALLBACK_OWNER_LABEL, FALLBACK_OPERATION_LABEL,
  type ForkAttachment, type ForkDaemonAdapter } from "./daemon";
import { ForkController, type TransferNotice } from "./fork-controller";
import { ForkStore } from "./fork-store";

const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
const lock = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")) as { listen?: unknown };
const target = localDaemonTarget(lock.listen);
const socketPath = target.startsWith("unix://") ? target.slice(7)
  : target.startsWith("pipe://") ? target.slice(7) : undefined;
const client = new DaemonClient({
  url: socketPath ? "ws://localhost/ws" : `ws://${target}/ws`,
  clientId: `rate-fork-smoke-${randomUUID()}`, clientType: "cli", appVersion: "0.12.0",
  connectTimeoutMs: 10_000, reconnect: { enabled: false },
  localCredential: async () => (await readFile(join(home, "local-credential"), "utf8")).trim(),
  webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, {
    headers: options?.headers, ...(socketPath ? { socketPath } : {}),
  }) as unknown as WebSocketLike,
});
const real = createDaemonAdapter({ home });
const realInference = process.env.PASEO_RATE_FORK_REAL_INFERENCE === "1";
const transportMarker = "PASEO_FORK_TRANSPORT_OK";
const transportPrompt = "这是插件消息传输测试。只回复 PASEO_FORK_TRANSPORT_OK，不调用工具，不执行任务。";
let realPromptAttempted = false;
const fixture = await mkdtemp(join(tmpdir(), "paseo-rate-fork-live-"));
let mainId: string | undefined;
let backupId: string | undefined;
let workspaceId: string | undefined;
let projectId: string | undefined;
let controller: ForkController | undefined;
const cleanupErrors: string[] = [];
const result: Record<string, unknown> = {
  real: ["local daemon authentication", "Claude source session", "Codex child session",
    "same workspace and parent labels", "native fork contexts in both directions",
    ...(realInference ? ["one GPT-6.1 Sol Ultra response with native outbound attachment"] : [])],
  simulated: ["initial provider rate limit", "quota recovery",
    realInference ? "Claude return send acknowledgement" : "send acknowledgements"],
  inferencePromptsSent: 0,
};
async function cleanup(action: () => Promise<unknown>) {
  try { await action(); } catch (error) { cleanupErrors.push(String(error)); }
}

try {
  execFileSync("git", ["init", "--quiet", fixture], { stdio: "pipe" });
  await client.connect();
  const created = await client.createWorkspace({
    idempotencyKey: randomUUID(), source: { kind: "directory", path: fixture },
    title: "Cross-provider fallback smoke (disposable)",
    agent: { config: { provider: "claude", cwd: fixture, model: "opus", thinkingOptionId: "high",
      modeId: "plan", title: "Disposable Claude handoff source" } },
  });
  workspaceId = created.workspace?.id;
  projectId = created.workspace?.projectId;
  mainId = created.agent?.id;
  assert.ok(created.workspace, created.error ?? "The fixture workspace was not created");
  assert.equal(resolve(created.workspace.projectRootPath), resolve(fixture));
  assert.ok(mainId, "The fixture Claude agent was not created");
  const original = await real.getAgent(mainId);
  const originalRaw = (await client.fetchAgent({ agentId: mainId }))?.agent;
  assert.ok(original);
  assert.ok(originalRaw);
  assert.equal(original.provider, "claude");
  assert.equal(original.currentModeId, "plan");

  let clock = Date.now();
  let exhausted = true;
  const sends: Array<{ agentId: string; text: string; messageId: string; attachment: ForkAttachment }> = [];
  const contexts = new Map<string, ForkAttachment>();
  const notices: TransferNotice[] = [];
  const adapter: ForkDaemonAdapter = {
    ...real,
    async forkContext(id) {
      const context = await real.forkContext(id);
      assert.ok(context.attachment);
      contexts.set(id, structuredClone(context.attachment));
      return context;
    },
    async sendWithContext(agentId, text, messageId, attachment) {
      const outbound = agentId !== mainId;
      if (outbound) backupId = agentId;
      const wireText = realInference && outbound ? transportPrompt : text;
      sends.push({ agentId, text: wireText, messageId, attachment: structuredClone(attachment) });
      if (realInference && outbound) {
        assert.equal(realPromptAttempted, false, "Refusing to send more than one real inference prompt");
        realPromptAttempted = true;
        await real.sendWithContext(agentId, wireText, messageId, attachment);
        result.inferencePromptsSent = 1;
        const finished = await client.waitForFinish(agentId, 120_000);
        assert.equal(finished.status, "idle", `Real GPT transport failed: ${finished.status}; ${finished.error ?? ""}`);
        const page = await client.fetchAgentTimeline(agentId, { direction: "tail", limit: 30 });
        const responses = page.entries.flatMap(({ item }) => item.type === "assistant_message" ? [item.text] : []);
        assert.ok(responses.some((response) => response.includes(transportMarker)),
          "The real GPT assistant response did not contain the transport marker");
        result.realTransport = { passed: true, status: finished.status, marker: transportMarker,
          model: finished.final?.model, thinking: finished.final?.effectiveThinkingOptionId };
      }
    },
    async usage(id) {
      assert.equal(id, mainId);
      return { requestId: "simulated-claude-quota", reports: [{
        id: "claude:smoke", sourceId: "claude", sourceLabel: "Claude", account: {},
        fetchedAt: new Date(clock).toISOString(), report: { status: "available", windows: [{
          id: "five_hour", label: "Session", usedPct: exhausted ? 100 : 10,
          resetsAt: new Date(clock + 1000).toISOString(),
        }] },
      }] };
    },
  };
  const store = new ForkStore(join(fixture, "isolated-fork-state.json"));
  store.loadSync();
  controller = new ForkController(adapter, store, () => true,
    async (_id, notice) => { notices.push(notice); }, () => clock);
  await controller.endedTurn(mainId, "simulated-claude-rate-limit", {
    kind: "failed", error: { message: "Rate limit exceeded; try again in 1 second" },
  });
  assert.equal(controller.error, null);
  const entry = store.state.agents[mainId];
  assert.ok(entry?.fallbackAgentId, "A Codex backup was not recorded durably");
  backupId = entry.fallbackAgentId;
  const backup = await real.getAgent(backupId);
  assert.ok(backup);
  assert.equal(backup.provider, "codex");
  assert.equal(backup.model, "gpt-6.1-sol");
  assert.equal(backup.thinkingOptionId, "ultra");
  assert.equal(backup.workspaceId, original.workspaceId);
  assert.equal(backup.labels?.[FALLBACK_OWNER_LABEL], original.id);
  assert.equal(backup.labels?.[FALLBACK_OPERATION_LABEL], entry.operationId);
  assert.equal(backup.labels?.["paseo.parent-agent-id"], original.id);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.agentId, backupId);
  assert.deepEqual(sends[0]?.attachment, contexts.get(mainId));
  assert.equal(sends[0]?.attachment.contextKind, "chat_history");
  assert.equal(entry.fallbackSent, true);
  result.fallback = { provider: backup.provider, model: backup.model,
    thinking: backup.thinkingOptionId, sameWorkspace: true, parentAndOwnershipLabels: true };

  exhausted = false;
  clock += 10_000;
  await controller.tick();
  assert.equal(controller.error, null);
  assert.equal(sends.length, 2);
  assert.equal(sends[1]?.agentId, original.id);
  assert.deepEqual(sends[1]?.attachment, contexts.get(backupId));
  assert.equal(sends[1]?.attachment.contextKind, "chat_history");
  if (realInference) assert.ok(sends[1]?.attachment.text.includes(transportMarker),
    "The native backup fork context did not include its real GPT response");
  assert.notEqual(sends[0]?.messageId, sends[1]?.messageId);
  assert.equal(store.state.agents[mainId]?.returnSent, true);
  assert.ok(notices.some(({ phase }) => phase === "returning"));
  const after = await real.getAgent(mainId);
  const afterRaw = (await client.fetchAgent({ agentId: mainId }))?.agent;
  assert.ok(after);
  assert.ok(afterRaw);
  assert.deepEqual({ model: afterRaw.model, thinking: afterRaw.thinkingOptionId, effectiveThinking: afterRaw.effectiveThinkingOptionId },
    { model: originalRaw.model, thinking: originalRaw.thinkingOptionId, effectiveThinking: originalRaw.effectiveThinkingOptionId });
  assert.deepEqual({ provider: after.provider, model: after.model, thinking: after.thinkingOptionId,
    mode: after.currentModeId, workspace: after.workspaceId },
  { provider: original.provider, model: original.model, thinking: original.thinkingOptionId,
    mode: original.currentModeId, workspace: original.workspaceId });
  result.return = { provider: after.provider, model: after.model, configuredModel: afterRaw.model, thinking: after.thinkingOptionId,
    mode: after.currentModeId, receivedNativeBackupContext: true,
    simulatedSendAcknowledgements: sends.length - (realInference ? 1 : 0),
    ...(realInference ? { backupContextContainsRealMarker: true } : {}) };
  clock += 60_001;
  await controller.tick();
  assert.equal(store.state.agents[mainId], undefined);
  result.isolatedJournalCleared = true;
  result.fixture = { mainAgentId: mainId, fallbackAgentId: backupId };
} finally {
  if (controller) await cleanup(() => controller!.close());
  if (realPromptAttempted && backupId) await cleanup(async () => {
    const backup = await real.getAgent(backupId!);
    if (backup && (backup.status === "running" || backup.status === "initializing" ||
        backup.activeTurn || backup.pendingPermissions.length > 0)) await real.stop(backupId!);
  });
  await cleanup(() => real.close());
  for (const id of [backupId, mainId]) if (id) await cleanup(async () => {
    assert.ok((await client.archiveAgent(id)).archivedAt);
  });
  if (workspaceId) await cleanup(async () => {
    const archived = await client.archiveWorkspace(workspaceId!);
    assert.equal(archived.error, null);
    assert.ok(archived.archivedAt);
  });
  if (projectId) await cleanup(() => client.removeProject(projectId!));
  await cleanup(() => client.close());
  await cleanup(() => rm(fixture, { recursive: true, force: true }));
  result.cleanup = cleanupErrors.length ? { errors: cleanupErrors }
    : "fixture agents and workspace archived; fixture project and temporary files removed";
  console.log(JSON.stringify(result, null, 2));
  assert.equal(cleanupErrors.length, 0, `Cleanup failed: ${cleanupErrors.join("; ")}`);
}
