import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LABEL_CALL, LABEL_RUN } from "../shared/ids";
import type { AgentCall } from "../shared/run-types";
import type { PaseoApi } from "./gate";
import { recoverChildren } from "./recovery";
import { emptyUsage, type RunRecord } from "./run-store";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const BASE_LABEL = "paseo-dynamic-workflow/base";
const at = "2026-10-22T00:00:00Z";

function call(agentId: string | null = null): AgentCall {
  return {
    callId: "a1", label: "Recovered child", phase: null, status: "skipped", agentId,
    provider: "claude", model: "test", queuedAt: at, startedAt: at, endedAt: at,
    resultPreview: null, error: "run interrupted", usage: emptyUsage(), worktree: null, repairs: 0,
  };
}

function record(cwd = "/tmp/parent", calls = [call()]): RunRecord {
  return {
    version: 1, runId: "wf_0123456789ab", meta: { name: "recovery", description: "Recovery fixture" },
    status: "interrupted", parentAgentId: "parent", workspaceId: "parent-workspace", cwd,
    scriptPath: join(cwd, "script.js"), source: "script", resumedFrom: null, startedAt: at, endedAt: at,
    error: "plugin stopped", phaseOrder: [], calls, logs: [], resultPreview: null, usage: emptyUsage(), budgetTotal: null, notified: false,
  };
}

interface Child {
  id: string;
  cwd: string;
  workspaceId: string;
  archivedAt: string | null;
  labels: Record<string, string>;
}

function child(overrides: Partial<Child> = {}): Child {
  return {
    id: "lost-child", cwd: "/tmp/child", workspaceId: "child-workspace", archivedAt: null,
    labels: { [LABEL_RUN]: "wf_0123456789ab", [LABEL_CALL]: "a1" }, ...overrides,
  };
}

function api(children: Child[]) {
  const handles = new Map(children.map((agent) => [agent.id, {
    refresh: vi.fn(async () => ({ agent })),
    archive: vi.fn(async () => { agent.archivedAt = at; return { archivedAt: at }; }),
  }]));
  const archiveWorkspace = vi.fn(async (_id: string) => ({ archivedAt: at as string | null, error: null as string | null }));
  const list = vi.fn(async (_input: unknown): Promise<{ entries: Array<{ agent: Child }>; pageInfo: { hasMore: boolean; nextCursor: string | null } }> => ({
    entries: children.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null },
  }));
  const paseo = { agents: { list, ref: (id: string) => handles.get(id)! }, workspaces: { archive: archiveWorkspace } } as unknown as PaseoApi;
  return { paseo, handles, list, archiveWorkspace };
}

it("recovers a label-owned child even when its create response was never persisted", async () => {
  const run = record();
  const owned = child();
  const unrelated = child({ id: "unrelated", labels: { [LABEL_RUN]: "wf_other", [LABEL_CALL]: "a1" } });
  // A stale persisted id and a broad list response must not archive an unrelated agent.
  run.calls.push({ ...call(unrelated.id), callId: "a2" });
  const f = api([owned, unrelated]);
  await recoverChildren(f.paseo, run);
  expect(run.calls[0].agentId).toBe(owned.id);
  expect(f.handles.get(owned.id)!.archive).toHaveBeenCalledOnce();
  expect(f.handles.get(unrelated.id)!.archive).not.toHaveBeenCalled();
  expect(f.archiveWorkspace).not.toHaveBeenCalled();
});

it("discovers lost children on later pages of the daemon's ownership listing", async () => {
  const run = record();
  const owned = child();
  const f = api([owned]);
  f.list.mockResolvedValueOnce({ entries: [], pageInfo: { hasMore: true, nextCursor: "next-page" } });
  await recoverChildren(f.paseo, run);
  expect(run.calls[0].agentId).toBe(owned.id);
  expect(f.handles.get(owned.id)!.archive).toHaveBeenCalledOnce();
  expect(f.list).toHaveBeenCalledTimes(2);
});

it.each(["workspace", "directory"])("never archives the launching agent's %s", async (same) => {
  const run = record();
  const owned = child({
    workspaceId: same === "workspace" ? run.workspaceId! : "child-workspace",
    cwd: same === "directory" ? run.cwd : "/tmp/child",
    labels: { [LABEL_RUN]: run.runId, [LABEL_CALL]: "a1", [BASE_LABEL]: "f".repeat(40) },
  });
  const f = api([owned]);
  await recoverChildren(f.paseo, run);
  expect(f.handles.get(owned.id)!.archive).toHaveBeenCalledOnce();
  expect(f.archiveWorkspace).not.toHaveBeenCalled();
});

describe("recovered worktree safety", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "dwf-recovery-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const repo = join(root, "repo");
    const worktree = join(root, "child");
    await mkdir(repo);
    const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args])).stdout.trim();
    await git(repo, "init");
    await git(repo, "config", "user.name", "Workflow recovery fixture");
    await git(repo, "config", "user.email", "workflow-recovery@example.invalid");
    await writeFile(join(repo, "file.txt"), "base\n");
    await git(repo, "add", "file.txt");
    await git(repo, "commit", "-m", "base");
    const base = await git(repo, "rev-parse", "HEAD");
    await git(repo, "worktree", "add", "-b", "recovered-child", worktree);
    const run = record(repo);
    const owned = child({ cwd: worktree, labels: { [LABEL_RUN]: run.runId, [LABEL_CALL]: "a1", [BASE_LABEL]: base } });
    const f = api([owned]);
    f.archiveWorkspace.mockImplementation(async (id) => {
      if (id !== owned.workspaceId) throw new Error("Attempted to remove the parent workspace");
      await git(repo, "worktree", "remove", worktree);
      return { archivedAt: at, error: null };
    });
    return { ...f, run, repo, worktree, git, owned };
  }

  it("removes only an unchanged child worktree after recovering its agent", async () => {
    const f = await fixture();
    await recoverChildren(f.paseo, f.run);
    expect(f.archiveWorkspace).toHaveBeenCalledWith("child-workspace");
    expect(f.run.calls[0].worktree).toEqual({ path: f.worktree, branch: "recovered-child", workspaceId: "child-workspace", changed: false });
    await expect(access(f.worktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.repo, "file.txt"), "utf8")).toBe("base\n");
  });

  it.each(["dirty", "committed"])("keeps %s child worktrees and records their branch", async (kind) => {
    const f = await fixture();
    await writeFile(join(f.worktree, "file.txt"), "child change\n");
    if (kind === "committed") {
      await f.git(f.worktree, "add", "file.txt");
      await f.git(f.worktree, "commit", "-m", "child change");
      expect(await f.git(f.worktree, "status", "--porcelain")).toBe("");
    }
    await recoverChildren(f.paseo, f.run);
    expect(f.archiveWorkspace).not.toHaveBeenCalled();
    expect(f.run.calls[0].worktree).toMatchObject({ path: f.worktree, branch: "recovered-child", changed: true });
    expect(await readFile(join(f.worktree, "file.txt"), "utf8")).toBe("child change\n");
    expect(await readFile(join(f.repo, "file.txt"), "utf8")).toBe("base\n");
  });

  it("does not claim removal when archive reports success but the directory remains", async () => {
    const f = await fixture();
    f.archiveWorkspace.mockResolvedValue({ archivedAt: at, error: null });
    await recoverChildren(f.paseo, f.run);
    expect(f.run.calls[0].worktree).toMatchObject({ path: f.worktree, changed: null });
    expect(await readFile(join(f.worktree, "file.txt"), "utf8")).toBe("base\n");
  });

  it("keeps a failed workspace teardown visible instead of reporting it removed", async () => {
    const f = await fixture();
    f.archiveWorkspace.mockResolvedValue({ archivedAt: null, error: "teardown failed" });
    await recoverChildren(f.paseo, f.run);
    expect(f.run.calls[0].worktree).toMatchObject({ path: f.worktree, changed: null });
    expect(await readFile(join(f.worktree, "file.txt"), "utf8")).toBe("base\n");
  });
});
