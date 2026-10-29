import type { PluginTimelineTransformerContribution } from '@getpaseo/plugin/client';
import { TASK_CARD_KIND, taskCardSchema } from '../shared/task-card';

type Transformer = PluginTimelineTransformerContribution<'tool_call'>;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function outputValue(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 3) return null;
  if (typeof value === 'string') {
    if (value.length > 2 * 1024 * 1024) return null;
    try { return outputValue(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) return value.length === 1 && record(value[0]) && value[0].type === 'text' ? outputValue(value[0].text, depth + 1) : null;
  if (!record(value) || value.isError === true || value.ok === false) return null;
  if (Array.isArray(value.content)) return outputValue(value.content, depth + 1);
  return value;
}

/** Only the actual scoped MCP tools may replace their successful native row. */
export const taskTransformer: Transformer = {
  id: 'companion-task', query: { itemType: 'tool_call' },
  transform({ item, phase }) {
    if (phase !== 'complete' || item.status !== 'completed' || item.error || item.detail.type !== 'unknown') return;
    const action = item.name.startsWith('cindy_memory.') ? item.name.slice('cindy_memory.'.length)
      : item.name.startsWith('mcp__cindy_memory__') ? item.name.slice('mcp__cindy_memory__'.length) : null;
    if (action !== 'start_session_task' && action !== 'check_session_task') return;
    const value = outputValue(item.detail.output);
    if (!value || value.action !== action || !record(value.task)) return;
    const task = value.task;
    if (value.taskId !== task.id || value.botId !== task.requestingBotId || task.targetBotId !== null) return;
    if (action === 'start_session_task' && value.accepted !== true) return;
    let receiptId: string | undefined;
    if (action === 'check_session_task') {
      if (!Array.isArray(task.results)) return;
      const last = task.results.at(-1);
      if (!record(last) || typeof last.id !== 'string' || !['completed', 'failed', 'cancelled'].includes(String(last.status))) return;
      receiptId = last.id;
    }
    const parsed = taskCardSchema.safeParse({ botId: value.botId, taskId: value.taskId, parentAgentId: task.parentSessionId, ...(receiptId ? { receiptId } : {}) });
    if (!parsed.success) return;
    return { items: [{ type: 'plugin', kind: TASK_CARD_KIND, version: 1, data: parsed.data }] };
  },
};
