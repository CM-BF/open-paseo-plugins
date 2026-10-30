import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { discoveryRpc } from "../shared/contracts";

export type DiscoveredPlugin = z.infer<typeof discoveryRpc.output>[number];
type Source = DiscoveredPlugin["sources"][number];
export interface DiscoveryOptions {
  home: string;
  cliPath?: string;
  developmentRoot?: string;
}
export interface DiscoveryDependencies {
  run?: (command: string, args: string[]) => Promise<string>;
}

/** Desktop-managed daemons do not necessarily inherit a shell PATH containing paseo. */
export function resolvePaseoCli(
  options: {
    cliPath?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    exists?: (path: string) => boolean;
  } = {},
): string {
  const env = options.env ?? process.env;
  const configured =
    options.cliPath?.trim() || env.PASEO_CLI?.trim() || env.PASEO_BIN?.trim();
  if (configured) return configured;
  const bundled = "/Applications/Paseo.app/Contents/Resources/bin/paseo";
  if (
    (options.platform ?? process.platform) === "darwin" &&
    (options.exists ?? existsSync)(bundled)
  )
    return bundled;
  return "paseo";
}
const execute = promisify(execFile);
const MAX_METADATA_FILES = 60;
const MAX_METADATA_BYTES = 96 * 1024;
const MAX_SCAN_ENTRIES = 1800;
const pluginSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().max(300).optional(),
    path: z.string().max(4000),
    installation: z
      .object({
        identity: z
          .object({ kind: z.string(), remote: z.string().optional() })
          .passthrough(),
        currentRevision: z.string().optional(),
      })
      .optional(),
    source: z.string().optional(),
    remote: z.string().optional(),
    commit: z.string().optional(),
  })
  .passthrough();

async function defaultRun(command: string, args: string[]): Promise<string> {
  const result = await execute(command, args, {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout;
}

/** Only recognized GitHub repository coordinates become watch candidates. */
function repository(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 500) return;
  const text = value.trim().replace(/^git@github\.com:/, "https://github.com/");
  const match =
    /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      text,
    );
  if (
    !match ||
    match[1] === "." ||
    match[1] === ".." ||
    match[2] === "." ||
    match[2] === ".."
  )
    return;
  return `https://github.com/${match[1]}/${match[2]}`;
}
function revision(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}
function safePaths(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  return [
    ...new Set(
      values
        .filter(
          (path): path is string =>
            typeof path === "string" &&
            path.length > 0 &&
            path.length <= 500 &&
            !path.startsWith("/") &&
            !path.includes("\\") &&
            !path.split("/").includes("..") &&
            !/[\0\r\n]/.test(path),
        )
        .map((path) => path.replace(/^\.\//, "").replace(/\/$/, "")),
    ),
  ].slice(0, 20);
}

function metadataSources(value: unknown, file: string): Source[] {
  const found: Source[] = [];
  function visit(input: unknown, depth: number): void {
    if (depth > 5 || found.length >= 100) return;
    if (Array.isArray(input)) {
      input.slice(0, 50).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!input || typeof input !== "object") return;
    const object = input as Record<string, unknown>;
    const repo = repository(object.repository ?? object.url ?? object.remote);
    if (repo) {
      const baseline = revision(
        object.upstreamCommit ?? object.commit ?? object.revision,
      );
      const paths = safePaths(object.paths ?? object.subpath ?? object.path);
      const relationship: Source["relationship"] =
        object.relationship === "fork" ||
        object.relationship === "feature" ||
        object.relationship === "reference"
          ? object.relationship
          : file === "UPSTREAM.json"
            ? "fork"
            : "reference";
      found.push({
        repository: repo,
        baseline,
        paths,
        relationship,
        ref: typeof object.ref === "string" ? object.ref.slice(0, 200) : "",
        notes: `明确来源元数据：${file}。${baseline ? "基线来自该文件记录的上游 commit。" : "未记录已采用的完整上游 SHA；请确认基线后添加监控。"}${typeof object.notes === "string" ? ` 记录说明：${object.notes.slice(0, 3000)}` : ""}`,
      });
    }
    for (const key of [
      "upstream",
      "source",
      "sources",
      "references",
      "skills",
      "entries",
      "items",
    ])
      visit(object[key], depth + 1);
  }
  visit(value, 0);
  return found;
}

async function collectMetadata(
  directory: string,
): Promise<{ files: string[]; limited: boolean }> {
  const files: string[] = [];
  let scanned = 0;
  let limited = false;
  for (const name of ["UPSTREAM.json", "SOURCE.json"]) {
    try {
      const stat = await lstat(join(directory, name));
      if (stat.isFile() && !stat.isSymbolicLink()) files.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") limited = true;
    }
  }
  const queue: Array<{ path: string; depth: number }> = [
    { path: "catalog", depth: 0 },
  ];
  while (
    queue.length &&
    files.length < MAX_METADATA_FILES &&
    scanned < MAX_SCAN_ENTRIES
  ) {
    const current = queue.shift()!;
    let entries;
    try {
      const stat = await lstat(join(directory, current.path));
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      entries = await readdir(join(directory, current.path), {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") limited = true;
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      scanned++;
      if (scanned > MAX_SCAN_ENTRIES || files.length >= MAX_METADATA_FILES) {
        limited = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const path = `${current.path}/${entry.name}`;
      if (
        entry.isFile() &&
        ["SOURCE.json", "UPSTREAM.json", "catalog.json"].includes(entry.name)
      )
        files.push(path);
      else if (
        entry.isDirectory() &&
        current.depth < 7 &&
        !["node_modules", ".git", "vendor"].includes(entry.name)
      )
        queue.push({ path, depth: current.depth + 1 });
    }
  }
  return { files, limited: limited || queue.length > 0 };
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function editableTarget(
  directory: string,
  home: string,
  run: NonNullable<DiscoveryDependencies["run"]>,
): Promise<string | undefined> {
  try {
    const actual = await realpath(directory);
    const actualHome = await realpath(home).catch(() => resolve(home));
    // Installed managed snapshots are deployment artifacts, even if they contain a .git directory.
    if (
      [join(actualHome, "plugins"), join(actualHome, "local-plugins")].some(
        (root) => within(root, actual),
      )
    )
      return;
    const root = (
      await run("git", ["-C", actual, "rev-parse", "--show-toplevel"])
    ).trim();
    if (!root || !within(await realpath(root), actual)) return;
    if (
      (
        await run("git", ["-C", actual, "rev-parse", "--is-bare-repository"])
      ).trim() !== "false"
    )
      return;
    await access(actual, constants.W_OK);
    return actual;
  } catch {
    return;
  }
}

export async function discoverSources(
  options: DiscoveryOptions,
  dependencies: DiscoveryDependencies = {},
): Promise<DiscoveredPlugin[]> {
  if (!isAbsolute(options.home)) throw new Error("Paseo home 必须为绝对路径");
  const run = dependencies.run ?? defaultRun;
  const raw = await run(resolvePaseoCli({ cliPath: options.cliPath }), [
    "--home",
    options.home,
    "plugin",
    "ls",
    "--json",
  ]);
  const plugins: Array<
    z.infer<typeof pluginSchema> & {
      developmentPath?: string;
      installed?: boolean;
    }
  > = z
    .array(pluginSchema)
    .max(300)
    .parse(JSON.parse(raw))
    .map((plugin) => ({ ...plugin, installed: true }));
  if (options.developmentRoot) {
    if (!isAbsolute(options.developmentRoot))
      throw new Error("开发仓库路径必须为绝对路径");
    const root = await realpath(options.developmentRoot);
    const directory = join(root, "plugins");
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("开发仓库 plugins 必须为真实目录");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries
      .filter((item) => item.isDirectory() && !item.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 100)) {
      const path = join(directory, entry.name);
      if (!within(root, await realpath(path))) continue;
      try {
        const manifestPath = join(path, "paseo-plugin.json");
        const manifestStat = await lstat(manifestPath);
        if (
          !manifestStat.isFile() ||
          manifestStat.isSymbolicLink() ||
          manifestStat.size > MAX_METADATA_BYTES
        )
          continue;
        const manifest = z
          .object({
            id: z.string().min(1).max(200),
            name: z.string().max(300).optional(),
          })
          .parse(JSON.parse(await readFile(manifestPath, "utf8")));
        const installed = plugins.find((plugin) => plugin.id === manifest.id);
        if (installed) installed.developmentPath = path;
        else
          plugins.push({
            ...manifest,
            path,
            developmentPath: path,
            installed: false,
          });
      } catch {
        /* A development folder without a valid manifest is not a plugin candidate. */
      }
    }
  }
  const result: DiscoveredPlugin[] = [];
  for (const plugin of plugins) {
    const notes: string[] = [];
    const sources: Source[] = [];
    const installedPath = plugin.path;
    if (!isAbsolute(installedPath)) {
      result.push({
        id: plugin.id,
        name: plugin.name ?? plugin.id,
        installedPath,
        sources: [],
        note: "安装目录不是绝对路径，未扫描；来源未知。",
      });
      continue;
    }
    const identity = plugin.installation?.identity;
    const installedRepository = repository(
      identity?.kind === "git"
        ? identity.remote
        : plugin.source === "git"
          ? plugin.remote
          : undefined,
    );
    if (installedRepository)
      sources.push({
        repository: installedRepository,
        ref: "",
        baseline: revision(
          plugin.installation?.currentRevision ?? plugin.commit,
        ),
        paths: [],
        relationship: "fork",
        notes:
          "来源为 Paseo 已安装的 Git 插件。其直接版本更新已有原生 plugin update；本插件可用于管理适配任务。",
      });
    if (plugin.installed === false)
      notes.push("开发仓库中的插件候选，当前未安装。");
    const scanRoots = [
      ...new Set(
        [installedPath, plugin.developmentPath].filter(
          (path): path is string => !!path,
        ),
      ),
    ];
    for (const scanRoot of scanRoots) {
      const scan = await collectMetadata(scanRoot);
      if (scan.limited)
        notes.push("来源扫描达到数量/深度边界或部分目录不可读。");
      for (const file of scan.files) {
        try {
          const stat = await lstat(join(scanRoot, file));
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > MAX_METADATA_BYTES
          ) {
            notes.push(`${file} 超过大小上限或不是普通文件，已跳过。`);
            continue;
          }
          const value = JSON.parse(
            await readFile(join(scanRoot, file), "utf8"),
          );
          sources.push(...metadataSources(value, file));
        } catch {
          notes.push(`${file} 无法解析；请人工检查来源元数据。`);
        }
      }
    }
    const targetPath = plugin.developmentPath
      ? await editableTarget(plugin.developmentPath, options.home, run)
      : identity?.kind === "git" || identity?.kind === "npm"
        ? undefined
        : await editableTarget(installedPath, options.home, run);
    if (targetPath) {
      try {
        const remotes = await run("git", ["-C", targetPath, "remote", "-v"]);
        for (const line of remotes.split("\n")) {
          const match = /^(origin|upstream)\s+(\S+)\s+\(fetch\)$/.exec(line);
          const repo = match ? repository(match[2]) : undefined;
          if (
            !match ||
            !repo ||
            sources.some((source) => source.repository === repo)
          )
            continue;
          sources.push({
            repository: repo,
            ref: "",
            paths: [],
            relationship: match[1] === "upstream" ? "fork" : "reference",
            notes: `Git ${match[1]} remote 候选；不是已确认的参考来源，已采用的上游 commit 未知。请确认后选择基线，未使用本地 HEAD 代替。`,
          });
        }
      } catch {
        notes.push("无法读取 Git remote 候选。");
      }
    } else
      notes.push(
        "安装目录未证明是可编辑开发 checkout；请选择开发仓库路径后创建监控。",
      );
    const unique = [
      ...new Map(
        sources.map((source) => [
          `${source.repository}\0${source.ref}\0${source.baseline ?? ""}\0${source.paths.join("\0")}`,
          source,
        ]),
      ).values(),
    ].slice(0, 100);
    if (!unique.length)
      notes.push("未发现明确来源元数据；请手动添加，未从 README 猜测来源。");
    result.push({
      id: plugin.id,
      name: plugin.name ?? plugin.id,
      installedPath,
      targetPath,
      sources: unique,
      note: notes.join(" "),
    });
  }
  return discoveryRpc.output.parse(result);
}
