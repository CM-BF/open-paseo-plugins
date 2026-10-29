import type { PaseoApi } from "@getpaseo/client";
import type { Watch } from "../shared/contracts";
import { admitLaunch } from "./admission";
import { localRevision, reviewKey } from "./review-context";
import type { Store } from "./store";
import type { TaskExecutor, TaskManager } from "./tasks";
import { configurationKey } from "./validation";
import { validateTarget } from "./workspaces";

export class ReviewCoordinator {
  constructor(
    private readonly options: {
      store: Store;
      tasks: TaskManager;
      paseo(): Promise<PaseoApi>;
      executor(paseo: PaseoApi): TaskExecutor;
      disposed(): boolean;
      revision?: (targetPath: string) => Promise<string>;
    },
  ) {}

  async check(expected: Watch): Promise<void> {
    const { store, tasks, disposed } = this.options;
    if (!expected.review || disposed()) return;
    const checkedAt = new Date().toISOString();
    try {
      const revision = await (this.options.revision || localRevision)(
        expected.targetPath,
      );
      if (disposed()) return;
      const key = reviewKey(expected, revision);
      const current = await store.change((state) => {
        const watch = state.watches.find((item) => item.id === expected.id);
        if (
          !watch ||
          !watch.enabled ||
          watch.error ||
          configurationKey(watch) !== configurationKey(expected) ||
          watch.observation?.head !== expected.observation?.head
        )
          return;
        watch.reviewState = { key, localRevision: revision, checkedAt };
        return state.settings.enabled && watch.review?.autoReview
          ? watch
          : undefined;
      });
      if (!current || disposed()) return;
      const previousTasks = (await tasks.list()).filter(
        (task) => task.watchId === current.id && task.intent === "review",
      );
      if (previousTasks.some((task) => task.reviewKey === key)) return;
      if (
        previousTasks.some(
          (task) => task.status === "preparing" || task.status === "uncertain",
        )
      )
        throw new Error("已有建议任务正在创建或结果待确认，不能自动重复创建。");
      if (!current.workspaceId || !current.provider)
        throw new Error("自动建议需要先选择工作区与模型。");
      const paseo = await this.options.paseo();
      if (disposed()) return;
      const workspace = paseo.workspaces.ref(current.workspaceId);
      const placement = await workspace.refresh();
      if (!placement) throw new Error("自动建议的工作区已不存在。");
      await validateTarget(
        current.targetPath,
        workspace.directory ||
          placement.workspaceDirectory ||
          placement.projectRootPath,
      );
      if (disposed()) return;
      for (const previous of previousTasks) {
        if (!previous.agentId) continue;
        const agent = paseo.agents.ref(previous.agentId);
        await agent.refresh();
        if (
          agent.activeTurn ||
          agent.status === "running" ||
          agent.status === "initializing" ||
          agent.pendingPermissions?.length
        )
          throw new Error("上一份建议仍在运行或等待权限；本轮不启动并行审查。");
      }
      await admitLaunch(
        store,
        tasks,
        current,
        {
          head: current.observation!.head,
          workspaceId: current.workspaceId,
          provider: current.provider,
          localRevision: revision,
          automatic: true,
        },
        this.options.executor(paseo),
      );
    } catch (error) {
      if (disposed()) return;
      await store.change((state) => {
        const watch = state.watches.find((item) => item.id === expected.id);
        if (
          !watch ||
          configurationKey(watch) !== configurationKey(expected) ||
          watch.observation?.head !== expected.observation?.head
        )
          return;
        watch.reviewState = {
          ...watch.reviewState,
          checkedAt,
          error:
            error instanceof Error
              ? error.message.slice(0, 1200)
              : "建议准备失败",
        };
      });
    }
  }
}
