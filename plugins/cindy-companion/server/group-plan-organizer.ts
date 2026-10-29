import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { GroupPlanRequest } from '../shared/group-plans';
import { splitBotGroupRelaySteps } from '../shared/vendor/botGroupMentions';
import { buildPlanDecisionPrompt, parsePlanDecision, PLAN_DECISION_SYSTEM_PROMPT, type PlanDecisionInput, type PlanStepDraft } from './vendor/botGroupDivision';
import type { CompanionStore } from './store';
import { prepareLaneDispatch,stopFailureCode,type GroupDriver,type GroupLane } from './group-driver';
import type { GroupPlans, GroupPlanState } from './group-plans';
import { record, string, throwIpcError } from './errors';

export interface SavedPlanRequest {
  view: GroupPlanRequest; fingerprint: string; input: PlanDecisionInput; lane?: GroupLane;
  phase: 'created'|'dispatching'|'answered'|'settled'; result?: PlanStepDraft[]|null;
  supersedesPlanId?:string;expectedRevision?:number;
  cleanupPending?:boolean;
}
export interface GroupPlanOrganizerState extends GroupPlanState { groupPlanRequests?:Record<string,SavedPlanRequest> }
interface Deps {
  driver:GroupDriver; configFor:(botId:string,cwd:string)=>Promise<Record<string,unknown>>;
  /** Actual ordinary-discussion routing on a failed explicit plan, with its durable clientMessageId. */
  fallback:(groupId:string,text:string,clientMessageId:string,sourceMessageId:string)=>Promise<void>;
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Host adapter for Cindy's original strict organizer prompt/parser, isolated from companion lanes. */
export class GroupPlanOrganizer {
  private jobs=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private cancellations=new Map<string,Promise<void>>();
  private initialized:Promise<void>|null=null;private closing=false;
  constructor(private store:CompanionStore,private plans:GroupPlans,private deps:Deps){}
  private transaction<T>(run:(state:GroupPlanOrganizerState)=>T|Promise<T>){return this.store.transaction(state=>run(state as GroupPlanOrganizerState));}
  private async snapshot():Promise<GroupPlanOrganizerState>{return this.store.snapshot();}
  async init(){
    if(this.closing)throwIpcError('SERVICE_CLOSED','Organizer is closing');
    this.initialized??=(async()=>{
      const state=await this.snapshot();
      for(const saved of Object.values(state.groupPlanRequests??{}).filter(r=>['planning','unknown'].includes(r.view.status))){
        if(saved.phase==='answered'&&saved.view.status==='planning'){await this.publish(saved.view.id);continue;}
        if(saved.lane&&!saved.lane.dispatch&&saved.phase==='dispatching'){
          saved.lane.dispatch={...prepareLaneDispatch(`organize:${saved.view.id}`),phase:'unknown',code:'ADMISSION_OUTCOME_UNKNOWN'};
          await this.transaction(s=>{s.groupPlanRequests![saved.view.id]!.lane!.dispatch=saved.lane!.dispatch;});
        }
        let stopCode:string|undefined;if(saved.lane)try{await this.deps.driver.stop(saved.lane);}catch(error){stopCode=stopFailureCode(error);}
        await this.transaction(s=>{const current=s.groupPlanRequests![saved.view.id]!;current.view.status=stopCode?'unknown':'failed';current.view.code=stopCode??'HOST_RESTARTED';current.view.updatedAt=Date.now();});
      }
      for(const saved of Object.values((await this.snapshot()).groupPlanRequests??{}).filter(r=>r.cleanupPending&&['complete','failed'].includes(r.view.status)))await this.cleanup(saved.view.id);
    })();return this.initialized;
  }
  async list(groupId:string){await this.init();return Object.values((await this.snapshot()).groupPlanRequests??{}).filter(r=>r.view.groupId===groupId).map(r=>r.view);}
  async replay(groupId:string,operationId:string,text:string){
    const prior=(await this.snapshot()).groupPlanRequests?.[hash([groupId,operationId])];if(!prior)return null;
    if(prior.view.request!==text)throwIpcError('IDEMPOTENCY_CONFLICT','Planning request changed');return{accepted:true as const,request:prior.view};
  }
  async create(groupId:string,args:Record<string,unknown>,revision?:{planId:string;expectedRevision:number}){
    await this.init();if(args.steps!==undefined)return this.plans.create(groupId,args);
    const request=string(args.request,'request',16000),operation=string(args.operationId,'operationId',200);const state=await this.snapshot();
    const id=hash([groupId,operation]),fingerprint=hash([groupId,request,args.trackedMentions??[],revision??null]);
    const prior=state.groupPlanRequests?.[id];if(prior){if(prior.fingerprint!==fingerprint)throwIpcError('IDEMPOTENCY_CONFLICT','Planning request changed');return{accepted:true as const,request:prior.view};}
    const group=state.groups?.[groupId];if(!group||group.deletedAt)throwIpcError('NOT_FOUND','Group not found');
    if(group.mutation)throwIpcError('GROUP_BUSY','Group deletion is awaiting cleanup');
    const members=group.botIds.flatMap(id=>{const profile=state.profiles[id];return profile?.status==='active'&&profile.enabled?[{botId:id,name:profile.name,description:profile.description}]:[];});
    const written=splitBotGroupRelaySteps(request,{members,allLabels:['所有人','all','everyone']});
    const picked=args.trackedMentions===undefined?[]:Array.isArray(args.trackedMentions)?args.trackedMentions.map(value=>string(record(value).botId,'mentioned companion',100)):throwIpcError('INVALID_PARAMS','Invalid mentions');
    if(!revision&&written&&picked.every(id=>written.some(step=>step.botId===id)))return this.plans.create(groupId,{...args,steps:written,start:true});
    const saved=await this.transaction(s=>{
      const prior=s.groupPlanRequests?.[id];if(prior){if(prior.fingerprint!==fingerprint)throwIpcError('IDEMPOTENCY_CONFLICT','Planning request changed');return prior;}
      const current=s.groups?.[groupId];if(!current||current.deletedAt)throwIpcError('NOT_FOUND','Group not found');
      if(current.mutation)throwIpcError('GROUP_BUSY','Group deletion is awaiting cleanup');
      if(Object.values(s.groupPlanRequests??{}).some(r=>r.view.groupId===groupId&&['planning','unknown'].includes(r.view.status))||Object.values(s.groupPlans??{}).some(p=>p.view.groupId===groupId&&['proposed','running','waiting'].includes(p.view.status)&&p.view.id!==revision?.planId))
        throwIpcError('PLAN_OPEN','This group already has an open work arrangement');
      const previous=revision?s.groupPlans?.[revision.planId]:undefined;
      if(revision&&(!previous||previous.view.groupId!==groupId||previous.view.status!=='proposed'||previous.view.revision!==revision.expectedRevision))throwIpcError('PRECONDITION_FAILED','The proposed arrangement changed');
      if(current.rounds.some(r=>['queued','running','permission','stopping','unknown'].includes(r.status)))throwIpcError('GROUP_BUSY','Stop the active discussion before arranging work');
      const admittedMembers=current.botIds.flatMap(id=>{const profile=s.profiles[id];return profile?.status==='active'&&profile.enabled?[{botId:id,name:profile.name,description:profile.description}]:[];});
      const organizer=admittedMembers.find(m=>m.botId===s.groupPlanSettings?.[groupId]?.organizerBotId)??admittedMembers[0];if(!organizer)throwIpcError('MEMBER_UNAVAILABLE','No organizer is available');
      const now=Date.now(),sourceMessageId=randomUUID();
      const saved:SavedPlanRequest={view:{id,groupId,request,sourceMessageId,organizerBotId:organizer.botId,organizerName:organizer.name,status:'planning',createdAt:now,updatedAt:now},
        fingerprint,phase:'created',...(revision?{supersedesPlanId:revision.planId,expectedRevision:revision.expectedRevision}:{}),
        input:{mode:revision?'revise':'forced',groupName:current.name,organizerName:organizer.name,members:admittedMembers,request,
          ...(previous?{currentSteps:previous.view.steps}:{}),recent:current.messages.filter(m=>m.kind==='message').slice(-12).map(m=>({from:m.authorName,text:m.content}))}};
      current.messages.push({id:sourceMessageId,sequence:(current.messages.at(-1)?.sequence??0)+1,authorKind:'user',authorName:'You',kind:'message',content:request,createdAt:now});current.updatedAt=now;
      (s.groupPlanRequests??={})[id]=saved;return saved;
    });
    if(saved.view.status==='planning')this.launch(id);return{accepted:true as const,request:saved.view};
  }
  private launch(id:string){
    if(this.jobs.has(id)||this.closing)return;const controller=new AbortController();const job={controller,promise:Promise.resolve()};this.jobs.set(id,job);
    job.promise=this.run(id,controller.signal).catch(async error=>{
      const saved=(await this.snapshot()).groupPlanRequests![id]!;let stopCode:string|undefined;if(saved.lane)try{await this.deps.driver.stop(saved.lane);}catch(error){stopCode=stopFailureCode(error);}
      const stopped=!stopCode,raw=typeof(error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'PLAN_UNAVAILABLE';
      const code=stopCode??(raw==='unsupported_capability'?'HOST_UPGRADE_REQUIRED':(error as {dispatchOutcome?:string})?.dispatchOutcome==='unknown'?'ADMISSION_OUTCOME_UNKNOWN':raw);
      await this.transaction(state=>{const item=state.groupPlanRequests![id]!;item.view.status=stopped?'failed':'unknown';item.view.code=code;item.view.updatedAt=Date.now();});
      if(stopped)await this.cleanup(id);
      // Confirmed execution failure falls back through ordinary routing; never replay an unknown send.
      if(stopped&&!['HOST_UPGRADE_REQUIRED','PROVIDER_ADMISSION_UNAVAILABLE','GROUP_LANE_BUSY','ADMISSION_OUTCOME_UNKNOWN'].includes(code)&&!controller.signal.aborted&&saved.phase!=='answered'&&!saved.supersedesPlanId)try{await this.deps.fallback(saved.view.groupId,saved.view.request,`plan-fallback:${id}`,saved.view.sourceMessageId);}catch{await this.transaction(state=>{state.groupPlanRequests![id]!.view.code='FALLBACK_NOT_CONFIRMED';});}
    }).finally(()=>{if(this.jobs.get(id)===job)this.jobs.delete(id);});
  }
  private async run(id:string,signal:AbortSignal){
    let saved=(await this.snapshot()).groupPlanRequests![id]!;
    const cwd=join(this.store.root,'group-organizers',id);await this.store.safePath(cwd);await mkdir(cwd,{recursive:true});
    const base=await this.deps.configFor(saved.view.organizerBotId,cwd);
    // The public host has no auxiliary text API. This is a separate native utility session,
    // with no companion memory/skills instructions, and never a canonical/group execution lane.
    const provider=String(base.provider).split('/')[0];
    const config={...base,systemPrompt:PLAN_DECISION_SYSTEM_PROMPT,mcpServers:{},
      ...(provider==='codex'?{options:{...record(base.options??{}),sandbox_mode:'read-only',approval_policy:'on-request'}}:{})};
    const lane:GroupLane={agentId:randomUUID(),operationId:randomUUID(),groupId:saved.view.groupId,roundId:id,botId:saved.view.organizerBotId,cwd,title:'Cindy · Arrange work',config,phase:'creating',dispatch:prepareLaneDispatch(`organize:${id}`)};
    await this.transaction(state=>{const current=state.groupPlanRequests![id]!;current.lane=lane;current.cleanupPending=true;});
    if(signal.aborted)return;
    const ensured=await this.deps.driver.ensure(lane);lane.phase='ready';lane.workspaceId=ensured.workspaceId;
    await this.transaction(state=>{const current=state.groupPlanRequests![id]!;current.lane=lane;current.phase='dispatching';current.view.agentId=lane.agentId;});
    if(signal.aborted)return;
    const limit=new AbortController();const abort=()=>limit.abort();signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,20_000);
    let result:string;
    try{result=await this.deps.driver.reply(lane,{prompt:buildPlanDecisionPrompt(saved.input),messageId:`organize:${id}`,signal:limit.signal,
      recordDispatch:async receipt=>{await this.transaction(state=>{const current=state.groupPlanRequests![id]!;if(current.lane?.agentId!==lane.agentId)throwIpcError('GROUP_LANE_MISMATCH','Organizer admission changed');current.lane.dispatch=receipt;});},
      permission:waiting=>{if(waiting)limit.abort();}});}
    finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
    const decision=parsePlanDecision(result,saved.input.mode,new Set(saved.input.members.map(m=>m.botId)));
    await this.transaction(state=>{const current=state.groupPlanRequests![id]!;current.phase='answered';current.result=decision?.needsPlan?decision.steps:null;});
    if(signal.aborted)return;await this.publish(id);
    // Cleanup is independently recoverable and must not overwrite a committed proposal.
    await this.cleanup(id);
  }
  private async cleanup(id:string){const saved=(await this.snapshot()).groupPlanRequests![id]!;if(!saved.lane)return;
    try{await this.deps.driver.archive(saved.lane);await this.transaction(state=>{const current=state.groupPlanRequests![id]!;current.cleanupPending=false;current.view.cleanupPending=false;delete current.view.cleanupCode;current.lane!.cleanupPending=false;delete current.lane!.cleanupCode;});}
    catch(error){await this.transaction(state=>{const current=state.groupPlanRequests![id]!;current.view.cleanupPending=true;current.view.cleanupCode=(error as {code?:string})?.code??'CLEANUP_NOT_CONFIRMED';current.lane!.cleanupPending=true;current.lane!.cleanupCode=current.view.cleanupCode;});}
  }
  private async publish(id:string){
    const saved=(await this.snapshot()).groupPlanRequests![id]!;
    if(saved.result){
      const {plan}=await this.plans.create(saved.view.groupId,{operationId:`resolved:${id}`,request:saved.view.request,steps:saved.result},
        {requestId:id,sourceMessageId:saved.view.sourceMessageId,...(saved.supersedesPlanId?{supersedesPlanId:saved.supersedesPlanId,expectedRevision:saved.expectedRevision}:{})});
      await this.transaction(state=>{const current=state.groupPlanRequests![id]!;current.phase='settled';current.view.status='complete';current.view.planId=plan.id;current.view.updatedAt=Date.now();});
    }else{
      await this.transaction(state=>{const current=state.groupPlanRequests![id]!;current.phase='settled';current.view.status='failed';current.view.code='PLAN_UNAVAILABLE';current.view.updatedAt=Date.now();});
      if(!saved.supersedesPlanId)await this.deps.fallback(saved.view.groupId,saved.view.request,`plan-fallback:${id}`,saved.view.sourceMessageId);
    }
  }
  async cancel(groupId:string,id:string){
    await this.init();const request=await this.transaction(state=>{
      const saved=state.groupPlanRequests?.[id];if(!saved||saved.view.groupId!==groupId)throwIpcError('NOT_FOUND','Planning request not found');
      if(['planning','unknown'].includes(saved.view.status)){saved.view.status='unknown';saved.view.code='STOP_REQUESTED';saved.view.updatedAt=Date.now();}
      return saved.view;
    });
    if(['complete','failed'].includes(request.status)){
      const saved=(await this.snapshot()).groupPlanRequests![id]!;if(saved.cleanupPending)await this.cleanup(id);
      return{accepted:true as const,request:(await this.snapshot()).groupPlanRequests![id]!.view};
    }
    if(request.code==='STOP_REQUESTED'&&!this.cancellations.has(id)){
      const job=this.jobs.get(id);job?.controller.abort();
      const cancellation=(async()=>{await job?.promise;const saved=(await this.snapshot()).groupPlanRequests![id]!;let stopCode:string|undefined;
        if(saved.lane)try{await this.deps.driver.stop(saved.lane);}catch(error){stopCode=stopFailureCode(error);}const confirmed=!stopCode;
        await this.transaction(state=>{const current=state.groupPlanRequests![id]!;if(current.view.status==='complete')return;
          current.view.status=confirmed?'failed':'unknown';current.view.code=confirmed?'USER_STOPPED':stopCode;current.view.updatedAt=Date.now();});
        if(confirmed)await this.cleanup(id);
      })();
      this.cancellations.set(id,cancellation);void cancellation.catch(()=>{}).finally(()=>this.cancellations.delete(id));
    }
    return{accepted:true as const,request};
  }
  async close(){
    if(this.closing)return;this.closing=true;await this.initialized?.catch(()=>{});const jobs=[...this.jobs.values()];for(const job of jobs)job.controller.abort();await Promise.allSettled(jobs.map(job=>job.promise));await Promise.allSettled([...this.cancellations.values()]);
    const pending=Object.values((await this.snapshot()).groupPlanRequests??{}).filter(r=>r.view.status==='planning');
    for(const saved of pending){let stopCode:string|undefined;if(saved.lane)try{await this.deps.driver.stop(saved.lane);}catch(error){stopCode=stopFailureCode(error);}
      await this.transaction(state=>{const current=state.groupPlanRequests![saved.view.id]!;current.view.status=stopCode?'unknown':'failed';current.view.code=stopCode??'HOST_RESTARTED';});}
  }
}
