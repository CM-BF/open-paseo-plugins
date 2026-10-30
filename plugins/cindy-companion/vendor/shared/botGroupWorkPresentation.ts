import type { BotGroupPlanView, BotGroupPlanStepView, BotGroupReplyMode } from './botGroupChat';
export const isActiveBotGroupMember = (member: { status: string }) => member.status === 'active';

/** The step the host reports as current (running, being redone, or last finished / failed). */
export function currentBotGroupPlanStep(plan: BotGroupPlanView): BotGroupPlanStepView | null {
  if (plan.currentStep === null) return null;
  return plan.steps.find((step) => step.position === plan.currentStep) ?? null;
}

export type BotGroupPlanFollowUp =
  | { kind: 'continue'; next: BotGroupPlanStepView }
  | { kind: 'retry'; failed: BotGroupPlanStepView };

/**
 * What the timeline offers under a plan that stopped after a step: 「下一步 · 继续」
 * when the step finished and another one waits, 「没做完 · 重试」 when it failed.
 */
export function botGroupPlanFollowUp(plan: BotGroupPlanView | null): BotGroupPlanFollowUp | null {
  if (!plan || plan.status !== 'waiting') return null;
  const current = currentBotGroupPlanStep(plan);
  if (!current) return null;
  if (current.status === 'failed') return { kind: 'retry', failed: current };
  if (current.status !== 'done') return null;
  const index = plan.steps.indexOf(current);
  const next = plan.steps.slice(index + 1).find((step) => step.status === 'pending');
  return next ? { kind: 'continue', next } : null;
}

/** Composer copy that follows the open plan (placeholder and the 「安排分工」 gate). */
export type BotGroupComposerPlanState =
  | { kind: 'proposed' }
  | { kind: 'running'; botName: string; talk?: boolean }
  | { kind: 'waiting'; botName: string; stepDone: boolean };

export function botGroupComposerPlanState(plan: BotGroupPlanView | null, replyMode: BotGroupReplyMode = 'all'): BotGroupComposerPlanState | null {
  if (!plan) return null;
  if (plan.status === 'proposed') return { kind: 'proposed' };
  const current = currentBotGroupPlanStep(plan);
  // Keep the work-plan state for the division gate, but name a recipient only when
  // ordinary text is actually forwarded to that worker (including legacy plans).
  const botName = replyMode === 'mentioned' ? '' : current?.botName.trim() ?? '';
  // Only promise additions when unmentioned words actually reach the speaking teammate.
  if (plan.status === 'running' && plan.kind === 'talk') return plan.canAdd === false || replyMode === 'mentioned' ? null : { kind: 'running', botName, talk: true };
  if (plan.status === 'running') return { kind: 'running', botName };
  // A queue waiting for 继续 takes a new request, not changes to the last answer (bot-group-chat.md §4.0).
  if (plan.status === 'waiting' && plan.kind === 'talk') return null;
  if (plan.status === 'waiting') return { kind: 'waiting', botName, stepDone: current?.status === 'done' };
  return null;
}

/** A plan that is running or waiting blocks a new 「安排分工」 (the host answers PLAN_OPEN). */
export function isBotGroupDivisionBlocked(state: BotGroupComposerPlanState | null): boolean {
  return state?.kind === 'running' || state?.kind === 'waiting';
}


/**
 * Absolute path of a hand-off file, or null when the entry could leave the plan's
 * work directory. The host lists files relative to `workDir` with POSIX separators;
 * the join follows the work directory's own separator so Windows paths stay native.
 */
export function botGroupPlanFilePath(workDir: string | null, file: string): string | null {
  if (!workDir || !file) return null;
  if (file.startsWith('/') || file.includes('\\') || /^[A-Za-z]:/.test(file)) return null;
  const segments = file.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  const windows = /^[A-Za-z]:[\\/]/.test(workDir) || workDir.startsWith('\\\\');
  const separator = windows ? '\\' : '/';
  const base = workDir.replace(/[\\/]+$/, '');
  return `${base}${separator}${segments.join(separator)}`;
}


/** Last path segment for compact labels (project folder, file chips). */
export function botGroupPathBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
