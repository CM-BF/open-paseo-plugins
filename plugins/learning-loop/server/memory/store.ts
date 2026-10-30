// Bounded, curated memory in the shape of Hermes tools/memory_tool_store.py: entries separated by
// "\n§\n", a character budget per store checked on the FINAL state of a batch, unique-substring
// matching for patch/remove, exact duplicates refused, and a threat scan on everything written.
// One process owns the files (the plugin), so a serial queue is the only lock needed.

import { createHash } from "node:crypto";
import { join } from "node:path";
import { ENTRY_DELIMITER } from "../../shared/constants";
import type { Actor, MemoryOp, MemoryStoreView, MemoryTarget, PendingWrite, ProjectRef, MemoryEntryMeta } from "../../shared/contracts";
import { newId, readJson, readText, SerialQueue, writeAtomic, writeJson } from "../files";
import type { StatePaths } from "../paths";
import { firstThreatMessage } from "../threats";

export interface MemoryLimits {
  user: number;
  memory: number;
  project: number;
}

export interface MemoryResult {
  success: boolean;
  target: MemoryTarget;
  message?: string;
  error?: string;
  usage?: string;
  entry_count?: number;
  current_entries?: string[];
  closest_entries?: string[];
  staged?: boolean;
  pending_id?: string;
  /** Full text of entries a patch overwrote or a remove deleted. */
  replaced?: string[];
  note?: string;
}

/** What changed, for review summaries and the activity log. */
export interface MemoryChange {
  target: MemoryTarget;
  project: ProjectRef | null;
  action: "add" | "patch" | "remove";
  text: string;
  before?: string;
}

const LABELS: Record<MemoryTarget, string> = {
  user: "USER PROFILE (who the user is)",
  memory: "MEMORY (your notes about the environment)",
  project: "PROJECT MEMORY",
};

export function splitEntries(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function joinedLength(entries: readonly string[]): number {
  return entries.join(ENTRY_DELIMITER).length;
}

export function usageText(used: number, limit: number): string {
  const pct = limit > 0 ? Math.min(999, Math.round((used / limit) * 100)) : 0;
  return `${pct}% — ${used.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars`;
}

/** Typography folding for the fallback match: quotes, dashes, spaces, case. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function substringMatches(entries: readonly string[], oldText: string): number[] {
  const exact = entries.flatMap((entry, index) => (entry.includes(oldText) ? [index] : []));
  if (exact.length > 0) return exact;
  const needle = normalizeForMatch(oldText);
  if (!/[\p{L}\p{N}]/u.test(needle)) return [];
  return entries.flatMap((entry, index) => (normalizeForMatch(entry).includes(needle) ? [index] : []));
}

/** Index of the one entry old_text names; whole-entry exact matches win over substrings. */
export function findUniqueMatch(entries: readonly string[], oldText: string): { index: number | null; ambiguous: boolean } {
  const exact = entries.flatMap((entry, index) => (entry === oldText ? [index] : []));
  const matches = exact.length > 0 ? exact : substringMatches(entries, oldText);
  if (new Set(matches.map((index) => entries[index])).size > 1) return { index: null, ambiguous: true };
  return { index: matches.length > 0 ? matches[0]! : null, ambiguous: false };
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
}

export function closestEntries(entries: readonly string[], oldText: string): string[] {
  const wanted = words(oldText);
  if (wanted.size === 0) return [];
  return entries
    .map((entry, index) => {
      const have = words(entry);
      let shared = 0;
      for (const word of wanted) if (have.has(word)) shared += 1;
      return { entry, index, score: shared / wanted.size };
    })
    .filter((row) => row.score >= 0.3)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map((row) => row.entry);
}

function spanOccurrences(text: string, span: string): number {
  if (!span) return 0;
  let count = 0;
  for (let index = text.indexOf(span); index !== -1; index = text.indexOf(span, index + 1)) count += 1;
  return count;
}

interface OpOutcome {
  entries: string[];
  change: MemoryChange | null;
  message?: string;
  error?: string;
  closest?: string[];
  pinned?: string;
}

/** Applies one operation to a copy of the entries. Pure; the caller checks the budget. */
export function applyOp(entries: readonly string[], op: MemoryOp, target: MemoryTarget, project: ProjectRef | null): OpOutcome {
  const content = (op.content ?? "").trim();
  const oldText = (op.old_text ?? "").trim();
  if (op.action === "add") {
    if (!content) return { entries: [...entries], change: null, error: "'content' is required for add." };
    const threat = firstThreatMessage(content);
    if (threat) return { entries: [...entries], change: null, error: threat };
    if (content.includes("§")) return { entries: [...entries], change: null, error: "Entries cannot contain '§' (it separates entries); write one fact per entry." };
    if (entries.includes(content)) return { entries: [...entries], change: null, message: "Entry already exists (no duplicate added)." };
    return { entries: [...entries, content], change: { target, project, action: "add", text: content } };
  }
  if (!oldText) return { entries: [...entries], change: null, error: `'old_text' is required for ${op.action}.` };
  const { index, ambiguous } = findUniqueMatch(entries, oldText);
  if (ambiguous) {
    const matches = entries.filter((_, i) => substringMatches(entries, oldText).includes(i)).map((e) => (e.length > 80 ? `${e.slice(0, 80)}...` : e));
    return {
      entries: [...entries],
      change: null,
      error: `'${oldText}' matches several entries (${matches.join(" | ")}). Include more text so old_text names exactly one entry.`,
    };
  }
  if (index === null) {
    const hint = oldText.includes("§") ? " old_text must come from ONE entry ('§' separates entries); use one op per entry." : "";
    const closest = closestEntries(entries, oldText);
    return {
      entries: [...entries],
      change: null,
      error: `No entry matched '${oldText}'.${hint} Retry the ${op.action} with old_text copied verbatim from the intended entry${closest.length ? " (closest_entries below)." : "."}`,
      closest,
    };
  }
  const entry = entries[index]!;
  if (op.action === "remove") {
    const next = entries.filter((_, i) => i !== index);
    return { entries: next, change: { target, project, action: "remove", text: entry, before: entry }, pinned: entry };
  }
  if (!content) {
    return {
      entries: [...entries],
      change: null,
      error: "'content' is required for patch. To drop text inside an entry, patch a longer span that contains it; 'remove' deletes the whole entry.",
    };
  }
  let patched: string;
  if (entry === oldText) patched = content;
  else {
    let span = oldText;
    let count = spanOccurrences(entry, span);
    if (count === 0) {
      // Matched through typography folding: patch the whole entry only when the fold covers it.
      if (normalizeForMatch(entry) === normalizeForMatch(oldText)) {
        span = entry;
        count = 1;
      } else {
        return {
          entries: [...entries],
          change: null,
          error: `'${oldText}' only matched after normalizing quotes/dashes/spacing. Copy old_text verbatim from the entry: ${entry}`,
        };
      }
    }
    if (count > 1) {
      return {
        entries: [...entries],
        change: null,
        error: `'${oldText}' appears ${count} times in the matched entry, and patch edits one span. Include more surrounding text so old_text occurs once.`,
      };
    }
    patched = entry.replace(span, () => content).trim();
  }
  const threat = firstThreatMessage(patched);
  if (threat) return { entries: [...entries], change: null, error: threat };
  if (patched.includes("§")) return { entries: [...entries], change: null, error: "Entries cannot contain '§'." };
  const next = [...entries];
  next[index] = patched;
  return { entries: next, change: { target, project, action: "patch", text: patched, before: entry }, pinned: entry };
}

export interface BatchOutcome {
  ok: boolean;
  entries: string[];
  changes: MemoryChange[];
  pinned: string[];
  messages: string[];
  error?: string;
  closest?: string[];
}

/** All operations or none; the budget is checked only on the final state (Hermes semantics). */
export function applyBatch(
  entries: readonly string[],
  ops: readonly MemoryOp[],
  target: MemoryTarget,
  project: ProjectRef | null,
  limit: number,
): BatchOutcome {
  let working = [...entries];
  const changes: MemoryChange[] = [];
  const pinned: string[] = [];
  const messages: string[] = [];
  for (const [position, op] of ops.entries()) {
    const outcome = applyOp(working, op, target, project);
    if (outcome.error) {
      const prefix = ops.length > 1 ? `Operation ${position + 1} (${op.action}): ` : "";
      return { ok: false, entries: [...entries], changes: [], pinned: [], messages: [], error: prefix + outcome.error, ...(outcome.closest?.length ? { closest: outcome.closest } : {}) };
    }
    working = outcome.entries;
    if (outcome.change) changes.push(outcome.change);
    if (outcome.pinned) pinned.push(outcome.pinned);
    if (outcome.message) messages.push(outcome.message);
  }
  const total = joinedLength(working);
  if (total > limit) {
    const current = joinedLength(entries);
    const what =
      ops.length === 1 && ops[0]!.action === "add"
        ? `Memory at ${current.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars; adding this entry (${(ops[0]!.content ?? "").trim().length} chars) would exceed the limit by ${(total - limit).toLocaleString("en-US")} chars.`
        : `Applying ${ops.length === 1 ? "this operation" : `all ${ops.length} operations`} would put memory at ${total.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars.`;
    return {
      ok: false,
      entries: [...entries],
      changes: [],
      pinned: [],
      messages: [],
      error:
        `${what} Retry as ONE 'operations' batch that removes or shortens (patch) stale entries from current_entries ` +
        `below to free at least ${(total - limit).toLocaleString("en-US")} chars AND makes your change; the limit is checked only on the batch result.`,
    };
  }
  return { ok: true, entries: working, changes, pinned, messages };
}

interface ProjectsIndex {
  projects: Record<string, { root: string; name: string; scope?: "workspace" | "repo" }>;
}

function parseProjects(value: unknown): ProjectsIndex {
  const projects: ProjectsIndex["projects"] = {};
  const raw = (value as { projects?: unknown })?.projects;
  if (raw && typeof raw === "object") {
    for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
      const e = entry as { root?: unknown; name?: unknown; scope?: unknown };
      if (typeof e?.root === "string" && typeof e?.name === "string") projects[key] = { root: e.root, name: e.name, ...(e.scope === "repo" || e.scope === "workspace" ? { scope: e.scope } : {}) };
    }
  }
  return { projects };
}

function parsePending(value: unknown): PendingWrite[] {
  return Array.isArray((value as { pending?: unknown })?.pending) ? ((value as { pending: PendingWrite[] }).pending) : [];
}

export interface WriteOptions {
  actor: Actor;
  /** Stage instead of writing (write approval). */
  stage: boolean;
  expectedRevision?: string;
}

export class MemoryStore {
  private readonly queue = new SerialQueue();

  constructor(
    private readonly paths: StatePaths,
    private readonly limits: () => MemoryLimits,
  ) {}

  private filePath(target: MemoryTarget, project: ProjectRef | null): string {
    if (target === "user") return join(this.paths.memoryDir, "USER.md");
    if (target === "memory") return join(this.paths.memoryDir, "MEMORY.md");
    if (!project) throw new Error("project memory needs a project");
    return join(this.paths.projectsDir, `${project.key}.md`);
  }

  limitOf(target: MemoryTarget): number {
    return this.limits()[target];
  }

  entries(target: MemoryTarget, project: ProjectRef | null = null): Promise<string[]> {
    return this.queue.run(() => this.entriesUnlocked(target, project));
  }

  private async entriesUnlocked(target: MemoryTarget, project: ProjectRef | null = null): Promise<string[]> {
    if (target === "project" && !project) return [];
    return splitEntries(await readText(this.filePath(target, project)));
  }

  async projects(): Promise<ProjectRef[]> {
    const index = await readJson(this.paths.projectsIndex, { projects: {} }, parseProjects);
    return Object.entries(index.projects)
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async project(key: string): Promise<ProjectRef | null> {
    return (await this.projects()).find((project) => project.key === key) ?? null;
  }

  private async rememberProject(project: ProjectRef): Promise<void> {
    const index = await readJson(this.paths.projectsIndex, { projects: {} }, parseProjects);
    const known = index.projects[project.key];
    if (known && known.root === project.root && known.name === project.name && known.scope === project.scope) return;
    index.projects[project.key] = { root: project.root, name: project.name, scope: project.scope };
    await writeJson(this.paths.projectsIndex, index);
  }

  views(): Promise<MemoryStoreView[]> { return this.queue.run(() => this.viewsUnlocked()); }

  private async viewsUnlocked(): Promise<MemoryStoreView[]> {
    const views: MemoryStoreView[] = [];
    for (const target of ["user", "memory"] as const) {
      const entries = await this.entriesUnlocked(target);
      views.push({ target, project: null, label: LABELS[target], limit: this.limitOf(target), used: joinedLength(entries), entries, revision: await this.revisionFor(target, null, entries), metadata: await this.metadata(target, null, entries) });
    }
    for (const project of await this.projects()) {
      const entries = await this.entriesUnlocked("project", project);
      views.push({
        target: "project",
        project,
        label: `${project.scope === "workspace" ? "WORKSPACE MEMORY" : LABELS.project}: ${project.name}`,
        limit: this.limitOf("project"),
        used: joinedLength(entries),
        entries,
        revision: await this.revisionFor("project", project, entries),
        metadata: await this.metadata("project", project, entries),
      });
    }
    return views;
  }

  private async metadata(target: MemoryTarget, project: ProjectRef | null, entries: readonly string[]): Promise<MemoryEntryMeta[]> {
    const path = this.filePath(target, project) + ".meta.json";
    const raw = await readText(path);
    const data = raw ? JSON.parse(raw) as { version: number; entries: MemoryEntryMeta[] } : null;
    if (data && (data.version !== 1 || !Array.isArray(data.entries))) throw new Error("Unsupported memory metadata");
    return entries.map(text => {
      const contentHash = hash(text);
      const known = data?.entries.find(e => (e.contentHash ?? e.revision) === contentHash);
      const item: MemoryEntryMeta = known ? { ...known, contentHash } : { id: `legacy-${hash([target, project?.key ?? "host", text]).slice(0, 24)}`, contentHash, revision: "", source: "legacy", actor: null, createdAt: null, updatedAt: null, reviewDue: null, state: "active" };
      item.revision = entryRevision(item);
      return item;
    });
  }

  private async saveMetadata(target: MemoryTarget, project: ProjectRef | null, before: string[], after: string[], changes: MemoryChange[], actor: Actor): Promise<void> {
    const old = await this.metadata(target, project, before);
    const now = new Date().toISOString();
    const metadata = after.map(text => {
      const unchanged = old.find(e => e.contentHash === hash(text));
      if (unchanged) return unchanged;
      const change = changes.find(c => c.text === text && c.action !== "remove");
      const prior = change?.before ? old.find(e => e.contentHash === hash(change.before!)) : null;
      const item: MemoryEntryMeta = { id: prior?.id ?? newId("me_"), contentHash: hash(text), revision: "", source: "learned" as const, actor, createdAt: prior ? prior.createdAt : now, updatedAt: now, reviewDue: null, state: "active" as const };
      item.revision = entryRevision(item);
      return item;
    });
    await writeJson(this.filePath(target, project) + ".meta.json", { version: 1, entries: metadata });
  }

  setValidity(target: MemoryTarget, project: ProjectRef | null, id: string, revision: string, state: MemoryEntryMeta["state"], reviewDue: string | null): Promise<{ ok: boolean; message: string }> {
    return this.queue.run(async () => {
      if (target === "project" && !project) return { ok: false, message: "Unknown project." };
      if (reviewDue && Number.isNaN(Date.parse(reviewDue))) return { ok: false, message: "Invalid review date." };
      const entries = await this.entriesUnlocked(target, project);
      const metadata = await this.metadata(target, project, entries);
      const item = metadata.find(e => e.id === id);
      if (!item || item.revision !== revision) return { ok: false, message: "Conflict: memory entry changed. Refresh before changing its validity." };
      item.state = state;
      item.reviewDue = reviewDue;
      item.revision = entryRevision(item);
      await writeJson(this.filePath(target, project) + ".meta.json", { version: 1, entries: metadata });
      return { ok: true, message: "Validity saved. Existing conversation snapshots are unchanged." };
    });
  }

  private async revisionFor(target: MemoryTarget, project: ProjectRef | null, entries: string[]): Promise<string> {
    const metadata = target === "project" && !project ? [] : await this.metadata(target, project, entries);
    return hash({ entries, validity: metadata.map(e => ({ id: e.id, revision: e.revision })) });
  }

  inspect(target: MemoryTarget, project: ProjectRef | null): Promise<{ entries: string[]; revision: string; metadata: MemoryEntryMeta[]; scope: string }> {
    return this.queue.run(async () => {
    const entries = await this.entriesUnlocked(target, project);
    return { entries, revision: await this.revisionFor(target, project, entries), metadata: target === "project" && !project ? [] : await this.metadata(target, project, entries), scope: project ? `${project.scope ?? "project"}:${project.root}` : "host" };
    });
  }

  async reviewState(project: ProjectRef | null): Promise<string> {
    const stores = await this.views();
    if (project && !stores.some(v => v.project?.key === project.key)) stores.push({ target: "project", project, label: `${project.scope ?? "project"}: ${project.name}`, limit: this.limitOf("project"), used: 0, entries: [], revision: await this.revisionFor("project", project, []), metadata: [] });
    return JSON.stringify(stores.filter(v => !v.project || v.project.key === project?.key), null, 2);
  }

  /** Writes or stages a batch. Never throws for validation problems; they come back as errors. */
  write(target: MemoryTarget, project: ProjectRef | null, ops: readonly MemoryOp[], options: WriteOptions): Promise<{ result: MemoryResult; changes: MemoryChange[] }> {
    return this.queue.run(async () => {
      if (target === "project" && !project) {
        return { result: { success: false, target, error: "No project is known for this agent's working directory, so target='project' is unavailable. Use 'memory' instead." }, changes: [] };
      }
      if (ops.length === 0) return { result: { success: false, target, error: "No operations given." }, changes: [] };
      const limit = this.limitOf(target);
      const entries = await this.entriesUnlocked(target, project);
      if (options.expectedRevision && options.expectedRevision !== await this.revisionFor(target, project, entries)) return { result: { success: false, target, error: "Conflict: memory changed since the review/read snapshot. Read it again before writing.", current_entries: entries }, changes: [] };
      const batch = applyBatch(entries, ops, target, project, limit);
      if (!batch.ok) {
        const overBudget = batch.error?.includes("current_entries") ?? false;
        return {
          result: {
            success: false,
            target,
            error: batch.error!,
            usage: usageText(joinedLength(entries), limit),
            ...(overBudget ? { current_entries: entries } : {}),
            ...(batch.closest ? { closest_entries: batch.closest } : {}),
          },
          changes: [],
        };
      }
      if (batch.changes.length === 0) {
        return { result: { success: true, target, message: batch.messages.join(" ") || "Nothing changed.", usage: usageText(joinedLength(entries), limit), entry_count: entries.length }, changes: [] };
      }
      if (options.stage) {
        const pending: PendingWrite = {
          id: newId("mw_"),
          createdAt: new Date().toISOString(),
          actor: options.actor,
          target,
          project,
          operations: ops.map((op) => ({ ...op })),
          pinned: batch.pinned,
          revision: await this.revisionFor(target, project, entries),
        };
        const all = await readJson(this.paths.pending, [] as PendingWrite[], parsePending);
        const same = all.find(p => p.target === target && p.project?.key === project?.key && p.revision === pending.revision && JSON.stringify(p.operations) === JSON.stringify(pending.operations));
        if (same) pending.id = same.id;
        else all.push(pending);
        await writeJson(this.paths.pending, { pending: all });
        return {
          result: {
            success: true,
            target,
            staged: true,
            pending_id: pending.id,
            message: "Write staged for the user's approval (write approval is on). It is not in memory yet; do not retry it.",
          },
          changes: batch.changes,
        };
      }
      if (project) await this.rememberProject(project);
      await this.saveMetadata(target, project, entries, batch.entries, batch.changes, options.actor);
      await writeAtomic(this.filePath(target, project), batch.entries.join(ENTRY_DELIMITER) + "\n");
      const replaced = batch.changes.flatMap((change) => (change.before ? [change.before] : []));
      return {
        result: {
          success: true,
          target,
          usage: usageText(joinedLength(batch.entries), limit),
          entry_count: batch.entries.length,
          ...(batch.messages.length ? { message: batch.messages.join(" ") } : {}),
          ...(replaced.length ? { replaced } : {}),
          note: "Write saved. This update is complete — do not repeat it. New agents see it in their system prompt; this session keeps its starting snapshot.",
        },
        changes: batch.changes,
      };
    });
  }

  async pending(): Promise<PendingWrite[]> {
    return readJson(this.paths.pending, [] as PendingWrite[], parsePending);
  }

  /** Approve applies the staged batch only if every entry it targeted is still there unchanged. */
  resolvePending(id: string, approve: boolean): Promise<{ ok: boolean; message: string; changes: MemoryChange[] }> {
    return this.queue.run(async () => {
      const all = await this.pending();
      const item = all.find((entry) => entry.id === id);
      if (!item) return { ok: false, message: "That staged write no longer exists.", changes: [] };
      const rest = all.filter((entry) => entry.id !== id);
      if (!approve) {
        await writeJson(this.paths.pending, { pending: rest });
        return { ok: true, message: "Rejected.", changes: [] };
      }
      const entries = await this.entriesUnlocked(item.target, item.project);
      if (item.revision && item.revision !== await this.revisionFor(item.target, item.project, entries)) return { ok: false, message: "Conflict: this memory store changed since the proposal was staged. Reject it and generate a new proposal.", changes: [] };
      const missing = item.pinned.filter((text) => !entries.includes(text));
      if (missing.length > 0) {
        return { ok: false, message: `An entry this write targets changed since it was staged: "${missing[0]!.slice(0, 80)}". Reject it and make the change again.`, changes: [] };
      }
      const batch = applyBatch(entries, item.operations, item.target, item.project, this.limitOf(item.target));
      if (!batch.ok) return { ok: false, message: batch.error ?? "The staged write no longer applies.", changes: [] };
      if (item.project) await this.rememberProject(item.project);
      await this.saveMetadata(item.target, item.project, entries, batch.entries, batch.changes, item.actor);
      await writeAtomic(this.filePath(item.target, item.project), batch.entries.join(ENTRY_DELIMITER) + "\n");
      await writeJson(this.paths.pending, { pending: rest });
      return { ok: true, message: "Approved and saved.", changes: batch.changes };
    });
  }

  /** Frozen system-prompt block for a new agent ("" when every store is empty). */
  snapshot(project: ProjectRef | null): Promise<string> { return this.queue.run(() => this.snapshotUnlocked(project)); }

  private async snapshotUnlocked(project: ProjectRef | null): Promise<string> {
    const blocks: string[] = [];
    const sep = "═".repeat(46);
    const add = (title: string, entries: string[], limit: number) => {
      if (entries.length === 0) return;
      blocks.push(`${sep}\n${title} [${usageText(joinedLength(entries), limit)}]\n${sep}\n${entries.join(ENTRY_DELIMITER)}`);
    };
    const active = async (target: MemoryTarget, scope: ProjectRef | null = null) => {
      const entries = await this.entriesUnlocked(target, scope);
      const metadata = await this.metadata(target, scope, entries);
      return entries.filter((_, i) => metadata[i]!.state === "active" && (!metadata[i]!.reviewDue || Date.parse(metadata[i]!.reviewDue!) > Date.now()));
    };
    add(LABELS.user, await active("user"), this.limitOf("user"));
    add(LABELS.memory, await active("memory"), this.limitOf("memory"));
    if (project) add(`${project.scope === "workspace" ? "WORKSPACE MEMORY" : LABELS.project}: ${project.name} (${project.root})`, await active("project", project), this.limitOf("project"));
    return blocks.join("\n\n");
  }
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function entryRevision(item: MemoryEntryMeta): string { return hash({ contentHash: item.contentHash, state: item.state, reviewDue: item.reviewDue }); }
