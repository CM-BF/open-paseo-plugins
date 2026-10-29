import type { CompanionTask } from './companion-tasks';
import { taskMatches, type TaskCardData } from './task-card';
import { executionErrorText } from './execution-notice';

export type TaskRequest = (op: string, args: Record<string, unknown>) => Promise<unknown>;
export interface TaskObservation { task: CompanionTask | null; readError: string; mutationError: string; busy: boolean }
let intentSequence = 0;
function intentId() { return `task-${Date.now().toString(36)}-${(++intentSequence).toString(36)}-${Math.random().toString(36).slice(2)}`; }
/** Shared native/DOM adapter: monotonic reads, exact owner binding, durable mutation intents. */
export function observeTask(data: TaskCardData, request: TaskRequest, emit: (value: TaskObservation) => void,
  options: { groupId?: string; current?: () => boolean; timers?: { set: typeof setTimeout; clear: typeof clearTimeout } } = {}) {
  const timers = options.timers ?? { set: setTimeout, clear: clearTimeout };
  let disposed = false, reading = false, again = false, epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let intent: { key: string; operationId: string } | null = null;
  let state: TaskObservation = { task: null, readError: '', mutationError: '', busy: false };
  const current = () => !disposed && (options.current?.() ?? true);
  const update = (patch: Partial<TaskObservation>) => { if (current()) { state = { ...state, ...patch }; emit(state); } };
  const accept = (value: unknown) => {
    const task = (value as { task?: CompanionTask })?.task;
    if (!task || !taskMatches(data, task, options.groupId)) throw new Error('Task ownership could not be verified.');
    if (data.receiptId && !task.results.some(receipt => receipt.id === data.receiptId)) throw new Error('The recorded task result is unavailable.');
    if (!state.task || task.revision >= state.task.revision) update({ task });
    return task;
  };
  const read = async () => {
    if (!current()) return;
    if (reading) { again = true; return; }
    if (timer) timers.clear(timer); timer = undefined;
    reading = true; const started = epoch;
    try {
      const result = await request('companion.tasks.get', { botId: data.botId, taskId: data.taskId, parentAgentId: data.parentAgentId, ...(options.groupId ? { groupId: options.groupId } : {}) });
      if (!current() || started !== epoch) return;
      accept(result); update({ readError: '' });
    } catch (error) { if (current() && started === epoch) update({ readError: error instanceof Error ? error.message : String(error) }); }
    finally {
      reading = false;
      if (current()) {
        if (again) { again = false; void read(); }
        else if (!data.receiptId || !state.task || state.readError) timer = timers.set(() => { timer = undefined; void read(); }, 2000);
      }
    }
  };
  const mutate = async (op: 'message' | 'stop' | 'resume', text?: string) => {
    if (!current() || state.busy || data.receiptId) return null;
    const task = state.task;
    if (!task) throw new Error('The task is not available yet.');
    if (op === 'message') {
      if (!text?.trim() || text.length > 4000) throw new Error('A task note must contain 1–4000 characters.');
    }
    if (op !== 'stop') {
      const key = op === 'message' ? `message:${text}` : 'resume';
      if (intent?.key !== key) intent = { key, operationId: intentId() };
    }
    epoch++; update({ busy: true, mutationError: '' });
    try {
      const result = await request(`companion.tasks.${op === 'resume' ? 'message' : op}`, { botId: data.botId, taskId: data.taskId, parentAgentId: data.parentAgentId, ...(options.groupId ? { groupId: options.groupId } : {}),
        ...(op === 'message' ? { message: text, mode: 'queue', operationId: intent!.operationId } : op === 'resume' ? { mode: 'resume', operationId: intent!.operationId } : { mode: 'cancel' }) });
      if (!current()) return null;
      epoch++; const saved = accept(result); if (op !== 'stop') intent = null;
      return saved;
    } catch (error) { if (current()) { epoch++; update({ mutationError: executionErrorText(error) }); } throw error; }
    finally { if (current()) { update({ busy: false }); void read(); } }
  };
  void read();
  return {
    refresh: () => { if (current()) { epoch++; void read(); } },
    stop: () => mutate('stop'),
    resume: () => mutate('resume'),
    note: (text: string) => mutate('message', text),
    dispose: () => { disposed = true; epoch++; if (timer) timers.clear(timer); },
  };
}
