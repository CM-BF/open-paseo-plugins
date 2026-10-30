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

async function listWorkspaceEntries(paseo: PaseoApi) {
  const workspaces: Awaited<
    ReturnType<PaseoApi["workspaces"]["list"]>
  >["entries"] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await paseo.workspaces.list({
      includeBackground: true,
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    workspaces.push(...page.entries);
    if (!page.pageInfo.hasMore) break;
    const next = page.pageInfo.nextCursor;
    if (!next || seen.has(next))
      throw new Error("工作区列表分页未完整返回，请稍后重试");
    seen.add(next);
    cursor = next;
  } while (true);
  return workspaces;
}

export async function environment(paseo: PaseoApi) {
  const [entries, projectList, available] = await Promise.all([
    listWorkspaceEntries(paseo),
    paseo.projects.list(),
    paseo.providers.listAvailable(),
  ]);
  if (available.error) throw new Error(available.error);
  const backgroundProjects = new Set(
    entries.filter((entry) => entry.background).map((entry) => entry.projectId),
  );
  const visibleProjects = new Set(
    entries.filter((entry) => !entry.background).map((entry) => entry.projectId),
  );
  return {
    workspaces: entries
      .filter((entry) => !entry.background && !entry.archivingAt)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        directory: entry.workspaceDirectory || entry.projectRootPath,
      })),
    // Empty projects remain selectable, but background automation must not
    // introduce otherwise hidden projects into the human workspace picker.
    projects: projectList.projects
      .filter(
        (project) =>
          !backgroundProjects.has(project.projectId) ||
          visibleProjects.has(project.projectId),
      )
      .map((project) => ({
        id: project.projectId,
        name: project.projectCustomName?.trim() || project.projectDisplayName,
        directory: project.projectRootPath,
      })),
    providers: available.providers
      .filter((item) => item.available)
      .map((item) => ({ id: item.provider, label: item.provider })),
  };
}
