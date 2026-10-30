import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CompanionStore } from './store';
import { planWorkDirectories } from './group-plan-workdir';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(){const root=await mkdtemp(join(tmpdir(),'cindy-workdir-'));roots.push(root);const store=new CompanionStore(join(root,'data'));await store.load();return{root,store,dirs:planWorkDirectories(store)};}
const git=async(args:readonly string[],cwd:string)=>(await promisify(execFile)('git',[...args],{cwd,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}})).stdout;
it('prepares an owned plain folder and reports only this step’s bounded file changes',async()=>{
 const {store,dirs}=await setup();const directory=await dirs.prepare('group','plan',null);expect(directory.workDir).toBe(await realpath(join(store.root,'bot-groups','group','files')));
 await writeFile(join(directory.workDir,'old.txt'),'before');const before=await dirs.snapshot(directory);await writeFile(join(directory.workDir,'new.txt'),'new content');
 expect(await dirs.artifacts(directory,before)).toEqual([{path:'new.txt',size:11}]);
 await expect(dirs.artifactPath(directory,'../outside')).rejects.toMatchObject({code:'UNSAFE_PATH'});
});
it('uses one deterministic git worktree per plan and preserves the user checkout through edits and new commits',async()=>{
 const {root,store}=await setup();const repo=join(root,'repo');await mkdir(repo);await git(['init'],repo);await writeFile(join(repo,'base.txt'),'base');await git(['add','base.txt'],repo);await git(['commit','-m','fixture'],repo);
 const dirs=planWorkDirectories(store,git);const directory=await dirs.prepare('group','plan1',repo);const again=await dirs.prepare('group','plan1',repo);
 expect(again).toEqual(directory);expect(directory.workDir).not.toBe(repo);expect(directory.branch).toBe('cindy/plan-plan1');const before=await dirs.snapshot(directory);
 await writeFile(join(directory.workDir,'result.txt'),'result');await git(['add','result.txt'],directory.workDir);await git(['commit','-m','result'],directory.workDir);
 expect(await dirs.artifacts(directory,before)).toEqual([{path:'result.txt',size:6}]);await expect(readFile(join(repo,'result.txt'))).rejects.toMatchObject({code:'ENOENT'});
 expect((await git(['status','--porcelain'],repo)).trim()).toBe('');
 await git(['checkout','-b','someone-else'],directory.workDir);await expect(dirs.validate(directory)).rejects.toMatchObject({code:'WORKTREE_OWNERSHIP_MISMATCH'});
});
it('never falls back to a git project checkout when worktree creation or detection is uncertain',async()=>{
 const {root,store}=await setup();const repo=join(root,'repo');await mkdir(join(repo,'.git'),{recursive:true});
 const unknown=planWorkDirectories(store,async()=>{throw new Error('cannot detect');});await expect(unknown.prepare('group','p',repo)).rejects.toMatchObject({code:'WORKDIR_UNAVAILABLE'});
 const missing=planWorkDirectories(store,async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});});await expect(missing.prepare('group','p',repo)).rejects.toMatchObject({code:'WORKDIR_UNAVAILABLE'});
});
it('rejects symlink escapes and replacement of the recorded working directory',async()=>{
 const {root,dirs}=await setup();const directory=await dirs.prepare('group','p',null);const outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,'private.txt'),'private');
 await symlink(outside,join(directory.workDir,'link'));await expect(dirs.artifactPath(directory,'link/private.txt')).rejects.toMatchObject({code:'UNSAFE_PATH'});
 await rm(directory.workDir,{recursive:true});await symlink(outside,directory.workDir);await expect(dirs.validate(directory)).rejects.toMatchObject({code:'WORKDIR_UNAVAILABLE'});
});
