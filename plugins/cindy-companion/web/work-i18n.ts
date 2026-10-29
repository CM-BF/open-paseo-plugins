/** Host execution facts the original Cindy state machine did not distinguish. */
export const workEnglish = {
  confirmCleanup: 'Confirm cleanup',
  deleting: 'Group cleanup is not yet confirmed. Open group settings and retry Delete to finish cleanup.',
  directory: { loading: 'Reading folders on this host…', parent: 'Parent folder', select: 'Use this folder', truncated: 'The host limited this folder listing. Open a subfolder to narrow it.' },
  execution: { preparing: 'Preparing this step…', running: 'Working…', permission: 'Waiting for permission in the task.', stopping: 'Stopping… The host has not confirmed that work has stopped.', unknown: 'Execution status is unconfirmed. Open the task to check it; this step will not be sent again automatically.' },
  noteQueued: 'Added to this teammate’s work queue. It will be read after the current turn.',
  planning: 'The organizer is arranging the work…',
  planningFailed: 'The arrangement could not be created.',
  noteHint: 'Add a note for this teammate after its current turn.',
};
export const workChinese = {
  confirmCleanup: '确认清理',
  deleting: '群清理尚未确认完成。请在群设置中重试删除，完成清理。',
  directory: { loading: '正在读取这台主机的文件夹…', parent: '上一级', select: '选择此文件夹', truncated: '此目录项较多，主机只返回了部分目录。请进入子目录缩小范围。' },
  execution: { preparing: '正在准备这一步…', running: '正在工作…', permission: '等待在任务中确认权限。', stopping: '正在停止…宿主尚未确认工作已经停止。', unknown: '执行状态尚未确认。请打开任务核对；不会自动重发这一步。' },
  noteQueued: '已加入这位伙伴的工作队列，当前一轮结束后会读取。',
  planning: '负责人正在安排分工…',
  planningFailed: '未能生成安排。',
  noteHint: '补充内容会在这位伙伴当前一轮结束后读取。',
};
export const tasksEnglish = { resume: 'Continue task', loading: 'Loading task…', unavailable: 'This task’s conversation binding is unavailable.', stopping: 'Stop requested; waiting for confirmation.', unknown: 'This task’s execution status is unconfirmed. Open it to check; it will not be started again automatically.', noteUnknown: 'The host has not confirmed this note. The text is kept here; do not send a second copy while its outcome is unknown.' };
export const tasksChinese = { resume: '继续任务', loading: '正在读取任务…', unavailable: '这项任务的会话绑定不可用。', stopping: '已请求停止，等待确认。', unknown: '这项任务的执行状态尚未确认。请打开核对；不会自动重新启动。', noteUnknown: '宿主尚未确认这条补充。文字已保留；结果未明时不要重复发送。' };
