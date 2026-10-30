/** Host admission and stop facts shared by native and original DOM cards. */
const keys = {
  HOST_UPGRADE_REQUIRED: 'upgrade', unsupported_capability: 'upgrade', PROVIDER_ADMISSION_UNAVAILABLE: 'upgrade', PROVIDER_QUEUE_UNAVAILABLE: 'upgrade',
  GROUP_LANE_BUSY: 'busy', TASK_BUSY: 'busy',
  ADMISSION_OUTCOME_UNKNOWN: 'admissionUnknown',
  QUEUE_ITEM_REMOVED: 'queueRemoved',
  GROUP_STOP_REQUIRES_NATIVE: 'nativeStop', TASK_STOP_REQUIRES_NATIVE: 'nativeStop', STOP_REQUIRES_NATIVE: 'nativeStop',
  STOP_NOT_CONFIRMED: 'stopUnknown', STOP_REQUESTED: 'stopping', USER_STOPPED: 'stopped',
  HOST_RESTARTED: 'interrupted', PLUGIN_CLOSED: 'interrupted',
  REPLY_NOT_CONFIRMED: 'outcomeUnknown', CONNECTION_LOST: 'outcomeUnknown',
  GROUP_ARCHIVE_REQUIRES_NATIVE: 'nativeArchive', CLEANUP_NOT_CONFIRMED: 'cleanupUnknown',
  ATTACHMENT_INPUT_UNAVAILABLE: 'attachmentUnavailable',
} as const;
const messages = {
  en: {
    attachmentUnavailable: 'The message and its attachments are saved in this group. This runtime cannot pass these attachments to the teammate yet, so the teammate has not received this input.',
    upgrade: 'This input has not been sent. The current runtime cannot safely start this work. Your request is kept; you can try again later.',
    busy: 'This input has not been sent because the task session is busy. Its current work has not been interrupted.',
    admissionUnknown: 'This input may have been sent, but the host has not confirmed it. Open the task to check; do not send another copy.',
    queueRemoved: 'The queued item was removed, but whether it already started is not confirmed. Open the task to check; do not send another copy.',
    nativeStop: 'This host cannot safely stop the exact task turn. Open the task session and stop it there, then return and press Stop again to confirm. It is not yet confirmed stopped.',
    stopUnknown: 'The stop is not yet confirmed. Open the task to check, then press Stop again to confirm.',
    stopping: 'Stop requested; waiting for confirmation.',
    stopped: 'The task was stopped.',
    interrupted: 'The host connection changed before the task outcome was confirmed. Open the task to check; it will not be sent again automatically.',
    outcomeUnknown: 'The task outcome has not been confirmed. Open the task to check; it will not be sent again automatically.',
    nativeArchive: 'Cleanup is pending. Open the task session and archive it there, then return and confirm cleanup. This action will only check its state.',
    cleanupUnknown: 'Cleanup has not been confirmed. Open the task session to check, then confirm cleanup here.',
    failed: 'This action could not be completed. Open the task session to check its state and details.',
  },
  'zh-CN': {
    attachmentUnavailable: '消息和附件已保存在群里。当前运行环境还不能把这些附件传给伙伴，因此这条内容尚未送入伙伴的模型。',
    upgrade: '这条内容尚未发送。当前运行环境尚未提供安全启动能力；请求已保留，可稍后重试。',
    busy: '这条内容尚未发送，因为任务会话正在忙。会话中原有的工作没有被打断。',
    admissionUnknown: '这条内容可能已经发送，但主机尚未确认。请打开任务核对，不要重复发送。',
    queueRemoved: '排队条目已移除，但是否已经开始执行尚未确认。请打开任务核对，不要重复发送。',
    nativeStop: '这台主机暂时无法安全停止任务对应的那一轮。请打开任务会话，在那里手动停止，再回来点“停止”确认。目前尚未确认已停止。',
    stopUnknown: '尚未确认已停止。请打开任务核对，再点“停止”确认。',
    stopping: '已请求停止，等待确认。',
    stopped: '任务已停止。',
    interrupted: '任务结果确认前，主机连接发生了变化。请打开任务核对；不会自动重发。',
    outcomeUnknown: '任务结果尚未确认。请打开任务核对；不会自动重发。',
    nativeArchive: '清理尚未完成。请打开任务会话，在那里归档，再回来确认清理。这里的操作只会核对状态。',
    cleanupUnknown: '尚未确认清理完成。请打开任务会话核对，再回来确认清理。',
    failed: '未能完成这次操作。请打开任务会话，查看当前状态和详情。',
  },
};
/** Preserve a recognized structured code across adapter state without leaking it into visible text. */
export function executionErrorText(value: unknown): string {
  if (value && typeof value === 'object') {
    const error = value as { code?: unknown; message?: unknown };
    if (typeof error.code === 'string' && Object.prototype.hasOwnProperty.call(keys, error.code)) return error.code;
    if (typeof error.message === 'string') return error.message;
  }
  return value == null ? '' : String(value);
}
export function executionMessage(value: unknown, locale = 'en'): string {
  const text = executionErrorText(value), dictionary = locale.toLowerCase().startsWith('zh') ? messages['zh-CN'] : messages.en;
  const key = Object.prototype.hasOwnProperty.call(keys, text) ? keys[text as keyof typeof keys] : undefined;
  return key ? dictionary[key] : /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(text) ? dictionary.failed : text;
}
