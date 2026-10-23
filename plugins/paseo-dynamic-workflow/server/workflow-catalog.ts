import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BUILTIN_WORKFLOWS } from "./builtin-workflows";
import { paseoHome } from "./paths";
import { parseWorkflowScript } from "./script-parse";

const execFileAsync = promisify(execFile);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BUILTIN_PREFIX = "builtin.";

export interface NamedWorkflow {
  script: string;
  /** The file it came from; null for a workflow that ships with the plugin. */
  path: string | null;
}

export interface CatalogEntry {
  name: string;
  description: string;
  whenToUse?: string;
  /** "built-in" or the file it was read from. */
  source: string;
}

export class UnknownWorkflowError extends Error {}

export function isWorkflowName(name: string): boolean {
  return NAME.test(name);
}

/** Saved workflows: the caller's directory and git root, then ~/.paseo and ~/.claude. */
export async function workflowDirs(cwd: string): Promise<string[]> {
  const roots = [cwd];
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5000 });
    const top = stdout.trim();
    if (top && top !== cwd) roots.push(top);
  } catch {
    // Not a git checkout.
  }
  const dirs: string[] = [];
  for (const root of roots) dirs.push(join(root, ".paseo", "workflows"), join(root, ".claude", "workflows"));
  dirs.push(join(paseoHome(), "workflows"), join(homedir(), ".claude", "workflows"));
  return [...new Set(dirs)];
}

/** Saved files win over built-ins of the same name, so a user can replace a built-in; `builtin.<name>` skips them. */
export async function findNamedWorkflow(name: string, dirs: string[]): Promise<NamedWorkflow> {
  if (name.startsWith(BUILTIN_PREFIX)) {
    const bare = name.slice(BUILTIN_PREFIX.length);
    if (Object.hasOwn(BUILTIN_WORKFLOWS, bare)) return { script: BUILTIN_WORKFLOWS[bare]!, path: null };
    throw new UnknownWorkflowError(`There is no built-in workflow "${bare}". Built-ins: ${Object.keys(BUILTIN_WORKFLOWS).sort().join(", ")}`);
  }
  for (const dir of dirs) {
    const path = join(dir, `${name}.js`);
    const script = await readFile(path, "utf8").catch(() => null);
    if (script !== null) return { script, path };
  }
  const builtin = Object.hasOwn(BUILTIN_WORKFLOWS, name) ? BUILTIN_WORKFLOWS[name] : undefined;
  if (builtin !== undefined) return { script: builtin, path: null };
  const available = (await listWorkflows(dirs)).map((entry) => entry.name);
  throw new UnknownWorkflowError(
    `Workflow "${name}" not found. Looked in ${dirs.join(", ")} and the built-in workflows. Available: ${available.length ? available.join(", ") : "(none)"}`,
  );
}

/** Every name findNamedWorkflow resolves, with the file or built-in that wins. */
export async function listWorkflows(dirs: string[]): Promise<CatalogEntry[]> {
  const entries = new Map<string, CatalogEntry>();
  for (const dir of dirs) {
    const isDir = await stat(dir).then((entry) => entry.isDirectory(), () => false);
    if (!isDir) continue;
    for (const file of (await readdir(dir).catch(() => [] as string[])).sort()) {
      const name = file.endsWith(".js") ? file.slice(0, -3) : "";
      if (!isWorkflowName(name) || entries.has(name)) continue;
      const path = join(dir, file);
      const script = await readFile(path, "utf8").catch(() => null);
      if (script !== null) entries.set(name, describe(name, script, path));
    }
  }
  for (const [name, script] of Object.entries(BUILTIN_WORKFLOWS)) {
    if (!entries.has(name)) entries.set(name, describe(name, script, "built-in"));
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function describe(name: string, script: string, source: string): CatalogEntry {
  try {
    const { meta } = parseWorkflowScript(script);
    return { name, description: meta.description, ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}), source };
  } catch (error) {
    return { name, description: `(does not parse: ${error instanceof Error ? error.message : String(error)})`, source };
  }
}

/** Markdown appended to the reference for one caller; `builtinDir` holds readable copies of the built-ins. */
export function catalogText(entries: CatalogEntry[], builtinDir?: string): string {
  if (entries.length === 0) return "## Named workflows available to you\n\nNone.";
  const lines = entries.map((entry) => {
    const where = entry.source === "built-in" ? (builtinDir ? `built-in, source ${join(builtinDir, `${entry.name}.js`)}` : "built-in") : entry.source;
    const when = entry.whenToUse ? ` When to use: ${entry.whenToUse}` : "";
    return `- \`${entry.name}\` (${where}): ${entry.description}${when}`;
  });
  return [
    "## Named workflows available to you",
    "",
    "Launch one with `workflow({ name, args })` or `paseo-workflow run --name <name> --args-json '...'`. A saved file of the same name replaces a built-in; `builtin.<name>` always runs the shipped one. Each built-in's header comment documents its `args`; read its source file below before the first launch.",
    "",
    ...lines,
  ].join("\n");
}
