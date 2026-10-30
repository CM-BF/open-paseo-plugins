import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CompanionStore } from './store';
import { CompanionService } from './service';
import { CompanionError } from './errors';
import { lookupMainReception } from './group-reception';
import { outboxKey } from './group-outbox';
import type { GroupDriver } from './group-driver';
import type { Paseo } from './runtime';
const roots:string[]=[],services:CompanionService[]=[];
afterEach(async()=>{for(const service of services.splice(0))await service.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'cindy-reception-'));roots.push(root);const store=new CompanionStore(root);await store.load();const second=await store.create({name:'Partner'});
 const driver:GroupDriver={ensure:vi.fn(async()=>({workspaceId:'workspace'})),reply:vi.fn(async()=>{throw new CompanionError('PROVIDER_ADMISSION_UNAVAILABLE','fixture has no native admission');}),stop:vi.fn(async()=>{}),archive:vi.fn(async()=>{}),configure:vi.fn(async()=>{})};
 const service=new CompanionService(store,{groupDriver:()=>driver});services.push(service);service.runtime.setMcpFactory(async()=>({type:'http',url:'http://fixture.invalid'}));
 const paseo={providers:{waitForReady:async()=>({entries:[{provider:'codex',status:'ready',modes:[{id:'auto'}],models:[{id:'fixture',isDefault:true}]}]})}} as unknown as Paseo;
 const g=await service.groups.create(paseo,{operationId:'room',name:'Team',botIds:['cindy',second.id],replyMode:'mentioned'}),id=g.group.id;
 const rpc=async(op:string,args:Record<string,unknown>={})=>{const r=await service.invoke({op,args:{groupId:id,...args}},paseo);if(!r.ok)throw new CompanionError(r.code,r.message);return r.value as any;};
 const media=async(bytes=Buffer.from('document'))=>{const a=await rpc('groups.media.begin',{operationId:`upload-${bytes.toString()}`,name:'document.txt',mimeType:'text/plain',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});if(bytes.length)await rpc('groups.media.write',{uploadId:a.uploadId,offset:0,data:bytes.toString('base64')});return(await rpc('groups.media.complete',{uploadId:a.uploadId})).attachment;};
 const enqueue=(text:string,clientMessageId:string,extra:Record<string,unknown>={})=>rpc('groups.outbox.enqueue',{text,clientMessageId,operationId:`send-${clientMessageId}`,...extra});
 const settled=async(clientMessageId:string)=>{let entry:any;await vi.waitFor(async()=>{entry=(await rpc('groups.outbox.reconcile',{clientMessageId})).entry;expect(entry.status).toBe('sent');});return entry;};
 return{root,store,service,paseo,id,ids:['cindy',second.id],driver,rpc,media,enqueue,settled};
}
it('accepts attachment-only main messages once, freezes hashes and keeps message bytes after outbox discard',async()=>{
 const t=await setup(),a=await t.media();const [first,second]=await Promise.all([t.enqueue('','one',{attachments:[{mediaId:a.mediaId}]}),t.enqueue('','one',{attachments:[{mediaId:a.mediaId}]})]);expect(first.entry.clientMessageId).toBe(second.entry.clientMessageId);
 const sent=await t.settled('one'),state=await t.store.snapshot();expect(state.groups![t.id]!.messages).toHaveLength(1);expect(sent.target.kind).toBe('message');expect(state.groupMedia![a.mediaId]!.refs).toEqual([`message:${sent.target.messageId}`]);expect(state.groupMedia![a.mediaId]!.retained).toBe(false);
 expect((await t.rpc('groups.get')).group.lastMessage.attachments).toEqual([a]);expect(t.driver.ensure).not.toHaveBeenCalled();
 await t.rpc('groups.outbox.discard',{clientMessageId:'one',operationId:'discard'});expect((await t.rpc('groups.outbox.reconcile',{clientMessageId:'one'})).entry.status).toBe('discarded');
 expect((await t.rpc('groups.media.read',{mediaId:a.mediaId,messageId:sent.target.messageId,offset:0})).data).toBe(Buffer.from('document').toString('base64'));
 await expect(t.rpc('groups.media.read',{mediaId:a.mediaId,offset:0})).rejects.toMatchObject({code:'NOT_FOUND'});
 expect((await new CompanionStore(t.root).snapshot()).groups![t.id]!.messages[0]!.attachments).toEqual([a]);
});
it('keeps native attachment input explicitly blocked before creation, including quoted and topic roots',async()=>{
 const t=await setup(),a=await t.media();await t.enqueue('@all inspect','input',{attachments:[{mediaId:a.mediaId}]});const sent=await t.settled('input');
 await vi.waitFor(async()=>expect((await t.rpc('groups.get')).group.round).toMatchObject({status:'failed',code:'ATTACHMENT_INPUT_UNAVAILABLE'}));
 await t.enqueue('@Cindy explain','quote',{quote:{messageId:sent.target.messageId}});const quoted=await t.settled('quote');
 const row=(await t.rpc('groups.history.get',{messageIds:[quoted.target.messageId]})).messages.find((m:any)=>m.id===quoted.target.messageId);expect(row.quote).toMatchObject({attachmentCount:1,attachmentName:'document.txt'});
 await t.rpc('groups.threads.reply',{rootId:sent.target.messageId,text:'@Cindy topic',clientMessageId:'thread'});
 await vi.waitFor(async()=>expect((await t.rpc('groups.threads.get',{rootId:sent.target.messageId})).round).toMatchObject({status:'failed',code:'ATTACHMENT_INPUT_UNAVAILABLE'}));
 expect(t.driver.ensure).not.toHaveBeenCalled();expect(t.driver.reply).not.toHaveBeenCalled();expect(t.driver.stop).not.toHaveBeenCalled();
});
it('rejects unsupported work attachments before outbox admission and preserves the upload for editing',async()=>{
 const t=await setup(),a=await t.media();await expect(t.enqueue('arrange','division',{division:true,attachments:[{mediaId:a.mediaId}]})).rejects.toMatchObject({code:'ATTACHMENT_ROUTE_UNSUPPORTED'});
 const g=(await t.rpc('groups.get')).group;await t.rpc('groups.update',{expectedRevision:g.revision,replyMode:'all'});
 await t.rpc('groups.plans.create',{operationId:'plan',request:'Draft',steps:[{botId:'cindy',task:'Draft'}]});
 await expect(t.enqueue('revise','revision',{attachments:[{mediaId:a.mediaId}]})).rejects.toMatchObject({code:'ATTACHMENT_ROUTE_UNSUPPORTED'});
 const state=await t.store.snapshot();expect(Object.values(state.groupOutbox??{})).toHaveLength(0);expect(state.groupMedia![a.mediaId]!.retained).toBe(true);expect(t.driver.ensure).not.toHaveBeenCalled();
});
it('routes division and proposed revisions through durable original organizer receipts',async()=>{
 const t=await setup();await t.enqueue('Please arrange the work','division',{division:true});const sent=await t.settled('division');expect(sent.target.kind).toBe('plan-request');
 await vi.waitFor(async()=>expect((await t.store.snapshot()).groupPlanRequests![sent.target.requestId]!.view.status).toBe('failed'));
 const direct=await t.rpc('groups.plans.create',{operationId:'direct',request:'Draft',steps:[{botId:'cindy',task:'Draft'}]});
 const g=(await t.rpc('groups.get')).group;await t.rpc('groups.update',{expectedRevision:g.revision,replyMode:'all'});
 await t.enqueue('Please change the arrangement','revision');const revised=await t.settled('revision');expect(revised.target.kind).toBe('plan-request');
 const state=await t.store.snapshot();expect(state.groupPlanRequests![revised.target.requestId]!.supersedesPlanId).toBe(direct.plan.id);
 expect(lookupMainReception(state,state.groupOutbox![outboxKey(t.id,'revision')]!.view.input)).toEqual(revised.target);
 await t.enqueue('Please change the arrangement','revision');expect((await t.store.snapshot()).groups![t.id]!.messages.filter(m=>m.content==='Please change the arrangement')).toHaveLength(1);
});
it('recovers a sent message from its durable receipt after lost acceptance ACK without another send',async()=>{
 const t=await setup();await t.enqueue('original','once');const sent=await t.settled('once');await t.service.close();
 await t.store.transaction(state=>{const saved=state.groupOutbox![outboxKey(t.id,'once')]!;saved.view.status='sending';delete saved.view.target;});
 const store=new CompanionStore(t.root),service=new CompanionService(store,{groupDriver:()=>t.driver});services.push(service);
 const result=await service.invoke({op:'groups.outbox.list',args:{groupId:t.id}},t.paseo);expect(result.ok).toBe(true);if(result.ok)expect((result.value as any).entries[0]).toMatchObject({status:'sent',target:sent.target});
 expect((await store.snapshot()).groups![t.id]!.messages.filter(m=>m.content==='original')).toHaveLength(1);expect(t.driver.reply).not.toHaveBeenCalled();
});
it('routes waiting-plan notes once and reconciles the original message after the plan changes',async()=>{
 const t=await setup();const g=(await t.rpc('groups.get')).group;await t.rpc('groups.update',{expectedRevision:g.revision,replyMode:'all'});
 const result=await t.rpc('groups.plans.create',{operationId:'direct',request:'Draft',steps:[{botId:'cindy',task:'Draft'}]});
 // Persist a real awaiting-input plan boundary without starting a provider fixture.
 await t.store.transaction(s=>{const p=s.groupPlans![result.plan.id]!;p.view.status='waiting';p.view.currentStep=0;p.view.steps[0]!.status='done';p.view.execution={state:'idle'};});
 await t.enqueue('Refine the output','note');const sent=await t.settled('note');expect(sent.target).toMatchObject({kind:'plan-note',planId:result.plan.id});
 await t.enqueue('Refine the output','note');const state=await t.store.snapshot();expect(state.groupPlans![result.plan.id]!.notes.filter(n=>n.operationId==='note')).toHaveLength(1);expect(lookupMainReception(state,state.groupOutbox![outboxKey(t.id,'note')]!.view.input)).toEqual(sent.target);
});
it('tombstones owned media on group deletion and replays cleanup without native mutation',async()=>{
 const t=await setup(),a=await t.media();const g=(await t.rpc('groups.get')).group;await t.rpc('groups.delete',{expectedRevision:g.revision});
 await expect(stat(join(t.root,'group-media',`${a.mediaId}.bin`))).rejects.toMatchObject({code:'ENOENT'});
 const state=await new CompanionStore(t.root).snapshot();expect(state.groupMedia![a.mediaId]).toMatchObject({phase:'cancelled',retained:false,cleaned:true,refs:[]});
 expect(await t.rpc('groups.delete',{expectedRevision:g.revision})).toMatchObject({deleted:true});await expect(t.rpc('groups.media.read',{mediaId:a.mediaId,offset:0})).rejects.toMatchObject({code:'NOT_FOUND'});expect(t.driver.archive).not.toHaveBeenCalled();
});
it('adopts an existing direct-send receipt before mutable work routing and rejects conflicting identities before queuing',async()=>{
 const t=await setup();const original=await t.rpc('groups.send',{text:'before plan',clientMessageId:'prior'});
 const g=(await t.rpc('groups.get')).group;await t.rpc('groups.update',{expectedRevision:g.revision,replyMode:'all'});
 await t.rpc('groups.plans.create',{operationId:'direct',request:'Draft',steps:[{botId:'cindy',task:'Draft'}]});
 const accepted=await t.enqueue('before plan','prior');expect(accepted.entry).toMatchObject({status:'sent',target:{kind:'message',messageId:original.message.id}});
 await expect(t.enqueue('changed','prior')).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 await expect(t.enqueue('before plan','prior',{division:true})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 expect(Object.keys((await t.store.snapshot()).groupPlanRequests??{})).toHaveLength(0);expect(t.driver.ensure).not.toHaveBeenCalled();
});
it('returns failed outbox attachments to an editable draft atomically without reviving the old send',async()=>{
 const t=await setup(),a=await t.media();const failing=vi.spyOn(t.service.groups,'send').mockRejectedValueOnce(new CompanionError('GROUP_BUSY','wait'));
 await t.enqueue('draft','failed',{attachments:[{mediaId:a.mediaId}]});await vi.waitFor(async()=>expect((await t.rpc('groups.outbox.reconcile',{clientMessageId:'failed'})).entry.status).toBe('failed'));failing.mockRestore();
 const input={clientMessageId:'failed',operationId:'edit'};expect((await t.rpc('groups.outbox.edit',input)).entry.status).toBe('discarded');
 expect((await t.store.snapshot()).groupMedia![a.mediaId]).toMatchObject({retained:true,refs:[],phase:'sealed'});
 expect((await t.rpc('groups.media.read',{mediaId:a.mediaId,offset:0})).data).toBe(Buffer.from('document').toString('base64'));
 await t.enqueue('edited','new',{attachments:[{mediaId:a.mediaId}]});const sent=await t.settled('new');
 expect((await t.rpc('groups.outbox.edit',input)).entry.status).toBe('discarded');
 expect((await t.store.snapshot()).groupMedia![a.mediaId]).toMatchObject({retained:false,refs:[`message:${sent.target.messageId}`]});
 expect((await t.enqueue('draft','failed',{attachments:[{mediaId:a.mediaId}]})).entry.status).toBe('discarded');
 await expect(t.rpc('groups.outbox.edit',{clientMessageId:'new',operationId:'cannot-edit-sent'})).rejects.toMatchObject({code:'OUTBOX_NOT_EDITABLE'});
 expect((await t.store.snapshot()).groups![t.id]!.messages.filter(m=>m.authorKind==='user').map(m=>m.content)).toEqual(['edited']);
});
it('fences group deletion while reception is unknown and retains its exact attachment reference',async()=>{
 const t=await setup(),a=await t.media();vi.spyOn(t.service.groups,'send').mockRejectedValueOnce(new Error('lost reception outcome'));
 await t.enqueue('uncertain','unknown',{attachments:[{mediaId:a.mediaId}]});await vi.waitFor(async()=>expect((await t.rpc('groups.outbox.reconcile',{clientMessageId:'unknown'})).entry.status).toBe('unknown'));
 const g=(await t.rpc('groups.get')).group;await expect(t.rpc('groups.delete',{expectedRevision:g.revision})).rejects.toMatchObject({code:'OUTBOX_OUTCOME_UNKNOWN'});
 await expect(t.rpc('groups.outbox.edit',{clientMessageId:'unknown',operationId:'edit'})).rejects.toMatchObject({code:'OUTBOX_OUTCOME_UNKNOWN'});
 const state=await t.store.snapshot();expect(state.groups![t.id]!.deletedAt).toBeUndefined();expect(state.groups![t.id]!.mutation).toBeUndefined();expect(state.groupMedia![a.mediaId]!.refs).toEqual([`outbox:${outboxKey(t.id,'unknown')}`]);expect((await t.rpc('groups.media.read',{mediaId:a.mediaId,offset:0})).data).toBe(Buffer.from('document').toString('base64'));
});
it('replays an old upload cancel after outbox edit and filesystem reopen without revoking the restored draft',async()=>{
 const t=await setup(),a=await t.media();vi.spyOn(t.service.groups,'send').mockRejectedValueOnce(new CompanionError('GROUP_BUSY','wait'));
 await t.enqueue('retained draft','failed-edit',{attachments:[{mediaId:a.mediaId}]});await vi.waitFor(async()=>expect((await t.rpc('groups.outbox.reconcile',{clientMessageId:'failed-edit'})).entry.status).toBe('failed'));
 const cancel={uploadId:a.mediaId,operationId:'old-cancel'};
 expect(await t.rpc('groups.media.cancel',cancel)).toEqual({cancelled:true,retained:true});
 await t.rpc('groups.outbox.edit',{clientMessageId:'failed-edit',operationId:'restore'});await t.service.close();
 const store=new CompanionStore(t.root),service=new CompanionService(store,{groupDriver:()=>t.driver});services.push(service);
 const invoke=(op:string,args:Record<string,unknown>)=>service.invoke({op,args:{groupId:t.id,...args}},t.paseo);
 expect(await invoke('groups.media.cancel',cancel)).toMatchObject({ok:true,value:{cancelled:true,retained:true}});
 expect((await store.snapshot()).groupMedia![a.mediaId]).toMatchObject({phase:'sealed',retained:true,refs:[]});
 expect(await invoke('groups.media.read',{mediaId:a.mediaId,offset:0})).toMatchObject({ok:true,value:{data:Buffer.from('document').toString('base64')}});
 expect(await invoke('groups.media.cancel',{...cancel,operationId:'new-user-cancel'})).toMatchObject({ok:true,value:{cancelled:true,retained:false}});
 await expect(stat(join(t.root,'group-media',`${a.mediaId}.bin`))).rejects.toMatchObject({code:'ENOENT'});
});
