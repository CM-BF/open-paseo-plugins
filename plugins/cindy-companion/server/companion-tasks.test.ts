import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CompanionStore} from './store';
import {CompanionTasks,type TaskOwner} from './companion-tasks';
import type {GroupDriver} from './group-driver';
import {planWorkDirectories} from './group-plan-workdir';
const roots:string[]=[],managers:CompanionTasks[]=[];afterEach(async()=>{for(const m of managers.splice(0))await m.close();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true});});
function barrier<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return{promise,resolve};}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'cindy-tasks-'));roots.push(root);const store=new CompanionStore(root);await store.load();const profile=await store.get('cindy');
 const owner:TaskOwner={botId:'cindy',scope:{agentId:'parent',role:'canonical'}};
 await store.transaction(s=>{s.bindings.cindy={agentId:'parent',operationId:'parent',phase:'ready',profileVersion:1,appliedVersion:1,appliedCapabilities:profile.capabilities,cwd:join(profile.homeDir,'workspace'),title:'Cindy',config:{},sessionScope:owner.scope};});
 const driver:GroupDriver={ensure:vi.fn(async lane=>{const disk=JSON.parse(await readFile(join(root,'state.json'),'utf8'));expect(disk.companionTasks[lane.roundId].lane.agentId).toBe(lane.agentId);return{workspaceId:'child-workspace'};}),reply:vi.fn(async()=> 'RESULT'),stop:vi.fn(async()=>{}),archive:vi.fn(async()=>{})};
 const configFor=vi.fn(async()=>({provider:'codex/test',modeId:'auto',options:{approval_policy:'on-request',sandbox_mode:'workspace-write'}}));
 const tasks=new CompanionTasks(store,{driver,configFor});managers.push(tasks);return{root,store,owner,driver,tasks,configFor};
}
it('starts one independent native child and freezes identity, context and every result across followups',async()=>{
 const f=await fixture(),args={operationId:'start',instruction:'Build a report',title:'Report'};
 const [a,b]=await Promise.all([f.tasks.start(f.owner,args),f.tasks.start(f.owner,args)]);expect(a.task.id).toBe(b.task.id);
 await vi.waitFor(async()=>expect((await f.tasks.get('cindy',a.task.id)).task.status).toBe('completed'));
 const first=(await f.tasks.get('cindy',a.task.id)).task;expect(first).toMatchObject({targetBotId:null,parentSessionId:'parent',runSequence:1});
 const lane=vi.mocked(f.driver.ensure).mock.calls[0]![0];expect(lane.config).not.toHaveProperty('mcpServers');expect(lane.config).not.toHaveProperty('systemPrompt');
 await f.tasks.message('cindy',first.id,{operationId:'follow',message:'Now revise it'});await vi.waitFor(async()=>expect((await f.tasks.get('cindy',first.id)).task.results).toHaveLength(2));
 const second=(await f.tasks.get('cindy',first.id)).task;expect(second.childSessionId).toBe(first.childSessionId);expect(second.results[0]).toEqual(first.results[0]);expect(second.objective).toBe('Build a report');
 expect(vi.mocked(f.driver.reply).mock.calls.map(c=>c[1].prompt)).toEqual(['Build a report','Now revise it']);
 const retry=await f.tasks.start(f.owner,args);expect(retry.task.id).toBe(first.id);expect(f.driver.reply).toHaveBeenCalledTimes(2);
 await expect(f.tasks.start(f.owner,{...args,instruction:'different'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it('does not label a queued native input as accepted or running before a turn identity exists',async()=>{
 const f=await fixture(),entered=barrier<void>(),release=barrier<void>();
 vi.mocked(f.driver.reply).mockImplementationOnce(async(_lane,input)=>{await input.queued?.(true);entered.resolve();await release.promise;await input.admitted?.('owned-task-turn');await input.queued?.(false);return'Finished own queued input';});
 const {task}=await f.tasks.start(f.owner,{operationId:'queue-view',instruction:'Wait in the native queue'});await entered.promise;
 const pending=(await f.tasks.get('cindy',task.id)).task;expect(pending).toMatchObject({status:'queued',activity:'queued',acceptedAt:null,results:[]});
 release.resolve();await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('completed'));expect((await f.tasks.get('cindy',task.id)).task.acceptedAt).toBeTypeOf('number');
});
it('queues additions while busy, permits only pending edits and preserves a paused queue until resume',async()=>{
 const f=await fixture(),entered=barrier<void>();vi.mocked(f.driver.reply).mockImplementationOnce(async(_lane,input)=>{await input.admitted?.('fixture-owned');entered.resolve();return new Promise((_yes,no)=>input.signal.addEventListener('abort',()=>no(new Error('stopped'))));});
 const {task}=await f.tasks.start(f.owner,{operationId:'start',instruction:'Work'});await entered.promise;
 await f.tasks.message('cindy',task.id,{operationId:'follow',message:'Second'});const queued=(await f.tasks.get('cindy',task.id)).task.queue.find(q=>q.status==='queued')!;
 await f.tasks.message('cindy',task.id,{operationId:'edit',mode:'edit',queued_message_id:queued.id,message:'Updated second'});
 await f.tasks.stop('cindy',task.id,'pause');await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.control).toBe('paused'));
 expect(f.driver.reply).toHaveBeenCalledTimes(1);await f.tasks.message('cindy',task.id,{operationId:'resume',mode:'resume'});
 await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('completed'));
 expect(vi.mocked(f.driver.reply).mock.calls.map(c=>c[1].prompt)).toEqual(['Work','Updated second']);
});
it('drains creation before stopping and never retries an unknown native outcome',async()=>{
 const f=await fixture(),entered=barrier<void>(),release=barrier<{workspaceId:string}>();vi.mocked(f.driver.ensure).mockImplementationOnce(async(lane,input)=>{await input!.recordDispatch({...lane.dispatch!,phase:'accepted',turnId:'creation-owned'});entered.resolve();return release.promise;});vi.mocked(f.driver.stop).mockRejectedValueOnce(new Error('offline'));
 const {task}=await f.tasks.start(f.owner,{operationId:'start',instruction:'Work'});await entered.promise;
 await f.tasks.stop('cindy',task.id);release.resolve({workspaceId:'child'});await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.control).toBe('unknown'));
 expect(f.driver.reply).not.toHaveBeenCalled();await expect(f.tasks.message('cindy',task.id,{operationId:'again',message:'Repeat'})).rejects.toMatchObject({code:'TASK_OUTCOME_UNKNOWN'});
 await f.tasks.stop('cindy',task.id);await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.control).toBe('stopped'));
 expect(f.driver.ensure).toHaveBeenCalledTimes(1);
});
it('revokes start authority atomically and persists explicit responsibility release',async()=>{
 const f=await fixture();const {task}=await f.tasks.start(f.owner,{operationId:'start',instruction:'Work'});await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('completed'));
 await f.tasks.responsibility('cindy',task.id,'release');expect((await new CompanionStore(f.root).snapshot()).companionTasks![task.id]!.view.responsibility).toBe('released');
 await f.store.transaction(s=>{delete s.bindings.cindy;});await expect(f.tasks.start(f.owner,{operationId:'new',instruction:'Work'})).rejects.toMatchObject({code:'SESSION_SCOPE_REVOKED'});
 await expect(f.tasks.get('foreign',task.id)).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('a later cancel wins over an in-flight pause and cancelled tasks cannot silently restart',async()=>{
 const f=await fixture(),running=barrier<void>(),stopping=barrier<void>(),release=barrier<void>();
 vi.mocked(f.driver.reply).mockImplementationOnce(async(_lane,input)=>{await input.admitted?.('fixture-owned');running.resolve();return new Promise((_yes,no)=>input.signal.addEventListener('abort',()=>no(new Error('stopped'))));});
 vi.mocked(f.driver.stop).mockImplementationOnce(async()=>{stopping.resolve();await release.promise;});
 const {task}=await f.tasks.start(f.owner,{operationId:'start',instruction:'Work'});await running.promise;await f.tasks.message('cindy',task.id,{operationId:'queued',message:'Later'});
 await f.tasks.stop('cindy',task.id,'pause');await stopping.promise;await f.tasks.stop('cindy',task.id,'cancel');release.resolve();
 await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('cancelled'));
 expect((await f.tasks.get('cindy',task.id)).task.queue).toEqual([]);
 await expect(f.tasks.message('cindy',task.id,{operationId:'restart',message:'Again'})).rejects.toMatchObject({code:'TASK_CANCELLED'});
});
it('keeps a capability-blocked input unsent and cancellable without pretending creation outcome is unknown',async()=>{
 const f=await fixture();vi.mocked(f.driver.ensure).mockRejectedValue(Object.assign(new Error('Upgrade required'),{code:'HOST_UPGRADE_REQUIRED'}));
 const {task}=await f.tasks.start(f.owner,{operationId:'start',instruction:'Work'});expect(task.childSessionId).toBeTypeOf('string');
 await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.blocked?.code).toBe('HOST_UPGRADE_REQUIRED'));
 const blocked=(await f.tasks.get('cindy',task.id)).task;expect(blocked).toMatchObject({control:'paused',activity:'idle',runSequence:0,status:'failed'});expect(blocked.queue[0]!.status).toBe('queued');expect(f.driver.reply).not.toHaveBeenCalled();
 await f.tasks.stop('cindy',task.id);await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('cancelled'));expect(f.driver.stop).not.toHaveBeenCalled();
});
it('does not stop an unrelated busy turn and resumes the retained queue only after native idle',async()=>{
 const f=await fixture();vi.mocked(f.driver.reply).mockRejectedValueOnce(Object.assign(new Error('busy'),{code:'TASK_BUSY'}));
 const {task}=await f.tasks.start(f.owner,{operationId:'start',instruction:'Work'});await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.lastError).toBe('TASK_BUSY'));
 expect(f.driver.stop).not.toHaveBeenCalled();expect(f.driver.reply).toHaveBeenCalledTimes(1);await f.tasks.nativeIdle(task.childSessionId!);
 await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('completed'));expect(f.driver.reply).toHaveBeenCalledTimes(2);
 expect(vi.mocked(f.driver.reply).mock.calls[0]![1].messageId).not.toBe(vi.mocked(f.driver.reply).mock.calls[1]![1].messageId);expect((await f.tasks.get('cindy',task.id)).task.runSequence).toBe(1);
});
it('reconciles a persisted stopping intent after restart without replaying any message',async()=>{
 const f=await fixture();const {task}=await f.tasks.start(f.owner,{operationId:'start',instruction:'Work'});await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('completed'));await f.tasks.close();
 await f.store.transaction(s=>{const t=s.companionTasks![task.id]!;t.view.control='stopping';t.stopMode='cancel';});
 const reopened=new CompanionTasks(new CompanionStore(f.root),{driver:f.driver,configFor:f.configFor});managers.push(reopened);
 expect((await reopened.get('cindy',task.id)).task).toMatchObject({status:'cancelled',control:'stopped'});expect(f.driver.reply).toHaveBeenCalledTimes(1);
});
it('replays mutation receipts after input consumption, cancellation and a real store restart',async()=>{
 const f=await fixture(),{task}=await f.tasks.start(f.owner,{operationId:'start',instruction:'Work'});
 await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('completed'));
 await f.tasks.stop('cindy',task.id,'pause');await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.control).toBe('paused'));
 const queue={operationId:'follow',message:'Second'};await f.tasks.message('cindy',task.id,queue);
 const pending=(await f.tasks.get('cindy',task.id)).task.queue[0]!;
 const edit={operationId:'edit',mode:'edit',queued_message_id:pending.id,message:'Revised'};await f.tasks.message('cindy',task.id,edit);
 await f.tasks.message('cindy',task.id,{operationId:'extra',message:'Withdraw me'});
 const extra=(await f.tasks.get('cindy',task.id)).task.queue.find(q=>q.text==='Withdraw me')!;
 const withdraw={operationId:'withdraw',mode:'withdraw',queued_message_id:extra.id};await f.tasks.message('cindy',task.id,withdraw);
 const resume={operationId:'resume',mode:'resume'};await f.tasks.message('cindy',task.id,resume);
 await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.results).toHaveLength(2));
 await f.tasks.stop('cindy',task.id);await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('cancelled'));await f.tasks.close();
 const reopened=new CompanionTasks(new CompanionStore(f.root),{driver:f.driver,configFor:f.configFor});managers.push(reopened);
 for(const args of [queue,edit,withdraw,resume])expect((await reopened.message('cindy',task.id,args)).task.status).toBe('cancelled');
 expect(vi.mocked(f.driver.reply).mock.calls.map(c=>c[1].prompt)).toEqual(['Work','Revised']);
 await expect(reopened.message('cindy',task.id,{...edit,message:'Changed payload'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it('cancels a known busy admission without interrupting the unrelated turn even when stop precedes the receipt',async()=>{
 const f=await fixture(),entered=barrier<void>(),receipt=barrier<void>();
 vi.mocked(f.driver.reply).mockImplementationOnce(async()=>{entered.resolve();await receipt.promise;throw Object.assign(new Error('busy'),{code:'TASK_BUSY'});});
 const {task}=await f.tasks.start(f.owner,{operationId:'start',instruction:'Work'});await entered.promise;
 await f.tasks.stop('cindy',task.id,'cancel');receipt.resolve();
 await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('cancelled'));
 expect(f.driver.stop).not.toHaveBeenCalled();expect((await f.tasks.get('cindy',task.id)).task.runSequence).toBe(0);
});
it('retains unknown dispatch intent across stop and restart without using idle as cancellation proof',async()=>{
 const f=await fixture();vi.mocked(f.driver.reply).mockRejectedValueOnce(Object.assign(new Error('agent_request_outcome_unknown'),{dispatchOutcome:'unknown'}));
 const {task}=await f.tasks.start(f.owner,{operationId:'start',instruction:'Work'});
 await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.lastError).toBe('ADMISSION_OUTCOME_UNKNOWN'));
 await f.tasks.stop('cindy',task.id,'cancel');await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.control).toBe('unknown'));await f.tasks.close();
 const reopened=new CompanionTasks(new CompanionStore(f.root),{driver:f.driver,configFor:f.configFor});managers.push(reopened);
 expect((await reopened.get('cindy',task.id)).task).toMatchObject({control:'unknown',lastError:'ADMISSION_OUTCOME_UNKNOWN',queue:[{status:'unknown'}]});
 expect(f.driver.stop).not.toHaveBeenCalled();expect(f.driver.reply).toHaveBeenCalledTimes(1);
 await expect(reopened.message('cindy',task.id,{operationId:'again',message:'Again'})).rejects.toMatchObject({code:'TASK_OUTCOME_UNKNOWN'});
});
it('rejects task admission when profile deletion reserves the owner while model configuration is pending',async()=>{
 const f=await fixture(),entered=barrier<void>(),release=barrier<void>();f.configFor.mockImplementationOnce(async()=>{entered.resolve();await release.promise;return{provider:'codex/test',modeId:'auto',options:{approval_policy:'on-request',sandbox_mode:'workspace-write'}};});
 const start=f.tasks.start(f.owner,{operationId:'race',instruction:'Work'}),rejected=expect(start).rejects.toMatchObject({code:'SESSION_SCOPE_REVOKED'});
 await entered.promise;await f.store.transaction(s=>{s.profileDeletions={cindy:{requestedAt:Date.now()}};});release.resolve();await rejected;
 expect((await f.store.snapshot()).companionTasks).toBeUndefined();expect(f.driver.ensure).not.toHaveBeenCalled();
});
it('publishes an answered task after artifact recovery without repeating execution or changing its frozen receipt',async()=>{
 const f=await fixture(),directories=planWorkDirectories(f.store),collect=vi.fn(directories.artifacts).mockRejectedValueOnce(new Error('temporary file inspection failure'));
 const tasks=new CompanionTasks(f.store,{driver:f.driver,configFor:f.configFor,directories:{...directories,artifacts:collect}});managers.push(tasks);
 vi.mocked(f.driver.reply).mockImplementation(async(lane,input)=>{await writeFile(join(lane.cwd,'result.txt'),input.prompt);return`Result: ${input.prompt}`;});
 const {task}=await tasks.start(f.owner,{operationId:'start',instruction:'First'});await vi.waitFor(async()=>expect((await tasks.get('cindy',task.id)).task.status).toBe('failed'));
 expect(f.driver.reply).toHaveBeenCalledTimes(1);expect((await f.store.snapshot()).companionTasks![task.id]!.inputs[0]!.phase).toBe('answered');
 await tasks.message('cindy',task.id,{operationId:'follow',message:'Second'});await vi.waitFor(async()=>expect((await tasks.get('cindy',task.id)).task.results).toHaveLength(2));
 const results=(await tasks.get('cindy',task.id)).task.results;expect(results.map(r=>r.text)).toEqual(['Result: First','Result: Second']);expect(results.map(r=>r.runSequence)).toEqual([1,2]);
 expect(results[0]!.artifacts).toMatchObject([{path:'result.txt',status:'added'}]);expect(results[1]!.artifacts).toMatchObject([{path:'result.txt',status:'modified'}]);expect(f.driver.reply).toHaveBeenCalledTimes(2);
});
it('persists the accepted native turn and reuses its exact cancellation receipt across restart',async()=>{
 const f=await fixture(),entered=barrier<void>();
 vi.mocked(f.driver.reply).mockImplementationOnce(async(_lane,input)=>{await input.admitted?.('owned-native-turn');entered.resolve();return new Promise((_yes,no)=>input.signal.addEventListener('abort',()=>no(new Error('stopped'))));});
 vi.mocked(f.driver.stop).mockRejectedValueOnce(new Error('cancel acknowledgement lost'));
 const {task}=await f.tasks.start(f.owner,{operationId:'start',instruction:'Work'});await entered.promise;
 expect((await new CompanionStore(f.root).snapshot()).companionTasks![task.id]!.inputs[0]!.nativeTurnId).toBe('owned-native-turn');
 await f.tasks.stop('cindy',task.id,'cancel');await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.control).toBe('unknown'));await f.tasks.close();
 const reopened=new CompanionTasks(new CompanionStore(f.root),{driver:f.driver,configFor:f.configFor});managers.push(reopened);expect((await reopened.get('cindy',task.id)).task.status).toBe('cancelled');
 const stops=vi.mocked(f.driver.stop).mock.calls.map(call=>call[0] as {ownedTurnId?:string;cancelMessageId?:string});
 expect(stops).toHaveLength(2);expect(stops[0]).toMatchObject({ownedTurnId:'owned-native-turn',cancelMessageId:expect.any(String)});expect(stops[1]!.cancelMessageId).toBe(stops[0]!.cancelMessageId);expect(f.driver.reply).toHaveBeenCalledTimes(1);
});
it('keeps provider-level idle admission unavailable distinct from a host upgrade and safely cancels the unsent queue',async()=>{
 const f=await fixture();vi.mocked(f.driver.reply).mockRejectedValue(Object.assign(new Error('Provider cannot guarantee start-if-idle'),{code:'PROVIDER_ADMISSION_UNAVAILABLE'}));
 const {task}=await f.tasks.start(f.owner,{operationId:'provider-blocked',instruction:'Work'});
 await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.blocked?.code).toBe('PROVIDER_ADMISSION_UNAVAILABLE'));
 expect((await f.tasks.get('cindy',task.id)).task).toMatchObject({control:'paused',activity:'idle',runSequence:0,queue:[{status:'queued'}]});
 await f.tasks.stop('cindy',task.id,'cancel');await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('cancelled'));
 expect(f.driver.stop).not.toHaveBeenCalled();expect(f.driver.reply).toHaveBeenCalledOnce();
});
it.each(['legacy','dispatching'] as const)('keeps a %s consuming input without an ACK unknown across disk restart even when native stop would report idle',async kind=>{
 const f=await fixture();const {task}=await f.tasks.start(f.owner,{operationId:'started',instruction:'Work'});await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('completed'));await f.tasks.close();
 await f.store.transaction(state=>{const saved=state.companionTasks![task.id]!,input=saved.inputs[0]!;saved.view.status='running';saved.view.control='active';input.phase='consuming';input.nativeMessageId='may-have-been-sent';delete input.nativeTurnId;delete input.admissionUnknown;if(kind==='legacy')delete input.dispatch;else input.dispatch={messageId:input.nativeMessageId,cancelMessageId:'cancel',phase:'dispatching'};});
 vi.mocked(f.driver.stop).mockClear();const recovered=new CompanionTasks(new CompanionStore(f.root),{driver:f.driver,configFor:f.configFor});managers.push(recovered);
 expect((await recovered.get('cindy',task.id)).task).toMatchObject({control:'unknown',lastError:'ADMISSION_OUTCOME_UNKNOWN',queue:[{status:'unknown'}]});await recovered.stop('cindy',task.id,'cancel');
 await vi.waitFor(async()=>expect((await recovered.get('cindy',task.id)).task.control).toBe('unknown'));expect(f.driver.stop).not.toHaveBeenCalled();expect(f.driver.reply).toHaveBeenCalledOnce();
});
it('restores a recorded not-sent input as a paused queue across restart and cancels it without touching the native child',async()=>{
 const f=await fixture();const {task}=await f.tasks.start(f.owner,{operationId:'started',instruction:'Work'});await vi.waitFor(async()=>expect((await f.tasks.get('cindy',task.id)).task.status).toBe('completed'));await f.tasks.close();
 await f.store.transaction(state=>{const saved=state.companionTasks![task.id]!,input=saved.inputs[0]!;saved.view.status='running';saved.view.control='active';input.phase='consuming';delete input.nativeTurnId;input.dispatch={messageId:'not-sent',cancelMessageId:'cancel',phase:'not-sent',code:'PROVIDER_ADMISSION_UNAVAILABLE'};});
 vi.mocked(f.driver.stop).mockClear();const recovered=new CompanionTasks(new CompanionStore(f.root),{driver:f.driver,configFor:f.configFor});managers.push(recovered);
 expect((await recovered.get('cindy',task.id)).task).toMatchObject({status:'failed',control:'paused',activity:'idle',lastError:'PROVIDER_ADMISSION_UNAVAILABLE',queue:[{status:'queued'}]});await recovered.stop('cindy',task.id,'cancel');
 await vi.waitFor(async()=>expect((await recovered.get('cindy',task.id)).task.status).toBe('cancelled'));expect(f.driver.stop).not.toHaveBeenCalled();
});
