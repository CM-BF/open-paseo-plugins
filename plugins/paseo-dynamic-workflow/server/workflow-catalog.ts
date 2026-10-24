import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BUILTIN_WORKFLOWS } from "./builtin-workflows";
import { paseoHome } from "./paths";
import { MAX_SCRIPT_CHARS, parseWorkflowScript } from "./script-parse";

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
  dirs.push(...userWorkflowDirs());
  return [...new Set(dirs)];
}

/** Only the user's own directories may replace a built-in: a checked-out repository cannot. */
function userWorkflowDirs(): string[] {
  return [join(paseoHome(), "workflows"), join(homedir(), ".claude", "workflows")];
}

function mayShadowBuiltin(dir: string): boolean {
  return userWorkflowDirs().includes(dir);
}

/** A regular file of script size; never a FIFO, device or directory that would block or flood a read. */
async function readScriptFile(path: string): Promise<string | null> {
  const entry = await stat(path).catch(() => null);
  if (!entry || !entry.isFile() || entry.size > MAX_SCRIPT_CHARS * 4) return null;
  return readFile(path, "utf8").catch(() => null);
}

/**
 * Saved files win over built-ins of the same name only from ~/.paseo/workflows or
 * ~/.claude/workflows; `builtin.<name>` always runs the shipped one.
 */
export async function findNamedWorkflow(name: string, dirs: string[]): Promise<NamedWorkflow> {
  if (name.startsWith(BUILTIN_PREFIX)) {
    const bare = name.slice(BUILTIN_PREFIX.length);
    if (Object.hasOwn(BUILTIN_WORKFLOWS, bare)) return { script: BUILTIN_WORKFLOWS[bare]!, path: null };
    throw new UnknownWorkflowError(`There is no built-in workflow "${bare}". Built-ins: ${Object.keys(BUILTIN_WORKFLOWS).sort().join(", ")}`);
  }
  const builtin = Object.hasOwn(BUILTIN_WORKFLOWS, name) ? BUILTIN_WORKFLOWS[name] : undefined;
  for (const dir of dirs) {
    if (builtin !== undefined && !mayShadowBuiltin(dir)) continue;
    const path = join(dir, `${name}.js`);
    const script = await readScriptFile(path);
    if (script !== null) return { script, path };
  }
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
      if (!isWorkflowName(name) || name.startsWith(BUILTIN_PREFIX) || entries.has(name)) continue;
      if (Object.hasOwn(BUILTIN_WORKFLOWS, name) && !mayShadowBuiltin(dir)) continue;
      const path = join(dir, file);
      const script = await readScriptFile(path);
      if (script !== null) entries.set(name, describe(name, script, path));
    }
  }
  for (const [name, script] of Object.entries(BUILTIN_WORKFLOWS)) {
    if (!entries.has(name)) entries.set(name, describe(name, script, "built-in"));
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Text from a saved file is the file author's: one line, no markup, clipped. */
function flat(text: string, max: number): string {
  const cleaned = text.replace(/[\p{Cc}\p{Cf}\p{Co}\u2028\u2029]+/gu, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function describe(name: string, script: string, source: string): CatalogEntry {
  try {
    const { meta } = parseWorkflowScript(script);
    const limit = source === "built-in" ? 2000 : 400;
    return { name, description: flat(meta.description, limit), ...(meta.whenToUse ? { whenToUse: flat(meta.whenToUse, limit) } : {}), source };
  } catch (error) {
    return { name, description: `(does not parse: ${flat(error instanceof Error ? error.message : String(error), 200)})`, source };
  }
}

/** Markdown appended to the reference for one caller; `builtinDir` holds read-only copies of the built-ins. */
export function catalogText(entries: CatalogEntry[], builtinDir?: string, note?: string): string {
  if (entries.length === 0) return "## Named workflows available to you\n\nNone.";
  const lines = entries.map((entry) => {
    const where = entry.source === "built-in" ? (builtinDir ? `built-in, read-only source ${join(builtinDir, `${entry.name}.js`)}` : "built-in") : `saved file ${entry.source}`;
    const when = entry.whenToUse ? ` When to use: ${entry.whenToUse}` : "";
    return `- \`${entry.name}\` (${where}): ${entry.description}${when}`;
  });
  return [
    "## Named workflows available to you",
    "",
    "Launch one with `workflow({ name, args })`, or from the CLI with the reference command's own path and `run --name <name> --args-json '...'`. A file of the same name in ~/.paseo/workflows or ~/.claude/workflows replaces a built-in (project directories cannot); `builtin.<name>` always runs the shipped one. Descriptions of saved files are their authors' text. Each built-in's header comment documents its `args`: read its source file below before the first launch.",
    ...(note ? ["", note] : []),
    "",
    ...lines,
  ].join("\n");
}
