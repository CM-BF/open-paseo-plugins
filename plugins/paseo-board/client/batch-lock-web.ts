export interface BatchLockManager {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
}

function browserLocks(): BatchLockManager | undefined {
  const runtime = globalThis as unknown as { navigator?: { locks?: BatchLockManager }; window?: { navigator?: { locks?: BatchLockManager } } };
  return runtime.navigator?.locks ?? runtime.window?.navigator?.locks;
}

/** Only the synchronous read/freeze/persist preparation runs under this browser-wide lock. */
export async function withBatchPreparationLock<T>(scope: { hostId: string; boardId: string }, prepare: () => T, manager: BatchLockManager | undefined = browserLocks()): Promise<T> {
  if (!manager) throw new Error("此浏览器暂不支持统一发送，可逐条发送。");
  let entered = false;
  try {
    return await manager.request("paseo-board-comment-batch:" + JSON.stringify([scope.hostId, scope.boardId]), () => { entered = true; return prepare(); });
  } catch (error) {
    if (entered) throw error;
    throw new Error("暂时无法准备统一发送；评论已保留，请稍后重试。");
  }
}
