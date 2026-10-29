import { hostname } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PluginBeforeRequests } from '@getpaseo/plugin/server';
import type { CompanionProfile, InvokeInput, InvokeResult, BootstrapData } from '../shared/contracts';
import { BOT_SETTINGS_PROTOCOL_VERSION } from '../shared/vendor/botRemoteSettings';
import { CompanionStore } from './store';
import { CompanionRuntime, type Paseo } from './runtime';
import { CompanionMemoryStore } from './memory';
import { createBotMemoryService } from './vendor/botMemoryService';
import { parseBotMemoryScopeKey } from './vendor/memory/storage';
import { botId, CompanionError, record, string, throwIpcError, unsupported } from './errors';
import { CompanionRoutines, ScheduleCli, type ScheduleDriver } from './schedules';
import { readFontChunk } from './font-assets';
import { CompanionGroups, parseTrackedMentions } from './groups';
import { CompanionGroupHistory } from './group-history';
import { NativeGroupDriver, type GroupDriver } from './group-driver';
import { GroupPlans } from './group-plans';
import { GroupPlanOrganizer } from './group-plan-organizer';
import { browsePlanDirectories } from './group-plan-workdir';
import { resolveBotGroupMentions } from '../shared/vendor/botGroupMentions';
import { PresetImports } from './presets/import';
import { PresetOpenings } from './presets/opening';
import { avatarDataUrl } from './avatar';
import type { SessionScope } from '../shared/session-scope';
import { LocalPaseo } from './local-paseo';
import { publicPaseoCli } from './host-cli';
import { validateSessionBinding } from './session-authority';
import { CompanionTasks, taskNeedsSettlement } from './companion-tasks';
import { NativeTaskDriver } from './companion-task-driver';
import { createHash } from 'node:crypto';

const OPS = ['caps', 'assets.fontChunk', 'paseo.presets.list', 'paseo.presets.invite', 'paseo.presets.status', 'preset.opening.status', 'preset.opening.choose',
  'groups.list', 'groups.get', 'groups.create', 'groups.update', 'groups.setMembers', 'groups.send', 'groups.continue', 'groups.stop', 'groups.delete','groups.cleanup',
  'groups.history.get', 'groups.history.send', 'groups.history.react', 'groups.history.reactors',
  'groups.threads.get', 'groups.threads.reply', 'groups.threads.follow', 'groups.threads.shareToMain', 'groups.threads.stop', 'groups.threads.continue',
  'groups.plans.list','groups.plans.create','groups.plans.start','groups.plans.continue','groups.plans.retry','groups.plans.stop','groups.plans.dismiss','groups.plans.edit','groups.plans.note','groups.plans.revise','groups.plans.cancelRequest','groups.plans.settings','groups.plans.artifact','groups.plans.directories',
  'companion.tasks.list','companion.tasks.get','companion.tasks.start','companion.tasks.message','companion.tasks.stop','companion.tasks.responsibility','companion.tasks.artifact','companion.tasks.owner',
  'profile.get', 'profile.update', 'profile.chooseAvatar', 'lifecycle.run', 'models.default', 'models.features',
  'memory.list', 'memory.read', 'memory.update', 'memory.delete', 'capabilities.catalog', 'history.search',
  'paseo.bootstrap', 'profile.list', 'profile.create', 'profile.ensure', 'paseo.conversation.ensure',
  'conversation.send', 'conversation.history', 'home.get', 'memory.create', 'paseo.openPath',
  'routines.list', 'routines.sources', 'routines.reconcile', 'routines.save', 'routines.saveWithModel', 'routines.saveWithSessionMode', 'routines.history', 'routines.runNow', 'routines.remove'] as const;
export class CompanionService {
  readonly store: CompanionStore;
  readonly runtime: CompanionRuntime;
  readonly routines: CompanionRoutines;
  readonly groups: CompanionGroups;
  readonly groupHistory: CompanionGroupHistory;
  readonly presets: PresetImports;
  readonly openings: PresetOpenings;
  private readonly memoryStores = new Map<string, CompanionMemoryStore>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly profileMutations = new Map<string, Promise<unknown>>();
  private closing: Promise<void> | null = null;
  private disposed = false;
  private workBackend:{plans:GroupPlans;organizer:GroupPlanOrganizer}|null=null;
  private readonly groupDriverFactory:(paseo:Paseo)=>GroupDriver;
  private readonly localPaseo = new LocalPaseo(publicPaseoCli().home);
  private taskBackend:CompanionTasks|null=null;
  private readonly toolsPaseo:()=>Promise<Paseo>;
  private readonly taskDriverFactory:(paseo:Paseo)=>GroupDriver;
  private readonly ownedApi:(fallback:Paseo)=>Promise<Paseo>;
  readonly memory: ReturnType<typeof createBotMemoryService>;
  constructor(store = new CompanionStore(), options: { scheduleDriver?: ScheduleDriver; groupDriver?: (paseo: Paseo) => GroupDriver;taskDriver?:(paseo:Paseo)=>GroupDriver;paseoForTools?:()=>Promise<Paseo> } = {}) {
    this.store = store; this.runtime = new CompanionRuntime(store);
    this.routines = new CompanionRoutines(store, this.runtime, options.scheduleDriver ?? new ScheduleCli());
    this.groups = new CompanionGroups(store, this.runtime, options.groupDriver);
    this.groupHistory = new CompanionGroupHistory(store, this.groups);
    this.toolsPaseo=options.paseoForTools??(()=>this.localPaseo.get());
    this.ownedApi=options.groupDriver||options.taskDriver?async fallback=>fallback:()=>this.toolsPaseo();
    const managed=(factory:(api:Paseo)=>GroupDriver):GroupDriver=>({
      ensure:async lane=>factory(await this.toolsPaseo()).ensure(lane),reply:async(lane,input)=>factory(await this.toolsPaseo()).reply(lane,input),
      stop:async lane=>factory(await this.toolsPaseo()).stop(lane),archive:async lane=>factory(await this.toolsPaseo()).archive(lane),
      configure:async(lane,config)=>factory(await this.toolsPaseo()).configure!(lane,config),
    });
    this.groupDriverFactory=options.groupDriver??(()=>managed(api=>new NativeGroupDriver(api)));
    this.taskDriverFactory=options.taskDriver??(()=>managed(api=>new NativeTaskDriver(api)));
    this.presets = new PresetImports(store);
    this.openings = new PresetOpenings(store);
    this.memory = createBotMemoryService({
      getStore: async scope => {
        const id = parseBotMemoryScopeKey(scope); if (!id) throwIpcError('INVALID_PARAMS', 'Invalid memory scope');
        return this.memoryStore(id);
      },
      readBot: async id => { const p = await store.get(id); return { canonicalSessionId: p.canonicalSessionId ?? null }; },
      // Changes are durable; an existing system prompt cannot be silently refreshed on older hosts.
      requestRefresh: async () => { throw new CompanionError('RUNTIME_REFRESH_REQUIRED', 'Memory saved; current session instructions are unchanged'); },
      setTimer: (callback, ms) => { const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, ms); this.timers.add(timer); return timer; },
      clearTimer: value => { clearTimeout(value as ReturnType<typeof setTimeout>); this.timers.delete(value as ReturnType<typeof setTimeout>); },
    });
  }
  private admit<T>(run: () => Promise<T>): Promise<T> {
    if (this.disposed) throwIpcError('PLUGIN_CLOSED', 'Companion plugin is closing');
    const operation = Promise.resolve().then(run); this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => {});
    return operation;
  }
  close(): Promise<void> {
    this.disposed = true;
    this.closing ??= (async () => {
      await Promise.allSettled([...this.operations]);
      // Accepted memory writes may schedule refresh timers while draining.
      for (const timer of this.timers) clearTimeout(timer); this.timers.clear();
      await this.routines.close();
      await this.taskBackend?.close();
      await this.workBackend?.organizer.close();
      await this.workBackend?.plans.close();
      await this.groups.close();
      await this.runtime.close();
      await this.localPaseo.dispose();
    })();
    return this.closing;
  }
  private work(paseo:Paseo){
    if(!this.workBackend){
      const driver=this.groupDriverFactory(paseo),configFor=async(id:string,cwd:string,scope?:SessionScope)=>this.runtime.nativeConfigFor(await this.ownedApi(paseo),id,cwd,scope);
      const plans=new GroupPlans(this.store,{driver,configFor,verifyWorkspace:async(id,cwd)=>{const workspace=(await this.ownedApi(paseo)).workspaces.ref(id);if(!await workspace.refresh()||workspace.directory!==cwd)throwIpcError('WORKSPACE_MISMATCH','The file no longer belongs to this native workspace');}});
      const organizer=new GroupPlanOrganizer(this.store,plans,{driver,configFor,fallback:async(groupId,text,clientMessageId,sourceMessageId)=>{
        await this.groups.send(paseo,groupId,{text,clientMessageId},sourceMessageId);
      }});
      this.workBackend={plans,organizer};
    }
    return this.workBackend;
  }
  private tasks(paseo:Paseo){
    this.taskBackend??=new CompanionTasks(this.store,{driver:this.taskDriverFactory(paseo),configFor:async(botId,cwd)=>this.runtime.taskConfigFor(await this.ownedApi(paseo),botId,cwd),
      verifyWorkspace:async(id,cwd)=>{const workspace=(await this.ownedApi(paseo)).workspaces.ref(id);if(!await workspace.refresh()||workspace.directory!==cwd)throwIpcError('WORKSPACE_MISMATCH','The file no longer belongs to this native workspace');}});return this.taskBackend;
  }
  validateSessionScope(id:string,scope:SessionScope):Promise<void>{
    return this.admit(async()=>{botId(id);await validateSessionBinding(this.store,await this.toolsPaseo(),id,scope);});
  }
  onNativeTaskTurnEnded(paseo:Paseo,agentId:string):Promise<void>{
    return this.admit(async()=>{
      const state=await this.store.snapshot();if(!Object.values(state.companionTasks??{}).some(t=>t.lane?.agentId===agentId&&t.waitingForNativeIdle))return;
      const agent=paseo.agents.ref(agentId);if(await agent.refresh()&&!agent.archivedAt&&!agent.activeTurn&&agent.status!=='running'&&agent.status!=='initializing'&&!agent.pendingPermissions?.length)await this.tasks(paseo).nativeIdle(agentId);
    });
  }
  async invokeSessionTool(id:string,scope:SessionScope,op:string,args:Record<string,unknown>):Promise<InvokeResult>{
    try{return await this.admit(async()=>{
      const paseo=await this.toolsPaseo();await validateSessionBinding(this.store,paseo,id,scope);
      if(op==='list_agents')return{ok:true,value:{agents:(await this.store.list()).filter(p=>p.enabled&&p.status==='active').map(p=>({id:p.id,name:p.name,description:p.description,local:true})),unavailableDevices:[]}};
      const tasks=this.tasks(paseo),taskId=args.task_id===undefined?undefined:string(args.task_id,'task_id',128);
      if(op==='start_session_task'){
        const native=paseo.agents.ref(scope.agentId);await native.refresh();
        const operationId=typeof args.idempotency_key==='string'?args.idempotency_key:createHash('sha256').update(JSON.stringify([scope.agentId,native.activeTurn?.turnId,args])).digest('hex');
        const result=await tasks.start({botId:id,scope},{...args,operationId});
        return{ok:true,value:{...result,action:op,botId:id,taskId:result.task.id,task_id:result.task.id,session_id:result.task.childSessionId,status:result.task.status,completion_destination:scope.groupId?'group':'task-card'}};
      }
      if(!taskId)throwIpcError('INVALID_PARAMS','A task_id is required');
      const task=(await tasks.get(id,taskId)).task;
      // The requesting companion owns the task; a different group lane does not inherit it.
      if(task.parentSessionId!==scope.agentId)throwIpcError('TASK_NOT_OWNED','This session did not create the task');
      if(op==='check_session_task')return{ok:true,value:{action:op,botId:id,taskId,task_id:taskId,task}};
      if(task.responsibility==='released')throwIpcError('TASK_RESPONSIBILITY_RELEASED','The companion no longer owns follow-up responsibility for this task');
      if(op==='message_session_task'){
        const operationId=typeof args.idempotency_key==='string'?args.idempotency_key:createHash('sha256').update(JSON.stringify([scope.agentId,taskId,paseo.agents.ref(scope.agentId).activeTurn?.turnId,args])).digest('hex');
        return{ok:true,value:await tasks.message(id,taskId,{...args,operationId})};
      }
      if(op==='stop_session_task')return{ok:true,value:await tasks.stop(id,taskId,args.mode)};
      throwIpcError('UNSUPPORTED','This session tool is not connected');
    });}catch(error){return{ok:false,code:error instanceof CompanionError?error.code:'SESSION_TOOL_ERROR',message:error instanceof Error?error.message:String(error)};}
  }
  async applyPendingForAgent(paseo: Paseo, agentId: string): Promise<void> {
    return this.admit(async () => {
      const state = await this.store.snapshot();
      const id = Object.keys(state.bindings).find(id => state.bindings[id]!.agentId === agentId);
      if (id) await this.runtime.applyProfile(paseo, id);
    });
  }
  restoreToolEndpoint(): Promise<void> {
    return this.admit(async () => {
      const profiles = await this.store.list(); const state = await this.store.snapshot();
      const id = profiles.find(profile => profile.canonicalSessionId)?.id ?? Object.values(state.routines)[0]?.botId ??
        Object.values(state.groups ?? {}).flatMap(group => Object.values(group.lanes)).find(lane => state.profiles[lane.botId])?.botId??
        Object.values(state.groupPlans??{}).flatMap(plan=>Object.values(plan.lanes)).find(lane=>state.profiles[lane.botId])?.botId;
      if (id) await this.runtime.instructionsFor(id);
    });
  }
  beforeCreateRoutine(request: PluginBeforeRequests['agent.create'], paseo: Paseo) {
    return this.admit(() => this.routines.beforeCreate(request, paseo));
  }
  async invokeMemoryTool(id: string, op: string, args: Record<string, unknown>): Promise<InvokeResult> {
    try {
      return await this.admit(async () => {
        botId(id);
        if (op === 'profile.context') {
          await this.store.reconcile(id);
          const p = await this.store.get(id);
          return { ok: true, value: { name: p.name, identitySource: p.identitySource, userContextSource: p.userContextSource,
            memoryEnabled: p.capabilities.memory, version: p.currentVersion } };
        }
        if (!['memory.list', 'memory.read', 'memory.create', 'memory.update', 'memory.delete'].includes(op)) throwIpcError('INVALID_PARAMS', 'Unsupported companion memory tool');
        if (!(await this.store.get(id)).capabilities.memory) throwIpcError('MEMORY_DISABLED', 'Memory is disabled for this companion');
        return { ok: true, value: await this.dispatch({ op, args: { ...args, botId: id } }, {} as Paseo) };
      });
    } catch (error) {
      return { ok: false, code: error instanceof CompanionError ? error.code : 'MEMORY_ERROR', message: error instanceof Error ? error.message : String(error) };
    }
  }
  private async memoryStore(id: string): Promise<CompanionMemoryStore> {
    const p = await this.store.get(id); await this.store.checkHome(id);
    let store = this.memoryStores.get(id);
    if (!store) { store = new CompanionMemoryStore(join(p.homeDir, 'memories'), async () => { await this.store.get(id); await this.store.checkHome(id); }); this.memoryStores.set(id, store); }
    return store;
  }
  caps() { return { version: BOT_SETTINGS_PROTOCOL_VERSION, ops: [...OPS] }; }
  async bootstrap(paseo: Paseo, requestedId?: string): Promise<BootstrapData> {
    const profiles = await this.store.list();
    const bot = requestedId ? await this.store.get(requestedId) : profiles.find(p => p.id === 'cindy') ?? profiles[0]!;
    let models: unknown;
    try { models = await this.runtime.catalog(paseo, bot.id); }
    catch (error) { models = { entries: [], error: error instanceof Error ? error.message : String(error) }; }
    return { bot, profiles, caps: this.caps(), models,
      home: { name: hostname(), local: true, transferSupported: false, directory: bot.homeDir }, runtime: await this.runtime.refreshState(paseo, bot.id) };
  }
  async invoke(input: InvokeInput, paseo: Paseo): Promise<InvokeResult> {
    try { return { ok: true, value: await this.admit(() => this.dispatch(input, paseo)) }; }
    catch (error) { return { ok: false, code: error instanceof CompanionError ? error.code : 'HOST_ERROR', message: error instanceof Error ? error.message : String(error) }; }
  }
  private async dispatch({ op, args }: InvokeInput, paseo: Paseo): Promise<unknown> {
    // Native creation/send and deletion share admission. A late starter callback
    // cannot recreate or append to a teammate after its delete has begun.
    if (['profile.update', 'profile.chooseAvatar', 'profile.ensure', 'paseo.conversation.ensure',
      'conversation.send', 'preset.opening.choose', 'lifecycle.run'].includes(op)) {
      const id = botId(args.botId);
      const previous = this.profileMutations.get(id) ?? Promise.resolve();
      const current = previous.catch(() => {}).then(() => this.dispatchUnlocked({ op, args }, paseo));
      this.profileMutations.set(id, current);
      void current.finally(() => { if (this.profileMutations.get(id) === current) this.profileMutations.delete(id); }).catch(() => {});
      return current;
    }
    return this.dispatchUnlocked({ op, args }, paseo);
  }
  private async dispatchUnlocked({ op, args }: InvokeInput, paseo: Paseo): Promise<unknown> {
    if (op === 'caps') return this.caps();
    if (op === 'assets.fontChunk') return readFontChunk(args);
    if (op === 'paseo.presets.list') return this.presets.list();
    if (op === 'paseo.presets.invite') return this.presets.invite(args);
    if (op === 'paseo.presets.status') return this.presets.status(string(args.requestId, 'requestId', 200));
    if(op.startsWith('companion.tasks.')){
      if(op==='companion.tasks.owner'){
        const agentId=string(args.agentId,'agentId',100),state=await this.store.snapshot(),taskId=state.taskAgents?.[agentId],saved=taskId?state.companionTasks?.[taskId]:undefined;
        if(!saved?.lane||saved.lane.agentId!==agentId||saved.lane.phase!=='ready')return{owner:null};
        const agent=paseo.agents.ref(agentId);if(!await agent.refresh()||agent.cwd!==saved.lane.cwd||agent.workspaceId!==saved.view.workspaceId||(args.workspaceId!==undefined&&args.workspaceId!==agent.workspaceId))return{owner:null};
        const profile=state.profiles[saved.owner.botId]??state.deletedProfiles?.[saved.owner.botId]?.profile;if(!profile)return{owner:null};
        return{owner:{botId:profile.id,name:profile.name,avatar:profile.avatar,avatarColor:profile.avatarColor,taskId:saved.view.id,responsibility:saved.view.responsibility,canonicalSessionId:profile.canonicalSessionId}};
      }
      const id=botId(args.botId),tasks=this.tasks(paseo);await this.store.get(id);
      if(op==='companion.tasks.list')return tasks.list(id,args.groupId===undefined?undefined:botId(args.groupId));
      if(op==='companion.tasks.start'){
        const state=await this.store.snapshot(),agentId=string(args.parentAgentId,'parentAgentId',100);
        const binding=state.bindings[id];let scope:SessionScope|undefined=binding?.agentId===agentId?binding.sessionScope:undefined;
        if(!scope)for(const group of Object.values(state.groups??{})){const lane=Object.values(group.lanes).find(l=>l.botId===id&&l.agentId===agentId);if(lane?.sessionScope){scope=lane.sessionScope;break;}}
        if(!scope)throwIpcError('SESSION_SCOPE_REQUIRED','Open or refresh a companion session that supports collaboration');
        await validateSessionBinding(this.store,paseo,id,scope);return tasks.start({botId:id,scope},args);
      }
      const taskId=string(args.taskId,'taskId',128);
      const task=(await tasks.get(id,taskId)).task;
      if((args.parentAgentId!==undefined&&args.parentAgentId!==task.parentSessionId)||(args.groupId!==undefined&&args.groupId!==task.groupId))throwIpcError('TASK_SCOPE_MISMATCH','The task row belongs to a different conversation');
      if(op==='companion.tasks.get')return tasks.get(id,taskId);
      if(op==='companion.tasks.message')return tasks.message(id,taskId,args);
      if(op==='companion.tasks.stop')return tasks.stop(id,taskId,args.mode);
      if(op==='companion.tasks.responsibility')return tasks.responsibility(id,taskId,args.action);
      if(op==='companion.tasks.artifact'){
        return tasks.artifact(id,taskId,string(args.path,'path',4096),args.receiptId===undefined?undefined:string(args.receiptId,'receiptId',128));
      }
      return unsupported(op);
    }
    if (op === 'groups.list') return this.groups.list(paseo);
    if (op === 'groups.create') return this.groups.create(paseo, args);
    if (op.startsWith('groups.')) {
      const groupId = botId(args.groupId);
      // Internal topic execution IDs are not public group IDs. Every RPC keeps the real room boundary.
      const publicGroup = (await this.store.snapshot()).groups?.[groupId];
      if (!publicGroup || publicGroup.deletedAt) throwIpcError('NOT_FOUND', 'Group not found');
      if (op.startsWith('groups.history.') || op.startsWith('groups.threads.')) {
        if (args.actorId !== undefined || args.callerId !== undefined) throwIpcError('INVALID_PARAMS', 'History actors are assigned by the host');
        if (op === 'groups.history.get') return this.groupHistory.get(paseo, groupId, args);
        if (op === 'groups.history.send') return this.groupHistory.send(paseo, groupId, args);
        if (op === 'groups.history.react') return this.groupHistory.react(groupId, args);
        if (op === 'groups.history.reactors') return this.groupHistory.reactors(groupId, args);
        if (op === 'groups.threads.get') return this.groupHistory.thread(paseo, groupId, args);
        if (op === 'groups.threads.reply') return this.groupHistory.reply(paseo, groupId, args);
        if (op === 'groups.threads.follow') return this.groupHistory.follow(paseo, groupId, args);
        if (op === 'groups.threads.shareToMain') return this.groupHistory.share(paseo, groupId, args);
        if (op === 'groups.threads.stop' || op === 'groups.threads.continue') return this.groupHistory.action(paseo, groupId, args, op.endsWith('.stop') ? 'stop' : 'continue');
        return unsupported(op);
      }
      if(op==='groups.cleanup')return this.groups.cleanup(paseo,groupId);
      if(op.startsWith('groups.plans.')){
        const {plans,organizer}=this.work(paseo);await plans.init();await organizer.init();
        if(op==='groups.plans.list')return{...await plans.list(groupId),requests:await organizer.list(groupId)};
        if(op==='groups.plans.create')return organizer.create(groupId,args);
        if(op==='groups.plans.settings')return plans.settings(groupId,args);
        if(op==='groups.plans.directories'){await plans.list(groupId);return browsePlanDirectories(args.path===undefined?undefined:string(args.path,'path',4096));}
        if(op==='groups.plans.cancelRequest')return organizer.cancel(groupId,string(args.requestId,'requestId',200));
        const planId=string(args.planId,'planId',200);
        if(op==='groups.plans.artifact')return plans.artifact(groupId,planId,Number(args.position),string(args.path,'artifact path',4096),args.messageId===undefined?undefined:string(args.messageId,'messageId',200));
        if(!Number.isSafeInteger(args.expectedRevision))throwIpcError('INVALID_PARAMS','Invalid plan revision');
        const input={...args,groupId,planId,expectedRevision:Number(args.expectedRevision),operationId:string(args.operationId,'operationId',200)};
        if(op==='groups.plans.revise')return organizer.create(groupId,{operationId:input.operationId,request:string(args.text,'text',16000)}, {planId,expectedRevision:input.expectedRevision});
        const action=op.slice('groups.plans.'.length);
        if(['start','continue','retry','stop','dismiss','edit','note'].includes(action))return plans.action(action as 'start',input);
        return unsupported(op);
      }
      if (op === 'groups.get') {const result=await this.groups.get(paseo, groupId, args);const {plans,organizer}=this.work(paseo);return{...result,...await plans.list(groupId),requests:await organizer.list(groupId)};}
      if (op === 'groups.update' || op === 'groups.setMembers') return this.groups.update(paseo, groupId, args, op === 'groups.setMembers');
      if (op === 'groups.send') {
        const operationId=string(args.clientMessageId,'clientMessageId',200),text=string(args.text,'text',32000),tracked=parseTrackedMentions(args.trackedMentions);
        const work=this.work(paseo);const replay=await work.organizer.replay(groupId,operationId,text)??await work.plans.replayNote(groupId,operationId,text);
        if(replay)return replay;
        const state=await this.store.snapshot(),group=state.groups?.[groupId];
        if(group){const mentions=resolveBotGroupMentions(text,{members:group.botIds.map(id=>({botId:id,name:state.profiles[id]?.name??id})),tracked,allLabels:['all','everyone','所有人','全部','大家']});
          const openPlan=Object.values(state.groupPlans??{}).find(p=>p.view.groupId===groupId&&['proposed','running','waiting'].includes(p.view.status));
          if(openPlan&&group.replyMode==='all'&&!mentions.all&&!mentions.botIds.length){
            const {plans,organizer}=work;
            if(openPlan.view.status==='proposed')return organizer.create(groupId,{operationId,request:args.text},{planId:openPlan.view.id,expectedRevision:openPlan.view.revision});
            const result=await plans.action('note',{groupId,planId:openPlan.view.id,expectedRevision:openPlan.view.revision,operationId,text:args.text});
            return{...result,...await plans.replayNote(groupId,operationId,text)};
          }
        }
        return this.groups.send(paseo, groupId, args);
      }
      if (op === 'groups.continue') return this.groups.continue(paseo, groupId, args);
      if (op === 'groups.stop') return this.groups.stop(paseo, groupId, string(args.roundId, 'roundId', 200));
      if (op === 'groups.delete') return this.groups.remove(paseo, groupId, args.expectedRevision);
      return unsupported(op);
    }
    if (op === 'paseo.bootstrap') return this.bootstrap(paseo, args.botId === undefined ? undefined : botId(args.botId));
    if (op === 'profile.list') return { profiles: await this.store.list() };
    if (op === 'profile.create') return { profile: await this.store.create(args) };
    if (op === 'models.default') return { modelChain: [await this.runtime.defaultRoute(paseo, typeof args.botId === 'string' ? botId(args.botId) : 'cindy')] };
    // Unsupported host-wide operations must remain a visible failure, not fabricated empty catalogs.
    if (/^(voice\.|channels\.|autonomy\.)/.test(op)) return unsupported(op);
    if (op === 'routines.sources') return []; // This adapter has time triggers only; no event connector is registered.
    const id = botId(args.botId);
    if (op === 'preset.opening.status') return this.openings.status(paseo, id, string(args.agentId, 'agentId', 100));
    if (op === 'preset.opening.choose') return this.openings.choose(paseo, id, string(args.agentId, 'agentId', 100), args.option);
    if (op === 'models.features') {
      const p = await this.store.get(id); const model = string(args.model, 'model', 500);
      const harness = args.harness === 'claude' ? 'claude' : args.harness === 'pi' ? 'pi' : args.harness === 'codex' ? 'codex' : null;
      if (!harness) throwIpcError('INVALID_PARAMS', 'Invalid model harness');
      const provider = args.providerId ? string(args.providerId, 'provider', 200) : harness;
      const result = await paseo.providers.listFeatures({ provider: `${provider}/${model}`, cwd: join(p.homeDir, 'workspace'),
        ...(args.effort ? { thinkingOptionId: string(args.effort, 'effort', 100) } : {}) });
      if (result.error) throwIpcError('PROVIDER_FEATURES_UNAVAILABLE', result.error);
      return result;
    }
    if (op === 'routines.list') return this.routines.list(id, paseo);
    if (op === 'routines.reconcile') return this.routines.reconcile(id, string(args.id, 'routine id', 200), paseo);
    if (['routines.save', 'routines.saveWithModel', 'routines.saveWithSessionMode'].includes(op)) return this.routines.save(paseo, id, args.input, args.id === undefined ? undefined : string(args.id, 'routine id', 200));
    if (op === 'routines.history') return this.routines.history(id, string(args.id, 'routine id', 200), paseo);
    if (op === 'routines.runNow') return this.routines.run(id, string(args.id, 'routine id', 200), paseo, args.operationId === undefined ? undefined : string(args.operationId, 'operation id', 200));
    if (op === 'routines.remove') { await this.routines.remove(id, string(args.id, 'routine id', 200), paseo); return null; }
    if (op === 'profile.get') { await this.store.reconcile(id); return { profile: await this.store.get(id), runtime: await this.runtime.refreshState(paseo, id) }; }
    if (op === 'profile.update') {
      const expected = args.expectedVersion;
      if (expected !== undefined && (!Number.isSafeInteger(expected) || Number(expected) < 1)) throwIpcError('INVALID_PARAMS', 'Invalid expectedVersion');
      const profile = await this.store.update(id, record(args.patch), expected as number | undefined);
      try { return { profile, runtime: await this.runtime.applyProfile(paseo, id) }; }
      catch (error) { return { profile, runtime: { ...await this.runtime.state(id), state: 'pending', code: 'RUNTIME_APPLY_FAILED', message: error instanceof Error ? error.message : String(error) } }; }
    }
    if (op === 'profile.chooseAvatar') {
      const profile = await this.store.update(id, { avatar: avatarDataUrl(args.avatarImageBase64), ...(args.expectedAvatar === undefined ? {} : { expectedAvatar: args.expectedAvatar }) });
      return { profile, runtime: await this.runtime.state(id) };
    }
    if (['profile.ensure', 'paseo.conversation.ensure'].includes(op)) {
      const result = await this.runtime.ensure(paseo, id);
      await this.openings.ensure(paseo, id, result.agentId);
      return result;
    }
    if (op === 'conversation.send') {
      const text = string(args.text, 'message', 100000); const messageId = string(args.clientMessageId, 'clientMessageId', 200);
      const { agentId } = await this.runtime.ensure(paseo, id);
      const agent = paseo.agents.ref(agentId); await agent.refresh();
      if (agent.activeTurn || agent.status === 'running' || agent.status === 'initializing') throwIpcError('AGENT_BUSY', 'The companion is still working');
      await agent.send(text, { messageId, activeTurnBehavior: 'interrupt' });
      await this.store.transaction(state => { const p = state.profiles[id]!; p.lastMessagePreview = text.slice(0, 240); p.lastMessageAt = Date.now(); p.lastMessageRole = 'user'; });
      return { accepted: true, agentId, messageId };
    }
    if (op === 'conversation.history') {
      const p = await this.store.get(id); if (!p.canonicalSessionId) return { entries: [], hasOlder: false, hasNewer: false };
      return this.history(paseo, p.canonicalSessionId, args);
    }
    if (op === 'history.search') return this.searchHistory(paseo, await this.store.get(id), string(args.query, 'query', 1000), Number(args.limit ?? 20));
    if (op === 'memory.list') return this.memory.list(id, args.query);
    if (op === 'memory.read') return this.memory.read(id, args.filename);
    if (op === 'memory.update') return this.memory.update({ botId: id, filename: string(args.filename, 'filename', 256), title: string(args.title, 'title', 1000), body: string(args.body, 'body', 8192), expectedUpdatedAt: string(args.expectedUpdatedAt, 'expectedUpdatedAt', 64) });
    if (op === 'memory.delete') { await this.memory.delete({ botId: id, filename: string(args.filename, 'filename', 256), expectedUpdatedAt: string(args.expectedUpdatedAt, 'expectedUpdatedAt', 64) }); return null; }
    if (op === 'memory.create') {
      if (!['user', 'feedback', 'project', 'reference'].includes(String(args.type))) throwIpcError('INVALID_PARAMS', 'Invalid memory type');
      const store = await this.memoryStore(id);
      const name = string(args.name, 'memory name', 64); const title = string(args.title, 'title', 100); const body = string(args.body, 'body', 8192);
      const result = await store.write({ type: args.type as 'user', name, title, body, description: string(args.description ?? title, 'description', 200) });
      return this.memory.read(id, result.filename);
    }
    if (op === 'capabilities.catalog') {
      const p = await this.store.get(id); if (!p.canonicalSessionId) return { personal: [], entries: { skill: [], mcp: [], toolset: [] }, state: 'not-created', configurable: false,
        code: 'CAPABILITY_SELECTION_UNSUPPORTED', message: 'Start the companion to inspect provider-native skills. Per-companion skill, external MCP and toolset selection is not exposed by this host.' };
      const result = await paseo.agents.ref(p.canonicalSessionId).commands();
      if (result.error) throwIpcError('CAPABILITY_CATALOG_UNAVAILABLE', result.error);
      return { personal: [], entries: { skill: result.commands.filter(command => command.kind === 'skill').map(command => ({ id: command.name, name: command.name, description: command.description ?? '', available: false, joined: p.skills.includes(command.name),
        reason: 'Visible through the provider; per-companion skill selection is not available on this host.' })),
        mcp: [], toolset: [] }, configurable: false, code: 'CAPABILITY_SELECTION_UNSUPPORTED', message: 'Provider-native skills are shown for reference. This host does not expose per-companion skill, external MCP or toolset selection.',
        configured: { skills: p.skills, mcpServers: p.capabilities.mcpServers, toolsets: p.capabilities.toolsets }, runtime: await this.runtime.state(id) };
    }
    if (op === 'home.get') { const p = await this.store.get(id); return { name: hostname(), local: true, transferSupported: false, directory: p.homeDir }; }
    if (op === 'paseo.openPath') {
      const p = await this.store.get(id);
      if (args.path !== undefined && args.path !== p.homeDir) throwIpcError('UNSAFE_PATH', 'Only this companion home can be opened');
      await this.store.checkHome(id);
      if (process.platform !== 'darwin' && process.platform !== 'linux') return unsupported('Open folder on this platform');
      await promisify(execFile)(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [p.homeDir], { timeout: 10000 });
      return { success: true };
    }
    if (op === 'profile.retryInvitation') return unsupported('Companion invitation generation');
    if (op === 'lifecycle.run') {
      if (args.action !== 'delete') return unsupported(`Companion ${String(args.action)}`);
      if (args.keepTaskHistory !== true || args.worktreeDisposition === 'recycle') return unsupported('Deleting native conversation history or worktrees');
      const p = await this.store.get(id);
      if (id === 'cindy') throwIpcError('DEFAULT_COMPANION', 'The default Cindy companion cannot be deleted');
      const confirmName = string(args.confirmName, 'confirmation name', 200);
      if (confirmName !== p.name) throwIpcError('PRECONDITION_FAILED', 'Companion name changed; confirm again');
      const state = await this.store.snapshot();
      if (Object.values(state.routines).some(routine => routine.botId === id)) throwIpcError('ROUTINES_EXIST', 'Remove this companion’s routines before deleting it');
      if(Object.values(state.companionTasks??{}).some(task=>task.owner.botId===id&&taskNeedsSettlement(task)))throwIpcError('TASK_BUSY','Stop this companion’s delegated tasks before deleting it');
      if (Object.values(state.groups ?? {}).some(group => !group.deletedAt && group.botIds.includes(id))) throwIpcError('GROUP_MEMBERSHIP_EXISTS', 'Remove this companion from its groups before deleting it');
      if (state.bindings[id]?.phase && state.bindings[id]?.phase !== 'ready') throwIpcError('CREATE_OUTCOME_UNKNOWN', 'Resolve pending agent creation before deleting the companion');
      await this.store.transaction(current=>{
        if(Object.values(current.companionTasks??{}).some(task=>task.owner.botId===id&&taskNeedsSettlement(task)))throwIpcError('TASK_BUSY','A delegated task was admitted before deletion');
        if(Object.values(current.groups??{}).some(group=>!group.deletedAt&&group.botIds.includes(id)))throwIpcError('GROUP_MEMBERSHIP_EXISTS','A group still contains this companion');
        if(Object.values(current.routines).some(routine=>routine.botId===id))throwIpcError('ROUTINES_EXIST','A routine still belongs to this companion');
        (current.profileDeletions??={})[id]??={requestedAt:Date.now()};
      });
      const agents = await Promise.all(p.sessions.map(async session => { const agent = paseo.agents.ref(session.id); return await agent.refresh() ? agent : null; }));
      if (agents.some(agent => agent && (agent.activeTurn || agent.status === 'running' || agent.status === 'initializing'))) throwIpcError('AGENT_BUSY', 'Wait for this companion’s current work to finish before deleting it');
      for (const agent of agents) if (agent && !agent.archivedAt) await agent.archive();
      await this.store.deleteProfile(id, confirmName); this.memoryStores.delete(id);
      return { action: 'delete', botId: id, deleted: true, keepTaskHistory: true, worktreeDisposition: 'retain' };
    }
    return unsupported(op);
  }
  private async history(paseo: Paseo, agentId: string, args: Record<string, unknown>) {
    const limit = Math.max(1, Math.min(200, Number(args.limit ?? 100)));
    const page = await paseo.agents.ref(agentId).timeline.refetch({ limit,
      ...(args.cursor ? { cursor: args.cursor as never, direction: 'before' as const } : {}) });
    if (page.error) throwIpcError('HISTORY_UNAVAILABLE', page.error); return page;
  }
  private async searchHistory(paseo: Paseo, p: CompanionProfile, query: string, limit: number) {
    const needle = query.toLocaleLowerCase(); const results: unknown[] = []; let capped = false;
    for (const session of p.sessions.filter(s => s.status !== 'deleted')) {
      const page = await this.history(paseo, session.id, { limit: 200 }); capped ||= page.hasOlder;
      const hits = page.entries.flatMap(entry => {
        const item = entry.item as unknown as Record<string, unknown>;
        const text = typeof item.text === 'string' ? item.text : typeof item.content === 'string' ? item.content : '';
        const index = text.toLocaleLowerCase().indexOf(needle); if (index < 0) return [];
        return [{ messageId: String(item.id ?? entry.seqStart), messageClientId: String(item.id ?? entry.seqStart), role: item.role ?? (item.type === 'user_message' ? 'user' : 'assistant'),
          createdAt: String(item.createdAt ?? entry.timestamp), snippet: null, preview: text.slice(Math.max(0, index - 60), index + 180), score: 1, ftsRank: null, vectorRank: null }];
      });
      const titleMatch = session.title.toLocaleLowerCase().indexOf(needle);
      if (!hits.length && titleMatch < 0) continue;
      results.push({ session: { id: session.id, title: session.title, workingDir: join(p.homeDir, 'workspace'), workspaceKind: 'dialogue', agentKind: p.capabilities.harness === 'claude' ? 'cc' : p.capabilities.harness,
        status: session.status, userSendAt: null, createdAt: new Date(p.createdAt).toISOString(), updatedAt: new Date(session.updatedAt).toISOString(), _count: { messages: page.entries.length },
        companion: { id: p.id, name: p.name, role: session.role, readOnly: false } }, matchKind: titleMatch >= 0 ? hits.length ? 'both' : 'title' : 'content',
        titleMatchIndices: titleMatch >= 0 ? [titleMatch] : [], titleScore: titleMatch >= 0 ? 1 : null, contentHit: hits[0] ?? null, contentHits: hits, rankScore: 1 });
    }
    return { query, results: results.slice(0, Math.min(100, Math.max(1, limit))), vectorUsed: false, vectorSkipReason: 'keyword-only', poolCapped: capped };
  }
}
