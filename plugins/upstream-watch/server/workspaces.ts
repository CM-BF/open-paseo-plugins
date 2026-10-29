import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { realpath, readdir, stat } from "node:fs/promises";
type PaseoApi = PluginHandlerContext["paseo"];

function contains(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
  );
}

export async function validateTarget(
  target: string,
  workspace: string,
): Promise<void> {
  if (!isAbsolute(target) || !isAbsolute(workspace))
    throw new Error("插件目录与工作区必须是绝对路径");
  const [actualTarget, actualWorkspace] = await Promise.all([
    realpath(target),
    realpath(workspace),
  ]);
  if (!(await stat(actualTarget)).isDirectory())
    throw new Error("插件开发目录不存在或不是目录");
  if (contains(actualWorkspace, actualTarget)) return;
  // Synthetic workspaces intentionally mount their repositories as top-level symlinks.
  const children = await readdir(workspace, { withFileTypes: true });
  for (const entry of children
    .filter((item) => item.isSymbolicLink())
    .slice(0, 100)) {
    const mount = await realpath(resolve(workspace, entry.name)).catch(
      () => null,
    );
    if (mount && contains(mount, actualTarget)) return;
  }
  throw new Error(
    "请选择包含该插件开发目录的工作区；安装快照应先改为可编辑的源码目录",
  );
}

export async function environment(paseo: PaseoApi) {
  const providersPromise = paseo.providers.listAvailable();
  const workspaces: { id: string; name: string; directory: string }[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await paseo.workspaces.list({
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const entry of page.entries)
      workspaces.push({
        id: entry.id,
        name: entry.name,
        directory: entry.workspaceDirectory || entry.projectRootPath,
      });
    if (!page.pageInfo.hasMore) break;
    const next = page.pageInfo.nextCursor;
    if (!next || seen.has(next))
      throw new Error("工作区列表分页未完整返回，请稍后重试");
    seen.add(next);
    cursor = next;
  } while (true);
  const available = await providersPromise;
  if (available.error) throw new Error(available.error);
  return {
    workspaces,
    providers: available.providers
      .filter((item) => item.available)
      .map((item) => ({ id: item.provider, label: item.provider })),
  };
}
