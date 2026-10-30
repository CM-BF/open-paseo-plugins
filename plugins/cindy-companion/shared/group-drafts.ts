import type { BotGroupTrackedMention } from './groups';
import type { GroupAttachment } from './group-media';
import type { BotGroupQuoteView } from './vendor/botGroupQuote';

/** Unsent UI state lives only in the selected app process, like Cindy's owner Map. */
export interface GroupComposerDraft {
  text: string;
  trackedMentions: BotGroupTrackedMention[];
  quote: BotGroupQuoteView | null;
  division: boolean;
  attachments: GroupAttachment[];
  intent?: { signature: string; clientMessageId: string; operationId: string; attempted?: boolean };
  /** Persist before relinquishing the failed outbox entry; a lost ACK replays this exact edit. */
  pendingEdit?: { clientMessageId: string; operationId: string; quote: BotGroupQuoteView | null };
  topic?: { alsoSend: boolean; unposted: string[]; attempt?: { signature: string; clientMessageId: string } };
}
export interface GroupDraftSnapshot { generation: number; draft: GroupComposerDraft | null }
