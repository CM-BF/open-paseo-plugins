// Paseo data adapter around the original Cindy group header, bubbles and composer chrome.
// Extracted JSX/style provenance is recorded in group-upstream-files.json and SOURCE.md.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePlus2, Plus, Settings2 } from 'lucide-react';
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
import { GroupHistoryMessageView as Message, originalHistoryMessage } from './group-history-message';
import { useGroupPlans } from './adapters/group-plans';
import { WorkPlanMessage, WorkPlanFooter, WorkHandoffFiles } from './work-plan';
import { WorkDivisionTag, WorkDivisionMenuItem } from './work-composer';
import { openWorkArtifact } from './work-artifacts';
import { botGroupComposerPlanState } from '../vendor/shared/botGroupWorkPresentation';
import { resolveBotGroupMentions, splitBotGroupRelaySteps } from '../shared/vendor/botGroupMentions';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuItem } from '../vendor/renderer/components/ui/dropdown-menu';
import { executionErrorText, executionMessage } from '../shared/execution-notice';
import { GroupCleanupNotice } from './group-cleanup';
import type { GroupHistoryMessage } from '../shared/group-history';
import { useGroupHistory } from './group-history-store';
import { GroupHistoryThread } from './group-history-thread';
import { BotGroupThreadHint } from '../vendor/renderer/features/bots/BotGroupThreadHint';
import { BotGroupQuotePreview } from '../vendor/renderer/features/bots/BotGroupQuote';
import { botGroupQuoteFromMessage, resolveBotGroupQuote, type BotGroupQuoteView } from '../shared/vendor/botGroupQuote';
import { useThreadPanelResize } from '../vendor/renderer/features/bots/useThreadPanelResize';
import { findThreadMessageElement, flashThreadTarget } from '../vendor/renderer/features/bots/BotGroupThreadViews';

import { useGroupDraft } from './group-drafts';
import { useGroupUploads } from './group-uploads';
import { GroupComposerAttachments, UploadLeaveDialog } from './group-media-view';
import { acceptGroupOutbox, GroupOutboxRows, useGroupOutbox, type OutboxIntent } from './group-outbox';
import type { GroupOutboxEntry } from '../shared/group-outbox';
import type { GroupComposerDraft } from '../shared/group-drafts';

const busyRound = (status?: string) => ['queued', 'running', 'permission', 'stopping', 'unknown'].includes(status ?? '');

export function GroupChat({ groupId }: { groupId: string }) {
  const { t, i18n } = useTranslation();
  const { data, setData, error: readError, refresh } = useGroup(groupId);
  const work = useGroupPlans(groupId);
  const history = useGroupHistory(groupId, data?.messages ?? [], i18n.language);
  const [quote, setQuote] = useState<BotGroupQuoteView | null>(null);
  const [topic, setTopic] = useState<{rootId:string;focusMessageId?:string} | null>(null);
  const layout = useRef<HTMLDivElement>(null), topicOpener = useRef<HTMLElement | null>(null);
  const resize = useThreadPanelResize(layout, topic?.rootId ?? null, () => {});
  const historyRows = new Map(history.data?.messages.map(message => [message.id, message]) ?? []);
  const messages = (data?.messages ?? []).map(message => ({ ...message, ...historyRows.get(message.id) }));
  const sources = [...messages, ...(history.data?.quoteSources ?? [])] as GroupHistoryMessage[];
  const openTopic = (rootId:string, focusMessageId?:string) => { topicOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setTopic({rootId,focusMessageId}); };
  const closeTopic = () => { setTopic(null); topicOpener.current?.focus(); };
  const historyChanged = () => { history.refresh(); void refresh(); };
  const selectQuote = (message: GroupMessage & Partial<GroupHistoryMessage>) => { if (pendingEdit) return; setDivision(false); setQuote(botGroupQuoteFromMessage(originalHistoryMessage(message))); textarea.current?.focus(); };
  const locate = async (messageId:string) => {
    stick.current = false;
    const found = findThreadMessageElement(scroll.current, messageId);
    if (found) { flashThreadTarget(found); return; }
    let before = data?.messages[0]?.sequence;
    for (let page = 0; page < 8 && before; page++) {
      const next = await invoke<GroupSnapshot>('groups.get', { groupId, beforeSequence: before });
      if (!alive.current) return;
      setData(previous => previous ? { ...previous, messages: mergeMessages(next.messages, previous.messages), hasOlder: next.hasOlder } : next);
      if (next.messages.some(message => message.id === messageId)) {
        requestAnimationFrame(() => { if (alive.current) { const target = findThreadMessageElement(scroll.current, messageId); if (target) flashThreadTarget(target); } }); return;
      }
      const nextBefore = next.messages[0]?.sequence;
      if (!next.hasOlder || !nextBefore || nextBefore >= before) break;
      before = nextBefore;
    }
    if (alive.current) setError(t('bots.groupChat.server.thread.sourceUnavailable'));
  };
  const locateSafely = (messageId:string) => { void locate(messageId).catch(reason => { if (alive.current) setError(executionErrorText(reason)); }); };
  const [division, setDivision] = useState(false), [menuOpen, setMenuOpen] = useState(false), [workNotice, setWorkNotice] = useState('');
  const [text, setText] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [settings, setSettings] = useState(false);
  const lock = useRef(false), alive = useRef(true), textarea = useRef<HTMLTextAreaElement>(null), scroll = useRef<HTMLDivElement>(null), stick = useRef(true);
  const sendIntent = useRef<OutboxIntent | null>(null);
  const [pendingEdit, setPendingEdit] = useState<GroupComposerDraft['pendingEdit']>();
  const fileInput = useRef<HTMLInputElement>(null);
  const media = useGroupUploads(groupId);
  const [leaveOpen, setLeaveOpen] = useState(false), [leaving, setLeaving] = useState(false), [leaveError, setLeaveError] = useState('');
  const continueIntent = useRef<{ roundId: string; operationId: string } | null>(null);
  const members = useMemo(() => (data?.group.members ?? []) as BotGroupMemberView[], [data?.group.members]);
  const mention = useBotGroupMentionPicker({ text, onTextChange: setText, members, textareaRef: textarea, allLabels: ['all', 'everyone', '所有人', t('bots.groupChat.mention.all')] });
  const outbox = useGroupOutbox(groupId, () => { void refresh(); history.refresh(); work.refresh(); });
  const currentDraft = { text, trackedMentions: mention.tracked, quote, division, attachments: media.attachments, ...(sendIntent.current ? {intent:sendIntent.current} : {}), ...(pendingEdit ? {pendingEdit} : {}) };
  const draft = useGroupDraft(groupId, currentDraft, value => { setText(value.text); mention.setTracked(value.trackedMentions); setQuote(value.quote); setDivision(value.division); media.restore(value.attachments); sendIntent.current = value.intent ?? null; setPendingEdit(value.pendingEdit); });
  const leave = async () => { try { await draft.save(); if (alive.current) post('close'); } catch (reason) { if (alive.current) setError(executionErrorText(reason)); } };
  const editQueued = (entry: GroupOutboxEntry) => {
    if (!draft.ready || pendingEdit || text || media.uploads.length) { setError(t('paseoMedia.editBlocked')); return; }
    const source = entry.input.quote ? sources.find(value => value.id === entry.input.quote!.messageId) : undefined;
    const intent = {clientMessageId:entry.clientMessageId,operationId:crypto.randomUUID(),quote:source ? botGroupQuoteFromMessage(originalHistoryMessage(source)) : null};
    void action(() => restoreOutboxEdit(intent));
  };
  const restoreOutboxEdit = async (intent: NonNullable<GroupComposerDraft['pendingEdit']>) => {
    setPendingEdit(intent);
    // The parent process owns the recovery intent before the durable outbox relinquishes it.
    await draft.replace({...currentDraft,pendingEdit:intent});
    if (!alive.current) return;
    const result = await invoke<{accepted:true;entry:GroupOutboxEntry}>('groups.outbox.edit', {groupId,clientMessageId:intent.clientMessageId,operationId:intent.operationId});
    if (!alive.current) return;
    const entry = result.entry;
    if (!result.accepted || entry.groupId !== groupId || entry.clientMessageId !== intent.clientMessageId || entry.status !== 'discarded') throw new Error('The host did not confirm this draft transfer.');
    if (entry.input.quote && intent.quote?.messageId !== entry.input.quote.messageId) throw new Error('The quoted source of this draft could not be confirmed.');
    const restored: GroupComposerDraft = {text:entry.input.text,trackedMentions:entry.input.trackedMentions ?? [],quote:intent.quote,division:Boolean(entry.input.division),attachments:entry.attachments};
    await draft.replace(restored);
    if (!alive.current) return;
    setText(restored.text); mention.setTracked(restored.trackedMentions); setQuote(restored.quote); setDivision(restored.division); media.restore(restored.attachments); sendIntent.current = null; setPendingEdit(undefined);
    outbox.accept(entry); textarea.current?.focus();
  };
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
  const showStop = active && !text.trim() && !media.uploads.length;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (settings) return;
    const requested = () => { if (topic) closeTopic(); else if (media.pending) setLeaveOpen(true); else void leave(); };
    window.addEventListener('cindy-request-close', requested);
    return () => window.removeEventListener('cindy-request-close', requested);
  }, [settings, topic, media.pending, draft.ready]);
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
    if (!data || !draft.ready || pendingEdit || deleting || media.pending || (!text.trim() && !media.attachments.length) || planning || work.pending) return;
    const requested = text, trackedMentions = mention.tracked, selectedQuote = quote;
    const payload = { groupId, text: requested, trackedMentions, ...(selectedQuote ? {quote:{messageId:selectedQuote.messageId}} : {}), attachments:media.attachments.map(({mediaId}) => ({mediaId})), division };
    const signature = JSON.stringify(payload);
    if (sendIntent.current?.signature !== signature) sendIntent.current = {signature,clientMessageId:crypto.randomUUID(),operationId:crypto.randomUUID()};
    const intent = sendIntent.current;
    void action(async () => {
      // Save the immutable retry identity before submitting. A lost enqueue ACK
      // must survive leaving/reopening this iframe in the same app process.
      await draft.replace({...currentDraft,intent:{...intent,attempted:true}});
      if (!alive.current) return;
      const entry = await acceptGroupOutbox({...payload,clientMessageId:intent.clientMessageId},intent);
      if (!alive.current) return;
      outbox.accept(entry);
      if (entry.target?.kind === 'plan-note') setWorkNotice(t('paseoWork.noteQueued'));
      const empty = {text:'',trackedMentions:[],quote:null,division:false,attachments:[]};
      if (alive.current) { setText(''); setQuote(current => current === selectedQuote ? null : current); setDivision(false); media.accepted(); mention.reset(); sendIntent.current = null; history.refresh(); work.refresh(); stick.current = true; }
      await draft.replace(empty);
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
  return <div ref={layout} className="flex h-full min-w-0 flex-1 overflow-hidden"><main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface)] text-[var(--text-primary)]">
    <header className="flex h-14 shrink-0 items-center border-b border-[var(--border-default)] px-3"><div data-testid="bot-group-content-header" className="flex h-full w-full min-w-0 items-center gap-2 pr-2">
      <button type="button" onClick={() => setSettings(true)} title={members.map(value => value.name).join(', ')} className="flex min-w-0 items-center gap-2 rounded-xl px-2 py-1 text-left hover:bg-[var(--surface-hover)]"><BotGroupAvatarStack members={members}/><span className="flex min-w-0 flex-col"><span className="min-w-0 truncate text-13 font-medium leading-5 text-[var(--text-primary)]">{data.group.name}</span><span className="min-w-0 truncate text-11 leading-4 tabular-nums text-[var(--text-tertiary)]">{running ? `${running.botName} · ${t('paseoGroups.status.' + running.status)}` : t('bots.groupChat.memberCount', { count: members.length })}</span></span></button>
      <button type="button" aria-label={t('bots.groupChat.settings.title')} onClick={() => setSettings(true)} className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"><Settings2 size={15}/></button>
    </div></header>
    <div ref={scroll} data-testid="bot-group-timeline" onScroll={event => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; }} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-4"><div className="mx-auto flex w-full max-w-[760px] flex-col">
      {data.hasOlder && <div className="mb-2 flex justify-center"><Button variant="secondary" size="sm" compact loading={busy} onClick={older}>{t('bots.groupChat.timeline.loadEarlier')}</Button></div>}
      {!data.messages.length && !active && <div className="py-12 text-center"><p className="text-13 font-medium text-[var(--text-secondary)]">{t('bots.groupChat.timeline.emptyTitle')}</p><p className="mt-1 text-12 text-[var(--text-tertiary)]">{t('bots.groupChat.timeline.emptyDescription')}</p></div>}
      {messages.map((message, index) => <Fragment key={message.id}><Message groupId={groupId} message={message} previous={messages[index - 1]} members={data.group.members} locale={i18n.language} quoteSources={sources} historyEnabled={Boolean(history.data)} readOnly={Boolean(deleting)} onQuote={selectQuote} onThread={openTopic} onLocate={locateSafely} onChanged={historyChanged}
        files={message.planId && message.planStep !== undefined ? plans.filter(plan => plan.id === message.planId).map(plan => <WorkHandoffFiles key={plan.id} plan={plan} position={message.planStep!} message={message} onOpenArtifact={openWorkArtifact}/>) : plans.flatMap(plan => plan.steps.filter(step => step.resultMessageId === message.id).map(step => <WorkHandoffFiles key={plan.id + ':' + step.position} plan={plan} position={step.position} onOpenArtifact={openWorkArtifact} />))}/>
        {work.data && plans.filter(plan => plan.sourceMessageId === message.id).map(plan => <WorkPlanMessage key={plan.id} plan={plan} members={members} settings={work.data!.settings} control={work} locale={i18n.language} onOpenArtifact={openWorkArtifact} showFooter={false} />)}
        {plans.filter(plan => plan.status === 'done' && plan.steps.at(-1)?.resultMessageId === message.id).map(plan => <div key={plan.id} className="mt-3"><WorkPlanFooter plan={plan} members={members} control={work}/></div>)}
      </Fragment>)}
      <GroupOutboxRows outbox={outbox} groupId={groupId} readOnly={Boolean(deleting || busy || pendingEdit)} canEdit={entry => draft.ready && !pendingEdit && !text && !media.uploads.length && (!entry.input.quote || sources.some(value => value.id === entry.input.quote!.messageId))} onEdit={editQueued}/>
      {openPlan && work.data && !data.messages.some(message => message.id === openPlan.sourceMessageId) && <WorkPlanMessage plan={openPlan} members={members} settings={work.data.settings} control={work} locale={i18n.language} onOpenArtifact={openWorkArtifact} showFooter={false}/>}
      {openPlan && <div className="mt-3"><WorkPlanFooter plan={openPlan} members={members} control={work}/></div>}
      {work.data?.requests?.filter(request => request.status !== 'complete' || request.cleanupPending).map(request => <div key={request.id} className="mt-3 flex flex-wrap items-center justify-center gap-2 text-12 text-[var(--text-secondary)]"><p role={request.status === 'planning' ? 'status' : 'alert'}>{request.organizerName} · {request.status !== 'complete' && (executionMessage(request.code, i18n.language) || t(request.status === 'planning' ? 'paseoWork.planning' : request.status === 'unknown' ? 'paseoWork.execution.unknown' : 'paseoWork.planningFailed'))}{request.cleanupPending && <span className={request.status === 'complete' ? '' : 'block'}>{executionMessage(request.cleanupCode ?? 'CLEANUP_NOT_CONFIRMED', i18n.language)}</span>}</p>{request.agentId && <Button variant="secondary" tone="quiet" size="sm" compact onClick={() => post('navigate-agent', { agentId: request.agentId })}>{t('paseoGroups.openTask')}</Button>}{(['planning', 'unknown'].includes(request.status) || request.cleanupPending) && <Button variant="secondary" tone="quiet" size="sm" compact disabled={Boolean(work.pending) || (['planning', 'unknown'].includes(request.status) && request.code === 'STOP_REQUESTED')} onClick={() => void work.cancelRequest(request.id)}>{t(['complete', 'failed'].includes(request.status) ? 'paseoWork.confirmCleanup' : 'bots.groupChat.composer.stop')}</Button>}</div>)}
      {!!data.group.cleanupPending?.length && <div className="mt-3"><GroupCleanupNotice pending={data.group.cleanupPending} busy={busy} onConfirm={() => void action(async () => { await invoke('groups.cleanup', { groupId }); })}/></div>}
      {round?.status === 'waiting' && <div className="mt-3 flex justify-center"><Button variant="secondary" tone="quiet" size="sm" compact loading={busy} onClick={continueRound}>{t('bots.groupChat.timeline.continue')}</Button></div>}
    </div></div>
    {!!history.data?.threads.length && !deleting && <div className="relative h-0 shrink-0 px-5"><div className="pointer-events-none relative mx-auto h-0 w-full max-w-[760px] px-2"><BotGroupThreadHint threads={history.data.threads} members={members} openRootId={topic?.rootId ?? null} onOpen={openTopic}/></div></div>}
    {round?.code && <p role="status" className="px-5 text-center text-12 text-[var(--text-secondary)]">{executionMessage(round.code, i18n.language)}</p>}
    {recoveryStep?.agentId && <div className="px-5 text-center text-12 text-[var(--text-secondary)]"><Button variant="secondary" tone="quiet" size="sm" onClick={() => post('navigate-agent', { agentId: recoveryStep.agentId })}>{t(recoveryStep.status === 'permission' ? 'paseoGroups.reviewPermission' : 'paseoGroups.openTask')}</Button></div>}
    <div className={BOT_GROUP_COMPOSER_DOCK}><div className={BOT_GROUP_COMPOSER_COLUMN}>
      {deleting && <p role="status" className="mb-2 text-12 text-[var(--text-secondary)]">{t('paseoWork.deleting')}</p>}
      {history.error && <p role="alert" className="mb-2 text-13 text-[var(--error-fg)]">{history.error}</p>}
      {(error || readError || work.error || outbox.error || draft.error || media.error) && <p role="alert" className="mb-2 text-13 text-[var(--error-fg)]">{executionMessage(error || readError || work.error || outbox.error || draft.error || media.error, i18n.language)}</p>}
      {workNotice && <p role="status" className="mb-2 text-12 text-[var(--text-tertiary)]">{workNotice}</p>}
      {pendingEdit && <div role="status" className="mb-2 flex items-center gap-2 text-12 text-[var(--text-secondary)]"><span>{t('paseoMedia.editPending')}</span><Button variant="secondary" size="sm" compact disabled={!draft.ready || busy || deleting} onClick={() => { if (draft.ready && !deleting) void action(() => restoreOutboxEdit(pendingEdit)); }}>{t('paseoMedia.restoreEdit')}</Button></div>}
      {!!data.group.pendingReplies?.length && <div role="status" aria-live="polite" className="mb-2 flex flex-col gap-1 text-12 text-[var(--text-tertiary)]">{data.group.pendingReplies.map(pending => <p key={pending.id} data-pending-round-id={pending.id}>{t('paseoGroups.queuedReply', { names: pending.steps.map(step => step.botName).join(', ') })}</p>)}</div>}
      {mention.list}<div className={BOT_GROUP_COMPOSER_CARD} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (!deleting && draft.ready && !pendingEdit && !busy && event.dataTransfer.files.length) { event.preventDefault(); media.add(Array.from(event.dataTransfer.files)); } }}><div className="px-3"><GroupComposerAttachments groupId={groupId} uploads={media.uploads} remove={media.remove} retry={media.retry}/></div>{quote && <div className="px-3 pt-2"><BotGroupQuotePreview display={resolveBotGroupQuote(quote, sources.map(originalHistoryMessage))} onRemove={() => setQuote(null)}/></div>}{division && <WorkDivisionTag onRemove={() => { setDivision(false); textarea.current?.focus(); }}/>}<textarea ref={textarea} value={text} rows={1} maxLength={BOT_GROUP_MESSAGE_MAX_CHARS} readOnly={!draft.ready || Boolean(pendingEdit) || busy || Boolean(work.pending) || planning || deleting}
        aria-label={t('bots.groupChat.composer.label')} placeholder={placeholder} {...mention.textareaProps}
        onPaste={event => { if (!deleting && draft.ready && !pendingEdit && !busy && event.clipboardData.files.length) { event.preventDefault(); media.add(Array.from(event.clipboardData.files)); } }}
        onChange={event => { setWorkNotice(''); mention.onChange(event.target.value); }} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229 || mention.onKeyDown(event)) return; if (event.key === 'Backspace' && division && !text) setDivision(false); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} className={BOT_GROUP_COMPOSER_INPUT}/>
        <div className={BOT_GROUP_COMPOSER_FOOTER}><div className="flex min-w-0 items-center gap-2"><DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}><DropdownMenuTrigger asChild><button type="button" aria-label={t('bots.groupChat.composer.more')} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"><Plus size={16}/></button></DropdownMenuTrigger><DropdownMenuContent side="top" align="start" sideOffset={8} className="w-72"><DropdownMenuItem disabled={!draft.ready || Boolean(pendingEdit) || deleting || busy} onSelect={() => fileInput.current?.click()}><FilePlus2 size={16}/>{t('paseoMedia.add')}</DropdownMenuItem><WorkDivisionMenuItem blocked={Boolean(pendingEdit) || deleting || Boolean(openPlan) || planning || Boolean(work.pending) || !work.data} writtenSteps={Boolean(writtenSteps)} onSelect={() => { setDivision(true); setQuote(null); setMenuOpen(false); textarea.current?.focus(); }}/></DropdownMenuContent></DropdownMenu><span className="min-w-0 truncate text-12 text-[var(--text-tertiary)]">{active ? t(round?.status === 'stopping' || openPlan?.execution.state === 'stopping' ? 'paseoGroups.stopping' : workActive ? 'paseoWork.noteHint' : 'paseoGroups.supplementHint') : ''}</span></div><div onMouseDown={keepBotGroupComposerInputFocus(textarea)}><SendButton disabled={!draft.ready || (!showStop && Boolean(pendingEdit)) || media.pending || deleting || busy || Boolean(work.pending) || (planning && !showStop) || (!showStop && !text.trim() && !media.attachments.length) || (showStop && (round?.status === 'stopping' || openPlan?.execution.state === 'stopping' || planningRequest?.code === 'STOP_REQUESTED'))} isStreaming={showStop} onClick={showStop ? stop : send}/></div></div>
      </div>
    </div></div>
    <input ref={fileInput} type="file" multiple hidden onChange={event => { if (draft.ready && !pendingEdit && !deleting && !busy && event.target.files) media.add(Array.from(event.target.files)); event.target.value = ''; }}/>
    <UploadLeaveDialog open={leaveOpen} busy={leaving} error={leaveError} stay={() => setLeaveOpen(false)} leave={() => { if (leaving) return; setLeaving(true); setLeaveError(''); void media.cancelPending().then(() => leave()).catch(reason => { if (alive.current) setLeaveError(executionErrorText(reason)); }).finally(() => { if (alive.current) setLeaving(false); }); }}/>
    {settings && <GroupSettings group={data.group} onClose={() => setSettings(false)} onChanged={() => void refresh()} planSettings={work.data?.settings} planControl={work} planError={work.error}/>}
  </main>{topic && <GroupHistoryThread key={groupId + ':' + topic.rootId} groupId={groupId} rootId={topic.rootId} focusMessageId={topic.focusMessageId} members={data.group.members} readOnly={Boolean(deleting)} obscured={settings} onClose={closeTopic} onChanged={historyChanged} onRevealShare={locateSafely} resize={resize}/>}</div>;
}
