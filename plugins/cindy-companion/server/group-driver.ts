import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Paseo } from './runtime';
import { throwIpcError } from './errors';
import { publicPaseoCli } from './host-cli';

export interface GroupLane {
  agentId: string; operationId: string; groupId: string; roundId: string; botId: string;
  cwd: string; title: string; config: Record<string, unknown>; phase: 'creating' | 'ready' | 'unknown';
  workspaceId?: string;
  scope?: 'main' | 'talk'; retired?: boolean;
}
export interface GroupDriver {
  ensure(lane: GroupLane): Promise<{ workspaceId?: string }>;
  reply(lane: GroupLane, input: { prompt: string; messageId: string; signal: AbortSignal; permission: (waiting: boolean) => void }): Promise<string>;
  stop(lane: GroupLane): Promise<void>;
  archive(lane: GroupLane): Promise<void>;
  configure?(lane: GroupLane, config: Record<string, unknown>): Promise<void>;
}
/** Uses only public Paseo APIs and the shipped public CLI on SDKs without interrupt(). */
export class NativeGroupDriver implements GroupDriver {
  constructor(private readonly paseo: Paseo) {}
  async ensure(lane: GroupLane) {
    let agent = this.paseo.agents.ref(lane.agentId);
    if (!await agent.refresh()) {
      if (lane.phase === 'ready') throwIpcError('GROUP_LANE_MISSING', 'The group conversation is missing');
      agent = await this.paseo.agents.create({ agentId: lane.agentId, idempotencyKey: lane.operationId,
        config: lane.config as never, cwd: lane.cwd, title: lane.title, background: true,
        labels: { 'cindy-companion.groupId': lane.groupId, 'cindy-companion.botId': lane.botId, 'cindy-companion.roundId': lane.roundId } });
      await agent.refresh();
    }
    if (agent.archivedAt || agent.cwd !== lane.cwd) throwIpcError('GROUP_LANE_MISMATCH', 'The group conversation no longer matches its binding');
    return { workspaceId: agent.workspaceId ?? undefined };
  }
  async configure(lane: GroupLane, config: Record<string, unknown>) {
    if (JSON.stringify(lane.config) === JSON.stringify(config)) return;
    const agent = this.paseo.agents.ref(lane.agentId) as ReturnType<Paseo['agents']['ref']> & {
      setModel?: (model: string | null) => Promise<void>; setThinkingOption?: (effort: string | null) => Promise<unknown>;
      setFeature?: (id: string, value: unknown) => Promise<void>;
      updateInstructions?: (config: { systemPrompt: string; mcpServers?: Record<string, unknown> }) => Promise<unknown>;
    };
    await agent.refresh();
    if (agent.activeTurn || agent.status === 'running' || agent.pendingPermissions?.length) throwIpcError('GROUP_LANE_BUSY', 'The group conversation is still active');
    const oldProvider = String(lane.config.provider).split('/')[0]; const selection = String(config.provider);
    if (oldProvider !== selection.split('/')[0]) throwIpcError('HOST_UPGRADE_REQUIRED', 'This host cannot change the provider of an existing group conversation');
    const modelChanged = lane.config.provider !== config.provider;
    const effortChanged = lane.config.thinkingOptionId !== config.thinkingOptionId;
    const featuresChanged = JSON.stringify(lane.config.featureValues ?? {}) !== JSON.stringify(config.featureValues ?? {});
    const instructionsChanged = JSON.stringify([lane.config.systemPrompt, lane.config.mcpServers]) !== JSON.stringify([config.systemPrompt, config.mcpServers]);
    if ((modelChanged && !agent.setModel) || (effortChanged && !agent.setThinkingOption) || (featuresChanged && !agent.setFeature) || (instructionsChanged && !agent.updateInstructions))
      throwIpcError('HOST_UPGRADE_REQUIRED', 'Saved companion settings require a newer host to refresh this existing group conversation');
    if (modelChanged) await agent.setModel!(selection.slice(selection.indexOf('/') + 1));
    if (effortChanged) await agent.setThinkingOption!(typeof config.thinkingOptionId === 'string' ? config.thinkingOptionId : null);
    if (featuresChanged) {
      const old = (lane.config.featureValues ?? {}) as Record<string, unknown>; const next = (config.featureValues ?? {}) as Record<string, unknown>;
      for (const id of new Set([...Object.keys(old), ...Object.keys(next)])) await agent.setFeature!(id, next[id] ?? (id === 'fast_mode' ? false : 'default'));
    }
    if (instructionsChanged) await agent.updateInstructions!({ systemPrompt: String(config.systemPrompt ?? ''), mcpServers: (config.mcpServers ?? {}) as Record<string, unknown> });
  }
  async stop(lane: GroupLane) {
    const agent = this.paseo.agents.ref(lane.agentId);
    if (!await agent.refresh()) {
      if (lane.phase !== 'ready') throwIpcError('STOP_NOT_CONFIRMED', 'Agent creation outcome is still unknown');
      return;
    }
    if (agent.cwd !== lane.cwd) throwIpcError('GROUP_LANE_MISMATCH', 'Refusing to stop a different conversation');
    if (!agent.activeTurn && agent.status !== 'running' && agent.status !== 'initializing') return;
    const newer = agent as typeof agent & { interrupt?: () => Promise<unknown> };
    if (newer.interrupt) await newer.interrupt();
    else {
      const cli = publicPaseoCli();
      const result = await promisify(execFile)(cli.file, ['--home', cli.home, 'agent', 'stop', lane.agentId, '--json'], { timeout: 30000, maxBuffer: 1024 * 1024 });
      const data = JSON.parse(result.stdout) as { stoppedCount?: number; agentIds?: string[] };
      if (!Number.isSafeInteger(data.stoppedCount) || !Array.isArray(data.agentIds) || data.agentIds.some(id => id !== lane.agentId))
        throwIpcError('STOP_NOT_CONFIRMED', 'The host did not confirm this conversation stop');
    }
    await agent.refresh();
    if (agent.activeTurn || agent.status === 'running' || agent.status === 'initializing') throwIpcError('STOP_NOT_CONFIRMED', 'The conversation has not stopped yet');
  }
  async archive(lane: GroupLane) {
    await this.stop(lane);
    const agent = this.paseo.agents.ref(lane.agentId);
    if (!await agent.refresh()) return;
    if (agent.cwd !== lane.cwd) throwIpcError('GROUP_LANE_MISMATCH', 'Refusing to archive a different conversation');
    if (!agent.archivedAt) await agent.archive();
  }
  async reply(lane: GroupLane, input: { prompt: string; messageId: string; signal: AbortSignal; permission: (waiting: boolean) => void }): Promise<string> {
    const agent = this.paseo.agents.ref(lane.agentId);
    await agent.refresh();
    if (agent.activeTurn || agent.status === 'running' || agent.status === 'initializing') throwIpcError('GROUP_LANE_BUSY', 'This group conversation is already running');
    if (input.signal.aborted) throwIpcError('GROUP_STOPPED', 'Group stopped');
    let accepted = false; let settled = false; let waitingPermission = false;
    let dispatching = false; let started = false; let completed = false; let turnId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined; let remaining = 2 * 60 * 60 * 1000; let runningSince = Date.now();
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
      // This dedicated lane has no unrelated input. The explicit idle check precedes sending.
      dispatching = true;
      await agent.send(input.prompt, { messageId: input.messageId, activeTurnBehavior: 'steer' });
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
    }
  }
}
