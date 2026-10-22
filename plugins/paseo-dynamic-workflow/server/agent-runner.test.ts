import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPaseoApi } from "@getpaseo/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, branchName, type AgentProgress, type AgentTask } from "./agent-runner";
import { compileSchema } from "./json-schema";
import type { PaseoApi } from "./gate";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(cleanups.splice(0).map((fn) => fn())); });
const modes = {
  claude: [{ id: "plan", colorTier: "planning" }, { id: "default", colorTier: "safe" }, { id: "bypassPermissions", colorTier: "dangerous", isUnattended: true }],
  codex: [{ id: "auto", colorTier: "moderate" }, { id: "full-access", colorTier: "dangerous", isUnattended: true }],
  pi: [], opencode: [{ id: "plan", colorTier: "planning" }, { id: "build", colorTier: "moderate" }],
};
function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return { runId: "wf_0123456789ab", callId: "a1", workflowName: "test", label: "test", phase: null, prompt: "task", opts: {},
    parent: { agentId: "parent", provider: "claude", model: "sonnet", modeId: "bypassPermissions", thinkingOptionId: null, featureValues: undefined, cwd: "/tmp", workspaceId: "parent-workspace" },
    signal: new AbortController().signal, timeoutMs: 0, archiveWhenDone: true, ...overrides };
}
function fixture() {
  let snapshot: any = { id: "child", provider: "claude", model: "sonnet", cwd: "/tmp", workspaceId: "child-workspace", status: "idle", archivedAt: null, pendingPermissions: [] };
  let listener: (message: any) => void = () => {};
  const handle = {
    id: "child", current: () => snapshot,
    refresh: vi.fn(async () => ({ agent: snapshot, project: null })),
    waitForFinish: vi.fn(async () => ({ status: "idle", final: snapshot, lastMessage: "done", error: null })),
    send: vi.fn(async () => {}), archive: vi.fn(async () => ({ archivedAt: "now" })),
    timeline: { subscribe: (callback: typeof listener) => { listener = callback; const off = () => {}; return Object.assign(off, { ready: Promise.resolve() }); } },
  };
  const parentHandle = { refresh: vi.fn(async () => null) };
  const api = {
    agents: { create: vi.fn(async (_options: any) => handle), ref: vi.fn((id: string) => id === "parent" ? parentHandle : handle) },
    providers: {
      listModels: vi.fn(async (provider: string): Promise<any> => ({ models: [{ id: provider === "claude" ? "sonnet" : "gpt-x", label: "Default", isDefault: true }] })),
      listAvailable: vi.fn(async () => ({ providers: Object.keys(modes).map((provider) => ({ provider, available: true })) })),
      listModes: vi.fn(async (provider: string) => ({ modes: modes[provider as keyof typeof modes] ?? [] })),
      snapshot: vi.fn(async () => ({ entries: Object.entries(modes).map(([provider, list]) => ({ provider, modes: list })) })),
    },
    config: { get: vi.fn(async () => ({ config: { agentProfiles: [{ id: "profile", name: "profile", provider: "codex" }] } })) },
    workspaces: { archive: vi.fn(async () => ({ archivedAt: "now", error: null })), open: vi.fn() },
  };
  const progress: AgentProgress = { started: vi.fn(), status: vi.fn(), usage: vi.fn(), repaired: vi.fn() };
  return { api, handle, parentHandle, progress, runner: new AgentRunner(() => api as unknown as PaseoApi), snapshot: (next: any) => { snapshot = { ...snapshot, ...next }; }, cancel: () => listener({ event: { type: "turn_canceled", reason: "stopped" } }) };
}
function transient(): Error { return Object.assign(new Error("Transport not connected"), { name: "DaemonConnectionError", code: "DAEMON_CONNECTION_LOST" }); }

describe("AgentRunner configuration", () => {
  it("resolves a real default model through the SDK for a model-less parent", async () => {
    const f = fixture();
    const createAgent = vi.fn(async (options) => ({ ...f.handle.current(), id: "child", model: options.config.model }));
    const daemon = {
      createAgent, fetchAgent: vi.fn(async (options) => options.agentId === "parent" ? null : ({ agent: f.handle.current(), project: null })),
      listProviderModes: f.api.providers.listModes, listProviderModels: f.api.providers.listModels,
      waitForFinish: f.handle.waitForFinish, getDaemonConfig: f.api.config.get,
      sendAgentMessage: vi.fn(async () => {}), archiveAgent: vi.fn(async () => ({ archivedAt: "now" })),
      subscribeAgentTimeline: vi.fn(() => Object.assign(() => {}, { ready: Promise.resolve(), release: async () => {} })),
    };
    const api = createPaseoApi(daemon as any);
    const t = task(); t.parent.model = null;
    const outcome = await new AgentRunner(() => api).run(t, f.progress);
    expect(outcome).toMatchObject({ ok: true, value: "done" });
    await api.dispose();
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ provider: "claude", model: "sonnet" }) }));
  });
  it.each([{ provider: "codex" }, { agentType: "profile" }])("uses a default model for %j", async (opts) => {
    const f = fixture(); await f.runner.run(task({ opts }), f.progress);
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ config: { provider: "codex/gpt-x" } });
  });
  it("uses the manager default sentinel when provider catalog is unavailable", async () => {
    const f = fixture(); f.api.providers.listModels.mockRejectedValue(new Error("offline catalog"));
    await f.runner.run(task({ opts: { provider: "codex" } }), f.progress);
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ config: { provider: "codex/default" } });
  });
  it("keeps an upstream id that collides with a Paseo provider name", async () => {
    const f = fixture(); f.api.providers.listModels.mockResolvedValue({ models: [{ id: "opencode/foo", label: "Foo" }] });
    const t = task({ opts: { model: "opencode/foo" } }); t.parent.provider = "pi"; t.parent.model = "old"; t.parent.modeId = null;
    await f.runner.run(t, f.progress);
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ config: { provider: "pi/opencode/foo" } });
  });
  it("keeps unknown upstream prefixes when model listing is unavailable", async () => {
    const f = fixture(); f.api.providers.listModels.mockRejectedValue(new Error("offline catalog"));
    await f.runner.run(task({ opts: { model: "anthropic/foo" } }), f.progress);
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ config: { provider: "claude/anthropic/foo" } });
  });
  it("caps a profile's same-provider unattended mode at the launcher's planning mode", async () => {
    const f = fixture(); f.api.config.get.mockResolvedValue({ config: { agentProfiles: [{ id: "profile", name: "profile", provider: "claude", modeId: "bypassPermissions" }] } } as any);
    const t = task({ opts: { agentType: "profile" } }); t.parent.modeId = "plan";
    await f.runner.run(t, f.progress);
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ config: { modeId: "plan" } });
  });
  it("keeps upstream/model identifiers intact and resolves qualified aliases", async () => {
    const f = fixture(); f.api.providers.listModels.mockImplementation(async (provider) => ({ models: [{ id: provider === "opencode" ? "anthropic/claude-sonnet" : "claude-opus", aliases: ["opus"], label: "Model" }] }));
    const t = task({ opts: { model: "anthropic/claude-sonnet" } }); t.parent.provider = "opencode"; t.parent.model = "anthropic/old"; t.parent.modeId = "build";
    await f.runner.run(t, f.progress);
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ config: { provider: "opencode/anthropic/claude-sonnet" } });
    await f.runner.run(task({ opts: { model: "claude/opus" } }), f.progress);
    expect(f.api.agents.create.mock.calls[1]?.[0]).toMatchObject({ config: { provider: "claude/claude-opus" } });
  });
  it.each(["default", "plan"])("does not weaken %s permissions across providers", async (modeId) => {
    const f = fixture(); const t = task({ opts: { provider: "pi" } }); t.parent.modeId = modeId;
    const outcome = await f.runner.run(t, f.progress);
    expect(outcome).toMatchObject({ ok: false, throws: true }); expect(f.api.agents.create).not.toHaveBeenCalled();
    t.opts = { provider: "codex" }; await f.runner.run(t, f.progress);
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ config: { modeId: "auto", options: { sandbox_mode: "read-only", approval_policy: "on-request" } } });
  });
  it("uses catalog metadata when live runtime modes expose only ids and labels", async () => {
    const f = fixture();
    f.parentHandle.refresh.mockResolvedValue({ agent: { provider: "claude", currentModeId: "bypassPermissions", availableModes: [{ id: "bypassPermissions", label: "Bypass" }] }, project: null } as any);
    expect(await f.runner.run(task(), f.progress)).toMatchObject({ ok: true });
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ config: { modeId: "bypassPermissions" } });
  });
  it("caps stale auto-accept features even when the parent mode id stays the same", async () => {
    const f = fixture();
    const t = task(); t.parent.provider = "opencode"; t.parent.modeId = "build"; t.parent.featureValues = { auto_accept: true };
    f.parentHandle.refresh.mockResolvedValue({ agent: { provider: "opencode", currentModeId: "build", availableModes: modes.opencode, features: [{ type: "toggle", id: "auto_accept", value: false }] }, project: null } as any);
    await f.runner.run(t, f.progress);
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ config: { modeId: "build", featureValues: { auto_accept: false } } });
  });
  it("explicitly disables target OpenCode auto-accept while capping a broadened live parent", async () => {
    const f = fixture(); const t = task({ opts: { provider: "opencode" } }); t.parent.modeId = "plan";
    f.parentHandle.refresh.mockResolvedValue({ agent: { provider: "claude", currentModeId: "bypassPermissions", availableModes: [] }, project: null } as any);
    await f.runner.run(t, f.progress);
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ config: { modeId: "plan", featureValues: { auto_accept: false } } });
  });
  it("uses the stricter live parent mode when a user changes it mid-run", async () => {
    const f = fixture(); f.parentHandle.refresh.mockResolvedValue({ agent: { provider: "claude", currentModeId: "plan", availableModes: modes.claude }, project: null } as any);
    await f.runner.run(task({ opts: { provider: "codex" } }), f.progress);
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ config: { modeId: "auto", options: { sandbox_mode: "read-only", approval_policy: "on-request" } } });
  });
});

describe("AgentRunner lifecycle", () => {
  it.each([false, true])("skips an archived child without reviving it (schema=%s)", async (schema) => {
    const f = fixture(); f.snapshot({ archivedAt: "now", status: "closed" });
    const outcome = await f.runner.run(task({ opts: schema ? { schema: compileSchema({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }) } : {} }), f.progress);
    expect(outcome).toMatchObject({ ok: false, skipped: true }); expect(f.handle.send).not.toHaveBeenCalled();
  });
  it("does not accept partial text from a canceled turn", async () => {
    const f = fixture(); f.handle.waitForFinish.mockImplementationOnce(async () => { f.cancel(); return { status: "idle", final: f.handle.current(), lastMessage: "partial", error: null }; });
    const outcome = await f.runner.run(task(), f.progress);
    expect(outcome).toMatchObject({ ok: false, skipped: true });
  });
  it("retries transient wait and archive failures without creating a second child", async () => {
    const f = fixture(); f.handle.waitForFinish.mockRejectedValueOnce(transient()); f.handle.archive.mockRejectedValueOnce(transient());
    const outcome = await f.runner.run(task(), f.progress);
    expect(outcome).toMatchObject({ ok: true, value: "done" }); expect(f.api.agents.create).toHaveBeenCalledTimes(1); expect(f.handle.archive).toHaveBeenCalledTimes(2);
  });
  it("uses the same idempotency key when creation loses its response", async () => {
    const f = fixture(); f.api.agents.create.mockRejectedValueOnce(transient());
    expect(await f.runner.run(task(), f.progress)).toMatchObject({ ok: true });
    expect(f.api.agents.create).toHaveBeenCalledTimes(2);
    expect(f.api.agents.create.mock.calls[0]?.[0]).toEqual(f.api.agents.create.mock.calls[1]?.[0]);
  });
  it("aborts reconnect backoff promptly and leaves non-connection errors unretried", async () => {
    const f = fixture(); const controller = new AbortController();
    f.handle.waitForFinish.mockImplementation(async () => { controller.abort("skip"); throw transient(); });
    expect(await f.runner.run(task({ signal: controller.signal }), f.progress)).toMatchObject({ ok: false, skipped: true });
    const g = fixture(); g.handle.waitForFinish.mockRejectedValue(new Error("provider unavailable"));
    expect(await g.runner.run(task(), g.progress)).toMatchObject({ ok: false, skipped: false, error: "provider unavailable" });
    expect(g.handle.waitForFinish).toHaveBeenCalledTimes(1);
  });
  it("does not count stale usage twice when a correction turn is aborted", async () => {
    const f = fixture(); const controller = new AbortController(); f.snapshot({ lastUsage: { outputTokens: 7 } });
    f.handle.waitForFinish.mockImplementationOnce(async () => ({ status: "idle", final: f.handle.current(), lastMessage: "invalid json", error: null }));
    f.handle.waitForFinish.mockImplementationOnce(async () => { controller.abort("skip"); return new Promise(() => {}); });
    const schema = compileSchema({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
    expect(await f.runner.run(task({ opts: { schema }, signal: controller.signal }), f.progress)).toMatchObject({ ok: false, skipped: true });
    expect(f.progress.usage).toHaveBeenCalledTimes(1);
  });
  it("counts newly exposed partial usage on abort and archives the child", async () => {
    const f = fixture(); const controller = new AbortController(); f.snapshot({ lastUsage: { inputTokens: 3, outputTokens: 7 } });
    f.handle.waitForFinish.mockImplementation(async () => { controller.abort("skip"); return new Promise(() => {}); });
    const outcome = await f.runner.run(task({ signal: controller.signal }), f.progress);
    expect(outcome).toMatchObject({ ok: false, skipped: true }); expect(f.progress.usage).toHaveBeenCalledWith({ inputTokens: 3, outputTokens: 7, costUsd: 0 }); expect(f.handle.archive).toHaveBeenCalledTimes(1);
  });
  it("throws exhausted schema correction and creation validation errors", async () => {
    const f = fixture(); const schema = compileSchema({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
    expect(await f.runner.run(task({ opts: { schema } }), f.progress)).toMatchObject({ ok: false, throws: true, skipped: false });
    expect(f.handle.send).toHaveBeenCalledTimes(4);
    const g = fixture(); g.api.agents.create.mockRejectedValue(new Error("unknown model"));
    expect(await g.runner.run(task(), g.progress)).toMatchObject({ ok: false, throws: true, error: "unknown model" });
  });
  it("keeps caller-selected ownership before a delayed create and cleans it after abort", async () => {
    const f = fixture(); const controller = new AbortController(); let complete!: () => void;
    f.api.agents.create.mockImplementation(async () => { await new Promise<void>((resolve) => { complete = resolve; }); return f.handle; });
    const creating = vi.fn(); const pending = f.runner.run(task({ signal: controller.signal }), { ...f.progress, creating } as any);
    await vi.waitFor(() => expect(f.api.agents.create).toHaveBeenCalled());
    expect(creating).toHaveBeenCalledWith(expect.objectContaining({ agentId: expect.any(String) }));
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ agentId: creating.mock.calls[0]?.[0].agentId, idempotencyKey: expect.any(String) });
    controller.abort("stop"); complete(); expect(await pending).toMatchObject({ ok: false, skipped: true }); expect(f.handle.archive).toHaveBeenCalled();
  });
});

describe("AgentRunner directory placement and worktrees", () => {
  async function gitFixture() {
    const root = await mkdtemp(join(tmpdir(), "dwf-runner-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const git = (...args: string[]) => exec("git", ["-C", root, ...args]);
    await git("init"); await git("config", "user.name", "Workflow test"); await git("config", "user.email", "workflow-test@example.invalid");
    await writeFile(join(root, "file.txt"), "base\n"); await git("add", "."); await git("commit", "-m", "base");
    const worktree = join(root, "child-worktree");
    const f = fixture();
    f.api.agents.create.mockImplementation(async (options) => {
      await git("worktree", "add", worktree, options.worktree.branch);
      f.snapshot({ cwd: worktree }); return f.handle;
    });
    f.api.workspaces.archive.mockImplementation(async () => { await git("worktree", "remove", "--force", worktree); return { archivedAt: "now", error: null }; });
    const t = task({ opts: { isolation: "worktree" } }); t.parent.cwd = root;
    return { f, t, root, worktree, git };
  }
  it("creates an explicit target workspace with the parent link for cwd overrides", async () => {
    const f = fixture(); const cwd = await mkdtemp(join(tmpdir(), "dwf-cwd-")); cleanups.push(() => rm(cwd, { recursive: true, force: true }));
    const create = vi.fn(async () => f.handle); f.api.workspaces.open.mockResolvedValue({ directory: cwd, agents: { create } } as any);
    const outcome = await f.runner.run(task({ opts: { cwd } }), f.progress);
    expect(outcome).toMatchObject({ ok: true }); expect(f.api.agents.create).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ parent: "parent" }));
  });
  it("rejects cwd overrides when the workspace would silently collapse the directory", async () => {
    const f = fixture(); f.api.workspaces.open.mockResolvedValue({ directory: "/different-directory", agents: { create: vi.fn() } } as any);
    const outcome = await f.runner.run(task({ opts: { cwd: tmpdir() } }), f.progress);
    expect(outcome).toMatchObject({ ok: false, throws: true, error: expect.stringContaining("isolation") }); expect(f.api.agents.create).not.toHaveBeenCalled();
  });
  it("keeps branch identity inside the daemon's 50-character slug limit", () => {
    const names = new Set<string>();
    for (let id = 1; id <= 1000; id++) {
      for (const label of ["Migrate this file to the new API.".repeat(3), "", "中文", "!-punctuation-!"]) {
        const name = branchName({ runId: "wf_0123456789ab", callId: `a${id}`, label });
        expect(name.length).toBeLessThanOrEqual(50); expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      }
      names.add(branchName({ runId: "wf_0123456789ab", callId: `a${id}`, label: "Migrate this file to the new API." }));
    }
    expect(names.size).toBe(1000);
  });
  it("removes an unchanged worktree and its exact reserved branch", async () => {
    const { f, t, git } = await gitFixture(); const outcome = await f.runner.run(t, f.progress);
    expect(outcome).toMatchObject({ ok: true, worktree: { changed: false } });
    expect(f.api.agents.create.mock.calls[0]?.[0]).toMatchObject({ worktree: { mode: "checkout-branch", branch: branchName(t) } });
    expect((await git("branch", "--list", branchName(t))).stdout.trim()).toBe("");
  });
  it("retains clean worktrees and their child when archive-finished is disabled", async () => {
    const { f, t, git } = await gitFixture(); t.archiveWhenDone = false;
    expect(await f.runner.run(t, f.progress)).toMatchObject({ ok: true, worktree: { changed: false, retained: true } });
    expect(f.handle.archive).not.toHaveBeenCalled(); expect(f.api.workspaces.archive).not.toHaveBeenCalled();
    expect((await git("branch", "--list", branchName(t))).stdout.trim()).not.toBe("");
  });
  it.each(["dirty", "committed"])("preserves %s worktrees and their branches", async (kind) => {
    const { f, t, worktree, git } = await gitFixture();
    f.handle.send.mockImplementationOnce(async () => {
      await writeFile(join(worktree, "file.txt"), "changed\n");
      if (kind === "committed") { await exec("git", ["-C", worktree, "add", "."]); await exec("git", ["-C", worktree, "commit", "-m", "child change"]); }
    });
    expect(await f.runner.run(t, f.progress)).toMatchObject({ ok: true, worktree: { changed: true, branch: branchName(t) } });
    expect(f.api.workspaces.archive).not.toHaveBeenCalled(); expect((await git("branch", "--list", branchName(t))).stdout.trim()).not.toBe("");
  });
  it("never deletes a pre-existing branch that a child checked out at the base commit", async () => {
    const { f, t, git, worktree } = await gitFixture(); await git("branch", "existing-topic");
    f.handle.send.mockImplementationOnce(async () => { await exec("git", ["-C", worktree, "checkout", "existing-topic"]); });
    expect(await f.runner.run(t, f.progress)).toMatchObject({ ok: true, worktree: { changed: false, branch: "existing-topic" } });
    expect((await git("branch", "--list", "existing-topic")).stdout.trim()).not.toBe("");
  });
  it("preserves a pre-existing branch when a create-name collision fails", async () => {
    const { f, t, git } = await gitFixture(); await git("branch", branchName(t));
    expect(await f.runner.run(t, f.progress)).toMatchObject({ ok: false });
    expect((await git("branch", "--list", branchName(t))).stdout.trim()).not.toBe(""); expect(f.api.agents.create).not.toHaveBeenCalled();
  });
  it("keeps an unremoved directory visible even when workspace archive reports success", async () => {
    const { f, t, git } = await gitFixture(); f.api.workspaces.archive.mockResolvedValue({ archivedAt: "now", error: null });
    expect(await f.runner.run(t, f.progress)).toMatchObject({ ok: true, worktree: { changed: null } });
    expect((await git("branch", "--list", branchName(t))).stdout.trim()).not.toBe("");
  });
  it("reports a failed worktree removal and preserves the branch", async () => {
    const { f, t, git } = await gitFixture();
    f.api.workspaces.archive.mockResolvedValue({ archivedAt: null, error: "teardown failed" } as any);
    expect(await f.runner.run(t, f.progress)).toMatchObject({ ok: true, worktree: { changed: null } });
    expect((await git("branch", "--list", branchName(t))).stdout.trim()).not.toBe("");
  });
});
