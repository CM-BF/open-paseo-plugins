import { BridgeError, invoke } from './bridge';
import { executionMessage } from '../shared/execution-notice';
import type { GroupReactors } from '../shared/group-history';

export function historyError(reason: unknown, language = 'en') {
  const zh = language.startsWith('zh');
  const code = reason instanceof BridgeError ? reason.code : (reason as { code?: string })?.code;
  if (code && ['HOST_UPGRADE_REQUIRED', 'PROVIDER_ADMISSION_UNAVAILABLE', 'PROVIDER_QUEUE_UNAVAILABLE', 'GROUP_LANE_BUSY', 'ADMISSION_OUTCOME_UNKNOWN', 'QUEUE_ITEM_REMOVED', 'GROUP_STOP_REQUIRES_NATIVE', 'STOP_NOT_CONFIRMED'].includes(code))
    return executionMessage(code, language);
  if (['UNSUPPORTED', 'UNKNOWN_OPERATION', 'NOT_IMPLEMENTED', 'INVALID_OPERATION'].includes(code ?? ''))
    return zh ? '此主机尚未连接群历史与话题服务，操作未完成。' : 'Group history and topics are not connected on this host. The operation was not completed.';
  if (code === 'HISTORY_WINDOW_TOO_LARGE') return zh ? '这条消息或附属信息超出读取上限，历史尚未载入，已读位置未推进。' : 'A message or its associated information exceeds the read limit. History was not loaded and the read position was not advanced.';
  if (code === 'QUOTE_UNAVAILABLE') return zh ? '原消息已无法引用。请移除引用后重新编辑。' : 'The original message can no longer be quoted. Remove the quote and edit your message.';
  if (code === 'SHARE_UNAVAILABLE') return zh ? '这条话题回复已无法分享到群聊。' : 'This topic reply is no longer available to share.';
  return reason instanceof Error ? reason.message : String(reason);
}

/** Original reaction roster result envelope; a failed read stays failed, never a fake empty list. */
export async function historyReactors(args: { groupId: string; messageId: string; emoji: string }) {
  try { return { ok: true as const, ...await invoke<GroupReactors>('groups.history.reactors', args) }; }
  catch (reason) { return { ok: false as const, errorCode: reason instanceof BridgeError ? reason.code : 'READ_FAILED' }; }
}

/** A lost mutation ACK retains its immutable intent even if polls advance history revisions. */
export function createHistoryIntents(request: typeof invoke = invoke) {
  const intents = new Map<string, { signature: string; args: Record<string, unknown> }>();
  const running = new Map<string, Promise<unknown>>();
  let disposed = false;
  return {
    run<T>(key: string, op: string, args: Record<string, unknown>): Promise<T> {
      if (disposed) return Promise.reject(new Error('This conversation was closed.'));
      const signature = JSON.stringify({ op, args });
      const active = running.get(key);
      if (active) {
        if (intents.get(key)?.signature !== signature) return Promise.reject(new Error('Wait for the current operation to finish.'));
        return active as Promise<T>;
      }
      let intent = intents.get(key);
      if (intent?.signature !== signature) {
        intent = { signature, args: { ...args, operationId: crypto.randomUUID() } };
        intents.set(key, intent);
      }
      const selected = intent;
      const promise = request<T>(op, selected.args).then(result => {
        if (intents.get(key) === selected) intents.delete(key);
        return result;
      }).finally(() => { if (running.get(key) === promise) running.delete(key); });
      running.set(key, promise);
      return promise;
    },
    dispose() { disposed = true; },
  };
}
