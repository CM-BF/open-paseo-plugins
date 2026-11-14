import { createHash } from "node:crypto";
import { z } from "zod";
import { IdSchema } from "../shared/contracts";
import { InboxScopeSchema, type InboxComment, type InboxPublicRow, type InboxPublicState, type InboxScope } from "../shared/inbox";

/*
 * The inbox's public sidecar (`inbox/<hash>.public.json`, public-threads DESIGN §12 A4). Everything about public
 * comment threads lives here, keyed by source and external ID, so the main ledger keeps the 77ca22a format and an
 * older plugin build can still load it. Written only inside the inbox's per-scope lock, before the main ledger.
 */

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const TAG = /^[a-f0-9]{12}$/;
const Timestamp = z.string().datetime();
const Pending = z.object({ hidden: z.boolean().optional(), resolved: z.boolean().optional() }).strict();
export const PublicRecordSchema = z.object({
  sourceId: IdSchema, externalId: z.string().min(1).max(200),
  parentId: z.string().regex(UUID).optional(), publicTag: z.string().regex(TAG).optional(), withdrawn: z.literal(true).optional(),
  /** What the inbox wants the page to show. */
  hidden: z.boolean(), resolved: z.boolean(),
  hiddenBy: z.enum(["hide", "dismiss"]).optional(),
  /** A human set this value: it is pushed again after a backend restore (§12 A14). */
  explicit: z.literal(true).optional(),
  /** Values the backend has not confirmed yet; `error` stops the outbox until the human retries. */
  pending: Pending.optional(), error: z.string().max(300).optional(),
  updatedAt: Timestamp,
}).strict();
export type PublicRecord = z.infer<typeof PublicRecordSchema>;
export const PublicActionSchema = z.object({
  id: z.string().max(2_400), sourceId: IdSchema, kind: z.enum(["pause", "hide-visitor"]), page: z.string().max(2_000), tag: z.string().regex(TAG).optional(),
  value: z.boolean(), pending: z.literal(true).optional(), error: z.string().max(300).optional(), changed: z.number().int().nonnegative().optional(), updatedAt: Timestamp,
}).strict();
export type PublicAction = z.infer<typeof PublicActionSchema>;
const AuditSchema = z.object({
  at: Timestamp, actor: z.object({ kind: z.enum(["user", "agent", "ingress"]), id: z.string().min(1).max(200) }).strict(),
  operation: z.enum(["import", "upgrade", "state", "triage", "outcome", "page", "visitor"]), subject: z.string().max(2_400),
}).strict();
export const PublicLedgerSchema = z.object({
  version: z.literal(1), scope: InboxScopeSchema, revision: z.number().int().nonnegative(),
  records: z.array(PublicRecordSchema).max(10_000), actions: z.array(PublicActionSchema).max(500),
  audit: z.array(AuditSchema).max(500), receipts: z.array(z.object({ eventId: IdSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(500),
}).strict();
export type PublicLedger = z.infer<typeof PublicLedgerSchema>;
export const PUBLIC_LEDGER_BYTES = 8_000_000;
/** Same derivation as inbox-store.ts `commentIdOf`. */
const commentIdOf = (sourceId: string, externalId: string) => `comment-${createHash("sha256").update(`${sourceId}\0${externalId}`).digest("hex").slice(0, 40)}`;

export const emptyPublicLedger = (scope: InboxScope): PublicLedger => ({ version: 1, scope, revision: 0, records: [], actions: [], audit: [], receipts: [] });
export const recordKey = (sourceId: string, externalId: string) => `${sourceId}\0${externalId}`;
export function findRecord(ledger: PublicLedger, sourceId: string, externalId: string): PublicRecord | undefined {
  return ledger.records.find(record => record.sourceId === sourceId && record.externalId === externalId);
}
export function audit(ledger: PublicLedger, entry: z.infer<typeof AuditSchema>) { ledger.audit = [...ledger.audit, entry].slice(-500); }
export function receipt(ledger: PublicLedger, eventId: string, digest: string) { ledger.receipts = [...ledger.receipts, { eventId, digest }].slice(-500); }
export function setPending(record: PublicRecord, field: "hidden" | "resolved", value: boolean) { record.pending = { ...record.pending, [field]: value }; delete record.error; }

/** The page state the inbox shows for a record. */
export function publicStateOf(record: PublicRecord): InboxPublicState {
  return { hidden: record.hidden, resolved: record.resolved, ...(record.hiddenBy ? { hiddenBy: record.hiddenBy } : {}), ...(record.withdrawn ? { withdrawn: true as const } : {}), ...(record.pending && Object.keys(record.pending).length ? { pending: { ...record.pending } } : {}), ...(record.error ? { error: record.error } : {}) };
}
/** A ledger comment with its public fields (read results only). */
export function decorate(comment: InboxComment, ledger: PublicLedger): InboxComment {
  const record = findRecord(ledger, comment.sourceId, comment.externalId);
  if (!record) return comment;
  return { ...comment, visibility: "public", ...(record.parentId ? { parentCommentId: commentIdOf(comment.sourceId, record.parentId) } : {}), ...(record.publicTag ? { publicTag: record.publicTag } : {}), publicState: publicStateOf(record) };
}
/** Removes read-only public fields before a ledger write: the stored ledger keeps the 77ca22a comment shape. */
export function stripPublic(comment: InboxComment): InboxComment {
  const { visibility: _v, parentCommentId: _p, publicTag: _t, publicState: _s, ...rest } = comment;
  return rest as InboxComment;
}

/**
 * Applies one imported row's public extension. A new record takes the backend's state at export time; an existing
 * record is upgraded (missing parent or tag filled in, withdrawal noted) but never moved to another thread.
 */
export function importPublicRow(ledger: PublicLedger, sourceId: string, row: InboxPublicRow, at: string): "new" | "upgraded" | "same" {
  const existing = findRecord(ledger, sourceId, row.externalId);
  if (!existing) {
    ledger.records.push({ sourceId, externalId: row.externalId, ...(row.parentId ? { parentId: row.parentId } : {}), ...(row.publicTag ? { publicTag: row.publicTag } : {}), ...(row.withdrawn ? { withdrawn: true as const } : {}), hidden: row.hidden === true, resolved: row.resolved === true, updatedAt: at });
    return "new";
  }
  if (existing.parentId !== undefined && row.parentId !== undefined && existing.parentId !== row.parentId) return "same";
  let changed = false;
  if (existing.parentId === undefined && row.parentId !== undefined) { existing.parentId = row.parentId; changed = true; }
  if (existing.publicTag === undefined && row.publicTag !== undefined) { existing.publicTag = row.publicTag; changed = true; }
  if (!existing.withdrawn && row.withdrawn) { existing.withdrawn = true; existing.hidden = true; delete existing.hiddenBy; if (existing.pending) delete existing.pending.hidden; changed = true; }
  if (changed) existing.updatedAt = at;
  return changed ? "upgraded" : "same";
}
export const conflictingParent = (ledger: PublicLedger, sourceId: string, row: InboxPublicRow) => {
  const existing = findRecord(ledger, sourceId, row.externalId);
  return Boolean(existing?.parentId !== undefined && row.parentId !== undefined && existing.parentId !== row.parentId || existing?.parentId !== undefined && row.parentId === undefined);
};

/** True when the comment is a public visitor reply or hidden on the page: the waker must not treat it as new (§12 A1). */
export function notNewForWaker(ledger: PublicLedger, comment: InboxComment): boolean {
  const record = findRecord(ledger, comment.sourceId, comment.externalId);
  return Boolean(record && (record.parentId !== undefined || record.hidden || record.withdrawn));
}
