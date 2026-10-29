import { createHash } from 'node:crypto';
import type { GroupOutboxEntry, GroupOutboxInput, GroupOutboxPage, GroupOutboxTarget } from '../shared/group-outbox';
import type { CompanionStore, SavedState } from './store';
import type { Paseo } from './runtime';
import { CompanionError, record, string, throwIpcError } from './errors';
import { parseTrackedMentions } from './groups';
import { adoptGroupMedia, mediaGroup, parseMediaInputs, pinGroupMedia, releaseGroupMedia, retainGroupMediaDraft } from './group-media';

export interface SavedGroupOutbox { view: GroupOutboxEntry; fingerprint: string; mutations: Record<string, { fingerprint: string }> }
export interface GroupMessageReceiver {
  /** The same production main/quoted/work routing as a direct user send. */
  accept(input: GroupOutboxInput, paseo: Paseo): Promise<GroupOutboxTarget>;
  /** Only local durable acceptance receipts. Never starts, stops or creates a native session. */
  lookup(state: SavedState, input: GroupOutboxInput): GroupOutboxTarget | null;
  validate?(state: SavedState, input: GroupOutboxInput): void;
  collect?(groupId:string):Promise<void>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const outboxKey = (groupId: string, clientMessageId: string) => hash([groupId, clientMessageId]);
function params(args: Record<string, unknown>, keys: string[]) { if (Object.keys(args).some(key => !keys.includes(key))) throwIpcError('INVALID_PARAMS', 'Unsupported outbox parameter'); }
export function outboxInput(args: Record<string, unknown>): GroupOutboxInput {
  params(args, ['groupId','clientMessageId','operationId','text','trackedMentions','quote','attachments','division']);
  const groupId=string(args.groupId,'groupId',200),clientMessageId=string(args.clientMessageId,'clientMessageId',200);
  const text=string(args.text,'text',32000,true),trackedMentions=parseTrackedMentions(args.trackedMentions),attachments=parseMediaInputs(args.attachments);
  if(text.length>8000||(!text.trim()&&!attachments.length))throwIpcError('INVALID_PARAMS','A message needs text or attachments');
  if(args.division!==undefined&&typeof args.division!=='boolean')throwIpcError('INVALID_PARAMS','Invalid division flag');
  let quote:GroupOutboxInput['quote'];if(args.quote!==undefined){const raw=record(args.quote);params(raw,['messageId']);quote={messageId:string(raw.messageId,'quoted message',100)};}
  if(quote&&args.division)throwIpcError('INVALID_PARAMS','A work request cannot also be a quoted reply');
  return{groupId,clientMessageId,text,trackedMentions,...(attachments.length?{attachments}:{}),...(quote?{quote}:{}),...(args.division?{division:true}:{})};
}
function entry(state:SavedState,groupId:string,clientMessageId:string){
  mediaGroup(state,groupId,true);const saved=state.groupOutbox?.[outboxKey(groupId,clientMessageId)];
  if(!saved)throwIpcError('NOT_FOUND','Outbox message not found');return saved;
}
function touch(saved:SavedGroupOutbox){saved.view.revision++;saved.view.updatedAt=Date.now();}
function hasSending(state:SavedState,groupId:string){return Object.values(state.groupOutbox??{}).some(saved=>saved.view.groupId===groupId&&saved.view.status==='sending');}
function contentFingerprint(input:GroupOutboxInput,attachments:Array<{mediaId:string;sha256:string}>){
  return hash(input.attachments?.length?[input,input.attachments.map(item=>({mediaId:item.mediaId,sha256:attachments.find(a=>a.mediaId===item.mediaId)?.sha256}))]:input);
}
function accepted(state:SavedState,saved:SavedGroupOutbox,target:GroupOutboxTarget){
  saved.view.target=target;if(saved.view.status!=='discarded')saved.view.status='sent';saved.view.recovery='none';delete saved.view.error;touch(saved);
  releaseGroupMedia(state,saved.view.groupId,`outbox:${outboxKey(saved.view.groupId,saved.view.clientMessageId)}`);
}
const definite = new Set(['INVALID_PARAMS','IDEMPOTENCY_CONFLICT','NOT_FOUND','GROUP_BUSY','PLAN_OPEN','MEMBER_UNAVAILABLE','QUOTE_UNAVAILABLE','MEDIA_UNAVAILABLE','ATTACHMENT_ROUTE_UNSUPPORTED','PRECONDITION_FAILED','PLAN_CLOSED']);

/** Cindy's durable sent-message outbox; unsent composer drafts are deliberately separate. */
export class GroupOutbox {
  private jobs=new Map<string,Promise<void>>();private operations=new Set<Promise<unknown>>();
  private kicks=new Set<string>();private failures=new Map<string,string>();
  private initialization:Promise<void>|null=null;private closed=false;
  constructor(private readonly store:CompanionStore,private readonly receiver:GroupMessageReceiver){}
  private admit<T>(run:()=>Promise<T>){
    if(this.closed)throwIpcError('PLUGIN_CLOSED','Outbox is closing');
    const promise=Promise.resolve().then(run);this.operations.add(promise);void promise.finally(()=>this.operations.delete(promise)).catch(()=>{});return promise;
  }
  async close(){this.closed=true;await Promise.allSettled([...this.operations]);await Promise.allSettled([...this.jobs.values()]);}
  private init(){
    this.initialization??=(async()=>{
      const state=await this.store.snapshot();if(!Object.values(state.groupOutbox??{}).some(saved=>saved.view.status==='sending'))return;
      await this.store.transaction(s=>{for(const saved of Object.values(s.groupOutbox??{}))if(saved.view.status==='sending'){
        const target=this.receiver.lookup(s,saved.view.input);if(target)accepted(s,saved,target);
        else{saved.view.status='unknown';saved.view.recovery='reconcile';saved.view.error={code:'OUTBOX_OUTCOME_UNKNOWN',message:'Message reception was interrupted; reconcile before sending again'};touch(saved);}
      }});
    })();return this.initialization;
  }
  enqueue(args:Record<string,unknown>,paseo:Paseo){return this.admit(async()=>{
    await this.init();const input=outboxInput(args),operation=string(args.operationId,'operationId',200),id=outboxKey(input.groupId,input.clientMessageId);
    const value=await this.store.transaction(state=>{
      mediaGroup(state,input.groupId);const prior=state.groupOutbox?.[id];
      if(prior){if(prior.fingerprint!==contentFingerprint(input,prior.view.attachments))throwIpcError('IDEMPOTENCY_CONFLICT','Outbox message content is immutable');return prior.view;}
      const target=this.receiver.lookup(state,input);
      if(!target)this.receiver.validate?.(state,input);
      if(Object.values(state.groupOutbox??{}).filter(s=>s.view.groupId===input.groupId&&!['sent','discarded'].includes(s.view.status)).length>=1000)throwIpcError('OUTBOX_LIMIT','Resolve existing outbox messages before sending more');
      const attachments=target?(target.kind==='message'?structuredClone(state.groups![input.groupId]!.messages.find(message=>message.id===target.messageId)?.attachments??[]):[]):pinGroupMedia(state,input.groupId,input.attachments??[],`outbox:${id}`),now=Date.now();
      const fingerprint=contentFingerprint(input,attachments);
      if(!target)adoptGroupMedia(state,input.groupId,input.attachments??[]);
      const view:GroupOutboxEntry={clientMessageId:input.clientMessageId,groupId:input.groupId,input,attachments,status:target?'sent':'queued',sequence:state.outboxSequence=(state.outboxSequence??0)+1,revision:1,createdAt:now,updatedAt:now,recovery:target?'none':'retry',...(target?{target}:{})};
      (state.groupOutbox??={})[id]={view,fingerprint,mutations:{[hash(operation)]:{fingerprint:hash(['enqueue',fingerprint])}}};return view;
    });
    this.launch(input.groupId,paseo);return{accepted:true as const,entry:value};
  });}
  list(groupId:string,args:Record<string,unknown>,paseo:Paseo){return this.admit(async()=>{
    await this.init();params(args,['groupId','before','limit']);
    if(this.failures.has(groupId)&&!this.jobs.has(groupId)){
      await this.store.transaction(state=>{mediaGroup(state,groupId,true);for(const saved of Object.values(state.groupOutbox??{}))if(saved.view.groupId===groupId&&saved.view.status==='sending'){
        const target=this.receiver.lookup(state,saved.view.input);if(target)accepted(state,saved,target);
        else{saved.view.status='unknown';saved.view.recovery='reconcile';saved.view.error={code:'OUTBOX_OUTCOME_UNKNOWN',message:'Message reception is not confirmed; reconcile without sending a new copy'};touch(saved);}
      }});this.failures.delete(groupId);
    }
    const state=await this.store.snapshot();mediaGroup(state,groupId,true);
    if(this.failures.has(groupId))throwIpcError('OUTBOX_STORAGE_ERROR',this.failures.get(groupId)!);
    const before=args.before===undefined?Infinity:Number(args.before),limit=args.limit===undefined?50:Number(args.limit);
    if((args.before!==undefined&&(!Number.isSafeInteger(args.before)||before<=0))||!Number.isSafeInteger(limit)||limit<1||limit>100)throwIpcError('INVALID_PARAMS','Invalid outbox page');
    const all=Object.values(state.groupOutbox??{}).map(s=>s.view).filter(v=>v.groupId===groupId&&v.sequence<before).sort((a,b)=>a.sequence-b.sequence);
    let count=Math.min(limit,all.length),value:GroupOutboxPage;
    do{const entries=all.slice(-count);value={groupId,entries:count?entries:[],nextBefore:count<all.length&&count?entries[0]!.sequence:null};if(Buffer.byteLength(JSON.stringify(value))<=1_700_000)break;count--;}while(count>0);
    if(all.length&&!count)throwIpcError('OUTBOX_WINDOW_TOO_LARGE','One outbox entry exceeds the response budget');
    this.launch(groupId,paseo);return value!;
  });}
  reconcile(groupId:string,args:Record<string,unknown>){return this.admit(async()=>{
    await this.init();params(args,['groupId','clientMessageId']);const clientId=string(args.clientMessageId,'clientMessageId',200);
    const result=await this.store.transaction(state=>{
      const saved=entry(state,groupId,clientId),target=this.receiver.lookup(state,saved.view.input);
      if(target&&saved.view.status!=='sent')accepted(state,saved,target);
      else if(!target&&saved.view.status==='sending'&&!this.jobs.has(groupId)){
        saved.view.status='unknown';saved.view.recovery='reconcile';saved.view.error={code:'OUTBOX_OUTCOME_UNKNOWN',message:'Message reception is not confirmed; reconcile without sending a new copy'};touch(saved);
      }
      return{entry:saved.view,hasSending:hasSending(state,groupId)};
    });
    // Reconciling one entry must not erase another orphaned send's recovery fence.
    if(!result.hasSending)this.failures.delete(groupId);return{entry:result.entry};
  });}
  mutate(action:'retry'|'discard'|'edit',groupId:string,args:Record<string,unknown>,paseo:Paseo){return this.admit(async()=>{
    await this.init();params(args,['groupId','clientMessageId','operationId']);const clientId=string(args.clientMessageId,'clientMessageId',200),operation=hash(string(args.operationId,'operationId',200)),fingerprint=hash([action,clientId]);
    const value=await this.store.transaction(state=>{
      const saved=entry(state,groupId,clientId),prior=saved.mutations[operation];
      if(prior){if(prior.fingerprint!==fingerprint)throwIpcError('IDEMPOTENCY_CONFLICT','Outbox action key changed');return{view:saved.view};}
      const target=this.receiver.lookup(state,saved.view.input);if(target)accepted(state,saved,target);
      if(['sending','unknown'].includes(saved.view.status))throwIpcError('OUTBOX_OUTCOME_UNKNOWN','Reconcile this message reception before changing its outbox entry');
      if(action==='retry'){
        mediaGroup(state,groupId);if(!['failed','queued'].includes(saved.view.status))throwIpcError('OUTBOX_NOT_RETRYABLE','This outbox message cannot be sent again');
        this.receiver.validate?.(state,saved.view.input);saved.view.status='queued';saved.view.recovery='retry';delete saved.view.error;
      }else{
        const ref=`outbox:${outboxKey(groupId,clientId)}`;
        if(action==='edit'){
          if(saved.view.status!=='failed'||saved.view.recovery!=='retry')throwIpcError('OUTBOX_NOT_EDITABLE','Only a confirmed failed reception can return to the composer');
          retainGroupMediaDraft(state,groupId,saved.view.input.attachments??[],ref);
        }
        saved.view.status='discarded';saved.view.recovery='none';releaseGroupMedia(state,groupId,ref);
      }
      saved.mutations[operation]={fingerprint};touch(saved);return{view:saved.view};
    });
    // Only list/reconcile clear the recovery fence after accounting for sends.
    // In particular, asynchronous blob collection can overlap a new failed send.
    if(action==='discard')await this.receiver.collect?.(groupId);this.launch(groupId,paseo);return{accepted:true as const,entry:value.view};
  });}
  private launch(groupId:string,paseo:Paseo){
    if(this.closed)return;if(this.jobs.has(groupId)){this.kicks.add(groupId);return;}
    const promise=this.run(groupId,paseo);this.jobs.set(groupId,promise);void promise.finally(()=>{if(this.jobs.get(groupId)===promise)this.jobs.delete(groupId);if(this.kicks.delete(groupId))this.launch(groupId,paseo);}).catch(()=>{});
  }
  private async run(groupId:string,paseo:Paseo){
    try{while(!this.closed){
      const state=await this.store.snapshot();if(!state.groups?.[groupId]||state.groups[groupId]!.deletedAt||state.groups[groupId]!.mutation)return;
      const pending=Object.values(state.groupOutbox??{}).filter(s=>s.view.groupId===groupId&&!['sent','discarded'].includes(s.view.status)).sort((a,b)=>a.view.sequence-b.view.sequence)[0];
      if(!pending||pending.view.status!=='queued')return;
      const id=outboxKey(groupId,pending.view.clientMessageId),claimed=await this.store.transaction(s=>{
        mediaGroup(s,groupId);const saved=s.groupOutbox![id]!;if(saved.view.status!=='queued')return false;
        const target=this.receiver.lookup(s,saved.view.input);if(target){accepted(s,saved,target);return false;}
        saved.view.status='sending';saved.view.recovery='reconcile';touch(saved);return true;
      });
      if(!claimed)continue;
      try{
        const target=await this.receiver.accept(pending.view.input,paseo);
        await this.store.transaction(s=>{const saved=s.groupOutbox![id]!;accepted(s,saved,target);});
      }catch(error){
        await this.store.transaction(s=>{
          const saved=s.groupOutbox![id]!,target=this.receiver.lookup(s,saved.view.input);if(target){accepted(s,saved,target);return;}
          const known=error instanceof CompanionError&&definite.has(error.code);saved.view.status=known?'failed':'unknown';saved.view.recovery=known?'retry':'reconcile';
          saved.view.error={code:known?(error as CompanionError).code:'OUTBOX_OUTCOME_UNKNOWN',message:known?(error as Error).message:'Message reception is not confirmed; reconcile without sending a new copy'};touch(saved);
        });
      }
    }}catch(error){
      // The immutable sending record is the recovery fence if persistence fails.
      // No detached retry, second acceptance ID, or optimistic success is produced.
      this.failures.set(groupId,error instanceof Error?error.message:'Outbox persistence failed');
    }
  }
}
