import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CompanionStore} from './store';
import {sessionBinding,validateSessionBinding} from './session-authority';
import type {Paseo} from './runtime';
import type {SessionScope} from '../shared/session-scope';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'cindy-session-auth-'));roots.push(root);const store=new CompanionStore(root);await store.load();const profile=await store.get('cindy');
 const scope:SessionScope={agentId:'owned-agent',role:'canonical'},cwd=join(profile.homeDir,'workspace');
 await store.transaction(s=>{s.bindings.cindy={agentId:scope.agentId,operationId:'op',phase:'ready',profileVersion:1,appliedVersion:1,appliedCapabilities:profile.capabilities,cwd,title:'Cindy',config:{},workspaceId:'owned-workspace',sessionScope:scope};});
 const native={refresh:vi.fn(async()=>({})),archivedAt:null as string|null,cwd,workspaceId:'owned-workspace'};
 const api={agents:{ref:()=>native}} as unknown as Paseo;return{root,store,scope,cwd,native,api};
}
it('validates native ownership after restart without UI state and ignores object insertion order',async()=>{
 const f=await fixture();await f.store.transaction(s=>{s.bindings.cindy!.sessionScope={role:'canonical',agentId:f.scope.agentId};});
 await validateSessionBinding(new CompanionStore(f.root),f.api,'cindy',f.scope);
 await expect(validateSessionBinding(f.store,f.api,'cindy',{...f.scope,groupId:'forged'})).rejects.toMatchObject({code:'SESSION_SCOPE_REVOKED'});
});
it.each(['deleted','disabled','archived','cwd','workspace'] as const)('rejects %s revocation rather than trusting the signed token',async kind=>{
 const f=await fixture();if(kind==='deleted')await f.store.transaction(s=>{delete s.profiles.cindy;});
 if(kind==='disabled')await f.store.transaction(s=>{s.profiles.cindy!.enabled=false;});
 if(kind==='archived')f.native.archivedAt='now';if(kind==='cwd')f.native.cwd='/foreign';if(kind==='workspace')f.native.workspaceId='foreign';
 await expect(validateSessionBinding(f.store,f.api,'cindy',f.scope)).rejects.toMatchObject({code:'SESSION_SCOPE_REVOKED'});
});
it('rechecks authorization after the asynchronous native refresh',async()=>{
 const f=await fixture();f.native.refresh.mockImplementation(async()=>{await f.store.transaction(s=>{delete s.bindings.cindy;});return{};});
 await expect(validateSessionBinding(f.store,f.api,'cindy',f.scope)).rejects.toMatchObject({code:'SESSION_SCOPE_REVOKED'});
});
it('rejects removed members, retired lanes, deleted groups and closed work plans',async()=>{
 const f=await fixture(),scope:SessionScope={agentId:'lane',role:'group',groupId:'group'};
 await f.store.transaction(s=>{s.groups={group:{id:'group',name:'G',description:'',botIds:['cindy'],replyMode:'all',revision:1,createdAt:1,updatedAt:1,messages:[],rounds:[],receipts:{},continueKeys:{},lanes:{lane:{agentId:'lane',botId:'cindy',groupId:'group',roundId:'round',operationId:'lane',cwd:f.cwd,title:'Cindy',phase:'ready',config:{},sessionScope:scope}}}};});
 const base=await f.store.snapshot();expect(sessionBinding(base,'cindy',scope).cwd).toBe(f.cwd);
 for(const change of [(s:typeof base)=>{s.groups!.group!.botIds=[];},(s:typeof base)=>{s.groups!.group!.lanes.lane!.retired=true;},(s:typeof base)=>{s.groups!.group!.deletedAt=1;}]){const state=structuredClone(base);change(state);expect(()=>sessionBinding(state,'cindy',scope)).toThrow();}
 const planScope:SessionScope={agentId:'lane',role:'plan',groupId:'group',planId:'plan'};
 const state=structuredClone(base);state.groupPlans={plan:{view:{id:'plan',groupId:'group',status:'dismissed',execution:{state:'idle'}} as never,projectDir:null,lanes:{cindy:{...state.groups!.group!.lanes.lane!,sessionScope:planScope}},notes:[],attempts:[]}};
 expect(()=>sessionBinding(state,'cindy',planScope)).toThrow();
 state.groupPlans.plan!.view.status='running';state.groupPlans.plan!.view.execution={state:'running'};
 state.groupPlans.plan!.view.currentStep=0;state.groupPlans.plan!.view.steps=[{position:0,botId:'cindy',botName:'Cindy',task:'Work',status:'running',agentId:'lane',artifacts:[]}];
 expect(sessionBinding(state,'cindy',planScope).cwd).toBe(f.cwd);
 state.groupPlans.plan!.view.currentStep=1;state.groupPlans.plan!.view.steps.push({position:1,botId:'other',botName:'Other',task:'Next',status:'running',agentId:'another-lane',artifacts:[]});
 expect(()=>sessionBinding(state,'cindy',planScope)).toThrow();
});
