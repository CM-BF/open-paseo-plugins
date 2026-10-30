import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionStore } from './store';
import { GroupOutbox, outboxKey, type GroupMessageReceiver } from './group-outbox';
import { CompanionError } from './errors';
import type { Paseo } from './runtime';
import type { GroupOutboxInput, GroupOutboxTarget } from '../shared/group-outbox';
const roots:string[]=[],boxes:GroupOutbox[]=[];const paseo={} as Paseo;
afterEach(async()=>{for(const box of boxes.splice(0))await box.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
async function setup(accept?:(input:GroupOutboxInput,save:()=>Promise<GroupOutboxTarget>)=>Promise<GroupOutboxTarget>){
  const root=await mkdtemp(join(tmpdir(),'cindy-outbox-'));roots.push(root);const store=new CompanionStore(root);await store.load();
  await store.transaction(s=>{s.groups={g:{id:'g',name:'G',description:'',botIds:['cindy'],replyMode:'mentioned',revision:1,createdAt:1,updatedAt:1,messages:[],rounds:[],lanes:{},receipts:{},continueKeys:{}}};});
  const calls:string[]=[];
  const receiver:GroupMessageReceiver={lookup:(s,input)=>{const target=s.groups!.g!.messages.find(m=>m.content===`receipt:${input.clientMessageId}`);return target?{kind:'message',messageId:target.id}:null;},accept:async input=>{
    calls.push(input.clientMessageId);const save=()=>store.transaction(s=>{const id=`m-${input.clientMessageId}`;s.groups!.g!.messages.push({id,content:`receipt:${input.clientMessageId}`,kind:'message',sequence:s.groups!.g!.messages.length+1,authorKind:'user',authorName:'You',createdAt:1});return{kind:'message' as const,messageId:id};});return accept?accept(input,save):save();}};
  const box=new GroupOutbox(store,receiver);boxes.push(box);return{root,store,box,receiver,calls};
}
const input=(id='one')=>({groupId:'g',clientMessageId:id,operationId:`enqueue-${id}`,text:`Text ${id}`});
async function status(t:Awaited<ReturnType<typeof setup>>,id='one'){return(await t.store.snapshot()).groupOutbox![outboxKey('g',id)]!.view.status;}
it('durably queues before return, serializes one group and recovers a lost acceptance ACK without duplicate send',async()=>{
  const hold=barrier();let once=true;const t=await setup(async(_i,save)=>{if(once){once=false;await hold.promise;await save();throw new Error('lost ACK');}return save();});
  const a=await t.box.enqueue(input(),paseo);expect(a.entry.status).toBe('queued');expect((await new CompanionStore(t.root).snapshot()).groupOutbox![outboxKey('g','one')]).toBeDefined();
  await t.box.enqueue(input('two'),paseo);await vi.waitFor(()=>expect(t.calls).toEqual(['one']));
  expect((await t.box.reconcile('g',{clientMessageId:'one'})).entry.status).toBe('sending');hold.resolve();
  await vi.waitFor(async()=>expect(await status(t,'two')).toBe('sent'));expect(t.calls).toEqual(['one','two']);
  const replay=await t.box.enqueue(input(),paseo);expect(replay.entry.target).toEqual({kind:'message',messageId:'m-one'});expect(t.calls).toHaveLength(2);
  await expect(t.box.enqueue({...input(),text:'different'},paseo)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it.each(['reconcile','mutation replay'] as const)('keeps another orphaned send recoverable after an unrelated %s',async action=>{
 const t=await setup(async(i,save)=>{if(i.clientMessageId==='old')return save();throw new Error('unknown reception');});
 await t.box.enqueue(input('old'),paseo);await vi.waitFor(async()=>expect(await status(t,'old')).toBe('sent'));
 const discard={clientMessageId:'old',operationId:'old-discard'};await t.box.mutate('discard','g',discard,paseo);
 await (t.box as unknown as {jobs:Map<string,Promise<void>>}).jobs.get('g');
 const original=t.store.transaction.bind(t.store);let failed=false;
 const mock=vi.spyOn(t.store,'transaction').mockImplementation(async run=>original(async state=>{
   const result=await run(state);if(state.groupOutbox?.[outboxKey('g','one')]?.view.status==='unknown'){failed=true;throw new Error('settlement disk failure');}return result;
 }));
 await t.box.enqueue(input(),paseo);await vi.waitFor(()=>expect(failed).toBe(true));
 await (t.box as unknown as {jobs:Map<string,Promise<void>>}).jobs.get('g');mock.mockRestore();
 expect(await status(t)).toBe('sending');
 if(action==='reconcile')await t.box.reconcile('g',{clientMessageId:'old'});else await t.box.mutate('discard','g',discard,paseo);
 await (t.box as unknown as {jobs:Map<string,Promise<void>>}).jobs.get('g');
 expect((await t.box.list('g',{},paseo)).entries.find(e=>e.clientMessageId==='one')).toMatchObject({status:'unknown',recovery:'reconcile'});
 expect(t.calls).toEqual(['old','one']);
});
it('retains unknown crash-before-ACK input across actual filesystem reopen and never replays from an idle/list observation',async()=>{
  const hold=barrier(),entered=barrier();const t=await setup(async()=>{entered.resolve();await hold.promise;throw new Error('unknown');});await t.box.enqueue(input(),paseo);await entered.promise;
  const reopenedStore=new CompanionStore(t.root), calls:string[]=[];const reopened=new GroupOutbox(reopenedStore,{lookup:()=>null,accept:async i=>{calls.push(i.clientMessageId);return{kind:'message',messageId:'bad'};}});boxes.push(reopened);
  const page=await reopened.list('g',{groupId:'g'},paseo);expect(page.entries[0]).toMatchObject({status:'unknown',recovery:'reconcile'});
  await expect(reopened.mutate('retry','g',{clientMessageId:'one',operationId:'retry'},paseo)).rejects.toMatchObject({code:'OUTBOX_OUTCOME_UNKNOWN'});
  expect((await reopened.reconcile('g',{clientMessageId:'one'})).entry.status).toBe('unknown');expect(calls).toEqual([]);hold.resolve();await t.box.close();
});
it('replays retry/discard mutation identities after their effects settle and rejects changed reuse',async()=>{
  let failure=true;const t=await setup(async(_i,save)=>{if(failure)throw new CompanionError('GROUP_BUSY','Wait');return save();});await t.box.enqueue(input(),paseo);await vi.waitFor(async()=>expect(await status(t)).toBe('failed'));
  failure=false;const retry={clientMessageId:'one',operationId:'retry'};await t.box.mutate('retry','g',retry,paseo);await vi.waitFor(async()=>expect(await status(t)).toBe('sent'));
  expect((await t.box.mutate('retry','g',retry,paseo)).entry.status).toBe('sent');expect(t.calls).toHaveLength(2);
  await expect(t.box.mutate('discard','g',retry,paseo)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  const discard={clientMessageId:'one',operationId:'discard'};await t.box.mutate('discard','g',discard,paseo);await t.box.close();
  const reopened=new GroupOutbox(new CompanionStore(t.root),t.receiver);boxes.push(reopened);expect((await reopened.mutate('discard','g',discard,paseo)).entry.status).toBe('discarded');
  expect((await reopened.enqueue(input(),paseo)).entry.status).toBe('discarded');expect(t.calls).toHaveLength(2);
});
it('pages all valid large UTF-8 entries by a monotonic cursor without dropping bodies',async()=>{
  const t=await setup();await t.box.close();
  await t.store.transaction(s=>{s.groupOutbox={};for(let i=1;i<=80;i++){const base={...input(String(i)),text:'中'.repeat(8000)};s.groupOutbox[outboxKey('g',String(i))]={fingerprint:'unused',mutations:{},view:{groupId:'g',clientMessageId:String(i),sequence:i,input:base,attachments:[],status:'sent',revision:1,createdAt:1,updatedAt:1,recovery:'none'}};}});
  const reopened=new GroupOutbox(t.store,t.receiver);boxes.push(reopened);let before:number|undefined;const all=[];
  do{const page=await reopened.list('g',{limit:100,...(before?{before}:{})},paseo);expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1_700_000);all.push(...page.entries);before=page.nextBefore??undefined;}while(before);
  expect(all).toHaveLength(80);expect(new Set(all.map(e=>e.clientMessageId)).size).toBe(80);expect(all.every(e=>e.input.text==='中'.repeat(8000))).toBe(true);
});
it('close drains accepted receiver work, keeps queued successors durable and rejects new requests',async()=>{
  const hold=barrier(),entered=barrier();const t=await setup(async(_i,save)=>{entered.resolve();await hold.promise;return save();});await t.box.enqueue(input(),paseo);await entered.promise;await t.box.enqueue(input('two'),paseo);
  const close=t.box.close();let settled=false;void close.then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);hold.resolve();await close;
  expect(await status(t)).toBe('sent');expect(await status(t,'two')).toBe('queued');expect(()=>t.box.list('g',{},paseo)).toThrow(/closing/);
});
it('keeps room order while an independent room can receive during an unresolved first-room send',async()=>{
 const t=await setup();await t.box.close();await t.store.transaction(s=>{s.groups!.other={...structuredClone(s.groups!.g!),id:'other'};});
 const held=barrier(),entered=barrier(),calls:string[]=[];
 const receiver:GroupMessageReceiver={lookup:(s,i)=>{const m=s.groups![i.groupId]!.messages.find(m=>m.id===i.clientMessageId);return m?{kind:'message',messageId:m.id}:null;},accept:async i=>{
   calls.push(i.groupId);if(i.groupId==='g'){entered.resolve();await held.promise;}
   return t.store.transaction(s=>{s.groups![i.groupId]!.messages.push({id:i.clientMessageId,sequence:1,content:i.text,authorKind:'user',authorName:'You',kind:'message',createdAt:1});return{kind:'message',messageId:i.clientMessageId};});
 }};
 const box=new GroupOutbox(t.store,receiver);boxes.push(box);await box.enqueue(input(),paseo);await entered.promise;
 await box.enqueue({...input('other'),groupId:'other'},paseo);
 await vi.waitFor(async()=>expect((await t.store.snapshot()).groupOutbox![outboxKey('other','other')]!.view.status).toBe('sent'));
 expect(calls).toEqual(['g','other']);held.resolve();await box.close();
});
it('recovers a reception receipt after both settlement writes fail without leaving an orphaned sending row',async()=>{
 const t=await setup(),original=t.store.transaction.bind(t.store);let writes=0;
 const mock=vi.spyOn(t.store,'transaction').mockImplementation(async run=>{if([4,5].includes(++writes))throw new Error('disk temporarily unavailable');return original(run);});
 await t.box.enqueue(input(),paseo);await vi.waitFor(async()=>{expect(t.calls).toHaveLength(1);expect(writes).toBeGreaterThanOrEqual(5);});mock.mockRestore();
 let page:Awaited<ReturnType<GroupOutbox['list']>>|undefined;
 await vi.waitFor(async()=>{page=await t.box.list('g',{},paseo);expect(page.entries[0]!.status).toBe('sent');});
 expect(page!.entries[0]!.target).toEqual({kind:'message',messageId:'m-one'});expect(t.calls).toHaveLength(1);
});
it('reconcile before list converts an orphaned send to unknown after its failure settlement could not persist',async()=>{
 const t=await setup(async()=>{throw new Error('reception outcome unknown');});
 const original=t.store.transaction.bind(t.store);let failed=false;
 const mock=vi.spyOn(t.store,'transaction').mockImplementation(async run=>original(async state=>{
   const result=await run(state);if(state.groupOutbox?.[outboxKey('g','one')]?.view.status==='unknown'){failed=true;throw new Error('settlement disk failure');}return result;
 }));
 await t.box.enqueue(input(),paseo);await vi.waitFor(()=>expect(failed).toBe(true));
 // Wait for the admitted receiver job itself, not an arbitrary timer.
 await (t.box as unknown as {jobs:Map<string,Promise<void>>}).jobs.get('g');mock.mockRestore();
 expect(await status(t)).toBe('sending');
 expect((await t.box.reconcile('g',{clientMessageId:'one'})).entry).toMatchObject({status:'unknown',recovery:'reconcile',error:{code:'OUTBOX_OUTCOME_UNKNOWN'}});
 expect((await t.box.list('g',{},paseo)).entries[0]!.status).toBe('unknown');
 await expect(t.box.mutate('retry','g',{clientMessageId:'one',operationId:'retry'},paseo)).rejects.toMatchObject({code:'OUTBOX_OUTCOME_UNKNOWN'});
 expect(t.calls).toEqual(['one']);
 const reopened=new GroupOutbox(new CompanionStore(t.root),t.receiver);boxes.push(reopened);
 expect((await reopened.reconcile('g',{clientMessageId:'one'})).entry.status).toBe('unknown');expect(t.calls).toEqual(['one']);
});
