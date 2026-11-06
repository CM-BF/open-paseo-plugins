import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DOMParser } from "linkedom";
import { z } from "zod";
import type { Board } from "../shared/contracts";
import {
  BoardRefSchema, boardRefKey, CompositionSnapshotSchema, CompositionSourcesStateSchema,
  COMPOSITION_SNAPSHOT_MAX_BYTES, ReadSourceInputSchema, SetCompositionSourcesInputSchema,
  SyncCompositionSourceInputSchema, type BoardRef, type CompositionSnapshot, type CompositionSourcesState, type SourceReadResult,
} from "../shared/composition";
import { describeAuthoring } from "./authored-source";
import { assertId, assertJson, BoardStoreError, canonicalJson, ensureDirectory, parseInput, serialized } from "./store-format";

const StoredSchema = z.object({
  schemaVersion: z.literal(1), boardId: z.string(), boardCreatedAt: z.string(),
  revision: z.number().int().nonnegative(),
  sources: z.array(z.object({ ref: BoardRefSchema, grantedAt: z.string().datetime(), sourceCreatedAt: z.string().optional(),
    cached: z.object({ snapshot: CompositionSnapshotSchema, receivedAt: z.string().datetime() }).optional(),
  }).strict()).max(32),
}).strict();
type Stored = z.infer<typeof StoredSchema>;
type BoardReader = { read(id: string): Promise<Board | null> };
function boundedText(value: string, characterLimit: number, byteLimit: number): string {
  let characters = 0, bytes = 0, text = "";
  for (const point of value) {
    const size = Buffer.byteLength(JSON.stringify(point)) - 2;
    if (characters + point.length > characterLimit || bytes + size > byteLimit) break;
    text += point; characters += point.length; bytes += size;
  }
  return text;
}
const coverage = (included: number, total: number) => ({ included, total, truncated: included < total });
const receipt = (cached: NonNullable<Stored["sources"][number]["cached"]>) => ({
  sourceCreatedAt: cached.snapshot.createdAt,
  revision: cached.snapshot.revision, canvasRevision: cached.snapshot.canvasRevision,
  documentVersion: cached.snapshot.documentVersion, observedAt: cached.snapshot.observedAt, receivedAt: cached.receivedAt,
});
function validateSnapshot(raw: unknown): CompositionSnapshot {
  assertJson(raw, "Composition source snapshot");
  const snapshot = parseInput(CompositionSnapshotSchema, raw);
  if (Buffer.byteLength(JSON.stringify(snapshot)) > COMPOSITION_SNAPSHOT_MAX_BYTES) throw new BoardStoreError("size_limit", "Composition snapshot exceeds its bounded inspection budget");
  for (const [name, count] of Object.entries(snapshot.coverage)) {
    if (!count || typeof count !== "object") continue;
    if (count.included > count.total || count.truncated !== (count.included < count.total)) throw new BoardStoreError("invalid_input", `Invalid ${name} coverage`);
  }
  if (snapshot.coverage.text.included !== snapshot.text.length || snapshot.coverage.data.included !== snapshot.data.length || snapshot.coverage.updates.included !== snapshot.updates.length || snapshot.coverage.interactions.included !== snapshot.interactions.length) throw new BoardStoreError("invalid_input", "Snapshot coverage does not match its contents");
  if (new Set(snapshot.data.map(item => item.key)).size !== snapshot.data.length || new Set(snapshot.updates.map(item => item.id)).size !== snapshot.updates.length || new Set(snapshot.interactions.map(item => item.id)).size !== snapshot.interactions.length) throw new BoardStoreError("invalid_input", "Duplicate source inspection entries");
  for (const entry of snapshot.data) { try { assertJson(JSON.parse(entry.json), "Source data"); } catch { throw new BoardStoreError("invalid_input", "Source data must be complete finite JSON"); } }
  if (snapshot.updates.some(update => update.boardRevision > snapshot.revision || update.canvasRevision > snapshot.canvasRevision || update.documentVersion > snapshot.documentVersion)) throw new BoardStoreError("invalid_input", "Source update belongs to a future revision");
  return snapshot;
}

/** Persisted source projection. Authored scripts and network resources are never executed. */
export function compositionSnapshot(board: Board, hostId: string, observedAt = new Date().toISOString()): CompositionSnapshot {
  const authored = describeAuthoring(board.canvas);
  let text = "";
  if (authored.materializedAuthoredHtml !== null) {
    const document = new DOMParser().parseFromString(`<html><body>${authored.materializedAuthoredHtml}</body></html>`, "text/html");
    for (const node of document.querySelectorAll("script,style,template,noscript,head")) node.remove();
    text = ((document.body as unknown as { textContent: string | null }).textContent ?? "").replace(/\s+/g, " ").trim();
  }
  let dataBudget = 24000;
  const entries = Object.entries(board.canvas.data);
  const data: CompositionSnapshot["data"] = [];
  for (const [key, value] of entries) {
    const json = JSON.stringify(value), size = Buffer.byteLength(JSON.stringify({ key, json }));
    if (data.length === 32 || key.length > 500 || json.length > 16000 || size > dataBudget) continue;
    data.push({ key, json }); dataBudget -= size;
  }
  let selectorBudget = 12000;
  const updates = board.updates.slice(-12).map(update => ({
    id: update.id, at: update.at, kind: update.kind, boardRevision: update.boardRevision,
    canvasRevision: update.canvasRevision, documentVersion: update.documentVersion,
    selectors: update.targets.map(target => target.selector).filter(selector => { const size = Buffer.byteLength(JSON.stringify(selector)); if (size > selectorBudget) return false; selectorBudget -= size; return true; }),
  }));
  const interactions = [...board.interactions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).slice(0, 8).map(item => ({ id: item.id, status: item.status, question: boundedText(item.text, 1200, 1800), ...(item.response ? { response: boundedText(item.response, 2400, 3600) } : {}), updatedAt: item.updatedAt }));
  const textExcerpt = boundedText(text, 24000, 48000);
  return validateSnapshot({
    sourceRef: { hostId, boardId: board.id }, revision: board.revision, canvasRevision: board.canvas.revision,
    documentVersion: board.canvas.documentVersion, observedAt, title: board.title.slice(0, 1000), createdAt: board.createdAt, updatedAt: board.updatedAt,
    coverage: { source: "persistent-store", liveBrowserObserved: false, historyComplete: false,
      text: { ...coverage(textExcerpt.length, text.length), replayComplete: authored.replay.complete },
      data: coverage(data.length, entries.length), updates: coverage(updates.length, board.updates.length), interactions: coverage(interactions.length, board.interactions.length),
      note: "Bounded current persisted inspection, not a complete daily history or live DOM/screenshot. Text is static authored text after replay; scripts are not run. Questions/responses and target lists may be excerpts. Updates cover at most the last 12 of the retained 80; omitted data requires a narrower source read on its own Board.",
    },
    text: textExcerpt, data, updates, interactions,
    unreadUpdateCount: board.updates.filter(update => !board.seenUpdateIds.includes(update.id)).length,
    pendingCount: board.interactions.filter(item => ["saved", "sending", "delivered", "processing"].includes(item.status)).length,
  });
}

/** User grants live outside authored content. Agent publication/state cannot grant source access. */
export class CompositionSources {
  constructor(private root: string, private store: BoardReader, private hostId: () => Promise<string | undefined>, private now: () => number = Date.now) {}
  private async board(id: string) { const board = await this.store.read(assertId(id)); if (!board) throw new BoardStoreError("not_found", "Composition Board does not exist"); return board; }
  private path(boardId: string) { return join(this.root, `${assertId(boardId)}.json`); }
  private async load(board: Board): Promise<Stored> {
    await ensureDirectory(this.root);
    const empty: Stored = { schemaVersion: 1, boardId: board.id, boardCreatedAt: board.createdAt, revision: 0, sources: [] };
    try {
      const path = this.path(board.id), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 6_000_000) throw new BoardStoreError("unsafe_path", "Invalid composition storage file");
      const saved = StoredSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (saved.boardId !== board.id) throw new BoardStoreError("corrupt_storage", "Composition identity does not match filename");
      // Recreating a deleted Board never inherits its old grants.
      if (saved.boardCreatedAt !== board.createdAt) return empty;
      if (new Set(saved.sources.map(source => boardRefKey(source.ref))).size !== saved.sources.length) throw new BoardStoreError("corrupt_storage", "Duplicate composition sources");
      for (const source of saved.sources) if (source.cached) {
        validateSnapshot(source.cached.snapshot);
        if (source.sourceCreatedAt !== undefined && source.sourceCreatedAt !== source.cached.snapshot.createdAt) throw new BoardStoreError("corrupt_storage", "Cached source creation identity does not match its grant");
        if (boardRefKey(source.cached.snapshot.sourceRef) !== boardRefKey(source.ref)) throw new BoardStoreError("corrupt_storage", "Cached source identity does not match its grant");
      }
      return saved;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty; throw error; }
  }
  private state(stored: Stored): CompositionSourcesState { return CompositionSourcesStateSchema.parse({ boardId: stored.boardId, boardCreatedAt: stored.boardCreatedAt, revision: stored.revision, sources: stored.sources.map(source => ({ ref: source.ref, grantedAt: source.grantedAt, ...(source.sourceCreatedAt ? { sourceCreatedAt: source.sourceCreatedAt } : {}), ...(source.cached ? { snapshot: receipt(source.cached) } : {}) })) }); }
  private async save(stored: Stored): Promise<void> {
    const path = this.path(stored.boardId), temporary = `${path}.${randomUUID()}.tmp`;
    const data = JSON.stringify(StoredSchema.parse(stored));
    if (Buffer.byteLength(data) > 6_000_000) throw new BoardStoreError("size_limit", "Composition source storage exceeds its budget");
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(this.root, "r"); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  async list(boardId: string): Promise<CompositionSourcesState> { return serialized(this.path(boardId), async () => this.state(await this.load(await this.board(boardId)))); }
  async set(raw: z.input<typeof SetCompositionSourcesInputSchema>): Promise<CompositionSourcesState> {
    const input = parseInput(SetCompositionSourcesInputSchema, raw);
    return serialized(this.path(input.boardId), async () => {
      const saved = await this.load(await this.board(input.boardId));
      if (saved.revision !== input.expectedRevision) throw new BoardStoreError("revision_conflict", "Source access changed; reread and review the selection");
      if (new Set(input.sources.map(boardRefKey)).size !== input.sources.length) throw new BoardStoreError("invalid_input", "A source can only be granted once");
      const local = await this.hostId();
      if (input.sources.some(ref => ref.hostId === local && ref.boardId === input.boardId)) throw new BoardStoreError("invalid_input", "A Board cannot be its own source");
      if (canonicalJson(saved.sources.map(source => ({ ...source.ref, sourceCreatedAt: source.sourceCreatedAt }))) === canonicalJson(input.sources)) return this.state(saved);
      const selected: Stored["sources"] = [];
      for (const selection of input.sources) {
        const { sourceCreatedAt, ...ref } = selection;
        const existing = saved.sources.find(source => boardRefKey(source.ref) === boardRefKey(ref));
        if (existing?.sourceCreatedAt) {
          if (existing.sourceCreatedAt !== sourceCreatedAt) throw new BoardStoreError("source_identity_changed", "This source Board was recreated; remove and select it again");
          selected.push(existing); continue;
        }
        const localBoard = ref.hostId === local ? await this.store.read(ref.boardId) : null;
        if (ref.hostId === local && !localBoard) throw new BoardStoreError("source_missing", "The selected source no longer exists");
        if (localBoard && localBoard.createdAt !== sourceCreatedAt) throw new BoardStoreError("source_identity_changed", "The selected source changed before access was saved; select it again");
        selected.push({ ref, grantedAt: new Date(this.now()).toISOString(), sourceCreatedAt });
      }
      saved.sources = selected;
      saved.revision++; await this.save(saved); return this.state(saved);
    });
  }
  async inspect(boardId: string): Promise<CompositionSnapshot> {
    const local = await this.hostId();
    if (!local) throw new BoardStoreError("host_identity_unavailable", "This host does not expose its public identity; open the source directly");
    return compositionSnapshot(await this.board(boardId), local, new Date(this.now()).toISOString());
  }
  async sync(raw: z.input<typeof SyncCompositionSourceInputSchema>) {
    const input = parseInput(SyncCompositionSourceInputSchema, raw), snapshot = validateSnapshot(input.snapshot);
    if (boardRefKey(input.ref) !== boardRefKey(snapshot.sourceRef)) throw new BoardStoreError("source_mismatch", "Snapshot does not match the approved source");
    return serialized(this.path(input.boardId), async () => {
      const saved = await this.load(await this.board(input.boardId));
      if (input.expectedSourcesRevision !== saved.revision) throw new BoardStoreError("revision_conflict", "Source access changed; discard the pending source read");
      const source = saved.sources.find(source => boardRefKey(source.ref) === boardRefKey(input.ref));
      if (!source) throw new BoardStoreError("source_not_authorized", "The user has not granted this source to this Board");
      if (!source.sourceCreatedAt) throw new BoardStoreError("source_identity_unbound", "Select this source again to confirm its creation identity before accepting its contents");
      if (source.sourceCreatedAt !== undefined && source.sourceCreatedAt !== snapshot.createdAt) throw new BoardStoreError("source_identity_changed", "This source Board was recreated; remove and select it again before accepting its contents");
      if (source.cached) {
        const old = source.cached.snapshot;
        if (snapshot.createdAt !== old.createdAt) throw new BoardStoreError("source_identity_changed", "This source Board was recreated; remove and select it again before accepting its contents");
        if (snapshot.revision < old.revision || snapshot.canvasRevision < old.canvasRevision || snapshot.documentVersion < old.documentVersion || Date.parse(snapshot.observedAt) < Date.parse(old.observedAt)) throw new BoardStoreError("stale_source", "An older source observation cannot replace the saved snapshot");
        if (snapshot.revision === old.revision && (snapshot.canvasRevision !== old.canvasRevision || snapshot.documentVersion !== old.documentVersion)) throw new BoardStoreError("source_version_mismatch", "Equal Board revisions must retain canvas identity");
        if (canonicalJson(snapshot) === canonicalJson(old)) return receipt(source.cached);
      }
      source.sourceCreatedAt = snapshot.createdAt;
      source.cached = { snapshot, receivedAt: new Date(this.now()).toISOString() };
      await this.save(saved); return receipt(source.cached);
    });
  }
  async read(raw: z.input<typeof ReadSourceInputSchema>): Promise<SourceReadResult> {
    const input = parseInput(ReadSourceInputSchema, raw);
    return serialized(this.path(input.boardId), async () => {
      const saved = await this.load(await this.board(input.boardId));
      const source = saved.sources.find(source => boardRefKey(source.ref) === boardRefKey(input.source));
      if (!source) throw new BoardStoreError("source_not_authorized", "The user has not granted this source to this Board");
      if (!source.sourceCreatedAt) throw new BoardStoreError("source_identity_unbound", "Select this source again to confirm its creation identity before reading its contents");
      const base = { boardId: input.boardId, sourceRef: input.source, sourcesRevision: saved.revision };
      if (await this.hostId() === input.source.hostId) {
        const board = await this.store.read(input.source.boardId);
        if (!board) return { ...base, availability: "source-missing", provenance: "local-store", stale: true, freshness: "unavailable" };
        if (source.sourceCreatedAt !== undefined && source.sourceCreatedAt !== board.createdAt) throw new BoardStoreError("source_identity_changed", "This source Board was recreated; remove and select it again");
        const snapshot = compositionSnapshot(board, input.source.hostId, new Date(this.now()).toISOString());
        return { ...base, availability: "available", provenance: "local-store", snapshot, receivedAt: snapshot.observedAt, ageMs: 0, stale: false, freshness: "read-now" };
      }
      if (!source.cached) return { ...base, availability: "not-yet-observed", provenance: "none", stale: true, freshness: "unavailable" };
      return { ...base, availability: "available", provenance: "client-observed-cache", ...source.cached,
        ageMs: Math.max(0, this.now() - Date.parse(source.cached.snapshot.observedAt)), stale: true, freshness: "cached-not-live" };
    });
  }
}
