// Compact action JSX/tokens extracted from Cindy MessageActionBar and ChatServerControls (118767c).
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Ellipsis, MessagesSquare, SmilePlus } from 'lucide-react';
import { BubbleHoverToolbar } from '../vendor/renderer/components/chat/BubbleHoverToolbar';
import { ChatReplyIcon } from '../vendor/renderer/components/chat/ChatReplyIcon';
import { CHAT_COLOR_TRANSITION_CLASS, CHAT_ICON_BUTTON_CLASS } from '../vendor/renderer/components/chat/chatChrome';
import { ChatReactionButton } from '../vendor/renderer/features/bots/ChatReactionButton';
import { Tip } from '../vendor/renderer/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '../vendor/renderer/components/ui/popover';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../vendor/renderer/components/ui/dropdown-menu';
import { MENU_ITEM_CLASS } from '../vendor/renderer/features/cc-agent/sidebar/menuStyles';
import { cn } from '../vendor/renderer/lib/utils';
import { formatAbsolute } from '../vendor/renderer/hooks/useRelativeTime';
import type { BotGroupMemberView, BotGroupMessageView } from '../shared/vendor/botGroupChat';
import { useHistoryMutations } from './group-history-store';

const emojis = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '✅', '🤔', '🔥', '👏', '🚀', '💯'];
const actionButtonClass = cn(CHAT_ICON_BUTTON_CLASS, 'group h-6 w-6 border-none bg-transparent', 'enabled:hover:bg-[var(--cmd-palette-item-hover)]');
const actionIconClass = cn(CHAT_COLOR_TRANSITION_CLASS, 'text-[var(--cmd-palette-item-meta)] group-hover:text-[var(--msg-assistant-text)]');
export type HistoryMenuAction = { key: string; label: string; icon: ReactNode; onSelect(): void; disabled?: boolean };

export function GroupHistoryActions({ groupId, message, members, revision, align, onChanged, onQuote, onThread, menuActions = [], disabled = false }: {
  groupId: string; message: BotGroupMessageView; members: BotGroupMemberView[]; revision: number;
  align: 'left' | 'right'; onChanged(): void; onQuote?: () => void; onThread?: () => void;
  menuActions?: HistoryMenuAction[]; disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [picker, setPicker] = useState(false), [menu, setMenu] = useState(false), [copyError, setCopyError] = useState('');
  const pointer = useRef(false);
  const mutation = useHistoryMutations(onChanged, i18n.language);
  const busy = mutation.pending.length > 0 || disabled;
  const react = (emoji: string, present: boolean) => { setPicker(false); void mutation.run('reaction', 'groups.history.react', { groupId, messageId: message.id, emoji, present }); };
  const quoteLabel = t('bots.groupChat.server.quoteReply');
  const threadLabel = t(message.replyCount ? 'bots.groupChat.server.openTopic' : 'bots.groupChat.server.startTopic', { count: message.replyCount });
  const reactionLabel = t('bots.groupChat.server.addReaction');
  const copyText = message.threadShare ? message.threadShare.status === 'available' ? message.threadShare.content : '' : message.content;
  return <>
    {!!message.reactions?.length && <div data-share-exclude="" data-reaction-corner={align} className={cn('flex items-center gap-1 relative z-[5] -mb-2 max-w-[calc(100%+10px)] flex-wrap', align === 'right' ? 'self-start -ml-2.5 flex-row-reverse' : 'self-end -mr-2.5 justify-end')}>
      {message.reactions.map(reaction => <ChatReactionButton key={reaction.emoji} groupId={groupId} messageId={message.id} reaction={reaction} revision={revision} members={members} corner disabled={busy} onToggle={() => react(reaction.emoji, !reaction.me)}/>)}
    </div>}
    <BubbleHoverToolbar marker="data-bot-group-message-actions" side={align === 'right' ? 'left' : 'right'} open={picker || menu} besideReactions={Boolean(message.reactions?.length)}>
      <div data-share-exclude="" className={cn('flex flex-wrap items-center gap-0.5', align === 'right' ? 'justify-end' : 'justify-start')}>
        {onQuote && <Tip text={quoteLabel}><button type="button" disabled={disabled} className={actionButtonClass} aria-label={quoteLabel} onClick={event => { event.stopPropagation(); onQuote(); }}><ChatReplyIcon size={14} strokeWidth={2} className={actionIconClass}/></button></Tip>}
        {onThread && <Tip text={threadLabel}><button type="button" disabled={disabled} className={actionButtonClass} aria-label={threadLabel} onClick={event => { event.stopPropagation(); onThread(); }}><MessagesSquare size={14} strokeWidth={2} className={actionIconClass}/></button></Tip>}
        <Popover open={picker} onOpenChange={setPicker}><Tip text={reactionLabel}><PopoverTrigger asChild><button type="button" disabled={busy} className={actionButtonClass} aria-label={reactionLabel} onClick={event => event.stopPropagation()}><SmilePlus size={14} strokeWidth={2} className={actionIconClass}/></button></PopoverTrigger></Tip><PopoverContent align={align === 'right' ? 'end' : 'start'} className="z-[80] w-fit p-2" aria-label={reactionLabel}><div className="grid grid-cols-6 gap-1">{emojis.map(emoji => <button type="button" key={emoji} disabled={busy} aria-label={emoji} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50" onClick={() => react(emoji, !message.reactions?.some(value => value.emoji === emoji && value.me))}>{emoji}</button>)}</div></PopoverContent></Popover>
        <DropdownMenu open={menu} onOpenChange={setMenu}><DropdownMenuTrigger asChild><Tip text={t('chat.messageActionBar.moreActions')}><button type="button" className={cn(actionButtonClass, 'data-[state=open]:bg-[var(--cmd-palette-item-hover)]')} aria-label={t('chat.messageActionBar.moreActions')} onClick={event => event.stopPropagation()} onPointerDown={() => { pointer.current = true; }} onKeyDown={() => { pointer.current = false; }}><Ellipsis size={14} strokeWidth={2} className={actionIconClass}/></button></Tip></DropdownMenuTrigger>
          <DropdownMenuContent align={align === 'left' ? 'start' : 'end'} sideOffset={4} className="min-w-[184px]" onPointerDownCapture={() => { pointer.current = true; }} onPointerDownOutside={() => { pointer.current = true; }} onKeyDownCapture={() => { pointer.current = false; }} onCloseAutoFocus={event => { if (pointer.current) event.preventDefault(); }}>
            <DropdownMenuItem className={MENU_ITEM_CLASS} onSelect={() => { setCopyError(''); void Promise.resolve().then(() => navigator.clipboard.writeText(copyText)).catch(() => setCopyError(i18n.language.startsWith('zh') ? '当前浏览器不允许复制，请手动选中文本。' : 'Copy is unavailable in this browser. Select the text to copy it.')); }}><Copy size={14} strokeWidth={2} className="shrink-0"/>{t('chat.messageActionBar.copy')}</DropdownMenuItem>
            {menuActions.map(action => <DropdownMenuItem key={action.key} disabled={disabled || action.disabled} className={MENU_ITEM_CLASS} onSelect={event => { event.stopPropagation(); action.onSelect(); }}>{action.icon}{action.label}</DropdownMenuItem>)}
            <div className="px-2 py-1 text-12 text-[var(--text-tertiary)]">{formatAbsolute(new Date(message.createdAt).toISOString())}</div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </BubbleHoverToolbar>
    {(mutation.error || copyError) && <p role="alert" className="mt-1 text-12 text-[var(--error-fg)]">{mutation.error || copyError}</p>}
  </>;
}
