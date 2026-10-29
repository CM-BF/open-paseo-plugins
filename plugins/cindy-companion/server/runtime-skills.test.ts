import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CompanionStore } from './store';
import { CompanionRuntime, type Paseo } from './runtime';
import { NativeGroupDriver, prepareLaneDispatch, type GroupLane, type LaneDispatch } from './group-driver';
import type { NativeCreationReceipt } from './native-lane-input';
import { NATIVE_SKILLS_METADATA, withNativeSkills } from './native-skills';

const roots:string[]=[], runtimes:CompanionRuntime[]=[];
afterEach(async()=>{for(const runtime of runtimes.splice(0))await runtime.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(native:boolean|null=true){
  const root=await mkdtemp(join(tmpdir(),'cindy-native-skills-'));roots.push(root);
  const store=new CompanionStore(root),runtime=new CompanionRuntime(store);runtimes.push(runtime);
  const snapshots=new Map<string,any>();
  const updateInstructions=vi.fn(async(_input:Record<string,unknown>)=>({}));
  const ref=(id:string)=>({id, get cwd(){return snapshots.get(id)?.cwd;},get workspaceId(){return snapshots.get(id)?.workspaceId;},
    get archivedAt(){return snapshots.get(id)?.archivedAt;},get activeTurn(){return snapshots.get(id)?.activeTurn;},get status(){return snapshots.get(id)?.status;},
    get pendingPermissions(){return snapshots.get(id)?.pendingPermissions;},refresh:async()=>snapshots.get(id)??null,current:()=>snapshots.get(id)??null,updateInstructions});
  const create=vi.fn(async(input:any)=>{if(!snapshots.has(input.agentId)){const [provider,model]=input.config.provider.split('/');snapshots.set(input.agentId,{id:input.agentId,provider,model,cwd:input.cwd,workspaceId:'workspace',status:'idle'});}return ref(input.agentId);});
  const agents={ref,create,...(native===null?{}:{supportsNativeSkillMounts:()=>native})};
  const paseo={agents,providers:{waitForReady:async()=>({entries:[{provider:'codex',status:'ready',models:[{id:'model',isDefault:true}],modes:[{id:'auto'}]}]})}} as unknown as Paseo;
  let token='source-1',enabledCount=1,localSkillIds:string[]=[];
  const factory=async()=>({profile:await store.get('cindy'),token,enabledCount,localSkillIds,mounts:enabledCount?[{directory:join(root,'mount')}]:[]});
  runtime.setSkillsFactory(factory);
  return{root,store,runtime,paseo,snapshots,ref,create,updateInstructions,factory,setSource:(next:string,count=1,ids:string[]=[])=>{token=next;enabledCount=count;localSkillIds=ids;}};
}
it.each([null,false])('does not pass native skill fields without positive host support (%s)',async supported=>{
  const f=await fixture(supported);const result=await f.runtime.ensure(f.paseo,'cindy');
  expect(f.create.mock.calls[0]![0].config).not.toHaveProperty('skillMounts');expect(f.create.mock.calls[0]![0].config).not.toHaveProperty(NATIVE_SKILLS_METADATA);
  expect(result.runtime.skills).toMatchObject({status:'unavailable',appliedToken:null,desiredToken:'source-1'});
  await expect(f.runtime.nativeConfigFor(f.paseo,'cindy','/group')).rejects.toMatchObject({code:'NATIVE_SKILL_MOUNTS_UNSUPPORTED'});
});
it('passes only public mount fields and records the exact acknowledged source epoch',async()=>{
  const f=await fixture(),result=await f.runtime.ensure(f.paseo,'cindy');
  expect(f.create.mock.calls[0]![0].config).toMatchObject({skillMounts:[{directory:join(f.root,'mount')}]});
  expect(f.create.mock.calls[0]![0].config).not.toHaveProperty(NATIVE_SKILLS_METADATA);
  expect(result.runtime.skills).toMatchObject({status:'applied',appliedToken:'source-1'});
  expect((await f.store.snapshot()).bindings.cindy!.config).toHaveProperty(NATIVE_SKILLS_METADATA);
  f.setSource('body-changed');expect((await f.runtime.applyProfile(f.paseo,'cindy')).skills).toMatchObject({status:'applied',appliedToken:'body-changed'});
  expect(f.updateInstructions).toHaveBeenCalledOnce();expect(f.updateInstructions.mock.calls[0]![0]).not.toHaveProperty(NATIVE_SKILLS_METADATA);
  f.setSource('disabled-all',0);expect((await f.runtime.applyProfile(f.paseo,'cindy')).skills).toMatchObject({status:'none',appliedToken:'disabled-all'});
  expect(f.updateInstructions.mock.calls[1]![0].skillMounts).toEqual([]);
});
it('busy sessions keep the old source and apply only after idle, including disabled selected local skills',async()=>{
  const f=await fixture();const {agentId}=await f.runtime.ensure(f.paseo,'cindy');f.setSource('source-2');f.snapshots.get(agentId).activeTurn={turnId:'busy'};
  expect(await f.runtime.applyProfile(f.paseo,'cindy')).toMatchObject({state:'pending',code:'AGENT_BUSY',skills:{appliedToken:'source-1',desiredToken:'source-2'}});
  expect(f.updateInstructions).not.toHaveBeenCalled();f.snapshots.get(agentId).activeTurn=null;
  await f.store.update('cindy',{skills:['local-disabled']});f.setSource('source-3',0,['local-disabled']);
  expect((await f.runtime.applyProfile(f.paseo,'cindy')).skills).toMatchObject({status:'none',appliedToken:'source-3'});
  await expect(f.runtime.nativeConfigFor(f.paseo,'cindy','/group')).resolves.toMatchObject({skillMounts:[]});
});
it('an in-flight acknowledgement never marks a later save epoch applied',async()=>{
  const f=await fixture();await f.runtime.ensure(f.paseo,'cindy');f.setSource('source-2');
  let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});f.updateInstructions.mockImplementationOnce(async()=>{await hold;return{};});
  const result=f.runtime.applyProfile(f.paseo,'cindy');await vi.waitFor(()=>expect(f.updateInstructions).toHaveBeenCalledOnce());f.setSource('source-3');release();
  expect(await result).toMatchObject({state:'pending',skills:{desiredToken:'source-3',appliedToken:'source-2',status:'pending'}});
  expect((await f.runtime.applyProfile(f.paseo,'cindy')).skills).toMatchObject({status:'applied',appliedToken:'source-3'});
});
it('lost or rejected update acknowledgements preserve the previous applied source across reopen',async()=>{
  const f=await fixture();await f.runtime.ensure(f.paseo,'cindy');f.setSource('source-2');f.updateInstructions.mockRejectedValueOnce(Object.assign(new Error('lost acknowledgement'),{code:'update_failed'}));
  expect(await f.runtime.applyProfile(f.paseo,'cindy')).toMatchObject({state:'pending',code:'update_failed',skills:{appliedToken:'source-1',desiredToken:'source-2'}});
  const reopened=new CompanionRuntime(new CompanionStore(f.root));runtimes.push(reopened);reopened.setSkillsFactory(f.factory);
  expect((await reopened.state('cindy')).skills).toMatchObject({status:'pending',appliedToken:'source-1',code:'update_failed'});
  expect((await reopened.applyProfile(f.paseo,'cindy')).skills).toMatchObject({status:'applied',appliedToken:'source-2'});
});
it('replays an unconfirmed native create with the exact immutable mount intent before declaring application',async()=>{
  const f=await fixture(),create=f.create.getMockImplementation()!;
  f.create.mockImplementationOnce(async input=>{await create(input);throw new Error('lost creation ACK');});
  await expect(f.runtime.ensure(f.paseo,'cindy')).rejects.toThrow('lost creation ACK');expect((await f.store.snapshot()).bindings.cindy!.appliedSkills).toBeUndefined();
  const first=structuredClone(f.create.mock.calls[0]![0]);f.setSource('source-2');
  const reopened=new CompanionRuntime(new CompanionStore(f.root));runtimes.push(reopened);reopened.setSkillsFactory(f.factory);
  expect((await reopened.ensure(f.paseo,'cindy')).runtime.skills).toMatchObject({status:'pending',appliedToken:'source-1',desiredToken:'source-2'});
  expect(f.create.mock.calls[1]![0]).toEqual(first);
});
it('allows current edited preset sources only on the native personal path, retaining byte-checked legacy behavior',async()=>{
  const f=await fixture(),profile=await f.store.get('cindy'),path=join(profile.homeDir,'skills/preset/SKILL.md');await mkdir(join(profile.homeDir,'skills/preset'),{recursive:true});await writeFile(path,'original');
  await f.store.transaction(state=>{state.presetImports={receipt:{result:{botId:'cindy',checks:[{entryId:'skill-preset',status:'copied'}]},files:[{path:'skills/preset/SKILL.md',skillId:'preset',sha256:createHash('sha256').update('original').digest('hex') }]} as never};});
  await f.store.update('cindy',{skills:['preset']});f.setSource('original',1,['preset']);
  const legacy={...f.paseo,agents:{...f.paseo.agents,supportsNativeSkillMounts:()=>false}} as Paseo;
  expect((await f.runtime.instructionsFor('cindy',undefined,legacy)).systemPrompt).toContain('locally installed Cindy skills');
  await writeFile(path,'edited original source');f.setSource('edited',1,['preset']);
  await expect(f.runtime.instructionsFor('cindy',undefined,legacy)).rejects.toMatchObject({code:'PRESET_SKILL_CHANGED'});
  const endpoint=vi.fn(async()=>({type:'http',url:'http://127.0.0.1/fixture'}));f.runtime.setMcpFactory(endpoint);
  await f.runtime.ensureToolEndpoint('cindy');expect(endpoint).toHaveBeenCalledWith('cindy');
  await expect(f.runtime.nativeConfigFor(f.paseo,'cindy','/group')).resolves.toMatchObject({skillMounts:[{directory:join(f.root,'mount')}]});
});
it('refreshes same-directory group projections by token and strips private metadata on both public APIs',async()=>{
  const f=await fixture(),driver=new NativeGroupDriver(f.paseo),snapshot=await f.factory();
  const config=withNativeSkills({provider:'codex/model',systemPrompt:'identity'},snapshot);
  const lane:GroupLane={agentId:'lane',operationId:'fixed',botId:'cindy',groupId:'group',roundId:'round',phase:'creating',cwd:'/group',title:'group',config,nativeInputVersion:1,dispatch:prepareLaneDispatch('first-input')};
  const journal=join(f.root,'lane.json'); await writeFile(journal,JSON.stringify(lane));
  const recordDispatch=async(receipt:LaneDispatch)=>{lane.dispatch=structuredClone(receipt);await writeFile(journal,JSON.stringify(lane));};
  let creation:NativeCreationReceipt|null=null;
  Object.assign(f.paseo.agents,{supportsInitialPromptReservation:()=>true,supportsTurnReceipts:()=>true,
    ref:(id:string)=>Object.assign(f.ref(id),{turns:{get:async({turnId}:{turnId:string})=>({agentId:id,clientMessageId:'first-input',turnId,status:'unknown'})}})});
  const getCreation=vi.fn(async()=>creation); Object.assign(f.paseo,{creations:{get:getCreation}});
  const create=f.create.getMockImplementation()!;
  f.create.mockImplementationOnce(async input=>{
    const saved=JSON.parse(await readFile(journal,'utf8')) as GroupLane;
    expect(saved.dispatch).toMatchObject({phase:'dispatching',native:{intent:{admission:'initial',messageId:'first-input',input:{text:'First group prompt'},creation:{idempotencyKey:'fixed',config:{skillMounts:snapshot.mounts}}}}});
    expect(saved.config).toHaveProperty(NATIVE_SKILLS_METADATA);
    expect(saved.dispatch!.native!.intent.creation!.config).not.toHaveProperty(NATIVE_SKILLS_METADATA);
    const agent=await create(input);
    Object.assign(f.snapshots.get('lane'),{status:'running',activeTurn:{turnId:'first-turn'}});
    creation={kind:'agent',agentId:'lane',workspaceId:'workspace',idempotencyKey:'fixed',phase:'completed',initialPrompt:{status:'accepted',clientMessageId:input.clientMessageId,turnId:'first-turn'}};
    return agent;
  });
  await expect(driver.ensure(lane,{prompt:'First group prompt',messageId:'first-input',signal:new AbortController().signal,recordDispatch})).resolves.toEqual({workspaceId:'workspace'});
  expect(f.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({agentId:'lane',idempotencyKey:'fixed',prompt:'First group prompt',clientMessageId:'first-input',requireInitialPromptReservation:true,config:{provider:'codex/model',systemPrompt:'identity',skillMounts:snapshot.mounts}}));
  expect(lane.phase).toBe('ready');expect(lane.dispatch?.native).toMatchObject({phase:'started',turnId:'first-turn',creationComplete:true});
  expect(getCreation).toHaveBeenCalledWith({kind:'agent',idempotencyKey:'fixed'});expect(f.updateInstructions).not.toHaveBeenCalled();
  const next=withNativeSkills({provider:'codex/model',systemPrompt:'identity'},{...snapshot,token:'changed'});
  await expect(driver.configure(lane,next)).rejects.toMatchObject({code:'GROUP_LANE_BUSY'});expect(f.updateInstructions).not.toHaveBeenCalled();
  Object.assign(f.snapshots.get('lane'),{status:'idle',activeTurn:null});
  await driver.configure(lane,next);expect(f.updateInstructions).toHaveBeenCalledExactlyOnceWith({systemPrompt:'identity',mcpServers:{},skillMounts:snapshot.mounts});expect(f.updateInstructions.mock.calls[0]![0]).not.toHaveProperty(NATIVE_SKILLS_METADATA);
  expect(f.create).toHaveBeenCalledOnce();
  Object.assign(f.paseo.agents,{supportsNativeSkillMounts:()=>false});await expect(driver.configure(lane,next)).rejects.toMatchObject({code:'NATIVE_SKILL_MOUNTS_UNSUPPORTED'});expect(f.updateInstructions).toHaveBeenCalledOnce();
  await expect(driver.configure(lane,{provider:'codex/model',systemPrompt:'identity'})).rejects.toMatchObject({code:'NATIVE_SKILL_MOUNTS_UNSUPPORTED'});expect(f.updateInstructions).toHaveBeenCalledOnce();
});
