import { z } from "zod";
import { AnchorSchema, IdSchema, type Anchor, type Interaction } from "../shared/contracts";
import type { CaptureFailureReason } from "../shared/frame-contract";
import { browserDraftStorage } from "./draft-storage-web";

export const DRAFT_STORAGE_PREFIX = "@paseo:board-drafts:v1:";
export interface DraftCompose {
  kind: Interaction["kind"];
  text: string;
  anchor?: Anchor;
  sourceInteractionId?: string;
  intentId?: string;
  destination?: "main" | "side" | "new-side";
  captureStatus?: "ready" | "failed" | "omitted";
  captureFailureReason?: CaptureFailureReason;
}
export interface DraftInput {
  id: string;
  /** Only explicitly staged comments participate; editing preserves their position. */
  queuedAt?: number;
  compose: DraftCompose;
  position: { x: number; y: number };
  open: boolean;
}
export interface StoredDraft extends DraftInput {
  revision: string;
  updatedAt: number;
  /** Concurrent windows retain both branches. Use revision, not id, as a list key. */
  conflicted?: boolean;
}
export type DraftStorageIssueCode = "unavailable" | "quota" | "corrupt" | "conflict" | "invalid" | "failed";
export interface DraftStorageIssue { code: DraftStorageIssueCode; message: string }
export interface DraftSnapshot { drafts: StoredDraft[]; issues: DraftStorageIssue[] }
export type DraftWriteResult = { ok: true; draft: StoredDraft } | { ok: false; issue: DraftStorageIssue };
export type DraftRemoveResult = { ok: true } | { ok: false; issue: DraftStorageIssue };
/** Browser adapter boundary; no DOM or native-only imports in this module. */
export interface DraftStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  subscribe?(listener: (key: string | null) => void): () => void;
}
export interface DraftStore {
  list(): DraftSnapshot;
  put(input: DraftInput, expectedRevision?: string | null): DraftWriteResult;
  remove(id: string, expectedRevision: string): DraftRemoveResult;
  subscribe(listener: () => void): () => void;
}

const ComposeSchema = z.object({
  kind: z.enum(["question", "change", "fork", "return", "reply"]),
  // Keep an overlong unsent draft recoverable even if sending needs it shortened.
  text: z.string().max(240000),
  sourceInteractionId: IdSchema.optional(), intentId: IdSchema.optional(),
  destination: z.enum(["main", "side", "new-side"]).optional(),
  captureStatus: z.enum(["ready", "failed", "omitted"]).optional(),
  captureFailureReason: z.enum(["content-changed", "too-complex", "unsupported-layout", "too-large", "timeout", "generation-failed"]).optional(),
}).refine(value => !value.intentId || Boolean(value.destination), "An uncertain send needs its immutable destination");
const InputSchema = z.object({
  id: IdSchema, compose: ComposeSchema, open: z.boolean(),
  queuedAt: z.number().finite().nonnegative().optional(),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }),
});
const RecordSchema = InputSchema.extend({
  version: z.literal(1), revision: IdSchema, parent: IdSchema.optional(),
  supersedes: z.array(IdSchema).max(2000).default([]), deleted: z.boolean().default(false),
  updatedAt: z.number().finite().nonnegative(), context: IdSchema.optional(),
});
type DraftRecord = z.infer<typeof RecordSchema>;
const ContextSchema = z.object({ version: z.literal(1), anchor: AnchorSchema });
const samePageListeners = new Set<{ scope: string; notify: () => void }>();
const issue = (code: DraftStorageIssueCode): DraftStorageIssue => ({ code, message: {
  unavailable: "当前客户端无法在本机持久保存草稿。",
  quota: "本机草稿空间已满，当前输入尚未保存到本机；请保留当前页面并重试。",
  corrupt: "有草稿记录无法读取，已保留原记录，没有自动覆盖或删除。",
  conflict: "这份草稿已在另一个窗口更新，当前输入尚未覆盖它。",
  invalid: "这份草稿无法保存，当前输入仍保留在页面中。",
  failed: "草稿尚未写入本机，请保留当前页面并重试。",
}[code] });
function storageIssue(error: unknown): DraftStorageIssue {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  return issue(name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" ? "quota" : name === "SecurityError" ? "unavailable" : "failed");
}
function token(): string {
  const source = globalThis as unknown as { crypto?: { getRandomValues(bytes: Uint8Array): Uint8Array } };
  const bytes = new Uint8Array(16);
  if (source.crypto?.getRandomValues) source.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
function freezeAnchor(anchor: Anchor): Anchor {
  if (anchor.rect) Object.freeze(anchor.rect);
  if (anchor.viewport) Object.freeze(anchor.viewport);
  if (anchor.image) Object.freeze(anchor.image);
  if (anchor.binding) {
    Object.freeze(anchor.binding.target); anchor.binding.ancestors.forEach(Object.freeze);
    Object.freeze(anchor.binding.ancestors); Object.freeze(anchor.binding.relative); Object.freeze(anchor.binding);
  }
  return Object.freeze(anchor);
}

/**
 * All reads and writes are synchronous. A successful put is already on disk from
 * the browser's perspective before it returns; no debounce or unmount flush exists.
 * Each revision gets a new key before its parent is removed. Interleaved windows
 * therefore retain both heads instead of losing one through last-writer-wins.
 */
export function createDraftStore(scope: { hostId: string; boardId: string }, storage: DraftStorage | null = browserDraftStorage()): DraftStore {
  const prefix = DRAFT_STORAGE_PREFIX + encodeURIComponent(JSON.stringify([scope.hostId, scope.boardId])) + ":";
  const recordPrefix = prefix + "draft:", contextPrefix = prefix + "anchor:";
  const contexts = new Map<string, Anchor>();
  const inputContexts = new WeakMap<Anchor, { id: string; draftId: string; anchor: Anchor }>();
  const records = new Map<string, { raw: string; value: DraftRecord }>();
  const keyFor = (revision: string) => recordPrefix + revision;
  const changed = () => { for (const listener of samePageListeners) if (listener.scope === prefix) { try { listener.notify(); } catch { /* observers cannot invalidate committed storage */ } } };
  const keys = (start: string): string[] => {
    const result: string[] = [];
    for (let i = 0; i < storage!.length; i++) { const key = storage!.key(i); if (key?.startsWith(start)) result.push(key); }
    return result;
  };
  function readRecord(key: string): DraftRecord | null {
    const raw = storage!.getItem(key);
    if (raw === null) return null;
    const cached = records.get(key);
    if (cached?.raw === raw) return cached.value;
    if (raw.length > 1500000) throw new Error("Invalid draft record");
    const value = RecordSchema.parse(JSON.parse(raw));
    if (key !== keyFor(value.revision)) throw new Error("Mismatched draft revision");
    records.set(key, { raw, value }); return value;
  }
  const hasContext = (id: string) => keys(contextPrefix).includes(contextPrefix + id);
  function readContext(id: string, present?: Set<string>): Anchor {
    const cached = contexts.get(id);
    if (cached) {
      if (present ? !present.has(contextPrefix + id) : !hasContext(id)) throw new Error("Missing draft reference");
      return cached;
    }
    const raw = storage!.getItem(contextPrefix + id);
    if (!raw || raw.length > 3300000) throw new Error("Missing draft reference");
    const anchor = freezeAnchor(ContextSchema.parse(JSON.parse(raw)).anchor);
    contexts.set(id, anchor); return anchor;
  }
  function materialize(record: DraftRecord, present?: Set<string>): StoredDraft {
    const anchor = record.context ? readContext(record.context, present) : undefined;
    if (anchor && record.context) inputContexts.set(anchor, { id: record.context, draftId: record.id, anchor });
    return { id: record.id, revision: record.revision, updatedAt: record.updatedAt, open: record.open,
      position: { ...record.position }, ...(record.queuedAt !== undefined ? { queuedAt: record.queuedAt } : {}), compose: { ...record.compose, ...(anchor ? { anchor } : {}) } };
  }
  function readHeads(): { heads: DraftRecord[]; issues: DraftStorageIssue[] } {
    const entries: DraftRecord[] = [], issues: DraftStorageIssue[] = [];
    const present = new Set(keys(recordPrefix));
    for (const key of records.keys()) if (!present.has(key)) records.delete(key);
    for (const key of present) {
      try { const record = readRecord(key); if (record) entries.push(record); }
      catch { issues.push(issue("corrupt")); }
    }
    const superseded = new Set(entries.flatMap(entry => [entry.parent, ...entry.supersedes]).filter(Boolean));
    return { heads: entries.filter(entry => !entry.deleted && !superseded.has(entry.revision)), issues };
  }
  function releaseUnused(id: string | undefined): void {
    if (!id) return;
    const heads = readHeads();
    if (heads.issues.length || heads.heads.some(head => head.context === id)) return;
    const key = contextPrefix + id, raw = storage!.getItem(key);
    storage!.removeItem(key); contexts.delete(id);
    // Another window may have read the removed parent immediately before us.
    // The remover checks after deleting; a writer also checks after committing.
    // Whichever action happens last repairs a reference still owned by a head.
    if (raw && readHeads().heads.some(head => head.context === id)) storage!.setItem(key, raw);
  }
  function collectUnused(pendingContext?: string): void {
    if (readHeads().issues.length) return;
    for (const key of keys(contextPrefix)) {
      const id = key.slice(contextPrefix.length);
      if (id !== pendingContext) releaseUnused(id);
    }
  }
  return {
    list() {
      if (!storage) return { drafts: [], issues: [issue("unavailable")] };
      try {
        const { heads, issues } = readHeads(), drafts: StoredDraft[] = [], present = new Set(keys(contextPrefix));
        for (const id of contexts.keys()) if (!present.has(contextPrefix + id)) contexts.delete(id);
        const counts = new Map<string, number>();
        for (const head of heads) counts.set(head.id, (counts.get(head.id) ?? 0) + 1);
        for (const head of heads) {
          try { drafts.push({ ...materialize(head, present), ...(counts.get(head.id)! > 1 ? { conflicted: true } : {}) }); }
          catch { issues.push(issue("corrupt")); }
        }
        drafts.sort((a, b) => b.updatedAt - a.updatedAt || b.revision.localeCompare(a.revision));
        return { drafts, issues };
      } catch (error) { return { drafts: [], issues: [storageIssue(error)] }; }
    },
    put(input, expectedRevision = null) {
      if (!storage) return { ok: false, issue: issue("unavailable") };
      let draft: z.infer<typeof InputSchema>;
      try {
        const captureStatus = (input.compose.captureStatus as string) === "pending" ? "omitted" : input.compose.captureStatus;
        draft = InputSchema.parse({ ...input, compose: { ...input.compose, captureStatus } });
        if (draft.queuedAt !== undefined && (draft.compose.intentId || draft.compose.sourceInteractionId)) return { ok: false, issue: issue("invalid") };
      } catch { return { ok: false, issue: issue("invalid") }; }
      let createdContext: string | undefined;
      let committed = false;
      try {
        const parent = expectedRevision ? readRecord(keyFor(expectedRevision)) : null;
        if (expectedRevision ? !parent || parent.id !== draft.id || readHeads().heads.every(head => head.revision !== expectedRevision)
          : readHeads().heads.some(head => head.id === draft.id)) return { ok: false, issue: issue("conflict") };
        const revision = token();
        let context: string | undefined, contextAnchor: Anchor | undefined;
        if (input.compose.anchor) {
          const cached = inputContexts.get(input.compose.anchor);
          if (cached?.draftId === draft.id && hasContext(cached.id)) { context = cached.id; contextAnchor = cached.anchor; }
          else {
            const anchor = freezeAnchor(AnchorSchema.parse(input.compose.anchor));
            contextAnchor = anchor;
            context = token(); createdContext = context;
            const raw = JSON.stringify({ version: 1, anchor });
            if (raw.length > 3300000) return { ok: false, issue: issue("invalid") };
            try { storage.setItem(contextPrefix + context, raw); }
            catch (error) { collectUnused(context); storage.setItem(contextPrefix + context, raw); }
            contexts.set(context, anchor); inputContexts.set(input.compose.anchor, { id: context, draftId: draft.id, anchor });
          }
        }
        const supersedes = parent ? [parent.revision, ...parent.supersedes.filter(id => storage!.getItem(keyFor(id)) !== null)] : [];
        if (supersedes.length > 2000) return { ok: false, issue: issue("failed") };
        const record: DraftRecord = { ...draft, version: 1, revision, supersedes, deleted: false, updatedAt: Date.now(), ...(context ? { context } : {}), ...(parent ? { parent: parent.revision } : {}) };
        const raw = JSON.stringify(record);
        if (raw.length > 1500000) throw new Error("Draft record exceeds its read bound");
        try { storage.setItem(keyFor(revision), raw); }
        catch (error) { collectUnused(context); storage.setItem(keyFor(revision), raw); }
        committed = true; records.set(keyFor(revision), { raw, value: record });
        if (context && contextAnchor && !hasContext(context)) {
          try {
            storage.setItem(contextPrefix + context, JSON.stringify({ version: 1, anchor: contextAnchor }));
            contexts.set(context, contextAnchor);
          } catch (error) {
            // No parent cleanup has started: keep the prior complete draft if the
            // concurrent reference repair cannot fit, and do not claim success.
            storage.removeItem(keyFor(revision)); records.delete(keyFor(revision)); committed = false; throw error;
          }
        }
        // Cleanup is best-effort only. The newly written child hides a leftover
        // parent, so a cleanup failure cannot turn an acknowledged write into loss.
        try {
          for (const id of supersedes) { storage.removeItem(keyFor(id)); records.delete(keyFor(id)); }
          if (parent) releaseUnused(parent.context === context ? undefined : parent.context);
        } catch { /* no loss; list() hides superseded revisions */ }
        if (context && contextAnchor) inputContexts.set(contextAnchor, { id: context, draftId: draft.id, anchor: contextAnchor });
        const result: StoredDraft = { ...draft, revision, updatedAt: record.updatedAt, compose: { ...draft.compose, ...(contextAnchor ? { anchor: contextAnchor } : {}) } };
        changed(); return { ok: true, draft: result };
      } catch (error) {
        if (createdContext && !committed) {
          try { storage.removeItem(contextPrefix + createdContext); contexts.delete(createdContext); } catch { /* unreferenced only */ }
        }
        return { ok: false, issue: error instanceof z.ZodError ? issue("invalid") : storageIssue(error) };
      }
    },
    remove(id, expectedRevision) {
      if (!storage) return { ok: false, issue: issue("unavailable") };
      try {
        const record = readRecord(keyFor(expectedRevision));
        if (!record || record.id !== id || readHeads().heads.every(head => head.revision !== expectedRevision)) return { ok: false, issue: issue("conflict") };
        const revision = token(), supersedes = [record.revision, ...record.supersedes.filter(id => storage!.getItem(keyFor(id)) !== null)];
        const tombstone: DraftRecord = { version: 1, id, revision, supersedes, deleted: true, updatedAt: Date.now(), compose: { kind: "question", text: "" }, open: false, position: { x: 0, y: 0 } };
        const raw = JSON.stringify(tombstone);
        try { storage.setItem(keyFor(revision), raw); }
        catch (error) {
          if (storageIssue(error).code !== "quota") throw error;
          // Discard must still work when no bytes remain for a tombstone. Remove
          // old ancestors first, retaining the live head until every old payload
          // is gone. A failed deletion leaves that head recoverable; a concurrent
          // child is never in this captured lineage and remains independently live.
          for (const old of [...supersedes].reverse()) { storage.removeItem(keyFor(old)); records.delete(keyFor(old)); }
          try { releaseUnused(record.context); } catch { /* the head is removed; reference cleanup can be retried */ }
          changed(); return { ok: true };
        }
        records.set(keyFor(revision), { raw, value: tombstone });
        try {
          for (const old of supersedes) { storage.removeItem(keyFor(old)); records.delete(keyFor(old)); }
          storage.removeItem(keyFor(revision)); records.delete(keyFor(revision));
          releaseUnused(record.context);
        } catch { /* tombstone suppresses any parent left by failed cleanup */ }
        changed(); return { ok: true };
      } catch (error) { return { ok: false, issue: storageIssue(error) }; }
    },
    subscribe(listener) {
      const entry = { scope: prefix, notify: listener }; samePageListeners.add(entry);
      const unsubscribe = storage?.subscribe?.(key => {
        if (key === null) contexts.clear();
        else if (key.startsWith(contextPrefix)) contexts.delete(key.slice(contextPrefix.length));
        if (key === null || key.startsWith(prefix)) listener();
      });
      return () => { samePageListeners.delete(entry); unsubscribe?.(); };
    },
  };
}
