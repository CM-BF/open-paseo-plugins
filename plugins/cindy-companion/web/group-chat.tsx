// Paseo data adapter around the original Cindy group header, bubbles and composer chrome.
// Extracted JSX/style provenance is recorded in group-upstream-files.json and SOURCE.md.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Settings2 } from 'lucide-react';
import { invoke, post } from './bridge';
import { useGroup, mergeMessages } from './adapters/group-store';
import type { GroupMessage, GroupSnapshot, GroupRound } from '../shared/groups';
import type { BotGroupMemberView } from '../shared/vendor/botGroupChat';
import { BOT_GROUP_MESSAGE_MAX_CHARS } from '../shared/vendor/botGroupChat';
import { Button } from '../vendor/renderer/components/ui/button';
import { Spinner } from '../vendor/renderer/components/ui/spinner';
import { SendButton } from '../vendor/renderer/components/new-chat/SendButton';
import { BotAvatar } from '../vendor/renderer/features/bots/BotAvatar';
import { BotGroupAvatarStack } from '../vendor/renderer/features/bots/BotGroupAvatars';
import { useBotGroupMentionPicker } from '../vendor/renderer/features/bots/useBotGroupMentionPicker';
import { BOT_GROUP_COMPOSER_CARD, BOT_GROUP_COMPOSER_COLUMN, BOT_GROUP_COMPOSER_DOCK, BOT_GROUP_COMPOSER_FOOTER,
  BOT_GROUP_COMPOSER_INPUT, fitBotGroupComposerInput, keepBotGroupComposerInputFocus, useRefitBotGroupComposerInputOnResize } from '../vendor/renderer/features/bots/botGroupComposerChrome';
import { formatBotTimelineClock, formatBotTimelineDate, isSameBotTimelineDay } from '../vendor/shared/botTimeline';
import { MarkdownRenderer } from './adapters/memory-markdown';
import { GroupSettings } from './group-settings';
import { GroupTaskCard } from './group-task';
import { useGroupPlans } from './adapters/group-plans';
import { WorkPlanMessage, WorkPlanFooter, WorkHandoffFiles } from './work-plan';
import { WorkDivisionTag, WorkDivisionMenuItem } from './work-composer';
import { openWorkArtifact } from './work-artifacts';
import { botGroupComposerPlanState } from '../vendor/shared/botGroupWorkPresentation';
import { resolveBotGroupMentions, splitBotGroupRelaySteps } from '../shared/vendor/botGroupMentions';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../vendor/renderer/components/ui/dropdown-menu';
import { executionErrorText, executionMessage } from '../shared/execution-notice';
import { GroupCleanupNotice } from './group-cleanup';

const busyRound = (status?: string) => ['queued', 'running', 'permission', 'stopping', 'unknown'].includes(status ?? '');
function Message({ groupId, message, previous, members, locale, files }: { groupId: string; message: GroupMessage; previous?: GroupMessage; members: GroupSnapshot['group']['members']; locale: string; files?: ReactNode }) {
  const { t } = useTranslation();
  const system = message.authorKind === 'system';
  const continued = !system && previous?.kind === 'message' && previous.authorKind === message.authorKind && previous.authorBotId === message.authorBotId
    && message.createdAt - previous.createdAt < 300_000 && isSameBotTimelineDay(previous.createdAt, message.createdAt);
  const member = members.find(value => value.botId === message.authorBotId);
  const body = <><MarkdownRenderer content={message.content}/>{message.taskId && <GroupTaskCard groupId={groupId} message={message}/>} {files}</>;
  const clock = formatBotTimelineClock(message.createdAt, locale);
  return <>
    {(!previous || !isSameBotTimelineDay(previous.createdAt, message.createdAt)) && <div data-testid="bot-group-date-divider" className="mt-6 flex select-none justify-center first:mt-0"><span className="text-11 leading-4 text-[var(--text-tertiary)]">{formatBotTimelineDate(message.createdAt, locale)}</span></div>}
    <div data-bot-group-message-id={message.id} className={`rounded-lg outline-none transition-colors first:mt-0 ${continued ? 'mt-0.5' : system ? 'mt-3' : 'mt-3.5'}`}>
      {system ? <p className="select-none text-center text-12 leading-5 text-[var(--text-tertiary)]">{executionMessage({ code: message.code, message: message.content }, locale)}</p> : message.authorKind === 'user' ?
        <article className="group/message relative flex min-w-0 justify-end rounded-lg py-0.5"><div className="flex min-w-0 max-w-[min(720px,calc(100%-120px))] flex-col items-end gap-1.5 transition-opacity"><div data-testid="bot-group-self-bubble" className="relative flex max-w-full flex-col gap-2 rounded-xl border border-[var(--msg-user-border)] bg-[var(--msg-user-bg)] px-3.5 py-2 text-15 font-normal leading-[1.6] text-[var(--msg-user-text)]">{body}</div>{message.delivery === 'deferred' && <p role="status" className="max-w-full text-12 leading-5 text-[var(--text-tertiary)]">{t('paseoGroups.deferred')}</p>}</div></article> :
        <article className="group/message relative flex min-w-0 items-start gap-2.5 rounded-lg py-0.5">
          <div className="flex w-7 shrink-0 justify-end">{continued ? <time className="select-none pt-0.5 text-11 leading-5 tabular-nums text-[var(--text-tertiary)] opacity-0 group-hover/message:opacity-100">{clock}</time> : <BotAvatar bot={member ?? { name: message.authorName, avatar: null, avatarColor: null }} size="sm"/>}</div>
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">{!continued && <span className="flex min-w-0 max-w-full select-none items-baseline gap-1.5"><span className="min-w-0 truncate text-13 font-medium leading-5 text-[var(--text-primary)]">{member?.name ?? message.authorName}</span>{message.planStep !== undefined && <span className="inline-flex min-h-[18px] max-w-[12rem] shrink-0 select-none items-center truncate rounded-full bg-[var(--surface-chip)] px-1.5 py-px text-11 font-medium leading-tight text-[var(--text-secondary)]">{t('bots.groupChat.timeline.stepTag', { count: message.planStep + 1 })}</span>}<time className="shrink-0 text-11 tabular-nums text-[var(--text-tertiary)]">{clock}</time></span>}
            <div className="relative flex min-w-0 max-w-[min(720px,calc(100%-120px))] flex-col"><div data-testid="bot-group-bubble" className="relative flex min-w-0 max-w-full flex-col gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 py-2.5 text-15 font-normal leading-[1.6] text-[var(--msg-assistant-text)]">{body}</div></div>
          </div>
        </article>}
    </div>
  </>;
}

export function GroupChat({ groupId }: { groupId: string }) {
  const { t, i18n } = useTranslation();
  const { data, setData, error: readError, refresh } = useGroup(groupId);
  const work = useGroupPlans(groupId);
  const [division, setDivision] = useState(false), [menuOpen, setMenuOpen] = useState(false), [workNotice, setWorkNotice] = useState('');
  const [text, setText] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [settings, setSettings] = useState(false);
  const lock = useRef(false), alive = useRef(true), textarea = useRef<HTMLTextAreaElement>(null), scroll = useRef<HTMLDivElement>(null), stick = useRef(true);
  const sendIntent = useRef<{ signature: string; clientMessageId: string } | null>(null);
  const continueIntent = useRef<{ roundId: string; operationId: string } | null>(null);
  const members = useMemo(() => (data?.group.members ?? []) as BotGroupMemberView[], [data?.group.members]);
  const mention = useBotGroupMentionPicker({ text, onTextChange: setText, members, textareaRef: textarea, allLabels: ['all', 'everyone', '所有人', t('bots.groupChat.mention.all')] });
  const plans = work.data?.plans ?? [];
  const openPlan = plans.find(plan => ['proposed', 'running', 'waiting'].includes(plan.status) || plan.execution.state === 'unknown');
  const planningRequest = work.data?.requests?.find(request => request.status === 'planning' || request.status === 'unknown');
  const planning = Boolean(planningRequest);
  const workActive = openPlan && openPlan.execution.state !== 'idle';
  const active = busyRound(data?.group.round?.status) || Boolean(workActive) || planning;
  const allLabels = ['all', 'everyone', '所有人', t('bots.groupChat.mention.all')];
  const writtenSteps = splitBotGroupRelaySteps(text, { members, allLabels });
  const planState = botGroupComposerPlanState(openPlan ?? null, data?.group.replyMode);
  const placeholder = division ? t(writtenSteps ? 'bots.groupChat.composer.placeholderDivisionSteps' : 'bots.groupChat.composer.placeholderDivision')
    : planState?.kind === 'proposed' ? t('bots.groupChat.composer.placeholderPlanProposed')
    : planState?.kind === 'running' && planState.botName ? t('bots.groupChat.composer.placeholderPlanRunning', { name: planState.botName })
    : planState?.kind === 'waiting' && planState.stepDone && planState.botName ? t('bots.groupChat.composer.placeholderPlanWaiting', { name: planState.botName })
    : t('bots.groupChat.composer.placeholder');
  const deleting = data?.group.mutation === 'deleting';
  const showStop = active && !text.trim();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (settings) return;
    const requested = () => post('close');
    window.addEventListener('cindy-request-close', requested);
    return () => window.removeEventListener('cindy-request-close', requested);
  }, [settings]);
  useLayoutEffect(() => { if (textarea.current) fitBotGroupComposerInput(textarea.current); }, [text]);
  useRefitBotGroupComposerInputOnResize(textarea);
  useLayoutEffect(() => { if (scroll.current && stick.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [data?.messages]);
  const action = async (run: () => Promise<unknown>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await run(); if (alive.current) { post('groups-changed'); void refresh(); } }
    catch (reason) { if (alive.current) setError(executionErrorText(reason)); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const acceptReceipt = (receipt: { message?: GroupMessage; round: GroupRound | null }) => {
    if (!alive.current) return;
    setData(previous => {
      if (!previous) return previous;
      const current = previous.group.round;
      const incoming = receipt.round;
      if (incoming?.kind === 'reply' && incoming.id !== current?.id && busyRound(current?.status)) {
        const pendingReplies = [...(previous.group.pendingReplies ?? []).filter(item => item.id !== incoming.id), incoming];
        return { ...previous, group: { ...previous.group, pendingReplies }, messages: receipt.message ? mergeMessages(previous.messages, [receipt.message]) : previous.messages };
      }
      const round = !current || (incoming && incoming.updatedAt >= current.updatedAt) ? incoming : current;
      return { ...previous, group: { ...previous.group, round }, messages: receipt.message ? mergeMessages(previous.messages, [receipt.message]) : previous.messages };
    });
  };
  const send = () => {
    if (deleting) return;
    if (!text.trim() || planning || work.pending) return;
    const requested = text;
    const trackedMentions = mention.tracked;
    const signature = JSON.stringify({ text: requested, trackedMentions });
    if (sendIntent.current?.signature !== signature) sendIntent.current = { signature, clientMessageId: crypto.randomUUID() };
    const clientMessageId = sendIntent.current.clientMessageId;
    void action(async () => {
      if (division) {
        if (!await work.createPlan(requested, trackedMentions)) return;
      } else {
        const addressed = resolveBotGroupMentions(requested, { members, allLabels, tracked: trackedMentions });
        if (openPlan && data?.group.replyMode === 'all' && !addressed.all && addressed.botIds.length === 0) {
          const result = await work.action(openPlan, openPlan.status === 'proposed' ? 'revise' : 'note', { text: requested });
          if (!result) return;
          if (result.delivery === 'queued' && alive.current) setWorkNotice(t('paseoWork.noteQueued'));
        } else {
      acceptReceipt(await invoke<{ message: GroupMessage; round: GroupRound | null }>('groups.send', { groupId, text: requested, trackedMentions, clientMessageId }));
        }
      }
      if (alive.current) { setText(''); setDivision(false); mention.reset(); sendIntent.current = null; stick.current = true; }
    });
  };
  const stop = () => { if (planningRequest) { void work.cancelRequest(planningRequest.id); return; } if (openPlan && workActive) { void work.action(openPlan, 'stop'); return; } const roundId = data?.group.round?.id; if (roundId) void action(async () => {
    acceptReceipt(await invoke<{ round: GroupRound }>('groups.stop', { groupId, roundId }));
  }); };
  const continueRound = () => {
    const roundId = data?.group.round?.id; if (!roundId) return;
    if (continueIntent.current?.roundId !== roundId) continueIntent.current = { roundId, operationId: crypto.randomUUID() };
    void action(async () => { acceptReceipt(await invoke<{ round: GroupRound }>('groups.continue', { groupId, ...continueIntent.current })); });
  };
  const older = () => { if (data?.messages[0]) void action(async () => {
    const next = await invoke<GroupSnapshot>('groups.get', { groupId, beforeSequence: data.messages[0].sequence });
    if (alive.current) setData(previous => previous ? { ...previous, messages: mergeMessages(next.messages, previous.messages), hasOlder: next.hasOlder } : next);
  }); };
  if (!data) return <main className="flex h-full items-center justify-center bg-[var(--surface)] p-6">{readError ? <div role="alert" className="text-13 text-[var(--text-danger)]">{readError}<Button variant="secondary" onClick={() => void refresh()}>{t('bots.retry')}</Button></div> : <Spinner size={20}/>}</main>;
  const round = data.group.round;
  const running = round?.steps.find(step => ['running', 'permission', 'unknown'].includes(step.status));
  const recoveryStep = running ?? (round?.code ? round.steps[round.position] : undefined);
  return <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface)] text-[var(--text-primary)]">
    <header className="flex h-14 shrink-0 items-center border-b border-[var(--border-default)] px-3"><div data-testid="bot-group-content-header" className="flex h-full w-full min-w-0 items-center gap-2 pr-2">
      <button type="button" onClick={() => setSettings(true)} title={members.map(value => value.name).join(', ')} className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-1 text-left hover:bg-[var(--surface-hover)]"><BotGroupAvatarStack members={members}/><span className="flex min-w-0 flex-col"><span className="min-w-0 truncate text-13 font-medium leading-5 text-[var(--text-primary)]">{data.group.name}</span><span className="min-w-0 truncate text-11 leading-4 tabular-nums text-[var(--text-tertiary)]">{running ? `${running.botName} · ${t('paseoGroups.status.' + running.status)}` : t('bots.groupChat.memberCount', { count: members.length })}</span></span></button>
      <button type="button" aria-label={t('bots.groupChat.settings.title')} onClick={() => setSettings(true)} className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"><Settings2 size={15}/></button>
    </div></header>
    <div ref={scroll} data-testid="bot-group-timeline" onScroll={event => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-4"><div className="mx-auto flex w-full max-w-[760px] flex-col">
      {data.hasOlder && <div className="mb-2 flex justify-center"><Button variant="secondary" size="sm" compact loading={busy} onClick={older}>{t('bots.groupChat.timeline.loadEarlier')}</Button></div>}
      {!data.messages.length && !active && <div className="py-12 text-center"><p className="text-13 font-medium text-[var(--text-secondary)]">{t('bots.groupChat.timeline.emptyTitle')}</p><p className="mt-1 text-12 text-[var(--text-tertiary)]">{t('bots.groupChat.timeline.emptyDescription')}</p></div>}
      {data.messages.map((message, index) => <Fragment key={message.id}><Message groupId={groupId} message={message} previous={data.messages[index - 1]} members={data.group.members} locale={i18n.language}
        files={message.planId && message.planStep !== undefined ? plans.filter(plan => plan.id === message.planId).map(plan => <WorkHandoffFiles key={plan.id} plan={plan} position={message.planStep!} message={message} onOpenArtifact={openWorkArtifact}/>) : plans.flatMap(plan => plan.steps.filter(step => step.resultMessageId === message.id).map(step => <WorkHandoffFiles key={plan.id + ':' + step.position} plan={plan} position={step.position} onOpenArtifact={openWorkArtifact} />))}/>
        {work.data && plans.filter(plan => plan.sourceMessageId === message.id).map(plan => <WorkPlanMessage key={plan.id} plan={plan} members={members} settings={work.data!.settings} control={work} locale={i18n.language} onOpenArtifact={openWorkArtifact} showFooter={false} />)}
        {plans.filter(plan => plan.status === 'done' && plan.steps.at(-1)?.resultMessageId === message.id).map(plan => <div key={plan.id} className="mt-3"><WorkPlanFooter plan={plan} members={members} control={work}/></div>)}
      </Fragment>)}
      {openPlan && work.data && !data.messages.some(message => message.id === openPlan.sourceMessageId) && <WorkPlanMessage plan={openPlan} members={members} settings={work.data.settings} control={work} locale={i18n.language} onOpenArtifact={openWorkArtifact} showFooter={false}/>}
      {openPlan && <div className="mt-3"><WorkPlanFooter plan={openPlan} members={members} control={work}/></div>}
      {work.data?.requests?.filter(request => request.status !== 'complete' || request.cleanupPending).map(request => <div key={request.id} className="mt-3 flex flex-wrap items-center justify-center gap-2 text-12 text-[var(--text-secondary)]"><p role={request.status === 'planning' ? 'status' : 'alert'}>{request.organizerName} · {request.status !== 'complete' && (executionMessage(request.code, i18n.language) || t(request.status === 'planning' ? 'paseoWork.planning' : request.status === 'unknown' ? 'paseoWork.execution.unknown' : 'paseoWork.planningFailed'))}{request.cleanupPending && <span className={request.status === 'complete' ? '' : 'block'}>{executionMessage(request.cleanupCode ?? 'CLEANUP_NOT_CONFIRMED', i18n.language)}</span>}</p>{request.agentId && <Button variant="secondary" tone="quiet" size="sm" compact onClick={() => post('navigate-agent', { agentId: request.agentId })}>{t('paseoGroups.openTask')}</Button>}{(['planning', 'unknown'].includes(request.status) || request.cleanupPending) && <Button variant="secondary" tone="quiet" size="sm" compact disabled={Boolean(work.pending) || (['planning', 'unknown'].includes(request.status) && request.code === 'STOP_REQUESTED')} onClick={() => void work.cancelRequest(request.id)}>{t(['complete', 'failed'].includes(request.status) ? 'paseoWork.confirmCleanup' : 'bots.groupChat.composer.stop')}</Button>}</div>)}
      {!!data.group.cleanupPending?.length && <div className="mt-3"><GroupCleanupNotice pending={data.group.cleanupPending} busy={busy} onConfirm={() => void action(async () => { await invoke('groups.cleanup', { groupId }); })}/></div>}
      {round?.status === 'waiting' && <div className="mt-3 flex justify-center"><Button variant="secondary" tone="quiet" size="sm" compact loading={busy} onClick={continueRound}>{t('bots.groupChat.timeline.continue')}</Button></div>}
    </div></div>
    {round?.code && <p role="status" className="px-5 text-center text-12 text-[var(--text-secondary)]">{executionMessage(round.code, i18n.language)}</p>}
    {recoveryStep?.agentId && <div className="px-5 text-center text-12 text-[var(--text-secondary)]"><Button variant="secondary" tone="quiet" size="sm" onClick={() => post('navigate-agent', { agentId: recoveryStep.agentId })}>{t(recoveryStep.status === 'permission' ? 'paseoGroups.reviewPermission' : 'paseoGroups.openTask')}</Button></div>}
    <div className={BOT_GROUP_COMPOSER_DOCK}><div className={BOT_GROUP_COMPOSER_COLUMN}>
      {deleting && <p role="status" className="mb-2 text-12 text-[var(--text-secondary)]">{t('paseoWork.deleting')}</p>}
      {(error || readError || work.error) && <p role="alert" className="mb-2 text-13 text-[var(--error-fg)]">{executionMessage(error || readError || work.error, i18n.language)}</p>}
      {workNotice && <p role="status" className="mb-2 text-12 text-[var(--text-tertiary)]">{workNotice}</p>}
      {!!data.group.pendingReplies?.length && <div role="status" aria-live="polite" className="mb-2 flex flex-col gap-1 text-12 text-[var(--text-tertiary)]">{data.group.pendingReplies.map(pending => <p key={pending.id} data-pending-round-id={pending.id}>{t('paseoGroups.queuedReply', { names: pending.steps.map(step => step.botName).join(', ') })}</p>)}</div>}
      {mention.list}<div className={BOT_GROUP_COMPOSER_CARD}>{division && <WorkDivisionTag onRemove={() => { setDivision(false); textarea.current?.focus(); }}/>}<textarea ref={textarea} value={text} rows={1} maxLength={BOT_GROUP_MESSAGE_MAX_CHARS} readOnly={busy || Boolean(work.pending) || planning || deleting}
        aria-label={t('bots.groupChat.composer.label')} placeholder={placeholder} {...mention.textareaProps}
        onChange={event => { setWorkNotice(''); mention.onChange(event.target.value); }} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229 || mention.onKeyDown(event)) return; if (event.key === 'Backspace' && division && !text) setDivision(false); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} className={BOT_GROUP_COMPOSER_INPUT}/>
        <div className={BOT_GROUP_COMPOSER_FOOTER}><div className="flex min-w-0 items-center gap-2"><DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}><DropdownMenuTrigger asChild><button type="button" aria-label={t('bots.groupChat.composer.more')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"><Plus size={16}/></button></DropdownMenuTrigger><DropdownMenuContent side="top" align="start" sideOffset={8} className="w-72"><WorkDivisionMenuItem blocked={deleting || Boolean(openPlan) || planning || Boolean(work.pending) || !work.data} writtenSteps={Boolean(writtenSteps)} onSelect={() => { setDivision(true); setMenuOpen(false); textarea.current?.focus(); }}/></DropdownMenuContent></DropdownMenu><span className="min-w-0 truncate text-12 text-[var(--text-tertiary)]">{active ? t(round?.status === 'stopping' || openPlan?.execution.state === 'stopping' ? 'paseoGroups.stopping' : workActive ? 'paseoWork.noteHint' : 'paseoGroups.supplementHint') : ''}</span></div><div onMouseDown={keepBotGroupComposerInputFocus(textarea)}><SendButton disabled={deleting || busy || Boolean(work.pending) || (planning && !showStop) || (!showStop && !text.trim()) || (showStop && (round?.status === 'stopping' || openPlan?.execution.state === 'stopping' || planningRequest?.code === 'STOP_REQUESTED'))} isStreaming={showStop} onClick={showStop ? stop : send}/></div></div>
      </div>
    </div></div>
    {settings && <GroupSettings group={data.group} onClose={() => setSettings(false)} onChanged={() => void refresh()} planSettings={work.data?.settings} planControl={work} planError={work.error}/>}
  </main>;
}
