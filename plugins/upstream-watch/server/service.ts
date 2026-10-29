import type {
  PluginHandlerContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import {
  overviewRpc,
  saveRpc,
  removeRpc,
  checkRpc,
  acknowledgeRpc,
  settingsRpc,
  launchRpc,
  retryTaskRpc,
  environmentRpc,
  modelsRpc,
  discoveryRpc,
} from "../shared/contracts";
import { Store } from "./store";
import { GitHubClient } from "./github";
import { Monitor } from "./monitor";
import { TaskManager, TaskCreationError } from "./tasks";
import { discoverSources } from "./discovery";
import { environment, validateTarget } from "./workspaces";
import { admitLaunch } from "./admission";
import { featureReview } from "../shared/feature-review";
import { LocalPaseo } from "./local-paseo";
import { localRevision, verifyLocalRevision } from "./review-context";
import { ReviewCoordinator } from "./reviews";
import { ReviewSourceCache } from './review-source';
import { prepareReviewPrompt } from './review-preparation';
import type { TaskExecution } from './tasks';
type PaseoApi = PluginHandlerContext["paseo"];

export function contributeServer(server: PluginServerContext) {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const folder = join(home, "upstream-watch");
  const store = new Store(join(folder, "state.json"));
  const github = new GitHubClient();
  const localPaseo = new LocalPaseo(home);
  const tasks = new TaskManager(join(folder, "tasks.json"));
  const sources = new ReviewSourceCache(join(folder, 'sources'));
  const ready = Promise.all([store.ready, tasks.ready]);
  let disposed = false;
  const reviews = new ReviewCoordinator({
    store,
    tasks,
    paseo: () => localPaseo.get(),
    executor,
    disposed: () => disposed,
  });
  const monitor = new Monitor(store, github, {
    afterCheck: (watch) => reviews.check(watch),
  });
  void ready
    .then(() => {
      if (!disposed) monitor.schedule();
    })
    .catch((error) =>
      console.error("Upstream watch initialization failed", String(error)),
    );

  function executor(paseo: PaseoApi) {
    return async (task: TaskExecution) => {
      if (disposed) throw new Error("插件已停止，任务创建结果待确认");
      const workspace = paseo.workspaces.ref(task.workspaceId);
      const current = await workspace.refresh();
      if (!current)
        throw new Error("目标工作区不可用，请确认任务是否已创建后再重试");
      await validateTarget(
        task.targetPath,
        workspace.directory ||
          current.workspaceDirectory ||
          current.projectRootPath,
      );
      if (disposed) throw new Error("插件已停止，任务创建结果待确认");
      let prompt = task.prompt;
      if (task.intent === 'review') {
        try {
          prompt = await prepareReviewPrompt(task, { prepare: (source, head) => sources.prepare(source, head),
            state: () => store.read(), disposed: () => disposed,
            placement: async () => {
              const refreshed = await workspace.refresh();
              if (!refreshed) throw new Error('建议的目标工作区已不存在。');
              await validateTarget(task.targetPath, workspace.directory || refreshed.workspaceDirectory || refreshed.projectRootPath);
              await verifyLocalRevision(task.targetPath, task.localRevision!);
            } });
        } catch (error) {
          throw new TaskCreationError(error instanceof Error ? error.message : '固定源码准备失败', { definitive: true });
        }
      }
      if (disposed) throw new TaskCreationError('插件已停止，尚未创建建议 agent。', { definitive: true });
      const agent = await workspace.agents.create({
        config: {
          provider: task.provider,
          ...(task.intent === "review" && task.provider === "codex/gpt-6-luna"
            ? { thinkingOptionId: "low" }
            : {}),
          ...(task.intent === "review" &&
          task.provider.split("/")[0] === "codex"
            ? {
                providerOptions: {
                  sandbox_mode: "read-only",
                  approval_policy: "on-request",
                },
              }
            : {}),
        },
        title: task.title,
        prompt,
        idempotencyKey: task.idempotencyKey,
        labels: {
          "upstream-watch.task": task.id,
          "upstream-watch.head": task.head,
          "upstream-watch.intent": task.intent,
        },
      });
      return { agentId: agent.id };
    };
  }

  server.handle(overviewRpc, async () => {
    await ready;
    const state = await store.read();
    return {
      ...state,
      checking: monitor.checking,
      authentication: github.authentication,
      tasks: await tasks.list(),
      reviews: state.watches.flatMap((watch) => {
        const review = featureReview(watch);
        return review ? [review] : [];
      }),
    };
  });
  server.handle(saveRpc, async (input) => {
    await ready;
    if (
      !isAbsolute(input.targetPath) ||
      !(await stat(input.targetPath)).isDirectory()
    )
      throw new Error("请填写实际存在的插件开发目录（绝对路径）");
    const watch = await monitor.save(input);
    monitor.check(watch.id);
    return watch;
  });
  server.handle(removeRpc, async ({ id }) => {
    await ready;
    await monitor.remove(id);
    return { ok: true };
  });
  server.handle(checkRpc, async ({ id }) => {
    await ready;
    return { started: monitor.check(id) };
  });
  server.handle(acknowledgeRpc, async ({ id, head }) => {
    await ready;
    return monitor.acknowledge(id, head);
  });
  server.handle(settingsRpc, async (settings) => {
    await ready;
    await store.change((state) => {
      state.settings = settings;
    });
    monitor.schedule();
    return settings;
  });
  server.handle(discoveryRpc, async ({ root }) =>
    discoverSources({ home, developmentRoot: root }),
  );
  server.handle(environmentRpc, async (_, { paseo }) => environment(paseo));
  server.handle(modelsRpc, async ({ provider, cwd }, { paseo }) => {
    const result = await paseo.providers.listModels(provider, { cwd });
    if (result.error) throw new Error(result.error);
    return (result.models || [])
      .filter((model) => model.isSelectable !== false)
      .map((model) => ({
        id: model.id.startsWith(`${provider}/`)
          ? model.id
          : `${provider}/${model.id}`,
        label: model.label,
      }));
  });
  server.handle(launchRpc, async (input, { paseo }) => {
    await ready;
    const watch = (await store.read()).watches.find(
      (item) => item.id === input.watchId,
    );
    if (!watch) throw new Error("跟踪项已不存在");
    const workspace = paseo.workspaces.ref(input.workspaceId);
    const current = await workspace.refresh();
    if (!current) throw new Error("目标工作区已不存在");
    await validateTarget(
      watch.targetPath,
      workspace.directory ||
        current.workspaceDirectory ||
        current.projectRootPath,
    );
    const revision = watch.review
      ? await localRevision(watch.targetPath)
      : undefined;
    return admitLaunch(
      store,
      tasks,
      watch,
      { ...input, localRevision: revision },
      executor(paseo),
    );
  });
  server.handle(retryTaskRpc, async ({ taskId }, { paseo }) => {
    await ready;
    return tasks.retry(taskId, executor(paseo));
  });

  return async () => {
    disposed = true;
    monitor.dispose();
    await sources.close();
    await monitor.waitForIdle();
    await tasks.waitForIdle();
    await localPaseo.dispose();
  };
}
