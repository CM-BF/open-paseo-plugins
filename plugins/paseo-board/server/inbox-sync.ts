import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { INBOX_LIMITS, InboxExternalCommentSchema, type InboxScope, type InboxActor } from "../shared/inbox";
import { InboxConnectInputSchema, InboxConnectionSchema, InboxSyncInputSchema, InboxReconcileInputSchema, type InboxConnectInput, type InboxSyncInput } from "../shared/inbox-connection";
import { IdSchema } from "../shared/contracts";
import { BoardStoreError, ensureDirectory, fingerprint, serialized } from "./store-format";
import type { InboxStore } from "./inbox-store";

const human: InboxActor = { kind: "user", id: "paseo-client" };
const StoredConnectionSchema = InboxConnectionSchema.extend({ token: z.string(), credential: z.string(), digest: z.string(), input: InboxConnectInputSchema.omit({ token: true }) });
const PrivateConnectionSchema = StoredConnectionSchema.extend({ previous: StoredConnectionSchema.optional() });
type PrivateConnection = z.infer<typeof PrivateConnectionSchema>;
const PageSchema = z.object({ deploymentId: IdSchema, cursor: z.string().min(1).max(500), nextCursor: z.string().min(1).max(500), comments: z.array(InboxExternalCommentSchema).max(INBOX_LIMITS.importPage) }).strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// Accommodates all 32 sources at their UTF-8 field limits, including a pending
// replacement and its previous settings. Read and write must use the same cap.
const CONNECTION_FILE_BYTES = 2 * 1024 * 1024;
const ConnectionFileSchema = z.array(PrivateConnectionSchema).max(INBOX_LIMITS.sources);

/** Human-configured pull boundary. Secrets never enter Board data, agent results or exported HTML. */
export class InboxConnections {
  private readonly directory: string;
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
  async list(scope: InboxScope) {
    await this.inbox.list({ ...scope, limit: 1 }, human); // validates current Board identity
    return (await this.load(this.path(scope))).map(record => this.public(record));
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
  async sync(raw: InboxSyncInput) {
    const input = InboxSyncInputSchema.parse(raw), scope = { boardId: input.boardId, expectedCreatedAt: input.expectedCreatedAt }, path = this.path(input);
    return serialized(path, async () => {
      const record = (await this.load(path)).find(item => item.sourceId === input.sourceId);
      if (!record || record.state !== "ready" || !record.enabled) throw new Error("An enabled, completed source configuration is required");
      const state = await this.inbox.list({ ...scope, limit: 1 }, human);
      if (state.revision !== input.expectedRevision) throw new BoardStoreError("revision_conflict", "Inbox changed; refresh before syncing");
      const source = state.sources.find(item => item.sourceId === record.sourceId && item.deploymentId === record.deploymentId && item.enabled);
      if (!source) throw new Error("Source permission was removed or replaced");
      const url = new URL(record.endpoint); url.searchParams.set("cursor", source.cursor); url.searchParams.set("limit", String(INBOX_LIMITS.importPage));
      const response = await this.fetcher(url.toString(), { headers: { Authorization: `Bearer ${record.token}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) as RequestInit["signal"] });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Comment export returned HTTP ${response.status}; cursor unchanged`); }
      if (Number(response.headers.get("content-length")) > 500_000) { await response.body?.cancel(); throw new Error("Comment export page exceeds the size limit"); }
      if (!response.body) throw new Error("Comment export returned an empty body");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 500_000) throw new Error("Comment export page exceeds the size limit"); chunks.push(chunk.value); }
      } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
      const page = PageSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (page.deploymentId !== record.deploymentId || page.cursor !== source.cursor) throw new Error("Comment export identity or cursor does not match the selected source");
      if (!page.comments.length && page.nextCursor === source.cursor) return { revision: state.revision, committedRevision: state.revision, replayed: false, imported: 0, duplicates: 0, cursor: source.cursor, unchanged: true };
      return this.inbox.importPage({ ...input, deploymentId: record.deploymentId, cursor: source.cursor, nextCursor: page.nextCursor, comments: page.comments }, { kind: "ingress", sourceId: record.sourceId, deploymentId: record.deploymentId, credential: record.credential });
    });
  }
}
