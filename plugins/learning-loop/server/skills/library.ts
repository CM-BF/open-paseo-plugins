// The skill library: agent-written procedural memory in the agentskills.io shape Hermes uses
// (SKILL.md + references/ templates/ scripts/ assets/). Ported behaviors (tools/skill_manager_tool.py,
// tools/skills_tool.py, agent/curator.py):
// - skill_manage is an ordered operations batch applied atomically (any failure changes nothing);
// - read-before-write: patching or overwriting an existing file needs a skill_view of that exact file
//   by the same caller, and the file must not have changed since;
// - pinned skills are off-limits to agents; an agent "delete" archives (recoverable);
// - every mutation appends a ledger entry with content-addressed before/after blobs, so one entry can
//   be rolled back;
// - usage counters drive the curator's active → stale → archived transitions.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import {
  SKILL_CATEGORY_RE,
  SKILL_DESCRIPTION_INDEX_CHARS,
  SKILL_NAME_RE,
  SKILL_SUPPORT_DIRS,
} from "../../shared/constants";
import type { Actor, LedgerEntry, SkillSummary, SkillProposal } from "../../shared/contracts";
import { appendLine, newId, readJson, readText, SerialQueue, writeAtomic, writeJson } from "../files";
import type { StatePaths } from "../paths";
import { firstThreatMessage, type ThreatScope } from "../threats";
import { parseFrontmatter } from "./frontmatter";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_OPS = 20;

export interface SkillRecord {
  name: string;
  category: string | null;
  dir: string;
  archived: boolean;
  description: string;
}

interface UsageRecord {
  createdBy: SkillSummary["createdBy"];
  createdAt: string | null;
  sourceAgentId: string | null;
  sourceRunId: string | null;
  category: string | null;
  lastViewedAt: string | null;
  lastPatchedAt: string | null;
  viewCount: number;
  useCount: number;
  patchCount: number;
  pinned: boolean;
  validity: "active" | "reference";
  reviewDue: string | null;
  stale: boolean;
}

type UsageFile = { skills: Record<string, UsageRecord> };

function emptyUsage(): UsageRecord {
  return {
    createdBy: "unknown",
    createdAt: null,
    sourceAgentId: null,
    sourceRunId: null,
    category: null,
    lastViewedAt: null,
    lastPatchedAt: null,
    viewCount: 0,
    useCount: 0,
    patchCount: 0,
    pinned: false,
    validity: "active",
    reviewDue: null,
    stale: false,
  };
}

function parseUsage(value: unknown): UsageFile {
  const skills: Record<string, UsageRecord> = {};
  const raw = (value as { skills?: unknown })?.skills;
  if (raw && typeof raw === "object") {
    for (const [name, record] of Object.entries(raw as Record<string, Partial<UsageRecord>>)) {
      skills[name] = { ...emptyUsage(), ...record };
    }
  }
  return { skills };
}

export function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A skill-relative support path: `references/x.md`, never absolute, never `..`. */
export function cleanSupportPath(filePath: string): { ok: true; path: string } | { ok: false; error: string } {
  const raw = filePath.trim().replace(/\\/g, "/");
  if (!raw) return { ok: false, error: "file_path is empty." };
  if (isAbsolute(raw) || raw.startsWith("/")) return { ok: false, error: "file_path must be relative to the skill directory, e.g. 'references/api.md'." };
  const norm = normalize(raw).split(sep).join("/");
  if (norm.split("/").some((part) => part === ".." || part === "")) return { ok: false, error: "file_path may not contain '..' or empty segments." };
  if (norm === "SKILL.md") return { ok: true, path: norm };
  const first = norm.split("/")[0]!;
  if (!(SKILL_SUPPORT_DIRS as readonly string[]).includes(first) || !norm.includes("/")) {
    return { ok: false, error: `file_path must start with one of ${SKILL_SUPPORT_DIRS.map((d) => `${d}/`).join(", ")}.` };
  }
  return { ok: true, path: norm };
}

export type SkillOp =
  | { action: "create"; name: string; content: string; category?: string }
  | { action: "patch"; name: string; old_string: string; new_string: string; replace_all?: boolean; file_path?: string }
  | { action: "rewrite"; name: string; content: string }
  | { action: "write_file"; name: string; file_path: string; file_content: string }
  | { action: "remove_file"; name: string; file_path: string }
  | { action: "delete"; name: string; absorbed_into?: string };

/** Reads the MCP `operations` array (or the legacy flat shape) into typed ops. */
export function parseOps(args: Record<string, unknown>): { ok: true; ops: SkillOp[] } | { ok: false; error: string } {
  const list = Array.isArray(args.operations) ? (args.operations as unknown[]) : typeof args.action === "string" ? [args] : null;
  if (!list || list.length === 0) return { ok: false, error: "Pass 'operations': a list of {name, action, ...} objects." };
  if (list.length > MAX_OPS) return { ok: false, error: `At most ${MAX_OPS} operations per call.` };
  const ops: SkillOp[] = [];
  for (const [index, value] of list.entries()) {
    const op = (value ?? {}) as Record<string, unknown>;
    const where = list.length > 1 ? `Operation ${index + 1}: ` : "";
    const name = typeof op.name === "string" ? op.name.trim() : "";
    if (!SKILL_NAME_RE.test(name)) return { ok: false, error: `${where}'name' must be lowercase letters, digits, hyphens or underscores (max 64).` };
    const str = (key: string) => (typeof op[key] === "string" ? (op[key] as string) : undefined);
    switch (op.action) {
      case "create": {
        const content = str("content");
        if (!content) return { ok: false, error: `${where}create needs 'content' (the full SKILL.md).` };
        const category = str("category")?.trim();
        if (category && !SKILL_CATEGORY_RE.test(category)) return { ok: false, error: `${where}'category' must be a lowercase directory name.` };
        ops.push({ action: "create", name, content, ...(category ? { category } : {}) });
        break;
      }
      case "patch":
      case "edit": {
        const content = str("content");
        const oldString = str("old_string");
        if (oldString !== undefined) {
          const newString = str("new_string");
          if (newString === undefined) return { ok: false, error: `${where}patch needs 'new_string' (empty string deletes the match).` };
          ops.push({
            action: "patch",
            name,
            old_string: oldString,
            new_string: newString,
            ...(op.replace_all === true ? { replace_all: true } : {}),
            ...(str("file_path") ? { file_path: str("file_path")! } : {}),
          });
        } else if (content !== undefined) ops.push({ action: "rewrite", name, content });
        else return { ok: false, error: `${where}patch needs old_string/new_string, or 'content' for a full SKILL.md rewrite.` };
        break;
      }
      case "write_file": {
        const filePath = str("file_path");
        const fileContent = str("file_content") ?? str("content");
        if (!filePath || fileContent === undefined) return { ok: false, error: `${where}write_file needs 'file_path' and 'file_content'.` };
        ops.push({ action: "write_file", name, file_path: filePath, file_content: fileContent });
        break;
      }
      case "remove_file": {
        const filePath = str("file_path");
        if (!filePath) return { ok: false, error: `${where}remove_file needs 'file_path'.` };
        ops.push({ action: "remove_file", name, file_path: filePath });
        break;
      }
      case "delete":
        if (list.length > 1) return { ok: false, error: "delete must be the only operation in its call." };
        ops.push({ action: "delete", name, ...(str("absorbed_into") ? { absorbed_into: str("absorbed_into")! } : {}) });
        break;
      default:
        return { ok: false, error: `${where}unknown action '${String(op.action)}'. Use create, patch, write_file, remove_file or delete.` };
    }
  }
  return { ok: true, ops };
}

function threatScopeFor(path: string): ThreatScope {
  return path === "SKILL.md" || path.endsWith(".md") ? "strict" : "all";
}

function validateSkillMd(name: string, content: string): { error?: string; warnings: string[] } {
  const warnings: string[] = [];
  const fm = parseFrontmatter(content);
  if (!fm.present) return { error: "SKILL.md must start with YAML frontmatter (--- name: ... description: ... ---).", warnings };
  if (fm.fields.name && fm.fields.name !== name) return { error: `frontmatter name '${fm.fields.name}' does not match the skill name '${name}'.`, warnings };
  const description = (fm.fields.description ?? "").trim();
  if (!description) return { error: "frontmatter needs a one-sentence 'description'.", warnings };
  if (description.length > 1024) return { error: "description is longer than 1024 characters.", warnings };
  if (description.length > SKILL_DESCRIPTION_INDEX_CHARS) {
    warnings.push(
      `description is ${description.length} chars; the skills index shows only the first ${SKILL_DESCRIPTION_INDEX_CHARS}. ` +
        "Shorten it now with a patch: keep it a self-contained trigger within 60 chars, 'Use when <trigger>. <behavior>.'",
    );
  }
  if (!fm.body.trim()) return { error: "SKILL.md has no body after the frontmatter.", warnings };
  return { warnings };
}

function occurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) count += 1;
  return count;
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) throw new Error("Learning-owned skills must not contain symlinks; upstream installations are read-only.");
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join("/"));
  }
  return out.sort();
}

interface LedgerRecord {
  id: string;
  at: string;
  actor: Actor;
  skill: string;
  action: string;
  summary: string;
  /** Skill-relative paths with sha256 of the content before/after (null = absent). */
  files: Array<{ path: string; before: string | null; after: string | null }>;
  /** Directory the skill lived in before (archive/restore/delete). */
  dir?: string;
  /** The ledger entry a rollback undid. */
  target?: string;
}

export interface ManageResult {
  success: boolean;
  staged?: boolean;
  pending_id?: string;
  error?: string;
  results?: Array<{ name: string; action: string; message: string }>;
  warnings?: string[];
  note?: string;
}

export interface ViewResult {
  success: boolean;
  error?: string;
  name?: string;
  category?: string | null;
  file_path?: string;
  content?: string;
  files?: string[];
  note?: string;
}

interface StoredProposal extends SkillProposal { operations?: SkillOp[]; stateAction?: { name: string; action: "archive" | "stale" }; activityRevisions?: Record<string, string> }

export class SkillLibrary {
  private readonly queue = new SerialQueue();
  /** reader → target ("name\0path") → sha of the content it saw. */
  private readonly reads = new Map<string, Map<string, string>>();
  /** skill → readers that loaded it (useCount counts distinct readers). */
  private readonly loadedBy = new Map<string, Set<string>>();

  constructor(
    private readonly paths: StatePaths,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async usage(): Promise<UsageFile> {
    return readJson(this.paths.usage, { skills: {} }, parseUsage);
  }

  private async saveUsage(usage: UsageFile): Promise<void> {
    await writeJson(this.paths.usage, usage);
  }

  /** Active skills (category dirs one level deep) and archived ones. Names are unique; first wins. */
  async scan(): Promise<SkillRecord[]> {
    const out: SkillRecord[] = [];
    const seen = new Set<string>();
    const add = async (dir: string, name: string, category: string | null, archived: boolean) => {
      if (seen.has(name) || !SKILL_NAME_RE.test(name)) return;
      const stat = await fs.lstat(join(dir, "SKILL.md")).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) return;
      const text = await readText(join(dir, "SKILL.md"));
      if (text === null) return;
      seen.add(name);
      out.push({ name, category, dir, archived, description: (parseFrontmatter(text).fields.description ?? "").trim() });
    };
    const top = await fs.readdir(this.paths.skillsDir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
    for (const entry of top) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = join(this.paths.skillsDir, entry.name);
      if ((await readText(join(dir, "SKILL.md"))) !== null) {
        await add(dir, entry.name, null, false);
        continue;
      }
      const inner = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
      for (const child of inner) {
        if (child.isDirectory() && !child.name.startsWith(".")) await add(join(dir, child.name), child.name, entry.name, false);
      }
    }
    const archived = await fs.readdir(this.paths.archiveDir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
    for (const entry of archived) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) await add(join(this.paths.archiveDir, entry.name), entry.name, null, true);
    }
    return out;
  }

  private async find(name: string): Promise<SkillRecord | null> {
    return (await this.scan()).find((skill) => skill.name === name) ?? null;
  }

  async list(includeArchived = true): Promise<SkillSummary[]> {
    const usage = await this.usage();
    const out: SkillSummary[] = [];
    for (const skill of await this.scan()) {
      if (skill.archived && !includeArchived) continue;
      const u = usage.skills[skill.name] ?? emptyUsage();
      out.push({
        name: skill.name,
        category: skill.archived ? u.category : skill.category,
        description: skill.description,
        state: skill.archived ? "archived" : u.stale ? "stale" : "active",
        pinned: u.pinned,
        createdBy: u.createdBy,
        createdAt: u.createdAt,
        lastUsedAt: lastActivity(u),
        useCount: u.useCount,
        viewCount: u.viewCount,
        patchCount: u.patchCount,
        revision: await this.revision(skill.name),
        validity: skill.archived ? "archived" : u.validity,
        reviewDue: u.reviewDue,
        source: { kind: u.createdBy === "unknown" ? "legacy" : "learned", agentId: u.sourceAgentId, runId: u.sourceRunId },
        files: await listFiles(skill.dir),
      });
    }
    return out.sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") || a.name.localeCompare(b.name));
  }

  /** The system-prompt index: active and stale skills, most recently used first, grouped by category. */
  async index(limit: number): Promise<string> {
    if (limit <= 0) return "";
    const skills = (await this.list(false)).filter(s => s.validity !== "reference" && (!s.reviewDue || Date.parse(s.reviewDue) > this.now().getTime())).sort((a, b) => Number(a.state === "stale") - Number(b.state === "stale")).slice(0, limit);
    if (skills.length === 0) return "";
    const byCategory = new Map<string, SkillSummary[]>();
    for (const skill of skills) {
      const key = skill.category ?? "general";
      byCategory.set(key, [...(byCategory.get(key) ?? []), skill]);
    }
    const lines: string[] = [];
    for (const category of [...byCategory.keys()].sort()) {
      lines.push(`  ${category}:`);
      for (const skill of byCategory.get(category)!.sort((a, b) => a.name.localeCompare(b.name))) {
        const desc = skill.description.slice(0, SKILL_DESCRIPTION_INDEX_CHARS);
        lines.push(desc ? `    - ${skill.name}: ${desc}` : `    - ${skill.name}`);
      }
    }
    return lines.join("\n");
  }

  private recordRead(reader: string, name: string, path: string, content: string): void {
    let map = this.reads.get(reader);
    if (!map) {
      map = new Map();
      this.reads.set(reader, map);
    }
    map.set(`${name}\0${path}`, sha(content));
  }

  private readHash(reader: string, name: string, path: string): string | undefined {
    return this.reads.get(reader)?.get(`${name}\0${path}`);
  }

  /** Forgets a caller's reads (its session ended). */
  forgetReader(reader: string): void {
    this.reads.delete(reader);
  }

  /** skill_view. `reader` is the calling agent or review run; null for the UI (not counted as use). */
  view(name: string, filePath: string | null, reader: string | null): Promise<ViewResult> {
    return this.queue.run(async () => {
      const skill = await this.find(name);
      if (!skill) {
        const names = (await this.scan()).filter((s) => !s.archived).map((s) => s.name);
        const near = names.filter((n) => n.includes(name) || name.includes(n)).slice(0, 5);
        return { success: false, error: `No skill named '${name}'.${near.length ? ` Did you mean: ${near.join(", ")}?` : " Call skills_list to see what exists."}` };
      }
      if (skill.archived && reader !== null) return { success: false, error: `Skill '${name}' is archived. Ask the user to restore it in Learning → Skills if it is still needed.` };
      const files = await listFiles(skill.dir);
      if (filePath && filePath !== "SKILL.md") {
        const clean = cleanSupportPath(filePath);
        if (!clean.ok) return { success: false, error: clean.error };
        const content = await readText(join(skill.dir, clean.path));
        if (content === null) return { success: false, error: `'${clean.path}' does not exist in skill '${name}'. Files: ${files.join(", ") || "(none)"}` };
        if (reader) this.recordRead(reader, name, clean.path, content);
        return { success: true, name, category: skill.category, file_path: clean.path, content, files };
      }
      const content = (await readText(join(skill.dir, "SKILL.md"))) ?? "";
      if (reader) {
        this.recordRead(reader, name, "SKILL.md", content);
        const usage = await this.usage();
        const u = usage.skills[name] ?? emptyUsage();
        u.viewCount += 1;
        u.lastViewedAt = this.now().toISOString();
        u.stale = false;
        let readers = this.loadedBy.get(name);
        if (!readers) {
          readers = new Set();
          this.loadedBy.set(name, readers);
        }
        if (!readers.has(reader)) {
          readers.add(reader);
          u.useCount += 1;
        }
        usage.skills[name] = u;
        await this.saveUsage(usage);
      }
      const support = files.filter((f) => f !== "SKILL.md");
      return {
        success: true,
        name,
        category: skill.category,
        content,
        files: support,
        ...(support.length ? { note: "Load a supporting file with skill_view(name, file_path='references/...') only when the task needs it." } : {}),
      };
    });
  }

  async revision(name: string): Promise<string> {
    const record = await this.find(name);
    if (!record) return "absent";
    const u = (await this.usage()).skills[name] ?? emptyUsage();
    const files = await Promise.all((await listFiles(record.dir)).map(async path => [path, sha(await readText(join(record.dir, path)) ?? "")]));
    return sha(JSON.stringify({ files, archived: record.archived, category: record.category, pinned: u.pinned, stale: u.stale, validity: u.validity, reviewDue: u.reviewDue }));
  }

  async pending(): Promise<StoredProposal[]> {
    const text = await readText(join(this.paths.skillsDir, ".pending.v1.json"));
    if (!text) return [];
    const data = JSON.parse(text) as { version: number; proposals: StoredProposal[] };
    if (data.version !== 1 || !Array.isArray(data.proposals)) throw new Error("Unsupported skill proposal store");
    return data.proposals;
  }

  private async propose(actor: Actor, summary: string, diff: SkillProposal["diff"], operations?: readonly SkillOp[], stateAction?: StoredProposal["stateAction"]): Promise<ManageResult> {
    const names = [...new Set([...diff.map(d => d.name), ...(stateAction ? [stateAction.name] : [])])];
    const revisions = Object.fromEntries(await Promise.all(names.map(async name => [name, await this.revision(name)])));
    const usage = await this.usage();
    const activityRevisions = stateAction || (actor.kind === "curator" && operations?.some(op => op.action === "delete")) ? Object.fromEntries(names.map(name => [name, activityRevision(usage.skills[name] ?? emptyUsage())])) : undefined;
    const proposals = await this.pending();
    const same = proposals.find(p => JSON.stringify(p.revisions) === JSON.stringify(revisions) && JSON.stringify(p.diff) === JSON.stringify(diff) && p.summary === summary && JSON.stringify(p.activityRevisions) === JSON.stringify(activityRevisions));
    const proposal: StoredProposal = same ?? { id: newId("sp_"), createdAt: this.now().toISOString(), actor, summary, revisions, diff, ...(activityRevisions ? { activityRevisions } : {}), ...(operations ? { operations: [...operations] } : {}), ...(stateAction ? { stateAction } : {}) };
    if (!same) {
      proposals.push(proposal);
      await writeJson(join(this.paths.skillsDir, ".pending.v1.json"), { version: 1, proposals });
    }
    return { success: true, staged: true, pending_id: proposal.id, results: names.map(name => ({ name, action: "proposal", message: "Staged for approval; skill files remain unchanged." })) };
  }

  resolvePending(id: string, approve: boolean): Promise<{ ok: boolean; message: string }> {
    return this.queue.run(async () => {
      const all = await this.pending();
      const item = all.find(p => p.id === id);
      if (!item) return { ok: false, message: "This skill proposal no longer exists." };
      if (approve) {
        const usage = await this.usage();
        for (const [name, activity] of Object.entries(item.activityRevisions ?? {})) {
          if (activityRevision(usage.skills[name] ?? emptyUsage()) !== activity) return { ok: false, message: `Conflict: ${name} was used since the curator proposal. Run the curator again.` };
        }
        for (const [name, revision] of Object.entries(item.revisions)) {
          if (await this.revision(name) !== revision) return { ok: false, message: `Conflict: '${name}' changed since the proposal. Reject it and generate a new diff.` };
        }
        if (item.operations) {
          const result = await this.manageUnlocked(item.operations, item.actor, null, false, true);
          if (!result.success) return { ok: false, message: result.error ?? "Proposal failed." };
        } else if (item.stateAction?.action === "archive") {
          const result = await this.archiveUnlocked(item.stateAction.name, item.actor, item.summary);
          if (!result.ok) return result;
        } else if (item.stateAction?.action === "stale") {
          const usage = await this.usage();
          const u = usage.skills[item.stateAction.name];
          if (!u) return { ok: false, message: "Skill ownership changed." };
          u.stale = true;
          await this.saveUsage(usage);
        } else return { ok: false, message: "Unsupported proposal." };
      }
      await writeJson(join(this.paths.skillsDir, ".pending.v1.json"), { version: 1, proposals: all.filter(p => p.id !== id) });
      return { ok: true, message: approve ? "Approved and saved." : "Rejected." };
    });
  }

  /** skill_manage: validate everything on an overlay, then commit; any failure leaves disk untouched. */
  manage(ops: readonly SkillOp[], actor: Actor, reader: string | null, stage = false): Promise<ManageResult> {
    return this.queue.run(() => this.manageUnlocked(ops, actor, reader, stage));
  }

  private async manageUnlocked(ops: readonly SkillOp[], actor: Actor, reader: string | null, stage: boolean, approved = false): Promise<ManageResult> {
      const skills = await this.scan();
      const usage = await this.usage();
      const byName = new Map(skills.map((skill) => [skill.name, skill]));
      for (const name of new Set(ops.map(op => op.name))) {
        const existing = byName.get(name);
        if (existing) await listFiles(existing.dir);
      }
      const overlay = new Map<string, string | null>(); // absolute path → new content (null = delete)
      const created = new Map<string, { dir: string; category: string | null }>();
      const touched = new Map<string, { dir: string; paths: Set<string>; action: string; summaries: string[] }>();
      const results: Array<{ name: string; action: string; message: string }> = [];
      const warnings: string[] = [];
      const isUser = actor.kind === "user";

      const dirOf = (name: string): string | null => created.get(name)?.dir ?? (byName.get(name) && !byName.get(name)!.archived ? byName.get(name)!.dir : null);
      const current = async (name: string, path: string): Promise<string | null> => {
        const dir = dirOf(name)!;
        const abs = join(dir, path);
        if (overlay.has(abs)) return overlay.get(abs)!;
        return readText(abs);
      };
      const touch = (name: string, path: string, action: string, summary: string) => {
        const dir = dirOf(name)!;
        const entry = touched.get(name) ?? { dir, paths: new Set<string>(), action, summaries: [] };
        entry.paths.add(path);
        if (entry.action !== action && entry.action !== "create") entry.action = "edit";
        entry.summaries.push(summary);
        touched.set(name, entry);
      };
      const guardRead = async (name: string, path: string): Promise<string | null> => {
        if (created.has(name) || isUser || approved) return null;
        const onDisk = await readText(join(dirOf(name)!, path));
        if (onDisk === null) return null;
        const seen = reader ? this.readHash(reader, name, path) : undefined;
        if (seen === undefined) {
          return `Read-before-write: call skill_view(name='${name}'${path === "SKILL.md" ? "" : `, file_path='${path}'`}) first, then base this write on what it returns.`;
        }
        if (seen !== sha(onDisk)) return `'${path}' in skill '${name}' changed since you viewed it. Call skill_view again and redo the write against the new content.`;
        return null;
      };
      const fail = (index: number, message: string): ManageResult => ({
        success: false,
        error: `${ops.length > 1 ? `Operation ${index + 1} (${ops[index]!.action}): ` : ""}${message} Nothing was changed.`,
      });

      for (const [index, op] of ops.entries()) {
        const existing = byName.get(op.name);
        if (op.action === "create") {
          if (existing || created.has(op.name)) {
            return fail(index, existing?.archived ? `A skill named '${op.name}' exists in the archive; ask the user to restore it, or pick another name.` : `Skill '${op.name}' already exists; patch it instead (skill_view it first).`);
          }
          const check = validateSkillMd(op.name, op.content);
          if (check.error) return fail(index, check.error);
          const threat = firstThreatMessage(op.content, "strict");
          if (threat) return fail(index, threat);
          const dir = op.category ? join(this.paths.skillsDir, op.category, op.name) : join(this.paths.skillsDir, op.name);
          created.set(op.name, { dir, category: op.category ?? null });
          overlay.set(join(dir, "SKILL.md"), op.content.endsWith("\n") ? op.content : `${op.content}\n`);
          touch(op.name, "SKILL.md", "create", "created");
          warnings.push(...check.warnings.map((w) => `${op.name}: ${w}`));
          results.push({ name: op.name, action: "create", message: `Created ${op.category ? `${op.category}/` : ""}${op.name}.` });
          continue;
        }
        if (!dirOf(op.name)) {
          return fail(index, existing?.archived ? `Skill '${op.name}' is archived.` : `No skill named '${op.name}'. Use skills_list, or create it first in this same call.`);
        }
        if (!isUser && usage.skills[op.name]?.pinned && !created.has(op.name)) {
          return fail(index, `Skill '${op.name}' is pinned by the user; it cannot be changed by agents.`);
        }
        if (op.action === "patch") {
          const clean = cleanSupportPath(op.file_path ?? "SKILL.md");
          if (!clean.ok) return fail(index, clean.error);
          const guard = await guardRead(op.name, clean.path);
          if (guard) return fail(index, guard);
          const text = await current(op.name, clean.path);
          if (text === null) return fail(index, `'${clean.path}' does not exist in '${op.name}'.`);
          const count = occurrences(text, op.old_string);
          if (count === 0) return fail(index, `old_string was not found in ${clean.path}. Copy it verbatim from skill_view output.`);
          if (count > 1 && !op.replace_all) return fail(index, `old_string occurs ${count} times in ${clean.path}; add surrounding text or set replace_all.`);
          const next = op.replace_all ? text.split(op.old_string).join(op.new_string) : text.replace(op.old_string, () => op.new_string);
          if (clean.path === "SKILL.md") {
            const check = validateSkillMd(op.name, next);
            if (check.error) return fail(index, `the patched SKILL.md is invalid: ${check.error}`);
          }
          const threat = firstThreatMessage(next, threatScopeFor(clean.path));
          if (threat) return fail(index, threat);
          overlay.set(join(dirOf(op.name)!, clean.path), next);
          touch(op.name, clean.path, "patch", `patched ${clean.path}`);
          results.push({ name: op.name, action: "patch", message: `Patched ${clean.path}${count > 1 ? ` (${count} places)` : ""}.` });
          continue;
        }
        if (op.action === "rewrite") {
          const guard = await guardRead(op.name, "SKILL.md");
          if (guard) return fail(index, guard);
          const check = validateSkillMd(op.name, op.content);
          if (check.error) return fail(index, check.error);
          const threat = firstThreatMessage(op.content, "strict");
          if (threat) return fail(index, threat);
          overlay.set(join(dirOf(op.name)!, "SKILL.md"), op.content.endsWith("\n") ? op.content : `${op.content}\n`);
          warnings.push(...check.warnings.map((w) => `${op.name}: ${w}`));
          touch(op.name, "SKILL.md", "edit", "rewrote SKILL.md");
          results.push({ name: op.name, action: "patch", message: "Rewrote SKILL.md." });
          continue;
        }
        if (op.action === "write_file") {
          const clean = cleanSupportPath(op.file_path);
          if (!clean.ok) return fail(index, clean.error);
          if (clean.path === "SKILL.md") return fail(index, "Use patch for SKILL.md.");
          if (Buffer.byteLength(op.file_content) > MAX_FILE_BYTES) return fail(index, `file_content is larger than ${MAX_FILE_BYTES / 1024} KB.`);
          const before = await current(op.name, clean.path);
          if (before !== null) {
            const guard = await guardRead(op.name, clean.path);
            if (guard) return fail(index, guard);
          }
          const threat = firstThreatMessage(op.file_content, threatScopeFor(clean.path));
          if (threat) return fail(index, threat);
          overlay.set(join(dirOf(op.name)!, clean.path), op.file_content);
          touch(op.name, clean.path, "write_file", `${before === null ? "added" : "rewrote"} ${clean.path}`);
          results.push({ name: op.name, action: "write_file", message: `${before === null ? "Added" : "Rewrote"} ${clean.path}.` });
          continue;
        }
        if (op.action === "remove_file") {
          const clean = cleanSupportPath(op.file_path);
          if (!clean.ok) return fail(index, clean.error);
          if (clean.path === "SKILL.md") return fail(index, "SKILL.md cannot be removed; delete the skill instead.");
          if ((await current(op.name, clean.path)) === null) return fail(index, `'${clean.path}' does not exist in '${op.name}'.`);
          const guard = await guardRead(op.name, clean.path);
          if (guard) return fail(index, guard);
          overlay.set(join(dirOf(op.name)!, clean.path), null);
          touch(op.name, clean.path, "remove_file", `removed ${clean.path}`);
          results.push({ name: op.name, action: "remove_file", message: `Removed ${clean.path}.` });
          continue;
        }
        // delete → archive (recoverable)
        if (op.absorbed_into && !byName.has(op.absorbed_into) && !created.has(op.absorbed_into)) {
          return fail(index, `absorbed_into '${op.absorbed_into}' does not exist.`);
        }
        if (stage) {
          const diff = await Promise.all((await listFiles(existing!.dir)).map(async path => ({ name: op.name, path, before: await readText(join(existing!.dir, path)), after: null })));
          return this.propose(actor, `Archive ${op.name}`, diff, ops);
        }
        const moved = await this.archiveUnlocked(op.name, actor, op.absorbed_into ? `archived (absorbed into ${op.absorbed_into})` : "archived by delete");
        if (!moved.ok) return fail(index, moved.message);
        return { success: true, results: [{ name: op.name, action: "delete", message: `${moved.message} It can be restored from Learning → Skills.` }] };
      }

      if (stage) {
        const diff: SkillProposal["diff"] = [];
        for (const [name, info] of touched) for (const path of info.paths) {
          const abs = join(info.dir, path);
          diff.push({ name, path, before: await readText(abs), after: overlay.get(abs) ?? null });
        }
        return this.propose(actor, results.map(r => `${r.name}: ${r.message}`).join("; "), diff, ops);
      }
      for (const abs of overlay.keys()) {
        const rel = relative(this.paths.skillsDir, abs);
        if (rel.startsWith("..") || isAbsolute(rel)) return { success: false, error: "Skill path leaves the owned library." };
        let current = this.paths.skillsDir;
        for (const part of rel.split(sep)) {
          current = join(current, part);
          const stat = await fs.lstat(current).catch(e => { if (e.code === "ENOENT") return null; throw e; });
          if (stat?.isSymbolicLink()) return { success: false, error: "Upstream/symlinked skill paths are read-only; create a local supplement instead." };
        }
      }
      // Commit: capture before-state, write blobs, apply, roll back on any failure.
      const befores = new Map<string, string | null>();
      for (const abs of overlay.keys()) befores.set(abs, await readText(abs));
      try {
        for (const [abs, content] of overlay) {
          if (content === null) await fs.rm(abs, { force: true });
          else await writeAtomic(abs, content);
        }
      } catch (error) {
        for (const [abs, content] of befores) {
          if (content === null) await fs.rm(abs, { force: true }).catch(() => undefined);
          else await writeAtomic(abs, content).catch(() => undefined);
        }
        return { success: false, error: `Writing the skill failed (${(error as Error).message}); every change was rolled back.` };
      }

      const at = this.now().toISOString();
      for (const [name, info] of touched) {
        const files: LedgerRecord["files"] = [];
        for (const path of info.paths) {
          const abs = join(info.dir, path);
          const before = befores.get(abs) ?? null;
          const after = overlay.get(abs) ?? null;
          files.push({ path, before: await this.blob(before), after: await this.blob(after) });
        }
        await appendLine(this.paths.ledger, {
          id: newId("lg_"),
          at,
          actor,
          skill: name,
          action: info.action,
          summary: info.summaries.join("; "),
          files,
          dir: info.dir,
        } satisfies LedgerRecord);
        const u = usage.skills[name] ?? emptyUsage();
        if (created.has(name)) {
          u.createdBy = actor.kind === "curator" ? "curator" : actor.kind;
          u.createdAt = at;
          u.sourceAgentId = actor.agentId;
          u.sourceRunId = actor.runId;
          u.category = created.get(name)!.category;
        } else {
          u.patchCount += 1;
          u.lastPatchedAt = at;
          u.stale = false;
        }
        usage.skills[name] = u;
        if (reader) {
          for (const path of info.paths) {
            const content = overlay.get(join(info.dir, path));
            if (content === null || content === undefined) this.reads.get(reader)?.delete(`${name}\0${path}`);
            else this.recordRead(reader, name, path, content);
          }
        }
      }
      await this.saveUsage(usage);
      return {
        success: true,
        results,
        ...(warnings.length ? { warnings } : {}),
        note: "Saved. New agents see new skills in their skills index; this session can load them with skill_view now.",
      };
  }

  private async blob(content: string | null): Promise<string | null> {
    if (content === null) return null;
    const hash = sha(content);
    const path = join(this.paths.ledgerBlobs, hash);
    if ((await readText(path)) === null) await writeAtomic(path, content);
    return hash;
  }

  private async archiveUnlocked(name: string, actor: Actor, summary: string, recordLedger = true): Promise<{ ok: boolean; message: string }> {
    const skill = await this.find(name);
    if (!skill || skill.archived) return { ok: false, message: `No active skill named '${name}'.` };
    const usage = await this.usage();
    if (actor.kind !== "user" && usage.skills[name]?.pinned) return { ok: false, message: `Skill '${name}' is pinned.` };
    const files: LedgerRecord["files"] = [];
    for (const path of await listFiles(skill.dir)) {
      files.push({ path, before: await this.blob(await readText(join(skill.dir, path))), after: null });
    }
    await fs.mkdir(this.paths.archiveDir, { recursive: true });
    const target = join(this.paths.archiveDir, name);
    if ((await fs.stat(target).catch(() => null)) !== null) await fs.rename(target, `${target}-${Date.now()}`);
    await fs.rename(skill.dir, target);
    const u = usage.skills[name] ?? emptyUsage();
    u.category = skill.category;
    u.stale = false;
    usage.skills[name] = u;
    await this.saveUsage(usage);
    if (recordLedger) await appendLine(this.paths.ledger, { id: newId("lg_"), at: this.now().toISOString(), actor, skill: name, action: "archive", summary, files, dir: skill.dir } satisfies LedgerRecord);
    return { ok: true, message: `Archived '${name}'.` };
  }

  private async restoreUnlocked(name: string, actor: Actor, recordLedger = true): Promise<{ ok: boolean; message: string }> {
    const skill = await this.find(name);
    if (!skill || !skill.archived) return { ok: false, message: `No archived skill named '${name}'.` };
    const usage = await this.usage();
    const u = usage.skills[name] ?? emptyUsage();
    const dir = u.category ? join(this.paths.skillsDir, u.category, name) : join(this.paths.skillsDir, name);
    if ((await fs.stat(dir).catch(() => null)) !== null) return { ok: false, message: `An active skill directory already exists at ${dir}.` };
    await fs.mkdir(dirname(dir), { recursive: true });
    await fs.rename(skill.dir, dir);
    u.stale = false;
    u.lastPatchedAt = this.now().toISOString();
    usage.skills[name] = u;
    await this.saveUsage(usage);
    if (recordLedger) await appendLine(this.paths.ledger, { id: newId("lg_"), at: this.now().toISOString(), actor, skill: name, action: "restore", summary: "restored from the archive", files: [], dir } satisfies LedgerRecord);
    return { ok: true, message: `Restored '${name}'.` };
  }

  setValidity(name: string, revision: string, validity: "active" | "reference", reviewDue: string | null): Promise<{ ok: boolean; message: string }> {
    return this.queue.run(async () => {
      const record = await this.find(name);
      if (!record || await this.revision(name) !== revision) return { ok: false, message: "Conflict: skill changed. Refresh before changing its validity." };
      if (reviewDue && Number.isNaN(Date.parse(reviewDue))) return { ok: false, message: "Invalid review date." };
      const usage = await this.usage();
      const u = usage.skills[name] ?? emptyUsage();
      u.validity = validity;
      u.reviewDue = reviewDue;
      usage.skills[name] = u;
      await this.saveUsage(usage);
      return { ok: true, message: "Validity saved; existing prompt indexes remain unchanged." };
    });
  }

  /** UI actions: pin, unpin, archive, restore, delete (hard delete; files kept as ledger blobs). */
  setState(name: string, action: "pin" | "unpin" | "archive" | "restore" | "delete" | "reference" | "activate", actor: Actor): Promise<{ ok: boolean; message: string }> {
    return this.queue.run(async () => {
      if (action === "archive") return this.archiveUnlocked(name, actor, "archived");
      if (action === "restore") return this.restoreUnlocked(name, actor);
      const skill = await this.find(name);
      if (!skill) return { ok: false, message: `No skill named '${name}'.` };
      const usage = await this.usage();
      const u = usage.skills[name] ?? emptyUsage();
      if (action === "reference" || action === "activate") {
        u.validity = action === "reference" ? "reference" : "active";
        usage.skills[name] = u;
        await this.saveUsage(usage);
        return { ok: true, message: `${name}: ${u.validity}. Existing conversation indexes remain unchanged.` };
      }
      if (action === "pin" || action === "unpin") {
        u.pinned = action === "pin";
        usage.skills[name] = u;
        await this.saveUsage(usage);
        return { ok: true, message: action === "pin" ? `Pinned '${name}'.` : `Unpinned '${name}'.` };
      }
      const files: LedgerRecord["files"] = [];
      for (const path of await listFiles(skill.dir)) {
        files.push({ path, before: await this.blob(await readText(join(skill.dir, path))), after: null });
      }
      await fs.rm(skill.dir, { recursive: true, force: true });
      await appendLine(this.paths.ledger, {
        id: newId("lg_"),
        at: this.now().toISOString(),
        actor,
        skill: name,
        action: "delete",
        summary: "deleted",
        files,
        dir: skill.archived ? join(this.paths.skillsDir, u.category ?? "", name) : skill.dir,
      } satisfies LedgerRecord);
      return { ok: true, message: `Deleted '${name}'. The ledger can bring it back.` };
    });
  }

  catalogSnapshot(): Promise<unknown> {
    return this.queue.run(async () => {
      const usage = await this.usage();
      const skills = [];
      for (const s of await this.list()) {
        const record = await this.find(s.name);
        if (!record) continue;
        const u = usage.skills[s.name] ?? emptyUsage();
        skills.push({ id: `learning-loop:host:${s.name}`, name: s.name, description: s.description, category: s.category, state: s.state, validity: s.validity, reviewDue: s.reviewDue, revision: await this.revision(s.name), source: { kind: u.createdBy === "unknown" ? "legacy" : "learned", agentId: u.sourceAgentId, runId: u.sourceRunId }, scope: { kind: "host" }, owner: "learning-loop", readOnly: true, files: s.files, content: await readText(join(record.dir, "SKILL.md")) ?? "" });
      }
      return { schemaVersion: 1, owner: "learning-loop", generatedAt: this.now().toISOString(), skills };
    });
  }

  private async ledgerRecords(): Promise<LedgerRecord[]> {
    const raw = await readText(this.paths.ledger);
    if (!raw) return [];
    const out: LedgerRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LedgerRecord);
      } catch {
        // a torn line is skipped, never rewritten
      }
    }
    return out;
  }

  async ledger(skill: string | null, limit: number): Promise<LedgerEntry[]> {
    const records = await this.ledgerRecords();
    const undone = new Set(records.flatMap((r) => (r.action === "rollback" && r.target ? [r.target] : [])));
    return records
      .filter((r) => skill === null || r.skill === skill)
      .slice(-limit)
      .reverse()
      .map((r) => ({ id: r.id, at: r.at, actor: r.actor, skill: r.skill, action: r.action, summary: r.summary, files: r.files, rolledBack: undone.has(r.id) }));
  }

  /** Restores exactly what one ledger entry changed. */
  rollback(id: string, actor: Actor): Promise<{ ok: boolean; message: string }> {
    return this.queue.run(async () => {
      const records = await this.ledgerRecords();
      const record = records.find((r) => r.id === id);
      if (!record) return { ok: false, message: "No such ledger entry." };
      if (records.some((r) => r.action === "rollback" && r.target === id)) return { ok: false, message: "That entry was already rolled back." };
      if (record.action === "rollback") return { ok: false, message: "Rollback entries cannot be rolled back; roll back the original change again instead." };
      const undone = new Set(records.flatMap(r => r.action === "rollback" && r.target ? [r.target] : []));
      if (records.slice(records.indexOf(record) + 1).some(r => r.skill === record.skill && r.action !== "rollback" && !undone.has(r.id))) return { ok: false, message: "Conflict: a later skill change exists. Roll back the latest change first." };
      if (record.action === "archive") {
        const archived = await this.find(record.skill);
        if (!archived?.archived) return { ok: false, message: "Conflict: archived skill state changed." };
        const paths = await listFiles(archived.dir);
        if (paths.length !== record.files.length) return { ok: false, message: "Conflict: archived files changed." };
        for (const file of record.files) if (sha(await readText(join(archived.dir, file.path)) ?? "") !== file.before) return { ok: false, message: "Conflict: archived content changed." };
        const restored = await this.restoreUnlocked(record.skill, actor, false);
        if (restored.ok) await appendLine(this.paths.ledger, { id: newId("lg_"), at: this.now().toISOString(), actor, skill: record.skill, action: "rollback", summary: `undid archive (${record.id})`, files: [], target: id } satisfies LedgerRecord);
        return restored;
      }
      if (record.action === "restore") {
        const archived = await this.archiveUnlocked(record.skill, actor, "re-archived by rollback", false);
        if (archived.ok) await appendLine(this.paths.ledger, { id: newId("lg_"), at: this.now().toISOString(), actor, skill: record.skill, action: "rollback", summary: `undid restore (${record.id})`, files: [], target: id } satisfies LedgerRecord);
        return archived;
      }
      const skill = await this.find(record.skill);
      const dir = skill && !skill.archived ? skill.dir : record.dir;
      if (!dir) return { ok: false, message: "The skill's directory is unknown." };
      if (skill?.archived) return { ok: false, message: `'${record.skill}' is archived; restore it first.` };
      for (const file of record.files) {
        const current = await readText(join(dir, file.path));
        if ((current === null ? null : sha(current)) !== file.after) return { ok: false, message: `Conflict: ${file.path} changed since this ledger entry.` };
        if (file.before !== null && await readText(join(this.paths.ledgerBlobs, file.before)) === null) return { ok: false, message: `The saved content of ${file.path} is missing.` };
      }
      const files: LedgerRecord["files"] = [];
      for (const file of record.files) {
        const abs = join(dir, file.path);
        const now = await readText(abs);
        files.push({ path: file.path, before: await this.blob(now), after: file.before });
        if (file.before === null) await fs.rm(abs, { force: true });
        else {
          const content = await readText(join(this.paths.ledgerBlobs, file.before));
          if (content === null) return { ok: false, message: `The saved content of ${file.path} is missing.` };
          await writeAtomic(abs, content);
        }
      }
      if ((await listFiles(dir)).length === 0) await fs.rm(dir, { recursive: true, force: true });
      await appendLine(this.paths.ledger, { id: newId("lg_"), at: this.now().toISOString(), actor, skill: record.skill, action: "rollback", summary: `undid ${record.action} (${record.summary})`, files, dir, target: id } satisfies LedgerRecord);
      return { ok: true, message: `Rolled back: ${record.summary}.` };
    });
  }

  /**
   * The curator's deterministic pass: agent- and review-created skills that are not pinned go stale
   * after `staleDays` without use and to the archive after `archiveDays`. Returns what changed.
   */
  curate(staleDays: number, archiveDays: number, stage = false): Promise<string[]> {
    return this.queue.run(async () => {
      const changes: string[] = [];
      const curator: Actor = { kind: "curator", agentId: null, title: null, runId: null };
      const now = this.now().getTime();
      const usage = await this.usage();
      const toArchive: string[] = [];
      for (const skill of await this.scan()) {
        if (skill.archived) continue;
        const u = usage.skills[skill.name];
        if (!u || u.pinned || (u.createdBy !== "agent" && u.createdBy !== "review" && u.createdBy !== "curator")) continue;
        const last = lastActivity(u);
        if (!last) continue;
        const idleDays = (now - Date.parse(last)) / 86_400_000;
        if (idleDays >= archiveDays) toArchive.push(skill.name);
        else if (idleDays >= staleDays && !u.stale) {
          if (stage) await this.propose(curator, `${skill.name} → stale`, [], undefined, { name: skill.name, action: "stale" });
          else u.stale = true;
          changes.push(`${stage ? "Proposed: " : ""}${skill.name} → stale`);
        }
      }
      await this.saveUsage(usage);
      for (const name of toArchive) {
        if (stage) {
          await this.propose(curator, `${name} → archived`, [], undefined, { name, action: "archive" });
          changes.push(`Proposed: ${name} → archived`);
          continue;
        }
        const result = await this.archiveUnlocked(name, curator, `archived after ${archiveDays} days unused`);
        if (result.ok) changes.push(`${name} → archived`);
      }
      return changes;
    });
  }
}

function lastActivity(u: UsageRecord): string | null {
  const stamps = [u.lastViewedAt, u.lastPatchedAt, u.createdAt].filter((s): s is string => typeof s === "string");
  return stamps.sort().at(-1) ?? null;
}

function activityRevision(u: UsageRecord): string { return sha(JSON.stringify([u.lastViewedAt, u.lastPatchedAt, u.viewCount, u.useCount])); }
