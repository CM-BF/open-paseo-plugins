import { randomUUID } from 'node:crypto';
import type { Paseo } from './runtime';
import { throwIpcError } from './errors';
import type { SessionScope } from '../shared/session-scope';
import { assertNativeSkillsSupport, nativeConfigOnly, skillsIntentFromConfig } from './native-skills';
import { NativeLaneInput, prepareNativeLaneInput, type NativeLaneInputRecord, type NativeLanePublicApi, type NativeCreationOptions } from './native-lane-input';

export interface GroupLane {
  agentId: string; operationId: string; groupId: string; roundId: string; botId: string;
  cwd: string; title: string; config: Record<string, unknown>; phase: 'creating' | 'ready' | 'unknown';
  workspaceId?: string;
  scope?: 'main' | 'talk' | 'thread'; retired?: boolean;
  threadRootId?: string;
  sessionScope?: SessionScope;
  /** New lanes persist their first input before native creation; absent on legacy empty creates. */
  nativeInputVersion?: 1;
  dispatch?: LaneDispatch;
  cleanupPending?:boolean;
  cleanupCode?:string;
}
/** Persisted before admission; a lost acknowledgement is never inferred from idle. */
export interface LaneDispatch {
  messageId:string; cancelMessageId:string;
  phase:'prepared'|'dispatching'|'queued'|'accepted'|'not-sent'|'unknown'|'completed';
  turnId?:string; code?:string;
  /** Control receipt only: exact Stop confirmed no longer owning a live turn; not native terminal evidence. */
  stopConfirmed?:boolean;
  /** Immutable public creation/queue input plus durable observation; no inferred native IDs. */
  native?:NativeLaneInputRecord;
}
export const prepareLaneDispatch=(messageId:string):LaneDispatch=>({messageId,cancelMessageId:randomUUID(),phase:'prepared'});
/** Revalidate owner admission only before a new native call, not while recording its late ACK. */
export function isNativeAdmissionWrite(previous:LaneDispatch|undefined,next:LaneDispatch):boolean {
  return next.native?.phase==='prepared'||(next.native?.phase==='dispatching'&&previous?.native?.phase==='prepared');
}
export function stopFailureCode(error:unknown):string {
  const code=(error as {code?:string})?.code;
  return ['ADMISSION_OUTCOME_UNKNOWN','QUEUE_ITEM_REMOVED','GROUP_STOP_REQUIRES_NATIVE','GROUP_LANE_MISMATCH'].includes(code??'')?code!:'STOP_NOT_CONFIRMED';
}
export interface GroupFirstInput {
  prompt:string; messageId:string; signal:AbortSignal;
  recordDispatch:(receipt:LaneDispatch)=>Promise<void>;
}
export interface GroupDriver {
  ensure(lane: GroupLane, firstInput?:GroupFirstInput): Promise<{ workspaceId?: string }>;
  reply(lane: GroupLane, input: { prompt: string; messageId: string; signal: AbortSignal; permission: (waiting: boolean) => void;queued?:(waiting:boolean)=>Promise<void>;timeoutMs?:number;requireIdleAdmission?:boolean;admitted?:(turnId:string)=>Promise<void>;recordDispatch?:(receipt:LaneDispatch)=>Promise<void> }): Promise<string>;
  stop(lane: GroupLane, recordDispatch?:(receipt:LaneDispatch)=>Promise<void>): Promise<void>;
  archive(lane: GroupLane): Promise<void>;
  configure?(lane: GroupLane, config: Record<string, unknown>): Promise<void>;
}
/** Background lanes are user-accessible: all dispatch and cancellation is turn-bound. */
export class NativeGroupDriver implements GroupDriver {
  constructor(private readonly paseo: Paseo) {}
  protected creationOptions(lane: GroupLane): Omit<NativeCreationOptions, 'agentId' | 'prompt' | 'clientMessageId' | 'requireInitialPromptReservation'> {
    return { idempotencyKey: lane.operationId, config: nativeConfigOnly(lane.config), cwd: lane.cwd, title: lane.title, background: true,
      labels: { 'cindy-companion.groupId': lane.groupId, 'cindy-companion.botId': lane.botId, 'cindy-companion.roundId': lane.roundId,
        ...(lane.threadRootId ? { 'cindy-companion.threadRootId': lane.threadRootId } : {}) } };
  }
  protected async verifyLane(lane: GroupLane) {
    const agent = this.paseo.agents.ref(lane.agentId);
    if (!await agent.refresh()) return null;
    if (agent.archivedAt || agent.cwd !== lane.cwd || (lane.workspaceId && agent.workspaceId !== lane.workspaceId))
      throwIpcError('GROUP_LANE_MISMATCH', 'The native conversation no longer matches its binding');
    return agent;
  }
  private executor(lane: GroupLane, record: NativeLaneInputRecord, persist?: (receipt: LaneDispatch) => Promise<void>) {
    if (!persist) throwIpcError('PERSISTENCE_REQUIRED', 'Native input requires its owner persistence callback');
    return new NativeLaneInput(this.paseo as unknown as NativeLanePublicApi, record, async native => {
      const previous = lane.dispatch;
      if (!previous || previous.messageId !== native.intent.messageId) throwIpcError('GROUP_LANE_MISMATCH', 'The native input binding changed');
      const phase: LaneDispatch['phase'] = native.phase === 'started' ? 'accepted'
        : ['completed', 'failed', 'cancelled'].includes(native.phase) ? 'completed'
        : native.phase as LaneDispatch['phase'];
      const next: LaneDispatch = { ...previous, phase, native, turnId: native.turnId, code: native.code };
      await persist(structuredClone(next)); lane.dispatch = next;
      if (native.creationComplete) lane.phase = 'ready';
      if (native.workspaceId) lane.workspaceId = native.workspaceId;
    });
  }
  private async inputExecutor(lane: GroupLane, input: GroupFirstInput, admission: 'initial' | 'queue') {
    let receipt = lane.dispatch;
    if (receipt && receipt.messageId !== input.messageId && !['prepared', 'not-sent', 'completed'].includes(receipt.phase))
      throwIpcError('ADMISSION_OUTCOME_UNKNOWN', 'The previous input must be reconciled before another one is admitted');
    if (!receipt || receipt.messageId !== input.messageId) receipt = prepareLaneDispatch(input.messageId);
    if(receipt.stopConfirmed)throwIpcError('GROUP_STOPPED','This input was already stopped; a new user action needs its own input identity');
    if (receipt.native) {
      if (receipt.native.intent.input.text !== input.prompt || receipt.native.intent.agentId !== lane.agentId)
        throwIpcError('NATIVE_INPUT_INTENT_CHANGED', 'The persisted input is immutable');
    } else {
      if (!['prepared', 'not-sent'].includes(receipt.phase))
        throwIpcError('ADMISSION_OUTCOME_UNKNOWN', 'This legacy input has no native receipt mapping; do not resend it');
      receipt = { ...receipt, native: prepareNativeLaneInput({ agentId: lane.agentId, messageId: input.messageId,
        input: { text: input.prompt }, admission, ...(admission === 'initial' ? { creation: this.creationOptions(lane) } : {}) }) };
      await input.recordDispatch(structuredClone(receipt)); lane.dispatch = receipt;
    }
    return this.executor(lane, receipt.native!, input.recordDispatch);
  }
  private outcome(record: NativeLaneInputRecord): void {
    if (record.phase === 'not-sent') throwIpcError(record.code ?? 'NATIVE_INPUT_NOT_SENT', 'The native input was not sent');
    if (record.phase === 'unknown' || record.phase === 'dispatching')
      throw Object.assign(new Error('Native input outcome is not confirmed; read its receipt without resending'), { code: 'ADMISSION_OUTCOME_UNKNOWN', nativeCode: record.code, dispatchOutcome: 'unknown' });
  }
  async ensure(lane: GroupLane, firstInput?: GroupFirstInput) {
    let agent = await this.verifyLane(lane);
    if (lane.phase !== 'ready' && firstInput) {
      if (lane.nativeInputVersion !== 1)
        throwIpcError('ADMISSION_OUTCOME_UNKNOWN', 'Legacy creation has no immutable first input; reconcile it before starting work');
      assertNativeSkillsSupport(this.paseo, lane.config);
      if (firstInput.signal.aborted) throwIpcError('GROUP_STOPPED', 'Group stopped');
      const execution = await this.inputExecutor(lane, firstInput, 'initial');
      if (firstInput.signal.aborted) { await execution.cancel(lane.dispatch!.cancelMessageId); throwIpcError('GROUP_STOPPED', 'Group stopped'); }
      const state = await execution.admit(firstInput.signal); this.outcome(state);
      agent = await this.verifyLane(lane);
    }
    if (!agent) throwIpcError(lane.phase === 'ready' ? 'GROUP_LANE_MISSING' : 'ADMISSION_OUTCOME_UNKNOWN', 'No confirmed native conversation is available');
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
  async stop(lane: GroupLane, persist?: (receipt: LaneDispatch) => Promise<void>) {
    let receipt=lane.dispatch;
    if(receipt?.stopConfirmed)return;
    const confirmed=async()=>{if(receipt&&persist){const next:LaneDispatch={...receipt,phase:'completed',stopConfirmed:true};await persist(structuredClone(next));lane.dispatch=next;}};
    if (receipt?.native) {
      if (['completed','failed','cancelled','not-sent'].includes(receipt.native.phase)) return;
      const execution = this.executor(lane, receipt.native, persist);
      let state = await execution.reconcile();
      if (!['completed','failed','cancelled','not-sent','prepared'].includes(state.phase) && !state.turnId && state.intent.admission === 'queue' && !await this.verifyLane(lane))
        throwIpcError('STOP_NOT_CONFIRMED','The native queue is unavailable; do not assume its input was removed');
      if (!['completed','failed','cancelled','not-sent'].includes(state.phase) && !state.turnId)
        state = await execution.cancel(receipt.cancelMessageId);
      if (['completed','failed','cancelled','not-sent'].includes(state.phase)) return;
      if (!state.turnId && state.phase === 'unknown' && state.cancellation?.code === 'QUEUE_ITEM_REMOVED')
        throwIpcError('QUEUE_ITEM_REMOVED', 'The queue item was removed, but whether it already executed is not confirmed; read its receipt without resending');
      if (!state.turnId) throwIpcError('ADMISSION_OUTCOME_UNKNOWN', 'The owned input or withdrawal is not confirmed; read its receipt without resending');
      if (!await this.verifyLane(lane)) throwIpcError('STOP_NOT_CONFIRMED','The owned native session is unavailable');
      receipt=lane.dispatch;
    }
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
        if(result.status==='cancelled'||result.status==='changed'){await confirmed();return;}
      }catch(error){if((error as {code?:string}).code!=='unsupported_capability')throw error;}
    }
    if (receipt?.native || agent.activeTurn || agent.status === 'running' || agent.status === 'initializing' || agent.pendingPermissions?.length)
      throwIpcError('GROUP_STOP_REQUIRES_NATIVE','This host cannot stop only the owned turn; stop it in the native session, then retry Stop');
    await confirmed();
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
    const agent = await this.verifyLane(lane);
    if (!agent) throwIpcError('GROUP_LANE_MISSING', 'The native conversation is missing');
    if (!input.recordDispatch) throwIpcError('PERSISTENCE_REQUIRED', 'Native input requires its owner persistence callback');
    const execution = await this.inputExecutor(lane, { ...input, recordDispatch: input.recordDispatch }, 'queue');
    let wake: (() => void) | undefined; const notify = () => wake?.();
    const unsubscribe = agent.subscribe(notify), timeline = agent.timeline.subscribe(notify);
    const abort = () => notify(); input.signal.addEventListener('abort', abort, { once: true });
    let remaining = input.timeoutMs ?? 2 * 60 * 60 * 1000, lastTime = Date.now(), waitingPermission = false;
    let queued: boolean | undefined, admitted: string | undefined;
    try {
      await timeline.ready;
      if (input.signal.aborted) throwIpcError('GROUP_STOPPED', 'Group stopped');
      let state = await execution.admit(input.signal);
      for (;;) {
        if (input.signal.aborted) throwIpcError('GROUP_STOPPED', 'Group stopped');
        this.outcome(state);
        const isQueued = state.phase === 'queued';
        if (queued !== isQueued) { queued = isQueued; await input.queued?.(isQueued); }
        if (state.turnId && admitted !== state.turnId) { admitted = state.turnId; await input.admitted?.(state.turnId); }
        if (state.phase === 'completed') return await execution.readReply();
        if (state.phase === 'failed') throwIpcError('RUNTIME_ERROR', 'The owned native turn failed');
        if (state.phase === 'cancelled') throwIpcError('GROUP_STOPPED', 'The owned native input was cancelled');
        await agent.refresh();
        const activeId = (agent.activeTurn as { turnId?: string } | null)?.turnId;
        const permission = Boolean(state.turnId && activeId === state.turnId && agent.pendingPermissions?.length);
        const now = Date.now(); if (!waitingPermission) remaining -= now - lastTime; lastTime = now;
        if (permission !== waitingPermission) { waitingPermission = permission; input.permission(permission); }
        if (remaining <= 0) throwIpcError('RUNTIME_TIMEOUT', 'The owned native turn has not settled');
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, Math.min(1000, Math.max(1, remaining)));
          function done() { clearTimeout(timer); if (wake === done) wake = undefined; resolve(); }
          wake = done; if (input.signal.aborted) done();
        });
        state = await execution.reconcile();
      }
    } finally { wake?.(); unsubscribe(); timeline(); input.signal.removeEventListener('abort', abort); }
  }
}
