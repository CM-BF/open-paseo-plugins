import { z } from "zod";
import { CommentsSchema, COMMENT_LIMIT, IdSchema, SideContextSchema, type BoardComment, type Interaction, type SideContext } from "../shared/contracts";
import type { DraftStorage, DraftStore, StoredDraft } from "./draft-store";
import { browserDraftStorage } from "./draft-storage-web";
import { withBatchPreparationLock, type BatchLockManager } from "./batch-lock-web";

const PREFIX = "@paseo:board-comment-batches:v1:";
const BATCH_READ_LIMIT = 12000000;
const BatchSchema = z.object({
  intentId: IdSchema, destination: z.enum(["main", "side", "new-side"]),
  sideContext: SideContextSchema.optional(),
  expectedCreatedAt: z.string().min(1).max(100).optional(),
  text: z.string().min(1).max(24000), comments: CommentsSchema,
  drafts: z.array(z.object({ id: IdSchema, revision: IdSchema })).min(1).max(COMMENT_LIMIT),
  createdAt: z.number().finite().nonnegative(),
}).refine(value => value.drafts.length === value.comments.length && value.drafts.every((draft, index) => draft.id === value.comments[index].id), "Batch sources must match every comment");
export type CommentBatch = z.infer<typeof BatchSchema>;
type Result = { ok: true } | { ok: false; message: string };
const listeners = new Set<{ scope: string; notify(): void }>();

export function batchContainsDraft(batch: CommentBatch, draft: Pick<StoredDraft, "id" | "revision">): boolean {
  return batch.drafts.some(item => item.id === draft.id && item.revision === draft.revision);
}
export function queuedDrafts(drafts: StoredDraft[], batches: CommentBatch[]): StoredDraft[] {
  return drafts.filter(draft => draft.queuedAt !== undefined && draft.compose.text.trim() && !draft.conflicted && !draft.compose.intentId && !draft.compose.sourceInteractionId && !batches.some(batch => batchContainsDraft(batch, draft)))
    .sort((a, b) => a.queuedAt! - b.queuedAt! || a.id.localeCompare(b.id));
}
export function createCommentBatch(drafts: StoredDraft[], intentId: string, destination: CommentBatch["destination"], expectedCreatedAt?: string, sideContext?: SideContext): CommentBatch {
  const ordered = queuedDrafts(drafts, []);
  if (!ordered.length || ordered.length !== drafts.length) throw new Error("请先检查待发送评论；空白、冲突或结果未知的草稿不能合并发送。");
  const identities = new Set(ordered.map(draft => draft.compose.expectedCreatedAt).filter((value): value is string => value !== undefined));
  if (expectedCreatedAt) identities.add(expectedCreatedAt);
  if (identities.size > 1) throw new Error("画板已被替换；原评论已保留，请重新核对来源后评论。");
  const identity = identities.values().next().value;
  const comments: BoardComment[] = ordered.map(draft => ({ id: draft.id, text: draft.compose.text.trim(), ...(draft.compose.anchor ? { anchor: draft.compose.anchor } : {}) }));
  const parsed = CommentsSchema.safeParse(comments);
  if (!parsed.success) throw new Error(`这组评论超过限制或引用无效；最多 ${COMMENT_LIMIT} 条，请减少文字或截图后重试。`);
  // The new-Side choice is frozen into the batch with its destination; main sends never carry it.
  return BatchSchema.parse({ intentId, destination, ...(destination !== "main" && sideContext === "owner-history" ? { sideContext } : {}), ...(identity ? { expectedCreatedAt: identity } : {}), text: `请将以下 ${comments.length} 条评论作为一组修改要求一起处理。`, comments: parsed.data, drafts: ordered.map(draft => ({ id: draft.id, revision: draft.revision })), createdAt: Date.now() });
}
export function acceptedBatchInteraction(batch: CommentBatch, interactions: Interaction[]): Interaction | undefined {
  const item = interactions.find(item => item.id === batch.intentId);
  const kinds = batch.destination === "main" ? ["change"] : batch.destination === "new-side" ? ["fork"] : ["fork", "reply"];
  if (!item || item.expectedCreatedAt !== batch.expectedCreatedAt || item.destination !== batch.destination || item.text !== batch.text || item.anchor || item.sourceInteractionId || !kinds.includes(item.kind)) return undefined;
  // Replies to an existing Side drop the choice; a created Side must carry exactly the frozen one.
  if (item.kind === "fork" && item.sideContext !== batch.sideContext) return undefined;
  const comments = CommentsSchema.safeParse(item.comments);
  return comments.success && sameData(comments.data, batch.comments) ? item : undefined;
}
/** Compare references as data without copying multi-megabyte screenshots into JSON strings. */
function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameData(a[key], b[key]));
}
/**
 * A grouped Side that failed before creation (sideNotCreated): put its frozen comments back into the
 * pending queue so the group can be sent again. Each comment returns under its original draft ID, so
 * a second press while those drafts still exist adds nothing.
 */
export function restoreBatchComments(store: DraftStore, interaction: Pick<Interaction, "comments">, options: { expectedCreatedAt?: string; position(anchor: BoardComment["anchor"]): { x: number; y: number }; now?: number }): { restored: number; existing: number; message?: string } {
  const now = options.now ?? Date.now();
  let restored = 0, existing = 0, message: string | undefined;
  (interaction.comments ?? []).forEach((comment, index) => {
    const result = store.put({ id: comment.id, open: false, queuedAt: now + index, position: options.position(comment.anchor), compose: {
      kind: "question", text: comment.text, ...(comment.anchor ? { anchor: comment.anchor } : {}), ...(options.expectedCreatedAt ? { expectedCreatedAt: options.expectedCreatedAt } : {}),
    } }, null);
    if (result.ok) restored++;
    else if (result.issue.code === "conflict") existing++;
    else message ??= result.issue.message;
  });
  return { restored, existing, ...(message ? { message } : {}) };
}
/** A receipt only retires the exact captured revisions, never later edits. */
export function reconcileBatchDrafts(batch: CommentBatch, store: DraftStore): Result {
  for (const source of batch.drafts) {
    const snapshot = store.list();
    if (snapshot.issues.length) return { ok: false, message: "评论已接收，但部分本机草稿无法读取；已保留发送记录。" };
    if (!snapshot.drafts.some(draft => draft.id === source.id && draft.revision === source.revision)) continue;
    const removed = store.remove(source.id, source.revision);
    if (!removed.ok && (removed.issue.code !== "conflict" || store.list().drafts.some(draft => draft.id === source.id && draft.revision === source.revision))) return { ok: false, message: removed.issue.message };
  }
  return { ok: true };
}

/** Each intent is one immutable durable value. No route or payload mutation on retry. */
export function createBatchStore(scope: { hostId: string; boardId: string }, storage: DraftStorage | null = browserDraftStorage()) {
  const prefix = PREFIX + encodeURIComponent(JSON.stringify([scope.hostId, scope.boardId])) + ":";
  const changed = () => { for (const listener of listeners) if (listener.scope === prefix) { try { listener.notify(); } catch { /* notification is not persistence */ } } };
  const failure = (message = "待发送评论尚未保存在本机；请保留当前页面并重试。"): Result => ({ ok: false, message });
  return {
    list(): { batches: CommentBatch[]; issues: string[] } {
      if (!storage) return { batches: [], issues: ["当前客户端无法在本机保存待发送评论。"] };
      const batches: CommentBatch[] = [], issues: string[] = [];
      try {
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index); if (!key?.startsWith(prefix)) continue;
          try {
            const raw = storage.getItem(key);
            if (!raw || raw.length > BATCH_READ_LIMIT) throw new Error("Invalid record");
            const batch = BatchSchema.parse(JSON.parse(raw));
            if (key !== prefix + batch.intentId) throw new Error("Wrong intent");
            batches.push(batch);
          } catch { issues.push("有一组发送记录无法读取；原记录已保留，没有自动重发或删除。"); }
        }
      } catch { issues.push("暂时无法读取本机待发送评论。"); }
      return { batches: batches.sort((a, b) => a.createdAt - b.createdAt || a.intentId.localeCompare(b.intentId)), issues };
    },
    put(input: CommentBatch): Result {
      if (!storage) return failure();
      try {
        const batch = BatchSchema.parse(input), raw = JSON.stringify(batch), key = prefix + batch.intentId;
        if (raw.length > BATCH_READ_LIMIT) return failure("这组评论过大；请减少截图或文字后重试。");
        const existing = storage.getItem(key);
        if (existing !== null && existing !== raw) return failure("这次发送已有固定内容和目标；请重试原发送。");
        if (existing === null) {
          // Recheck the durable outbox immediately before claiming these revisions.
          // A corrupt sibling is not evidence that its source revisions are free.
          for (let index = 0; index < storage.length; index++) {
            const otherKey = storage.key(index); if (!otherKey?.startsWith(prefix)) continue;
            const otherRaw = storage.getItem(otherKey);
            if (!otherRaw || otherRaw.length > BATCH_READ_LIMIT) return failure("发送记录无法读取；请先核对已有发送。");
            const other = BatchSchema.parse(JSON.parse(otherRaw));
            if (batch.drafts.some(draft => batchContainsDraft(other, draft))) return failure("这些评论已在另一组发送中；请核对或重试原发送。");
          }
        }
        if (existing === null) storage.setItem(key, raw);
        changed(); return { ok: true };
      } catch { return failure(); }
    },
    remove(batch: CommentBatch): Result {
      if (!storage) return failure();
      try {
        const key = prefix + batch.intentId, raw = storage.getItem(key);
        if (raw !== null && raw !== JSON.stringify(BatchSchema.parse(batch))) return failure("发送记录已发生变化，已保留原记录。");
        storage.removeItem(key); changed(); return { ok: true };
      } catch { return failure("评论已接收，但本机发送记录尚未清理；稍后会重新核对。"); }
    },
    subscribe(notify: () => void): () => void {
      const listener = { scope: prefix, notify }; listeners.add(listener);
      const off = storage?.subscribe?.(key => { if (key === null || key.startsWith(prefix)) notify(); });
      return () => { listeners.delete(listener); off?.(); };
    },
  };
}

/** Revalidate exactly the ordered revisions visible at the user's Send click. */
export function prepareCommentBatch(scope: { hostId: string; boardId: string; expectedCreatedAt?: string; sideContext?: SideContext }, drafts: DraftStore, batches: ReturnType<typeof createBatchStore>, destination: CommentBatch["destination"], intentId: string, reviewed: ReadonlyArray<Pick<StoredDraft, "id" | "revision">>, locks?: BatchLockManager): Promise<CommentBatch> {
  const expected = reviewed.map(({ id, revision }) => ({ id, revision }));
  return withBatchPreparationLock(scope, () => {
    const queued = drafts.list(), outbox = batches.list();
    if (queued.issues.length || outbox.issues.length) throw new Error(outbox.issues[0] ?? queued.issues[0].message);
    if (outbox.batches.some(batch => expected.some(draft => batchContainsDraft(batch, draft)))) throw new Error("这些评论已在另一窗口发送；请核对原发送。");
    const current = queuedDrafts(queued.drafts, outbox.batches);
    if (current.length !== expected.length || current.some((draft, index) => draft.id !== expected[index].id || draft.revision !== expected[index].revision)) throw new Error("待发送评论已在另一窗口更新，请重新核对后再统一发送。");
    const batch = createCommentBatch(current, intentId, destination, scope.expectedCreatedAt, scope.sideContext);
    const result = batches.put(batch);
    if (!result.ok) throw new Error(result.message);
    return batch;
  }, locks);
}
