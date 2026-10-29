import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { CompanionTask, TaskResultReceipt } from '../shared/companion-tasks';
import type { SessionScope } from '../shared/session-scope';
import type { CompanionStore, SavedState } from './store';
import type { TaskLane } from './companion-task-driver';
import {prepareLaneDispatch,type GroupDriver,type LaneDispatch} from './group-driver';
import { planWorkDirectories, type PlanDirectory, type PlanWorkDirectories } from './group-plan-workdir';
import { sessionBinding } from './session-authority';
import { string, throwIpcError } from './errors';

export interface TaskOwner {botId:string;scope:SessionScope}
interface TaskInput {id:string;text:string;phase:'queued'|'consuming'|'answered'|'unknown'|'settled'|'withdrawn';operationId:string;createdAt:number;result?:string;before?:Array<[string,string]>;nativeMessageId?:string;nativeTurnId?:string;busyMessageIds?:string[];admissionUnknown?:boolean;dispatch?:LaneDispatch}
export interface SavedCompanionTask {
  view:CompanionTask;owner:TaskOwner;fingerprint:string;operationId:string;directory?:PlanDirectory;lane?:TaskLane;
  workingDir?:string;useWorktree:boolean;timeoutMs:number;inputs:TaskInput[];
  config:Record<string,unknown>;messageKeys?:Record<string,string>;
  agentId:string;
  waitingForNativeIdle?:boolean;
  cancelRequests?:Record<string,{expectedTurnId:string;messageId:string}>;
  stopMode?:'cancel'|'request-stop'|'pause';
}
export function taskNeedsSettlement(task:SavedCompanionTask):boolean{
  return !task.view.blocked&&(['queued','running','waiting'].includes(task.view.status)||['unknown','pausing','stopping'].includes(task.view.control)||(task.view.control==='active'&&task.inputs.some(input=>['queued','consuming','answered','unknown'].includes(input.phase))));
}
interface Dependencies {
  driver:GroupDriver;configFor(botId:string,cwd:string):Promise<Record<string,unknown>>;
  directories?:PlanWorkDirectories;
  verifyWorkspace?:(workspaceId:string,cwd:string)=>Promise<void>;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const touch=(task:SavedCompanionTask)=>{task.view.updatedAt=Date.now();task.view.revision++;};
function project(task:SavedCompanionTask):CompanionTask{
  return{...structuredClone(task.view),queue:task.inputs.filter(i=>['queued','consuming','unknown'].includes(i.phase)).map(i=>({id:i.id,text:i.text,status:i.phase as 'queued',createdAt:i.createdAt}))};
}
function owned(state:SavedState,botId:string,id:string):SavedCompanionTask{
  const task=state.companionTasks?.[id];if(!task||task.owner.botId!==botId)throwIpcError('NOT_FOUND','Task not owned by this companion');return task;
}
function executionOwner(state:SavedState,task:SavedCompanionTask){
  const profile=state.profiles[task.owner.botId];if(!profile?.enabled||profile.status!=='active'||state.profileDeletions?.[task.owner.botId])throwIpcError('SESSION_SCOPE_REVOKED','The requesting companion is unavailable');
  if(task.owner.scope.groupId){const group=state.groups?.[task.owner.scope.groupId];if(!group||group.deletedAt||group.mutation||!group.botIds.includes(task.owner.botId))throwIpcError('SESSION_SCOPE_REVOKED','The requesting group membership was revoked');}
}
/** Original delegation state vocabulary, backed by immutable public native child identities. */
export class CompanionTasks {
  private jobs=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  private stops=new Map<string,Promise<void>>();private initialized:Promise<void>|null=null;private closing=false;
  private directories:PlanWorkDirectories;
  constructor(private store:CompanionStore,private deps:Dependencies){this.directories=deps.directories??planWorkDirectories(store);}
  private assertOpen(){if(this.closing)throwIpcError('PLUGIN_CLOSED','Tasks are closing');}
  async init(){
    this.assertOpen();this.initialized??=(async()=>{
      for(const task of Object.values((await this.store.snapshot()).companionTasks??{})){
        if((['queued','running','waiting'].includes(task.view.status)&&task.view.control==='active'&&!task.waitingForNativeIdle)||['pausing','stopping','unknown'].includes(task.view.control)){
          const restoredUnsent=await this.store.transaction(s=>{const t=s.companionTasks![task.view.id]!,input=t.inputs.find(i=>['consuming','unknown'].includes(i.phase));
            const unsent=input&&!input.nativeTurnId&&input.dispatch&&['prepared','not-sent'].includes(input.dispatch.phase);
            if(unsent&&!t.stopMode){input.phase='queued';delete input.nativeMessageId;delete input.admissionUnknown;t.view.runSequence=Math.max(0,t.view.runSequence-1);t.view.control='paused';t.view.activity='idle';t.view.status='failed';t.view.lastError=input.dispatch?.code??'HOST_RESTARTED';t.view.pendingInteraction=null;touch(t);return true;}
            for(const i of t.inputs)if(['consuming','unknown'].includes(i.phase)&&!i.nativeTurnId&&(!i.dispatch||['dispatching','unknown'].includes(i.dispatch.phase))){i.phase='unknown';i.admissionUnknown=true;}
            t.view.control='unknown';t.view.activity='unknown';t.view.lastError='HOST_RESTARTED';touch(t);return false;});
          if(restoredUnsent)continue;
          await this.reconcileStop(task.view.id,task.stopMode??'request-stop','HOST_RESTARTED');
        }
      }
    })();return this.initialized;
  }
  async list(botId:string,groupId?:string){await this.init();const state=await this.store.snapshot();return{tasks:Object.values(state.companionTasks??{}).filter(t=>t.owner.botId===botId&&(groupId===undefined||t.owner.scope.groupId===groupId)).map(project)};}
  async get(botId:string,id:string){await this.init();return{task:project(owned(await this.store.snapshot(),botId,id))};}
  /** Called only after a native idle observation; sendIfIdle remains the final atomic admission. */
  async nativeIdle(agentId:string){
    await this.init();const ids=await this.store.transaction(state=>Object.values(state.companionTasks??{}).filter(t=>t.lane?.agentId===agentId&&t.waitingForNativeIdle&&t.view.control==='active').map(t=>{t.waitingForNativeIdle=false;t.view.activity='queued';touch(t);return t.view.id;}));
    for(const id of ids)this.launch(id);
  }
  async start(owner:TaskOwner,args:Record<string,unknown>){
    await this.init();const instruction=string(args.instruction,'instruction',12000),operationId=string(args.operationId,'operationId',200);
    const title=args.title===undefined?instruction.slice(0,80):string(args.title,'title',120);
    const cwd=args.working_dir===undefined?undefined:string(args.working_dir,'working_dir',1024);
    if(cwd&&!isAbsolute(cwd))throwIpcError('INVALID_PARAMS','Task working directory must be absolute');
    if(args.use_worktree!==undefined&&typeof args.use_worktree!=='boolean')throwIpcError('INVALID_PARAMS','Invalid worktree option');
    if(args.use_worktree&&!cwd)throwIpcError('INVALID_PARAMS','An isolated task requires its actual project directory');
    if(args.model_selection!==undefined)throwIpcError('MODEL_ROUTE_UNAVAILABLE','Explicit application route identifiers are not exposed by this host; set the companion task model first');
    const timeout=Number(args.timeout_ms??1800000);if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>86400000)throwIpcError('INVALID_PARAMS','Invalid task timeout');
    const refs=args.context_refs===undefined?[]:args.context_refs;if(!Array.isArray(refs)||refs.length>32)throwIpcError('INVALID_PARAMS','Invalid context references');const contextRefs=refs.map(v=>string(v,'context reference',512));
    const fingerprint=digest([owner,instruction,title,cwd,args.use_worktree===true,timeout,contextRefs]);
    const existing=Object.values((await this.store.snapshot()).companionTasks??{}).find(t=>t.owner.botId===owner.botId&&t.owner.scope.agentId===owner.scope.agentId&&t.operationId===operationId);
    if(existing){if(existing.fingerprint!==fingerprint)throwIpcError('IDEMPOTENCY_CONFLICT','Task operation payload changed');return{accepted:true as const,task:project(existing)};}
    const id=randomUUID();const config=await this.deps.configFor(owner.botId,cwd??join(this.store.root,'tasks',id,'workspace'));
    const value=await this.store.transaction(state=>{
      sessionBinding(state,owner.botId,owner.scope);if(owner.scope.role==='task')throwIpcError('TASK_DEPTH_EXCEEDED','Independent tasks cannot create another companion task');
      const prior=Object.values(state.companionTasks??{}).find(t=>t.owner.botId===owner.botId&&t.owner.scope.agentId===owner.scope.agentId&&t.operationId===operationId);
      if(prior){if(prior.fingerprint!==fingerprint)throwIpcError('IDEMPOTENCY_CONFLICT','Task operation payload changed');return prior;}
      const now=Date.now(),agentId=randomUUID();const task:SavedCompanionTask={owner:structuredClone(owner),fingerprint,operationId,config,agentId,workingDir:cwd,useWorktree:args.use_worktree===true,timeoutMs:timeout,
        inputs:[{id:randomUUID(),text:instruction,phase:'queued',operationId,createdAt:now}],
        view:{id,requestingBotId:owner.botId,targetBotId:null,targetBotName:'Cindy',parentSessionId:owner.scope.agentId,childSessionId:agentId,title,objective:instruction,contextRefs,
          permissionSnapshot:{provider:config.provider,mode:config.modeId,providerOptions:config.options??null,policy:'ask'},lineage:[owner.scope.agentId],targetProfileVersion:null,depth:1,status:'queued',pendingInteraction:null,resultSummary:null,artifacts:[],lastError:null,
          createdAt:now,acceptedAt:null,completedAt:null,updatedAt:now,revision:1,groupId:owner.scope.groupId,workingDir:null,control:'active',activity:'queued',responsibility:'owned',runSequence:0,queue:[],results:[]}};
      (state.companionTasks??={})[id]=task;(state.taskAgents??={})[agentId]=id;this.groupTrace(state,task,'task-created');return task;
    });
    if(value.view.control==='active'&&value.view.status==='queued')this.launch(value.view.id);return{accepted:true as const,task:project(value)};
  }
  async message(botId:string,id:string,args:Record<string,unknown>){
    await this.init();if(args.decision!==undefined||args.answers!==undefined)throwIpcError('NATIVE_PERMISSION_REQUIRED','Answer the exact pending permission in the native task session');
    const mode=args.mode??'queue';if(!['queue','resume','edit','withdraw'].includes(String(mode)))throwIpcError('STEER_UNAVAILABLE','This host does not support exact-turn task steering');
    const operationId=string(args.operationId,'operationId',200),text=args.message===undefined?undefined:string(args.message,'message',4000);
    const fingerprint=digest([mode,text,args.queued_message_id??null]);
    const task=await this.store.transaction(state=>{
      const t=owned(state,botId,id);
      if(t.messageKeys?.[operationId]){if(t.messageKeys[operationId]!==fingerprint)throwIpcError('IDEMPOTENCY_CONFLICT','Task message changed');return t;}
      if(t.view.control==='unknown'||t.view.control==='stopping'||t.view.control==='pausing')throwIpcError('TASK_OUTCOME_UNKNOWN','Confirm the prior stop before changing task input');
      if(t.view.status==='cancelled')throwIpcError('TASK_CANCELLED','This task was cancelled; create a new task to restart it');
      if(mode==='edit'||mode==='withdraw'){
        const item=t.inputs.find(i=>i.id===args.queued_message_id);if(!item||item.phase!=='queued')throwIpcError('INPUT_ALREADY_CONSUMED','Only pending owned input can change');
        if(mode==='edit'){if(!text)throwIpcError('INVALID_PARAMS','A replacement message is required');item.text=text;}else item.phase='withdrawn';
      }else{
        if(mode==='resume'){if(t.view.control!=='paused')throwIpcError('TASK_NOT_PAUSED','Only a paused task can resume');t.view.control='active';t.waitingForNativeIdle=false;delete t.stopMode;delete t.view.blocked;}
        if(mode==='queue'&&!text)throwIpcError('INVALID_PARAMS','A message is required');
        if(text)t.inputs.push({id:randomUUID(),text,phase:'queued',operationId,createdAt:Date.now()});
        if(t.view.control!=='paused'&&t.inputs.some(i=>i.phase==='queued')){t.view.control='active';delete t.stopMode;if(!this.jobs.has(id)){t.view.status='queued';t.view.activity='queued';}}
      }
      (t.messageKeys??={})[operationId]=fingerprint;touch(t);return t;
    });
    if(task.view.control==='active'&&task.inputs.some(i=>i.phase==='queued'))this.launch(id);return{accepted:true as const,task:project(task)};
  }
  async stop(botId:string,id:string,mode:unknown='cancel'){
    await this.init();if(!['cancel','request-stop','pause'].includes(String(mode)))throwIpcError('INVALID_PARAMS','Invalid task stop mode');
    const task=await this.store.transaction(state=>{const t=owned(state,botId,id);t.stopMode=t.stopMode==='cancel'?'cancel':mode as SavedCompanionTask['stopMode'];t.view.control=t.stopMode==='pause'?'pausing':'stopping';touch(t);return t;});
    if(!this.stops.has(id)){
      const job=this.jobs.get(id);job?.controller.abort();const pending=(async()=>{await job?.promise;await this.reconcileStop(id,mode as NonNullable<SavedCompanionTask['stopMode']>,'USER_STOPPED');})();
      this.stops.set(id,pending);void pending.finally(()=>this.stops.delete(id)).catch(()=>{});
    }
    return{accepted:true as const,task:project(task)};
  }
  async responsibility(botId:string,id:string,action:unknown){
    if(action!=='claim'&&action!=='release')throwIpcError('INVALID_PARAMS','Invalid responsibility action');
    await this.init();const task=await this.store.transaction(state=>{const t=owned(state,botId,id);t.view.responsibility=action==='claim'?'owned':'released';touch(t);return t;});return{task:project(task)};
  }
  private launch(id:string){
    if(this.closing||this.jobs.has(id))return;const controller=new AbortController(),job={controller,promise:Promise.resolve()};this.jobs.set(id,job);
    job.promise=this.run(id,controller.signal).catch(async error=>{
      const code=String((error as {code?:string}).code??(error as Error).message);
      if(['HOST_UPGRADE_REQUIRED','unsupported_capability','PROVIDER_ADMISSION_UNAVAILABLE','TASK_BUSY','GROUP_LANE_BUSY'].includes(code)){
        await this.store.transaction(s=>{const t=s.companionTasks![id]!,input=t.inputs.find(i=>i.phase==='consuming');
          if(input){input.phase='queued';if(input.nativeMessageId){(input.busyMessageIds??=[]).push(input.nativeMessageId);delete input.nativeMessageId;}t.view.runSequence--;}
          t.view.lastError=code;t.view.activity='idle';t.view.pendingInteraction=null;
          if(['HOST_UPGRADE_REQUIRED','unsupported_capability','PROVIDER_ADMISSION_UNAVAILABLE'].includes(code)){if(t.view.control==='active'){t.view.status='failed';t.view.control='paused';}t.view.blocked=code==='PROVIDER_ADMISSION_UNAVAILABLE'?{code,message:'任务尚未发送；当前模型提供方无法保证只在空闲时开始，不会插入或中断其他轮次。'}:{code:'HOST_UPGRADE_REQUIRED',message:'任务尚未发送；升级宿主的原子空闲发送能力后可继续。'};}
          else{t.waitingForNativeIdle=true;if(t.view.control==='active')t.view.status='queued';}
          touch(t);
        });return;
      }
      if((error as {dispatchOutcome?:string}).dispatchOutcome==='unknown'){
        await this.store.transaction(s=>{const t=s.companionTasks![id]!,input=t.inputs.find(i=>i.phase==='consuming');if(input){input.phase='unknown';input.admissionUnknown=true;}t.view.control='unknown';t.view.activity='unknown';t.view.status='failed';t.view.lastError='ADMISSION_OUTCOME_UNKNOWN';touch(t);});return;
      }
      if(controller.signal.aborted)return;
      await this.reconcileStop(id,'request-stop',code);
    }).finally(async()=>{if(this.jobs.get(id)===job)this.jobs.delete(id);if(!this.closing){const t=(await this.store.snapshot()).companionTasks?.[id];if(t?.view.control==='active'&&!t.waitingForNativeIdle&&t.inputs.some(i=>i.phase==='queued'))this.launch(id);}});void job.promise.catch(()=>{});
  }
  private async run(id:string,signal:AbortSignal){
    while(!signal.aborted&&!this.closing){
      let task=(await this.store.snapshot()).companionTasks![id]!;if(task.view.control!=='active'||task.waitingForNativeIdle)return;
      const answered=task.inputs.find(i=>i.phase==='answered');if(answered){await this.publish(id,answered);continue;}
      if(!task.directory){
        let directory:PlanDirectory;
        if(task.useWorktree){directory=await this.directories.prepare(`task-${id}`,`task-${id}`,task.workingDir!);if(!directory.branch)throwIpcError('WORKTREE_REQUIRED','An isolated task requires a Git project');}
        else{const path=task.workingDir??join(this.store.root,'tasks',id,'workspace');if(!task.workingDir){await this.store.safePath(path);await mkdir(path,{recursive:true,mode:0o700});}const workDir=await realpath(path);if(!(await stat(workDir)).isDirectory())throwIpcError('WORKDIR_UNAVAILABLE','Task directory is unavailable');directory={workDir,branch:null};}
        await this.store.transaction(s=>{const t=s.companionTasks![id]!;t.directory=directory;t.view.workingDir=directory.workDir;touch(t);});task=(await this.store.snapshot()).companionTasks![id]!;
      }
      await this.directories.validate(task.directory!);if(signal.aborted)return;
      if(!task.lane){
        const config=task.config,agentId=task.agentId;
        await this.store.transaction(state=>{const t=state.companionTasks![id]!;executionOwner(state,t);if(t.view.control!=='active')return;
          t.lane={agentId,operationId:`cindy-task:${id}`,parentAgentId:t.owner.scope.agentId,taskId:id,groupId:t.owner.scope.groupId??'',roundId:id,botId:t.owner.botId,cwd:t.directory!.workDir,title:t.view.title,config,phase:'creating'};t.view.childSessionId=agentId;touch(t);});
        task=(await this.store.snapshot()).companionTasks![id]!;
      }
      if(signal.aborted||!task.lane)return;const lane=task.lane,native=await this.deps.driver.ensure(lane);
      await this.store.transaction(s=>{const t=s.companionTasks![id]!;t.lane!.phase='ready';t.lane!.workspaceId=native.workspaceId;t.view.workspaceId=native.workspaceId;t.view.acceptedAt??=Date.now();});
      if(signal.aborted)return;
      const before=await this.directories.snapshot(task.directory!);
      const input=await this.store.transaction(s=>{const t=s.companionTasks![id]!;if(t.view.control!=='active')return null;executionOwner(s,t);const i=t.inputs.find(i=>i.phase==='queued');if(!i)return null;
        i.phase='consuming';i.nativeMessageId??=randomUUID();i.dispatch=prepareLaneDispatch(i.nativeMessageId);t.lane!.dispatch=i.dispatch;i.before=[...before];t.view.runSequence++;t.view.status='running';t.view.activity='running';t.view.completedAt=null;t.view.lastError=null;touch(t);return i;});
      if(!input)return;
      lane.dispatch=input.dispatch;
      const text=await this.deps.driver.reply(lane,{prompt:input.text,messageId:input.nativeMessageId!,signal,timeoutMs:task.timeoutMs,
        recordDispatch:async receipt=>{await this.store.transaction(s=>{const t=s.companionTasks![id]!,i=t.inputs.find(i=>i.id===input.id)!;if(i.nativeMessageId!==receipt.messageId)throwIpcError('TASK_OUTCOME_UNKNOWN','Task admission changed');i.dispatch=receipt;t.lane!.dispatch=receipt;i.admissionUnknown=['dispatching','unknown'].includes(receipt.phase)&&!receipt.turnId;if(receipt.turnId)i.nativeTurnId=receipt.turnId;});},
        admitted:async turnId=>{await this.store.transaction(s=>{const i=s.companionTasks![id]!.inputs.find(i=>i.id===input.id)!;i.nativeTurnId=turnId;});},
        permission:waiting=>{void this.store.transaction(s=>{const t=s.companionTasks![id]!;if(t.view.control==='active'){t.view.status=waiting?'waiting':'running';t.view.activity=waiting?'permission':'running';t.view.pendingInteraction=waiting?{requestId:'native-session',kind:'permission',summary:'请在该任务的 Paseo 会话中处理权限请求',raisedAt:Date.now()}:null;touch(t);}}).catch(()=>{});}});
      if(signal.aborted)return;
      await this.store.transaction(s=>{const i=s.companionTasks![id]!.inputs.find(i=>i.id===input.id)!;i.phase='answered';i.result=text;});
      await this.publish(id,{...input,phase:'answered',result:text});
    }
  }
  private async publish(id:string,input:TaskInput){
      const task=(await this.store.snapshot()).companionTasks![id]!;
      const changed=await this.directories.artifacts(task.directory!,new Map(input.before));
      const artifacts=changed.map(file=>({path:file.path,absolutePath:join(task.directory!.workDir,file.path),status:(input.before?.some(([path])=>path===file.path)?'modified':'added') as 'modified'|'added'}));
      const text=input.result!;
      await this.store.transaction(s=>{const t=s.companionTasks![id]!,i=t.inputs.find(i=>i.id===input.id)!;if(t.view.control!=='active')return;i.phase='settled';t.view.status='completed';t.view.activity='idle';t.view.pendingInteraction=null;t.view.resultSummary=text;t.view.artifacts=artifacts;t.view.completedAt=Date.now();
        const receipt:TaskResultReceipt={id:randomUUID(),runSequence:t.view.runSequence,text,status:'completed',title:t.view.title,workingDir:t.directory!.workDir,artifacts:structuredClone(artifacts),createdAt:Date.now()};t.view.results.push(receipt);this.groupTrace(s,t,'task-result',receipt);touch(t);});
  }
  async artifact(botId:string,id:string,path:string,receiptId?:string){
    const t=owned(await this.store.snapshot(),botId,id),receipt=receiptId?t.view.results.find(r=>r.id===receiptId):t.view.results.at(-1);
    if(!receipt||!receipt.artifacts.some(a=>a.path===path)||!t.directory||!t.view.workspaceId)throwIpcError('NOT_FOUND','The file is not part of this task result');
    const full=await this.directories.artifactPath(t.directory,path);
    if(!this.deps.verifyWorkspace)throwIpcError('WORKSPACE_UNAVAILABLE','The host cannot verify this artifact workspace');
    await this.deps.verifyWorkspace(t.view.workspaceId,t.directory.workDir);
    return{workspaceId:t.view.workspaceId,path:relative(t.directory.workDir,full).split(sep).join('/')};
  }
  private groupTrace(state:SavedState,task:SavedCompanionTask,kind:'task-created'|'task-result',receipt?:TaskResultReceipt){
    const group=task.owner.scope.groupId?state.groups?.[task.owner.scope.groupId]:undefined;if(!group||group.deletedAt||group.mutation||!group.botIds.includes(task.owner.botId))return;
    const now=Date.now();group.messages.push({id:randomUUID(),sequence:(group.messages.at(-1)?.sequence??0)+1,createdAt:now,authorKind:'bot',authorBotId:task.owner.botId,authorName:state.profiles[task.owner.botId]?.name??task.owner.botId,kind:'message',content:kind==='task-created'?'':receipt!.text,taskId:task.view.id,taskParentSessionId:task.owner.scope.agentId,...(receipt?{taskResult:structuredClone(receipt)}:{})});group.updatedAt=now;
  }
  private async reconcileStop(id:string,mode:NonNullable<SavedCompanionTask['stopMode']>,code:string){
    const task=(await this.store.snapshot()).companionTasks![id]!;
    if(task.inputs.some(input=>input.admissionUnknown)){
      await this.store.transaction(s=>{const t=s.companionTasks![id]!;t.view.control='unknown';t.view.activity='unknown';t.view.status='failed';t.view.lastError='ADMISSION_OUTCOME_UNKNOWN';touch(t);});return;
    }
    // A durable busy receipt or capability rejection proves our input was not sent.
    // The child may contain another user's active turn, which this queue must not stop.
    const ownedTurnId=task.inputs.findLast(input=>input.nativeTurnId)?.nativeTurnId;
    const unsent=task.inputs.find(input=>['queued','consuming','unknown'].includes(input.phase)&&!input.nativeTurnId&&input.dispatch&&['prepared','not-sent'].includes(input.dispatch.phase));
    const cancel=ownedTurnId?await this.store.transaction(s=>{const t=s.companionTasks![id]!;return(t.cancelRequests??={})[ownedTurnId]??={expectedTurnId:ownedTurnId,messageId:randomUUID()};}):undefined;
    let confirmed=true,stopError='STOP_NOT_CONFIRMED';if(task.lane&&!unsent&&!task.view.blocked&&!task.waitingForNativeIdle)try{await this.deps.driver.stop({...task.lane,ownedTurnId,cancelMessageId:cancel?.messageId} as TaskLane);}catch(error){confirmed=false;stopError=String((error as {code?:string}).code??stopError);}
    await this.store.transaction(s=>{const t=s.companionTasks![id]!;t.view.control=!confirmed?'unknown':mode==='pause'?'paused':'stopped';t.view.activity=confirmed?'idle':'unknown';t.view.pendingInteraction=null;
      mode=t.stopMode??mode;t.view.control=!confirmed?'unknown':mode==='pause'?'paused':'stopped';
      if(unsent&&confirmed&&mode==='pause'){const i=t.inputs.find(i=>i.id===unsent.id)!;if(i.phase!=='queued')t.view.runSequence=Math.max(0,t.view.runSequence-1);i.phase='queued';delete i.nativeMessageId;}
      t.view.status=!confirmed?'failed':mode==='pause'?'waiting':mode==='cancel'?'cancelled':'failed';t.view.lastError=confirmed?code:stopError;t.view.completedAt=confirmed&&mode!=='pause'?Date.now():null;
      for(const input of t.inputs){if(input.phase==='consuming'||input.phase==='unknown')input.phase=confirmed?'settled':'unknown';if(mode==='cancel'&&confirmed&&input.phase==='queued')input.phase='withdrawn';}
      if(confirmed&&mode!=='pause'&&t.view.runSequence>0&&!t.view.results.some(result=>result.runSequence===t.view.runSequence)&&!t.inputs.some(input=>input.phase==='answered')){
        const receipt:TaskResultReceipt={id:randomUUID(),runSequence:t.view.runSequence,text:code,status:mode==='cancel'?'cancelled':'failed',title:t.view.title,workingDir:t.directory!.workDir,artifacts:[],createdAt:Date.now()};t.view.results.push(receipt);this.groupTrace(s,t,'task-result',receipt);
      }
      touch(t);});
  }
  async close(){if(this.closing)return;this.closing=true;await this.initialized?.catch(()=>{});const jobs=[...this.jobs.entries()];for(const[,job]of jobs)job.controller.abort();await Promise.allSettled(jobs.map(([,job])=>job.promise));await Promise.allSettled([...this.stops.values()]);for(const[id]of jobs)await this.reconcileStop(id,'request-stop','HOST_RESTARTED');}
}
