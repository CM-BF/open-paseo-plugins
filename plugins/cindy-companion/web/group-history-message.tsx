// Retains the previously extracted Cindy group bubble layout; adds original history decorations.
import type { ReactNode } from 'react';
import { CornerDownRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GroupMessage, GroupSnapshot } from '../shared/groups';
import type { GroupHistoryMessage } from '../shared/group-history';
import type { BotGroupMessageView, BotGroupMemberView } from '../shared/vendor/botGroupChat';
import { isBotGroupMessageQuotable, resolveBotGroupQuote } from '../shared/vendor/botGroupQuote';
import { formatBotTimelineClock, formatBotTimelineDate, isSameBotTimelineDay } from '../vendor/shared/botTimeline';
import { BotAvatar } from '../vendor/renderer/features/bots/BotAvatar';
import { BotGroupQuoteBlock } from '../vendor/renderer/features/bots/BotGroupQuote';
import { BotGroupThreadPreview, BotGroupThreadShareQuote, botGroupThreadShareLabel } from '../vendor/renderer/features/bots/BotGroupThreadViews';
import { MarkdownRenderer } from './adapters/memory-markdown';
import { GroupTaskCard } from './group-task';
import { GroupHistoryActions, type HistoryMenuAction } from './group-history-actions';
import { GroupMessageAttachments } from './group-media-view';
import { executionMessage } from '../shared/execution-notice';
export function originalHistoryMessage(message: GroupMessage & Partial<GroupHistoryMessage>): BotGroupMessageView {
  return { ...message, authorBotId: message.authorBotId ?? null, mentions: message.mentions ?? { all: false, botIds: [] }, noticeCode: null,
    planId: message.planId ?? null, files: [], attachments: (message.attachments ?? []).map(item => ({...item,id:item.mediaId,url:null,path:null,state:'loading' as const})) };
}
export function GroupHistoryMessageView({ groupId, message, previous, members, locale, files, quoteSources = [], onQuote, onThread, onLocate, onChanged = () => {}, menuActions, footer, historyEnabled = false, readOnly = false }: {
  groupId: string; message: GroupMessage & Partial<GroupHistoryMessage>; previous?: GroupMessage; members: GroupSnapshot['group']['members']; locale: string; files?: ReactNode;
  quoteSources?: GroupHistoryMessage[]; onQuote?: (message: GroupMessage & Partial<GroupHistoryMessage>) => void; onThread?: (rootId: string, focusMessageId?: string) => void;
  onLocate?: (messageId: string) => void; onChanged?: () => void; menuActions?: HistoryMenuAction[]; footer?: ReactNode; historyEnabled?: boolean; readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const system = message.authorKind === 'system';
  const continued = !system && previous?.kind === 'message' && previous.authorKind === message.authorKind && previous.authorBotId === message.authorBotId
    && message.createdAt - previous.createdAt < 300_000 && isSameBotTimelineDay(previous.createdAt, message.createdAt);
  const member = members.find(value => value.botId === message.authorBotId);
  const original = originalHistoryMessage(message);
  const quote = message.quote ? <BotGroupQuoteBlock display={resolveBotGroupQuote(message.quote, quoteSources.map(originalHistoryMessage))} onLocate={onLocate ? () => onLocate(message.quote!.messageId) : undefined}/> : null;
  const body = message.deleted ? <p className="text-13 italic text-[var(--text-tertiary)]">{t('bots.groupChat.quote.deleted')}</p> : <>{quote}{message.threadShare ? <><p className="flex select-none items-center gap-1 text-12 text-[var(--text-tertiary)]"><CornerDownRight size={12} aria-hidden/>{botGroupThreadShareLabel(message.threadShare,t)}</p><BotGroupThreadShareQuote share={message.threadShare} members={members as BotGroupMemberView[]} attachments={null} onOpenThread={onThread ? () => onThread(message.threadShare!.threadRootId, message.threadShare!.messageId) : undefined} inset={message.authorKind !== 'user'}/></> : <MarkdownRenderer content={message.content}/>} {message.taskId && <GroupTaskCard groupId={groupId} message={message}/>} {files}<GroupMessageAttachments groupId={groupId} messageId={message.id} attachments={message.attachments ?? []} align={message.authorKind === 'user' ? 'right' : 'left'}/></>;
  const actions = historyEnabled && !system && !message.deleted ? <GroupHistoryActions groupId={groupId} message={original} members={members as BotGroupMemberView[]} revision={message.reactionRevision ?? message.historyRevision ?? 0} align={message.authorKind === 'user' ? 'right' : 'left'} onChanged={onChanged} onQuote={onQuote && isBotGroupMessageQuotable(original) ? () => onQuote(message) : undefined} onThread={onThread && !message.threadRootId && !message.threadShare ? () => onThread(message.id) : undefined} menuActions={menuActions} disabled={readOnly}/> : null;
  const preview = onThread && (message.replyCount ?? 0) > 0 ? <BotGroupThreadPreview message={original} members={members as BotGroupMemberView[]} onOpen={() => onThread(message.id)}/> : null;
  const clock = formatBotTimelineClock(message.createdAt, locale);
  return <>
    {(!previous || !isSameBotTimelineDay(previous.createdAt, message.createdAt)) && <div data-testid="bot-group-date-divider" className="mt-6 flex select-none justify-center first:mt-0"><span className="text-11 leading-4 text-[var(--text-tertiary)]">{formatBotTimelineDate(message.createdAt, locale)}</span></div>}
    <div data-bot-group-message-id={message.id} data-share-message-id={message.id} className={`rounded-lg outline-none transition-colors first:mt-0 ${continued ? 'mt-0.5' : system ? 'mt-3' : 'mt-3.5'}`}>
      {system ? <p className="select-none text-center text-12 leading-5 text-[var(--text-tertiary)]">{executionMessage({ code: message.code, message: message.content }, locale)}</p> : message.authorKind === 'user' ?
        <article className="group/message relative flex min-w-0 justify-end rounded-lg py-0.5"><div className="relative flex min-w-0 max-w-[min(720px,calc(100%-120px))] flex-col items-end gap-1.5 transition-opacity">{actions}<div data-testid="bot-group-self-bubble" className="relative flex max-w-full flex-col gap-2 rounded-xl border border-[var(--msg-user-border)] bg-[var(--msg-user-bg)] px-3.5 py-2 text-15 font-normal leading-[1.6] text-[var(--msg-user-text)]">{body}</div>{message.delivery === 'deferred' && <p role="status" className="max-w-full text-12 leading-5 text-[var(--text-tertiary)]">{t('paseoGroups.deferred')}</p>}{preview}{footer}</div></article> :
        <article className="group/message relative flex min-w-0 items-start gap-2.5 rounded-lg py-0.5">
          <div className="flex w-7 shrink-0 justify-end">{continued ? <time className="select-none pt-0.5 text-11 leading-5 tabular-nums text-[var(--text-tertiary)] opacity-0 group-hover/message:opacity-100">{clock}</time> : <BotAvatar bot={member ?? { name: message.authorName, avatar: null, avatarColor: null }} size="sm"/>}</div>
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">{!continued && <span className="flex min-w-0 max-w-full select-none items-baseline gap-1.5"><span className="min-w-0 truncate text-13 font-medium leading-5 text-[var(--text-primary)]">{member?.name ?? message.authorName}</span>{message.planStep !== undefined && <span className="inline-flex min-h-[18px] max-w-[12rem] shrink-0 select-none items-center truncate rounded-full bg-[var(--surface-chip)] px-1.5 py-px text-11 font-medium leading-tight text-[var(--text-secondary)]">{t('bots.groupChat.timeline.stepTag', { count: message.planStep + 1 })}</span>}<time className="shrink-0 text-11 tabular-nums text-[var(--text-tertiary)]">{clock}</time></span>}
            <div className="relative flex min-w-0 max-w-[min(720px,calc(100%-120px))] flex-col">{actions}<div data-testid="bot-group-bubble" className="relative flex min-w-0 max-w-full flex-col gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3.5 py-2.5 text-15 font-normal leading-[1.6] text-[var(--msg-assistant-text)]">{body}</div>{preview}{footer}</div>
          </div>
        </article>}
    </div>
  </>;
}
