import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanionStore } from './store';
import { GroupPlans } from './group-plans';
import { GroupPlanOrganizer } from './group-plan-organizer';
import type { GroupDriver } from './group-driver';
const roots:string[]=[];const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function barrier<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return{promise,resolve};}
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'cindy-organizer-'));roots.push(root);const store=new CompanionStore(root);await store.load();const other=await store.create({name:'Designer'});
 await store.transaction(state=>{state.groups={team:{id:'team',name:'Team',description:'',botIds:['cindy',other.id],replyMode:'all',revision:1,createdAt:1,updatedAt:1,messages:[],rounds:[],lanes:{},receipts:{},continueKeys:{}}};});
 const driver:GroupDriver={ensure:vi.fn(async()=>({workspaceId:'workspace'})),reply:vi.fn(async()=>JSON.stringify({needsPlan:true,steps:[{botId:'cindy',task:'Design'},{botId:other.id,task:'Review'}]})),stop:vi.fn(async()=>{}),archive:vi.fn(async()=>{})};
 const directory=join(root,'work');await mkdir(directory);const configFor=vi.fn(async()=>({provider:'codex/test',systemPrompt:'PRIVATE_IDENTITY',mcpServers:{memory:{secret:'private'}},providerOptions:{sandbox_mode:'workspace-write'}}));
 const plans=new GroupPlans(store,{driver,configFor,workDirectories:{prepare:async()=>({workDir:directory,branch:null}),validate:async()=>{},snapshot:async()=>new Map(),artifacts:async()=>[],artifactPath:async(_d,p)=>join(directory,p)}});
 const fallback=vi.fn(async()=>{});const organizer=new GroupPlanOrganizer(store,plans,{driver,configFor,fallback});cleanups.push(async()=>{await organizer.close();await plans.close();});
 return{root,store,driver,plans,organizer,fallback,other,configFor};
}
it('persists a planning request once, uses original strict JSON logic in an isolated utility lane, then commits one proposed card',async()=>{
 const t=await setup(),started=barrier<void>(),release=barrier<string>();vi.mocked(t.driver.reply).mockImplementation(async(lane,input)=>{expect(lane.config.systemPrompt).not.toContain('PRIVATE_IDENTITY');expect(lane.config.mcpServers).toEqual({});expect(lane.config.options).toMatchObject({sandbox_mode:'read-only'});expect(input.prompt).toContain('needsPlan');started.resolve();return release.promise;});
 const input={operationId:'request',request:'Please design and review a page'};const a=await t.organizer.create('team',input),b=await t.organizer.create('team',input);expect(a).toEqual(b);await started.promise;
 await expect(t.organizer.create('team',{...input,request:'changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 release.resolve(JSON.stringify({needsPlan:true,steps:[{botId:'cindy',task:'Design'},{botId:t.other.id,task:'Review'}]}));
 await vi.waitFor(async()=>expect((await t.organizer.list('team'))[0]!.status).toBe('complete'));
 const snapshot=await t.plans.list('team');expect(snapshot.plans).toHaveLength(1);expect(snapshot.plans[0]!.status).toBe('proposed');
 expect(t.driver.reply).toHaveBeenCalledTimes(1);expect((await t.store.snapshot()).groups!.team!.messages.filter(m=>m.authorKind==='user')).toHaveLength(1);
 expect(snapshot.plans[0]!.sourceMessageId).toBe((await t.organizer.list('team'))[0]!.sourceMessageId);expect(t.fallback).not.toHaveBeenCalled();
});
it('does not grant personal native skill mounts to the isolated organizer utility session',async()=>{
 const t=await setup();t.configFor.mockResolvedValue({provider:'codex/test',systemPrompt:'PRIVATE_IDENTITY',mcpServers:{memory:{secret:'private'}},providerOptions:{sandbox_mode:'workspace-write'},
  skillMounts:[{directory:'/private/companion-library'}],__cindyNativeSkills:{token:'personal-source',enabledCount:1,mounts:[{directory:'/private/companion-library'}]}} as never);
 await t.organizer.create('team',{operationId:'no-skills',request:'Arrange work'});
 await vi.waitFor(async()=>expect((await t.organizer.list('team'))[0]!.status).toBe('complete'));
 const lane=vi.mocked(t.driver.ensure).mock.calls[0]![0];expect(lane.config).not.toHaveProperty('skillMounts');expect(lane.config).not.toHaveProperty('__cindyNativeSkills');
 const stored=Object.values((await new CompanionStore(t.root).snapshot()).groupPlanRequests!)[0]!.lane!;
 expect(stored.config).not.toHaveProperty('skillMounts');expect(stored.config).not.toHaveProperty('__cindyNativeSkills');expect(stored.config.mcpServers).toEqual({});
});
it('written @steps skip organizer generation and start exactly the original relay order',async()=>{
 const t=await setup();const result=await t.organizer.create('team',{operationId:'written',request:'@Cindy 设计；@Designer 检查'});
 expect('plan'in result).toBe(true);await vi.waitFor(async()=>expect((await t.plans.list('team')).plans[0]!.status).toBe('waiting'));
 expect(await t.organizer.list('team')).toEqual([]);expect(vi.mocked(t.driver.ensure).mock.calls[0]![0].title).toContain('分工');
});
it('keeps the old proposal until a revised proposal commits and never treats malformed output as success',async()=>{
 const t=await setup();const old=await t.plans.create('team',{operationId:'old',request:'Old request',steps:[{botId:'cindy',task:'Draft'}]});
 const started=barrier<void>(),release=barrier<string>();vi.mocked(t.driver.reply).mockImplementation(async()=>{started.resolve();return release.promise;});
 await t.organizer.create('team',{operationId:'revise',request:'Add a review'},{planId:old.plan.id,expectedRevision:old.plan.revision});await started.promise;
 expect((await t.plans.list('team')).plans[0]!.status).toBe('proposed');release.resolve(JSON.stringify({needsPlan:true,steps:[{botId:'cindy',task:'Draft'},{botId:t.other.id,task:'Review'}]}));
 await vi.waitFor(async()=>expect((await t.organizer.list('team'))[0]!.status).toBe('complete'));
 expect((await t.plans.list('team')).plans.map(p=>p.status)).toEqual(['superseded','proposed']);
});
it('known invalid organizer output routes the same accepted request to ordinary discussion without re-running planning',async()=>{
 const t=await setup();vi.mocked(t.driver.reply).mockResolvedValue('not valid JSON');const input={operationId:'bad',request:'Discuss the problem'};
 await t.organizer.create('team',input);await vi.waitFor(()=>expect(t.fallback).toHaveBeenCalledTimes(1));
 const request=(await t.organizer.list('team'))[0]!;expect(request.status).toBe('failed');expect(t.fallback).toHaveBeenCalledWith('team',input.request,`plan-fallback:${request.id}`,request.sourceMessageId);
 await t.organizer.create('team',input);expect(t.driver.reply).toHaveBeenCalledTimes(1);expect((await t.plans.list('team')).plans).toEqual([]);
});
it('cancellation drains in-flight creation and unknown outcomes remain blocked until exact stop reconciliation',async()=>{
 const t=await setup(),started=barrier<void>(),release=barrier<{workspaceId:string}>();vi.mocked(t.driver.ensure).mockImplementation(async()=>{started.resolve();return release.promise;});vi.mocked(t.driver.stop).mockRejectedValueOnce(new Error('unknown'));
 await t.organizer.create('team',{operationId:'cancel',request:'Create a plan'});await started.promise;const request=(await t.organizer.list('team'))[0]!;
 await t.organizer.cancel('team',request.id);release.resolve({workspaceId:'workspace'});await vi.waitFor(async()=>expect((await t.organizer.list('team'))[0]!.code).toBe('STOP_NOT_CONFIRMED'));
 expect(t.driver.reply).not.toHaveBeenCalled();expect(t.fallback).not.toHaveBeenCalled();
 await expect(t.organizer.create('team',{operationId:'another',request:'Another plan'})).rejects.toMatchObject({code:'PLAN_OPEN'});
 await t.organizer.cancel('team',request.id);await vi.waitFor(async()=>expect((await t.organizer.list('team'))[0]!.code).toBe('USER_STOPPED'));
});
it('blocks explicit and written work while an organizer owns planning admission',async()=>{
 const t=await setup(),entered=barrier<void>();vi.mocked(t.driver.reply).mockImplementation(async(_lane,input)=>{entered.resolve();return new Promise((_yes,no)=>input.signal.addEventListener('abort',()=>no(new Error('stopped'))));});
 await t.organizer.create('team',{operationId:'planning',request:'Arrange this work'});await entered.promise;
 await expect(t.organizer.create('team',{operationId:'explicit',request:'Do this',steps:[{botId:'cindy',task:'Other'}],start:true})).rejects.toMatchObject({code:'PLAN_OPEN'});
 await expect(t.organizer.create('team',{operationId:'written',request:'@Cindy 设计；@Designer 检查'})).rejects.toMatchObject({code:'PLAN_OPEN'});
 expect(t.driver.ensure).toHaveBeenCalledTimes(1);
});
it('derives organizer membership inside admission after a competing member change',async()=>{
 const t=await setup(),real=t.store.transaction.bind(t.store);let intercepted=false;
 vi.spyOn(t.store,'transaction').mockImplementation(async run=>{
   if(!intercepted){intercepted=true;await real(state=>{state.groups!.team!.botIds=[t.other.id];});}
   return real(run);
 });
 // Initialize before the interception so the barrier targets request admission.
 await t.organizer.init();intercepted=false;
 await t.organizer.create('team',{operationId:'membership',request:'Arrange this work'});
 const saved=Object.values((await t.store.snapshot()).groupPlanRequests!)[0]!;
 expect(saved.input.members.map(m=>m.botId)).toEqual([t.other.id]);expect(saved.view.organizerBotId).toBe(t.other.id);
});
it('persists utility cleanup before creation and retries archive after publication without rerunning the organizer',async()=>{
 const t=await setup();vi.mocked(t.driver.ensure).mockImplementationOnce(async lane=>{const saved=(await t.store.snapshot()).groupPlanRequests![lane.roundId]!;expect(saved.cleanupPending).toBe(true);return{workspaceId:'utility'};});
 vi.mocked(t.driver.archive).mockRejectedValueOnce(new Error('temporary archive failure'));
 await t.organizer.create('team',{operationId:'cleanup',request:'Arrange this work'});
 await vi.waitFor(()=>expect(t.driver.archive).toHaveBeenCalledTimes(1));
 const saved=Object.values((await t.store.snapshot()).groupPlanRequests!)[0]!;expect(saved.view.status).toBe('complete');expect(saved.cleanupPending).toBe(true);await t.organizer.close();
 const reopened=new GroupPlanOrganizer(new CompanionStore(t.root),t.plans,{driver:t.driver,configFor:t.configFor,fallback:t.fallback});cleanups.push(()=>reopened.close());
 expect((await reopened.list('team'))[0]!.status).toBe('complete');expect(t.driver.reply).toHaveBeenCalledTimes(1);expect(t.driver.archive).toHaveBeenCalledTimes(2);
 expect((await new CompanionStore(t.root).snapshot()).groupPlanRequests![saved.view.id]!.cleanupPending).toBe(false);
});
it('keeps unsupported provider input unsent without ordinary-discussion fallback and exposes manual cleanup',async()=>{
 const t=await setup();const {nativeLaneFixture}=await import('./testing/native-lane');const f=nativeLaneFixture();Object.assign(t.driver,{ensure:f.driver.ensure.bind(f.driver),reply:f.driver.reply.bind(f.driver),stop:f.driver.stop.bind(f.driver),archive:f.driver.archive.bind(f.driver)});f.admission.mockResolvedValue({status:'unavailable'} as never);
 await t.organizer.create('team',{operationId:'unavailable',request:'Arrange work'});
 await vi.waitFor(async()=>expect((await t.organizer.list('team'))[0]!).toMatchObject({status:'failed',code:'PROVIDER_QUEUE_UNAVAILABLE',cleanupPending:true,cleanupCode:'GROUP_ARCHIVE_REQUIRES_NATIVE'}));
 const request=(await t.organizer.list('team'))[0]!;expect(request.agentId).toBeTypeOf('string');expect(t.fallback).not.toHaveBeenCalled();expect(f.agent.send).not.toHaveBeenCalled();expect(f.agent.archive).not.toHaveBeenCalled();
 f.patch({archivedAt:'native-confirmed'});const confirmed=await t.organizer.cancel('team',request.id);expect(confirmed.request.cleanupPending).toBe(false);expect(confirmed.request.code).toBe('PROVIDER_QUEUE_UNAVAILABLE');expect(f.agent.archive).not.toHaveBeenCalled();
});
it('persists organizer lost acknowledgement and keeps it unknown on restart and cancel without model replay',async()=>{
 const t=await setup();const {nativeLaneFixture}=await import('./testing/native-lane');const f=nativeLaneFixture();Object.assign(t.driver,{ensure:f.driver.ensure.bind(f.driver),reply:f.driver.reply.bind(f.driver),stop:f.driver.stop.bind(f.driver),archive:f.driver.archive.bind(f.driver)});f.admission.mockRejectedValue(new Error('lost ACK'));
 await t.organizer.create('team',{operationId:'unknown',request:'Arrange work'});await vi.waitFor(async()=>expect((await t.organizer.list('team'))[0]!).toMatchObject({status:'unknown',code:'ADMISSION_OUTCOME_UNKNOWN'}));
 const saved=Object.values((await new CompanionStore(t.root).snapshot()).groupPlanRequests!)[0]!;expect(saved.lane!.dispatch?.phase).toBe('unknown');await t.organizer.close();
 const recovered=new GroupPlanOrganizer(new CompanionStore(t.root),t.plans,{driver:f.driver,configFor:t.configFor,fallback:t.fallback});cleanups.push(()=>recovered.close());await recovered.cancel('team',saved.view.id);
 await vi.waitFor(async()=>expect((await recovered.list('team'))[0]!).toMatchObject({status:'unknown',code:'ADMISSION_OUTCOME_UNKNOWN'}));expect(f.admission).toHaveBeenCalledOnce();expect(t.fallback).not.toHaveBeenCalled();expect(f.agent.cancelTurn).not.toHaveBeenCalled();expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it('migrates a legacy unknown organizer dispatch before allowing cancellation to reconcile',async()=>{
 const t=await setup();await t.organizer.create('team',{operationId:'legacy',request:'Arrange'});await vi.waitFor(async()=>expect((await t.organizer.list('team'))[0]!.status).toBe('complete'));await t.organizer.close();
 const id=Object.keys((await t.store.snapshot()).groupPlanRequests!)[0]!;
 await t.store.transaction(state=>{const saved=state.groupPlanRequests![id]!;saved.view.status='unknown';saved.phase='dispatching';delete saved.lane!.dispatch;});
 const {nativeLaneFixture}=await import('./testing/native-lane');const f=nativeLaneFixture();const recovered=new GroupPlanOrganizer(new CompanionStore(t.root),t.plans,{driver:f.driver,configFor:t.configFor,fallback:t.fallback});cleanups.push(()=>recovered.close());
 expect((await recovered.list('team'))[0]!).toMatchObject({status:'unknown',code:'ADMISSION_OUTCOME_UNKNOWN'});await recovered.cancel('team',id);
 await vi.waitFor(async()=>expect((await recovered.list('team'))[0]!).toMatchObject({status:'unknown',code:'ADMISSION_OUTCOME_UNKNOWN'}));expect(f.admission).not.toHaveBeenCalled();expect(f.agent.cancelTurn).not.toHaveBeenCalled();
});
