import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../shared/contracts";
import { DEFAULT_PREFERENCES, migratePreferences, preferencesSchema } from "../shared/settings";
import { shouldStage } from "../server/approval";
import { statePaths } from "../server/paths";
import { SkillLibrary } from "../server/skills/library";
import { LearnedCatalog } from "../server/skills/catalog";
import { MemoryStore } from "../server/memory/store";
import { ReviewBudget } from "../server/review/budget";
import { resolveProject, resolveProjectWithin } from "../server/project";
import { callTool, TOOL_DEFINITIONS, TOOL_DEFINITIONS_V2, toolsForBinding, type ToolDeps } from "../server/tools";
import { SessionIndex } from "../server/sessions/index";

let root: string;
let skills: SkillLibrary;
let memory: MemoryStore;
const agent: Actor = { kind: "agent", agentId: "fixture-agent", title: null, runId: null };
const review: Actor = { ...agent, kind: "review", runId: "review-1" };
const user: Actor = { kind: "user", agentId: null, title: null, runId: null };
const content = "---\nname: fixture\ndescription: Use when testing.\n---\n# Fixture\nUse a private test directory.\n";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ll-reliability-"));
  const paths = statePaths(root);
  skills = new SkillLibrary(paths, () => new Date("2026-10-22T00:00:00Z"));
  memory = new MemoryStore(paths, () => ({ user: 1000, memory: 1000, project: 1000 }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("approval policy and proposals", () => {
  it("preserves v1 choices, applies proposal defaults only to new installs", () => {
    expect(DEFAULT_PREFERENCES.writeApproval).toBe("background");
    expect(preferencesSchema.parse(migratePreferences({}, 1))).toMatchObject({ writeApproval: "off", sessionRetentionDays: 0 });
    for (const mode of ["off", "background", "all"] as const) {
      const migrated = preferencesSchema.parse(migratePreferences({ writeApproval: mode, review: { model: "haiku", maxBudgetUsd: .15, enabled: false } }, 1));
      expect(migrated.writeApproval).toBe(mode);
      expect(migrated.review).toMatchObject({ model: "haiku", maxBudgetUsd: .15, enabled: false, dailyBudgetUsd: 2 });
      expect(shouldStage(mode, user)).toBe(false);
      expect(shouldStage(mode, review)).toBe(mode !== "off");
      expect(shouldStage(mode, agent)).toBe(mode === "all");
    }
  });

  it("stages skill_manage at the dispatcher, survives restart, deduplicates unchanged proposals", async () => {
    const deps: ToolDeps = { skills, memory, sessions: null, stage: () => true, onMemoryChange() {}, onSkillChange() {} };
    const ctx = { actor: review, reader: "review", project: null, selfAgentId: null };
    const args = { operations: [{ name: "fixture", action: "create", content }] };
    const result = JSON.parse((await callTool("skill_manage", args, ctx, deps)).text);
    expect(result.staged).toBe(true);
    expect(await skills.list()).toEqual([]);
    expect(JSON.parse((await callTool("skill_manage", args, ctx, deps)).text).pending_id).toBe(result.pending_id);
    const reloaded = new SkillLibrary(statePaths(root));
    expect((await reloaded.pending())[0]?.diff[0]).toMatchObject({ before: null, after: content });
    expect((await reloaded.resolvePending(result.pending_id, true)).ok).toBe(true);
    expect((await reloaded.view("fixture", null, null)).content).toBe(content);
    expect((await reloaded.pending()).length).toBe(0);
  });

  it("stages multi-file patches and refuses concurrent changes without losing either diff", async () => {
    await skills.manage([{ name: "fixture", action: "create", content }], agent, "one");
    const p = await skills.manage([{ name: "fixture", action: "patch", old_string: "private", new_string: "isolated" }, { name: "fixture", action: "write_file", file_path: "references/check.md", file_content: "Check the fixture." }], review, "one", true);
    expect(p.staged).toBe(true);
    expect((await skills.view("fixture", null, "two")).content).toBe(content);
    await skills.manage([{ name: "fixture", action: "patch", old_string: "private", new_string: "temporary" }], agent, "two");
    expect(await skills.resolvePending(p.pending_id!, true)).toMatchObject({ ok: false, message: expect.stringContaining("Conflict") });
    expect((await skills.view("fixture", null, null)).content).toContain("temporary");
    expect((await skills.pending()).length).toBe(1);
    expect((await skills.resolvePending(p.pending_id!, false)).ok).toBe(true);
  });

  it("stages delete/archive and both curator transitions without changing active files", async () => {
    await skills.manage([{ name: "fixture", action: "create", content }], agent, "one");
    const p = await skills.manage([{ name: "fixture", action: "delete" }], review, "one", true);
    expect(p.staged).toBe(true);
    expect((await skills.list())[0]?.state).toBe("active");
    await skills.resolvePending(p.pending_id!, false);
    const later = new SkillLibrary(statePaths(root), () => new Date("2026-12-22T00:00:00Z"));
    expect(await later.curate(14, 90, true)).toEqual(["Proposed: fixture → stale"]);
    expect((await later.list())[0]?.state).toBe("active");
    const pending = (await later.pending())[0]!;
    expect((await later.resolvePending(pending.id, true)).ok).toBe(true);
    expect((await later.list())[0]?.state).toBe("stale");
    await later.curate(14, 30, true);
    const archive = (await later.pending())[0]!;
    expect((await later.list())[0]?.state).toBe("stale");
    expect((await later.resolvePending(archive.id, true)).ok).toBe(true);
    expect((await later.list())[0]?.state).toBe("archived");
  });

  it("refuses rollback over an external file edit or later ledger change", async () => {
    await skills.manage([{ name: "fixture", action: "create", content }], agent, "one");
    const create = (await skills.ledger(null, 10))[0]!;
    await writeFile(join(root, "skills", "fixture", "SKILL.md"), content.replace("private", "external"));
    expect((await skills.rollback(create.id, user)).message).toContain("Conflict");
    expect(await readFile(join(root, "skills", "fixture", "SKILL.md"), "utf8")).toContain("external");
  });

  it("memory proposals conflict even when a competing write only adds another entry", async () => {
    const p = await memory.write("memory", null, [{ action: "add", content: "Uses pnpm." }], { actor: review, stage: true });
    await memory.write("memory", null, [{ action: "add", content: "Uses Node 24." }], { actor: agent, stage: false });
    expect((await memory.resolvePending(p.result.pending_id!, true)).message).toContain("Conflict");
    expect(await memory.entries("memory")).toEqual(["Uses Node 24."]);
  });
});

describe("budget", () => {
  it("reserves maximum before starting, settles actual cost, preserves unknown reservations after restart", async () => {
    const path = join(root, "budget.json");
    const now = () => new Date("2026-10-22T12:00:00Z");
    const b = new ReviewBudget(path, now);
    expect(await Promise.all([b.reserve("a", .5, .75), b.reserve("b", .5, .75)])).toEqual([true, false]);
    const reloaded = new ReviewBudget(path, now);
    expect(await reloaded.reserve("c", .5, .75)).toBe(false);
    await reloaded.settle("a", .1);
    expect(await reloaded.reserve("c", .5, .75)).toBe(true);
    await reloaded.settle("c", null);
    expect(await reloaded.today()).toMatchObject({ charged: .6, reserved: 0 });
    const tomorrow = new ReviewBudget(path, () => new Date("2026-10-23T00:00:00Z"));
    expect(await tomorrow.reserve("d", .5, .75)).toBe(true);
  });
  it("does not reset a corrupt budget ledger to free spend", async () => {
    const path = join(root, "budget.json");
    await writeFile(path, "broken");
    await expect(new ReviewBudget(path).reserve("a", .5, 2)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("broken");
  });
});

describe("source, scope and retention", () => {
  it("legacy memory has unknown source; revisions keep stable ids and validity controls only future snapshots", async () => {
    await mkdir(join(root, "memory"));
    await writeFile(join(root, "memory", "MEMORY.md"), "Uses yarn.\n");
    const legacy = (await memory.views()).find(v => v.target === "memory")!.metadata![0]!;
    expect(legacy).toMatchObject({ source: "legacy", actor: null, createdAt: null });
    await memory.write("memory", null, [{ action: "patch", old_text: "yarn", content: "pnpm" }], { actor: review, stage: false });
    const current = (await memory.views()).find(v => v.target === "memory")!.metadata![0]!;
    expect(current.id).toBe(legacy.id);
    expect(current.revision).not.toBe(legacy.revision);
    expect(current.actor?.runId).toBe("review-1");
    const frozen = await memory.snapshot(null);
    await memory.setValidity("memory", null, current.id, current.revision, "reference", null);
    expect(await memory.snapshot(null)).not.toContain("pnpm");
    expect(frozen).toContain("pnpm");
    expect((await memory.setValidity("memory", null, current.id, legacy.revision, "active", null)).ok).toBe(false);
    await memory.setValidity("memory", null, current.id, current.revision, "active", "2020-01-01");
    expect(await memory.snapshot(null)).not.toContain("pnpm");
  });

  it("shares real worktrees but separates repository and synthetic workspace scope", async () => {
    const repo = join(root, "repo"); const other = join(root, "other"); const workspace = join(root, "workspace"); const worktree = join(root, "worktree");
    await Promise.all([mkdir(repo), mkdir(other), mkdir(workspace)]);
    for (const dir of [repo, other]) {
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: dir });
    }
    execFileSync("git", ["worktree", "add", "-qb", "fixture", worktree], { cwd: repo });
    await symlink(worktree, join(workspace, "app"));
    const base = await resolveProject(workspace);
    const one = await resolveProject(repo); const two = await resolveProject(join(workspace, "app"));
    expect(base.scope).toBe("workspace"); expect(one.scope).toBe("repo"); expect(two.key).toBe(one.key);
    expect((await resolveProject(other)).key).not.toBe(one.key); expect(base.key).not.toBe(one.key);
    expect((await resolveProjectWithin(base, "app")).key).toBe(one.key);
    await expect(resolveProjectWithin(base, "../other")).rejects.toThrow("inside");
  });

  it("accepts workspace aliases without accepting unrelated repositories", async () => {
    const workspace = join(root, "workspace"), repo = join(root, "repository"), alias = join(root, "workspace-alias");
    await mkdir(workspace); await mkdir(repo);
    execFileSync("git", ["init", "-q", repo]);
    await symlink(repo, join(workspace, "app"));
    await symlink(workspace, alias);
    const base = await resolveProject(workspace);
    expect((await resolveProjectWithin(base, join(alias, "app"))).key).toBe((await resolveProject(repo)).key);
    await expect(resolveProjectWithin(base, repo)).rejects.toThrow("inside");
  });

  it("publishes an opt-in readonly catalog, no duplicate native installs, and removes it when disabled", async () => {
    let enabled = false;
    const exporter = new LearnedCatalog(root, skills, () => enabled);
    await skills.manage([{ name: "fixture", action: "create", content }], review, "one");
    await exporter.publish(); await expect(access(exporter.path)).rejects.toThrow();
    enabled = true; await exporter.publish();
    const data = JSON.parse(await readFile(exporter.path, "utf8"));
    expect(data).toMatchObject({ schemaVersion: 1, owner: "learning-loop", skills: [{ id: "learning-loop:host:fixture", readOnly: true, source: { kind: "learned", agentId: "fixture-agent", runId: "review-1" } }] });
    expect(data.skills[0].content).toBe(content);
    expect(JSON.stringify(data)).not.toContain(root);
    enabled = false; await exporter.publish(); await expect(access(exporter.path)).rejects.toThrow();
  });

  it("scopes search before limiting, prunes indexed copies while retaining cursors, keeps legacy schema unchanged", async () => {
    const index = new SessionIndex(join(root, "sessions.db"));
    try {
      for (const [agentId, scopeKey] of [["a", "repo-a"], ["b", "repo-b"]]) {
        index.upsertSession({ agentId: agentId!, scopeKey, title: null, provider: "codex", cwd: root, archived: false, createdAt: "2026-01-01", updatedAt: "2026-10-22" });
        index.applyPage(agentId!, "epoch", [{ seq: 1, at: "2026-10-22", role: "user", text: "deploy fixture" }, { seq: 2, at: "2026-01-01", role: "assistant", text: "old fixture" }], 2, false);
      }
      expect(index.search("fixture", { limit: 1, scopeKey: "repo-b" })[0]?.session.agentId).toBe("b");
      expect(index.recent(10, [], "repo-a").map(s => s.agentId)).toEqual(["a"]);
      expect(index.prune(90, Date.parse("2026-10-22"))).toBe(2);
      expect(index.syncState("a")).toEqual({ epoch: "epoch", lastSeq: 2 });
      expect(index.window("a", null, 10)).toHaveLength(1);
      const props = TOOL_DEFINITIONS.find(t => t.name === "session_search")!.inputSchema.properties as object;
      const next = TOOL_DEFINITIONS_V2.find(t => t.name === "session_search")!.inputSchema.properties as object;
      expect(props).not.toHaveProperty("scope"); expect(next).toHaveProperty("scope");
    } finally { index.close(); }
  });
});

describe("concurrent validity and scoped tool reads", () => {
  it("blocks an old memory proposal after validity changed, and makes validity edits use CAS", async () => {
    await memory.write("memory", null, [{ action: "add", content: "Uses yarn." }], { actor: agent, stage: false });
    const before = await memory.inspect("memory", null);
    const entry = before.metadata[0]!;
    const p = await memory.write("memory", null, [{ action: "patch", old_text: "yarn", content: "pnpm" }], { actor: review, stage: true });
    expect((await memory.setValidity("memory", null, entry.id, entry.revision, "archived", null)).ok).toBe(true);
    expect((await memory.resolvePending(p.result.pending_id!, true)).message).toContain("Conflict");
    expect((await memory.setValidity("memory", null, entry.id, entry.revision, "active", null)).message).toContain("Conflict");
    expect((await memory.inspect("memory", null)).revision).not.toBe(before.revision);
    expect(await memory.snapshot(null)).not.toContain("yarn");
  });

  it("rejects review writes against stale memory, then lets explicit v2 read refresh the revision", async () => {
    const initial = await memory.inspect("memory", null);
    const revisions = { "memory:host": initial.revision };
    await memory.write("memory", null, [{ action: "add", content: "Uses Node." }], { actor: user, stage: false });
    const deps: ToolDeps = { memory, skills, sessions: null, stage: () => false, onMemoryChange() {}, onSkillChange() {} };
    const context = { actor: review, reader: "review", project: null, selfAgentId: null, version: 2, memoryRevisions: revisions };
    expect((await callTool("memory", { target: "memory", action: "add", content: "Uses pnpm." }, context, deps)).isError).toBe(true);
    const read = JSON.parse((await callTool("memory", { target: "memory", action: "read" }, context, deps)).text);
    expect(read.entries).toEqual(["Uses Node."]);
    expect(revisions["memory:host"]).toBe(read.revision);
    expect((await callTool("memory", { target: "memory", action: "add", content: "Uses pnpm." }, context, deps)).isError).toBe(false);
  });

  it("can roll back changes in reverse order without clobbering later edits", async () => {
    await skills.manage([{ name: "fixture", action: "create", content }], agent, "one");
    const created = (await skills.ledger(null, 10))[0]!;
    await skills.manage([{ name: "fixture", action: "patch", old_string: "private", new_string: "isolated" }], agent, "one");
    const patched = (await skills.ledger(null, 10))[0]!;
    expect((await skills.rollback(created.id, user)).ok).toBe(false);
    expect((await skills.rollback(patched.id, user)).ok).toBe(true);
    expect((await skills.rollback(created.id, user)).ok).toBe(true);
    expect(await skills.list()).toEqual([]);
  });

  it("does not edit symlinked upstream skill resources", async () => {
    await skills.manage([{ name: "fixture", action: "create", content }], agent, "one");
    const external = join(root, "upstream"); await mkdir(external); await writeFile(join(external, "api.md"), "Original upstream");
    await symlink(external, join(root, "skills", "fixture", "references"));
    await expect(skills.manage([{ name: "fixture", action: "write_file", file_path: "references/api.md", file_content: "Mutated" }], user, null)).rejects.toThrow("symlinks");
    expect(await readFile(join(external, "api.md"), "utf8")).toBe("Original upstream");
  });

  it("keeps reference/due skills available for explicit view but out of future prompt indexes", async () => {
    await skills.manage([{ name: "fixture", action: "create", content }], agent, "one");
    const original = await skills.index(80);
    const revision = await skills.revision("fixture");
    expect((await skills.setValidity("fixture", revision, "reference", null)).ok).toBe(true);
    expect(await skills.index(80)).not.toContain("fixture");
    expect((await skills.view("fixture", null, "two")).success).toBe(true);
    expect(await skills.index(80)).not.toContain("fixture");
    expect(original).toContain("fixture");
    expect((await skills.setValidity("fixture", revision, "active", null)).ok).toBe(false);
    expect((await skills.setValidity("fixture", await skills.revision("fixture"), "active", "2020-01-01")).ok).toBe(true);
    expect(await skills.index(80)).not.toContain("fixture");
  });
});

it("does not approve a curator archive after the skill was used again", async () => {
  await skills.manage([{ name: "fixture", action: "create", content }], agent, "one");
  const later = new SkillLibrary(statePaths(root), () => new Date("2026-12-22T00:00:00Z"));
  await later.curate(14, 30, true);
  const proposal = (await later.pending())[0]!;
  await later.view("fixture", null, "new-reader");
  expect((await later.resolvePending(proposal.id, true)).message).toContain("used since");
  expect((await later.list())[0]?.state).toBe("active");
});


describe("native skills and the learned library", () => {
  it("keeps shipped v1/v2 catalogs byte-identical while new bindings describe library ownership", () => {
    // Captured from the deployed b6c63fc catalog: these prefixes belong to existing sessions.
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(digest(toolsForBinding("legacy-binding"))).toBe("763049a5c19b97f6679771aeb6947242710d6468462e658497ecf21b95b9d0a5");
    expect(digest(toolsForBinding("v2-existing"))).toBe("94861288e3d657f503a02355b34299f0e1be471faa509fa1a15378098370ceb0");
    const newer = toolsForBinding("v3-new");
    expect(newer.map(t => t.inputSchema)).toEqual(TOOL_DEFINITIONS_V2.map(t => t.inputSchema));
    for (const name of ["skills_list", "skill_view", "skill_manage"]) {
      expect(newer.find(t => t.name === name)?.description).toContain("provider's full skill catalog");
    }
  });

  it("reports a library-scoped miss without claiming an installed native skill is absent or changing it", async () => {
    const nativeDir = join(root, "native-repository", ".agents", "skills", "native-fixture");
    await mkdir(nativeDir, { recursive: true });
    const nativeContent = "---\nname: native-fixture\ndescription: A native-only fixture.\n---\nRead the native catalog path.\n";
    await writeFile(join(nativeDir, "SKILL.md"), nativeContent);
    const deps: ToolDeps = { memory, skills, sessions: null, stage: () => false, onMemoryChange() {}, onSkillChange() {} };
    for (const version of [2, 3]) {
      const context = { actor: agent, reader: "fixture", project: null, selfAgentId: null, version };
      const response = await callTool("skill_view", { name: "native-fixture" }, context, deps);
      expect(response.isError).toBe(true);
      expect(JSON.parse(response.text)).toMatchObject({ success: false, library: "learning-loop" });
      expect(JSON.parse(response.text).hint).toContain("does not mean a native skill is unavailable");
      expect(JSON.parse(response.text).hint).toContain("SKILL.md path advertised in its native catalog");
      const mutation = await callTool("skill_manage", { operations: [{ action: "patch", name: "native-fixture", old_string: "native", new_string: "changed" }] }, context, deps);
      expect(mutation.isError).toBe(true);
    }
    expect(await readFile(join(nativeDir, "SKILL.md"), "utf8")).toBe(nativeContent);
    expect(await skills.list()).toEqual([]);
  });
});
