import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  INBOX_CONTENT_NOTICE, INBOX_LIMITS, InboxAuditSchema, InboxCommentSchema, InboxImportInputSchema,
  InboxListInputSchema, InboxPolicyInputSchema, InboxPolicySchema, InboxReadInputSchema,
  InboxSourceInputSchema, InboxSourceSchema, InboxTriageInputSchema, InboxScopeSchema,
  type InboxActor, type InboxAudit, type InboxComment, type InboxImportInput, type InboxListInput,
  type InboxMutationResult, type InboxPage, type InboxPolicyInput, type InboxReadInput, type InboxReadResult, type InboxScope,
  type InboxSourceInput, type InboxTriageInput,
} from "../shared/inbox";
import { BoardStoreError, canonicalJson, ensureDirectory, fingerprint, parseInput, serialized } from "./store-format";

const SourceRecordSchema = InboxSourceSchema.extend({ credentialHash: z.string().regex(/^[a-f0-9]{64}$/) });
const ReceiptSchema = z.object({
  eventId: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(),
  imported: z.number().int().nonnegative().optional(), duplicates: z.number().int().nonnegative().optional(), cursor: z.string().optional(),
}).strict();
const StateSchema = z.object({
  version: z.literal(1), scope: InboxScopeSchema, revision: z.number().int().nonnegative(), policy: InboxPolicySchema,
  sources: z.array(SourceRecordSchema).max(INBOX_LIMITS.sources), comments: z.array(InboxCommentSchema).max(INBOX_LIMITS.comments),
  audit: z.array(InboxAuditSchema).max(INBOX_LIMITS.events), receipts: z.array(ReceiptSchema).max(INBOX_LIMITS.events),
}).strict();
type State = z.infer<typeof StateSchema>;
type SourceRecord = z.infer<typeof SourceRecordSchema>;
type MutationInput = InboxScope & { expectedRevision: number; eventId: string };
type MutationDetails = { subject?: string; imported?: number; duplicates?: number; cursor?: string };
export interface InboxStoreOptions {
  /** A fresh authoritative lookup is required even for exact idempotent replays. */
  resolveBoard(boardId: string): Promise<{ createdAt: string; ownerAgentId?: string } | null>;
  /** Owner is accepted directly; this callback may admit server-verified forks only. Defaults to deny. */
  authorizeAgent?(boardId: string, agentId: string): Promise<boolean>;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const deny = (message: string): never => { throw new BoardStoreError("forbidden", message); };
const conflict = (message: string): never => { throw new BoardStoreError("revision_conflict", message); };

/** A separate bounded ledger: importing a comment never creates a Board interaction or dispatches an agent. */
export class InboxStore {
  private readonly directory: string;
  constructor(rootDir: string, private readonly options: InboxStoreOptions) { this.directory = join(resolve(rootDir), "inbox"); }

  async list(raw: InboxListInput, actor: InboxActor): Promise<InboxPage> {
    const input = parseInput(InboxListInputSchema, raw);
    return this.access(input, actor, "read", async state => {
      let offset = 0;
      if (input.cursor) {
        const match = /^(\d+):(\d+)$/.exec(input.cursor);
        if (!match || Number(match[1]) !== state.revision) conflict("Inbox changed; restart pagination to review the current snapshot");
        offset = Number(match![2]);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > state.comments.length) throw new BoardStoreError("invalid_input", "Invalid inbox cursor");
      }
      const comments = state.comments.slice(offset, offset + input.limit);
      return structuredClone({
        revision: state.revision, policy: state.policy,
        sources: state.sources.map(({ credentialHash: _secret, ...source }) => source),
        comments, total: state.comments.length,
        nextCursor: offset + comments.length < state.comments.length ? `${state.revision}:${offset + comments.length}` : null,
        contentNotice: INBOX_CONTENT_NOTICE,
        permissions: { read: true, triage: actor.kind === "user" || state.policy.triage, configure: actor.kind === "user", publish: false as const, changeApplication: false as const },
        recentAudit: state.audit.slice(-30),
      });
    });
  }

  async read(raw: InboxReadInput, actor: InboxActor): Promise<InboxReadResult> {
    const input = parseInput(InboxReadInputSchema, raw);
    return this.access(input, actor, "read", async state => {
      const comment = state.comments.find(item => item.id === input.commentId);
      if (!comment) throw new BoardStoreError("not_found", "Inbox comment does not exist");
      return structuredClone({ revision: state.revision, comment, contentNotice: INBOX_CONTENT_NOTICE });
    });
  }

  async setPolicy(raw: InboxPolicyInput, actor: InboxActor): Promise<InboxMutationResult> {
    const input = parseInput(InboxPolicyInputSchema, raw);
    return this.mutate(input, actor, "policy", input, state => { state.policy = input.policy; return {}; });
  }

  async setSource(raw: InboxSourceInput, actor: InboxActor): Promise<InboxMutationResult> {
    const input = parseInput(InboxSourceInputSchema, raw);
    const credentialHash = hash(input.credential);
    const { credential: _credential, ...safe } = input;
    return this.mutate(input, actor, "source", { ...safe, credentialHash }, (state, at) => {
      const existing = state.sources.find(item => item.sourceId === input.sourceId);
      if (existing && existing.deploymentId !== input.deploymentId) throw new BoardStoreError("identity_conflict", "A source is bound to its deployment. Disable it and register a new source ID for a new deployment.");
      if (!existing && state.sources.length >= INBOX_LIMITS.sources) throw new BoardStoreError("size_limit", "Inbox source limit reached; no data was changed");
      const source: SourceRecord = { sourceId: input.sourceId, deploymentId: input.deploymentId, label: input.label, enabled: input.enabled, credentialHash, cursor: existing?.cursor ?? "0", updatedAt: at };
      if (existing) Object.assign(existing, source); else state.sources.push(source);
      return { subject: input.sourceId };
    });
  }

  async importPage(raw: InboxImportInput, actor: InboxActor): Promise<InboxMutationResult> {
    const input = parseInput(InboxImportInputSchema, raw);
    return this.mutate(input, actor, "import", input, (state, at) => {
      const source = this.source(state, input.sourceId, input.deploymentId);
      if (source.cursor !== input.cursor) conflict("Import cursor changed; reconcile the recorded checkpoint before continuing");
      let imported = 0, duplicates = 0;
      for (const external of input.comments) {
        const existing = state.comments.find(item => item.sourceId === input.sourceId && item.externalId === external.externalId);
        if (existing) {
          const { id: _id, sourceId: _sourceId, deploymentId: _deploymentId, contentTrust: _trust, importedAt: _at, revision: _revision, status: _status, labels: _labels, note: _note, updatedAt: _updated, ...original } = existing;
          if (canonicalJson(original) !== canonicalJson(external)) throw new BoardStoreError("idempotency_conflict", "An external comment ID was reused with different content; existing evidence is unchanged");
          duplicates++; continue;
        }
        if (state.comments.length >= INBOX_LIMITS.comments) throw new BoardStoreError("size_limit", "Inbox comment limit reached; this page and its cursor were not committed");
        state.comments.push({ ...external, id: `comment-${hash(`${input.sourceId}\0${external.externalId}`).slice(0, 40)}`, sourceId: input.sourceId, deploymentId: input.deploymentId, contentTrust: "external-untrusted", importedAt: at, revision: 1, status: "new", labels: [], note: "", updatedAt: at });
        imported++;
      }
      if (source.cursor === input.nextCursor && imported > 0) throw new BoardStoreError("invalid_input", "A page containing new comments must advance its cursor");
      source.cursor = input.nextCursor; source.updatedAt = at;
      return { subject: source.sourceId, imported, duplicates, cursor: source.cursor };
    }, state => {
      if (actor.kind !== "ingress") return deny("Import requires its exact authenticated source and deployment");
      if (actor.sourceId !== input.sourceId || actor.deploymentId !== input.deploymentId) deny("Import requires its exact authenticated source and deployment");
      this.authenticateSource(state, actor);
    });
  }

  async triage(raw: InboxTriageInput, actor: InboxActor): Promise<InboxMutationResult> {
    const input = parseInput(InboxTriageInputSchema, raw);
    return this.mutate(input, actor, "triage", input, (state, at) => {
      const comment = state.comments.find(item => item.id === input.commentId);
      if (!comment) throw new BoardStoreError("not_found", "Inbox comment does not exist");
      if (comment.revision !== input.expectedCommentRevision) conflict("Comment triage changed; read its latest state before editing");
      Object.assign(comment, { status: input.status, labels: input.labels, note: input.note, revision: comment.revision + 1, updatedAt: at });
      return { subject: comment.id };
    });
  }

  private async access<T>(scope: InboxScope, actor: InboxActor, operation: "read" | InboxAudit["operation"], action: (state: State) => Promise<T>): Promise<T> {
    const identity = parseInput(InboxScopeSchema, { boardId: scope.boardId, expectedCreatedAt: scope.expectedCreatedAt });
    const path = this.path(identity);
    await ensureDirectory(this.directory);
    return serialized(path, async () => {
      const board = await this.options.resolveBoard(identity.boardId);
      if (!board || board.createdAt !== identity.expectedCreatedAt) throw new BoardStoreError("identity_conflict", "Board was removed or replaced; its previous inbox cannot be reused");
      const state = await this.load(path, identity);
      const latest = await this.options.resolveBoard(identity.boardId);
      if (!latest || latest.createdAt !== identity.expectedCreatedAt) throw new BoardStoreError("identity_conflict", "Board changed while the inbox was being read");
      if (actor.kind === "agent") {
        if (!actor.agentId || actor.agentId.length > 200 || (latest.ownerAgentId !== actor.agentId && !await this.options.authorizeAgent?.(identity.boardId, actor.agentId))) deny("This agent does not own this Board or an authorized fork");
        if (operation !== "read" && operation !== "triage") deny("Only the user can configure inbox access and sources");
        if (!state.policy.read || operation === "triage" && !state.policy.triage) deny("The user has not granted this inbox permission to agents");
      } else if (actor.kind === "user") {
        if (!actor.id || actor.id.length > 200) deny("User identity is required");
        if (operation === "import") deny("A user action cannot substitute for authenticated source delivery");
      } else if (actor.kind === "ingress") {
        if (operation !== "import") deny("Source credentials only permit importing comments");
      } else deny("Unknown inbox actor");
      return action(state);
    });
  }

  private async mutate(input: MutationInput, actor: InboxActor, operation: InboxAudit["operation"], payload: unknown, change: (state: State, at: string) => MutationDetails, beforeReplay?: (state: State) => void): Promise<InboxMutationResult> {
    return this.access(input, actor, operation, async state => {
      beforeReplay?.(state);
      const identity = actor.kind === "agent" ? actor.agentId : actor.kind === "user" ? actor.id : actor.sourceId;
      const digest = fingerprint(`inbox:${operation}`, { payload, actor: { kind: actor.kind, id: identity } });
      const receipt = state.receipts.find(item => item.eventId === input.eventId);
      if (receipt) {
        if (receipt.digest !== digest) throw new BoardStoreError("idempotency_conflict", "Inbox event ID was reused with a different request");
        const { eventId: _id, digest: _digest, revision, ...details } = receipt;
        return { ...details, revision: state.revision, committedRevision: revision, replayed: true };
      }
      if (state.revision !== input.expectedRevision) conflict("Inbox changed; refresh before submitting this change");
      // Reserve enough final audit entries to revoke every grant/source even when normal writes fill the ledger.
      const revokingPolicy = operation === "policy" && this.isPolicyRevocation(state, payload);
      const revokingSource = operation === "source" && this.isSourceRevocation(state, payload);
      const normalLimit = INBOX_LIMITS.events - INBOX_LIMITS.sources - 2;
      if (state.audit.length >= INBOX_LIMITS.events || state.audit.length >= normalLimit && !revokingPolicy && !revokingSource) throw new BoardStoreError("size_limit", "Inbox audit limit reached; existing evidence is retained and access can still be revoked");
      const at = new Date().toISOString();
      const { subject, ...details } = change(state, at);
      state.revision++;
      state.audit.push({ eventId: input.eventId, revision: state.revision, at, operation, actor: { kind: actor.kind, id: identity }, ...(subject ? { subject } : {}), ...(details.imported !== undefined ? { imported: details.imported, duplicates: details.duplicates } : {}) });
      state.receipts.push({ eventId: input.eventId, digest, revision: state.revision, ...details });
      // A fresh identity check closes awaited lookup/fork-authorization gaps before committing.
      const current = await this.options.resolveBoard(input.boardId);
      if (!current || current.createdAt !== input.expectedCreatedAt) throw new BoardStoreError("identity_conflict", "Board identity changed during the operation");
      if (actor.kind === "agent" && current.ownerAgentId !== actor.agentId && !await this.options.authorizeAgent?.(input.boardId, actor.agentId)) deny("Agent ownership changed during the operation");
      await this.write(this.path(state.scope), state, revokingPolicy || revokingSource);
      return { ...details, revision: state.revision, committedRevision: state.revision, replayed: false };
    });
  }

  private isPolicyRevocation(state: State, payload: unknown) {
    const input = payload as InboxPolicyInput;
    return (!input.policy.read || state.policy.read) && (!input.policy.triage || state.policy.triage) &&
      (state.policy.read && !input.policy.read || state.policy.triage && !input.policy.triage);
  }
  private isSourceRevocation(state: State, payload: unknown) {
    const input = payload as Omit<InboxSourceInput, "credential"> & { credentialHash: string };
    const source = state.sources.find(item => item.sourceId === input.sourceId);
    return Boolean(source?.enabled && !input.enabled && source.deploymentId === input.deploymentId && source.label === input.label && source.credentialHash === input.credentialHash);
  }

  private source(state: State, sourceId: string, deploymentId: string): SourceRecord {
    const source = state.sources.find(item => item.sourceId === sourceId);
    if (!source || source.deploymentId !== deploymentId || !source.enabled) deny("Comment source is not enabled for this deployment");
    return source!;
  }
  private authenticateSource(state: State, actor: Extract<InboxActor, { kind: "ingress" }>) {
    const source = this.source(state, actor.sourceId, actor.deploymentId);
    if (typeof actor.credential !== "string" || actor.credential.length < 32 || actor.credential.length > 512 || !timingSafeEqual(Buffer.from(hash(actor.credential), "hex"), Buffer.from(source.credentialHash, "hex"))) deny("Invalid comment source credential");
  }
  private path(scope: InboxScope) { return join(this.directory, `${hash(canonicalJson(scope))}.json`); }
  private async load(path: string, scope: InboxScope): Promise<State> {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new BoardStoreError("unsafe_path", "Inbox storage must be a regular file");
      if (stat.size > INBOX_LIMITS.storageBytes) throw new BoardStoreError("size_limit", "Inbox storage is too large; no data was changed");
      const state = StateSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (canonicalJson(state.scope) !== canonicalJson(scope) || state.revision !== state.receipts.length || state.revision !== state.audit.length || state.audit.some((item, index) => item.revision !== index + 1 || item.eventId !== state.receipts[index]?.eventId || state.receipts[index].revision !== index + 1) || new Set(state.receipts.map(item => item.eventId)).size !== state.receipts.length || new Set(state.sources.map(item => item.sourceId)).size !== state.sources.length || new Set(state.comments.map(item => item.id)).size !== state.comments.length || state.comments.some(item => item.id !== `comment-${hash(`${item.sourceId}\0${item.externalId}`).slice(0, 40)}` || !state.sources.some(source => source.sourceId === item.sourceId && source.deploymentId === item.deploymentId))) throw new Error("Inbox ledger identity or sequence mismatch");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, scope, revision: 0, policy: { read: false, triage: false }, sources: [], comments: [], audit: [], receipts: [] };
      if (error instanceof BoardStoreError) throw error;
      throw new BoardStoreError("corrupt_storage", "Inbox could not be read; existing data was not changed");
    }
  }
  private async write(path: string, state: State, revoking: boolean) {
    const data = JSON.stringify(StateSchema.parse(state));
    const limit = INBOX_LIMITS.storageBytes - (revoking ? 0 : 128_000);
    if (Buffer.byteLength(data, "utf8") > limit) throw new BoardStoreError("size_limit", "Inbox storage limit reached; this operation was not committed and access can still be revoked");
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
