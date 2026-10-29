/** Cindy 118767c group history semantics. Host-owned durable data, never frontend-authored snapshots. */
import type { GroupMessage, GroupRound, GroupSendInput } from './groups';
import type { BotGroupQuoteView, BotGroupThreadPreview, BotGroupThreadShareView, BotGroupThreadSummary,
  BotGroupThreadUnread, ChatReactor } from './vendor/botGroupChat';

export interface GroupHistoryMessage extends GroupMessage {
  /** Monotonic history revision at which this projection was read. */
  historyRevision: number;
  deleted?: boolean;
  isSelf?: boolean;
  threadRootId?: string | null;
  quote?: BotGroupQuoteView;
  replyCount?: number;
  threadPreview?: BotGroupThreadPreview;
  threadUnread?: BotGroupThreadUnread;
  threadShare?: BotGroupThreadShareView;
  reactions?: Array<{ emoji: string; count: number; me: boolean }>;
  reactionRevision?: number;
}
export interface GroupHistorySnapshot {
  groupId: string;
  revision: number;
  /** A byte-bounded page of requested IDs (or latest main messages when omitted). */
  messages: GroupHistoryMessage[];
  /** Authoritative main-message originals referenced by the returned messages. */
  quoteSources: GroupHistoryMessage[];
  /** Only summaries whose roots are in this page; excerpts are bounded, message bodies are not. */
  threads: BotGroupThreadSummary[];
  /** Continue with the same messageIds and this exclusive sequence cursor. */
  nextBeforeSequence: number | null;
}
export interface GroupThreadSnapshot {
  groupId: string;
  rootId: string;
  revision: number;
  root: GroupHistoryMessage;
  replies: GroupHistoryMessage[];
  quoteSources: GroupHistoryMessage[];
  hasMore: boolean;
  nextBeforeSequence: number | null;
  /** Read cursor BEFORE an optional successful markRead, for the new-replies divider. */
  readBefore: number | null;
  following: boolean;
  round: GroupRound | null;
  pendingReplies?: GroupRound[];
  /** Main-message IDs keyed by reply ID; source identity is validated by the service. */
  sharedReplies: Record<string, { messageId: string; bySelf: boolean }>;
}
export interface GroupQuotedSendInput extends GroupSendInput { quote: { messageId: string } }
export interface GroupThreadReplyInput extends GroupSendInput { rootId: string }
export interface GroupHistorySendReceipt {
  accepted: true;
  message: GroupHistoryMessage;
  round: GroupRound | null;
}
export interface GroupHistoryMutationReceipt { accepted: true; revision: number }
export type GroupReactors = { reactors: ChatReactor[]; revision: number };

/** All operations use the existing settings.invoke envelope; no botId or caller-chosen actorId.
 * groups.history.get {groupId,messageIds?:string[],beforeSequence?:number} -> GroupHistorySnapshot (IDs <= 500).
 *   Explicit IDs never force unrelated latest messages. Follow nextBeforeSequence to receive all
 *   requested IDs; responses fit 1.7 MB of UTF-8 JSON and never truncate message bodies.
 * groups.history.send GroupQuotedSendInput -> GroupHistorySendReceipt.
 *   Same clientMessageId + immutable text/mentions/quote retries replay the receipt. The service
 *   reads a live main original before first send, then freezes quote/recipients across lost ACKs.
 * groups.threads.get {groupId,rootId,beforeSequence?,markRead?:boolean} -> GroupThreadSnapshot.
 *   Reply page <= 50 and byte-bounded; follow nextBeforeSequence for older replies. markRead only on the newest page, UI visible/focused/at bottom. Projection validation precedes read-cursor commit.
 * groups.threads.reply GroupThreadReplyInput -> GroupHistorySendReceipt.
 *   Text/mentions only, as in the original. Separate owned lane/context for root + its replies.
 * groups.threads.follow {groupId,rootId,following,operationId} -> {following,revision}.
 * groups.threads.shareToMain {groupId,rootId,messageId,operationId}
 *   -> {messageId:string,alreadyShared:boolean,revision:number}; durable one share per self/reply.
 *   This stores a verified reference, never triggers a new group round or copies caller text.
 * groups.history.react {groupId,messageId,emoji,present,operationId} -> GroupHistoryMutationReceipt.
 * groups.history.reactors {groupId,messageId,emoji} -> GroupReactors.
 * groups.threads.stop {groupId,rootId,roundId,operationId} -> {accepted:true,round:GroupRound}.
 * groups.threads.continue {groupId,rootId,roundId,operationId} -> {accepted:true,round:GroupRound}.
 *   Existing atomic admission/exact-turn cancellation/unknown recovery semantics remain intact.
 * Unknown or unsupported operations reject explicitly; the UI never fills in fake success/data.
 * Accounts/multi-person sharing, user attachments and durable composer outbox are separate work.
 */
