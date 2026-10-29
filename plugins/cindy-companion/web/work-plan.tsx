import { useTranslation } from 'react-i18next';
import type { GroupPlanSettings, GroupWorkPlan } from '../shared/group-plans';
import type { GroupMessage } from '../shared/groups';
import type { BotGroupMemberView } from '../shared/vendor/botGroupChat';
import { BotAvatar } from '../vendor/renderer/features/bots/BotAvatar';
import { BotGroupOrganizerTag, BotGroupPlanCard, BotGroupPlanFollowUpRow, BotGroupPlanEndDivider,
  BotGroupHandoffFiles } from '../vendor/renderer/features/bots/BotGroupPlan';
import { botGroupPlanFollowUp, currentBotGroupPlanStep } from '../vendor/shared/botGroupWorkPresentation';
import { Button } from '../vendor/renderer/components/ui/button';
import type { useGroupPlans } from './adapters/group-plans';
import { post } from './bridge';
import { formatBotTimelineClock } from '../vendor/shared/botTimeline';
import { executionMessage } from '../shared/execution-notice';

export type WorkPlanController = Pick<ReturnType<typeof useGroupPlans>, 'pending' | 'action' | 'settings'>;
export type OpenPlanArtifact = (plan: GroupWorkPlan, position: number, path: string, messageId?: string) => Promise<void>;

/** Original organizer bubble and plan widgets; the durable host snapshot owns every status. */
export function WorkPlanMessage({ plan, members, settings, control, locale, onOpenArtifact, showFooter = true }: {
  plan: GroupWorkPlan; members: BotGroupMemberView[]; settings: GroupPlanSettings;
  control: WorkPlanController; locale: string; onOpenArtifact: OpenPlanArtifact; showFooter?: boolean;
}) {
  const { t } = useTranslation();
  const member = members.find(value => value.botId === plan.organizerBotId);
  const pending = control.pending?.planId === plan.id ? control.pending.action : null;
  const blocked = control.pending !== null;
  const actionable = plan.status === 'proposed' && plan.execution.state === 'idle';
  const reassignable = plan.status === 'waiting' && plan.execution.state === 'idle';
  const followUp = plan.execution.state === 'idle' ? botGroupPlanFollowUp(plan) : null;
  const step = currentBotGroupPlanStep(plan);
  const liveStep = plan.steps.find(value => value.position === step?.position);
  const cardPending = blocked ? (pending === 'start' || pending === 'dismiss' ? pending : 'edit') : null;
  const followPending = blocked ? (pending === 'continue' || pending === 'retry' ? pending : 'dismiss') : null;
  const doneAt = new Map(plan.steps.flatMap(value => value.completedAt === undefined ? [] : [[value.position + 1, value.completedAt] as const]));
  const timed = Number.isFinite(plan.createdAt) && plan.createdAt > 0;
  return <div data-work-plan-id={plan.id} className="mt-3.5 flex min-w-0 flex-col gap-3">
    <article className="group/message relative flex min-w-0 items-start gap-2.5 rounded-lg py-0.5">
      <div className="flex w-7 shrink-0 justify-end"><BotAvatar bot={member ?? { name: plan.organizerName, avatar: null, avatarColor: null }} size="sm" /></div>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <span className="flex min-w-0 max-w-full select-none items-baseline gap-1.5"><span className="min-w-0 truncate text-13 font-medium leading-5 text-[var(--text-primary)]">{plan.organizerName}</span><BotGroupOrganizerTag />{timed && <time dateTime={new Date(plan.createdAt).toISOString()} className="shrink-0 text-11 tabular-nums text-[var(--text-tertiary)]">{formatBotTimelineClock(plan.createdAt, locale)}</time>}</span>
        <div className="relative flex min-w-0 max-w-[min(720px,calc(100%-120px))] flex-col"><div className="relative flex min-w-0 max-w-full flex-col gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 py-2.5 text-15 font-normal leading-[1.6] text-[var(--msg-assistant-text)]">
          <BotGroupPlanCard plan={plan} members={members} actionable={actionable} reassignable={reassignable} pending={cardPending}
            runningSince={liveStep?.startedAt ?? null} doneAt={doneAt} locale={locale}
            onStart={() => { void control.action(plan, 'start'); }} onDismiss={() => { void control.action(plan, 'dismiss'); }}
            onEditStep={(value, action, botId) => { void control.action(plan, 'edit', { position: value.position, action, ...(botId ? { botId } : {}) }); }}
            onAutoContinueChange={['proposed', 'running', 'waiting'].includes(plan.status) && !['stopping', 'unknown'].includes(plan.execution.state) ? value => { void control.settings(settings, { autoContinue: value }); } : undefined} />
          {(plan.execution.state !== 'idle' || plan.execution.code) && <p role="status" className="text-12 leading-5 text-[var(--text-secondary)]">{executionMessage(plan.execution.code, locale) || t(`paseoWork.execution.${plan.execution.state}`)}</p>}
          {liveStep?.agentId && (plan.execution.state !== 'idle' || plan.execution.code) && <Button variant="secondary" tone="quiet" size="sm" onClick={() => post('navigate-agent', { agentId: liveStep.agentId })}>{t(plan.execution.state === 'permission' ? 'paseoGroups.reviewPermission' : 'paseoGroups.openTask')}</Button>}
        </div></div>
      </div>
    </article>
    {showFooter && followUp && <BotGroupPlanFollowUpRow plan={plan} followUp={followUp} members={members} pending={followPending}
      onContinue={() => { void control.action(plan, 'continue'); }} onRetry={() => { void control.action(plan, 'retry'); }} onEnd={() => { void control.action(plan, 'dismiss'); }} />}
    {showFooter && plan.status === 'done' && plan.execution.state === 'idle' && <BotGroupPlanEndDivider stepCount={plan.steps.length} />}
  </div>;
}

export function WorkHandoffFiles({ plan, position, message, onOpenArtifact }: { plan: GroupWorkPlan; position: number; message?: GroupMessage; onOpenArtifact: OpenPlanArtifact }) {
  if (message) {
    if (message.planId !== plan.id || message.planStep !== position) return null;
    return <BotGroupHandoffFiles files={(message.artifacts ?? []).map(file => file.path)} workDir={plan.workDir} onOpenFile={path => onOpenArtifact(plan, position, path, message.id)} />;
  }
  const step = plan.steps.find(value => value.position === position);
  return step ? <BotGroupHandoffFiles files={step.artifacts.map(file => file.path)} workDir={plan.workDir} onOpenFile={path => onOpenArtifact(plan, position, path)} /> : null;
}

export function WorkPlanFooter({ plan, members, control }: { plan: GroupWorkPlan; members: BotGroupMemberView[]; control: WorkPlanController }) {
  if (plan.execution.state !== 'idle') return null;
  const followUp = botGroupPlanFollowUp(plan);
  const action = control.pending?.action;
  return followUp ? <BotGroupPlanFollowUpRow plan={plan} followUp={followUp} members={members}
    pending={control.pending ? action === 'continue' || action === 'retry' ? action : 'dismiss' : null}
    onContinue={() => { void control.action(plan, 'continue'); }} onRetry={() => { void control.action(plan, 'retry'); }} onEnd={() => { void control.action(plan, 'dismiss'); }} />
    : plan.status === 'done' ? <BotGroupPlanEndDivider stepCount={plan.steps.length} /> : null;
}
