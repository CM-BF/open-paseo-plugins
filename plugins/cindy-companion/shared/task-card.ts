import { z } from 'zod';
import type { CompanionTask, TaskResultReceipt } from './companion-tasks';
import type { BotCollaborationMeta } from './vendor/botCollaboration';

export const TASK_CARD_KIND = 'companion-task';
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
export const taskCardSchema = z.object({ botId: identifier, taskId: identifier, parentAgentId: identifier, receiptId: identifier.optional() }).strict();
export type TaskCardData = z.infer<typeof taskCardSchema>;
export interface CompanionTaskCardView {
  id: string; title: string; objective: string; agentId?: string; harness?: string;
  state: 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  createdAt: number; acceptedAt?: number | null; completedAt?: number | null;
  currentAction?: string; waitingSummary?: string; resultText: string; error?: string; errorCode?: string;
  files: string[]; workingDir?: string; stale: boolean; canAddNote: boolean; canStop: boolean; canResume?: boolean;
  receipt?: NonNullable<BotCollaborationMeta['result']>;
}
/** Every displayed fact is from the owned task or the selected immutable run receipt. */
export function projectTaskCard(task: CompanionTask, receipt?: TaskResultReceipt): CompanionTaskCardView {
  const uncertain = task.control === 'unknown' || task.activity === 'unknown';
  const state = uncertain ? 'unknown' : task.status === 'queued' ? 'starting' : task.status === 'timed-out' ? 'failed' : task.status;
  return {
    id: task.id, title: task.title, objective: task.objective, agentId: task.childSessionId ?? undefined,
    state, createdAt: task.createdAt, acceptedAt: task.acceptedAt, completedAt: task.completedAt,
    waitingSummary: task.pendingInteraction?.summary, resultText: task.resultSummary ?? '', error: task.blocked?.message ?? task.lastError ?? undefined,
    errorCode: task.blocked?.code,
    files: task.artifacts.map(file => file.path), workingDir: task.workingDir ?? undefined, stale: uncertain,
    canAddNote: task.control === 'active' && task.status === 'running',
    canResume: task.control === 'paused',
    canStop: task.control === 'paused' || uncertain || (task.control === 'active' && ['queued', 'running', 'waiting'].includes(task.status)),
    ...(receipt ? { receipt: { runSequence: receipt.runSequence, status: receipt.status, text: receipt.text,
      title: receipt.title, workingDir: receipt.workingDir, artifacts: receipt.artifacts.map(file => ({ absolutePath: file.path })) } } : {}),
  };
}
export function taskMatches(data: TaskCardData, task: CompanionTask, groupId?: string): boolean {
  return task.id === data.taskId && task.requestingBotId === data.botId && task.parentSessionId === data.parentAgentId
    && (groupId === undefined || task.groupId === groupId);
}
