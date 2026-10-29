import type { Watch } from "../shared/contracts";
import { configurationKey } from "./validation";
import type { Store } from "./store";
import type { TaskExecutor, TaskManager } from "./tasks";

export async function admitLaunch(
  store: Store,
  tasks: TaskManager,
  expected: Watch,
  input: { head: string; workspaceId: string; provider: string },
  executor: TaskExecutor,
) {
  return store.change(async (state) => {
    const watch = state.watches.find((item) => item.id === expected.id);
    if (
      !watch ||
      configurationKey(watch) !== configurationKey(expected) ||
      watch.error ||
      watch.observation?.head !== input.head ||
      !watch.observation.hasUpdate
    ) {
      throw new Error("关联或检查结果已改变，请刷新后再创建更新任务");
    }
    const task = await tasks.launch(watch, input, executor);
    watch.workspaceId = input.workspaceId;
    watch.provider = input.provider;
    return task;
  });
}
