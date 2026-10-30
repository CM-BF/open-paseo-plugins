import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CompanionStore} from './store';
import {CompanionService} from './service';
import type {Paseo} from './runtime';
import type {GroupDriver} from './group-driver';
import type {SessionScope} from '../shared/session-scope';
const roots:string[]=[],services:CompanionService[]=[];afterEach(async()=>{for(const s of services.splice(0))await s.close();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'cindy-session-tools-'));roots.push(root);const store=new CompanionStore(root);await store.load();const profile=await store.get('cindy');
 const scope:SessionScope={agentId:'parent',role:'canonical'},cwd=join(profile.homeDir,'workspace');
 await store.transaction(s=>{s.bindings.cindy={agentId:'parent',operationId:'parent',phase:'ready',profileVersion:1,appliedVersion:1,appliedCapabilities:profile.capabilities,cwd,title:'Cindy',config:{},sessionScope:scope,workspaceId:'parent-workspace'};});
 const native=new Map<string,{cwd:string;workspaceId:string;archivedAt:string|null}>();native.set('parent',{cwd,workspaceId:'parent-workspace',archivedAt:null});
 const workspaces=new Map<string,string>();workspaces.set('parent-workspace',cwd);
 const paseo={agents:{ref:(id:string)=>({id,refresh:async()=>native.has(id)?{}:null,get cwd(){return native.get(id)?.cwd;},get workspaceId(){return native.get(id)?.workspaceId;},get archivedAt(){return native.get(id)?.archivedAt;},activeTurn:{turnId:'parent-turn'},current:()=>({})})},
   workspaces:{ref:(id:string)=>({refresh:async()=>workspaces.has(id)?{}:null,get directory(){return workspaces.get(id);}})},
   providers:{waitForReady:async()=>({entries:[{provider:'codex',status:'ready',modes:[{id:'auto'}],models:[{id:'test',isDefault:true}]}]})}} as unknown as Paseo;
 const driver:GroupDriver={ensure:vi.fn(async lane=>{native.set(lane.agentId,{cwd:lane.cwd,workspaceId:'child-workspace',archivedAt:null});workspaces.set('child-workspace',lane.cwd);return{workspaceId:'child-workspace'};}),reply:vi.fn(async lane=>{await writeFile(join(lane.cwd,'result.txt'),'real artifact');return'Done';}),stop:vi.fn(async()=>{}),archive:vi.fn(async()=>{})};
 const getApi=vi.fn(async()=>paseo),service=new CompanionService(store,{taskDriver:()=>driver,paseoForTools:getApi});services.push(service);
 return{store,scope,paseo,native,workspaces,driver,getApi,service};
}
it('runs authenticated tools before any UI call, ignores caller assertions, and creates a real owned task receipt',async()=>{
 const f=await fixture();const result=await f.service.invokeSessionTool('cindy',f.scope,'start_session_task',{instruction:'Write the result',callerSessionId:'forged',idempotency_key:'once'});
 expect(result.ok).toBe(true);if(!result.ok)return;const value=result.value as any;expect(value).toMatchObject({action:'start_session_task',botId:'cindy',task:{parentSessionId:'parent'}});expect(f.getApi).toHaveBeenCalled();
 await vi.waitFor(async()=>expect((await f.store.snapshot()).companionTasks![value.taskId]!.view.status).toBe('completed'));
 const same=await f.service.invokeSessionTool('cindy',f.scope,'start_session_task',{instruction:'Write the result',callerSessionId:'forged',idempotency_key:'once'});expect((same as any).value.taskId).toBe(value.taskId);expect(f.driver.reply).toHaveBeenCalledTimes(1);
 expect(await f.service.invokeSessionTool('foreign',f.scope,'check_session_task',{task_id:value.taskId})).toMatchObject({ok:false,code:'SESSION_SCOPE_REVOKED'});
 expect(await f.service.invoke({op:'companion.tasks.get',args:{botId:'cindy',taskId:value.taskId,parentAgentId:'wrong'}},f.paseo)).toMatchObject({ok:false,code:'TASK_SCOPE_MISMATCH'});
 await f.service.invoke({op:'companion.tasks.responsibility',args:{botId:'cindy',taskId:value.taskId,action:'release'}},f.paseo);
 expect(await f.service.invokeSessionTool('cindy',f.scope,'message_session_task',{task_id:value.taskId,message:'Again',idempotency_key:'two'})).toMatchObject({ok:false,code:'TASK_RESPONSIBILITY_RELEASED'});
});
it('returns creator identity through the direct child index and validates frozen artifacts against the native workspace',async()=>{
 const f=await fixture(),start=await f.service.invokeSessionTool('cindy',f.scope,'start_session_task',{instruction:'Write the result',idempotency_key:'once'});const id=(start as any).value.taskId as string;
 await vi.waitFor(async()=>expect((await f.store.snapshot()).companionTasks![id]!.view.status).toBe('completed'));
 const task=(await f.store.snapshot()).companionTasks![id]!.view,agentId=task.childSessionId!;
 expect(await f.service.invoke({op:'companion.tasks.owner',args:{agentId,workspaceId:'child-workspace'}},f.paseo)).toMatchObject({ok:true,value:{owner:{botId:'cindy',taskId:id,responsibility:'owned'}}});
 await f.service.invoke({op:'companion.tasks.responsibility',args:{botId:'cindy',taskId:id,action:'release'}},f.paseo);
 expect(await f.service.invoke({op:'companion.tasks.owner',args:{agentId}},f.paseo)).toMatchObject({ok:true,value:{owner:{botId:'cindy',taskId:id,responsibility:'released'}}});
 f.native.get(agentId)!.archivedAt='archived';expect(await f.service.invoke({op:'companion.tasks.owner',args:{agentId}},f.paseo)).toMatchObject({ok:true,value:{owner:{taskId:id}}});
 const args={botId:'cindy',taskId:id,path:'result.txt',receiptId:task.results[0]!.id,parentAgentId:'parent'};
 expect(await f.service.invoke({op:'companion.tasks.artifact',args},f.paseo)).toMatchObject({ok:true,value:{workspaceId:'child-workspace',path:'result.txt'}});
 expect(await f.service.invoke({op:'companion.tasks.artifact',args:{...args,receiptId:'foreign'}},f.paseo)).toMatchObject({ok:false,code:'NOT_FOUND'});
 f.workspaces.set('child-workspace','/changed');expect(await f.service.invoke({op:'companion.tasks.artifact',args},f.paseo)).toMatchObject({ok:false,code:'WORKSPACE_MISMATCH'});
 f.native.get(agentId)!.workspaceId='changed';expect(await f.service.invoke({op:'companion.tasks.owner',args:{agentId}},f.paseo)).toMatchObject({ok:true,value:{owner:null}});
});
