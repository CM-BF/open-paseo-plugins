import { randomUUID } from 'node:crypto';
import type { Paseo } from './runtime';
import { throwIpcError } from './errors';
import type { SessionScope } from '../shared/session-scope';
import { assertNativeSkillsSupport, nativeConfigOnly, skillsIntentFromConfig } from './native-skills';

export interface GroupLane {
  agentId: string; operationId: string; groupId: string; roundId: string; botId: string;
  cwd: string; title: string; config: Record<string, unknown>; phase: 'creating' | 'ready' | 'unknown';
  workspaceId?: string;
  scope?: 'main' | 'talk' | 'thread'; retired?: boolean;
  threadRootId?: string;
  sessionScope?: SessionScope;
  dispatch?: LaneDispatch;
  cleanupPending?:boolean;
  cleanupCode?:string;
}
/** Persisted before admission; a lost acknowledgement is never inferred from idle. */
export interface LaneDispatch {
  messageId:string; cancelMessageId:string;
  phase:'prepared'|'dispatching'|'accepted'|'not-sent'|'unknown'|'completed';
  turnId?:string; code?:string;
}
export const prepareLaneDispatch=(messageId:string):LaneDispatch=>({messageId,cancelMessageId:randomUUID(),phase:'prepared'});
export function stopFailureCode(error:unknown):string {
  const code=(error as {code?:string})?.code;
  return ['ADMISSION_OUTCOME_UNKNOWN','GROUP_STOP_REQUIRES_NATIVE','GROUP_LANE_MISMATCH'].includes(code??'')?code!:'STOP_NOT_CONFIRMED';
}
export interface GroupDriver {
  ensure(lane: GroupLane): Promise<{ workspaceId?: string }>;
  reply(lane: GroupLane, input: { prompt: string; messageId: string; signal: AbortSignal; permission: (waiting: boolean) => void;timeoutMs?:number;requireIdleAdmission?:boolean;admitted?:(turnId:string)=>Promise<void>;recordDispatch?:(receipt:LaneDispatch)=>Promise<void> }): Promise<string>;
  stop(lane: GroupLane): Promise<void>;
  archive(lane: GroupLane): Promise<void>;
  configure?(lane: GroupLane, config: Record<string, unknown>): Promise<void>;
}
/** Background lanes are user-accessible: all dispatch and cancellation is turn-bound. */
export class NativeGroupDriver implements GroupDriver {
  constructor(private readonly paseo: Paseo) {}
  async ensure(lane: GroupLane) {
    let agent = this.paseo.agents.ref(lane.agentId);
    const found = await agent.refresh();
    if (!found || (lane.phase !== 'ready' && skillsIntentFromConfig(lane.config))) {
      if (lane.phase === 'ready') throwIpcError('GROUP_LANE_MISSING', 'The group conversation is missing');
      assertNativeSkillsSupport(this.paseo, lane.config);
      agent = await this.paseo.agents.create({ agentId: lane.agentId, idempotencyKey: lane.operationId,
        config: nativeConfigOnly(lane.config) as never, cwd: lane.cwd, title: lane.title, background: true,
        labels: { 'cindy-companion.groupId': lane.groupId, 'cindy-companion.botId': lane.botId, 'cindy-companion.roundId': lane.roundId,
          ...(lane.threadRootId ? { 'cindy-companion.threadRootId': lane.threadRootId } : {}) } });
      if(!await agent.refresh())throwIpcError('GROUP_CREATE_NOT_CONFIRMED','Native creation returned without a readable group session');
    }
    if (agent.archivedAt || agent.cwd !== lane.cwd) throwIpcError('GROUP_LANE_MISMATCH', 'The group conversation no longer matches its binding');
    return { workspaceId: agent.workspaceId ?? undefined };
  }
  async configure(lane: GroupLane, config: Record<string, unknown>) {
    if (Object.hasOwn(lane.config,'skillMounts') && !Object.hasOwn(config,'skillMounts'))
      throwIpcError('NATIVE_SKILL_MOUNTS_UNSUPPORTED','The previous native mounts cannot be refreshed or cleared by this connected SDK');
    assertNativeSkillsSupport(this.paseo, config);
    if (JSON.stringify(lane.config) === JSON.stringify(config)) return;
    const agent = this.paseo.agents.ref(lane.agentId) as ReturnType<Paseo['agents']['ref']> & {
      setModel?: (model: string | null) => Promise<void>; setThinkingOption?: (effort: string | null) => Promise<unknown>;
      setFeature?: (id: string, value: unknown) => Promise<void>;
      updateInstructions?: (config: { systemPrompt: string; mcpServers?: Record<string, unknown>; skillMounts?: Array<{directory:string}> }) => Promise<unknown>;
    };
    await agent.refresh();
    if (agent.activeTurn || agent.status === 'running' || agent.pendingPermissions?.length) throwIpcError('GROUP_LANE_BUSY', 'The group conversation is still active');
    const oldProvider = String(lane.config.provider).split('/')[0]; const selection = String(config.provider);
    if (oldProvider !== selection.split('/')[0]) throwIpcError('HOST_UPGRADE_REQUIRED', 'This host cannot change the provider of an existing group conversation');
    const modelChanged = lane.config.provider !== config.provider;
    const effortChanged = lane.config.thinkingOptionId !== config.thinkingOptionId;
    const featuresChanged = JSON.stringify(lane.config.featureValues ?? {}) !== JSON.stringify(config.featureValues ?? {});
    const instructionsChanged = JSON.stringify([lane.config.systemPrompt, lane.config.mcpServers, skillsIntentFromConfig(lane.config), lane.config.skillMounts]) !== JSON.stringify([config.systemPrompt, config.mcpServers, skillsIntentFromConfig(config), config.skillMounts]);
    if ((modelChanged && !agent.setModel) || (effortChanged && !agent.setThinkingOption) || (featuresChanged && !agent.setFeature) || (instructionsChanged && !agent.updateInstructions))
      throwIpcError('HOST_UPGRADE_REQUIRED', 'Saved companion settings require a newer host to refresh this existing group conversation');
    if (modelChanged) await agent.setModel!(selection.slice(selection.indexOf('/') + 1));
    if (effortChanged) await agent.setThinkingOption!(typeof config.thinkingOptionId === 'string' ? config.thinkingOptionId : null);
    if (featuresChanged) {
      const old = (lane.config.featureValues ?? {}) as Record<string, unknown>; const next = (config.featureValues ?? {}) as Record<string, unknown>;
      for (const id of new Set([...Object.keys(old), ...Object.keys(next)])) await agent.setFeature!(id, next[id] ?? (id === 'fast_mode' ? false : 'default'));
    }
    if (instructionsChanged) await agent.updateInstructions!({ systemPrompt: String(config.systemPrompt ?? ''), mcpServers: (config.mcpServers ?? {}) as Record<string, unknown>,
      ...(Object.hasOwn(config,'skillMounts') ? {skillMounts:config.skillMounts as Array<{directory:string}>} : {}) });
  }
  async stop(lane: GroupLane) {
    const receipt=lane.dispatch;
    if(receipt&&['prepared','not-sent','completed'].includes(receipt.phase))return;
    if(receipt&&['dispatching','unknown'].includes(receipt.phase)&&!receipt.turnId)
      throwIpcError('ADMISSION_OUTCOME_UNKNOWN','Native admission is unconfirmed; do not resend or infer cancellation from idle');
    const agent = this.paseo.agents.ref(lane.agentId);
    if (!await agent.refresh()) {
      if (lane.phase !== 'ready') throwIpcError('STOP_NOT_CONFIRMED', 'Agent creation outcome is still unknown');
      return;
    }
    if (agent.cwd !== lane.cwd || (lane.workspaceId&&agent.workspaceId!==lane.workspaceId)) throwIpcError('GROUP_LANE_MISMATCH', 'Refusing to stop a different conversation');
    const exact=agent as typeof agent&{cancelTurn?:(input:{expectedTurnId:string;messageId:string})=>Promise<{status:'cancelled'|'changed'|'unavailable'}>};
    if(receipt?.turnId&&exact.cancelTurn){
      try{
        const result=await exact.cancelTurn({expectedTurnId:receipt.turnId,messageId:receipt.cancelMessageId});
        if(result.status==='cancelled'||result.status==='changed')return;
      }catch(error){if((error as {code?:string}).code!=='unsupported_capability')throw error;}
    }
    if (agent.activeTurn || agent.status === 'running' || agent.status === 'initializing' || agent.pendingPermissions?.length)
      throwIpcError('GROUP_STOP_REQUIRES_NATIVE','This host cannot stop only the owned turn; stop it in the native session, then retry Stop');
  }
  async archive(lane: GroupLane) {
    await this.stop(lane);
    const agent = this.paseo.agents.ref(lane.agentId);
    if (!await agent.refresh()) {if(lane.phase!=='ready')throwIpcError('CLEANUP_NOT_CONFIRMED','Native creation may still complete; its absence is not confirmed');return;}
    if (agent.cwd !== lane.cwd) throwIpcError('GROUP_LANE_MISMATCH', 'Refusing to archive a different conversation');
    // Public archive closes whatever turn is current. There is no atomic idle
    // archive contract, so even an idle precheck cannot authorize auto-cleanup.
    if (!agent.archivedAt) throwIpcError('GROUP_ARCHIVE_REQUIRES_NATIVE','Archive this conversation in Paseo, then confirm cleanup here');
  }
  async reply(lane: GroupLane, input: Parameters<GroupDriver['reply']>[1]): Promise<string> {
    const agent = this.paseo.agents.ref(lane.agentId);
    let receipt=lane.dispatch?.messageId===input.messageId?{...lane.dispatch}:prepareLaneDispatch(input.messageId);
    const record=async(patch:Partial<LaneDispatch>)=>{receipt={...receipt,...patch};lane.dispatch=receipt;await input.recordDispatch?.({...receipt});};
    if(!['prepared','not-sent'].includes(receipt.phase))throwIpcError('ADMISSION_OUTCOME_UNKNOWN','This input already has a native admission receipt; it cannot be resent');
    await agent.refresh();
    const busyCode=input.requireIdleAdmission?'TASK_BUSY':'GROUP_LANE_BUSY';
    if (agent.activeTurn || agent.status === 'running' || agent.status === 'initializing' || agent.pendingPermissions?.length){await record({phase:'not-sent',code:busyCode});throwIpcError(busyCode, 'This native conversation is already running; the input was not sent');}
    const guarded=agent as typeof agent&{sendIfIdle?:(text:string,options:{messageId:string})=>Promise<{status:'accepted';turnId:string}|{status:'busy'}|{status:'unavailable'}>};
    if(!guarded.sendIfIdle){await record({phase:'not-sent',code:'HOST_UPGRADE_REQUIRED'});throwIpcError('HOST_UPGRADE_REQUIRED','This host cannot atomically dispatch input to an idle conversation');}
    if (input.signal.aborted) throwIpcError('GROUP_STOPPED', 'Group stopped');
    let accepted = false; let settled = false; let waitingPermission = false;
    let dispatching = false; let started = false; let completed = false; let turnId: string | undefined;let endedTurnId:string|undefined;
    let timer: ReturnType<typeof setTimeout> | undefined; let remaining = input.timeoutMs??2 * 60 * 60 * 1000; let runningSince = Date.now();
    let resolve!: () => void; let reject!: (error: unknown) => void;
    const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Sending can fail while observation is already active.
    void finished.catch(() => {});
    const fail = (code: string) => { if (!settled) { settled = true; reject(Object.assign(new Error(code), { code })); } };
    const arm = () => { runningSince = Date.now(); timer = setTimeout(() => fail('RUNTIME_TIMEOUT'), remaining); };
    const inspect = () => {
      if (!accepted || settled) return;
      const permission = Boolean(agent.pendingPermissions?.length);
      if (permission !== waitingPermission) {
        waitingPermission = permission; input.permission(permission);
        if (permission) { if (timer) clearTimeout(timer); remaining = Math.max(1, remaining - (Date.now() - runningSince)); }
        else arm();
      }
      if (permission) return;
      if (agent.status === 'error') { fail('RUNTIME_ERROR'); return; }
      // An accepted send may still report the pre-dispatch idle snapshot. Only a native
      // completed event for the observed turn is completion evidence.
      if (started && completed) { settled = true; resolve(); }
    };
    const abort = () => fail('GROUP_STOPPED');
    const unsubscribe = agent.subscribe(inspect);
    const timeline = agent.timeline.subscribe(event => {
      const value = event.event;
      if (value.type === 'subscription_restored' || value.type === 'replacement' || value.type === 'error') { fail('CONNECTION_LOST'); return; }
      if (!dispatching || settled) return;
      if (value.type === 'turn_started') {
        if (started && value.turnId !== turnId) { fail('REPLY_NOT_CONFIRMED'); return; }
        started = true; turnId = value.turnId;
      }
      if (['turn_completed', 'turn_failed', 'turn_canceled'].includes(value.type)) {
        if (!started || ('turnId' in value && turnId && value.turnId !== turnId)) { fail('REPLY_NOT_CONFIRMED'); return; }
        endedTurnId=turnId;
        if (value.type === 'turn_failed') { fail('RUNTIME_ERROR'); return; }
        if (value.type === 'turn_canceled') { fail('GROUP_STOPPED'); return; }
        completed = true; inspect();
      }
    });
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      await timeline.ready;
      if (settled) await finished;
      if (input.signal.aborted) throwIpcError('GROUP_STOPPED', 'Group stopped');
      await record({phase:'dispatching'});
      if(input.signal.aborted) {await record({phase:'not-sent',code:'GROUP_STOPPED'});throwIpcError('GROUP_STOPPED','Group stopped');}
      dispatching = true;
      let admission:Awaited<ReturnType<NonNullable<typeof guarded.sendIfIdle>>>;
      try{admission=await guarded.sendIfIdle(input.prompt,{messageId:input.messageId});}
      catch(error){
        // A method/feature rejection happens before dispatch. Every other lost
        // acknowledgement stays uncertain; an idle snapshot cannot cancel it.
        if((error as {code?:string}).code==='unsupported_capability'){await record({phase:'not-sent',code:'HOST_UPGRADE_REQUIRED'});throw error;}
        await record({phase:'unknown',code:'ADMISSION_OUTCOME_UNKNOWN'});
        throw Object.assign(error instanceof Error?error:new Error(String(error)),{dispatchOutcome:'unknown'});
      }
      if(admission.status==='busy'){await record({phase:'not-sent',code:busyCode});throwIpcError(busyCode,'The conversation has another native turn; this input was not sent');}
      if(admission.status==='unavailable'){await record({phase:'not-sent',code:'PROVIDER_ADMISSION_UNAVAILABLE'});throwIpcError('PROVIDER_ADMISSION_UNAVAILABLE','This provider cannot guarantee an idle-only turn; the input was not sent');}
      if(admission.status!=='accepted'||typeof admission.turnId!=='string'||!admission.turnId){await record({phase:'unknown',code:'ADMISSION_OUTCOME_UNKNOWN'});throw Object.assign(new Error('Invalid native admission receipt'),{code:'ADMISSION_OUTCOME_UNKNOWN',dispatchOutcome:'unknown'});}
      await record({phase:'accepted',turnId:admission.turnId});
      await input.admitted?.(admission.turnId);
      if(turnId&&turnId!==admission.turnId)throwIpcError('REPLY_NOT_CONFIRMED','The native turn changed during admission');
      turnId=admission.turnId;
      accepted = true; arm(); await agent.refresh(); inspect(); await finished;
      if (input.signal.aborted) throwIpcError('GROUP_STOPPED', 'Group stopped');
      // Completion alone is insufficient: bind the answer to this exact persisted input.
      const entries: Array<{ turnId?: string; item: { type: string; text?: string; clientMessageId?: string; messageId?: string } }> = [];
      let cursor: unknown;
      for (let pageNo = 0; pageNo < 50; pageNo++) {
        const page = await agent.timeline.refetch({ limit: 200, projection: 'canonical', ...(cursor ? { cursor: cursor as never, direction: 'before' as const } : {}) });
        if (page.error) throwIpcError('REPLY_NOT_CONFIRMED', 'Cannot read the completed group turn');
        entries.unshift(...page.entries);
        if (entries.some(entry => entry.item.type === 'user_message' && (entry.item.clientMessageId === input.messageId || entry.item.messageId === input.messageId))) break;
        if (!page.hasOlder || !page.startCursor) break; cursor = page.startCursor;
      }
      const start = entries.findIndex(entry => entry.item.type === 'user_message' && (entry.item.clientMessageId === input.messageId || entry.item.messageId === input.messageId));
      if (start < 0 || entries.slice(start + 1).some(entry => entry.item.type === 'user_message')) throwIpcError('REPLY_NOT_CONFIRMED', 'Cannot attribute the group answer to its request');
      const replies = entries.slice(start + 1).filter(entry => entry.item.type === 'assistant_message' && typeof entry.item.text === 'string');
      if (turnId && replies.some(entry => entry.turnId && entry.turnId !== turnId)) throwIpcError('REPLY_NOT_CONFIRMED', 'The answer belongs to another native turn');
      const text = replies.at(-1)?.item.text;
      if (text === undefined) throwIpcError('REPLY_NOT_CONFIRMED', 'The completed turn has no confirmed assistant reply');
      return text;
    } finally {
      if (timer) clearTimeout(timer); unsubscribe(); timeline(); input.signal.removeEventListener('abort', abort);
      if(receipt.turnId&&endedTurnId===receipt.turnId)await record({phase:'completed'});
    }
  }
}
