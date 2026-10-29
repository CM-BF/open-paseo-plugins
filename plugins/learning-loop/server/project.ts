import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, resolve, relative, sep } from "node:path";
import type { ProjectRef } from "../shared/contracts";

function gitCommonDir(cwd: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, timeout: 5000, windowsHide: true },
      (error, stdout) => done(error ? null : stdout.trim() || null),
    );
  });
}

export function projectKeyOf(root: string): string {
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "root";
  return `${slug}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}`;
}

/**
 * The project a directory belongs to: the main checkout of its git repository (so every worktree
 * of one repo shares one project memory), else the directory itself.
 */
export async function resolveProject(cwd: string): Promise<ProjectRef> {
  let base = isAbsolute(cwd) ? cwd : resolve(cwd);
  try {
    base = await fs.realpath(base);
  } catch {
    // keep the given path
  }
  const common = await gitCommonDir(base);
  let root = base;
  if (common && basename(common) === ".git") root = dirname(common);
  else if (common) root = common.replace(/\/\.git\/?$/, "") || base;
  try {
    root = await fs.realpath(root);
  } catch {
    // keep the computed path
  }
  return { key: projectKeyOf(root), root, name: basename(root) || root, scope: common ? "repo" : "workspace" };
}

/** Caches resolveProject by cwd for the life of the process. */
export class ProjectResolver {
  private cache = new Map<string, Promise<ProjectRef>>();

  constructor(private readonly resolveFn: (cwd: string) => Promise<ProjectRef> = resolveProject) {}

  resolve(cwd: string): Promise<ProjectRef> {
    let hit = this.cache.get(cwd);
    if (!hit) {
      hit = this.resolveFn(cwd);
      this.cache.set(cwd, hit);
      hit.catch(() => this.cache.delete(cwd));
    }
    return hit;
  }
}

/** Selection stays inside the lexical workspace; symlinked worktrees resolve to their repo. */
export async function resolveProjectWithin(base: ProjectRef, path: string): Promise<ProjectRef> {
  let chosen = resolve(base.root, path);
  // The daemon canonicalizes cwd (e.g. /tmp → /private/tmp). Match an alias of the
  // workspace itself before resolving child symlinks, which may be mounted worktrees.
  const canonicalBase = await fs.realpath(base.root).catch(() => base.root);
  let ancestor = chosen;
  while (true) {
    if (await fs.realpath(ancestor).catch(() => null) === canonicalBase) {
      chosen = resolve(base.root, relative(ancestor, chosen));
      break;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const rel = relative(base.root, chosen);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Choose a repository inside the current workspace.");
  const project = await resolveProject(chosen);
  if (project.scope !== "repo") throw new Error("The selected path is not a Git repository.");
  return project;
}
