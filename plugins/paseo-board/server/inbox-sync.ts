import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  INBOX_AUTO_LIMITS, INBOX_LIMITS, InboxHumanReplyInputSchema, InboxReplyInputSchema, InboxReplyPendingInputSchema, normalizeExternalComment,
  type InboxActor, type InboxExternalComment, type InboxMutationResult, type InboxPendingReply, type InboxReplyResult, type InboxScope,
} from "../shared/inbox";
import { InboxConnectInputSchema, InboxConnectionSchema, InboxSyncInputSchema, InboxReconcileInputSchema, type InboxConnectInput, type InboxSyncInput } from "../shared/inbox-connection";
import { IdSchema } from "../shared/contracts";
import { BoardStoreError, ensureDirectory, fingerprint, parseInput, serialized } from "./store-format";
import type { InboxPublicOutboxItem, InboxStore, PrepareReplyResult } from "./inbox-store";
import { recordKey } from "./inbox-public-ledger";
import type { InboxPublicRow } from "../shared/inbox";
import { replyGuardMessage, replyGuardReason } from "./reply-guard";
import { BIDI_CONTROL } from "../shared/bidi";

const human: InboxActor = { kind: "user", id: "paseo-client" };
/** The coordinator's own read-only calls (DESIGN §11.8 "Internal actors"). */
export const AUTOMATION_ACTOR: InboxActor = { kind: "user", id: "paseo-board-automation" };
const StoredConnectionSchema = InboxConnectionSchema.extend({ token: z.string(), credential: z.string(), digest: z.string(), input: InboxConnectInputSchema.omit({ token: true }) });
const PrivateConnectionSchema = StoredConnectionSchema.extend({ previous: StoredConnectionSchema.optional() });
type PrivateConnection = z.infer<typeof PrivateConnectionSchema>;
/** v1 and v2 envelopes (DESIGN §11.10): rows are checked one by one, never by the envelope schema. */
const EnvelopeSchema = z.object({
  deploymentId: IdSchema, cursor: z.string().min(1).max(500), nextCursor: z.string().min(1).max(500),
  comments: z.array(z.unknown()).max(INBOX_LIMITS.importPage), format: z.literal(2).optional(),
  /** Public threads (`threads=1`, public-threads §5.3): rows may carry their public extension. */
  threads: z.literal(1).optional(),
}).strict();
const PublicMessageSchema = z.object({
  id: z.string().min(1).max(200), by: z.enum(["visitor", "owner", "agent"]), tag: z.string().regex(/^[a-f0-9]{12}$/).optional(), name: z.string().max(160).optional(),
  text: z.string().max(8_000), createdAt: z.string().max(40), hidden: z.boolean().optional(), withdrawn: z.literal(true).optional(), replyTo: z.string().max(200).optional(),
}).strict();
/** The backend's owner moderation listing (`GET …/public/moderation`). */
const ModerationSchema = z.object({
  deploymentId: z.string(), publicThreads: z.boolean(),
  pages: z.array(z.object({ page: z.string().max(2_000), version: z.number().int().nonnegative(), paused: z.boolean() }).strict()).max(500),
  releases: z.array(z.string().max(80)).max(1_000), total: z.number().int().nonnegative(), truncated: z.boolean(),
  threads: z.array(PublicMessageSchema.omit({ by: true }).extend({ page: z.string().max(2_000), resolved: z.boolean(), hidden: z.boolean(), anchor: z.record(z.string(), z.unknown()).optional(), replies: z.array(PublicMessageSchema).max(100), omitted: z.number().int().nonnegative() }).strict()).max(100),
}).strict();
export type ModerationListing = z.infer<typeof ModerationSchema>;
/** The backend's current page state could not be read (unreachable, refused, too old or not the same deployment). */
export const PUBLIC_CHECK_FAILED = "暂时无法向评论后端确认公开讨论现在在页面上的样子，评论助手这次不能读取或回复公开评论。";
/**
 * What one page shows now, from the owner moderation listing: `visible` holds the external IDs of visible roots and of
 * the visible visitor replies of visible roots; `withdrawn` every row a visitor withdrew. A backend with public
 * comments turned off shows nothing. A visitor message without an explicit `hidden: false` counts as not shown.
 */
export function pageVisibility(listing: ModerationListing): { visible: Set<string>; withdrawn: string[] } {
  const visible = new Set<string>(), withdrawn: string[] = [];
  for (const thread of listing.threads) {
    if (thread.withdrawn) withdrawn.push(thread.id);
    const rootShown = listing.publicThreads && !thread.hidden && !thread.withdrawn;
    if (rootShown) visible.add(thread.id);
    for (const message of thread.replies) {
      if (message.by !== "visitor") continue;
      if (message.withdrawn) withdrawn.push(message.id);
      if (rootShown && message.hidden === false && !message.withdrawn) visible.add(message.id);
    }
  }
  return { visible, withdrawn };
}
export type PublicPostOutcome = { kind: "ok"; echo: { hidden?: boolean; resolved?: boolean; withdrawn?: boolean; changed?: number } } | { kind: "transient"; error: string; retryAfterMs?: number } | { kind: "fail"; message: string; code?: string };
const ReplyResponseSchema = z.object({
  deploymentId: z.string(), replayed: z.boolean().optional(),
  reply: z.object({ replyId: z.string().min(1).max(200), commentExternalId: z.string(), text: z.string(), createdAt: z.string().datetime() }).passthrough(),
}).passthrough();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// Accommodates all 32 sources at their UTF-8 field limits, including a pending
// replacement and its previous settings. Read and write must use the same cap.
const CONNECTION_FILE_BYTES = 2 * 1024 * 1024;
const ConnectionFileSchema = z.array(PrivateConnectionSchema).max(INBOX_LIMITS.sources);

/** Private, server-only view of one source for the coordinator. Never returned by an RPC or tool. */
export interface RuntimeSource { sourceId: string; deploymentId: string; label: string; endpoint: string; token: string; credential: string; enabled: boolean; ready: boolean }
export interface FetchedPage { format: 1 | 2; deploymentId: string; cursor: string; nextCursor: string; rows: unknown[]; characters: number; threads?: boolean }
export type SyncFailureKind = "network" | "http" | "envelope" | "identity" | "too-large";
/** A classified export failure; `message` is the panel's `lastError` text (DESIGN §4.8, §11.5). */
export class SyncFailure extends Error {
  constructor(readonly kind: SyncFailureKind, message: string, readonly status?: number, readonly retryAfterMs?: number) { super(message); this.name = "SyncFailure"; }
}
export const IDENTITY_MISMATCH = "后端身份或游标与记录不一致：可能换了数据库或部署，请登记新的来源。";
export interface ReplyEvent { commentId: string; key: string; status: InboxReplyResult["status"]; recorded: boolean; pending?: InboxPendingReply; lastError?: string }

const describe = (error: unknown) => {
  const value = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (value?.name === "TimeoutError" || value?.name === "AbortError") return "请求超时";
  const cause = value?.cause?.code ?? value?.cause?.message;
  return `${value?.message ?? String(error)}${cause ? ` (${cause})` : ""}`.slice(0, 200);
};
const PAGE_TOO_LARGE = "后端返回的一页数据超过上限，自动同步已停止。";
/** The owner moderation listing, too large to read (a backend older than the byte budget). */
export const MODERATION_TOO_LARGE = "后端返回的公开评论列表超过上限，暂时无法显示。请在应用目录运行 paseo-board-app update-runtime，然后重新部署。";
async function readLimited(response: Response, limit: number, tooLarge = PAGE_TOO_LARGE): Promise<string> {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new SyncFailure("too-large", tooLarge); }
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > limit) throw new SyncFailure("too-large", tooLarge); chunks.push(chunk.value); }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  return Buffer.concat(chunks).toString("utf8");
}
const retryAfter = (response: Response) => {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, INBOX_AUTO_LIMITS.retryAfterMaxMs) : undefined;
};
function httpFailure(status: number, retry?: number): SyncFailure {
  if (status === 401 || status === 403) return new SyncFailure("http", `后端拒绝了导出令牌（HTTP ${status}）。请在「后端来源」里更新令牌。`, status);
  if (status === 404) return new SyncFailure("http", "后端没有开启评论导出（HTTP 404）。", status);
  return new SyncFailure("http", `后端返回 HTTP ${status}`, status, retry);
}

/** Per-row normalization (DESIGN §11.5): valid rows import, bad rows are quarantined, the cursor still advances. */
export function normalizePage(rows: readonly unknown[]): { comments: InboxExternalComment[]; quarantined: Array<{ externalId: string; field: string; reason: string }>; sanitized: number; publicRows: InboxPublicRow[] } {
  const comments: InboxExternalComment[] = [], quarantined: Array<{ externalId: string; field: string; reason: string }> = [], seen = new Set<string>(), publicRows: InboxPublicRow[] = [];
  let sanitized = 0;
  rows.forEach((row, index) => {
    const result = normalizeExternalComment(row, index);
    if (!result.ok) { quarantined.push({ externalId: result.externalId, field: result.field, reason: result.reason.slice(0, 200) }); return; }
    if (seen.has(result.comment.externalId)) { quarantined.push({ externalId: result.comment.externalId, field: "externalId", reason: "externalId: duplicate_in_page" }); return; }
    seen.add(result.comment.externalId);
    sanitized += result.dropped.length;
    comments.push(result.comment);
    if (result.public) publicRows.push(result.public);
  });
  return { comments, quarantined, sanitized, publicRows };
}
const PAGE_CHARACTERS = (comments: readonly InboxExternalComment[]) => comments.reduce((sum, item) => sum + JSON.stringify(item).length, 0);

/** `回复需要 1–2000 字的纯文本。` — normalized text is what is stored, hashed and posted (DESIGN §11.7). */
export function normalizeReplyText(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  // eslint-disable-next-line no-control-regex
  if (!text || text.length > INBOX_LIMITS.replyText || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || BIDI_CONTROL.test(text)) throw new BoardStoreError("invalid_input", "回复需要 1–2000 字的纯文本。");
  return text;
}
export const replyKey = (scope: InboxScope, commentId: string, eventId: string) => `ir-${hash(`${scope.boardId}\0${scope.expectedCreatedAt}\0${commentId}\0${eventId}`).slice(0, 48)}`;
const MESSAGES = {
  published: "已回复，访客页面会在十几秒内显示。",
  unrecorded: "已发送给访客；本地记录稍后自动补上。不要用新的 eventId 重试。",
  sending: "回复已排队，系统会用同一编号自动重试。不要用新的 eventId 重试。",
  draft: "回复已保存为草稿，等用户审核后发布。",
};
type PostOutcome = { kind: "ok"; replyId: string; createdAt: string } | { kind: "transient"; error: string } | { kind: "fail"; code: string; message: string };

/** Human-configured pull boundary. Secrets never enter Board data, agent results or exported HTML. */
export class InboxConnections {
  private readonly directory: string;
  private readonly listeners = new Set<(scope: InboxScope, event: ReplyEvent) => void>();
  constructor(root: string, private readonly inbox: InboxStore, private readonly fetcher: typeof fetch = fetch) { this.directory = join(root, "inbox-connections"); }
  private path(scope: InboxScope) { return join(this.directory, `${hash(JSON.stringify([scope.boardId, scope.expectedCreatedAt]))}.json`); }
  private public(record: PrivateConnection) { const { sourceId, deploymentId, label, endpoint, enabled, state, eventId } = record; return InboxConnectionSchema.parse({ sourceId, deploymentId, label, endpoint, enabled, state, eventId }); }
  private async load(path: string): Promise<PrivateConnection[]> {
    await ensureDirectory(this.directory);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CONNECTION_FILE_BYTES) throw new Error("Unsafe inbox connection file");
      return ConnectionFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private async save(path: string, records: PrivateConnection[]) {
    const encoded = JSON.stringify(ConnectionFileSchema.parse(records));
    if (Buffer.byteLength(encoded, "utf8") > CONNECTION_FILE_BYTES) throw new BoardStoreError("size_limit", "Inbox connection settings exceed the storage limit");
    await ensureDirectory(this.directory);
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
    try { await rename(temp, path); } finally { await unlink(temp).catch(() => undefined); }
  }
  /** One lock per source, shared by manual sync, auto-sync and reply POSTs. */
  withSourceLock<T>(scope: InboxScope, sourceId: string, work: () => Promise<T>): Promise<T> { return serialized(`${this.path(scope)}#source:${sourceId}`, work); }
  onReply(listener: (scope: InboxScope, event: ReplyEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(scope: InboxScope, event: ReplyEvent) { for (const listener of this.listeners) { try { listener(scope, event); } catch { /* listeners are advisory */ } } }

  async list(scope: InboxScope) {
    await this.inbox.list({ ...scope, limit: 1 }, human); // validates current Board identity
    return (await this.load(this.path(scope))).map(record => this.public(record));
  }
  /** Every Board scope with a connection file, for the coordinator's discovery. */
  async scopes(): Promise<InboxScope[]> {
    await ensureDirectory(this.directory);
    const scopes = new Map<string, InboxScope>();
    for (const name of (await readdir(this.directory)).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        for (const record of await this.load(join(this.directory, name))) {
          const scope = { boardId: record.input.boardId, expectedCreatedAt: record.input.expectedCreatedAt };
          if (join(this.directory, name) === this.path(scope)) scopes.set(JSON.stringify(scope), scope);
        }
      } catch { /* an unreadable file is reported when that Board's inbox is opened */ }
    }
    return [...scopes.values()];
  }
  /** Private records for the coordinator (endpoint, token, credential). Server memory only. */
  async runtimeSources(scope: InboxScope): Promise<RuntimeSource[]> {
    return (await this.load(this.path(scope))).map(record => ({ sourceId: record.sourceId, deploymentId: record.deploymentId, label: record.label, endpoint: record.endpoint, token: record.token, credential: record.credential, enabled: record.enabled, ready: record.state === "ready" }));
  }
  private guardContext(records: readonly PrivateConnection[]) {
    return {
      tokens: records.flatMap(record => [record.token, record.credential, ...(record.previous ? [record.previous.token, record.previous.credential] : [])]),
      endpoints: records.flatMap(record => [record.endpoint, ...(record.previous ? [record.previous.endpoint] : [])]),
    };
  }

  async connect(raw: InboxConnectInput) {
    const input = InboxConnectInputSchema.parse(raw), path = this.path(input);
    return serialized(path, async () => {
      const page = await this.inbox.list({ boardId: input.boardId, expectedCreatedAt: input.expectedCreatedAt, limit: 1 }, human);
      const records = await this.load(path), previous = records.find(record => record.sourceId === input.sourceId);
      if (previous?.eventId !== input.eventId && (previous?.eventId ?? null) !== input.expectedConnectionEventId) throw new BoardStoreError("revision_conflict", "Source connection changed; refresh and review its current endpoint before saving");
      if (previous && previous.deploymentId !== input.deploymentId) throw new Error("Use a new source ID for a different deployment");
      if (previous?.state === "pending" && previous.eventId !== input.eventId) throw new Error("A source configuration is pending; reconcile the original action first");
      const token = input.token ?? previous?.token;
      if (!token) throw new Error("An export token is required for a new source");
      const digest = fingerprint("inbox-connection", { ...input, token });
      if (previous?.eventId === input.eventId && previous.digest !== digest) throw new Error("Source event ID reused with different settings");
      if (previous?.eventId !== input.eventId && page.revision !== input.expectedRevision) throw new BoardStoreError("revision_conflict", "Inbox changed; refresh before saving source settings");
      if (!previous && records.length >= INBOX_LIMITS.sources) throw new Error("Inbox source limit reached");
      const { token: _token, ...safeInput } = input;
      const prior = previous?.state === "pending" ? previous.previous : previous;
      const record: PrivateConnection = { sourceId: input.sourceId, deploymentId: input.deploymentId, label: input.label, endpoint: input.endpoint, enabled: input.enabled, state: "pending", eventId: input.eventId, input: safeInput, token, digest, credential: previous?.eventId === input.eventId ? previous.credential : randomBytes(32).toString("hex"), ...(prior ? { previous: StoredConnectionSchema.parse(prior) } : {}) };
      const next = [...records.filter(item => item.sourceId !== input.sourceId), record];
      await this.save(path, next);
      try {
        await this.inbox.setSource({ boardId: input.boardId, expectedCreatedAt: input.expectedCreatedAt, expectedRevision: input.expectedRevision, eventId: input.eventId, sourceId: input.sourceId, deploymentId: input.deploymentId, label: input.label, enabled: input.enabled, credential: record.credential }, human);
      } catch (error) {
        // Domain failures happen before commit. Unknown I/O outcomes retain the
        // original pending action, including credentials, for exact replay.
        if (error instanceof BoardStoreError && ["revision_conflict", "identity_conflict", "size_limit", "forbidden", "invalid_input"].includes(error.code)) {
          await this.save(path, [...records.filter(item => item.sourceId !== input.sourceId), ...(prior ? [prior] : [])]);
        }
        throw error;
      }
      record.state = "ready"; delete record.previous; await this.save(path, next);
      return this.public(record);
    });
  }
  async reconcile(raw: z.infer<typeof InboxReconcileInputSchema>) {
    const input = InboxReconcileInputSchema.parse(raw);
    await this.inbox.list({ boardId: input.boardId, expectedCreatedAt: input.expectedCreatedAt, limit: 1 }, human);
    const record = (await this.load(this.path(input))).find(item => item.sourceId === input.sourceId);
    if (!record || record.eventId !== input.eventId) throw new Error("Source configuration changed; refresh before reconciling");
    try { await this.connect({ ...record.input, token: record.token }); return { state: "ready" as const }; }
    catch (error) {
      if (error instanceof BoardStoreError && error.code === "revision_conflict") return { state: "cancelled" as const };
      throw error;
    }
  }

  /** One authenticated export page (`format=2`; an old runtime answers v1). Classified failures, unchanged cursor. */
  async fetchPage(source: Pick<RuntimeSource, "endpoint" | "token" | "deploymentId">, cursor: string, limit: number): Promise<FetchedPage> {
    const url = new URL(source.endpoint);
    // threads=1: public visitor replies and public state (public-threads §5.2.7); older runtimes ignore it.
    url.searchParams.set("cursor", cursor); url.searchParams.set("limit", String(limit)); url.searchParams.set("format", "2"); url.searchParams.set("threads", "1");
    let response: Response;
    try { response = await this.fetcher(url.toString(), { headers: { Authorization: `Bearer ${source.token}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) as RequestInit["signal"] }); }
    catch (error) { throw new SyncFailure("network", `连接不上后端：${describe(error)}`); }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw httpFailure(response.status, retryAfter(response)); }
    let body: string;
    try { body = await readLimited(response, INBOX_AUTO_LIMITS.responseBytes); }
    catch (error) { if (error instanceof SyncFailure) throw error; throw new SyncFailure("network", `连接不上后端：${describe(error)}`); }
    let value: unknown;
    try { value = JSON.parse(body); } catch { throw new SyncFailure("envelope", "后端返回的数据格式无法识别（JSON）。请确认后端由 paseo-board-app 生成，并已运行 update-runtime。"); }
    const parsed = EnvelopeSchema.safeParse(value);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path.map(String).join(".") || (parsed.error.issues[0]?.code === "unrecognized_keys" ? (parsed.error.issues[0] as { keys?: string[] }).keys?.join(",") : "") || "页面";
      throw new SyncFailure("envelope", `后端返回的数据格式无法识别（${String(path).slice(0, 80)}）。请确认后端由 paseo-board-app 生成，并已运行 update-runtime。`);
    }
    const page = parsed.data;
    if (page.deploymentId !== source.deploymentId || page.cursor !== cursor) throw new SyncFailure("identity", IDENTITY_MISMATCH);
    return { format: page.format === 2 ? 2 : 1, deploymentId: page.deploymentId, cursor: page.cursor, nextCursor: page.nextCursor, rows: page.comments, characters: JSON.stringify(page.comments).length, ...(page.threads === 1 ? { threads: true } : {}) };
  }
  static unchanged(page: FetchedPage, cursor: string) { return !page.rows.length && page.nextCursor === cursor; }
  /** Normalize and import one fetched page as the source's ingress actor. Call under the source lock. */
  async importFetched(scope: InboxScope, source: Pick<RuntimeSource, "sourceId" | "deploymentId" | "credential">, cursor: string, page: FetchedPage): Promise<InboxMutationResult> {
    const { comments, quarantined, sanitized, publicRows } = normalizePage(page.rows);
    if (PAGE_CHARACTERS(comments) > INBOX_LIMITS.importCharacters) throw new BoardStoreError("invalid_input", "Import page is too large");
    return this.inbox.importPage({ ...scope, eventId: `sync-${randomUUID()}`, sourceId: source.sourceId, deploymentId: source.deploymentId, cursor, nextCursor: page.nextCursor, comments, ...(quarantined.length ? { quarantined } : {}), ...(sanitized ? { sanitized } : {}), ...(publicRows.length ? { publicRows } : {}) }, { kind: "ingress", sourceId: source.sourceId, deploymentId: source.deploymentId, credential: source.credential });
  }

  /** Manual 立即同步: the same path as auto-sync. Accepts any expectedRevision up to the current one. */
  async sync(raw: InboxSyncInput) {
    const input = InboxSyncInputSchema.parse(raw), scope = { boardId: input.boardId, expectedCreatedAt: input.expectedCreatedAt }, path = this.path(input);
    const record = (await this.load(path)).find(item => item.sourceId === input.sourceId);
    if (!record || record.state !== "ready" || !record.enabled) throw new Error("An enabled, completed source configuration is required");
    return this.withSourceLock(scope, record.sourceId, async () => {
      const state = await this.inbox.list({ ...scope, limit: 1 }, human);
      if (input.expectedRevision > state.revision) throw new BoardStoreError("invalid_input", "expectedRevision is newer than this inbox; refresh before syncing");
      const source = state.sources.find(item => item.sourceId === record.sourceId && item.deploymentId === record.deploymentId && item.enabled);
      if (!source) throw new Error("Source permission was removed or replaced");
      let page = await this.fetchPage(record, source.cursor, INBOX_AUTO_LIMITS.pageLimit);
      if (InboxConnections.unchanged(page, source.cursor)) return { revision: state.revision, committedRevision: Math.max(state.revision, 1), replayed: false, imported: 0, duplicates: 0, cursor: source.cursor, unchanged: true };
      try { return { ...await this.importFetched(scope, record, source.cursor, page), unchanged: false }; }
      catch (error) {
        if (!(error instanceof BoardStoreError && error.code === "invalid_input" && error.message.includes("Import page is too large"))) throw error;
        page = await this.fetchPage(record, source.cursor, INBOX_AUTO_LIMITS.smallPageLimit);
        return { ...await this.importFetched(scope, record, source.cursor, page), unchanged: false };
      }
    });
  }

  /** Agent (`board_inbox_reply`) or human (`board.inbox.reply`) reply through the write-ahead outbox (DESIGN §11.7). */
  async reply(raw: unknown, actor: InboxActor, options: { onPage?: ReadonlySet<string>; authorText?: readonly string[] } = {}): Promise<InboxReplyResult> {
    const input = actor.kind === "user" ? parseInput(InboxHumanReplyInputSchema, raw) : parseInput(InboxReplyInputSchema, raw);
    if (actor.kind === "ingress") throw new BoardStoreError("forbidden", "Source credentials cannot reply");
    const scope = { boardId: input.boardId, expectedCreatedAt: input.expectedCreatedAt };
    const text = normalizeReplyText(input.text);
    const records = await this.load(this.path(scope));
    const allowSensitive = actor.kind === "user" && "allowSensitive" in input && input.allowSensitive === true;
    if (!allowSensitive) this.guard(text, records);
    const prepared = await this.inbox.prepareReply({ ...scope, commentId: input.commentId, expectedCommentRevision: input.expectedCommentRevision, eventId: input.eventId, text, resolve: input.resolve, key: replyKey(scope, input.commentId, input.eventId), ...(allowSensitive ? { approvedSensitive: true } : {}) }, actor, { readySources: records.filter(record => record.state === "ready" && record.enabled).map(({ sourceId, deploymentId }) => ({ sourceId, deploymentId })), ...(options.onPage ? { onPage: options.onPage } : {}), ...(options.authorText?.length ? { authorText: options.authorText } : {}) });
    return this.continueReply(scope, input.commentId, prepared);
  }
  /** Human publish / retry / discard of a pending reply (`board.inbox.reply-pending`). */
  async replyPending(raw: unknown): Promise<InboxReplyResult> {
    const input = parseInput(InboxReplyPendingInputSchema, raw);
    const scope = { boardId: input.boardId, expectedCreatedAt: input.expectedCreatedAt };
    const text = input.text === undefined ? undefined : normalizeReplyText(input.text);
    if (input.action === "publish" && !input.allowSensitive) {
      const current = await this.inbox.replyState(scope, input.commentId, input.key, AUTOMATION_ACTOR);
      const candidate = text ?? current.pending?.text;
      if (candidate) this.guard(candidate, await this.load(this.path(scope)));
    }
    const prepared = await this.inbox.pendingAction({ ...scope, eventId: input.eventId, commentId: input.commentId, key: input.key, action: input.action, ...(text !== undefined ? { text } : {}), ...(input.allowSensitive ? { approvedSensitive: true } : {}) }, human);
    if (prepared.kind === "gone") {
      this.emit(scope, { commentId: input.commentId, key: input.key, status: "failed", recorded: true });
      return { status: "failed", recorded: true, replayed: false, revision: prepared.revision, commentRevision: prepared.commentRevision, message: "回复已丢弃。" };
    }
    return this.continueReply(scope, input.commentId, prepared);
  }
  /** Outbox retry of one `sending` pending with its original key. */
  async retryPending(scope: InboxScope, commentId: string, key: string): Promise<InboxReplyResult> {
    const current = await this.inbox.replyState(scope, commentId, key, AUTOMATION_ACTOR);
    if (current.reply) return this.continueReply(scope, commentId, { kind: "published", reply: current.reply, revision: current.revision, commentRevision: current.commentRevision, replayed: true });
    if (!current.pending || !current.comment) return this.continueReply(scope, commentId, { kind: "gone", revision: current.revision, commentRevision: current.commentRevision });
    return this.continueReply(scope, commentId, { kind: "pending", pending: current.pending, comment: current.comment, revision: current.revision, commentRevision: current.commentRevision, replayed: true });
  }
  /** 24 hours without a confirmed delivery (DESIGN §11.7 outbox loop). */
  async expirePending(scope: InboxScope, commentId: string, key: string, lastError: string): Promise<void> {
    await this.withPendingSource(scope, commentId, key, async (record, comment) => {
      const failed = await this.inbox.failReply(scope, commentId, key, `24 小时内没能确认送达：${lastError}`.slice(0, 300), this.ingress(record));
      this.emit(scope, { commentId, key, status: "failed", recorded: true, ...(failed.kind === "pending" ? { pending: failed.pending } : {}) });
      void comment;
    });
  }

  private ingress(record: { sourceId: string; deploymentId: string; credential: string }): InboxActor { return { kind: "ingress", sourceId: record.sourceId, deploymentId: record.deploymentId, credential: record.credential }; }
  private guard(text: string, records: readonly PrivateConnection[]) {
    const reason = replyGuardReason(text, this.guardContext(records));
    if (reason) throw new BoardStoreError("invalid_input", replyGuardMessage(reason), { guard: reason });
  }
  private async withPendingSource<T>(scope: InboxScope, commentId: string, key: string, work: (record: PrivateConnection, comment: { sourceId: string; deploymentId: string; externalId: string }) => Promise<T>): Promise<T | undefined> {
    const current = await this.inbox.replyState(scope, commentId, key, AUTOMATION_ACTOR);
    if (!current.comment) return undefined;
    const comment = current.comment;
    const record = (await this.load(this.path(scope))).find(item => item.sourceId === comment.sourceId);
    if (!record) return undefined;
    return this.withSourceLock(scope, comment.sourceId, () => work(record, comment));
  }

  private async continueReply(scope: InboxScope, commentId: string, prepared: PrepareReplyResult): Promise<InboxReplyResult> {
    const base = { replayed: prepared.kind !== "gone" && prepared.replayed, revision: prepared.revision, commentRevision: prepared.commentRevision };
    if (prepared.kind === "gone") return { ...base, replayed: true, status: "failed", recorded: true, message: "回复没能送达：这条回复已被丢弃。" };
    if (prepared.kind === "published") {
      this.emit(scope, { commentId, key: prepared.reply.key, status: "published", recorded: true });
      return { ...base, status: "published", recorded: true, reply: prepared.reply, message: MESSAGES.published };
    }
    const pending = prepared.pending;
    if (pending.state === "draft") { this.emit(scope, { commentId, key: pending.key, status: "draft", recorded: true, pending }); return { ...base, status: "draft", recorded: true, pending, message: MESSAGES.draft }; }
    if (pending.state === "failed") { this.emit(scope, { commentId, key: pending.key, status: "failed", recorded: true, pending }); return { ...base, status: "failed", recorded: true, pending, message: `回复没能送达：${pending.failedReason ?? ""}`.slice(0, 300) }; }
    return this.post(scope, commentId, pending.key, base);
  }

  /** Steps 5–7: POST with the derived key under the per-source lock, then record the outcome as the source's ingress actor. */
  private async post(scope: InboxScope, commentId: string, key: string, base: { replayed: boolean; revision: number; commentRevision: number }): Promise<InboxReplyResult> {
    const outcome = await this.withPendingSource(scope, commentId, key, async (record, comment): Promise<InboxReplyResult> => {
      // Re-read inside the lock: a concurrent caller may already have confirmed this key.
      const current = await this.inbox.replyState(scope, commentId, key, AUTOMATION_ACTOR);
      if (current.reply) { this.emit(scope, { commentId, key, status: "published", recorded: true }); return { ...base, revision: current.revision, commentRevision: current.commentRevision, status: "published", recorded: true, reply: current.reply, message: MESSAGES.published }; }
      const pending = current.pending;
      if (!pending) return { ...base, revision: current.revision, commentRevision: current.commentRevision, status: "failed", recorded: true, message: "回复没能送达：这条回复已被丢弃。" };
      if (pending.state !== "sending") return this.continueReply(scope, commentId, { kind: "pending", pending, comment, revision: current.revision, commentRevision: current.commentRevision, replayed: true });
      const sending = (lastError: string): InboxReplyResult => {
        this.emit(scope, { commentId, key, status: "sending", recorded: true, pending, lastError });
        return { ...base, revision: current.revision, commentRevision: current.commentRevision, status: "sending", recorded: true, pending, message: MESSAGES.sending };
      };
      if (record.state !== "ready" || !record.enabled || record.deploymentId !== comment.deploymentId) return sending("来源已停用或已更换，回复暂停发送。");
      if (!pending.approvedSensitive) {
        const reason = replyGuardReason(pending.text, this.guardContext(await this.load(this.path(scope))));
        if (reason) {
          const failed = await this.inbox.failReply(scope, commentId, key, replyGuardMessage(reason), this.ingress(record));
          this.emit(scope, { commentId, key, status: "failed", recorded: true, ...(failed.kind === "pending" ? { pending: failed.pending } : {}) });
          throw new BoardStoreError("invalid_input", replyGuardMessage(reason), { guard: reason });
        }
      }
      const result = await this.postReply(record, comment.externalId, key, pending.text, pending.authorKind);
      if (result.kind === "transient") return sending(result.error);
      if (result.kind === "fail") {
        const failed = await this.inbox.failReply(scope, commentId, key, result.message, this.ingress(record)).catch(() => undefined);
        this.emit(scope, { commentId, key, status: "failed", recorded: Boolean(failed), ...(failed?.kind === "pending" ? { pending: failed.pending } : {}) });
        throw new BoardStoreError(result.code, result.message);
      }
      try {
        const confirmed = await this.inbox.confirmReply(scope, commentId, key, { replyId: result.replyId, createdAt: result.createdAt }, this.ingress(record));
        this.emit(scope, { commentId, key, status: "published", recorded: true });
        if (confirmed.kind === "published") return { ...base, revision: confirmed.revision, commentRevision: confirmed.commentRevision, status: "published", recorded: true, reply: confirmed.reply, message: MESSAGES.published };
        return { ...base, status: "published", recorded: true, message: MESSAGES.published };
      } catch (error) {
        // The visitor can already see it. The outbox confirms later; the backend replays the same key.
        this.emit(scope, { commentId, key, status: "published", recorded: false, pending, lastError: `本地记录失败：${describe(error)}` });
        return { ...base, revision: current.revision, commentRevision: current.commentRevision, status: "published", recorded: false, pending, message: MESSAGES.unrecorded };
      }
    });
    if (outcome) return outcome;
    throw new BoardStoreError("forbidden", "来源已停用或已更换，无法回复。");
  }

  private async postReply(record: PrivateConnection, externalId: string, key: string, text: string, authorKind: "owner" | "agent"): Promise<PostOutcome> {
    const url = new URL(record.endpoint.replace(/\/+$/, "") + "/" + encodeURIComponent(externalId) + "/replies");
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), { method: "POST", headers: { Authorization: `Bearer ${record.token}`, "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": key }, body: JSON.stringify({ text, authorKind }), redirect: "error", signal: AbortSignal.timeout(10_000) as RequestInit["signal"] });
    } catch (error) { return { kind: "transient", error: `连接不上后端：${describe(error)}` }; }
    let body: unknown = {};
    try { body = JSON.parse(await readLimited(response, 64_000)); } catch { body = {}; }
    const code = typeof (body as { code?: unknown }).code === "string" && /^[a-z_]{1,40}$/.test((body as { code: string }).code) ? (body as { code: string }).code : undefined;
    if (response.status === 200 || response.status === 201) {
      const parsed = ReplyResponseSchema.safeParse(body);
      if (parsed.success && parsed.data.deploymentId === record.deploymentId && parsed.data.reply.commentExternalId === externalId && parsed.data.reply.text === text) return { kind: "ok", replyId: parsed.data.reply.replyId, createdAt: parsed.data.reply.createdAt };
      return { kind: "fail", code: "identity_conflict", message: "后端返回的回复与请求不一致（可能换了部署）。" };
    }
    if (response.status === 429 || response.status >= 500) return { kind: "transient", error: `后端返回 HTTP ${response.status}` };
    if (response.status === 401 || response.status === 403) return { kind: "transient", error: "后端拒绝了收件箱令牌，请在「后端来源」里更新。" };
    if (response.status === 404 && code === "comment_not_found") return { kind: "fail", code: "not_found", message: "后端没有这条评论（后端可能已更换或恢复了旧数据）。" };
    // Backend configuration the human can fix and redeploy: keep the pending reply and retry with the same key.
    if (response.status === 404 && code === "export_disabled") return { kind: "transient", error: "后端没有设置收件箱令牌（BOARD_INBOX_EXPORT_TOKEN），回复暂停发送；设置后重新部署即可继续。" };
    if (response.status === 404 && code === "comments_disabled") return { kind: "transient", error: "后端关闭了评论功能（board-app.json 的 comments.enabled），回复暂停发送；重新开启并部署后即可继续。" };
    if (response.status === 404) return { kind: "fail", code: "backend_outdated", message: "后端版本过旧，不支持回复：在应用目录运行 paseo-board-app update-runtime，然后重新部署。" };
    if (response.status === 409 && code === "idempotency_conflict") return { kind: "fail", code: "idempotency_conflict", message: "这个回复编号已用于另一条回复。" };
    if (response.status === 409 && code === "reply_limit") return { kind: "fail", code: "size_limit", message: "这条评论的回复已达 20 条上限。" };
    return { kind: "fail", code: "backend_rejected", message: `后端拒绝了这条回复（HTTP ${response.status}${code ? `：${code}` : ""}）。` };
  }

  // -----------------------------------------------------------------------------------------------------------
  // Public comment threads (public-threads §5.4.2, §12 A2, A3): owner calls with the source's token, never from a browser.

  private async ownerCall(source: Pick<RuntimeSource, "endpoint" | "token">, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<{ status: number; code?: string; body: unknown; retryAfterMs?: number }> {
    const url = source.endpoint.replace(/\/+$/, "") + path;
    const response = await this.fetcher(url, { method, headers: { Authorization: `Bearer ${source.token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(10_000) as RequestInit["signal"] });
    let parsed: unknown = {};
    try { parsed = JSON.parse(await readLimited(response, INBOX_AUTO_LIMITS.responseBytes, "后端返回的数据超过上限。")); } catch (error) { if (error instanceof SyncFailure) throw error; parsed = {}; }
    const code = typeof (parsed as { code?: unknown }).code === "string" && /^[a-z_]{1,40}$/.test((parsed as { code: string }).code) ? (parsed as { code: string }).code : undefined;
    return { status: response.status, ...(code ? { code } : {}), body: parsed, ...(retryAfter(response) ? { retryAfterMs: retryAfter(response) } : {}) };
  }
  /** One outbox item: a state change (POST …/<id>/state), a page pause or a bulk hide. */
  async postPublic(source: Pick<RuntimeSource, "endpoint" | "token" | "deploymentId">, item: InboxPublicOutboxItem): Promise<PublicPostOutcome> {
    let result: Awaited<ReturnType<InboxConnections["ownerCall"]>>;
    try {
      result = item.kind === "state" ? await this.ownerCall(source, "POST", `/${encodeURIComponent(item.externalId)}/state`, item.send)
        : item.action.kind === "pause" ? await this.ownerCall(source, "POST", "/public/pause", { page: item.action.page, paused: item.action.value })
          : await this.ownerCall(source, "POST", "/public/hide-visitor", { page: item.action.page, tag: item.action.tag, hidden: item.action.value });
    } catch (error) { return { kind: "transient", error: `连接不上后端：${describe(error)}` }; }
    const { status, code } = result, body = result.body as Record<string, unknown>;
    if (status === 200) {
      if (body.deploymentId !== source.deploymentId) return { kind: "fail", message: "后端返回的结果与请求不一致（可能换了部署）。" };
      if (item.kind === "state") {
        const state = body.state as Record<string, unknown> | undefined;
        if (!state || state.externalId !== item.externalId || Object.entries(item.send).some(([key, value]) => state[key] !== value)) return { kind: "fail", message: "后端返回的结果与请求不一致（可能换了部署）。" };
        return { kind: "ok", echo: { hidden: state.hidden === true, resolved: state.resolved === true, ...(state.withdrawn === true ? { withdrawn: true } : {}) } };
      }
      return { kind: "ok", echo: typeof body.changed === "number" ? { changed: body.changed } : {} };
    }
    if (status === 429 || status >= 500) return { kind: "transient", error: `后端返回 HTTP ${status}`, ...(result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : {}) };
    if (status === 401 || status === 403 && code !== "browser_forbidden") return { kind: "transient", error: "后端拒绝了收件箱令牌，请在「后端来源」里更新。" };
    if (status === 404 && (code === "export_disabled" || code === "comments_disabled")) return { kind: "transient", error: code === "export_disabled" ? "后端没有设置收件箱令牌（BOARD_INBOX_EXPORT_TOKEN）；设置后重新部署即可继续。" : "后端关闭了评论功能；重新开启并部署后即可继续。" };
    if (status === 404 && code === "comment_not_found") return { kind: "fail", message: "后端没有这条评论（后端可能已更换或恢复了旧数据）。" };
    if (status === 404) return { kind: "fail", message: "后端版本过旧，不支持隐藏或标为已解决：在应用目录运行 paseo-board-app update-runtime，然后重新部署。" };
    if (status === 409 && code === "not_public") return { kind: "fail", message: "后端认为这条评论不是公开评论。" };
    if (status === 409 && code === "withdrawn") return { kind: "fail", code, message: "访客已撤回这条评论，不能再在页面上显示。" };
    return { kind: "fail", message: `后端拒绝了这次更新（HTTP ${status}${code ? `：${code}` : ""}）。` };
  }
  /**
   * Registers or unregisters a public release on the backend this Board's inbox is connected to (matched by deployment).
   * `pages` names the share's page addresses: unregistering closes them to every release, registering reopens them.
   */
  async publicRelease(scope: InboxScope, deploymentId: string, releaseId: string, register: boolean, pages: string[] = []): Promise<void> {
    const source = (await this.runtimeSources(scope)).find(item => item.ready && item.enabled && item.deploymentId === deploymentId);
    if (!source) throw new BoardStoreError("forbidden", "公开评论需要先把这个后端连接到本 Board 的评论收件箱（更多 → 评论收件箱 → 后端来源），这样你才能隐藏不当评论或标为已解决。");
    let result: Awaited<ReturnType<InboxConnections["ownerCall"]>>;
    const request = pages.length ? { pages: pages.slice(0, 8) } : register ? {} : undefined;
    try { result = await this.ownerCall(source, register ? "PUT" : "DELETE", `/public-releases/${releaseId}`, request); }
    catch (error) { throw new Error(`没能在评论后端${register ? "登记" : "取消"}公开评论：连接不上后端（${describe(error)}）。`); }
    const body = result.body as Record<string, unknown>;
    if (result.status === 200 && body.deploymentId === deploymentId && body.releaseId === releaseId && body.registered === register) return;
    const reason = result.status === 404 && !result.code ? "后端版本过旧，不支持公开评论：在应用目录运行 paseo-board-app update-runtime，然后重新部署。"
      : result.status === 401 || result.status === 403 ? "后端拒绝了收件箱令牌，请在「后端来源」里更新。" : `HTTP ${result.status}${result.code ? `：${result.code}` : ""}`;
    throw new Error(`没能在评论后端${register ? "登记" : "取消"}公开评论：${reason}`);
  }
  /**
   * What visitors see right now on the pages of these public comments, read fresh from each page's owner moderation
   * listing (`?page=`). The export never re-delivers a row, so a withdrawal (or a hide made elsewhere) after import never
   * reaches the sidecar by sync; the sealed runner therefore checks the backend before a run, before each read of a
   * public comment and before each public reply (merge review fix). Returns the record keys (`sourceId\0externalId`) of
   * the rows the page shows; rows the listing leaves out (older threads, trimmed messages), comments without a page
   * address and comments of a disabled or replaced source are not in it. Withdrawals it sees are recorded in the
   * sidecar. Throws PUBLIC_CHECK_FAILED when a page cannot be read; callers fail closed.
   */
  async publicOnPage(scope: InboxScope, targets: ReadonlyArray<{ sourceId: string; deploymentId: string; pageUrl?: string }>): Promise<Set<string>> {
    const sources = await this.runtimeSources(scope), visible = new Set<string>(), pages = new Map<string, { source: RuntimeSource; pageUrl: string }>();
    for (const target of targets) {
      const source = sources.find(item => item.sourceId === target.sourceId && item.deploymentId === target.deploymentId && item.ready && item.enabled);
      if (source && target.pageUrl) pages.set(`${source.sourceId}\0${target.pageUrl}`, { source, pageUrl: target.pageUrl });
    }
    for (const { source, pageUrl } of pages.values()) {
      let result: Awaited<ReturnType<InboxConnections["ownerCall"]>>;
      try { result = await this.ownerCall(source, "GET", `/public/moderation?page=${encodeURIComponent(pageUrl)}`); }
      catch { throw new BoardStoreError("unavailable", PUBLIC_CHECK_FAILED); }
      const listing = result.status === 200 ? ModerationSchema.safeParse(result.body) : undefined;
      if (!listing?.success || listing.data.deploymentId !== source.deploymentId) throw new BoardStoreError("unavailable", PUBLIC_CHECK_FAILED);
      const page = pageVisibility(listing.data);
      for (const externalId of page.visible) visible.add(recordKey(source.sourceId, externalId));
      if (page.withdrawn.length) await this.inbox.notePublicWithdrawn(scope, source.sourceId, page.withdrawn, { kind: "ingress", sourceId: source.sourceId, deploymentId: source.deploymentId, credential: source.credential });
    }
    return visible;
  }
  /** The owner moderation listing of every ready, enabled source (public threads including hidden ones). */
  async moderation(scope: InboxScope): Promise<Array<{ source: RuntimeSource; listing?: ModerationListing; error?: string; unsupported?: boolean }>> {
    const sources = (await this.runtimeSources(scope)).filter(source => source.ready && source.enabled);
    return Promise.all(sources.map(async source => {
      try {
        const result = await this.ownerCall(source, "GET", "/public/moderation");
        if (result.status === 404 && (result.code === "not_found" || !result.code)) return { source, unsupported: true };
        if (result.status !== 200) return { source, error: result.status === 401 || result.status === 403 ? "后端拒绝了收件箱令牌，请在「后端来源」里更新。" : `后端返回 HTTP ${result.status}${result.code ? `：${result.code}` : ""}` };
        const listing = ModerationSchema.safeParse(result.body);
        if (!listing.success || listing.data.deploymentId !== source.deploymentId) return { source, error: "后端返回的公开评论数据无法识别。" };
        return { source, listing: listing.data };
      } catch (error) { return { source, error: error instanceof SyncFailure ? (error.kind === "too-large" ? MODERATION_TOO_LARGE : error.message) : `连接不上后端：${describe(error)}` }; }
    }));
  }
}
