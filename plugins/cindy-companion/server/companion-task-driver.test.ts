import {expect,it,vi} from 'vitest';
import {NativeTaskDriver,type TaskLane} from './companion-task-driver';
import type {Paseo} from './runtime';
import {prepareLaneDispatch,type LaneDispatch} from './group-driver';

function fixture(){
 let snapshot:any=null,creation:any=null;
 const agent={refresh:vi.fn(async()=>snapshot),get archivedAt(){return snapshot?.archivedAt;},get cwd(){return snapshot?.cwd;},get workspaceId(){return snapshot?.workspaceId;},get status(){return snapshot?.status;},get activeTurn(){return snapshot?.activeTurn;},current:()=>snapshot,turns:{get:vi.fn(async()=>({agentId:'child',clientMessageId:'first',turnId:'turn',status:'unknown'}))},send:vi.fn(),interrupt:vi.fn()};
 const create=vi.fn(async(input:any)=>{snapshot={...input,workspaceId:'workspace',status:'idle'};creation={kind:'agent',agentId:'child',workspaceId:'workspace',idempotencyKey:input.idempotencyKey,phase:'completed',initialPrompt:{status:'accepted',clientMessageId:input.clientMessageId,turnId:'turn'}};return agent;});
 const capabilities={supportsInitialPromptReservation:vi.fn(()=>true),supportsTurnReceipts:vi.fn(()=>true)};
 const paseo={agents:{ref:()=>agent,create,...capabilities},creations:{get:vi.fn(async()=>creation)}} as unknown as Paseo;
 const lane:TaskLane={taskId:'task',parentAgentId:'caller',agentId:'child',operationId:'create-once',groupId:'',roundId:'task',botId:'cindy',cwd:'/owned/task',title:'Do work',config:{provider:'codex/test',modeId:'auto'},phase:'creating',nativeInputVersion:1,dispatch:prepareLaneDispatch('first')};
 const input={prompt:'Do the work',messageId:'first',signal:new AbortController().signal,recordDispatch:async(receipt:LaneDispatch)=>{lane.dispatch=structuredClone(receipt);}};
 return{agent,create,lane,input,capabilities,driver:new NativeTaskDriver(paseo),patch:(value:object)=>{snapshot={...snapshot,...value};}};
}
it('requires public first-prompt reservation before creating a visible native child',async()=>{
 const f=fixture();f.capabilities.supportsInitialPromptReservation.mockReturnValue(false);await expect(f.driver.ensure(f.lane,f.input)).rejects.toMatchObject({code:'HOST_UPGRADE_REQUIRED'});
 expect(f.create).not.toHaveBeenCalled();expect(f.agent.send).not.toHaveBeenCalled();
});
it('creates one visible child of the signed caller and rejects a changed native identity before stop',async()=>{
 const f=fixture();Object.assign(f.agent,{sendIfIdle:vi.fn()});
 expect(await f.driver.ensure(f.lane,f.input)).toEqual({workspaceId:'workspace'});await f.driver.ensure({...f.lane,phase:'ready'});
 expect(f.create).toHaveBeenCalledOnce();expect(f.create.mock.calls[0]![0]).toMatchObject({agentId:'child',parent:'caller',cwd:'/owned/task',idempotencyKey:'create-once',prompt:'Do the work',clientMessageId:'first',requireInitialPromptReservation:true,labels:{'cindy-companion.taskId':'task'}});expect(f.create.mock.calls[0]![0]).not.toHaveProperty('background');
 f.patch({cwd:'/another-task',status:'running',activeTurn:{turnId:'foreign'}});
 await expect(f.driver.stop(f.lane,f.input.recordDispatch)).rejects.toMatchObject({code:'TASK_SESSION_MISMATCH'});expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it('does not use legacy interrupt on an active visible child when exact-turn stop is unavailable',async()=>{
 const f=fixture();Object.assign(f.agent,{sendIfIdle:vi.fn()});await f.driver.ensure(f.lane,f.input);delete f.lane.dispatch;f.patch({status:'running',activeTurn:{turnId:'human-turn'}});
 await expect(f.driver.stop({...f.lane,phase:'ready',ownedTurnId:'task-turn',cancelMessageId:'cancel-once'})).rejects.toMatchObject({code:'TASK_STOP_REQUIRES_NATIVE'});expect(f.agent.interrupt).not.toHaveBeenCalled();
 const cancelTurn=vi.fn(async()=>({status:'unavailable' as const}));Object.assign(f.agent,{cancelTurn});
 await expect(f.driver.stop({...f.lane,phase:'ready',ownedTurnId:'task-turn',cancelMessageId:'cancel-once'})).rejects.toMatchObject({code:'TASK_STOP_REQUIRES_NATIVE'});expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it('targets only the persisted owned turn and accepts changed without stopping a later human turn',async()=>{
 const f=fixture();Object.assign(f.agent,{sendIfIdle:vi.fn()});await f.driver.ensure(f.lane,f.input);delete f.lane.dispatch;f.patch({status:'running',activeTurn:{turnId:'human-turn'}});
 const cancelTurn=vi.fn(async()=>({status:'changed' as const}));Object.assign(f.agent,{cancelTurn});
 await f.driver.stop({...f.lane,phase:'ready',ownedTurnId:'task-turn',cancelMessageId:'cancel-once'});
 expect(cancelTurn).toHaveBeenCalledWith({expectedTurnId:'task-turn',messageId:'cancel-once'});expect(f.agent.interrupt).not.toHaveBeenCalled();
});
