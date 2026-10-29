import {vi} from 'vitest';
import {NativeGroupDriver} from '../group-driver';
import type {Paseo} from '../runtime';
/** Real driver with a public-API-shaped host boundary; never connects to a daemon. */
export function nativeLaneFixture(){
 let snapshot:any=null;const stream=new Set<(event:any)=>void>(),listeners=new Set<()=>void>();
 const sendIfIdle=vi.fn(async()=>({status:'accepted' as const,turnId:'owned-turn'}));
 const agent={get id(){return snapshot?.id;},get cwd(){return snapshot?.cwd;},get archivedAt(){return snapshot?.archivedAt;},get workspaceId(){return snapshot?.workspaceId;},get status(){return snapshot?.status;},get activeTurn(){return snapshot?.activeTurn;},get pendingPermissions(){return snapshot?.pendingPermissions??[];},
  refresh:vi.fn(async()=>snapshot),subscribe:(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);},send:vi.fn(),interrupt:vi.fn(),archive:vi.fn(),sendIfIdle,
  cancelTurn:vi.fn(async()=>({status:'unavailable' as 'unavailable'|'changed'|'cancelled'})),timeline:{subscribe:(fn:(event:any)=>void)=>{stream.add(fn);return Object.assign(()=>stream.delete(fn),{ready:Promise.resolve()});},refetch:vi.fn(async()=>({entries:[],error:null,hasOlder:false}))}};
 const paseo={agents:{ref:()=>agent,create:vi.fn(async(input:any)=>{snapshot={id:input.agentId,cwd:input.cwd,workspaceId:'workspace',status:'idle',activeTurn:null};return agent;})}} as unknown as Paseo;
 const patch=(value:object)=>{snapshot={...snapshot,...value};for(const fn of listeners)fn();};
 const event=(value:object)=>{for(const fn of stream)fn({event:value});};
 return{driver:new NativeGroupDriver(paseo),agent,sendIfIdle,patch,event};
}
