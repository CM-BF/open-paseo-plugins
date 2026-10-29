import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { BotLinkedProject, BotProjectOption, LinkedProjectsSnapshot } from '../shared/linked-projects';
import type { Paseo } from './runtime';
import type { CompanionStore, SavedState } from './store';
import { botId, string, throwIpcError } from './errors';
import { linkedProjectDirectoryKey, readBotLinkedProjects, setBotLinkedProject } from './vendor/projects/botWorkbenchService';
import { extractDisplayName } from './vendor/projects/projectDisplayName';
import { normalizeWorkingDirForStorage } from './vendor/projects/workingDir';

const MAX_BYTES = 512 * 1024;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Identical upstream directory identity; the store and RPC are already host scoped. */
export const linkedProjectId = (project: Pick<BotLinkedProject, 'path' | 'deviceId'>) => hash(JSON.stringify([
  project.deviceId ?? null, project.deviceId ? project.path : linkedProjectDirectoryKey(project.path),
]));
export type ProjectAccess = (state: SavedState) => Promise<void>;
interface RegisteredProject { path: string; name?: string }

/** Only public metadata APIs. Never open/create a workspace to discover a directory. */
export async function registeredProjects(paseo: Paseo): Promise<RegisteredProject[]> {
  const registered = new Map<string, RegisteredProject>();
  let bytes = 0;
  const add = (path: string | undefined, name?: string) => {
    if (!path || !isAbsolute(path)) return;
    const key = linkedProjectDirectoryKey(path), item = { path, ...(name ? { name } : {}) };
    const old = registered.get(key);
    bytes += Buffer.byteLength(JSON.stringify(item)) - (old ? Buffer.byteLength(JSON.stringify(old)) : 0);
    if (bytes > MAX_BYTES) throwIpcError('PROJECT_CATALOG_TOO_LARGE', 'The project catalog is too large to display completely');
    registered.set(key, item);
  };
  const { projects } = await paseo.projects.list();
  if (Buffer.byteLength(JSON.stringify(projects)) > MAX_BYTES) throwIpcError('PROJECT_CATALOG_TOO_LARGE', 'The project catalog is too large to display completely');
  const observedProjects = new Set<string>(), visibleProjects = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    // Background provisioning also creates a normal project row. Read metadata for
    // every workspace so that a background-only root cannot leak through projects.list.
    const page = await paseo.workspaces.list({ includeBackground: true, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const workspace of page.entries) {
      observedProjects.add(workspace.projectId);
      if (workspace.background || workspace.internal || workspace.archivingAt) continue;
      visibleProjects.add(workspace.projectId);
      // Missing workspaceDirectory must not turn a worktree into its repository root.
      if (workspace.workspaceDirectory) add(workspace.workspaceDirectory, workspace.title ??
        (workspace.workspaceDirectory === workspace.projectRootPath ? workspace.projectCustomName ?? undefined : undefined));
    }
    if (!page.pageInfo.hasMore) break;
    const next = page.pageInfo.nextCursor;
    if (!next || cursors.has(next)) throwIpcError('PROJECT_CATALOG_INCOMPLETE', 'The workspace catalog did not advance; refresh it before saving');
    cursors.add(next); cursor = next;
  } while (true);
  const workspaces = [...registered.values()]; registered.clear(); bytes = 0;
  for (const project of projects) {
    if (!observedProjects.has(project.projectId) || visibleProjects.has(project.projectId)) add(project.projectRootPath, project.projectCustomName ?? undefined);
  }
  for (const workspace of workspaces) add(workspace.path, workspace.name);
  return [...registered.values()];
}

export class CompanionProjects {
  private readonly store: CompanionStore;
  constructor(store: CompanionStore) { this.store = store; }
  private path(id: string) { return join(this.store.root, 'bots', botId(id), 'workbench.json'); }
  private owner(state: SavedState, id: string, write = false) {
    if (!Object.hasOwn(state.profiles, id) || state.profileDeletions?.[id]) throwIpcError('NOT_FOUND', 'Companion not found');
    if (write && (!state.profiles[id].enabled || state.profiles[id].status !== 'active')) throwIpcError('PRECONDITION_FAILED', 'Teammate is not active');
  }
  private async revision(id: string) {
    const path = this.path(id); await this.store.safePath(path);
    try { return hash(await readFile(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return hash('missing-workbench'); throw error; }
  }
  private async snapshot(id: string, paseo: Paseo, access: () => Promise<void>): Promise<LinkedProjectsSnapshot> {
    await access();
    const revision = await this.revision(id), linked = await readBotLinkedProjects(this.store.root, id);
    const registered = await registeredProjects(paseo); await access();
    const options = new Map<string, BotProjectOption>();
    const names = new Map(registered.map(item => [linkedProjectDirectoryKey(item.path), item.name]));
    const available = async (path: string) => stat(path).then(value => value.isDirectory(), () => false);
    for (const project of linked) {
      const id = linkedProjectId(project);
      options.set(id, { id, name: '', path: project.path, ...(project.deviceId ? { deviceId: project.deviceId } : {}),
        linked: true, available: !project.deviceId && await available(project.path) });
    }
    for (const project of registered) {
      const id = linkedProjectId(project);
      if (!options.has(id) && await available(project.path)) options.set(id, { id, name: '', path: project.path, linked: false, available: true });
    }
    const values = [...options.values()], paths = values.map(item => normalizeWorkingDirForStorage(item.path) ?? item.path);
    const projects = values.map((item, index) => ({ ...item, name: (!item.deviceId && names.get(linkedProjectDirectoryKey(item.path))) || extractDisplayName(paths[index], paths).name }));
    await access();
    if (await this.revision(id) !== revision) throwIpcError('PRECONDITION_FAILED', 'Project links changed while reading; reload them');
    if (Buffer.byteLength(JSON.stringify(projects)) > MAX_BYTES) throwIpcError('PROJECT_CATALOG_TOO_LARGE', 'The project catalog is too large to display completely');
    return { projects, revision };
  }
  list(id: string, paseo: Paseo, access?: ProjectAccess): Promise<LinkedProjectsSnapshot> {
    botId(id);
    return this.store.withSnapshot(async state => {
      const guard = async () => { this.owner(state, id); await this.store.safePath(this.path(id)); await access?.(state); };
      return this.snapshot(id, paseo, guard);
    });
  }
  set(id: string, paseo: Paseo, args: Record<string, unknown>): Promise<LinkedProjectsSnapshot> {
    botId(id); const projectId = string(args.projectId, 'projectId', 64), expectedRevision = string(args.expectedRevision, 'expectedRevision', 64);
    if (typeof args.linked !== 'boolean') throwIpcError('INVALID_PARAMS', 'linked must be a boolean');
    const linked = args.linked;
    return this.store.withSnapshot(async state => {
      const access = async () => { this.owner(state, id, true); await this.store.safePath(this.path(id)); };
      const before = await this.snapshot(id, paseo, access);
      if (before.revision !== expectedRevision) throwIpcError('PRECONDITION_FAILED', 'Project links changed; reload before saving');
      const project = before.projects.find(item => item.id === projectId);
      if (!project || (linked && !project.linked && !project.available)) throwIpcError('NOT_FOUND', 'Project unavailable');
      const guard = async () => {
        await access();
        if (await this.revision(id) !== expectedRevision) throwIpcError('PRECONDITION_FAILED', 'Project links changed before saving');
      };
      await setBotLinkedProject(this.store.root, id, { path: project.path, ...(project.deviceId ? { deviceId: project.deviceId } : {}) }, linked, guard);
      return this.snapshot(id, paseo, access);
    });
  }
}
