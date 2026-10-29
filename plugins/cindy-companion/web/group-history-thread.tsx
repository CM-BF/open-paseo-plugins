// Original ThreadPanel + ChatThreadPanel layout, with host-owned durable RPCs replacing Chat Server.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, BellRing, Check, CornerDownRight, MessageSquareShare } from 'lucide-react';
import type { GroupSnapshot, GroupRound, BotGroupTrackedMention } from '../shared/groups';
import type { GroupHistorySendReceipt, GroupThreadSnapshot } from '../shared/group-history';
import type { BotGroupMemberView } from '../shared/vendor/botGroupChat';
import { ThreadPanel, ThreadPanelRoot } from '../vendor/renderer/features/bots/ThreadPanel';
import type { ThreadPanelResize } from '../vendor/renderer/features/bots/useThreadPanelResize';
import { findThreadMessageElement, flashThreadTarget } from '../vendor/renderer/features/bots/BotGroupThreadViews';
import { Button } from '../vendor/renderer/components/ui/button';
import { Spinner } from '../vendor/renderer/components/ui/spinner';
import { Tip } from '../vendor/renderer/components/ui/tooltip';
import { SendButton } from '../vendor/renderer/components/new-chat/SendButton';
import { useBotGroupMentionPicker } from '../vendor/renderer/features/bots/useBotGroupMentionPicker';
import { BOT_GROUP_COMPOSER_CARD, BOT_GROUP_COMPOSER_DOCK, BOT_GROUP_COMPOSER_INPUT, BOT_GROUP_COMPOSER_FOOTER, fitBotGroupComposerInput, useRefitBotGroupComposerInputOnResize } from '../vendor/renderer/features/bots/botGroupComposerChrome';
import { cn } from '../vendor/renderer/lib/utils';
import { invoke, post, initValue } from './bridge';
import { historyError } from './group-history-rpc';
import { mergeHistoryMessages, observeHistory, useHistoryMutations } from './group-history-store';
import { GroupHistoryMessageView } from './group-history-message';
import { executionMessage } from '../shared/execution-notice';

type Draft = { text: string; alsoSend: boolean; tracked: BotGroupTrackedMention[];
  attempt?: { signature: string; clientMessageId: string }; unposted: string[] };
// Same iframe reopening retains the draft and lost-ACK ID; durable outbox is a separate next wave.
const drafts = new Map<string, Draft>();
const activeRound = (round: GroupRound | null | undefined) => ['queued', 'running', 'permission', 'stopping', 'unknown'].includes(round?.status ?? '');
const visible = () => typeof document !== 'undefined' && document.visibilityState !== 'hidden' && document.hasFocus();

export function GroupHistoryThread({ groupId, rootId, focusMessageId, members, readOnly, obscured = false, onClose, onChanged, onRevealShare, resize }: {
  groupId: string; rootId: string; focusMessageId?: string; members: GroupSnapshot['group']['members']; readOnly: boolean;
  onClose(): void; onChanged(): void; onRevealShare(messageId: string): void; resize?: ThreadPanelResize; obscured?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const draftKey = `${initValue()?.host.id ?? ''}\u0000${groupId}\u0000${rootId}`;
  if (!drafts.has(draftKey)) drafts.set(draftKey, { text: '', alsoSend: false, tracked: [], unposted: [] });
  const draft = drafts.get(draftKey)!;
  const [text, setText] = useState(draft.text), [alsoSend, setAlsoSend] = useState(draft.alsoSend), [unposted, setUnposted] = useState(draft.unposted);
  const [data, setData] = useState<GroupThreadSnapshot | null>(null), [error, setError] = useState(''), [sending, setSending] = useState(false), [olderBusy, setOlderBusy] = useState(false);
  const alive = useRef(true), sendingRef = useRef(false), olderLock = useRef(false), stick = useRef(true), scroll = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null), textarea = useRef<HTMLTextAreaElement>(null);
  const observer = useRef<ReturnType<typeof observeHistory<GroupThreadSnapshot>> | null>(null);
  const canRead = useRef(!readOnly && !obscured); canRead.current = !readOnly && !obscured;
  const merge = (value: GroupThreadSnapshot) => {
    if (value.groupId !== groupId || value.rootId !== rootId) throw new Error('The host returned another topic.');
    setData(previous => !previous ? value : value.revision < previous.revision ? previous : { ...value,
      readBefore: previous.readBefore, replies: mergeHistoryMessages(previous.replies, value.replies),
      sharedReplies: { ...previous.sharedReplies, ...value.sharedReplies },
      nextBeforeSequence: previous.replies[0]?.sequence < (value.replies[0]?.sequence ?? Infinity) ? previous.nextBeforeSequence : value.nextBeforeSequence,
      hasMore: previous.replies[0]?.sequence < (value.replies[0]?.sequence ?? Infinity) ? previous.hasMore : value.hasMore });
  };
  const refresh = () => { observer.current?.refresh(); onChanged(); };
  const mutation = useHistoryMutations(refresh, i18n.language);
  const mention = useBotGroupMentionPicker({ text, onTextChange: value => { draft.text = value; setText(value); }, members: members as BotGroupMemberView[], textareaRef: textarea,
    allLabels: ['all', 'everyone', '所有人', t('bots.groupChat.mention.all')] });
  const restoredMentions = useRef(draft.tracked);
  useEffect(() => { mention.setTracked(restoredMentions.current); }, []);
  useEffect(() => { draft.tracked = mention.tracked; }, [mention.tracked]);
  useEffect(() => {
    alive.current = true;
    const next = observeHistory(() => invoke<GroupThreadSnapshot>('groups.threads.get', { groupId, rootId, markRead: canRead.current && stick.current && visible() }),
      value => { merge(value); setError(''); }, reason => setError(historyError(reason, i18n.language)));
    observer.current = next;
    const focus = () => { if (visible()) next.refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { alive.current = false; next.dispose(); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [groupId, rootId]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key !== 'Escape' || event.defaultPrevented || !panel.current?.contains(document.activeElement)) return;
      if (document.querySelector('[role="dialog"], [data-radix-popper-content-wrapper]')) return;
      event.preventDefault(); event.stopPropagation(); onClose(); };
    panel.current?.addEventListener('keydown', escape); const element = panel.current;
    return () => element?.removeEventListener('keydown', escape);
  }, [onClose]);
  useLayoutEffect(() => { if (textarea.current) fitBotGroupComposerInput(textarea.current); }, [text]);
  useRefitBotGroupComposerInputOnResize(textarea);
  useLayoutEffect(() => { if (scroll.current && stick.current && !focusMessageId) scroll.current.scrollTop = scroll.current.scrollHeight; }, [data?.replies, focusMessageId]);
  const loadEarlier = async () => {
    if (olderLock.current || !data?.replies.length) return false;
    stick.current = false;
    olderLock.current = true; setOlderBusy(true);
    try {
      const value = await invoke<GroupThreadSnapshot>('groups.threads.get', { groupId, rootId, beforeSequence: data.nextBeforeSequence ?? data.replies[0].sequence, markRead: false });
      if (!alive.current) return false;
      if (value.groupId !== groupId || value.rootId !== rootId) throw new Error('The host returned another topic.');
      setData(previous => previous ? { ...previous, revision: Math.max(previous.revision, value.revision), replies: mergeHistoryMessages(value.replies, previous.replies), sharedReplies: { ...value.sharedReplies, ...previous.sharedReplies }, nextBeforeSequence: value.nextBeforeSequence, hasMore: value.hasMore } : value);
      return true;
    } catch (reason) { if (alive.current) setError(historyError(reason, i18n.language)); return false; }
    finally { olderLock.current = false; if (alive.current) setOlderBusy(false); }
  };
  const located = useRef(''), pages = useRef(0);
  useEffect(() => {
    if (!focusMessageId || !data || located.current === focusMessageId) return;
    stick.current = false;
    const target = findThreadMessageElement(scroll.current, focusMessageId);
    if (target) { located.current = focusMessageId; flashThreadTarget(target); return; }
    if (data.hasMore && pages.current++ < 8) { void loadEarlier(); return; }
    located.current = focusMessageId; setError(t('bots.groupChat.server.thread.sourceUnavailable'));
  }, [data, focusMessageId]);
  const share = async (messageId: string) => {
    const receipt = await mutation.run<{ messageId: string }>(`share:${messageId}`, 'groups.threads.shareToMain', { groupId, rootId, messageId });
    if (!alive.current) return;
    draft.unposted = receipt ? draft.unposted.filter(id => id !== messageId) : [...new Set([...draft.unposted, messageId])]; setUnposted([...draft.unposted]);
  };
  const send = async () => {
    if (readOnly || !data || sendingRef.current || !text.trim()) return;
    const requested = text, trackedMentions = mention.tracked, toMain = alsoSend;
    const signature = JSON.stringify({ text: requested, trackedMentions });
    if (draft.attempt?.signature !== signature) draft.attempt = { signature, clientMessageId: crypto.randomUUID() };
    sendingRef.current = true; setSending(true); setError('');
    try {
      const receipt = await invoke<GroupHistorySendReceipt>('groups.threads.reply', { groupId, rootId, text: requested, trackedMentions, clientMessageId: draft.attempt.clientMessageId });
      if (!alive.current) return;
      if (receipt.message.threadRootId !== rootId) throw new Error('The host returned another topic reply.');
      setData(previous => previous ? { ...previous, replies: mergeHistoryMessages(previous.replies, [receipt.message]) } : previous);
      if (draft.text === requested) { draft.text = ''; setText(''); mention.reset(); draft.attempt = undefined; }
      draft.alsoSend = false; setAlsoSend(false); stick.current = true; refresh();
      if (toMain) await share(receipt.message.id);
    } catch (reason) { if (alive.current) setError(historyError(reason, i18n.language)); }
    finally { sendingRef.current = false; if (alive.current) setSending(false); }
  };
  const round = data?.round, active = activeRound(round);
  const running = round?.steps.find(step => ['running', 'permission', 'unknown'].includes(step.status)) ?? (round?.code ? round.steps[round.position] : undefined);
  const stop = () => { if (!readOnly && round) void mutation.run('stop', 'groups.threads.stop', { groupId, rootId, roundId: round.id }); };
  const firstNew = data?.readBefore == null ? undefined : data.replies.findIndex(message => message.sequence > data.readBefore! && message.authorKind !== 'user' && message.authorKind !== 'system' && !message.deleted);
  return <ThreadPanel panelRef={panel} rootClientId={rootId} resize={resize} onClose={onClose} actions={data && <Tip text={t(`bots.groupChat.server.thread.${data.following ? 'unfollowTip' : 'followTip'}`)}><Button variant="secondary" tone="quiet" size="sm" aria-pressed={data.following} data-thread-follow="" className={cn('gap-1.5 px-2.5', data.following ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')} loading={mutation.pending.includes('follow')} disabled={readOnly} onClick={() => void mutation.run('follow', 'groups.threads.follow', { groupId, rootId, following: !data.following })}>{data.following ? <BellRing size={14}/> : <Bell size={14}/>} {t(`bots.groupChat.server.thread.${data.following ? 'following' : 'follow'}`)}</Button></Tip>}>
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-3" onScroll={event => { const element = event.currentTarget, before = stick.current; stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; if (!before && stick.current) refresh(); }}>
      {!data ? <div className="flex justify-center py-6">{error ? <Button variant="secondary" onClick={refresh}>{t('bots.retry')}</Button> : <Spinner size={18}/>}</div> : <div className="flex min-w-0 flex-col">
        <ThreadPanelRoot replyCount={data.root.replyCount} testId="bot-group-thread-replies"><GroupHistoryMessageView groupId={groupId} message={data.root} members={members} locale={i18n.language} quoteSources={data.quoteSources} historyEnabled onChanged={refresh} readOnly={readOnly}/></ThreadPanelRoot>
        {data.hasMore && <div className="mt-2"><Button variant="secondary" size="sm" loading={olderBusy} onClick={() => void loadEarlier()}>{t('bots.groupChat.timeline.loadEarlier')}</Button></div>}
        {data.replies.map((message, index) => { const shared = data.sharedReplies[message.id]; return <Fragment key={message.id}>
          {firstNew !== undefined && firstNew > 0 && index === firstNew && <div data-testid="bot-group-thread-new-replies" className="mt-3 flex select-none items-center gap-3 text-12 font-medium text-[var(--text-primary)]"><span className="flex shrink-0 items-center gap-1.5"><span className="size-1.5 rounded-full bg-[var(--bot-unread-bg)]"/>{t('bots.groupChat.server.thread.newSeparator')}</span><span className="h-px flex-1 bg-[var(--border-default)]"/></div>}
          <GroupHistoryMessageView groupId={groupId} message={message} previous={data.replies[index - 1]} members={members} locale={i18n.language} historyEnabled onChanged={refresh} readOnly={readOnly} menuActions={message.deleted || message.kind !== 'message' ? [] : [{ key: shared?.bySelf ? 'reveal-in-main' : 'post-to-main', label: t(`bots.groupChat.server.thread.${shared?.bySelf ? 'viewInMain' : 'postToMain'}`), icon: shared?.bySelf ? <CornerDownRight size={14}/> : <MessageSquareShare size={14}/>, disabled: mutation.pending.includes(`share:${message.id}`), onSelect: () => shared?.bySelf ? onRevealShare(shared.messageId) : void share(message.id) }]} footer={shared && <button type="button" onClick={() => onRevealShare(shared.messageId)} className="-ml-1.5 inline-flex min-h-6 select-none items-center gap-1 self-start rounded-full px-1.5 text-12 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]"><CornerDownRight size={12}/>{t(`bots.groupChat.server.thread.${shared.bySelf ? 'postedBySelf' : 'postedToMain'}`)}</button>}/>
        </Fragment>; })}
      </div>}
    </div>
    {(error || mutation.error) && <p role="alert" className="px-4 pt-3 text-13 text-[var(--error-fg)]">{error || mutation.error}</p>}
    {!!unposted.length && <div role="alert" className="mb-2 flex flex-wrap items-center gap-2 px-4 text-13 text-[var(--error-fg)]"><span>{t('bots.groupChat.server.thread.alsoSendFailed', { count: unposted.length })}</span><Button variant="secondary" size="sm" compact disabled={readOnly || mutation.pending.some(key => key.startsWith('share:'))} onClick={() => { for (const id of unposted) void share(id); }}>{t('bots.groupChat.server.thread.retryPost')}</Button></div>}
    {round?.code && <p role="status" className="px-4 text-12 text-[var(--text-secondary)]">{executionMessage(round.code, i18n.language)}</p>}
    {running?.agentId && <Button variant="secondary" tone="quiet" size="sm" onClick={() => post('navigate-agent', { agentId: running.agentId })}>{t('paseoGroups.openTask')}</Button>}
    {active && <Button variant="secondary" tone="quiet" size="sm" disabled={readOnly || mutation.pending.includes('stop') || round?.status === 'stopping'} onClick={stop}>{t('bots.groupChat.composer.stop')}</Button>}
    {round?.status === 'waiting' && <Button variant="secondary" tone="quiet" size="sm" disabled={readOnly || mutation.pending.includes('continue')} onClick={() => { if (!readOnly) void mutation.run('continue', 'groups.threads.continue', { groupId, rootId, roundId: round.id }); }}>{t('bots.groupChat.timeline.continue')}</Button>}
    <div className="border-t border-[var(--border-default)]"><div className={cn(BOT_GROUP_COMPOSER_DOCK, 'px-4')}>{mention.list}<div className={BOT_GROUP_COMPOSER_CARD}>
      <textarea ref={textarea} rows={1} maxLength={8000} value={text} readOnly={readOnly || sending || !data} aria-label={t('bots.groupChat.composer.label')} placeholder={t('bots.groupChat.server.sendReply')} {...mention.textareaProps} onChange={event => mention.onChange(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing || event.keyCode === 229 || mention.onKeyDown(event)) return; if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} className={BOT_GROUP_COMPOSER_INPUT}/>
      <div className={BOT_GROUP_COMPOSER_FOOTER}><button type="button" role="checkbox" aria-checked={alsoSend} disabled={sending || readOnly || !data} onClick={() => { draft.alsoSend = !alsoSend; setAlsoSend(!alsoSend); }} className="-ml-1.5 inline-flex min-h-7 min-w-0 select-none items-center gap-2 rounded-full px-1.5 text-13 text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"><span aria-hidden className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full', alsoSend ? 'bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]' : 'border border-[var(--border-default)]')}>{alsoSend && <Check size={10} strokeWidth={3}/>}</span><span className="min-w-0 truncate">{t('bots.groupChat.server.thread.alsoSend')}</span></button><SendButton disabled={readOnly || sending || !text.trim() || !data} isStreaming={false} onClick={() => void send()}/></div>
    </div></div></div>
  </ThreadPanel>;
}
