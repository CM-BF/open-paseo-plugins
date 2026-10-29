import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PaseoApi } from "@getpaseo/client";
import { afterEach, expect, it, vi } from "vitest";
import { watchSchema } from "../shared/contracts";
import { Store } from "../server/store";
import { TaskManager } from "../server/tasks";
import { ReviewCoordinator } from "../server/reviews";
import { Monitor } from "../server/monitor";
import { GitHubClient } from "../server/github";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "upstream-review-"));
  roots.push(root);
  const store = new Store(join(root, "state.json")),
    tasks = new TaskManager(join(root, "tasks.json"));
  const watch = watchSchema.parse({
    id: randomUUID(),
    name: "Review fixture",
    targetPath: root,
    repository: "example/tool",
    ref: "main",
    baseline: "a".repeat(40),
    createdAt: "2026-10-29",
    updatedAt: "2026-10-29",
    workspaceId: "wks_1234567890abcdef",
    provider: "codex/model",
    review: {
      mode: "recommend-only",
      autoReview: true,
      features: [
        {
          id: "core",
          title: "Core",
          upstreamPaths: ["src"],
          adoption: "missing",
        },
      ],
    },
    observation: {
      head: "a".repeat(40),
      ref: "main",
      url: "",
      title: "",
      date: "",
      compareUrl: "",
      comparison: "identical",
      commits: [],
      commitsTotal: 0,
      files: [],
      filesTruncated: false,
      matchedPaths: [],
      hasUpdate: false,
      needsReview: false,
    },
  });
  await store.change((state) => {
    state.watches.push(watch);
  });
  const executor = vi.fn(async () => ({ agentId: randomUUID() }));
  const refreshWorkspace = vi.fn(async () => ({ workspaceDirectory: root }));
  const previous = {
    refresh: vi.fn(async () => ({})),
    activeTurn: null as unknown,
    status: "idle",
    pendingPermissions: [] as unknown[],
  };
  const api = {
    workspaces: { ref: () => ({ refresh: refreshWorkspace, directory: root }) },
    agents: { ref: () => previous },
  } as unknown as PaseoApi;
  const paseo = vi.fn(async () => api);
  const revision = vi.fn(async () => "c".repeat(40));
  let disposed = false;
  const coordinator = new ReviewCoordinator({
    store,
    tasks,
    paseo,
    executor: () => executor,
    disposed: () => disposed,
    revision,
  });
  const check = async () => {
    await coordinator.check((await store.read()).watches[0]);
    await tasks.waitForIdle();
  };
  return {
    api,
    root,
    store,
    tasks,
    watch,
    check,
    coordinator,
    executor,
    paseo,
    revision,
    previous,
    refreshWorkspace,
    dispose: () => {
      disposed = true;
    },
  };
}
it("runs an opted-in no-diff backlog once and keeps the key across a restart", async () => {
  const f = await fixture();
  await f.check();
  await f.check();
  expect(f.executor).toHaveBeenCalledTimes(1);
  const task = (await f.tasks.list())[0];
  expect(task.intent).toBe("review");
  expect(task.prompt).toContain("不得修改代码");
  expect(task.localRevision).toBe("c".repeat(40));
  const resumedTasks = new TaskManager(join(f.root, "tasks.json"));
  const resumed = new ReviewCoordinator({
    store: new Store(join(f.root, "state.json")),
    tasks: resumedTasks,
    paseo: f.paseo,
    executor: () => f.executor,
    disposed: () => false,
    revision: f.revision,
  });
  await resumed.check((await f.store.read()).watches[0]);
  expect(f.executor).toHaveBeenCalledTimes(1);
  expect((await f.store.read()).watches[0].baseline).toBe("a".repeat(40));
});
it.each(["head", "inventory", "local", "model"])(
  "creates one new review when %s changes",
  async (kind) => {
    const f = await fixture();
    await f.check();
    if (kind === "local") f.revision.mockResolvedValue("d".repeat(40));
    else
      await f.store.change((state) => {
        if (kind === "head")
          state.watches[0].observation!.head = "b".repeat(40);
        else if (kind === "model") state.watches[0].provider = "codex/other";
        else
          state.watches[0].review!.features[0].notes =
            "New acceptance evidence";
      });
    await f.check();
    await f.check();
    const tasks = await f.tasks.list();
    expect(tasks).toHaveLength(2);
    expect(tasks[0].reviewKey).not.toBe(tasks[1].reviewKey);
    expect(f.executor).toHaveBeenCalledTimes(2);
  },
);

it("reuses the periodic monitor callback to persist and launch a review without an open UI", async () => {
  const f = await fixture();
  const github = new GitHubClient({
    transport: async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        sha: "a".repeat(40),
        html_url: "https://github.com/example/tool/commit/" + "a".repeat(40),
        commit: {
          message: "Same baseline",
          committer: { date: new Date().toISOString() },
        },
      }),
    }),
  });
  const monitor = new Monitor(f.store, github, {
    afterCheck: (watch) => f.coordinator.check(watch),
  });
  try {
    monitor.schedule();
    await vi.waitFor(async () => expect((await f.tasks.list()).length).toBe(1));
    await monitor.waitForIdle();
    await f.tasks.waitForIdle();
    expect((await f.store.read()).watches[0].checkedAt).toBeDefined();
    expect((await f.store.read()).watches[0].observation?.hasUpdate).toBe(
      false,
    );
    expect(f.executor).toHaveBeenCalledTimes(1);
  } finally {
    monitor.dispose();
    await monitor.waitForIdle();
  }
});
it.each(["opt-out", "paused", "missing-config"])(
  "does not create model work for %s",
  async (kind) => {
    const f = await fixture();
    await f.store.change((state) => {
      if (kind === "opt-out") state.watches[0].review!.autoReview = false;
      if (kind === "paused") state.settings.enabled = false;
      if (kind === "missing-config") delete state.watches[0].workspaceId;
    });
    await f.check();
    expect(f.paseo).not.toHaveBeenCalled();
    expect(f.executor).not.toHaveBeenCalled();
    if (kind === "missing-config")
      expect((await f.store.read()).watches[0].reviewState?.error).toContain(
        "工作区",
      );
  },
);
it("does not retry an uncertain request, even after the inventory changes", async () => {
  const f = await fixture();
  f.executor.mockRejectedValue(new Error("lost after send"));
  await f.check();
  await f.check();
  await f.store.change((state) => {
    state.watches[0].review!.features[0].notes = "updated";
  });
  await f.check();
  expect(f.executor).toHaveBeenCalledTimes(1);
  expect(await f.tasks.list()).toHaveLength(1);
  expect((await f.store.read()).watches[0].reviewState?.error).toContain(
    "待确认",
  );
});
it("defers a new scope while the previous review is running or awaiting permission", async () => {
  const f = await fixture();
  await f.check();
  f.revision.mockResolvedValue("d".repeat(40));
  f.previous.status = "running";
  await f.check();
  expect(f.executor).toHaveBeenCalledTimes(1);
  f.previous.status = "idle";
  f.previous.pendingPermissions = [{}];
  await f.check();
  expect(f.executor).toHaveBeenCalledTimes(1);
  f.previous.pendingPermissions = [];
  await f.check();
  expect(f.executor).toHaveBeenCalledTimes(2);
});
it("checks every older review instead of assuming the latest task owns all running work", async () => {
  const f = await fixture();
  await f.check();
  const first = (await f.tasks.list())[0];
  f.revision.mockResolvedValue("d".repeat(40));
  await f.check();
  f.api.agents.ref = ((id: string) => ({ ...f.previous, status: id === first.agentId ? "running" : "idle" })) as unknown as typeof f.api.agents.ref;
  f.revision.mockResolvedValue("e".repeat(40));
  await f.check();
  expect(f.executor).toHaveBeenCalledTimes(2);
  expect((await f.store.read()).watches[0].reviewState?.error).toContain("仍在运行");
});
it.each(["pause", "edit", "delete", "dispose"])(
  "rejects %s racing native workspace preflight",
  async (kind) => {
    const f = await fixture();
    f.refreshWorkspace.mockImplementationOnce(async () => {
      if (kind === "dispose") f.dispose();
      else
        await f.store.change((state) => {
          if (kind === "pause") state.settings.enabled = false;
          if (kind === "edit")
            state.watches[0].review!.features[0].notes = "changed";
          if (kind === "delete") state.watches = [];
        });
      return { workspaceDirectory: f.root };
    });
    await f.coordinator.check(f.watch);
    await f.tasks.waitForIdle();
    expect(f.executor).not.toHaveBeenCalled();
    expect(await f.tasks.list()).toEqual([]);
  },
);
it("preserves the successful source observation when the local revision cannot be read", async () => {
  const f = await fixture();
  f.revision.mockRejectedValue(new Error("No local revision"));
  await f.check();
  const current = (await f.store.read()).watches[0];
  expect(current.observation).toEqual(f.watch.observation);
  expect(current.error).toBeUndefined();
  expect(current.reviewState?.error).toBe("No local revision");
  expect(f.paseo).not.toHaveBeenCalled();
});
