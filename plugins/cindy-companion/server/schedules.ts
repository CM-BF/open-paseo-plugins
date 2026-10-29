import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { PluginBeforeRequests } from '@getpaseo/plugin/server';
import type { BotModelRoute } from '../shared/vendor/botModelChain';
import { CompanionStore } from './store';
import { CompanionRuntime, COMPANION_CONTEXT_GUIDANCE, resolveFastFeature, routeProvider, selectedRoute, type Paseo } from './runtime';
import { parseRoutineInput, type Routine, type RoutineInput } from './vendor/scheduler/routines';
import { CompanionError, record, string, throwIpcError } from './errors';
import { ScheduleSdk, scheduleCadence } from './schedule-sdk';
import { verifyPackagedSkills } from './presets/skills';
import { publicPaseoCli } from './host-cli';

export interface NativeSchedule { id: string; name?: string | null; status?: string; runs?: Array<Record<string, unknown>>; [key: string]: unknown }
export interface ScheduleDriver {
  list(): Promise<NativeSchedule[]>;
  inspect(id: string): Promise<NativeSchedule>;
  create(input: { name: string; prompt: string; provider: string; cwd: string; cadence: { cron?: string; timezone?: string; everyMs?: number }; thinking?: string; mode?: string; config?: Record<string, unknown> }): Promise<NativeSchedule>;
  update(id: string, input: { prompt: string; cadence: { cron?: string; timezone?: string; everyMs?: number } }): Promise<NativeSchedule>;
  pause(id: string): Promise<unknown>; resume(id: string): Promise<unknown>; remove(id: string): Promise<unknown>; run(id: string): Promise<unknown>;
}
type Execute = (file: string, args: string[]) => Promise<{ stdout: string }>;
/** Public CLI only. Tests inject Execute; no shell interpolation or ambient host selector. */
export class ScheduleCli implements ScheduleDriver {
  private readonly execute: Execute;
  private readonly file: string;
  private readonly home: string;
  constructor(options: { execute?: Execute; file?: string; home?: string } = {}) {
    this.execute = options.execute ?? ((file, args) => promisify(execFile)(file, args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }));
    const cli = publicPaseoCli(); this.file = options.file ?? cli.file; this.home = options.home ?? cli.home;
  }
  private async call(action: string, args: string[] = []): Promise<unknown> {
    const { stdout } = await this.execute(this.file, ['--home', this.home, 'schedule', action, ...args, '--json']);
    const result: unknown = JSON.parse(stdout);
    if (result && typeof result === 'object' && !Array.isArray(result) && (result as Record<string, unknown>).error) throwIpcError('SCHEDULE_FAILED', String((result as Record<string, unknown>).error));
    return result;
  }
  private cadence(input: { cron?: string; timezone?: string; everyMs?: number }) {
    return input.cron ? ['--cron', input.cron, '--timezone', input.timezone ?? 'UTC'] : ['--every', `${input.everyMs! / 1000}s`];
  }
  async list() { const result = await this.call('ls'); if (!Array.isArray(result)) throwIpcError('INVALID_HOST_RESPONSE', 'Invalid schedule list'); return result as NativeSchedule[]; }
  async inspect(id: string) { return record(await this.call('inspect', [id])) as NativeSchedule; }
  async create(input: Parameters<ScheduleDriver['create']>[0]) {
    return record(await this.call('create', [input.prompt, '--name', input.name, '--provider', input.provider, '--cwd', input.cwd, ...this.cadence(input.cadence), ...(input.thinking ? ['--thinking', input.thinking] : []), ...(input.mode ? ['--mode', input.mode] : [])])) as NativeSchedule;
  }
  async update(id: string, input: Parameters<ScheduleDriver['update']>[1]) { return record(await this.call('update', [id, '--prompt', input.prompt, ...this.cadence(input.cadence)])) as NativeSchedule; }
  pause(id: string) { return this.call('pause', [id]); }
  resume(id: string) { return this.call('resume', [id]); }
  remove(id: string) { return this.call('delete', [id]); }
  run(id: string) { return this.call('run-once', [id]); }
}
export interface SavedRoutine {
  botId: string; scheduleId?: string; operationName: string; phase: 'creating' | 'ready' | 'unknown'; data: Routine;
  execution?: { cwd: string; route: BotModelRoute; mode: string; profileVersion: number; providerOptions?: Record<string, unknown> };
  manualRuns?: ManualRun[];
  nativePrompt?: string;
}
interface ManualRun {
  operationId: string; requestedAt: number; baselineRunIds: string[];
  status: 'queued' | 'running' | 'unknown' | 'success' | 'failed';
  nativeRunId?: string; dispatchEndedAt?: number; launchError?: string;
}
function pending(run: ManualRun) { return ['queued', 'running', 'unknown'].includes(run.status); }
function routinePrompt(prompt: string): string {
  return `Before doing this routine, read the companion context and use its current identity and preferences. ${COMPANION_CONTEXT_GUIDANCE}\n\nStanding instruction:\n${prompt}`;
}
// Existing uncertain creation intents must still match the exact prompt they originally sent.
function legacyRoutinePrompt(prompt: string): string {
  return `Before doing this routine, call cindy_memory.companion_context and use its current identity and preferences. If that tool is unavailable, stop and report that the companion plugin must be enabled.\n\nStanding instruction:\n${prompt}`;
}
export class CompanionRoutines {
  private readonly store: CompanionStore; private readonly runtime: CompanionRuntime; private readonly driver: ScheduleDriver;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly launches = new Map<string, Promise<void>>();
  private closing: Promise<void> | null = null;
  constructor(store: CompanionStore, runtime: CompanionRuntime, driver: ScheduleDriver) { this.store = store; this.runtime = runtime; this.driver = driver; }
  private driverFor(paseo?: Paseo) { return ScheduleSdk.from(paseo) ?? this.driver; }
  private serial<T>(run: () => Promise<T>) { const job = this.queue.catch(() => {}).then(run); this.queue = job; return job; }
  close(): Promise<void> {
    this.closing ??= (async () => { await this.queue.catch(() => {}); await Promise.allSettled([...this.launches.values()]); await this.queue.catch(() => {}); })();
    return this.closing;
  }
  private async own(botId: string, id: string) {
    const entry = (await this.store.snapshot()).routines[id];
    if (!entry || entry.botId !== botId) throwIpcError('NOT_FOUND', 'Routine not found'); return entry;
  }
  private async recover(saved: SavedRoutine, driver: ScheduleDriver, removing = false): Promise<SavedRoutine> {
    if (saved.phase === 'ready') return saved;
    if (!saved.execution) throwIpcError('ROUTINE_UPGRADE_REQUIRED', 'This legacy creation intent cannot be verified automatically');
    const candidates = (await driver.list()).filter(item => item.name === saved.operationName);
    if (candidates.length !== 1 || (saved.scheduleId && candidates[0]!.id !== saved.scheduleId))
      throwIpcError('SCHEDULE_OUTCOME_UNKNOWN', candidates.length > 1 ? 'More than one native schedule matches this creation intent' : 'The native creation result is not yet uniquely confirmed');
    const actual = await driver.inspect(candidates[0]!.id);
    const target = actual.target as { type?: string; config?: Record<string, unknown> } | undefined;
    const cadence = actual.cadence as { type?: string; expression?: string; timezone?: string } | undefined;
    const expectedCadence = scheduleCadence(this.cadence(saved.data));
    const execution = saved.execution;
    if (actual.id !== candidates[0]!.id || actual.name !== saved.operationName || target?.type !== 'new-agent' ||
      target.config?.cwd !== execution.cwd || target.config?.provider !== routeProvider(execution.route) || target.config?.model !== execution.route.model ||
      target.config?.modeId !== execution.mode || actual.prompt !== (saved.nativePrompt ?? legacyRoutinePrompt(saved.data.prompt)) ||
      cadence?.type !== 'cron' || cadence.expression !== expectedCadence.expression || (cadence.timezone ?? 'UTC') !== expectedCadence.timezone)
      throwIpcError('ROUTINE_BINDING_MISMATCH', 'The native schedule differs from its recorded creation intent');
    await this.store.safePath(execution.cwd);
    const wantEnabled = !removing && saved.data.enabled;
    if (!['active', 'paused'].includes(String(actual.status))) throwIpcError('SCHEDULE_STATE_CONFLICT', 'The native schedule is no longer active or paused');
    if (wantEnabled && actual.status !== 'active') await driver.resume(actual.id);
    if (!wantEnabled && actual.status !== 'paused') await driver.pause(actual.id);
    const recovered = { ...saved, scheduleId: actual.id, phase: 'ready' as const };
    await this.store.transaction(state => { state.routines[saved.data.id] = recovered; });
    return recovered;
  }
  reconcile(botId: string, id: string, paseo?: Paseo) {
    return this.serial(async () => {
      const driver = this.driverFor(paseo); let saved = await this.recover(await this.own(botId, id), driver);
      if (saved.scheduleId) saved = await this.refreshManual(saved, await driver.inspect(saved.scheduleId));
      return { ...saved.data, backendState: saved.phase, ...this.manualActivity(saved) };
    });
  }
  private manualActivity(saved: SavedRoutine) {
    const active = saved.manualRuns?.find(pending);
    return { manualPending: !!active, ...(active ? { activity: active.status === 'running' ? 'running' : 'queued',
      ...(active.launchError ? { error: active.launchError } : {}) } : {}) };
  }
  /** Correlate only within the owned schedule, using its manual-run marker and pre-dispatch baseline. */
  private async refreshManual(saved: SavedRoutine, native: NativeSchedule): Promise<SavedRoutine> {
    if (native.id !== saved.scheduleId) throwIpcError('ROUTINE_BINDING_MISMATCH', 'The host returned another schedule');
    const manualRuns = (saved.manualRuns ?? []).map(attempt => {
      if (!pending(attempt)) return attempt;
      const candidates = attempt.nativeRunId ? (native.runs ?? []).filter(run => run.id === attempt.nativeRunId) : (native.runs ?? []).filter(run => {
        const started = Date.parse(String(run.startedAt));
        return typeof run.id === 'string' && !attempt.baselineRunIds.includes(run.id) && run.startedAt === run.scheduledFor &&
          started >= attempt.requestedAt && started <= (attempt.dispatchEndedAt ?? Date.now());
      });
      if (candidates.length !== 1) return this.launches.has(`${saved.data.id}:${attempt.operationId}`) ? attempt : { ...attempt, status: 'unknown' as const,
        launchError: attempt.launchError ?? 'The manual run outcome is not uniquely confirmed. Refresh history to reconcile; it will not be started again.' };
      const run = candidates[0]!;
      const status = run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'failed' : run.status === 'running' ? 'running' : 'unknown';
      return { ...attempt, nativeRunId: String(run.id), status } as ManualRun;
    });
    if (JSON.stringify(manualRuns) === JSON.stringify(saved.manualRuns ?? [])) return saved;
    await this.store.transaction(state => { state.routines[saved.data.id]!.manualRuns = manualRuns; });
    return { ...saved, manualRuns };
  }
  private cadence(input: RoutineInput) {
    if (input.triggers.length !== 1) throwIpcError('UNSUPPORTED_TRIGGER', 'This host supports one time trigger per routine');
    const trigger = input.triggers[0]!;
    if (trigger.kind === 'cron') return { cron: trigger.expression, timezone: trigger.timezone };
    if (trigger.kind === 'interval' && trigger.anchorMs === undefined) return { everyMs: trigger.intervalMs };
    throwIpcError('UNSUPPORTED_TRIGGER', 'This host supports cron and unanchored interval triggers');
  }
  private async features(paseo: Paseo, route: BotModelRoute, cwd: string) {
    if (!route.fastMode) return undefined;
    const catalog = await paseo.providers.listFeatures({ provider: `${routeProvider(route)}/${route.model}`, cwd });
    if (catalog.error) throwIpcError('PROVIDER_FEATURES_UNAVAILABLE', catalog.error);
    const selected = resolveFastFeature(catalog.features ?? [], route.fastMode);
    return { [selected.id]: selected.value };
  }
  /** Only exact directories recorded before native schedule creation belong to this adapter. */
  async beforeCreate(request: PluginBeforeRequests['agent.create'], paseo: Paseo): Promise<PluginBeforeRequests['agent.create']> {
    const state=await this.store.snapshot();const saved = Object.values(state.routines).find(routine => routine.execution?.cwd === request.config.cwd);
    if (!saved?.execution) return request;
    if(state.profileDeletions?.[saved.botId])throwIpcError('COMPANION_DELETING','The companion is being deleted');
    if (saved.phase !== 'ready') throwIpcError('SCHEDULE_OUTCOME_UNKNOWN', 'The owning routine is not confirmed');
    const profile = await this.store.get(saved.botId); const execution = saved.execution;
    const expectedCwd = join(profile.homeDir, 'routines', saved.data.id, 'workspace');
    if (execution.cwd !== expectedCwd || request.config.provider !== routeProvider(execution.route) || request.config.model !== execution.route.model)
      throwIpcError('ROUTINE_BINDING_MISMATCH', 'The scheduled agent does not match its immutable companion binding');
    await this.store.safePath(execution.cwd);
    if (!profile.enabled || profile.status !== 'active') throwIpcError('COMPANION_PAUSED', 'This companion is not active');
    const packaged = await verifyPackagedSkills(this.store, profile);
    if (profile.skills.some(skill => !packaged.supportedSkillIds.includes(skill)) || profile.capabilities.mcpServers.length || profile.capabilities.toolsets.length)
      throwIpcError('CAPABILITY_NOT_APPLIED', 'This routine cannot apply selected skills, external MCP servers or toolsets');
    const agentId=(request as typeof request&{agentId?:unknown}).agentId;
    let scope:import('../shared/session-scope').SessionScope|undefined;
    if(agentId!==undefined){
      if(typeof agentId!=='string'||! /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(agentId))throwIpcError('ROUTINE_BINDING_MISMATCH','Invalid native routine identity');
      scope={agentId,role:'routine',routineId:saved.data.id};
      await this.store.transaction(state=>{const previous=state.routineAgents?.[agentId];if(previous&&(previous.botId!==saved.botId||previous.routineId!==saved.data.id||previous.cwd!==execution.cwd))throwIpcError('ROUTINE_BINDING_MISMATCH','The native identity belongs to another routine');(state.routineAgents??={})[agentId]={botId:saved.botId,routineId:saved.data.id,cwd:execution.cwd,sessionScope:scope!};});
    }
    const instructions = await this.runtime.instructionsFor(saved.botId,scope);
    const featureValues = await this.features(paseo, execution.route, execution.cwd);
    return { ...request, config: { ...request.config, systemPrompt: instructions.systemPrompt,
      mcpServers: { ...request.config.mcpServers, ...instructions.mcpServers } as PluginBeforeRequests['agent.create']['config']['mcpServers'],
      modeId: execution.mode, providerOptions: { ...request.config.providerOptions, ...execution.providerOptions },
      ...(featureValues ? { featureValues: { ...request.config.featureValues, ...featureValues } } : {}) } };
  }
  async list(botId: string, paseo?: Paseo) {
    return this.serial(async () => {
      const state = await this.store.snapshot();
      const local = Object.values(state.routines).filter(r => r.botId === botId);
      const drafts = Object.values(state.presetRoutineDrafts ?? {}).filter(draft => draft.botId === botId && !state.routines[draft.data.id])
        .map(draft => ({ ...draft.data, enabled: false, backendState: 'draft', manualPending: false }));
      if (!local.length) return drafts;
      const driver = this.driverFor(paseo); const errors = new Map<string, string>();
      for (let i = 0; i < local.length; i++) if (local[i]!.phase !== 'ready') {
        try { local[i] = await this.recover(local[i]!, driver); }
        catch (error) { errors.set(local[i]!.data.id, error instanceof Error ? error.message : String(error)); }
      }
      const native = await driver.list();
      for (let i = 0; i < local.length; i++) if (local[i]!.manualRuns?.some(pending) && local[i]!.scheduleId) {
        try { local[i] = await this.refreshManual(local[i]!, await driver.inspect(local[i]!.scheduleId!)); }
        catch (error) { errors.set(local[i]!.data.id, error instanceof Error ? error.message : String(error)); }
      }
      return [...drafts, ...local.map(r => { const actual = native.find(s => s.id === r.scheduleId);
        const error = errors.get(r.data.id) ?? (actual ? undefined : 'Native schedule is missing');
        return { ...r.data, enabled: actual ? actual.status === 'active' : false,
          ...this.manualActivity(r), ...(error ? { error } : {}), backendState: r.phase }; })];
    });
  }
  save(paseo: Paseo, botId: string, raw: unknown, existingId?: string) {
    return this.serial(async () => {
      let input: RoutineInput;
      try { input = parseRoutineInput(raw); } catch (error) { throwIpcError('INVALID_PARAMS', error instanceof Error ? error.message : 'Invalid routine'); }
      const existingState = await this.store.snapshot();
      const draft = existingId && !Object.hasOwn(existingState.routines, existingId) ? existingState.presetRoutineDrafts?.[existingId] : undefined;
      if (draft && draft.botId !== botId) throwIpcError('NOT_FOUND', 'Routine not found');
      if (draft && !input.enabled) {
        const data: Routine = { ...input, id: existingId!, botId, revision: draft.data.revision + 1, createdAt: draft.data.createdAt, updatedAt: Date.now() };
        await this.store.transaction(state => { state.presetRoutineDrafts![existingId!] = { botId, data }; }); return data;
      }
      if (input.sessionMode !== 'fresh') throwIpcError('UNSUPPORTED_SESSION_MODE', 'This host currently supports fresh-session routines. Choose a new session for each run.');
      if (input.preRunHook || input.silentWhenIdle || input.modelOverride?.agentDeviceId) throwIpcError('UNSUPPORTED_ROUTINE_OPTION', 'This host cannot execute event checks, silent idle hooks or remote model routes');
      const cadence = this.cadence(input); scheduleCadence(cadence);
      const profile = await this.store.get(botId); const driver = this.driverFor(paseo);
      const packaged = await verifyPackagedSkills(this.store, profile);
      if (profile.skills.some(skill => !packaged.supportedSkillIds.includes(skill)) || profile.capabilities.mcpServers.length || profile.capabilities.toolsets.length)
        throwIpcError('CAPABILITY_NOT_APPLIED', 'This routine cannot apply selected skills, external MCP servers or toolsets');
      const route = input.modelOverride ? { harness: input.modelOverride.agentKind === 'claude-code' ? 'claude' as const : input.modelOverride.agentKind,
        model: input.modelOverride.model, providerId: input.modelOverride.providerId ?? null, effort: input.modelOverride.effort ?? '', fastMode: input.modelOverride.fastMode ?? false } : selectedRoute(profile) ?? await this.runtime.defaultRoute(paseo, botId);
      if (route.agentDeviceId) throwIpcError('UNSUPPORTED_ROUTINE_OPTION', 'Remote routine model routes are unavailable');
      // The fallback CLI cannot store MCP config. The owned creation hook supplies it before launch.
      const prompt = routinePrompt(input.prompt);
      const id = existingId ?? randomUUID(); let saved: SavedRoutine | undefined;
      if (existingId && !draft) saved = await this.recover(await this.own(botId, existingId), driver);
      const now = Date.now();
      const data: Routine = { ...input, id, botId, revision: (saved?.data.revision ?? 0) + 1, createdAt: saved?.data.createdAt ?? now, updatedAt: now };
      if (!saved) {
        const provider = routeProvider(route);
        const mode = provider === 'codex' ? 'auto' : provider === 'claude' ? 'default' : null;
        const catalog = await this.runtime.catalog(paseo, botId);
        if (!mode || !catalog.entries.find(entry => entry.provider === provider)?.modes?.some(candidate => candidate.id === mode))
          throwIpcError('PERMISSION_MODE_UNAVAILABLE', 'The provider does not advertise a supported ask-before-approval mode for routines');
        if (profile.capabilities.permissions !== 'ask') throwIpcError('PERMISSION_MODE_UNAVAILABLE', 'Only the companion ask-permission policy is supported');
        const cwd = join(profile.homeDir, 'routines', id, 'workspace');
        await this.store.safePath(cwd); await mkdir(cwd, { recursive: true, mode: 0o700 }); await this.store.safePath(cwd);
        const providerOptions = provider === 'codex' ? { approval_policy: 'on-request', sandbox_mode: 'workspace-write' } : undefined;
        const instructions = await this.runtime.instructionsFor(botId);
        const featureValues = await this.features(paseo, route, cwd);
        saved = { botId, operationName: `cindy:${botId}:${id}`, phase: 'creating', data, nativePrompt: prompt,
          execution: { cwd, route, mode, profileVersion: profile.currentVersion, ...(providerOptions ? { providerOptions } : {}) } };
        await this.store.transaction(state => { state.routines[id] = saved!; });
        try {
          const created = await driver.create({ name: saved.operationName, prompt, provider: `${provider}/${route.model}`, cwd, cadence, thinking: route.effort || undefined, mode,
            config: { ...instructions, ...(providerOptions ? { providerOptions } : {}), ...(featureValues ? { featureValues } : {}) } });
          string(created.id, 'schedule id', 200);
          saved.scheduleId = created.id;
          // Persist the returned ID before the optional pause, so a pause failure is recoverable.
          await this.store.transaction(state => { state.routines[id]!.scheduleId = created.id; });
          if (!input.enabled) await driver.pause(created.id);
          saved.phase = 'ready';
          await this.store.transaction(state => { state.routines[id] = saved!; if (state.presetRoutineDrafts) delete state.presetRoutineDrafts[id]; }); return data;
        } catch (error) {
          await this.store.transaction(state => { state.routines[id]!.phase = 'unknown'; });
          throw new CompanionError('SCHEDULE_OUTCOME_UNKNOWN', `Routine creation needs reconciliation: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!saved.scheduleId || saved.phase !== 'ready') throwIpcError('SCHEDULE_OUTCOME_UNKNOWN', 'Reconcile this routine before editing it');
      if (!saved.execution) throwIpcError('ROUTINE_UPGRADE_REQUIRED', 'Recreate this legacy routine to attach its companion context and memory tools');
      if (JSON.stringify(input.modelOverride) !== JSON.stringify(saved.data.modelOverride)) throwIpcError('UNSUPPORTED_ROUTINE_OPTION', 'Changing an existing routine model requires an upgraded host');
      await driver.update(saved.scheduleId, { prompt, cadence });
      if (input.enabled !== saved.data.enabled) await (input.enabled ? driver.resume(saved.scheduleId) : driver.pause(saved.scheduleId));
      await this.store.transaction(state => { state.routines[id] = { ...saved!, data, nativePrompt: prompt }; }); return data;
    });
  }
  async history(botId: string, id: string, paseo?: Paseo) {
    return this.serial(async () => {
      const state = await this.store.snapshot(); const draft = !Object.hasOwn(state.routines, id) ? state.presetRoutineDrafts?.[id] : undefined;
      if (draft) { if (draft.botId !== botId) throwIpcError('NOT_FOUND', 'Routine not found'); return []; }
      let saved = await this.own(botId, id); if (!saved.scheduleId) throwIpcError('SCHEDULE_OUTCOME_UNKNOWN', 'The schedule ID is not confirmed');
      const native = await this.driverFor(paseo).inspect(saved.scheduleId); saved = await this.refreshManual(saved, native);
      const actual = (native.runs ?? []).map(run => {
        const attempt = saved.manualRuns?.find(item => item.nativeRunId === run.id);
        return { id: run.id, routineId: id, revision: saved.data.revision, triggerIds: [], events: [],
          status: run.status === 'succeeded' ? 'success' : run.status, createdAt: Date.parse(String(run.startedAt)),
          finishedAt: run.endedAt ? Date.parse(String(run.endedAt)) : undefined, sessionId: run.agentId, resultText: run.output,
          error: run.error, scheduleRunId: run.id, operationId: attempt?.operationId, launchError: attempt?.launchError };
      });
      const unconfirmed = (saved.manualRuns ?? []).filter(run => !run.nativeRunId || !(native.runs ?? []).some(actual => actual.id === run.nativeRunId)).map(run => ({ id: `manual:${run.operationId}`,
        routineId: id, revision: saved.data.revision, triggerIds: [], events: [], status: pending(run) ? 'queued' : run.status,
        createdAt: run.requestedAt, error: run.launchError, manualPending: pending(run), launchState: run.status, operationId: run.operationId }));
      return [...actual, ...unconfirmed].sort((a, b) => b.createdAt - a.createdAt);
    });
  }
  run(botId: string, id: string, paseo?: Paseo, operationId: string = randomUUID()) {
    if (this.closing) return Promise.reject(new CompanionError('PLUGIN_CLOSED', 'Companion routines are closing'));
    return this.serial(async () => {
      const driver = this.driverFor(paseo); let saved = await this.recover(await this.own(botId, id), driver);
      if (!saved.scheduleId) throwIpcError('SCHEDULE_OUTCOME_UNKNOWN', 'The schedule is not ready');
      if (!saved.execution) throwIpcError('ROUTINE_UPGRADE_REQUIRED', 'Recreate this routine to attach companion context and memory');
      const native = await driver.inspect(saved.scheduleId); saved = await this.refreshManual(saved, native);
      const existing = saved.manualRuns?.find(run => run.operationId === operationId) ?? saved.manualRuns?.find(run => pending(run) || this.launches.has(`${saved.data.id}:${run.operationId}`));
      const receipt = (run: ManualRun) => ({ accepted: true, status: run.status, operationId: run.operationId, scheduleId: saved.scheduleId, nativeRunId: run.nativeRunId });
      if (existing) return receipt(existing);
      if (native.runs?.some(run => run.status === 'running')) throwIpcError('ROUTINE_ALREADY_RUNNING', 'This native schedule already has a running task');
      const attempt: ManualRun = { operationId, status: 'queued', requestedAt: Date.now(), baselineRunIds: (native.runs ?? []).map(run => String(run.id)) };
      await this.store.transaction(state => { const entry = state.routines[id]!; entry.manualRuns = [...(entry.manualRuns ?? []).slice(-99), attempt]; });
      // Do not await a full model turn inside Paseo's 30-second plugin RPC. This promise is owned and drained by close().
      const job = Promise.resolve().then(() => driver.run(saved.scheduleId!)).then(
        () => this.finishLaunch(botId, id, attempt.operationId, driver),
        error => this.finishLaunch(botId, id, attempt.operationId, driver, error),
      ).catch(error => { console.error('Companion routine outcome persistence failed', { routineId: id, operationId, message: error instanceof Error ? error.message : String(error) }); });
      this.launches.set(`${id}:${operationId}`, job);
      void job.finally(() => this.launches.delete(`${id}:${operationId}`));
      return receipt(attempt);
    });
  }
  private finishLaunch(botId: string, id: string, operationId: string, driver: ScheduleDriver, error?: unknown): Promise<void> {
    return this.serial(async () => {
      await this.store.transaction(state => {
        const attempt = state.routines[id]?.manualRuns?.find(run => run.operationId === operationId);
        if (!attempt) throwIpcError('NOT_FOUND', 'The accepted routine operation is missing');
        attempt.dispatchEndedAt = Date.now();
        if (error) attempt.launchError = `Launch acknowledgement failed; the task may still be running: ${error instanceof Error ? error.message : String(error)}`;
        if (pending(attempt)) attempt.status = 'unknown';
      });
      const saved = await this.own(botId, id);
      try { await this.refreshManual(saved, await driver.inspect(saved.scheduleId!)); }
      catch (error) {
        await this.store.transaction(state => {
          const attempt = state.routines[id]!.manualRuns!.find(run => run.operationId === operationId)!;
          attempt.launchError = `${attempt.launchError ?? 'The launch result needs reconciliation.'} History lookup failed: ${error instanceof Error ? error.message : String(error)}`;
        });
      }
    });
  }
  remove(botId: string, id: string, paseo?: Paseo) { return this.serial(async () => {
    const state = await this.store.snapshot(); const draft = !Object.hasOwn(state.routines, id) ? state.presetRoutineDrafts?.[id] : undefined;
    if (draft) { if (draft.botId !== botId) throwIpcError('NOT_FOUND', 'Routine not found'); await this.store.transaction(state => { delete state.presetRoutineDrafts![id]; }); return; }
    const driver = this.driverFor(paseo); let saved = await this.recover(await this.own(botId, id), driver, true);
    if (!saved.scheduleId) throwIpcError('SCHEDULE_OUTCOME_UNKNOWN', 'The schedule ID is not confirmed');
    const native = await driver.inspect(saved.scheduleId); saved = await this.refreshManual(saved, native);
    if (native.runs?.some(run => run.status === 'running') || saved.manualRuns?.some(run => pending(run) || this.launches.has(`${saved.data.id}:${run.operationId}`)))
      throwIpcError('ROUTINE_RUN_PENDING', 'Wait for this routine run to finish and its outcome to be confirmed before deleting it');
    await driver.remove(saved.scheduleId!); await this.store.transaction(state => { delete state.routines[id]; if (state.presetRoutineDrafts) delete state.presetRoutineDrafts[id]; });
  }); }
}
