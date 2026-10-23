import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fake, constructed } = vi.hoisted(() => ({
  fake: {
    connect: vi.fn(), close: vi.fn(), getConnectionState: vi.fn(),
    getLastServerInfoMessage: vi.fn(), fetchAgent: vi.fn(), applyAgentConfig: vi.fn(),
    sendAgentMessage: vi.fn(), listUsageReports: vi.fn(), fetchAgentTimeline: vi.fn(),
    listProviderModels: vi.fn(), buildAgentForkContext: vi.fn(), fetchAgents: vi.fn(),
    createAgent: vi.fn(), cancelAgent: vi.fn(), getDaemonConfig: vi.fn(),
  },
  constructed: vi.fn(),
}));

vi.mock("@getpaseo/client/internal/daemon-client", () => ({
  DaemonClient: function (config: unknown) {
    constructed(config);
    return fake;
  },
}));

import { createDaemonAdapter, localDaemonTarget, FALLBACK_OWNER_LABEL, FALLBACK_OPERATION_LABEL,
  type AgentSnapshot, type ForkAttachment } from "./daemon";

let home: string;
beforeEach(async () => {
  vi.resetAllMocks();
  fake.connect.mockResolvedValue(undefined);
  fake.close.mockResolvedValue(undefined);
  fake.getConnectionState.mockReturnValue({ status: "connected" });
  fake.getLastServerInfoMessage.mockReturnValue({ features: { agentConfigApply: true, agentRequestReceipts: true } });
  fake.fetchAgents.mockResolvedValue({ entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
  home = await mkdtemp(join(tmpdir(), "rate-fallback-daemon-"));
  await writeFile(join(home, "paseo.pid"), JSON.stringify({ listen: "127.0.0.1:6767" }));
  await writeFile(join(home, "local-credential"), `${"a".repeat(43)}\n`);
});

function source(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { id: "main-claude", provider: "claude", model: "opus", thinkingOptionId: "high",
    status: "error", archivedAt: null, activeTurn: null, pendingPermissions: [], lastError: "Rate limit",
    cwd: "/repo", workspaceId: "workspace-one", title: "Main task", currentModeId: "default", labels: {}, ...overrides };
}
function backup(overrides: Record<string, unknown> = {}) {
  return { ...source(), id: "backup", provider: "codex", model: "gpt-6.1-sol", thinkingOptionId: "ultra",
    labels: { [FALLBACK_OWNER_LABEL]: "main-claude", [FALLBACK_OPERATION_LABEL]: "operation-one" }, ...overrides };
}

describe("cross-provider fork adapter", () => {
  it("uses Paseo's fork context attachment and delivers it with a stable message ID", async () => {
    const adapter = createDaemonAdapter({ home });
    const attachment: ForkAttachment = { type: "text", mimeType: "text/plain", contextKind: "chat_history",
      title: "Chat history", text: "Existing user task and completed tool effects" };
    const context = { agentId: "main-claude", attachment, itemCount: 3, boundaryMessageId: "previous-user", error: null };
    fake.buildAgentForkContext.mockResolvedValue(context);
    expect(await adapter.forkContext("main-claude")).toBe(context);
    expect(fake.buildAgentForkContext).toHaveBeenCalledWith("main-claude");
    await adapter.sendWithContext("backup", "Continue from the handoff.", "stable-message", attachment);
    expect(fake.sendAgentMessage).toHaveBeenCalledWith("backup", "Continue from the handoff.", {
      messageId: "stable-message", activeTurnBehavior: "steer", attachments: [attachment],
    });
    await adapter.close();
  });

  it("creates an unprompted Codex child in the source workspace with durable ownership", async () => {
    const adapter = createDaemonAdapter({ home });
    fake.createAgent.mockResolvedValue(backup());
    const result = await adapter.createFallback({ source: source(), operationId: "operation-one" });
    expect(result).toMatchObject({ id: "backup", provider: "codex", model: "gpt-6.1-sol", thinkingOptionId: "ultra", workspaceId: "workspace-one" });
    expect(fake.createAgent).toHaveBeenCalledWith({ workspaceId: "workspace-one", callerAgentId: "main-claude",
      idempotencyKey: "operation-one", labels: {
        [FALLBACK_OWNER_LABEL]: "main-claude", [FALLBACK_OPERATION_LABEL]: "operation-one",
      }, config: { provider: "codex", cwd: "/repo", model: "gpt-6.1-sol", thinkingOptionId: "ultra",
        title: "Main task · GPT-6.1 fallback", modeId: "auto" } });
    expect(fake.sendAgentMessage).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("keeps the fallback suffix within the title limit without splitting a Unicode character", async () => {
    const adapter = createDaemonAdapter({ home });
    fake.createAgent.mockResolvedValue(backup());
    await adapter.createFallback({ source: source({ title: "😀".repeat(100) }), operationId: "operation-one" });
    const title = fake.createAgent.mock.calls[0]![0].config.title as string;
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.endsWith(" · GPT-6.1 fallback")).toBe(true);
    expect(title.slice(0, -" · GPT-6.1 fallback".length)).toBe("😀".repeat(90));
    await adapter.close();
  });

  it.each([
    ["plan", "auto", { plan_mode: true }],
    ["read-only", "auto", undefined],
    ["bypassPermissions", "full-access", undefined],
    ["full-access", "full-access", undefined],
    ["acceptEdits", "auto", undefined],
    [null, "auto", undefined],
  ])("maps source mode %s without granting broader permissions", async (currentModeId, modeId, featureValues) => {
    const adapter = createDaemonAdapter({ home });
    fake.createAgent.mockResolvedValue(backup());
    await adapter.createFallback({ source: source({ currentModeId }), operationId: "operation-one" });
    const config = fake.createAgent.mock.calls[0]![0].config;
    expect(config.modeId).toBe(modeId);
    expect(config.featureValues).toEqual(featureValues);
    expect(config.providerOptions).toEqual(currentModeId === "plan" || currentModeId === "read-only"
      ? { sandbox_mode: "read-only", approval_policy: "on-request" } : undefined);
    await adapter.close();
  });

  it("finds an existing backup after a lost creation response and does not create another", async () => {
    const adapter = createDaemonAdapter({ home });
    fake.fetchAgents.mockResolvedValue({ entries: [{ agent: backup() }], pageInfo: { hasMore: false } });
    expect((await adapter.createFallback({ source: source(), operationId: "operation-one" })).id).toBe("backup");
    expect(fake.createAgent).not.toHaveBeenCalled();
    expect(fake.fetchAgents).toHaveBeenCalledWith({ includeBackground: true,
      filter: { includeArchived: true, labels: { [FALLBACK_OWNER_LABEL]: "main-claude", [FALLBACK_OPERATION_LABEL]: "operation-one" } },
      page: { limit: 200 } });
    await adapter.close();
  });

  it("returns archived ownership for the controller to honor and rejects duplicate ownership", async () => {
    const adapter = createDaemonAdapter({ home });
    fake.fetchAgents.mockResolvedValueOnce({ entries: [{ agent: backup({ archivedAt: "2026-10-22T18:00:00Z" }) }], pageInfo: { hasMore: false } });
    expect((await adapter.findFallback("operation-one", "main-claude"))?.archivedAt).toBe("2026-10-22T18:00:00Z");
    fake.fetchAgents.mockResolvedValueOnce({ entries: [{ agent: backup() }, { agent: backup({ id: "duplicate" }) }], pageInfo: { hasMore: false } });
    await expect(adapter.findFallback("operation-one", "main-claude")).rejects.toThrow("Multiple backup");
    await adapter.close();
  });

  it("rejects a recovered backup in a different workspace before it can be used", async () => {
    const adapter = createDaemonAdapter({ home });
    fake.fetchAgents.mockResolvedValue({ entries: [{ agent: backup({ workspaceId: "another-workspace" }) }], pageInfo: { hasMore: false } });
    await expect(adapter.createFallback({ source: source(), operationId: "operation-one" })).rejects.toThrow("does not match");
    expect(fake.createAgent).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("requires an existing workspace and durable creation support", async () => {
    const adapter = createDaemonAdapter({ home });
    await expect(adapter.createFallback({ source: source({ workspaceId: null }), operationId: "operation-one" })).rejects.toThrow("workspace");
    fake.getLastServerInfoMessage.mockReturnValue({ features: {} });
    await expect(adapter.createFallback({ source: source(), operationId: "operation-one" })).rejects.toThrow("durable");
    expect(fake.createAgent).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("only stops labeled plugin backups and never the original user agent", async () => {
    const adapter = createDaemonAdapter({ home });
    fake.fetchAgent.mockResolvedValueOnce({ agent: source() });
    await expect(adapter.stop("main-claude")).rejects.toThrow("not a plugin-owned backup");
    expect(fake.cancelAgent).not.toHaveBeenCalled();
    fake.fetchAgent.mockResolvedValueOnce({ agent: backup() });
    await adapter.stop("backup");
    expect(fake.cancelAgent).toHaveBeenCalledWith("backup");
    await adapter.close();
  });

  it("resolves configured provider inheritance and caches it while handling cycles", async () => {
    const adapter = createDaemonAdapter({ home });
    fake.getDaemonConfig.mockResolvedValue({ config: { providers: {
      "claude-primary": { extends: "claude-hop" }, "claude-hop": { extends: "claude" },
      "codex-primary": { extends: "codex" }, circularA: { extends: "circularB" }, circularB: { extends: "circularA" },
    } } });
    expect(await adapter.providerFamily("claude")).toBe("claude");
    expect(await adapter.providerFamily("claude-primary")).toBe("claude");
    expect(await adapter.providerFamily("codex-primary")).toBe("codex");
    expect(await adapter.providerFamily("circularA")).toBeNull();
    expect(await adapter.providerFamily("unknown")).toBeNull();
    expect(fake.getDaemonConfig).toHaveBeenCalledTimes(1);
    await adapter.close();
  });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe("local daemon address", () => {
  it.each([
    ["127.0.0.1:6767", "127.0.0.1:6767"],
    ["0.0.0.0:6767", "127.0.0.1:6767"],
    ["tcp://[::]:6767", "[::1]:6767"],
    ["/tmp/paseo.sock", "unix:///tmp/paseo.sock"],
  ])("normalizes %s", (input, expected) => {
    expect(localDaemonTarget(input)).toBe(expected);
  });
  it.each([undefined, "", "https://remote.example", "192.168.1.5:6767", "127.0.0.1:0", "localhost:65536"])(
    "rejects credential use for %s", (input) => { expect(() => localDaemonTarget(input)).toThrow(); },
  );
});

describe("daemon adapter", () => {
  it("uses one authenticated local connection and applies model plus reasoning together", async () => {
    const adapter = createDaemonAdapter({ home });
    await adapter.applySettings("one", { model: "gpt-6.1", thinkingOptionId: "ultra" });
    await adapter.send("one", "Continue.", "unique-continuation");
    expect(constructed).toHaveBeenCalledTimes(1);
    const config = constructed.mock.calls[0]![0];
    expect(config.url).toBe("ws://127.0.0.1:6767/ws");
    expect(await config.localCredential()).toBe("a".repeat(43));
    expect(fake.applyAgentConfig).toHaveBeenCalledWith("one", { modelId: "gpt-6.1", thinkingOptionId: "ultra" });
    expect(fake.sendAgentMessage).toHaveBeenCalledWith("one", "Continue.", { messageId: "unique-continuation", activeTurnBehavior: "steer" });
    await adapter.close();
    expect(fake.close).toHaveBeenCalledTimes(1);
    await expect(adapter.send("one", "Continue.", "later")).rejects.toThrow("closed");
  });

  it("preserves runtime nulls and uses effective thinking as the saved default", async () => {
    const adapter = createDaemonAdapter({ home });
    const base = { id: "one", provider: "codex", model: "gpt-6-astra", thinkingOptionId: null,
      effectiveThinkingOptionId: "high", status: "idle", pendingPermissions: [], cwd: "/repo" };
    fake.fetchAgent.mockResolvedValueOnce({ agent: { ...base, runtimeInfo: { model: null, thinkingOptionId: null } } });
    expect(await adapter.getAgent("one")).toMatchObject({ model: null, thinkingOptionId: null, archivedAt: null, activeTurn: null, lastError: null });
    fake.fetchAgent.mockResolvedValueOnce({ agent: base });
    expect(await adapter.getAgent("one")).toMatchObject({ model: "gpt-6-astra", thinkingOptionId: "high" });
    await adapter.close();
  });

  it("refreshes usage scoped to the selected agent's account", async () => {
    const adapter = createDaemonAdapter({ home });
    fake.listUsageReports.mockResolvedValue({ reports: [] });
    expect(await adapter.usage("one")).toEqual({ reports: [] });
    expect(fake.listUsageReports).toHaveBeenCalledWith({ agentId: "one", forceRefresh: true });
    await adapter.close();
  });

  it("requires the combined configuration capability", async () => {
    const adapter = createDaemonAdapter({ home });
    fake.getLastServerInfoMessage.mockReturnValue({ features: {} });
    await expect(adapter.applySettings("one", { model: "gpt-6.1", thinkingOptionId: "ultra" })).rejects.toThrow("single agent configuration");
    expect(fake.applyAgentConfig).not.toHaveBeenCalled();
    await adapter.close();
  });

  it("closes a rejected connection and permits a later retry", async () => {
    const adapter = createDaemonAdapter({ home });
    fake.connect.mockRejectedValueOnce(new Error("offline"));
    await expect(adapter.usage("one")).rejects.toThrow("offline");
    await adapter.usage("one");
    expect(constructed).toHaveBeenCalledTimes(2);
    expect(fake.close).toHaveBeenCalledTimes(1);
    await adapter.close();
  });
});
