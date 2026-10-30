import {vi} from 'vitest';
import {NativeGroupDriver} from '../group-driver';
import type {Paseo} from '../runtime';
/** Real driver with public first-prompt/queue/turn receipt boundaries; never connects to a daemon. */
export function nativeLaneFixture(){
 let snapshot:any=null,creation:any=null,receipt:any=null;const stream=new Set<(event:any)=>void>(),listeners=new Set<()=>void>();
 const admission=vi.fn(async()=>({status:'accepted' as const,turnId:'owned-turn'}));
 const agent={get id(){return snapshot?.id;},get cwd(){return snapshot?.cwd;},get archivedAt(){return snapshot?.archivedAt;},get workspaceId(){return snapshot?.workspaceId;},get status(){return snapshot?.status;},get activeTurn(){return snapshot?.activeTurn;},get pendingPermissions(){return snapshot?.pendingPermissions??[];},
  refresh:vi.fn(async()=>snapshot),subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},send:vi.fn(),interrupt:vi.fn(),archive:vi.fn(),sendIfIdle:vi.fn(),
  inputs:{enqueue:vi.fn(async(_input:unknown,options:{messageId:string})=>{receipt={agentId:snapshot.id,clientMessageId:options.messageId,status:'unknown'};const value=await admission();receipt=value.status==='accepted'?{...receipt,status:'started',turnId:value.turnId}:{...receipt,status:'not_sent',code:'PROVIDER_QUEUE_UNAVAILABLE'};return receipt;}),get:vi.fn(async()=>receipt),cancel:vi.fn(async(input:{operationId:string})=>({...receipt,operationId:input.operationId,status:'unknown'})),getCancellation:vi.fn(async(input:{operationId:string})=>({...receipt,operationId:input.operationId,status:'unknown'}))},
  turns:{get:vi.fn(async(input:{turnId:string})=>({agentId:snapshot.id,clientMessageId:receipt?.clientMessageId??creation?.initialPrompt?.clientMessageId??null,turnId:input.turnId,status:'unknown'}))},
  cancelTurn:vi.fn(async()=>({status:'unavailable' as 'unavailable'|'changed'|'cancelled'})),timeline:{subscribe:(fn:(event:any)=>void)=>{stream.add(fn);return Object.assign(()=>stream.delete(fn),{ready:Promise.resolve()});},refetch:vi.fn(async()=>({entries:[],error:null,hasOlder:false}))}};
 const paseo={agents:{ref:()=>agent,supportsInitialPromptReservation:()=>true,supportsTurnReceipts:()=>true,supportsQueuedInputs:()=>true,create:vi.fn(async(input:any)=>{
  snapshot={id:input.agentId,cwd:input.cwd,workspaceId:'workspace',status:'idle',activeTurn:null};creation={kind:'agent',agentId:input.agentId,workspaceId:'workspace',idempotencyKey:input.idempotencyKey,phase:'completed',initialPrompt:{clientMessageId:input.clientMessageId,status:'unknown'}};
  const value=await admission();creation.initialPrompt=value.status==='accepted'?{clientMessageId:input.clientMessageId,status:'accepted',turnId:value.turnId}:{clientMessageId:input.clientMessageId,status:'not_sent',error:'PROVIDER_QUEUE_UNAVAILABLE'};return agent;
 })},creations:{get:vi.fn(async()=>creation)}} as unknown as Paseo;
 const patch=(value:object)=>{snapshot={...snapshot,...value};for(const fn of listeners)fn();};
 const event=(value:object)=>{for(const fn of stream)fn({event:value});};
 return{driver:new NativeGroupDriver(paseo),paseo,agent,admission,patch,event};
}
