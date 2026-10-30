import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, realpath, stat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createBotGroupWorkDir, type WorkDirSnapshot } from './vendor/botGroupWorkDir';
import { throwIpcError } from './errors';
import type { CompanionStore } from './store';
import type { GroupPlanArtifact } from '../shared/group-plans';

export interface PlanDirectory { workDir: string; branch: string | null; repositoryRoot?: string }
export interface PlanWorkDirectories {
  prepare(groupId: string, planId: string, projectDir: string | null): Promise<PlanDirectory>;
  validate(directory: PlanDirectory): Promise<void>;
  snapshot(directory: PlanDirectory): Promise<WorkDirSnapshot>;
  artifacts(directory: PlanDirectory, before: WorkDirSnapshot): Promise<GroupPlanArtifact[]>;
  artifactPath(directory: PlanDirectory, path: string): Promise<string>;
}
type Git = (args: readonly string[], cwd: string) => Promise<string>;
/** Read-only host directory picker; never lists files or follows child symbolic links. */
export async function browsePlanDirectories(input?:string){
  if(input!==undefined&&(!isAbsolute(input)||input.includes('\0')||input.length>4096))throwIpcError('INVALID_PARAMS','Invalid directory path');
  let path:string;
  try{path=await realpath(input??homedir());if(!(await stat(path)).isDirectory())throwIpcError('NOT_A_DIRECTORY','The path is not a directory');}
  catch(error){const code=(error as NodeJS.ErrnoException).code;if(code==='ENOENT')throwIpcError('NOT_FOUND','Directory not found');if(code==='EACCES'||code==='EPERM')throwIpcError('PERMISSION_DENIED','Cannot read this directory');throw error;}
  let entries;
  try{entries=await readdir(path,{withFileTypes:true});}catch(error){const code=(error as NodeJS.ErrnoException).code;if(code==='EACCES'||code==='EPERM')throwIpcError('PERMISSION_DENIED','Cannot read this directory');throw error;}
  const folders=entries.filter(entry=>entry.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name));
  const parent=resolve(path,'..');
  return{path,parent:parent===path?null:parent,directories:folders.slice(0,100).map(entry=>({name:entry.name,path:join(path,entry.name)})),...(folders.length>100?{truncated:true}: {})};
}
const gitCommand: Git = async (args, cwd) => (await promisify(execFile)('git', [...args], {
  cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
})).stdout;
/** Original directory/file rules; worktree allocation has a deterministic ownership identity. */
export function planWorkDirectories(store: CompanionStore, git: Git = gitCommand): PlanWorkDirectories {
  const worktrees = join(store.root, 'group-worktrees');
  const make = (planId: string) => createBotGroupWorkDir({
    ownerRoot: () => store.root, git,
    detectRepo: async cwd => {
      try { return { gitInstalled: true, isGitRepo: (await git(['rev-parse', '--is-inside-work-tree'], cwd)).trim() === 'true' }; }
      catch (error) {
        const e = error as { code?: string | number; stderr?: string };
        if (e.code === 'ENOENT') return { gitInstalled: false, isGitRepo: false };
        if (e.stderr?.includes('not a git repository')) return { gitInstalled: true, isGitRepo: false };
        throw error;
      }
    },
    prepareWorktree: async project => {
      const root = await realpath((await git(['rev-parse', '--show-toplevel'], project)).trim());
      await store.safePath(join(worktrees, planId)); await mkdir(worktrees, { recursive: true });
      const workingDir = join(await realpath(worktrees), planId); const branch = `cindy/plan-${planId}`;
      const inspect = async () => {
        const records = (await git(['worktree', 'list', '--porcelain', '-z'], root)).split('\0\0').filter(Boolean)
          .map(record => Object.fromEntries(record.split('\0').filter(Boolean).map(line => { const i = line.indexOf(' '); return [line.slice(0,i), line.slice(i+1)]; })));
        const found = records.find(record => record.worktree === workingDir);
        if (found && found.branch !== `refs/heads/${branch}`) throwIpcError('WORKTREE_OWNERSHIP_MISMATCH', 'The plan worktree has a different branch');
        return Boolean(found);
      };
      if (!await inspect()) {
        try { await lstat(workingDir); throwIpcError('WORKTREE_OWNERSHIP_MISMATCH', 'The plan worktree path is already occupied'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        try { await git(['worktree', 'add', '-b', branch, workingDir, 'HEAD'], root); }
        catch { if (!await inspect()) throwIpcError('WORKTREE_OUTCOME_UNKNOWN', 'Worktree creation was not confirmed; retry checks the same plan directory'); }
      }
      if (!await inspect()) throwIpcError('WORKTREE_OUTCOME_UNKNOWN', 'Worktree creation was not confirmed');
      return { ok: true, sessionId: '', workingDir, branch };
    },
    // Group deletion must retain worktrees and explicitly move owned plain folders to trash.
    trashItem: async () => { throwIpcError('UNSUPPORTED', 'Trash integration is not connected'); },
  });
  const validate = async (directory: PlanDirectory) => {
    if (!isAbsolute(directory.workDir) || !await stat(directory.workDir).then(s => s.isDirectory()).catch(() => false))
      throwIpcError('WORKDIR_UNAVAILABLE', 'The recorded plan directory is unavailable');
    if (await realpath(directory.workDir) !== resolve(directory.workDir))
      throwIpcError('WORKDIR_UNAVAILABLE', 'The recorded plan directory was replaced by a symbolic link');
    if (directory.branch) {
      if ((await git(['symbolic-ref', '--short', 'HEAD'], directory.workDir)).trim() !== directory.branch)
        throwIpcError('WORKTREE_OWNERSHIP_MISMATCH', 'The plan worktree branch changed');
      if (directory.repositoryRoot && await realpath((await git(['rev-parse', '--show-toplevel'], directory.repositoryRoot)).trim()) !== directory.repositoryRoot)
        throwIpcError('WORKTREE_OWNERSHIP_MISMATCH', 'The plan repository changed');
    }
  };
  const artifactPath = async (directory: PlanDirectory, name: string) => {
    await validate(directory);
    if (!name || isAbsolute(name) || name.includes('\0')) throwIpcError('UNSAFE_PATH', 'Invalid plan artifact path');
    const base = await realpath(directory.workDir); const lexical = resolve(base, name);
    if (!lexical.startsWith(base + sep)) throwIpcError('UNSAFE_PATH', 'Artifact leaves the plan directory');
    const actual = await realpath(lexical);
    if (!actual.startsWith(base + sep) || !(await stat(actual)).isFile()) throwIpcError('UNSAFE_PATH', 'Artifact leaves the plan directory');
    return actual;
  };
  return {
    async prepare(groupId, planId, projectDir) {
      if (!/^[a-zA-Z0-9_-]+$/.test(groupId) || !/^[a-zA-Z0-9_-]+$/.test(planId)) throwIpcError('INVALID_PARAMS', 'Invalid plan identity');
      if (projectDir !== null && !isAbsolute(projectDir)) throwIpcError('INVALID_PARAMS', 'Project directory must be absolute');
      await store.safePath(join(store.root, 'bot-groups', groupId, 'files'));
      const source = projectDir ? await realpath(projectDir) : null;
      const prepared = await make(planId).prepare({ groupId, projectDir: source });
      if (!prepared.ok) throwIpcError('WORKDIR_UNAVAILABLE', prepared.message);
      const directory: PlanDirectory = { workDir: await realpath(prepared.workDir), branch: prepared.branch,
        ...(prepared.branch && source ? { repositoryRoot: await realpath((await git(['rev-parse', '--show-toplevel'], source)).trim()) } : {}) };
      await validate(directory); return directory;
    }, validate, artifactPath,
    async snapshot(directory) { await validate(directory); return make('snapshot').snapshot(directory.workDir); },
    async artifacts(directory, before) {
      await validate(directory); const artifacts: GroupPlanArtifact[] = [];
      for (const name of await make('snapshot').changedFiles(directory.workDir, before)) {
        const full = await artifactPath(directory, name);
        artifacts.push({ path: relative(await realpath(directory.workDir), full).split(sep).join('/'), size: (await stat(full)).size });
      }
      return artifacts;
    },
  };
}
