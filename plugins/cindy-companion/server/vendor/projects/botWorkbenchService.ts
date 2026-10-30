/**
 * The original workbench file keeps linked project references and legacy Todo judgments.
 * Projects are context only; task responsibility lives in task-responsibility.v1.json.
 * Cloud handoff retains directory device identity and never opens another computer's paths.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BotLinkedProject } from '../../../shared/linked-projects';
import { isWindowsPathLike, normalizeWorkingDirForStorage } from './workingDir';


import { botProfileDir } from '../botProfileFolder';
import {
  LEGACY_MAX_DIRECTORIES,
  normalizeLegacyJudgments,
  type LegacyWorkbenchJudgment,
} from './botWorkbenchLegacy';

const WORKBENCH_FILE = 'workbench.json';

type StoredDirectory = BotLinkedProject;

interface StoredWorkbench {
  directories: StoredDirectory[];
  tasks: Record<string, LegacyWorkbenchJudgment>;
}

function normalizeDirectories(raw: unknown): StoredDirectory[] {
  const out: StoredDirectory[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (out.length >= LEGACY_MAX_DIRECTORIES) break;
    if (!entry || typeof entry !== 'object') continue;
    const dir = entry as { path?: unknown; addedAt?: unknown; deviceId?: unknown };
    const deviceId = typeof dir.deviceId === 'string' && dir.deviceId && dir.deviceId.length <= 200 ? dir.deviceId : undefined;
    // Another computer's path may use another platform's form; it is only carried, never opened here.
    const valid = typeof dir.path === 'string' && (deviceId ? !!dir.path.trim() && dir.path.length <= 4096 : path.isAbsolute(dir.path));
    const key = `${deviceId ?? ''}\0${String(dir.path)}`;
    if (!valid || seen.has(key)) continue;
    seen.add(key);
    out.push({ path: dir.path as string, addedAt: typeof dir.addedAt === 'string' ? dir.addedAt : new Date(0).toISOString(),
      ...(deviceId ? { deviceId } : {}) });
  }
  return out;
}

/** 读盘后的有界规整:丢掉畸形条目,不信任磁盘上的任何字段。 */
export function normalizeWorkbench(raw: unknown): StoredWorkbench | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as { directories?: unknown; tasks?: unknown };
  return { directories: normalizeDirectories(record.directories), tasks: normalizeLegacyJudgments(record.tasks) };
}

function workbenchPath(userDataDir: string, botId: string): string {
  return path.join(botProfileDir(userDataDir, botId), WORKBENCH_FILE);
}

/** Only a missing file is an empty workbench; an unreadable or damaged one throws. */
async function readStoredStrict(userDataDir: string, botId: string): Promise<StoredWorkbench> {
  let raw: string;
  try {
    raw = await fs.readFile(workbenchPath(userDataDir, botId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { directories: [], tasks: {} };
    throw error;
  }
  const stored = normalizeWorkbench(JSON.parse(raw));
  if (!stored) throw new Error('WORKBENCH_UNREADABLE');
  return stored;
}

async function writeStored(userDataDir: string, botId: string, stored: StoredWorkbench, guard?: () => Promise<void>): Promise<void> {
  const target = workbenchPath(userDataDir, botId);
  await guard?.();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await guard?.();
    await fs.writeFile(
      temp,
      `${JSON.stringify({ directories: stored.directories, tasks: stored.tasks }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    await guard?.();
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** 同一伙伴的读改写串行,并发的搬家合并互不覆盖。 */
const writeChains = new Map<string, Promise<unknown>>();
function mutate<T>(
  userDataDir: string,
  botId: string,
  change: (stored: StoredWorkbench) => { next: StoredWorkbench; result: T },
  guard?: () => Promise<void>,
): Promise<T> {
  const key = `${userDataDir}\0${botId}`;
  const run = (writeChains.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await guard?.();
      const stored = await readStoredStrict(userDataDir, botId);
      await guard?.();
      const { next, result } = change(stored);
      await writeStored(userDataDir, botId, next, guard);
      return result;
    });
  writeChains.set(key, run);
  // finally 派生的 promise 会继承 run 的 rejection 且无人接住:cleanup 照跑,rejection 在此吸收
  // (调用方已拿到原始 run 的失败)。
  void run.finally(() => {
    if (writeChains.get(key) === run) writeChains.delete(key);
  }).catch(() => undefined);
  return run;
}

/** Existing associations remain in the original file and travel with the companion. */
export async function readBotLinkedProjects(userDataDir: string, botId: string): Promise<BotLinkedProject[]> {
  return (await readStoredStrict(userDataDir, botId)).directories;
}

/** Links refer to individual directories, not the repository's sidebar grouping. */
export function linkedProjectDirectoryKey(directory: string): string {
  const normalized = normalizeWorkingDirForStorage(directory) ?? directory;
  return process.platform === 'win32' && isWindowsPathLike(normalized) ? normalized.toLowerCase() : normalized;
}

export async function setBotLinkedProject(
  userDataDir: string, botId: string, project: Pick<BotLinkedProject, 'path' | 'deviceId'>,
  linked: boolean, guard: () => Promise<void>,
): Promise<void> {
  if (!normalizeDirectories([project]).length) throw new Error('INVALID_PROJECT');
  await mutate(userDataDir, botId, stored => {
    const same = (entry: BotLinkedProject) => entry.deviceId === project.deviceId && (project.deviceId
      ? entry.path === project.path
      : linkedProjectDirectoryKey(entry.path) === linkedProjectDirectoryKey(project.path));
    const exists = stored.directories.some(same);
    if (linked && !exists && stored.directories.length >= LEGACY_MAX_DIRECTORIES) throw new Error('PROJECT_LIMIT');
    const directories = linked
      ? exists ? stored.directories : [...stored.directories, { ...project, addedAt: new Date().toISOString() }]
      : stored.directories.filter(entry => !same(entry));
    return { next: { ...stored, directories }, result: undefined };
  }, guard);
  // The caller publishes its host-scoped invalidation after this atomic save.
}
