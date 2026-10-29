import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { cindyDraft } from '../shared/cindy';
import { stateSchema, watchSchema } from '../shared/contracts';
import { reviewKey } from '../server/review-context';
import { prepareReviewPrompt } from '../server/review-preparation';
import type { TaskExecution } from '../server/tasks';
function fixture() {
  const baseline='a'.repeat(40),head='b'.repeat(40),localRevision='c'.repeat(40);
  const watch=watchSchema.parse({ ...cindyDraft(), id:randomUUID(), enabled:true, targetPath:'/tmp/fixture', provider:'codex/model', workspaceId:'wks_1234567890abcdef', baseline,
    createdAt:'now',updatedAt:'now',observation:{head,ref:'main',url:'https://github.com/makecindy/cindy',title:'head',date:'now',compareUrl:'compare',comparison:'ahead',commits:[],commitsTotal:1,files:[],filesTruncated:false,matchedPaths:[],hasUpdate:true,needsReview:false} });
  watch.review!.autoReview=true;
  const state=stateSchema.parse({version:1,watches:[watch],settings:{enabled:true,intervalHours:24}});
  const task:TaskExecution={id:randomUUID(),watchId:watch.id,head,localRevision,reviewKey:reviewKey(watch,localRevision),intent:'review',title:'review',targetPath:watch.targetPath,workspaceId:watch.workspaceId!,provider:watch.provider!,prompt:'Frozen read-only instructions',createdAt:'now',status:'preparing',idempotencyKey:'fixture',automatic:true,reviewSource:{repository:watch.repository,baseline}};
  const source={...task.reviewSource!,head,gitDir:'/tmp/private-cache.git'};
  return{state,task,source};
}
it('prepares exact frozen objects before yielding a prompt and does not require a clean worktree',async()=>{
  const f=fixture(),prepare=vi.fn(async()=>f.source);
  const prompt=await prepareReviewPrompt(f.task,{prepare,state:async()=>f.state,disposed:()=>false});
  expect(prepare).toHaveBeenCalledWith(f.task.reviewSource,f.task.head);
  expect(prompt).toContain(f.task.prompt);expect(prompt).toContain(f.source.gitDir);expect(prompt).toContain(f.task.head);
});
it.each(['pause','disable','delete','head','inventory','destination','disposed'] as const)('does not yield an agent prompt if %s changes during source preparation',async kind=>{
  const f=fixture();let release!:()=>void,disposed=false;
  let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
  const gate=new Promise<void>(r=>{release=r;});
  const prepared=prepareReviewPrompt(f.task,{prepare:async()=>{entered();await gate;return f.source;},state:async()=>f.state,disposed:()=>disposed});
  await started;
  const watch=f.state.watches[0]!;
  if(kind==='pause')f.state.settings.enabled=false;
  if(kind==='disable')watch.enabled=false;
  if(kind==='delete')f.state.watches=[];
  if(kind==='head')watch.observation!.head='d'.repeat(40);
  if(kind==='inventory')watch.review!.features[0]!.notes='changed';
  if(kind==='destination')watch.workspaceId='wks_ffffffffffffffff';
  if(kind==='disposed')disposed=true;
  release();await expect(prepared).rejects.toThrow('准备期间已变化');
});
it('a failed exact-source fetch produces no prompt',async()=>{
  const f=fixture();await expect(prepareReviewPrompt(f.task,{prepare:async()=>{throw Error('offline');},state:async()=>f.state,disposed:()=>false})).rejects.toThrow('offline');
});

it('recovers legacy source metadata only from the same complete frozen review key',async()=>{
  const f=fixture();delete f.task.reviewSource;
  const prepare=vi.fn(async()=>f.source);
  expect(await prepareReviewPrompt(f.task,{prepare,state:async()=>f.state,disposed:()=>false})).toContain(f.source.gitDir);
  expect(prepare).toHaveBeenCalledWith({repository:f.source.repository,baseline:f.source.baseline},f.task.head);
  f.state.watches[0]!.baseline='d'.repeat(40);
  await expect(prepareReviewPrompt(f.task,{prepare,state:async()=>f.state,disposed:()=>false})).rejects.toThrow('范围');
  expect(prepare).toHaveBeenCalledTimes(1);
});
it('revalidates scope after workspace placement refresh and propagates an unavailable destination',async()=>{
  const f=fixture();
  await expect(prepareReviewPrompt(f.task,{prepare:async()=>f.source,state:async()=>f.state,disposed:()=>false,placement:async()=>{f.state.watches[0]!.enabled=false;}})).rejects.toThrow('范围');
  f.state.watches[0]!.enabled=true;
  await expect(prepareReviewPrompt(f.task,{prepare:async()=>f.source,state:async()=>f.state,disposed:()=>false,placement:async()=>{throw Error('Workspace missing');}})).rejects.toThrow('Workspace missing');
});
