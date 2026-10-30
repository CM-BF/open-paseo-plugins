import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import type { GroupPlanActionInput, GroupPlanSettings, GroupPlanSnapshot, GroupWorkPlan } from '../shared/group-plans';
import type { GroupMessage } from '../shared/groups';
import { draftPlanSteps, buildPlanStepBrief } from './vendor/botGroupDivision';
import type { CompanionStore, SavedState } from './store';
import type { SavedGroup } from './groups';
import { prepareLaneDispatch,isNativeAdmissionWrite,stopFailureCode,type GroupDriver,type GroupLane,type LaneDispatch } from './group-driver';
import { planWorkDirectories, type PlanDirectory, type PlanWorkDirectories } from './group-plan-workdir';
import { botId, record, string, throwIpcError } from './errors';
import type { SessionScope } from '../shared/session-scope';

interface PlanAttempt {
  id: string; position: number; messageId: string; noteIds: string[];
  botId:string;agentId:string;cwd:string;
  phase: 'preparing' | 'dispatching' | 'answered' | 'committed' | 'failed' | 'unknown';
  before?: Array<[string,string]>; resultText?: string; code?: string;
  dispatch?:LaneDispatch;
}
export interface SavedGroupWorkPlan {
  view: GroupWorkPlan; projectDir: string | null; directory?: PlanDirectory;
  lanes: Record<string, GroupLane>; attempts: PlanAttempt[];
  retiredLanes?:GroupLane[];
  notes: Array<{ id: string; text: string; consumed: boolean; kind: 'more'|'redo'|'retry';operationId?:string }>;
}
export interface GroupPlanState extends SavedState {
  groupPlans?: Record<string,SavedGroupWorkPlan>;
  groupPlanSettings?: Record<string,GroupPlanSettings>;
  groupPlanOperations?: Record<string,{ fingerprint: string; planId: string }>;
}
export interface GroupPlansDependencies {
  driver: GroupDriver;
  configFor: (botId: string, cwd: string, scope?: SessionScope) => Promise<Record<string,unknown>>;
  verifyWorkspace?: (workspaceId:string,cwd:string)=>Promise<void>;
  workDirectories?: PlanWorkDirectories;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const open = (plan: GroupWorkPlan) => ['proposed','running','waiting'].includes(plan.status);
const active = (plan: GroupWorkPlan) => ['preparing','queued','running','permission','stopping','unknown'].includes(plan.execution.state);
const defaults = (): GroupPlanSettings => ({revision:1,organizerBotId:null,projectDir:null,autoContinue:false});
function groupAt(state: GroupPlanState, id: string, readOnly=false): SavedGroup {
  const group=state.groups?.[id]; if (!group || group.deletedAt) throwIpcError('NOT_FOUND','Group not found');if(group.mutation&&!readOnly)throwIpcError('GROUP_BUSY','Group deletion is awaiting cleanup');return group;
}
function planAt(state: GroupPlanState, groupId: string, id: string): SavedGroupWorkPlan {
  groupAt(state,groupId); const plan=state.groupPlans?.[id];
  if (!plan || plan.view.groupId!==groupId) throwIpcError('NOT_FOUND','Work arrangement not found'); return plan;
}
function touch(plan: GroupWorkPlan) { plan.revision++; plan.updatedAt=Date.now(); }
function message(group: SavedGroup, input: Omit<GroupMessage,'id'|'sequence'|'createdAt'> & {id?:string;planId?:string;planStep?:number;artifacts?:unknown}) {
  const value={...input,id:input.id??randomUUID(),sequence:(group.messages.at(-1)?.sequence??0)+1,createdAt:Date.now()};
  group.messages.push(value); group.updatedAt=value.createdAt; return value;
}
function available(state: GroupPlanState, group: SavedGroup, id: string) {
  const profile=state.profiles[id]; if(!group.botIds.includes(id)||!profile||!profile.enabled||profile.status!=='active'||state.profileDeletions?.[id])
    throwIpcError('MEMBER_UNAVAILABLE','The assigned companion is unavailable'); return profile;
}
function roomIdle(group: SavedGroup) {
  if (group.rounds.some(round=>['queued','running','permission','stopping','unknown'].includes(round.status)))
    throwIpcError('GROUP_BUSY','Stop the active discussion before starting a work arrangement');
}
/** Persistent work arrangements. Native execution and terminal publication are separate receipts. */
export class GroupPlans {
  private readonly directories: PlanWorkDirectories;
  private jobs=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private stopping=new Map<string,Promise<void>>();
  private initialization:Promise<void>|null=null;
  private closing=false;
  constructor(private readonly store:CompanionStore,private readonly deps:GroupPlansDependencies) {
    this.directories=deps.workDirectories??planWorkDirectories(store);
  }
  private transaction<T>(run:(state:GroupPlanState)=>T|Promise<T>):Promise<T> { return this.store.transaction(state=>run(state as GroupPlanState)); }
  private async snapshot():Promise<GroupPlanState> { return this.store.snapshot(); }
  private admission() { if(this.closing)throwIpcError('SERVICE_CLOSED','Work arrangements are closing'); }
  /** Recovered work is never dispatched automatically. Confirm stop before exposing Retry. */
  async init() {
    this.admission();
    this.initialization??=(async()=>{
      const affected=await this.transaction(state=>Object.values(state.groupPlans??{}).filter(saved=>active(saved.view)).map(saved=>{
        const attempt=saved.attempts.at(-1),lane=attempt&&saved.lanes[attempt.botId];
        if(lane&&!lane.dispatch&&attempt&&['dispatching','unknown'].includes(attempt.phase))lane.dispatch={...prepareLaneDispatch(attempt.messageId),phase:'unknown',code:'ADMISSION_OUTCOME_UNKNOWN'};
        saved.view.status='waiting'; saved.view.execution={state:'unknown',code:'HOST_RESTARTED'};
        const step=saved.view.steps[saved.view.currentStep??0]; if(step){step.status='failed';step.code='HOST_RESTARTED';}
        touch(saved.view);return saved.view.id;
      }));
      for(const id of affected)await this.reconcileStopped(id,'HOST_RESTARTED');
    })();
    return this.initialization;
  }
  async list(groupId:string):Promise<GroupPlanSnapshot> {
    await this.init();const state=await this.snapshot();groupAt(state,groupId,true);
    return {plans:Object.values(state.groupPlans??{}).filter(p=>p.view.groupId===groupId).map(p=>p.view),settings:state.groupPlanSettings?.[groupId]??defaults()};
  }
  async settings(groupId:string,args:Record<string,unknown>) {
    await this.init();
    if(args.projectDir!==undefined&&args.projectDir!==null&&(!isAbsolute(string(args.projectDir,'projectDir',4096))))throwIpcError('INVALID_PARAMS','Project directory must be absolute');
    if(args.autoContinue!==undefined&&typeof args.autoContinue!=='boolean')throwIpcError('INVALID_PARAMS','Invalid autoContinue');
    const settings=await this.transaction(state=>{
      const group=groupAt(state,groupId);const current=(state.groupPlanSettings??={})[groupId]??defaults();
      if(args.expectedRevision!==current.revision)throwIpcError('PRECONDITION_FAILED','Group work settings changed');
      if(args.organizerBotId!==undefined&&args.organizerBotId!==null)available(state,group,botId(args.organizerBotId));
      const next={...current,revision:current.revision+1,
        ...(args.organizerBotId!==undefined?{organizerBotId:args.organizerBotId as string|null}:{}),
        ...(args.projectDir!==undefined?{projectDir:args.projectDir as string|null}:{}),
        ...(args.autoContinue!==undefined?{autoContinue:args.autoContinue as boolean}:{})};
      state.groupPlanSettings[groupId]=next;
      for(const saved of Object.values(state.groupPlans??{}).filter(p=>p.view.groupId===groupId&&open(p.view)))saved.view.autoContinue=next.autoContinue;
      return next;
    });
    if(settings.autoContinue){
      const state=await this.snapshot();const pending=Object.values(state.groupPlans??{}).find(p=>p.view.groupId===groupId&&p.view.status==='waiting'&&p.view.execution.state==='idle'&&p.view.steps[p.view.currentStep??0]?.status==='done');
      if(pending)await this.action('continue',{groupId,planId:pending.view.id,expectedRevision:pending.view.revision,operationId:`auto:${pending.view.id}:${pending.view.revision}`});
    }
    return {settings};
  }
  async create(groupId:string,args:Record<string,unknown>,context?:{sourceMessageId?:string;supersedesPlanId?:string;expectedRevision?:number;requestId?:string}) {
    await this.init();const operationId=string(args.operationId,'operationId',200);const request=string(args.request,'request',16000);
    if(!Array.isArray(args.steps)||!args.steps.length||args.steps.length>6)throwIpcError('INVALID_PARAMS','An arrangement requires 1 to 6 steps');
    const raw=args.steps.map(value=>{const item=record(value);return{botId:botId(item.botId),task:string(item.task,'task',800)};});
    const steps=draftPlanSteps(raw);if(!steps)throwIpcError('INVALID_PARAMS','Invalid work steps');
    if(args.start!==undefined&&typeof args.start!=='boolean')throwIpcError('INVALID_PARAMS','Invalid start');
    const fingerprint=hash([groupId,request,raw,args.start===true,context??null]);const key=hash(['create',groupId,operationId]);
    const plan=await this.transaction(state=>{
      const group=groupAt(state,groupId);const receipt=state.groupPlanOperations?.[key];
      if(receipt){if(receipt.fingerprint!==fingerprint)throwIpcError('IDEMPOTENCY_CONFLICT','Operation belongs to another work arrangement');return planAt(state,groupId,receipt.planId).view;}
      roomIdle(group);
      if(Object.values(state.groupPlanRequests??{}).some(request=>request.view.groupId===groupId&&['planning','unknown'].includes(request.view.status)&&request.view.id!==context?.requestId))throwIpcError('PLAN_OPEN','The organizer is still arranging work');
      if(Object.values(state.groupPlans??{}).some(p=>p.view.groupId===groupId&&open(p.view)&&p.view.id!==context?.supersedesPlanId))throwIpcError('PLAN_OPEN','This group already has an open work arrangement');
      if(context?.supersedesPlanId){const previous=planAt(state,groupId,context.supersedesPlanId);if(previous.view.status!=='proposed'||previous.view.revision!==context.expectedRevision)throwIpcError('PRECONDITION_FAILED','The proposed arrangement changed');previous.view.status='superseded';touch(previous.view);}
      const settings=state.groupPlanSettings?.[groupId]??defaults();
      const organizer=group.botIds.find(id=>id===settings.organizerBotId&&state.profiles[id]?.enabled&&state.profiles[id]?.status==='active')
        ??group.botIds.find(id=>state.profiles[id]?.enabled&&state.profiles[id]?.status==='active');
      if(!organizer)throwIpcError('MEMBER_UNAVAILABLE','No organizer is available');
      const id=randomUUID(),now=Date.now();
      const source=context?.sourceMessageId?group.messages.find(m=>m.id===context.sourceMessageId&&m.authorKind==='user'):message(group,{authorKind:'user',authorName:'You',kind:'message',content:request,planId:id});
      if(!source)throwIpcError('NOT_FOUND','The planning source message is missing');
      const view:GroupWorkPlan={id,groupId,revision:1,request,sourceMessageId:source.id,kind:'work',status:'proposed',currentStep:null,
        organizerBotId:organizer,organizerName:state.profiles[organizer]!.name,workDir:null,branch:null,canManage:true,canAdd:true,
        autoContinue:settings.autoContinue,createdAt:now,updatedAt:now,execution:{state:'idle'},
        steps:steps.map((step,position)=>({...step,position,botName:available(state,group,step.botId).name,status:'pending',artifacts:[]}))};
      (state.groupPlans??={})[id]={view,projectDir:settings.projectDir,lanes:{},attempts:[],notes:[]};
      (state.groupPlanOperations??={})[key]={fingerprint,planId:id};
      // A new explicit work arrangement replaces only the owner's paused talk queue.
      for(const round of group.rounds)if(round.status==='waiting'){round.status='stopped';round.code='WORK_PLAN_STARTED';}
      if(args.start===true){view.status='running';view.currentStep=0;view.execution={state:'preparing'};}
      return view;
    });
    if(plan.status==='running')this.launch(plan.id);return{plan};
  }
  async action(action:'start'|'continue'|'retry'|'stop'|'dismiss'|'edit'|'note',input:GroupPlanActionInput&Record<string,unknown>) {
    await this.init();const key=hash(['action',input.groupId,string(input.operationId,'operationId',200)]);
    const {expectedRevision:_version,...immutable}=input;const fingerprint=hash([action,immutable]);
    const plan=await this.transaction(state=>{
      const saved=planAt(state,input.groupId,input.planId);const p=saved.view;const prior=state.groupPlanOperations?.[key];
      if(prior){if(prior.fingerprint!==fingerprint)throwIpcError('IDEMPOTENCY_CONFLICT','Operation payload changed');return p;}
      if(input.expectedRevision!==p.revision)throwIpcError('PRECONDITION_FAILED','Work arrangement changed');
      const group=groupAt(state,p.groupId);const at=p.currentStep??0;const step=p.steps[at];
      if(action==='stop'||action==='dismiss'){
        if(!open(p)&&p.execution.state!=='unknown')throwIpcError('PLAN_CLOSED','Work arrangement is closed');
        if(active(p)){p.execution={state:'stopping'};}
        else{p.status=p.status==='proposed'?'dismissed':'stopped';p.execution={state:'idle'};}
      }else if(action==='edit'){
        if(p.status!=='proposed'&&!(p.status==='waiting'&&p.execution.state==='idle'))throwIpcError('PLAN_BUSY','Stop at a step boundary before editing');
        const position=input.position;if(!Number.isSafeInteger(position)||!p.steps[Number(position)])throwIpcError('INVALID_PARAMS','Invalid step');
        if(input.action==='remove'){
          if(p.status!=='proposed'||p.steps.length===1)throwIpcError('INVALID_PARAMS','Only an unstarted arrangement can remove a step');
          p.steps.splice(Number(position),1);
        }else if(input.action==='reassign'){
          const target=p.steps[Number(position)]!;if(target.status==='done')throwIpcError('INVALID_PARAMS','A completed step cannot be reassigned');
          if(saved.attempts.at(-1)?.phase==='answered'&&saved.attempts.at(-1)?.position===position)throwIpcError('RESULT_PUBLICATION_PENDING','Publish the existing result before reassigning this step');
          const profile=available(state,group,botId(input.botId));target.botId=profile.id;target.botName=profile.name;
        }else throwIpcError('INVALID_PARAMS','Invalid edit action');
        p.steps.forEach((item,index)=>item.position=index);
      }else if(action==='note'){
        if(!open(p)||p.status==='proposed')throwIpcError('PLAN_CLOSED','Start the arrangement before adding work');
        if(['unknown','stopping'].includes(p.execution.state))throwIpcError('PLAN_BUSY','Confirm the previous stop before adding work');
        const text=string(input.text,'text',16000);
        if(p.status==='waiting'&&step.status!=='done')throwIpcError('PLAN_RETRY_REQUIRED','Retry the unfinished step explicitly');
        const note=message(group,{authorKind:'user',authorName:'You',kind:'message',content:text,planId:p.id});
        saved.notes.push({id:note.id,text,consumed:false,kind:p.status==='waiting'?'redo':'more',operationId:input.operationId});
        if(p.status==='waiting'){p.status='running';p.execution={state:'preparing'};step.status='pending';}
      }else{
        if(active(p))throwIpcError('PLAN_BUSY','The previous execution is still active or unconfirmed');
        roomIdle(group);
        if(action==='start'){if(p.status!=='proposed')throwIpcError('PLAN_CLOSED','Only a proposed arrangement can start');p.currentStep=0;}
        if(action==='continue'){
          if(p.status!=='waiting'||step.status!=='done'||at+1>=p.steps.length)throwIpcError('PLAN_NOT_READY','No next completed hand-off is ready');p.currentStep=at+1;
        }
        if(action==='retry'){
          if(p.status!=='waiting'||step.status!=='failed')throwIpcError('PLAN_NOT_READY','Only an unfinished step can retry');
          if(input.text!==undefined)saved.notes.push({id:randomUUID(),text:string(input.text,'text',16000),consumed:false,kind:'retry'});
        }
        available(state,group,p.steps[p.currentStep??0]!.botId);p.status='running';p.execution={state:'preparing'};
      }
      touch(p);(state.groupPlanOperations??={})[key]={fingerprint,planId:p.id};return p;
    });
    if(plan.execution.state==='stopping')this.stopInBackground(plan.id);
    else if(plan.status==='running')this.launch(plan.id);
    return{accepted:true as const,plan,...(action==='note'?{delivery:plan.execution.state==='preparing'?'started' as const:'queued' as const}:{})};
  }
  async replayNote(groupId:string,operationId:string,text:string){
    const state=await this.snapshot();
    for(const saved of Object.values(state.groupPlans??{}).filter(p=>p.view.groupId===groupId)){
      const note=saved.notes.find(note=>note.operationId===operationId);if(!note)continue;
      if(note.text!==text)throwIpcError('IDEMPOTENCY_CONFLICT','Message payload changed');
      return{accepted:true as const,plan:saved.view,message:groupAt(state,groupId).messages.find(m=>m.id===note.id),round:null};
    }return null;
  }
  private launch(id:string) {
    if(this.closing||this.jobs.has(id))return;
    const controller=new AbortController();const job={controller,promise:Promise.resolve()};this.jobs.set(id,job);
    job.promise=this.run(id,controller.signal).catch(async error=>{
      await this.fail(id,error).catch(()=>{});
    }).finally(()=>{if(this.jobs.get(id)===job)this.jobs.delete(id);});
  }
  private receiptWriter(id:string,lane:GroupLane) {
    return async (receipt:LaneDispatch)=>{await this.transaction(s=>{const current=s.groupPlans![id]!,last=current.attempts.at(-1)!;
      if(last.agentId!==lane.agentId||last.messageId!==receipt.messageId)throwIpcError('RESULT_OWNERSHIP_MISMATCH','Work admission changed');
      if(isNativeAdmissionWrite(current.lanes[last.botId]!.dispatch,receipt)){available(s,groupAt(s,current.view.groupId),last.botId);if(current.view.status!=='running'||current.view.execution.state==='stopping'||current.view.currentStep!==last.position)throwIpcError('PLAN_STOPPED','Work no longer owns this admission');}
      current.lanes[last.botId]!.dispatch=receipt;last.dispatch=receipt;if(receipt.native?.creationComplete)current.lanes[last.botId]!.phase='ready';
      if(receipt.native?.workspaceId){current.lanes[last.botId]!.workspaceId=receipt.native.workspaceId;current.view.steps[last.position]!.workspaceId=receipt.native.workspaceId;}
    });};
  }
  private async run(id:string,signal:AbortSignal) {
    while(!signal.aborted&&!this.closing){
      let state=await this.snapshot();let saved=state.groupPlans?.[id];if(!saved||saved.view.status!=='running'||saved.view.execution.state==='stopping')return;
      const p=saved.view,position=p.currentStep??0;let step=p.steps[position]!;available(state,groupAt(state,p.groupId),step.botId);
      if(!saved.directory){
        const directory=await this.directories.prepare(p.groupId,p.id,saved.projectDir);
        await this.transaction(s=>{const current=s.groupPlans![id]!;current.directory=directory;current.view.workDir=directory.workDir;current.view.branch=directory.branch;});
        if(signal.aborted)return;saved=(await this.snapshot()).groupPlans![id]!;
      }
      await this.directories.validate(saved.directory!);
      let attempt=saved.attempts.at(-1);
      if(attempt?.phase!=='answered'||attempt.position!==position){
        const agentId=saved.lanes[step.botId]?.agentId??randomUUID();
        const sessionScope:SessionScope={agentId,role:'plan',groupId:p.groupId,planId:p.id};
        const config=await this.deps.configFor(step.botId,saved.directory!.workDir,sessionScope);
        if(signal.aborted)return;
        let lane=saved.lanes[step.botId];
        const before=await this.directories.snapshot(saved.directory!);
        const prepared=await this.transaction(s=>{
          const current=s.groupPlans![id]!;if(current.view.execution.state==='stopping')return null;
          available(s,groupAt(s,p.groupId),step.botId);
          const lane=current.lanes[step.botId]??={agentId,sessionScope,operationId:randomUUID(),groupId:p.groupId,roundId:p.id,botId:step.botId,
            cwd:current.directory!.workDir,title:`${step.botName} · ${groupAt(s,p.groupId).name} · 分工`,config,phase:'creating',nativeInputVersion:1};
          const attempt:PlanAttempt={id:randomUUID(),position,botId:step.botId,agentId:lane.agentId,cwd:lane.cwd,messageId:randomUUID(),noteIds:current.notes.filter(n=>!n.consumed).map(n=>n.id),phase:'preparing',before:[...before]};
          if(lane.dispatch&&!['prepared','not-sent','completed'].includes(lane.dispatch.phase))throwIpcError('ADMISSION_OUTCOME_UNKNOWN','The previous work input is unsettled');
          lane.dispatch=prepareLaneDispatch(attempt.messageId);attempt.dispatch=lane.dispatch;
          current.view.steps[position]!.agentId=lane.agentId;current.view.steps[position]!.workspaceId=lane.workspaceId;
          current.attempts.push(attempt);current.view.execution={state:'preparing'};touch(current.view);
          return{lane,attempt};
        });
        if(!prepared||signal.aborted)return;lane=prepared.lane;attempt=prepared.attempt;
        state=await this.snapshot();saved=state.groupPlans![id]!;step=saved.view.steps[position]!;
        const noteSet=new Set(attempt.noteIds),notes=saved.notes.filter(n=>noteSet.has(n.id));
        const prompt=buildPlanStepBrief({groupName:groupAt(state,p.groupId).name,botName:step.botName,request:p.request,steps:saved.view.steps,position,
          handoffs:saved.view.steps.filter(item=>item.position<position&&item.status==='done').map(item=>({position:item.position,botName:item.botName,
            note:groupAt(state,p.groupId).messages.find(m=>m.id===item.resultMessageId)?.content??'',files:item.artifacts.map(f=>f.path)})),
          recent:[],workDir:saved.directory!.workDir,branch:saved.directory!.branch,
          ...(notes.length?{userNotes:{kind:notes[0]!.kind,texts:notes.map(n=>n.text)}}:{}),
        });
        const recordDispatch=this.receiptWriter(id,lane);
        // Reconcile the immutable first-input receipt before applying newer config.
        // An unknown creation must never be reissued with a changed prompt or config.
        const ensured=await this.deps.driver.ensure(lane,{prompt,messageId:attempt.messageId,signal,recordDispatch});
        lane=await this.transaction(s=>{const current=s.groupPlans![id]!;const stored=current.lanes[step.botId]!;stored.phase='ready';stored.workspaceId=ensured.workspaceId;
          current.view.steps[position]!.agentId=stored.agentId;current.view.steps[position]!.workspaceId=stored.workspaceId;return stored;});
        if(signal.aborted)return;
        if(hash(lane.config)!==hash(config)){
          if(!this.deps.driver.configure)throwIpcError('HOST_UPGRADE_REQUIRED','This host cannot refresh the existing work session');
          await this.deps.driver.configure(lane,config);
        }
        lane=await this.transaction(s=>{const stored=s.groupPlans![id]!.lanes[step.botId]!;stored.config=config;stored.sessionScope=sessionScope;return stored;});
        if(signal.aborted)return;
        await this.transaction(s=>{const current=s.groupPlans![id]!;if(current.view.execution.state==='stopping')return;
          current.attempts.at(-1)!.phase='dispatching';touch(current.view);});
        if(signal.aborted)return;
        const result=await this.deps.driver.reply(lane,{prompt,messageId:attempt.messageId,signal,
          recordDispatch,queued:async waiting=>{await this.transaction(s=>{const current=s.groupPlans![id]!;if(current.attempts.at(-1)?.id===attempt!.id&&current.view.execution.state!=='stopping'){
            current.view.execution={state:waiting?'queued':'running'};current.view.steps[position]!.status=waiting?'pending':'running';if(!waiting)current.view.steps[position]!.startedAt??=Date.now();touch(current.view);
          }});},permission:waiting=>{
          void this.transaction(s=>{const current=s.groupPlans![id]!;if(current.attempts.at(-1)?.id===attempt!.id&&current.view.execution.state!=='stopping')
            current.view.execution={state:waiting?'permission':'running'};}).catch(()=>{});
        }});
        if(signal.aborted)return;
        await this.transaction(s=>{const current=s.groupPlans![id]!;const last=current.attempts.at(-1)!;
          if(last.id!==attempt!.id||current.view.execution.state==='stopping')return;last.phase='answered';last.resultText=result;});
      }
      if(signal.aborted)return;
      saved=(await this.snapshot()).groupPlans![id]!;attempt=saved.attempts.at(-1)!;
      if(attempt.phase!=='answered')return;
      if(attempt.botId!==saved.view.steps[position]!.botId||attempt.cwd!==saved.directory!.workDir)throwIpcError('RESULT_OWNERSHIP_MISMATCH','The result belongs to a different step execution');
      const artifacts=await this.directories.artifacts(saved.directory!,new Map(attempt.before??[]));
      const again=await this.transaction(s=>{
        const current=s.groupPlans![id]!;const v=current.view,last=current.attempts.at(-1)!;
        if(v.execution.state==='stopping'||last.id!==attempt!.id)return false;
        available(s,groupAt(s,v.groupId),v.steps[position]!.botId);
        const noteIds=new Set(last.noteIds);for(const note of current.notes)if(noteIds.has(note.id))note.consumed=true;
        last.phase='committed';const step=v.steps[position]!;
        step.artifacts=[...new Map([...step.artifacts,...artifacts].map(file=>[file.path,file])).values()].slice(0,20);
        if(current.notes.some(n=>!n.consumed)){step.status='pending';v.execution={state:'preparing'};touch(v);return true;}
        const result=message(groupAt(s,v.groupId),{authorKind:'bot',authorBotId:step.botId,authorName:step.botName,kind:'message',content:last.resultText??'',
          planId:v.id,planStep:position,artifacts:structuredClone(step.artifacts),agentId:step.agentId,workspaceId:step.workspaceId});
        step.resultMessageId=result.id;step.status='done';step.completedAt=Date.now();delete step.code;
        v.execution={state:'idle'};
        if(position+1===v.steps.length){v.status='done';}
        else if(s.groupPlanSettings?.[v.groupId]?.autoContinue){v.currentStep=position+1;v.execution={state:'preparing'};}
        else v.status='waiting';touch(v);return v.status==='running';
      });
      if(!again)return;
    }
  }
  private async fail(id:string,error:unknown) {
    const raw=error&&typeof error==='object'&&'code'in error?String(error.code):'RUNTIME_ERROR';
    const code=raw==='unsupported_capability'?'HOST_UPGRADE_REQUIRED':(error as {dispatchOutcome?:string})?.dispatchOutcome==='unknown'?'ADMISSION_OUTCOME_UNKNOWN':raw;
    const saved=(await this.snapshot()).groupPlans?.[id];if(!saved||saved.view.execution.state==='stopping')return;
    const lane=saved.lanes[saved.view.steps[saved.view.currentStep??0]!.botId];let stopCode:string|undefined;
    if(lane)try{await this.deps.driver.stop(lane,this.receiptWriter(id,lane));}catch(error){stopCode=stopFailureCode(error);}
    const stopped=!stopCode;
    await this.transaction(s=>{const current=s.groupPlans![id]!;if(current.view.execution.state==='stopping')return;
      const last=current.attempts.at(-1);if(last&&last.phase!=='answered'&&last.phase!=='committed'){last.phase=stopped?'failed':'unknown';last.code=code;}
      const step=current.view.steps[current.view.currentStep??0]!;step.status='failed';step.code=code;
      current.view.status='waiting';current.view.execution=stopped?{state:'idle',code}:{state:'unknown',code:stopCode};touch(current.view);
    });
  }
  private stopInBackground(id:string) {
    if(this.stopping.has(id))return;const job=this.jobs.get(id);job?.controller.abort();
    const promise=(async()=>{await job?.promise;await this.reconcileStopped(id,'USER_STOPPED',true);})();
    this.stopping.set(id,promise);void promise.catch(()=>{}).finally(()=>this.stopping.delete(id));
  }
  private async reconcileStopped(id:string,code:string,terminal=false) {
    const saved=(await this.snapshot()).groupPlans![id]!;const at=saved.view.currentStep??0;const lane=saved.lanes[saved.view.steps[at]!.botId];
    let stopCode:string|undefined;if(lane)try{await this.deps.driver.stop(lane,this.receiptWriter(id,lane));}catch(error){stopCode=stopFailureCode(error);}const confirmed=!stopCode;
    await this.transaction(state=>{const current=state.groupPlans![id]!;
      current.view.status=confirmed&&terminal?'stopped':'waiting';current.view.execution=confirmed?{state:'idle',code}:{state:'unknown',code:stopCode};
      const step=current.view.steps[at]!;if(step.status!=='done'){step.status='failed';step.code=code;}
      const attempt=current.attempts.at(-1);if(attempt&&!['answered','committed'].includes(attempt.phase))attempt.phase=confirmed?'failed':'unknown';touch(current.view);
    });
  }
  async artifact(groupId:string,planId:string,position:number,path:string,messageId?:string) {
    await this.init();const state=await this.snapshot(),saved=planAt(state,groupId,planId);
    const frozen=messageId?groupAt(state,groupId).messages.find(m=>m.id===messageId&&m.planId===planId&&m.planStep===position):undefined;
    const files=messageId?frozen?.artifacts:saved.view.steps[position]?.artifacts;
    if(!Number.isSafeInteger(position)||!files?.some(file=>file.path===path)||!saved.directory)throwIpcError('NOT_FOUND','Artifact not recorded for this handoff');
    const workspaceId=messageId?frozen?.workspaceId:saved.view.steps[position]!.workspaceId;
    if(!workspaceId)throwIpcError('WORKSPACE_UNAVAILABLE','The artifact has no confirmed native workspace');
    const full=await this.directories.artifactPath(saved.directory,path);
    if(!this.deps.verifyWorkspace)throwIpcError('WORKSPACE_UNAVAILABLE','The host cannot verify this artifact workspace');
    await this.deps.verifyWorkspace(workspaceId,saved.directory.workDir);
    return{workspaceId,path:relative(saved.directory.workDir,full).split(sep).join('/')};
  }
  async close() {
    if(this.closing)return;this.closing=true;await this.initialization?.catch(()=>{});
    const jobs=[...this.jobs.entries()];for(const[,job]of jobs)job.controller.abort();
    await Promise.allSettled(jobs.map(([,job])=>job.promise));await Promise.allSettled([...this.stopping.values()]);
    for(const[id]of jobs)await this.reconcileStopped(id,'HOST_RESTARTED');
  }
}
