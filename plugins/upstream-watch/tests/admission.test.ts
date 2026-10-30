import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { watchSchema } from "../shared/contracts";
import { Store } from "../server/store";
import { TaskManager } from "../server/tasks";
import { admitLaunch } from "../server/admission";
import { environment, validateTarget } from "../server/workspaces";
import type { PaseoApi } from "@getpaseo/client";
import { cindyDraft } from "../shared/cindy";
import { reviewKey } from "../server/review-context";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "upstream-admission-"));
  roots.push(root);
  const store = new Store(join(root, "state.json"));
  const tasks = new TaskManager(join(root, "tasks.json"));
  const watch = watchSchema.parse({
    id: randomUUID(),
    name: "Fixture",
    targetPath: root,
    repository: "example/tool",
    baseline: "a".repeat(40),
    createdAt: "2026-10-24",
    updatedAt: "2026-10-24",
    observation: {
      head: "b".repeat(40),
      ref: "main",
      url: "https://github.com/example/tool/commit/head",
      title: "Fix",
      date: "2026-10-24",
      compareUrl: "https://github.com/example/tool/compare/base...head",
      comparison: "ahead",
      commits: [],
      commitsTotal: 1,
      files: [],
      filesTruncated: false,
      matchedPaths: [],
      hasUpdate: true,
      needsReview: false,
    },
  });
  await store.change((state) => {
    state.watches.push(watch);
  });
  return {
    root,
    store,
    tasks,
    watch,
    input: {
      head: watch.observation!.head,
      workspaceId: "wks_1234567890abcdef",
      provider: "claude/test",
    },
  };
}

it.each(["delete", "acknowledge", "retarget", "error"])(
  "rejects %s during workspace preflight without creating a task",
  async (kind) => {
    const { store, tasks, watch, input } = await setup();
    await store.change((state) => {
      if (kind === "delete") state.watches = [];
      if (kind === "acknowledge") state.watches[0].baseline = input.head;
      if (kind === "retarget") state.watches[0].targetPath = "/another/project";
      if (kind === "error") state.watches[0].error = "Last check failed";
    });
    const executor = vi.fn();
    await expect(
      admitLaunch(store, tasks, watch, input, executor),
    ).rejects.toThrow("已改变");
    expect(executor).not.toHaveBeenCalled();
    expect(await tasks.list()).toEqual([]);
  },
);

it("persists a task while preserving the adopted baseline and saving selected defaults", async () => {
  const { store, tasks, watch, input } = await setup();
  const task = await admitLaunch(store, tasks, watch, input, async () => ({
    agentId: randomUUID(),
  }));
  await vi.waitFor(async () =>
    expect((await tasks.list())[0].status).toBe("created"),
  );
  expect(task.head).toBe(input.head);
  expect((await store.read()).watches[0]).toMatchObject({
    baseline: "a".repeat(40),
    workspaceId: input.workspaceId,
    provider: input.provider,
    observation: { hasUpdate: true },
  });
});

it("rejects changed review scope during preflight, but admits a current review without a diff", async () => {
  const { store, tasks, watch, input } = await setup();
  watch.review = cindyDraft().review;
  watch.observation!.hasUpdate = false;
  await store.change((state) => {
    state.watches[0] = structuredClone(watch);
  });
  const stale = structuredClone(watch);
  delete stale.review;
  const executor = vi.fn(async () => ({ agentId: randomUUID() }));
  await expect(
    admitLaunch(store, tasks, stale, input, executor),
  ).rejects.toThrow("已改变");
  expect(executor).not.toHaveBeenCalled();
  const review = await admitLaunch(store, tasks, watch, input, executor);
  expect(review.intent).toBe("review");
  const selected = (await store.read()).watches[0];
  expect(selected.reviewState?.key).toBe(reviewKey(selected));
  await vi.waitFor(async () =>
    expect((await tasks.list())[0].status).toBe("created"),
  );
  expect((await store.read()).watches[0].baseline).toBe(watch.baseline);
});

it("accepts a synthetic workspace repository mount and rejects unrelated targets", async () => {
  const { root } = await setup();
  const workspace = join(root, "workspace"),
    checkout = join(root, "checkout"),
    plugin = join(checkout, "plugins", "mine");
  await Promise.all([mkdir(workspace), mkdir(plugin, { recursive: true })]);
  await symlink(checkout, join(workspace, "repo"));
  await expect(validateTarget(plugin, workspace)).resolves.toBeUndefined();
  await expect(
    validateTarget(join(workspace, "repo", "plugins", "mine"), workspace),
  ).resolves.toBeUndefined();
  await expect(validateTarget(root, workspace)).rejects.toThrow("包含");
  const nested = join(workspace, "dependencies");
  const unmounted = join(root, "unmounted");
  await mkdir(nested);
  await mkdir(join(unmounted, "plugins", "mine"), { recursive: true });
  await symlink(unmounted, join(nested, "outside"));
  await expect(
    validateTarget(join(nested, "outside", "plugins", "mine"), workspace),
  ).rejects.toThrow("包含");
});

it("lists all workspace pages and available providers without creating resources", async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce({
      entries: [{ id: "wks_a", name: "A", workspaceDirectory: "/a" }],
      pageInfo: { hasMore: true, nextCursor: "next" },
    })
    .mockResolvedValueOnce({
      entries: [{ id: "wks_b", name: "B", projectRootPath: "/b" }],
      pageInfo: { hasMore: false },
    });
  const paseo = {
    workspaces: { list },
    projects: { list: async () => ({ projects: [] }) },
    providers: {
      listAvailable: async () => ({
        providers: [
          { provider: "claude", available: true },
          { provider: "missing", available: false },
        ],
      }),
    },
  } as unknown as PaseoApi;
  expect(await environment(paseo)).toEqual({
    workspaces: [
      { id: "wks_a", name: "A", directory: "/a" },
      { id: "wks_b", name: "B", directory: "/b" },
    ],
    projects: [],
    providers: [{ id: "claude", label: "claude" }],
  });
  expect(list.mock.calls[1][0].page.cursor).toBe("next");
});
