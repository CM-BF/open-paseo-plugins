import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanionStore } from './store';
import { GroupPlans, type GroupPlanState } from './group-plans';
import type { GroupDriver, GroupLane } from './group-driver';
import type { PlanWorkDirectories } from './group-plan-workdir';

const roots:string[]=[];const managers:GroupPlans[]=[];
afterEach(async()=>{for(const manager of managers.splice(0))await manager.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function barrier<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return{promise,resolve};}
async function setup(){
  const root=await mkdtemp(join(tmpdir(),'cindy-work-plans-'));roots.push(root);const store=new CompanionStore(root);await store.load();
  const other=await store.create({name:'Designer'});const ids=['cindy',other.id];
  await store.transaction(state=>{state.groups={team:{id:'team',name:'Team',description:'',botIds:ids,replyMode:'all',revision:1,createdAt:1,updatedAt:1,messages:[],rounds:[],lanes:{},receipts:{},continueKeys:{}}};});
  const calls:Array<{lane:GroupLane;prompt:string;messageId:string}>=[];
  const driver:GroupDriver={ensure:vi.fn(async lane=>{
    const data=JSON.parse(await readFile(join(root,'state.json'),'utf8'));
    expect(data.groupPlans[lane.roundId].lanes[lane.botId].agentId).toBe(lane.agentId);return{workspaceId:'workspace'};
  }),reply:vi.fn(async(lane,input)=>{calls.push({lane,prompt:input.prompt,messageId:input.messageId});return`Done ${calls.length}`;}),stop:vi.fn(async()=>{}),archive:vi.fn(async()=>{})};
  const directory=join(root,'files');await mkdir(directory);
  const dirs:PlanWorkDirectories={prepare:vi.fn(async()=>({workDir:directory,branch:null})),validate:vi.fn(async()=>{}),snapshot:vi.fn(async()=>new Map()),artifacts:vi.fn(async()=>[]),artifactPath:vi.fn(async(_dir,name)=>join(directory,name))};
  const configFor=vi.fn(async(id:string)=>({provider:'codex/test',systemPrompt:`identity ${id}`,mcpServers:{memory:{botId:id}}}));
  const plans=new GroupPlans(store,{driver,configFor,workDirectories:dirs});managers.push(plans);
  const create=(extra:Record<string,unknown>={})=>plans.create('team',{operationId:'create',request:'Build and review',steps:[{botId:ids[0],task:'Draft'},{botId:ids[1],task:'Review'},{botId:ids[0],task:'Revise'}],...extra});
  const current=async()=>(await plans.list('team')).plans[0]!;
  const action=async(kind:'start'|'continue'|'retry'|'stop'|'dismiss'|'edit'|'note',extra:Record<string,unknown>={})=>{const p=await current();return plans.action(kind,{groupId:'team',planId:p.id,expectedRevision:p.revision,operationId:`${kind}-${p.revision}`,...extra});};
  const wait=async(status:string)=>{await vi.waitFor(async()=>expect((await current()).status).toBe(status));return current();};
  return{root,store,plans,driver,dirs,ids,calls,create,current,action,wait,configFor};
}
it('persists proposal and native intents, runs one step at a time, shares directory and reuses each bot × plan lane',async()=>{
  const t=await setup();const [a,b]=await Promise.all([t.create(),t.create()]);expect(a.plan.id).toBe(b.plan.id);expect(t.driver.ensure).not.toHaveBeenCalled();
  await t.action('start');let p=await t.wait('waiting');expect(p.currentStep).toBe(0);expect(t.calls).toHaveLength(1);
  await t.action('continue');p=await t.wait('waiting');expect(p.currentStep).toBe(1);expect(t.calls[1]!.prompt).toContain('Done 1');
  await t.action('continue');p=await t.wait('done');expect(p.steps.every(step=>step.status==='done')).toBe(true);
  expect(t.calls[0]!.lane.agentId).toBe(t.calls[2]!.lane.agentId);expect(t.calls[1]!.lane.agentId).not.toBe(t.calls[0]!.lane.agentId);
  expect(new Set(t.calls.map(call=>call.lane.cwd)).size).toBe(1);expect(t.dirs.prepare).toHaveBeenCalledTimes(1);
  expect(t.calls[1]!.lane.config.systemPrompt).toBe(`identity ${t.ids[1]}`);
  expect((await t.store.snapshot()).bindings).toEqual({});
});
it('deduplicates actions, rejects changed payloads and stale revisions, and limits reassign/remove to legal boundaries',async()=>{
  const t=await setup();await t.create();const p=await t.current();const input={groupId:'team',planId:p.id,expectedRevision:p.revision,operationId:'same'};
  await Promise.all([t.plans.action('start',input),t.plans.action('start',input)]);await t.wait('waiting');expect(t.calls).toHaveLength(1);
  await expect(t.plans.action('stop',input)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await expect(t.plans.action('continue',{...input,operationId:'new'})).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  await expect(t.action('edit',{action:'remove',position:1})).rejects.toMatchObject({code:'INVALID_PARAMS'});
  await expect(t.action('edit',{action:'reassign',position:0,botId:t.ids[1]})).rejects.toMatchObject({code:'INVALID_PARAMS'});
  await t.action('edit',{action:'reassign',position:1,botId:t.ids[0]});expect((await t.current()).steps[1]!.botId).toBe(t.ids[0]);
});
it('queues additions for the same step and publishes one final handoff only after all admitted notes run',async()=>{
  const t=await setup();const started=barrier<void>(),release=barrier<string>();let n=0;
  vi.mocked(t.driver.reply).mockImplementation(async(lane,input)=>{t.calls.push({lane,prompt:input.prompt,messageId:input.messageId});if(n++===0){started.resolve();return release.promise;}return'Final amended result';});
  await t.create({start:true});await started.promise;
  const note=await t.action('note',{text:'Also include tests'});expect(note.delivery).toBe('queued');release.resolve('Initial result');
  const p=await t.wait('waiting');expect(t.calls).toHaveLength(2);expect(t.calls[1]!.prompt).toContain('Also include tests');expect(t.calls[0]!.lane.agentId).toBe(t.calls[1]!.lane.agentId);
  const messages=(await t.store.snapshot()).groups!.team!.messages.filter(m=>m.authorKind==='bot');expect(messages.map(m=>m.content)).toEqual(['Final amended result']);expect(p.currentStep).toBe(0);
  await t.action('note',{text:'Make it shorter'});await t.wait('waiting');expect(t.calls).toHaveLength(3);expect(t.calls[2]!.prompt).toContain('already finished this step');
});
it('retains an answered result across artifact failure and retries publication without re-running native tools',async()=>{
  const t=await setup();vi.mocked(t.dirs.artifacts).mockRejectedValueOnce(Object.assign(new Error('disk'),{code:'ARTIFACT_UNAVAILABLE'}));
  await t.create({start:true});const p=await t.wait('waiting');expect(p.steps[0]!.status).toBe('failed');expect(t.calls).toHaveLength(1);
  await expect(t.action('edit',{action:'reassign',position:0,botId:t.ids[1]})).rejects.toMatchObject({code:'RESULT_PUBLICATION_PENDING'});
  await t.action('retry');await t.wait('waiting');expect(t.calls).toHaveLength(1);expect((await t.current()).steps[0]!.status).toBe('done');
});
it('failed execution requires an explicit retry with stable lane and new immutable input identity',async()=>{
  const t=await setup();vi.mocked(t.driver.reply).mockRejectedValueOnce(Object.assign(new Error('failed'),{code:'RUNTIME_ERROR'}));
  await t.create({start:true});const failed=await t.wait('waiting');expect(failed.steps[0]!.code).toBe('RUNTIME_ERROR');expect(t.driver.stop).toHaveBeenCalledTimes(1);
  await t.action('retry',{text:'Check what completed before continuing'});await t.wait('waiting');expect(t.driver.reply).toHaveBeenCalledTimes(2);
  const calls=vi.mocked(t.driver.reply).mock.calls;expect(calls[0]![0].agentId).toBe(calls[1]![0].agentId);expect(calls[0]![1].messageId).not.toBe(calls[1]![1].messageId);
  expect(calls[1]![1].prompt).toContain('Check what completed');
});
it('reconciles an unconfirmed creation with its original config before applying newer skills after real store reopen',async()=>{
 const t=await setup();const old={provider:'codex/test',systemPrompt:'identity old',skillMounts:[{directory:'/same/mount'}],__cindyNativeSkills:{token:'source-old',enabledCount:1,mounts:[{directory:'/same/mount'}]}};
 const next={...old,systemPrompt:'identity new',__cindyNativeSkills:{...old.__cindyNativeSkills,token:'source-new'}};
 t.configFor.mockResolvedValue(old as never);const calls:string[]=[];let original:GroupLane|undefined;
 vi.mocked(t.driver.ensure).mockImplementation(async lane=>{
  calls.push(`ensure:${(lane.config.__cindyNativeSkills as {token:string}).token}`);
  if(!original){original=structuredClone(lane);throw new Error('native created; ACK lost');}
  expect(lane.operationId).toBe(original.operationId);expect(lane.config).toEqual(original.config);return{workspaceId:'workspace'};
 });
 const configure=vi.fn(async(lane:GroupLane,config:Record<string,unknown>)=>{
  calls.push(`configure:${(config.__cindyNativeSkills as {token:string}).token}`);expect(lane.phase).toBe('ready');
  expect(Object.values((await new CompanionStore(t.root).snapshot()).groupPlans!)[0]!.lanes.cindy!.config).toEqual(old);
 });t.driver.configure=configure;
 await t.create({start:true});await t.wait('waiting');expect(t.driver.reply).not.toHaveBeenCalled();await t.plans.close();
 t.configFor.mockResolvedValue(next as never);const store=new CompanionStore(t.root),plans=new GroupPlans(store,{driver:t.driver,configFor:t.configFor,workDirectories:t.dirs});managers.push(plans);
 const p=(await plans.list('team')).plans[0]!;await plans.action('retry',{groupId:'team',planId:p.id,expectedRevision:p.revision,operationId:'recover-same-create'});
 await vi.waitFor(async()=>expect((await plans.list('team')).plans[0]!.steps[0]!.status).toBe('done'));
 expect(calls).toEqual(['ensure:source-old','ensure:source-old','configure:source-new']);expect(t.driver.reply).toHaveBeenCalledOnce();
 expect(vi.mocked(t.driver.reply).mock.calls[0]![0].config).toEqual(next);
 expect(Object.values((await new CompanionStore(t.root).snapshot()).groupPlans!)[0]!.lanes.cindy!.config).toEqual(next);
});
it('stop is quick, waits for admitted creation, suppresses late replies, and requires unknown stop reconciliation',async()=>{
  const t=await setup();const entered=barrier<void>(),release=barrier<{workspaceId:string}>();
  vi.mocked(t.driver.ensure).mockImplementation(async()=>{entered.resolve();return release.promise;});vi.mocked(t.driver.stop).mockRejectedValueOnce(new Error('not stopped'));
  await t.create({start:true});await entered.promise;const stopping=await t.action('stop');expect(stopping.plan.execution.state).toBe('stopping');release.resolve({workspaceId:'workspace'});
  await vi.waitFor(async()=>expect((await t.current()).execution.state).toBe('unknown'));expect(t.driver.reply).not.toHaveBeenCalled();
  await expect(t.action('retry')).rejects.toMatchObject({code:'PLAN_BUSY'});
  await t.action('stop');await t.wait('stopped');expect((await t.current()).execution.state).toBe('idle');
});
it('preserves waiting plans on reopen and marks uncertain active work failed after confirmed stop without replay',async()=>{
  const t=await setup();await t.create({start:true});await t.wait('waiting');await t.plans.close();
  const reopened=new GroupPlans(new CompanionStore(t.root),{driver:t.driver,configFor:t.configFor,workDirectories:t.dirs});managers.push(reopened);
  expect((await reopened.list('team')).plans[0]!.status).toBe('waiting');expect(t.calls).toHaveLength(1);
  await reopened.close();
  await t.store.transaction(state=>{const p=(state as GroupPlanState).groupPlans!;const first=Object.values(p)[0]!;first.view.status='running';first.view.execution={state:'running'};first.view.steps[0]!.status='running';});
  const recovered=new GroupPlans(new CompanionStore(t.root),{driver:t.driver,configFor:t.configFor,workDirectories:t.dirs});managers.push(recovered);
  const p=(await recovered.list('team')).plans[0]!;expect(p.status).toBe('waiting');expect(p.steps[0]!.status).toBe('failed');expect(p.execution.state).toBe('idle');expect(t.calls).toHaveLength(1);
});
it('autoContinue advances only completed steps and stops on a failure',async()=>{
  const t=await setup();await t.plans.settings('team',{expectedRevision:1,autoContinue:true});
  const original=vi.mocked(t.driver.reply).getMockImplementation()!;let n=0;vi.mocked(t.driver.reply).mockImplementation(async(...args)=>{if(n++===1)throw new Error('failed');return original(...args);});
  await t.create({start:true});const p=await t.wait('waiting');expect(p.currentStep).toBe(1);expect(p.steps[0]!.status).toBe('done');expect(p.steps[1]!.status).toBe('failed');expect(t.driver.reply).toHaveBeenCalledTimes(2);
});
it('persists exact work admission and stable cancellation across restart without interrupting another native turn',async()=>{
 const t=await setup();const {nativeLaneFixture}=await import('./testing/native-lane');const f=nativeLaneFixture();Object.assign(t.driver,{ensure:f.driver.ensure.bind(f.driver),reply:f.driver.reply.bind(f.driver),stop:f.driver.stop.bind(f.driver),archive:f.driver.archive.bind(f.driver)});
 f.sendIfIdle.mockImplementation(async()=>{f.patch({status:'running',activeTurn:{turnId:'owned-turn'}});f.event({type:'turn_started',turnId:'owned-turn',provider:'codex'});return{status:'accepted',turnId:'owned-turn'};});
 await t.create({start:true});await vi.waitFor(async()=>expect(Object.values((await new CompanionStore(t.root).snapshot()).groupPlans!)[0]!.attempts[0]!.dispatch?.phase).toBe('accepted'));
 await t.action('stop');await vi.waitFor(async()=>expect((await t.current()).execution).toMatchObject({state:'unknown',code:'GROUP_STOP_REQUIRES_NATIVE'}));
 const saved=Object.values((await t.store.snapshot()).groupPlans!)[0]!,receipt=saved.attempts[0]!.dispatch!;await t.plans.close();
 f.patch({status:'running',activeTurn:{turnId:'human'}});f.agent.cancelTurn.mockResolvedValue({status:'changed'});
 const recovered=new GroupPlans(new CompanionStore(t.root),{driver:f.driver,configFor:t.configFor,workDirectories:t.dirs});managers.push(recovered);
 const p=(await recovered.list('team')).plans[0]!;expect(p.execution.state).toBe('idle');expect(f.agent.cancelTurn.mock.calls.every(call=>(call as any[])[0].messageId===receipt.cancelMessageId&&(call as any[])[0].expectedTurnId==='owned-turn')).toBe(true);
 expect(f.agent.activeTurn).toEqual({turnId:'human'});expect(f.agent.interrupt).not.toHaveBeenCalled();expect(f.sendIfIdle).toHaveBeenCalledOnce();
});
it('distinguishes provider rejection from unknown work admission and never replays unknown on recovery',async()=>{
 const t=await setup();const {nativeLaneFixture}=await import('./testing/native-lane');const f=nativeLaneFixture();Object.assign(t.driver,{ensure:f.driver.ensure.bind(f.driver),reply:f.driver.reply.bind(f.driver),stop:f.driver.stop.bind(f.driver),archive:f.driver.archive.bind(f.driver)});
 f.sendIfIdle.mockResolvedValueOnce({status:'unavailable'} as never).mockRejectedValueOnce(new Error('lost ACK'));
 await t.create({start:true});let p=await t.wait('waiting');expect(p.execution).toEqual({state:'idle',code:'PROVIDER_ADMISSION_UNAVAILABLE'});expect(f.agent.cancelTurn).not.toHaveBeenCalled();
 await t.action('retry');await vi.waitFor(async()=>expect((await t.current()).execution).toEqual({state:'unknown',code:'ADMISSION_OUTCOME_UNKNOWN'}));await t.plans.close();
 const recovered=new GroupPlans(new CompanionStore(t.root),{driver:f.driver,configFor:t.configFor,workDirectories:t.dirs});managers.push(recovered);p=(await recovered.list('team')).plans[0]!;expect(p.execution).toEqual({state:'unknown',code:'ADMISSION_OUTCOME_UNKNOWN'});
 await expect(recovered.action('retry',{groupId:'team',planId:p.id,expectedRevision:p.revision,operationId:'unsafe-retry'})).rejects.toMatchObject({code:'PLAN_BUSY'});expect(f.sendIfIdle).toHaveBeenCalledTimes(2);expect(f.agent.interrupt).not.toHaveBeenCalled();
});
