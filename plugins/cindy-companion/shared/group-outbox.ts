import type { BotGroupTrackedMention } from './groups';
import type { GroupAttachment } from './group-media';
export interface GroupOutboxInput {
  groupId: string; clientMessageId: string; text: string;
  trackedMentions?: BotGroupTrackedMention[]; quote?: { messageId: string };
  attachments?: Array<{ mediaId: string }>;
  division?: boolean;
}
export type GroupOutboxTarget =
  | { kind: 'message'; messageId: string; roundId?: string }
  | { kind: 'plan-request'; requestId: string; messageId?: string }
  | { kind: 'plan'; planId: string; messageId?: string }
  | { kind: 'plan-note'; planId: string; messageId: string };
export interface GroupOutboxEntry {
  clientMessageId: string; groupId: string; input: GroupOutboxInput; attachments: GroupAttachment[];
  sequence: number;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'unknown' | 'discarded';
  revision: number; createdAt: number; updatedAt: number;
  target?: GroupOutboxTarget; error?: { code: string; message: string };
  /** Retry only resubmits the same durable acceptance identity, never a new native prompt. */
  recovery: 'retry' | 'reconcile' | 'none';
}
export interface GroupOutboxPage { groupId: string; entries: GroupOutboxEntry[]; nextBefore: number | null }
/** A durable outbox begins only when the user presses Send. Unsent renderer drafts stay separate.
 * groups.outbox.enqueue (GroupOutboxInput & {operationId}) -> {accepted:true,entry:GroupOutboxEntry}
 *   Durable before returning; queued/sending is not delivered. Same clientMessageId is immutable.
 * groups.outbox.list {groupId,before?,limit?} -> GroupOutboxPage (byte/count bounded).
 * groups.outbox.reconcile {groupId,clientMessageId} -> {entry:GroupOutboxEntry}
 *   Read authoritative reception receipts, without a new native send or history-page guessing.
 * groups.outbox.retry {groupId,clientMessageId,operationId} -> {accepted:true,entry:GroupOutboxEntry}
 * groups.outbox.discard {groupId,clientMessageId,operationId} -> {entry:GroupOutboxEntry}
 *   Tombstone prevents retries; it does not retract a message already accepted by the host.
 * groups.outbox.edit {groupId,clientMessageId,operationId} -> {accepted:true,entry:GroupOutboxEntry}
 *   Confirmed failed reception only. Atomically transfers attachments back to the draft and
 *   tombstones the old entry. The next explicit send uses a new identity; unknown is never editable.
 * Unknown acceptance requires reconciliation; editing requires an explicit new user send.
 * Every mutation ACK retry keeps operationId. No automatic change of payload or operation identity.
 */
