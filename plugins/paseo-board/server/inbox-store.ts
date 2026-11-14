import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  INBOX_AUTO_LIMITS, INBOX_CONTENT_NOTICE, INBOX_LIMITS, InboxArchiveInputSchema, InboxAuditSchema, InboxCommentSchema, InboxImportInputSchema,
  InboxListInputSchema, InboxPolicyInputSchema, InboxPolicySchema, InboxQuarantineSchema, InboxReadInputSchema,
  InboxSourceInputSchema, InboxSourceSchema, InboxTriageInputSchema, InboxScopeSchema, normalizeExternalComment,
  type InboxActor, type InboxArchiveInput, type InboxArchiveResult, type InboxAudit, type InboxAutoMode, type InboxComment, type InboxExternalComment,
  type InboxImportInput, type InboxListInput, type InboxMutationResult, type InboxPage, type InboxPendingReply, type InboxPolicy, type InboxPolicyInput,
  type InboxReadInput, type InboxReadResult, type InboxReply, type InboxScope, type InboxSourceInput, type InboxTriageInput,
} from "../shared/inbox";
import { BoardStoreError, canonicalJson, ensureDirectory, fingerprint, parseInput, serialized } from "./store-format";
import {
  PUBLIC_LEDGER_BYTES, PublicLedgerSchema, audit, conflictingParent, decorate, emptyPublicLedger, findRecord, importPublicRow, makeRoom, mirrorVisitorAction, notNewForWaker, publicStateOf, receipt, recordKey, setPending, stripPublic,
  type PublicAction, type PublicLedger, type PublicRecord,
} from "./inbox-public-ledger";
import { PUBLIC_TEXT, InboxPublicPageInputSchema, InboxPublicStateInputSchema, InboxPublicVisitorInputSchema, type InboxPublicPageInput, type InboxPublicStateInput, type InboxPublicVisitorInput } from "../shared/inbox-public";

const SourceRecordSchema = InboxSourceSchema.extend({ credentialHash: z.string().regex(/^[a-f0-9]{64}$/) });
const ReceiptSchema = z.object({
  eventId: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(),
  imported: z.number().int().nonnegative().optional(), duplicates: z.number().int().nonnegative().optional(), cursor: z.string().optional(),
  skipped: z.number().int().nonnegative().optional(), sanitized: z.number().int().nonnegative().optional(), archived: z.number().int().nonnegative().optional(),
}).strict();
const StateSchema = z.object({
  version: z.literal(1), scope: InboxScopeSchema, revision: z.number().int().nonnegative(), policy: InboxPolicySchema,
  sources: z.array(SourceRecordSchema).max(INBOX_LIMITS.sources), comments: z.array(InboxCommentSchema).max(INBOX_LIMITS.comments),
  audit: z.array(InboxAuditSchema).max(INBOX_LIMITS.events), receipts: z.array(ReceiptSchema).max(INBOX_LIMITS.events),
  // Additions after 4b94741 are optional, so older ledgers load unchanged (ledger version stays 1).
  nextSeq: z.number().int().positive().optional(),
  quarantine: z.array(InboxQuarantineSchema).max(INBOX_LIMITS.quarantine).optional(),
  archivedCount: z.number().int().nonnegative().optional(),
}).strict();
type State = z.infer<typeof StateSchema>;
type SourceRecord = z.infer<typeof SourceRecordSchema>;
type Receipt = z.infer<typeof ReceiptSchema>;
type MutationInput = InboxScope & { expectedRevision?: number; eventId: string };
type MutationDetails = { subject?: string; imported?: number; duplicates?: number; cursor?: string; skipped?: number; sanitized?: number; archived?: number };
type Access = "read" | "triage" | "reply" | "reply-outcome" | "import" | "archive" | "policy" | "source" | "public" | "public-outcome";
/** The public sidecar of one scope, loaded on first use inside the scope's lock (public-threads §12 A4). */
interface PublicContext { get(): Promise<PublicLedger>; touch(): void; commit(entry: { actor: InboxActor; operation: PublicLedger["audit"][number]["operation"]; subject: string; eventId?: string; digest?: string }, at: string): Promise<number> }
type Role = "user" | "assistant" | "owner" | "ingress";
type RevisionCheck = "exact" | "notFuture" | "none";
export interface InboxStoreOptions {
  /** A fresh authoritative lookup is required even for exact idempotent replays. */
  resolveBoard(boardId: string): Promise<{ createdAt: string; ownerAgentId?: string } | null>;
  /** Owner is accepted directly; this callback may admit server-verified forks only. Defaults to deny. */
  authorizeAgent?(boardId: string, agentId: string): Promise<boolean>;
  /** The Board's comment assistant (DESIGN §11.3). Defaults to deny. */
  authorizeAssistant?(scope: InboxScope, agentId: string): Promise<boolean>;
  /**
   * Comment IDs listed in the wakes this assistant received for the scope. The assistant may reply only to
   * those, so an injected comment cannot make it post into other visitors' threads. The plugin always wires
   * it; without it (store unit tests) replies are not restricted by wake.
   */
  assistantComments?(scope: InboxScope, agentId: string): Promise<ReadonlySet<string>>;
  now?: () => number;
}
/** Snapshot row for the waker: identifiers and routing hints only, never visitor text. */
export interface InboxWakeRow { id: string; seq: number; revision: number; sourceId: string; deploymentId: string; status: InboxComment["status"]; visitorTag?: string; releaseId?: string }
export interface InboxPendingRow { commentId: string; sourceId: string; deploymentId: string; externalId: string; pending: InboxPendingReply }
/** One public state change or page action the backend has not confirmed yet (public-threads §5.4.2). */
export type InboxPublicOutboxItem =
  | { kind: "state"; sourceId: string; externalId: string; send: { hidden?: boolean; resolved?: boolean } }
  | { kind: "action"; sourceId: string; id: string; action: PublicAction };
/** The only actor that may change what visitors see (the host's human UI); never an agent or the automation (§12 A19). */
const HUMAN_ID = "paseo-client";
const isHuman = (actor: InboxActor) => actor.kind === "user" && actor.id === HUMAN_ID;
export interface InboxAutomationState {
  revision: number; latestSeq: number; total: number; policy: InboxPolicy;
  sources: Array<{ sourceId: string; deploymentId: string; enabled: boolean; cursor: string; skipped: number; sanitized: number }>;
  /** importedAt times within the last day, per source, for the import quota. */
  imports: Record<string, string[]>;
  pendings: InboxPendingRow[];
}
export type PrepareReplyResult =
  | { kind: "published"; reply: InboxReply; revision: number; commentRevision: number; replayed: boolean }
  | { kind: "pending"; pending: InboxPendingReply; comment: { sourceId: string; deploymentId: string; externalId: string }; revision: number; commentRevision: number; replayed: boolean }
  | { kind: "gone"; revision: number; commentRevision: number };
export interface PrepareReplyInput extends InboxScope { commentId: string; expectedCommentRevision: number; eventId: string; text: string; resolve: boolean; key: string; approvedSensitive?: boolean }
export interface PendingActionInput extends InboxScope { eventId: string; commentId: string; key: string; action: "publish" | "retry" | "discard"; text?: string; approvedSensitive?: boolean }

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const deny = (message: string): never => { throw new BoardStoreError("forbidden", message); };
const conflict = (message: string): never => { throw new BoardStoreError("revision_conflict", message); };
const autoOf = (policy: InboxPolicy): InboxAutoMode => policy.auto ?? "off";
export const commentIdOf = (sourceId: string, externalId: string) => `comment-${hash(`${sourceId}\0${externalId}`).slice(0, 40)}`;
export const replyIdOf = (sourceId: string, replyId: string) => `reply-${hash(`${sourceId}\0${replyId}`).slice(0, 40)}`;
const externalFields = (comment: InboxComment): Record<string, unknown> => {
  const { externalId, text, authorName, createdAt, pageUrl, anchor, visitorTag } = comment;
  return { externalId, text, authorName, createdAt, pageUrl, anchor, visitorTag };
};
const ONLY_ASSISTANT = "只有这张 Board 的评论助手可以回复访客；你可以用 board_inbox_triage 记录建议。";
const NOT_WOKEN = "评论助手只能回复唤醒它时列出的评论。";
const OTHER_VISITOR = "回复里有一段和其他访客的评论相同（连续 16 个字以上）。访客之间互相看不到评论，请换一种说法。";
const PRIVATE_IN_PUBLIC = "回复里有一段和私密或已隐藏评论相同（连续 16 个字以上）。公开讨论里所有访客都能看到回复，请换一种说法。";
const THREAD_REPLY_LIMIT = "这个讨论的作者回复已达 20 条上限。";
const QUOTE_RUN = 16;
/**
 * True when the reply repeats a 16-character run of a comment written by another visitor (whitespace-insensitive).
 * For a reply to a public comment (`protect` given), any private or hidden comment is protected instead, including
 * the same visitor's: the reply is seen by every visitor of the page (public-threads §12 A1).
 */
function quotesOtherVisitor(text: string, comment: InboxComment, comments: readonly InboxComment[], protect?: (other: InboxComment) => boolean): boolean {
  const squash = (value: string) => value.replace(/\s+/g, " ").trim();
  const reply = squash(text);
  if (reply.length < QUOTE_RUN) return false;
  const runs = new Set<string>();
  for (let index = 0; index + QUOTE_RUN <= reply.length; index++) runs.add(reply.slice(index, index + QUOTE_RUN));
  for (const other of comments) {
    if (other.id === comment.id) continue;
    if (protect ? !protect(other) : other.visitorTag !== undefined && other.visitorTag === comment.visitorTag) continue;
    const body = squash(other.text);
    for (let index = 0; index + QUOTE_RUN <= body.length; index++) if (runs.has(body.slice(index, index + QUOTE_RUN))) return true;
  }
  return false;
}
/** The assistant budget counts confirmed replies by the host's confirmation time (older ledgers: the backend time). */
const replyTime = (reply: InboxReply) => Date.parse(reply.confirmedAt ?? reply.createdAt);

/** Outbox items oldest first; at the same moment a page action goes before the record it changed. */
export function chronological(entries: Array<{ at: string; rank: number; item: InboxPublicOutboxItem }>): InboxPublicOutboxItem[] {
  return entries.map((entry, index) => ({ ...entry, index })).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.rank - b.rank || a.index - b.index)).map(entry => entry.item);
}

/** A separate bounded ledger: importing a comment never creates a Board interaction or dispatches an agent. */
export class InboxStore {
  private readonly directory: string;
  private readonly publicListeners = new Set<(scope: InboxScope) => void>();
  constructor(rootDir: string, private readonly options: InboxStoreOptions) { this.directory = join(resolve(rootDir), "inbox"); }
  private now() { return this.options.now?.() ?? Date.now(); }

  async list(raw: InboxListInput, actor: InboxActor): Promise<InboxPage> {
    const input = parseInput(InboxListInputSchema, raw);
    return this.transact(input, actor, "read", async (state, role, _commit, pub) => {
      const ledger = await pub.get();
      const newest = input.order === "newest";
      let offset = 0;
      if (input.cursor) {
        const match = /^(\d+):(\d+)(:n)?$/.exec(input.cursor);
        if (match && Boolean(match[3]) !== newest) throw new BoardStoreError("invalid_input", "This inbox cursor belongs to the other list order");
        if (!match || Number(match[1]) !== state.revision) conflict("Inbox changed; restart pagination to review the current snapshot");
        offset = Number(match![2]);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > state.comments.length) throw new BoardStoreError("invalid_input", "Invalid inbox cursor");
      }
      const ordered = newest ? [...state.comments].reverse() : state.comments;
      const comments: InboxComment[] = [];
      let characters = 0;
      for (let index = offset; index < ordered.length && comments.length < input.limit; index++) {
        const comment = structuredClone(decorate(ordered[index], ledger));
        if (actor.kind === "agent") {
          // Agent pages are bounded; board_inbox_read returns the full text.
          if (comment.text.length > INBOX_LIMITS.agentText) { comment.text = comment.text.slice(0, INBOX_LIMITS.agentText); comment.truncated = true; }
          const size = JSON.stringify(comment).length;
          if (comments.length && characters + size > INBOX_LIMITS.agentPageCharacters) break;
          characters += size;
        }
        comments.push(comment);
      }
      const end = offset + comments.length;
      return structuredClone({
        revision: state.revision, policy: state.policy,
        sources: state.sources.map(({ credentialHash: _secret, ...source }) => source),
        comments, total: state.comments.length,
        nextCursor: end < ordered.length ? `${state.revision}:${end}${newest ? ":n" : ""}` : null,
        contentNotice: INBOX_CONTENT_NOTICE,
        permissions: { read: true, triage: role === "user" || state.policy.triage, reply: role === "user" || role === "assistant" && autoOf(state.policy) !== "off", configure: role === "user", publish: false as const, changeApplication: false as const },
        recentAudit: state.audit.slice(-30),
        ...(role === "user" ? { archivable: state.comments.filter(comment => archivable(comment, ["resolved", "dismissed"])).length, archivedCount: state.archivedCount ?? 0 } : {}),
      });
    });
  }

  async read(raw: InboxReadInput, actor: InboxActor): Promise<InboxReadResult> {
    const input = parseInput(InboxReadInputSchema, raw);
    return this.transact(input, actor, "read", async (state, _role, _commit, pub) => {
      const comment = state.comments.find(item => item.id === input.commentId);
      if (!comment) throw new BoardStoreError("not_found", "Inbox comment does not exist");
      return structuredClone({ revision: state.revision, comment: decorate(comment, await pub.get()), contentNotice: INBOX_CONTENT_NOTICE });
    });
  }

  /** Only `board.inbox.auto-enable` may pass allowAutoEnable (DESIGN §11.4). */
  async setPolicy(raw: InboxPolicyInput, actor: InboxActor, options: { allowAutoEnable?: boolean } = {}): Promise<InboxMutationResult> {
    const input = parseInput(InboxPolicyInputSchema, raw);
    return this.mutate(input, actor, "policy", "policy", input, {
      revisionCheck: "exact",
      revoking: state => isPolicyRevocation(state.policy, nextPolicy(state.policy, input.policy, options)),
      change: state => { state.policy = nextPolicy(state.policy, input.policy, options); return {}; },
    });
  }

  async setSource(raw: InboxSourceInput, actor: InboxActor): Promise<InboxMutationResult> {
    const input = parseInput(InboxSourceInputSchema, raw);
    const credentialHash = hash(input.credential);
    const { credential: _credential, ...safe } = input;
    const payload = { ...safe, credentialHash };
    return this.mutate(input, actor, "source", "source", payload, {
      revisionCheck: "exact",
      revoking: state => {
        const source = state.sources.find(item => item.sourceId === input.sourceId);
        return Boolean(source?.enabled && !input.enabled && source.deploymentId === input.deploymentId && source.label === input.label && source.credentialHash === credentialHash);
      },
      change: (state, at) => {
        const existing = state.sources.find(item => item.sourceId === input.sourceId);
        if (existing && existing.deploymentId !== input.deploymentId) throw new BoardStoreError("identity_conflict", "A source is bound to its deployment. Disable it and register a new source ID for a new deployment.");
        if (!existing && state.sources.length >= INBOX_LIMITS.sources) throw new BoardStoreError("size_limit", "Inbox source limit reached; no data was changed");
        const source: SourceRecord = { sourceId: input.sourceId, deploymentId: input.deploymentId, label: input.label, enabled: input.enabled, credentialHash, cursor: existing?.cursor ?? "0", updatedAt: at, ...(existing?.skipped ? { skipped: existing.skipped } : {}), ...(existing?.sanitized ? { sanitized: existing.sanitized } : {}) };
        if (existing) Object.assign(existing, source); else state.sources.push(source);
        return { subject: input.sourceId };
      },
    });
  }

  /** Rows arrive already normalized (DESIGN §11.5); quarantined rows are recorded and the cursor still advances. */
  async importPage(raw: InboxImportInput, actor: InboxActor): Promise<InboxMutationResult> {
    const input = parseInput(InboxImportInputSchema, raw);
    const { expectedRevision: _ignored, ...payload } = input;
    return this.mutate(input, actor, "import", "import", payload, {
      revisionCheck: "none", headroom: true, preloadPublic: Boolean(input.publicRows?.length),
      beforeReplay: state => {
        if (actor.kind !== "ingress" || actor.sourceId !== input.sourceId || actor.deploymentId !== input.deploymentId) deny("Import requires its exact authenticated source and deployment");
        this.authenticateSource(state, actor as Extract<InboxActor, { kind: "ingress" }>);
      },
      change: (state, at, pub) => {
        const source = this.source(state, input.sourceId, input.deploymentId);
        if (source.cursor !== input.cursor) conflict("Import cursor changed; reconcile the recorded checkpoint before continuing");
        // Public threads: the extension goes to the sidecar; a row may not move to another thread.
        const ledger = pub.value;
        if (ledger && input.publicRows) {
          const onPage = new Set(input.comments.map(item => item.externalId));
          for (const row of input.publicRows) {
            if (!onPage.has(row.externalId)) throw new BoardStoreError("invalid_input", "A public row must belong to a comment on the same page");
            if (conflictingParent(ledger, input.sourceId, row)) throw new BoardStoreError("idempotency_conflict", "An external comment ID was reused with a different thread; existing evidence is unchanged");
          }
          // A full sidecar drops settled records of comments that already left the inbox, so imports never stop.
          const fresh = input.publicRows.filter(row => !findRecord(ledger, input.sourceId, row.externalId)).length;
          if (fresh) this.ensurePublicRoom(state, ledger, input.publicRows.map(row => recordKey(input.sourceId, row.externalId)), fresh, at, { kind: "ingress", id: input.sourceId }, () => pub.touch());
          for (const row of input.publicRows) {
            const outcome = importPublicRow(ledger, input.sourceId, row, at);
            if (outcome !== "same") { pub.touch(); audit(ledger, { at, actor: { kind: "ingress", id: input.sourceId }, operation: outcome === "new" ? "import" : "upgrade", subject: row.externalId }); }
          }
        }
        let imported = 0, duplicates = 0, nextSeq = state.nextSeq ?? 1;
        for (const external of input.comments) {
          const existing = state.comments.find(item => item.sourceId === input.sourceId && item.externalId === external.externalId);
          if (existing) {
            if (canonicalJson(normalizedExternal(existing)) !== canonicalJson(normalizedExternal(external))) throw new BoardStoreError("idempotency_conflict", "An external comment ID was reused with different content; existing evidence is unchanged");
            duplicates++; continue;
          }
          if (state.comments.length >= INBOX_LIMITS.comments) throw new BoardStoreError("size_limit", "Inbox comment limit reached; this page and its cursor were not committed");
          state.comments.push({ ...external, id: commentIdOf(input.sourceId, external.externalId), sourceId: input.sourceId, deploymentId: input.deploymentId, contentTrust: "external-untrusted", importedAt: at, revision: 1, status: "new", labels: [], note: "", updatedAt: at, seq: nextSeq++ });
          imported++;
        }
        if (imported && state.comments.length > INBOX_LIMITS.headroomComments) throw new BoardStoreError("size_limit", "收件箱接近上限，自动同步已停止。请在「评论与权限」里归档已处理的评论。", { detail: "headroom", resource: "comments", count: state.comments.length });
        if (source.cursor === input.nextCursor && imported > 0) throw new BoardStoreError("invalid_input", "A page containing new comments must advance its cursor");
        const quarantined = input.quarantined ?? [];
        if (quarantined.length) state.quarantine = [...(state.quarantine ?? []), ...quarantined.map(item => ({ ...item, sourceId: input.sourceId, at }))].slice(-INBOX_LIMITS.quarantine);
        if (quarantined.length) source.skipped = (source.skipped ?? 0) + quarantined.length;
        if (input.sanitized) source.sanitized = (source.sanitized ?? 0) + input.sanitized;
        if (imported) state.nextSeq = nextSeq;
        source.cursor = input.nextCursor; source.updatedAt = at;
        return { subject: source.sourceId, imported, duplicates, cursor: source.cursor, ...(quarantined.length ? { skipped: quarantined.length } : {}), ...(input.sanitized ? { sanitized: input.sanitized } : {}) };
      },
      decorate: state => ({ latestSeq: (state.nextSeq ?? 1) - 1, total: state.comments.length }),
    });
  }

  async triage(raw: InboxTriageInput, actor: InboxActor): Promise<InboxMutationResult> {
    const input = parseInput(InboxTriageInputSchema, raw);
    return this.mutate(input, actor, "triage", "triage", input, {
      revisionCheck: "notFuture", preloadPublic: isHuman(actor),
      change: (state, at, pub) => {
        const comment = state.comments.find(item => item.id === input.commentId);
        if (!comment) throw new BoardStoreError("not_found", "Inbox comment does not exist");
        if (comment.revision !== input.expectedCommentRevision) conflict("Comment triage changed; read its latest state before editing");
        // The human's 不处理 hides a public comment on the page; leaving it shows it again unless it was hidden
        // separately. An agent's triage never changes what visitors see (public-threads §4.4, §12 A19).
        const record = pub.value && findRecord(pub.value, comment.sourceId, comment.externalId);
        if (record && !record.withdrawn) {
          if (input.status === "dismissed" && comment.status !== "dismissed" && !record.hidden) {
            Object.assign(record, { hidden: true, hiddenBy: "dismiss" as const, explicit: true as const, updatedAt: at }); setPending(record, "hidden", true);
            audit(pub.value!, { at, actor: { kind: "user", id: HUMAN_ID }, operation: "triage", subject: `${comment.externalId} hidden` }); pub.touch();
          } else if (comment.status === "dismissed" && input.status !== "dismissed" && record.hiddenBy === "dismiss") {
            Object.assign(record, { hidden: false, explicit: true as const, updatedAt: at }); delete record.hiddenBy; setPending(record, "hidden", false);
            audit(pub.value!, { at, actor: { kind: "user", id: HUMAN_ID }, operation: "triage", subject: `${comment.externalId} shown` }); pub.touch();
          }
        }
        Object.assign(comment, { status: input.status, labels: input.labels, note: input.note, revision: comment.revision + 1, updatedAt: at });
        return { subject: comment.id };
      },
    });
  }

  /** Human archive of handled comments (DESIGN §11.8): appended to a private JSONL file, then removed in one mutation. */
  async archive(raw: InboxArchiveInput, actor: InboxActor): Promise<InboxArchiveResult> {
    const input = parseInput(InboxArchiveInputSchema, raw);
    let archived = 0;
    const result = await this.mutate(input, actor, "archive", "archive", input, {
      revisionCheck: "exact",
      prepare: async state => {
        const leaving = state.comments.filter(comment => archivable(comment, input.statuses)).slice(0, INBOX_LIMITS.archiveBatch);
        if (leaving.length) await this.appendArchive(state.scope, leaving);
      },
      change: state => {
        const leaving = new Set(state.comments.filter(comment => archivable(comment, input.statuses)).slice(0, INBOX_LIMITS.archiveBatch).map(comment => comment.id));
        archived = leaving.size;
        state.comments = state.comments.filter(comment => !leaving.has(comment.id));
        state.archivedCount = (state.archivedCount ?? 0) + archived;
        return { archived };
      },
    });
    return { ...result, archived: result.archived ?? archived };
  }

  /** One serialized read for the waker: identifiers only, in seq order (DESIGN §11.6). */
  async snapshotAfter(scope: InboxScope, afterSeq: number, limit: number, actor: InboxActor): Promise<{ revision: number; latestSeq: number; total: number; policy: InboxPolicy; comments: InboxWakeRow[] }> {
    return this.transact(scope, actor, "read", async (state, _role, _commit, pub) => {
      const comments: InboxWakeRow[] = [], ledger = await pub.get();
      for (const comment of state.comments) {
        if (comment.seq === undefined || comment.seq <= afterSeq) continue;
        // Public visitor replies and hidden public comments are never new for the waker (public-threads §12 A1).
        comments.push({ id: comment.id, seq: comment.seq, revision: comment.revision, sourceId: comment.sourceId, deploymentId: comment.deploymentId, status: notNewForWaker(ledger, comment) ? "dismissed" : comment.status, ...(comment.visitorTag ? { visitorTag: comment.visitorTag } : {}), ...(comment.anchor?.releaseId ? { releaseId: comment.anchor.releaseId } : {}) });
        if (comments.length >= limit) break;
      }
      return { revision: state.revision, latestSeq: (state.nextSeq ?? 1) - 1, total: state.comments.length, policy: structuredClone(state.policy), comments };
    });
  }

  /** Loaded once when the coordinator starts a scope; ticks after that read no ledger. */
  async automationState(scope: InboxScope, actor: InboxActor): Promise<InboxAutomationState> {
    return this.transact(scope, actor, "read", async state => {
      const since = this.now() - 86_400_000, imports: Record<string, string[]> = {};
      for (const comment of state.comments) if (Date.parse(comment.importedAt) >= since) (imports[comment.sourceId] ??= []).push(comment.importedAt);
      return {
        revision: state.revision, latestSeq: (state.nextSeq ?? 1) - 1, total: state.comments.length, policy: structuredClone(state.policy),
        sources: state.sources.map(source => ({ sourceId: source.sourceId, deploymentId: source.deploymentId, enabled: source.enabled, cursor: source.cursor, skipped: source.skipped ?? 0, sanitized: source.sanitized ?? 0 })),
        imports, pendings: pendingRows(state),
      };
    });
  }

  async pendingReplies(scope: InboxScope, actor: InboxActor): Promise<InboxPendingRow[]> {
    return this.transact(scope, actor, "read", async state => pendingRows(state));
  }

  /** The current outbox state of one reply key, read under the per-source post lock. */
  async replyState(scope: InboxScope, commentId: string, key: string, actor: InboxActor): Promise<{ revision: number; commentRevision: number; reply?: InboxReply; pending?: InboxPendingReply; comment?: { sourceId: string; deploymentId: string; externalId: string } }> {
    return this.transact(scope, actor, "read", async state => {
      const comment = state.comments.find(item => item.id === commentId);
      if (!comment) throw new BoardStoreError("not_found", "Inbox comment does not exist");
      const reply = comment.replies?.find(item => item.key === key);
      const pending = comment.pendingReply?.key === key ? comment.pendingReply : undefined;
      return structuredClone({ revision: state.revision, commentRevision: comment.revision, ...(reply ? { reply } : {}), ...(pending ? { pending } : {}), comment: { sourceId: comment.sourceId, deploymentId: comment.deploymentId, externalId: comment.externalId } });
    });
  }

  /**
   * Write-ahead pending reply, which is also the per-comment lease (DESIGN §11.7 step 2).
   * Text must already be normalized and guarded. A replay returns the current outcome of that eventId.
   */
  async prepareReply(input: PrepareReplyInput, actor: InboxActor, context: { readySources: ReadonlyArray<{ sourceId: string; deploymentId: string }> }): Promise<PrepareReplyResult> {
    parseInput(InboxScopeSchema, { boardId: input.boardId, expectedCreatedAt: input.expectedCreatedAt });
    return this.transact(input, actor, "reply", async (state, role, commit, pub) => {
      const identity = actorId(actor);
      const digest = fingerprint("inbox:reply", { payload: { commentId: input.commentId, text: input.text }, actor: { kind: actor.kind, id: identity } });
      const receipt = state.receipts.find(item => item.eventId === input.eventId);
      const comment = state.comments.find(item => item.id === input.commentId);
      if (receipt) {
        if (receipt.digest !== digest) throw new BoardStoreError("idempotency_conflict", "这个 eventId 已用于另一条回复。");
        return replayOf(state, comment, input.eventId);
      }
      if (!comment) throw new BoardStoreError("not_found", "Inbox comment does not exist");
      if (comment.revision !== input.expectedCommentRevision) conflict("Comment changed; read its latest state before replying");
      if (!comment.visitorTag) throw new BoardStoreError("invalid_input", "这位访客看不到回复（评论不是从页面评论功能发出的），只能内部处理。");
      const ledger = await pub.get(), record = findRecord(ledger, comment.sourceId, comment.externalId);
      if (role === "assistant" && actor.kind === "agent") {
        if (this.options.assistantComments && !(await this.options.assistantComments(input, actor.agentId)).has(comment.id)) deny(NOT_WOKEN);
        if (record) {
          // Everyone on the page reads a reply to a public comment: protect every private or hidden comment.
          const visiblePublic = (other: InboxComment) => { const found = findRecord(ledger, other.sourceId, other.externalId); return !found || found.hidden || Boolean(found.withdrawn); };
          if (quotesOtherVisitor(input.text, comment, state.comments, visiblePublic)) throw new BoardStoreError("invalid_input", PRIVATE_IN_PUBLIC);
        } else if (quotesOtherVisitor(input.text, comment, state.comments)) throw new BoardStoreError("invalid_input", OTHER_VISITOR);
      }
      if (record) {
        // At most 20 owner and assistant replies per public thread: the root plus its visitor replies (§12 A22).
        const root = record.parentId ?? comment.externalId;
        let count = 0;
        for (const item of state.comments) {
          if (item.sourceId !== comment.sourceId) continue;
          const member = item.externalId === root || findRecord(ledger, item.sourceId, item.externalId)?.parentId === root;
          if (member) count += (item.replies?.length ?? 0) + (item.pendingReply && item.pendingReply.state !== "failed" ? 1 : 0);
        }
        if (count >= INBOX_LIMITS.replies) throw new BoardStoreError("size_limit", THREAD_REPLY_LIMIT);
      }
      if ((comment.replies?.length ?? 0) >= INBOX_LIMITS.replies) throw new BoardStoreError("size_limit", "这条评论的回复已达 20 条上限。");
      if (comment.pendingReply && comment.pendingReply.state !== "failed") conflict("这条评论有一条回复正在发送或待审核。");
      const source = state.sources.find(item => item.sourceId === comment.sourceId);
      if (!source?.enabled || source.deploymentId !== comment.deploymentId || !context.readySources.some(item => item.sourceId === comment.sourceId && item.deploymentId === comment.deploymentId)) deny("来源已停用或已更换，无法回复。");
      const now = this.now();
      if (actor.kind === "agent") {
        const since = now - 3_600_000;
        let recent = 0;
        for (const item of state.comments) {
          for (const reply of item.replies ?? []) if (reply.actor.kind === "agent" && replyTime(reply) >= since) recent++;
          if (item.pendingReply && item.pendingReply.state !== "failed" && item.pendingReply.actor.kind === "agent" && Date.parse(item.pendingReply.createdAt) >= since) recent++;
        }
        if (recent >= INBOX_AUTO_LIMITS.agentRepliesPerHour) throw new BoardStoreError("rate_limited", "回复过于频繁：每张 Board 每小时最多 30 条 AI 助手回复。");
      }
      const at = new Date(now).toISOString();
      const pending: InboxPendingReply = {
        key: input.key, eventId: input.eventId, text: input.text, authorKind: role === "user" ? "owner" : "agent",
        actor: { kind: actor.kind === "user" ? "user" : "agent", id: identity },
        // An assistant reply to a public comment waits for the human, whatever the mode (public-threads §12 A1).
        state: role === "assistant" && (autoOf(state.policy) === "review" || record !== undefined) ? "draft" : "sending",
        resolveOnConfirm: input.resolve, createdAt: at, failedReason: null,
        ...(input.approvedSensitive ? { approvedSensitive: true as const } : {}),
      };
      comment.pendingReply = pending; comment.revision++; comment.updatedAt = at;
      const revision = await commit({ eventId: input.eventId, operation: "reply", digest, subject: comment.id }, at);
      return { kind: "pending", pending: structuredClone(pending), comment: { sourceId: comment.sourceId, deploymentId: comment.deploymentId, externalId: comment.externalId }, revision, commentRevision: comment.revision, replayed: false };
    });
  }

  /** Human outbox actions (`board.inbox.reply-pending`). Text must already be normalized and guarded. */
  async pendingAction(input: PendingActionInput, actor: InboxActor): Promise<PrepareReplyResult> {
    return this.transact(input, actor, "reply", async (state, role, commit) => {
      if (role !== "user") deny("Only the user can publish, retry or discard a pending reply");
      const digest = fingerprint("inbox:reply-pending", { payload: { commentId: input.commentId, key: input.key, action: input.action, text: input.text }, actor: { kind: actor.kind, id: actorId(actor) } });
      const receipt = state.receipts.find(item => item.eventId === input.eventId);
      const comment = state.comments.find(item => item.id === input.commentId);
      if (receipt) {
        if (receipt.digest !== digest) throw new BoardStoreError("idempotency_conflict", "Inbox event ID was reused with a different request");
        const reply = comment?.replies?.find(item => item.key === input.key);
        if (reply) return { kind: "published", reply: structuredClone(reply), revision: state.revision, commentRevision: comment!.revision, replayed: true };
        if (comment?.pendingReply?.key === input.key) return { kind: "pending", pending: structuredClone(comment.pendingReply), comment: { sourceId: comment.sourceId, deploymentId: comment.deploymentId, externalId: comment.externalId }, revision: state.revision, commentRevision: comment.revision, replayed: true };
        return { kind: "gone", revision: state.revision, commentRevision: comment?.revision ?? 1 };
      }
      if (!comment) throw new BoardStoreError("not_found", "Inbox comment does not exist");
      const reply = comment.replies?.find(item => item.key === input.key);
      if (reply) return { kind: "published", reply: structuredClone(reply), revision: state.revision, commentRevision: comment.revision, replayed: true };
      const pending = comment.pendingReply;
      if (!pending || pending.key !== input.key) throw new BoardStoreError("not_found", "这条回复已经不在待处理列表里。");
      const info = { sourceId: comment.sourceId, deploymentId: comment.deploymentId, externalId: comment.externalId };
      const at = new Date(this.now()).toISOString();
      if (input.action === "discard") {
        if (pending.state === "sending") throw new BoardStoreError("invalid_input", "正在发送的回复不能丢弃；等它确认或失败后再处理。");
        delete comment.pendingReply;
      } else if (input.action === "publish") {
        if (pending.state !== "draft") throw new BoardStoreError("invalid_input", "只有待审核的草稿可以发布。");
        const text = input.text ?? pending.text;
        Object.assign(pending, { text, state: "sending", authorKind: text === pending.text ? pending.authorKind : "owner", ...(input.approvedSensitive ? { approvedSensitive: true } : {}) });
      } else {
        if (pending.state === "draft") throw new BoardStoreError("invalid_input", "草稿需要先发布。");
        if (pending.state === "sending") return { kind: "pending", pending: structuredClone(pending), comment: info, revision: state.revision, commentRevision: comment.revision, replayed: false };
        // A human retry restarts the 24-hour delivery window.
        Object.assign(pending, { state: "sending", failedReason: null, createdAt: at });
      }
      comment.revision++; comment.updatedAt = at;
      const revision = await commit({ eventId: input.eventId, operation: "reply", digest, subject: comment.id }, at);
      if (input.action === "discard") return { kind: "gone", revision, commentRevision: comment.revision };
      return { kind: "pending", pending: structuredClone(comment.pendingReply!), comment: info, revision, commentRevision: comment.revision, replayed: false };
    });
  }

  /** Backend confirmed the reply: by the source's ingress actor, guarded by the pending key, not the comment revision. */
  async confirmReply(scope: InboxScope, commentId: string, key: string, backend: { replyId: string; createdAt: string }, actor: InboxActor): Promise<PrepareReplyResult> {
    return this.transact(scope, actor, "reply-outcome", async (state, _role, commit) => {
      const ingress = this.outcomeActor(state, actor);
      const comment = state.comments.find(item => item.id === commentId);
      if (!comment) throw new BoardStoreError("not_found", "Inbox comment does not exist");
      if (comment.sourceId !== ingress.sourceId || comment.deploymentId !== ingress.deploymentId) deny("Reply outcomes require the comment's own source");
      const existing = comment.replies?.find(item => item.key === key);
      if (existing) return { kind: "published", reply: structuredClone(existing), revision: state.revision, commentRevision: comment.revision, replayed: true };
      const pending = comment.pendingReply;
      if (!pending || pending.key !== key) throw new BoardStoreError("not_found", "这条回复已经不在待处理列表里。");
      if ((comment.replies?.length ?? 0) >= INBOX_LIMITS.replies) throw new BoardStoreError("size_limit", "这条评论的回复已达 20 条上限。");
      const at = new Date(this.now()).toISOString();
      const reply: InboxReply = { id: replyIdOf(comment.sourceId, backend.replyId), replyId: backend.replyId, key, text: pending.text, authorKind: pending.authorKind, actor: pending.actor, eventId: pending.eventId, createdAt: backend.createdAt, confirmedAt: at };
      comment.replies = [...(comment.replies ?? []), reply];
      delete comment.pendingReply;
      if (pending.resolveOnConfirm) comment.status = "resolved";
      comment.revision++; comment.updatedAt = at;
      const digest = fingerprint("inbox:reply-ok", { payload: { commentId, key, replyId: backend.replyId }, actor: { kind: "ingress", id: ingress.sourceId } });
      const revision = await commit({ eventId: `reply-ok:${key}`, operation: "reply", digest, subject: comment.id }, at);
      return { kind: "published", reply: structuredClone(reply), revision, commentRevision: comment.revision, replayed: false };
    });
  }

  /** A definitive backend refusal, the 24-hour limit or the guard: the pending becomes `failed`. */
  async failReply(scope: InboxScope, commentId: string, key: string, reason: string, actor: InboxActor): Promise<PrepareReplyResult> {
    return this.transact(scope, actor, "reply-outcome", async (state, _role, commit) => {
      const ingress = this.outcomeActor(state, actor);
      const comment = state.comments.find(item => item.id === commentId);
      if (!comment) throw new BoardStoreError("not_found", "Inbox comment does not exist");
      if (comment.sourceId !== ingress.sourceId || comment.deploymentId !== ingress.deploymentId) deny("Reply outcomes require the comment's own source");
      const pending = comment.pendingReply;
      if (!pending || pending.key !== key) return { kind: "gone", revision: state.revision, commentRevision: comment.revision };
      if (pending.state === "failed") return { kind: "pending", pending: structuredClone(pending), comment: { sourceId: comment.sourceId, deploymentId: comment.deploymentId, externalId: comment.externalId }, revision: state.revision, commentRevision: comment.revision, replayed: true };
      const at = new Date(this.now()).toISOString();
      Object.assign(pending, { state: "failed", failedReason: reason.slice(0, 300) });
      // A pending can fail, be retried by the human and fail again: the comment revision keeps each outcome ID unique.
      const eventId = `reply-fail:${key}:${comment.revision}`;
      comment.revision++; comment.updatedAt = at;
      const digest = fingerprint("inbox:reply-fail", { payload: { commentId, key, reason }, actor: { kind: "ingress", id: ingress.sourceId } });
      const revision = await commit({ eventId, operation: "reply", digest, subject: comment.id }, at);
      return { kind: "pending", pending: structuredClone(pending), comment: { sourceId: comment.sourceId, deploymentId: comment.deploymentId, externalId: comment.externalId }, revision, commentRevision: comment.revision, replayed: false };
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Public comment threads (public-threads DESIGN §5.4 as amended by §12). Sidecar-only changes; the human alone
  // decides what visitors see; outcomes come from the comment's own source.

  /** Called after every committed sidecar change (the outbox listens). */
  onPublicChange(listener: (scope: InboxScope) => void): () => void { this.publicListeners.add(listener); return () => this.publicListeners.delete(listener); }
  private emitPublic(scope: InboxScope) { for (const listener of this.publicListeners) { try { listener(scope); } catch { /* advisory */ } } }

  /** Human 在页面上隐藏/显示, 标为已解决/重新打开 and 重试 by source and external ID; also for comments never imported. */
  async setPublicState(raw: InboxPublicStateInput, actor: InboxActor): Promise<{ revision: number; state: ReturnType<typeof publicStateOf>; replayed: boolean }> {
    const input = parseInput(InboxPublicStateInputSchema, raw);
    return this.transact(input, actor, "public", async (state, _role, _commit, pub) => {
      if (!isHuman(actor)) deny(PUBLIC_TEXT.humanOnly);
      const ledger = await pub.get();
      const digest = fingerprint("inbox:public-state", { payload: { sourceId: input.sourceId, externalId: input.externalId, hidden: input.hidden, resolved: input.resolved, retry: input.retry }, actor: { kind: actor.kind, id: actorId(actor) } });
      const previous = ledger.receipts.find(item => item.eventId === input.eventId);
      const existing = findRecord(ledger, input.sourceId, input.externalId);
      if (previous) {
        if (previous.digest !== digest) throw new BoardStoreError("idempotency_conflict", "Inbox event ID was reused with a different request");
        if (!existing) throw new BoardStoreError("not_found", "这条公开评论不在收件箱的记录里。");
        return { revision: ledger.revision, state: publicStateOf(existing), replayed: true };
      }
      if (!state.sources.some(source => source.sourceId === input.sourceId)) throw new BoardStoreError("not_found", "这个后端来源已不存在。");
      const at = new Date(this.now()).toISOString();
      let record = existing;
      if (!record) {
        this.ensurePublicRoom(state, ledger, [recordKey(input.sourceId, input.externalId)], 1, at, { kind: "user", id: HUMAN_ID }, () => undefined);
        const known = input.known ?? { hidden: false, resolved: false };
        record = { sourceId: input.sourceId, externalId: input.externalId, ...(known.parentId ? { parentId: known.parentId } : {}), ...(known.publicTag ? { publicTag: known.publicTag } : {}), ...(known.withdrawn ? { withdrawn: true as const } : {}), hidden: known.hidden || Boolean(known.withdrawn), resolved: known.resolved, updatedAt: at };
        ledger.records.push(record);
      }
      if (input.hidden === false && record.withdrawn) throw new BoardStoreError("invalid_input", PUBLIC_TEXT.withdrawn);
      if (input.resolved !== undefined && record.parentId !== undefined) throw new BoardStoreError("invalid_input", PUBLIC_TEXT.replyResolve);
      if (input.hidden !== undefined && !(record.withdrawn && input.hidden)) {
        record.hidden = input.hidden; if (input.hidden) record.hiddenBy = "hide"; else delete record.hiddenBy;
        setPending(record, "hidden", input.hidden);
      }
      if (input.resolved !== undefined) { record.resolved = input.resolved; setPending(record, "resolved", input.resolved); }
      if (input.retry && !record.pending) record.pending = { hidden: record.hidden, ...(record.parentId === undefined ? { resolved: record.resolved } : {}) };
      delete record.error; record.explicit = true; record.updatedAt = at;
      const revision = await pub.commit({ actor, operation: "state", subject: `${input.sourceId} ${input.externalId} hidden=${record.hidden} resolved=${record.resolved}`, eventId: input.eventId, digest }, at);
      return { revision, state: publicStateOf(record), replayed: false };
    });
  }

  /** Human 暂停新的公开评论 (per page) and 隐藏这位访客的全部公开评论, recorded for the outbox and re-pushed after a restore. */
  async setPublicAction(raw: InboxPublicPageInput | InboxPublicVisitorInput, kind: "pause" | "hide-visitor", actor: InboxActor): Promise<{ revision: number; action: PublicAction }> {
    const input = kind === "pause" ? parseInput(InboxPublicPageInputSchema, raw) : parseInput(InboxPublicVisitorInputSchema, raw);
    return this.transact(input, actor, "public", async (state, _role, _commit, pub) => {
      if (!isHuman(actor)) deny(PUBLIC_TEXT.humanOnly);
      const ledger = await pub.get();
      if (!state.sources.some(source => source.sourceId === input.sourceId)) throw new BoardStoreError("not_found", "这个后端来源已不存在。");
      const tag = "tag" in input ? input.tag : undefined, value = "paused" in input ? input.paused : (input as InboxPublicVisitorInput).hidden;
      const digest = fingerprint(`inbox:public-${kind}`, { payload: { sourceId: input.sourceId, page: input.page, tag, value }, actor: { kind: actor.kind, id: actorId(actor) } });
      const id = [kind, input.sourceId, input.page, tag ?? ""].join("\0"), previous = ledger.receipts.find(item => item.eventId === input.eventId);
      if (previous) {
        if (previous.digest !== digest) throw new BoardStoreError("idempotency_conflict", "Inbox event ID was reused with a different request");
        const found = ledger.actions.find(item => item.id === id);
        if (found) return { revision: ledger.revision, action: structuredClone(found) };
      }
      const at = new Date(this.now()).toISOString();
      const action: PublicAction = { id, sourceId: input.sourceId, kind, page: input.page, ...(tag ? { tag } : {}), value, pending: true, updatedAt: at };
      ledger.actions = [...ledger.actions.filter(item => item.id !== id), action].slice(-500);
      // The visitor's known comments follow the bulk change, so the inbox and the hourly re-push agree with it.
      if (kind === "hide-visitor" && tag) mirrorVisitorAction(ledger, input.sourceId, tag, value, at);
      const revision = await pub.commit({ actor, operation: kind === "pause" ? "page" : "visitor", subject: `${input.sourceId} ${input.page}${tag ? ` ${tag}` : ""} ${value}`, eventId: input.eventId, digest }, at);
      return { revision, action: structuredClone(action) };
    });
  }

  /** The sidecar, read-only (thread view merge, outbox and its hourly re-push). */
  async publicLedger(scope: InboxScope, actor: InboxActor): Promise<PublicLedger & { commentIds: Record<string, string> }> {
    return this.transact(scope, actor, "read", async (state, _role, _commit, pub) => {
      const ledger = structuredClone(await pub.get()), commentIds: Record<string, string> = {};
      for (const comment of state.comments) commentIds[`${comment.sourceId}\0${comment.externalId}`] = comment.id;
      return { ...ledger, commentIds };
    });
  }
  /**
   * Pending state changes and page actions without a definitive error, in the order the human made them (an action
   * before a record changed at the same moment), so a later 在页面上显示 is not undone by an earlier bulk hide.
   */
  async publicOutbox(scope: InboxScope, actor: InboxActor): Promise<InboxPublicOutboxItem[]> {
    const ledger = await this.publicLedger(scope, actor);
    return chronological([
      ...ledger.records.filter(record => record.pending && Object.keys(record.pending).length && !record.error).map(record => ({ at: record.updatedAt, rank: 1, item: { kind: "state" as const, sourceId: record.sourceId, externalId: record.externalId, send: { ...record.pending } } })),
      ...ledger.actions.filter(action => action.pending && !action.error).map(action => ({ at: action.updatedAt, rank: 0, item: { kind: "action" as const, sourceId: action.sourceId, id: action.id, action } })),
    ]);
  }
  /** Prunes the sidecar when it is full; `keep` lists record keys this mutation is about to use. */
  private ensurePublicRoom(state: State, ledger: PublicLedger, keep: string[], needed: number, at: string, actor: { kind: "user" | "ingress"; id: string }, touch: () => void) {
    const inLedger = new Set([...state.comments.map(comment => recordKey(comment.sourceId, comment.externalId)), ...keep]);
    const { removed, room } = makeRoom(ledger, inLedger, needed);
    if (removed) { audit(ledger, { at, actor, operation: "prune", subject: `${removed} settled records of comments no longer in the inbox` }); touch(); }
    if (!room) throw new BoardStoreError("size_limit", "公开评论记录已满：有太多公开评论的页面状态还在等后端确认。请先在「公开讨论」里处理同步失败的状态，再继续同步。");
  }
  /** The backend confirmed: each sent field leaves `pending` when the wanted value is still the one sent and the backend echoes it. */
  async confirmPublic(scope: InboxScope, item: InboxPublicOutboxItem, echo: { hidden?: boolean; resolved?: boolean; withdrawn?: boolean; changed?: number }, actor: InboxActor): Promise<void> {
    await this.publicOutcome(scope, item, actor, (record, action) => {
      if (record && item.kind === "state") {
        for (const field of ["hidden", "resolved"] as const) if (item.send[field] !== undefined && record.pending?.[field] === item.send[field] && echo[field] === item.send[field]) delete record.pending[field];
        if (echo.withdrawn && !record.withdrawn) { record.withdrawn = true; record.hidden = true; delete record.hiddenBy; if (record.pending) delete record.pending.hidden; }
        if (record.pending && !Object.keys(record.pending).length) delete record.pending;
        return `${item.externalId} confirmed`;
      }
      if (action && item.kind === "action" && action.updatedAt === item.action.updatedAt) { delete action.pending; if (echo.changed !== undefined) action.changed = echo.changed; return `${action.id} confirmed`; }
      return null;
    });
  }
  /** A definitive refusal: the outbox stops for this item until the human retries. */
  async failPublic(scope: InboxScope, item: InboxPublicOutboxItem, reason: string, actor: InboxActor): Promise<void> {
    await this.publicOutcome(scope, item, actor, (record, action) => {
      if (record && item.kind === "state" && record.pending) { record.error = reason.slice(0, 300); return `${item.externalId} failed`; }
      if (action && item.kind === "action" && action.pending) { action.error = reason.slice(0, 300); return `${action.id} failed`; }
      return null;
    });
  }
  private async publicOutcome(scope: InboxScope, item: InboxPublicOutboxItem, actor: InboxActor, apply: (record: PublicRecord | undefined, action: PublicAction | undefined) => string | null) {
    await this.transact(scope, actor, "public-outcome", async (state, _role, _commit, pub) => {
      const ingress = this.outcomeActor(state, actor);
      if (ingress.sourceId !== item.sourceId) deny("Public state outcomes require the comment's own source");
      const ledger = await pub.get();
      const record = item.kind === "state" ? findRecord(ledger, item.sourceId, item.externalId) : undefined;
      const action = item.kind === "action" ? ledger.actions.find(entry => entry.id === item.id) : undefined;
      const subject = apply(record, action);
      if (subject === null) return;
      if (record) record.updatedAt = new Date(this.now()).toISOString();
      await pub.commit({ actor, operation: "outcome", subject }, new Date(this.now()).toISOString());
    });
  }

  private publicPath(scope: InboxScope) { return join(this.directory, `${hash(canonicalJson(scope))}.public.json`); }
  private async loadPublic(scope: InboxScope): Promise<PublicLedger> {
    const path = this.publicPath(scope);
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new BoardStoreError("unsafe_path", "Inbox storage must be a regular file");
      if (stat.size > PUBLIC_LEDGER_BYTES) throw new BoardStoreError("size_limit", "Public comment records are too large; no data was changed");
      const ledger = PublicLedgerSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (canonicalJson(ledger.scope) !== canonicalJson(scope)) throw new Error("Public sidecar scope mismatch");
      return ledger;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPublicLedger(scope);
      if (error instanceof BoardStoreError) throw error;
      throw new BoardStoreError("corrupt_storage", "Public comment records could not be read; existing data was not changed");
    }
  }
  private async writePublic(scope: InboxScope, ledger: PublicLedger) {
    const path = this.publicPath(scope), data = JSON.stringify(PublicLedgerSchema.parse(ledger));
    if (Buffer.byteLength(data, "utf8") > PUBLIC_LEDGER_BYTES) throw new BoardStoreError("size_limit", "Public comment records reached their storage limit; this operation was not committed");
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }

  private outcomeActor(state: State, actor: InboxActor): Extract<InboxActor, { kind: "ingress" }> {
    if (actor.kind !== "ingress") return deny("Reply outcomes require the comment's authenticated source");
    // A reply made under a valid grant may already be public: its outcome is recorded even after the source is disabled.
    this.authenticateSource(state, actor, false);
    return actor;
  }

  private async appendArchive(scope: InboxScope, comments: InboxComment[]) {
    const file = join(this.directory, `${hash(canonicalJson(scope))}.archive.jsonl`);
    try { const stat = await lstat(file); if (stat.isSymbolicLink() || !stat.isFile()) throw new BoardStoreError("unsafe_path", "Inbox archive must be a regular file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const handle = await open(file, "a", 0o600);
    try { await handle.writeFile(comments.map(comment => JSON.stringify(comment)).join("\n") + "\n"); await handle.sync(); } finally { await handle.close(); }
  }

  private async authorize(state: State, latest: { ownerAgentId?: string }, actor: InboxActor, access: Access, scope: InboxScope): Promise<Role> {
    if (actor.kind === "agent") {
      if (!actor.agentId || actor.agentId.length > 200) deny("This agent does not own this Board or an authorized fork");
      const assistant = Boolean(await this.options.authorizeAssistant?.(scope, actor.agentId));
      const ownerOrFork = !assistant && (latest.ownerAgentId === actor.agentId || Boolean(await this.options.authorizeAgent?.(scope.boardId, actor.agentId)));
      if (!assistant && !ownerOrFork) deny("This agent does not own this Board or an authorized fork");
      const auto = autoOf(state.policy);
      if (access !== "read" && access !== "triage" && access !== "reply") deny("Only the user can configure inbox access and sources");
      if (assistant) {
        if (auto === "off") deny("自动处理已关闭；评论助手现在不能读取、处理或回复评论。");
        if (access === "read" && !state.policy.read || access === "triage" && !state.policy.triage) deny("The user has not granted this inbox permission to agents");
        return "assistant";
      }
      if (access === "reply") deny(ONLY_ASSISTANT);
      if (!state.policy.read || access === "triage" && !state.policy.triage) deny("The user has not granted this inbox permission to agents");
      return "owner";
    }
    if (actor.kind === "user") {
      if (!actor.id || actor.id.length > 200) deny("User identity is required");
      if (access === "import" || access === "reply-outcome" || access === "public-outcome") deny("A user action cannot substitute for authenticated source delivery");
      return "user";
    }
    if (actor.kind === "ingress") {
      if (access !== "import" && access !== "reply-outcome" && access !== "public-outcome") deny("Source credentials only permit importing comments and recording reply outcomes");
      return "ingress";
    }
    return deny("Unknown inbox actor");
  }

  /** Serialized, identity-checked access; `commit` appends the audit entry and receipt, rechecks identity and writes atomically. */
  private async transact<T>(scope: InboxScope, actor: InboxActor, access: Access, action: (state: State, role: Role, commit: (entry: { eventId: string; operation: InboxAudit["operation"]; digest: string; subject?: string; details?: Omit<MutationDetails, "subject">; revoking?: boolean; headroom?: boolean }, at: string) => Promise<number>, pub: PublicContext) => Promise<T>): Promise<T> {
    const identity = parseInput(InboxScopeSchema, { boardId: scope.boardId, expectedCreatedAt: scope.expectedCreatedAt });
    const path = this.path(identity);
    await ensureDirectory(this.directory);
    return serialized(path, async () => {
      const board = await this.options.resolveBoard(identity.boardId);
      if (!board || board.createdAt !== identity.expectedCreatedAt) throw new BoardStoreError("identity_conflict", "Board was removed or replaced; its previous inbox cannot be reused");
      const state = await this.load(path, identity);
      const latest = await this.options.resolveBoard(identity.boardId);
      if (!latest || latest.createdAt !== identity.expectedCreatedAt) throw new BoardStoreError("identity_conflict", "Board changed while the inbox was being read");
      const role = await this.authorize(state, latest, actor, access, identity);
      let ledger: PublicLedger | undefined, publicDirty = false;
      const writePublicNow = async () => { if (ledger && publicDirty) { ledger.revision++; await this.writePublic(identity, ledger); publicDirty = false; return true; } return false; };
      const pub: PublicContext = {
        get: async () => ledger ??= await this.loadPublic(identity),
        touch: () => { publicDirty = true; },
        // A sidecar-only change: identity is checked again; the main ledger and its revision are untouched.
        commit: async (entry, at) => {
          const current = await this.options.resolveBoard(identity.boardId);
          if (!current || current.createdAt !== identity.expectedCreatedAt) throw new BoardStoreError("identity_conflict", "Board identity changed during the operation");
          const value = await pub.get();
          audit(value, { at, actor: { kind: entry.actor.kind, id: actorId(entry.actor) }, operation: entry.operation, subject: entry.subject.slice(0, 2_400) });
          if (entry.eventId && entry.digest) receipt(value, entry.eventId, entry.digest);
          publicDirty = true; await writePublicNow(); this.emitPublic(identity);
          return value.revision;
        },
      };
      const commit = async (entry: { eventId: string; operation: InboxAudit["operation"]; digest: string; subject?: string; details?: Omit<MutationDetails, "subject">; revoking?: boolean; headroom?: boolean }, at: string) => {
        // Reserve enough final audit entries to revoke every grant/source even when normal writes fill the ledger.
        const normalLimit = INBOX_LIMITS.events - INBOX_LIMITS.sources - 2;
        if (state.audit.length >= INBOX_LIMITS.events || state.audit.length >= normalLimit && !entry.revoking) throw new BoardStoreError("size_limit", "Inbox audit limit reached; existing evidence is retained and access can still be revoked");
        if (entry.headroom && state.audit.length + 1 > INBOX_LIMITS.headroomEvents) throw new BoardStoreError("size_limit", `收件箱的操作记录接近上限（${state.audit.length} 条），自动同步已停止。可以登记一张新的 Board 继续接收评论。`, { detail: "headroom", resource: "audit", count: state.audit.length });
        const details = entry.details ?? {};
        state.revision++;
        state.audit.push({ eventId: entry.eventId, revision: state.revision, at, operation: entry.operation, actor: { kind: actor.kind, id: actorId(actor) }, ...(entry.subject ? { subject: entry.subject } : {}), ...(details.imported !== undefined ? { imported: details.imported, duplicates: details.duplicates } : {}), ...(details.skipped ? { skipped: details.skipped } : {}), ...(details.archived !== undefined ? { archived: details.archived } : {}) });
        state.receipts.push({ eventId: entry.eventId, digest: entry.digest, revision: state.revision, ...details });
        // A fresh identity check closes awaited lookup/fork-authorization gaps before committing.
        const current = await this.options.resolveBoard(identity.boardId);
        if (!current || current.createdAt !== identity.expectedCreatedAt) throw new BoardStoreError("identity_conflict", "Board identity changed during the operation");
        if (actor.kind === "agent" && current.ownerAgentId !== actor.agentId && !await this.options.authorizeAgent?.(identity.boardId, actor.agentId) && !await this.options.authorizeAssistant?.(identity, actor.agentId)) deny("Agent ownership changed during the operation");
        // The sidecar first: a crash in between leaves a public state change without its triage record, never the reverse.
        const publicChanged = await writePublicNow();
        await this.write(path, state, Boolean(entry.revoking), Boolean(entry.headroom));
        if (publicChanged) this.emitPublic(identity);
        return state.revision;
      };
      return action(state, role, commit, pub);
    });
  }

  private async mutate(input: MutationInput, actor: InboxActor, access: Access, operation: InboxAudit["operation"], payload: unknown, spec: {
    revisionCheck: RevisionCheck; headroom?: boolean; preloadPublic?: boolean;
    revoking?(state: State): boolean;
    beforeReplay?(state: State): void;
    prepare?(state: State): Promise<void>;
    change(state: State, at: string, pub: { value?: PublicLedger; touch(): void }): MutationDetails;
    decorate?(state: State): Partial<InboxMutationResult>;
  }): Promise<InboxMutationResult & { archived?: number }> {
    return this.transact(input, actor, access, async (state, _role, commit, pub) => {
      spec.beforeReplay?.(state);
      const digest = fingerprint(`inbox:${operation}`, { payload, actor: { kind: actor.kind, id: actorId(actor) } });
      const receipt = state.receipts.find(item => item.eventId === input.eventId);
      if (receipt) {
        if (receipt.digest !== digest) throw new BoardStoreError("idempotency_conflict", "Inbox event ID was reused with a different request");
        const { eventId: _id, digest: _digest, revision, ...details } = receipt as Receipt;
        return { ...details, revision: state.revision, committedRevision: revision, replayed: true, ...spec.decorate?.(state) };
      }
      const expected = input.expectedRevision;
      if (spec.revisionCheck === "exact" && state.revision !== expected) conflict("Inbox changed; refresh before submitting this change");
      if (spec.revisionCheck === "notFuture" && expected !== undefined && expected > state.revision) throw new BoardStoreError("invalid_input", "expectedRevision is newer than this inbox; read the inbox again");
      const revoking = spec.revoking?.(state) ?? false;
      await spec.prepare?.(state);
      const at = new Date(this.now()).toISOString();
      const value = spec.preloadPublic ? await pub.get() : undefined;
      const { subject, ...details } = spec.change(state, at, { value, touch: pub.touch });
      const revision = await commit({ eventId: input.eventId, operation, digest, subject, details, revoking, headroom: spec.headroom }, at);
      return { ...details, revision, committedRevision: revision, replayed: false, ...spec.decorate?.(state) };
    });
  }

  private source(state: State, sourceId: string, deploymentId: string): SourceRecord {
    const source = state.sources.find(item => item.sourceId === sourceId);
    if (!source || source.deploymentId !== deploymentId || !source.enabled) deny("Comment source is not enabled for this deployment");
    return source!;
  }
  private authenticateSource(state: State, actor: Extract<InboxActor, { kind: "ingress" }>, requireEnabled = true) {
    const source = requireEnabled ? this.source(state, actor.sourceId, actor.deploymentId) : state.sources.find(item => item.sourceId === actor.sourceId && item.deploymentId === actor.deploymentId) ?? deny("Comment source is not registered for this deployment");
    if (typeof actor.credential !== "string" || actor.credential.length < 32 || actor.credential.length > 512 || !timingSafeEqual(Buffer.from(hash(actor.credential), "hex"), Buffer.from(source.credentialHash, "hex"))) deny("Invalid comment source credential");
  }
  private path(scope: InboxScope) { return join(this.directory, `${hash(canonicalJson(scope))}.json`); }
  private async load(path: string, scope: InboxScope): Promise<State> {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new BoardStoreError("unsafe_path", "Inbox storage must be a regular file");
      if (stat.size > INBOX_LIMITS.storageBytes) throw new BoardStoreError("size_limit", "Inbox storage is too large; no data was changed");
      const state = StateSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (canonicalJson(state.scope) !== canonicalJson(scope) || state.revision !== state.receipts.length || state.revision !== state.audit.length || state.audit.some((item, index) => item.revision !== index + 1 || item.eventId !== state.receipts[index]?.eventId || state.receipts[index].revision !== index + 1) || new Set(state.receipts.map(item => item.eventId)).size !== state.receipts.length || new Set(state.sources.map(item => item.sourceId)).size !== state.sources.length || new Set(state.comments.map(item => item.id)).size !== state.comments.length || state.comments.some(item => item.id !== commentIdOf(item.sourceId, item.externalId) || item.truncated !== undefined || !state.sources.some(source => source.sourceId === item.sourceId && source.deploymentId === item.deploymentId))) throw new Error("Inbox ledger identity or sequence mismatch");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, scope, revision: 0, policy: { read: false, triage: false }, sources: [], comments: [], audit: [], receipts: [] };
      if (error instanceof BoardStoreError) throw error;
      throw new BoardStoreError("corrupt_storage", "Inbox could not be read; existing data was not changed");
    }
  }
  private async write(path: string, state: State, revoking: boolean, headroom: boolean) {
    // Public fields are read results only; the stored ledger keeps the 77ca22a shape (public-threads §12 A4).
    const data = JSON.stringify(StateSchema.parse({ ...state, comments: state.comments.map(stripPublic) }));
    const bytes = Buffer.byteLength(data, "utf8");
    if (headroom && bytes > INBOX_LIMITS.headroomBytes) throw new BoardStoreError("size_limit", "收件箱接近上限，自动同步已停止。请在「评论与权限」里归档已处理的评论。", { detail: "headroom", resource: "bytes", count: bytes });
    const limit = INBOX_LIMITS.storageBytes - (revoking ? 0 : 128_000);
    if (bytes > limit) throw new BoardStoreError("size_limit", "Inbox storage limit reached; this operation was not committed and access can still be revoked");
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
}

function actorId(actor: InboxActor): string { return actor.kind === "agent" ? actor.agentId : actor.kind === "user" ? actor.id : actor.sourceId; }
function archivable(comment: InboxComment, statuses: readonly string[]) {
  return statuses.includes(comment.status) && !(comment.pendingReply && comment.pendingReply.state !== "failed");
}
function pendingRows(state: State): InboxPendingRow[] {
  return state.comments.filter(comment => comment.pendingReply).map(comment => structuredClone({ commentId: comment.id, sourceId: comment.sourceId, deploymentId: comment.deploymentId, externalId: comment.externalId, pending: comment.pendingReply! }));
}
function replayOf(state: State, comment: InboxComment | undefined, eventId: string): PrepareReplyResult {
  const reply = comment?.replies?.find(item => item.eventId === eventId);
  if (comment && reply) return { kind: "published", reply: structuredClone(reply), revision: state.revision, commentRevision: comment.revision, replayed: true };
  if (comment?.pendingReply?.eventId === eventId) return { kind: "pending", pending: structuredClone(comment.pendingReply), comment: { sourceId: comment.sourceId, deploymentId: comment.deploymentId, externalId: comment.externalId }, revision: state.revision, commentRevision: comment.revision, replayed: true };
  return { kind: "gone", revision: state.revision, commentRevision: comment?.revision ?? 1 };
}
/** Dedupe compares normalized stored fields with normalized incoming fields (DESIGN §11.5 step 4). */
function normalizedExternal(comment: InboxComment | InboxExternalComment): unknown {
  const fields = "contentTrust" in comment ? externalFields(comment) : comment;
  const normalized = normalizeExternalComment(JSON.parse(JSON.stringify(fields)), 0);
  return normalized.ok ? normalized.comment : fields;
}
/** The next stored policy. Absent `auto` keeps the current mode while read and triage stay on. */
export function nextPolicy(current: InboxPolicy, requested: InboxPolicy, options: { allowAutoEnable?: boolean } = {}): InboxPolicy {
  const currentAuto = autoOf(current);
  let auto: InboxAutoMode = requested.auto ?? (requested.read && requested.triage ? currentAuto : "off");
  if (!requested.read || !requested.triage) auto = "off";
  if (currentAuto === "off" && auto !== "off" && !options.allowAutoEnable) throw new BoardStoreError("invalid_input", "开启自动处理需要通过确认步骤。");
  return { read: requested.read, triage: requested.triage, auto };
}
function isPolicyRevocation(previous: InboxPolicy, next: InboxPolicy) {
  const before = autoOf(previous), after = autoOf(next);
  const noGrant = (!next.read || previous.read) && (!next.triage || previous.triage) && (after === "off" || after === before);
  const removes = previous.read && !next.read || previous.triage && !next.triage || before !== "off" && after === "off";
  return noGrant && removes;
}
