import type { PluginHandlerContext } from '@getpaseo/plugin/server';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CompanionProfile, RuntimeState } from '../shared/contracts';
import type { BotModelRoute } from '../shared/vendor/botModelChain';
import { CompanionStore, type Binding } from './store';
import { CompanionError, throwIpcError } from './errors';
import { verifyPackagedSkills } from './presets/skills';
import type { SessionScope } from '../shared/session-scope';

export type Paseo = PluginHandlerContext['paseo'];
export const COMPANION_CONTEXT_GUIDANCE = 'Discover the MCP tool by server cindy_memory and tool basename companion_context, then call its actual registered name. Hosts may expose it as cindy_memory.companion_context or mcp__cindy_memory__companion_context. When a tool registry such as ALL_TOOLS is available, match both cindy_memory and companion_context in its name or metadata; do not require a dot separator. A failed exact-name search does not establish that the plugin is disabled. If discovery or the actual call fails, stop and report that specific failure.';
type Agent = ReturnType<Paseo['agents']['ref']>;
type EvolvingAgent = Agent & {
  setModel?: (modelId: string | null) => Promise<void>;
  setThinkingOption?: (id: string | null) => Promise<unknown>;
  setFeature?: (id: string, value: unknown) => Promise<void>;
  updateInstructions?: (input: { systemPrompt: string; mcpServers?: Record<string, unknown> }) => Promise<unknown>;
};
export function selectedRoute(profile: CompanionProfile): BotModelRoute | null {
  return profile.capabilities.modelChainOverride?.[0] ?? profile.capabilities.modelChain[0] ??
    (profile.capabilities.model ? { harness: profile.capabilities.harness, model: profile.capabilities.model,
      providerId: profile.capabilities.providerId ?? null, effort: profile.capabilities.effort, fastMode: profile.capabilities.fastMode } : null);
}
export function routeProvider(route: BotModelRoute): string { return route.providerId || (route.harness === 'claude' ? 'claude' : route.harness); }
function sameRuntimeProfile(a: CompanionProfile, b: CompanionProfile): boolean {
  return JSON.stringify([a.identitySource, a.userContextSource, a.skills, a.capabilities]) === JSON.stringify([b.identitySource, b.userContextSource, b.skills, b.capabilities]);
}
export function resolveFastFeature(features: ReadonlyArray<{ type: string; id: string; options?: ReadonlyArray<{ id: string; label: string }> }>, value: boolean | 'ultrafast') {
  const tier = features.find(feature => feature.type === 'select' && feature.id === 'service_tier');
  if (tier) {
    const label = value === 'ultrafast' ? 'ultrafast' : value ? 'fast' : 'normal';
    const option = tier.options?.find(option => !value ? option.id === 'default' : option.id === label || option.label.toLowerCase() === label);
    if (option) return { id: 'service_tier', value: option.id };
  }
  if (value !== 'ultrafast' && features.some(feature => feature.type === 'toggle' && feature.id === 'fast_mode')) return { id: 'fast_mode', value };
  throwIpcError('FEATURE_UNAVAILABLE', 'This model does not advertise the selected speed');
}
/** Stable canonical IDs and immutable creation intent are committed before the native create. */
export class CompanionRuntime {
  private readonly store: CompanionStore;
  private readonly ensureJobs = new Map<string, Promise<{ profile: CompanionProfile; agentId: string; workspaceId: string | null; runtime: RuntimeState }>>();
  private readonly applyJobs = new Map<string, Promise<unknown>>();
  private mcpFactory?: (botId: string, scope?: SessionScope) => Promise<Record<string, unknown>>;
  private disposed = false;
  constructor(store: CompanionStore) { this.store = store; }
  setMcpFactory(factory: (botId: string, scope?: SessionScope) => Promise<Record<string, unknown>>) { this.mcpFactory = factory; }
  async instructionsFor(id: string, scope?: SessionScope) {
    await this.store.reconcile(id);
    const profile = await this.store.get(id);
    const skills = await verifyPackagedSkills(this.store, profile);
    return { systemPrompt: [this.systemPrompt(profile), skills.systemPromptSuffix].filter(Boolean).join('\n\n'), ...(this.mcpFactory ? { mcpServers: { cindy_memory: await this.mcpFactory(id, scope) } } : {}) };
  }
  /** Native lane config shared by group and owned background work. */
  async nativeConfigFor(paseo: Paseo, id: string, cwd: string, scope?: SessionScope): Promise<Record<string, unknown>> {
    await this.store.reconcile(id); const profile = await this.store.get(id);
    const skills = await verifyPackagedSkills(this.store, profile);
    if (profile.skills.some(skill => !skills.supportedSkillIds.includes(skill)) || profile.capabilities.mcpServers.length || profile.capabilities.toolsets.length)
      throwIpcError('CAPABILITY_NOT_APPLIED', 'Selected external skills, MCP servers or toolsets are not attached by this host');
    const route = selectedRoute(profile) ?? await this.defaultRoute(paseo, id);
    if (route.agentDeviceId) throwIpcError('UNSUPPORTED', 'Remote model routes require a companion host transfer');
    if ((profile.capabilities.modelChainOverride ?? profile.capabilities.modelChain).length > 1) throwIpcError('FALLBACK_UNSUPPORTED', 'Automatic model fallback is unavailable');
    if (profile.capabilities.allowSchedulerFollow) throwIpcError('AUTONOMY_UNSUPPORTED', 'Autonomous follow-up is not connected');
    const provider = routeProvider(route); const mode = provider === 'codex' ? 'auto' : provider === 'claude' ? 'default' : null;
    const catalog = await this.catalog(paseo, id);
    if (profile.capabilities.permissions !== 'ask' || !mode || !catalog.entries.find(entry => entry.provider === provider)?.modes?.some(candidate => candidate.id === mode))
      throwIpcError('PERMISSION_MODE_UNAVAILABLE', 'The provider does not advertise a supported ask-permission mode');
    let featureValues: Record<string, unknown> | undefined;
    if (route.fastMode) {
      const features = await paseo.providers.listFeatures({ provider: `${provider}/${route.model}`, cwd });
      if (features.error) throwIpcError('PROVIDER_FEATURES_UNAVAILABLE', features.error);
      const feature = resolveFastFeature(features.features ?? [], route.fastMode); featureValues = { [feature.id]: feature.value };
    }
    return { provider: `${provider}/${route.model}`, modeId: mode, ...await this.instructionsFor(id, scope),
      ...(provider === 'codex' ? { options: { approval_policy: 'on-request', sandbox_mode: 'workspace-write' } } : {}),
      ...(route.effort ? { thinkingOptionId: route.effort } : {}), ...(featureValues ? { featureValues } : {}) };
  }
  /** A plain delegated task inherits the selected task model, never the companion's identity or memory. */
  async taskConfigFor(paseo:Paseo,id:string,cwd:string):Promise<Record<string,unknown>>{
    const profile=await this.store.get(id),route=profile.capabilities.taskModelOverride??selectedRoute(profile)??await this.defaultRoute(paseo,id);
    if(route.agentDeviceId)throwIpcError('UNSUPPORTED','Remote delegated sessions are not available');
    const provider=routeProvider(route),mode=provider==='codex'?'auto':provider==='claude'?'default':null;
    const catalog=await this.catalog(paseo,id);if(!mode||!catalog.entries.find(e=>e.provider===provider)?.modes?.some(m=>m.id===mode))throwIpcError('PERMISSION_MODE_UNAVAILABLE','The task provider has no verified ask-permission mode');
    let featureValues:Record<string,unknown>|undefined;
    if(route.fastMode){const features=await paseo.providers.listFeatures({provider:`${provider}/${route.model}`,cwd});if(features.error)throwIpcError('FEATURE_UNAVAILABLE',features.error);const feature=resolveFastFeature(features.features??[],route.fastMode);featureValues={[feature.id]:feature.value};}
    return{provider:`${provider}/${route.model}`,modeId:mode,...(route.effort?{thinkingOptionId:route.effort}:{}),...(featureValues?{featureValues}:{}),
      ...(provider==='codex'?{options:{approval_policy:'on-request',sandbox_mode:'workspace-write'}}:{})};
  }
  async close(): Promise<void> { this.disposed = true; await Promise.allSettled([...this.ensureJobs.values(), ...this.applyJobs.values()]); }
  private assertOpen() { if (this.disposed) throwIpcError('PLUGIN_CLOSED', 'Companion plugin is closing'); }
  private systemPrompt(profile: CompanionProfile): string {
    return [this.mcpFactory ? `At the start of every user turn, read the companion context. ${COMPANION_CONTEXT_GUIDANCE} It contains the current companion identity, user preferences and memory-enabled setting; use those current values in place of the initial profile below. Read and write durable memories only through this server's memory_list, memory_read, memory_write, memory_update and memory_delete tools, using their actual registered names in the same way. Do not edit memory files directly. Respect memoryEnabled=false.` : '',
      profile.identitySource, profile.userContextSource ? `Initial user preferences:\n${profile.userContextSource}` : ''].filter(Boolean).join('\n\n');
  }
  async state(id: string): Promise<RuntimeState> {
    const state = await this.store.snapshot(); const p = state.profiles[id];
    if (!p) throwIpcError('NOT_FOUND', 'Companion not found');
    const b = state.bindings[id];
    const base = { agentId: b?.agentId ?? null, workspaceId: b?.workspaceId ?? null, desiredVersion: p.currentVersion, appliedVersion: b?.appliedVersion ?? null,
      configuredModel: selectedRoute(p), appliedModel: b ? selectedRoute({ ...p, capabilities: b.appliedCapabilities }) : null };
    if(state.profileDeletions?.[id])return{...base,state:'error',code:'COMPANION_DELETING',message:'Deletion is awaiting native cleanup. Retry Delete to complete it.'};
    if (!b) return { ...base, state: 'not-created' };
    if (b.phase !== 'ready') return { ...base, state: b.phase === 'unknown' ? 'unknown' : 'creating', code: b.phase === 'unknown' ? 'CREATE_OUTCOME_UNKNOWN' : undefined, message: b.error };
    if(this.mcpFactory&&!b.sessionScope)return{...base,state:'pending',code:'SESSION_TOOLS_REFRESH_REQUIRED',message:'Memory remains available. Collaboration tools require a host instruction refresh for this existing session.'};
    const applied = b.appliedProfile ?? state.versions[id]?.find(v => v.version === b.appliedVersion)?.profile;
    if (applied && sameRuntimeProfile(p, applied)) return { ...base, state: 'ready' };
    if (applied && JSON.stringify([p.skills, p.capabilities.skillMode, p.capabilities.skillsExcluded, p.capabilities.mcpServers, p.capabilities.mcpMode, p.capabilities.toolsets, p.capabilities.toolsetMode]) !==
      JSON.stringify([applied.skills, applied.capabilities.skillMode, applied.capabilities.skillsExcluded, applied.capabilities.mcpServers, applied.capabilities.mcpMode, applied.capabilities.toolsets, applied.capabilities.toolsetMode]))
      return { ...base, state: 'pending', code: 'CAPABILITY_NOT_APPLIED', message: 'Saved, but this host cannot configure companion-specific skill, external MCP or toolset selections. Provider-native capabilities remain unchanged.' };
    return { ...base, state: 'pending', code: 'RUNTIME_REFRESH_REQUIRED', message: 'Saved. This host cannot refresh all companion instructions in an existing session; the active session retains its applied profile.' };
  }
  async catalog(paseo: Paseo, id: string) {
    const p = await this.store.get(id); return paseo.providers.waitForReady({ cwd: join(p.homeDir, 'workspace'), timeoutMs: 15000 });
  }
  async refreshState(paseo: Paseo, id: string): Promise<RuntimeState> {
    const state = await this.state(id); if (!state.agentId) return state;
    try { if (this.mcpFactory) await this.mcpFactory(id); }
    catch (error) { return { ...state, state: 'error', code: 'TOOL_ENDPOINT_UNAVAILABLE', message: `Companion tools are offline: ${error instanceof Error ? error.message : String(error)}` }; }
    const agent = paseo.agents.ref(state.agentId);
    const observed = await agent.refresh();
    if (!observed) return { ...state, state: 'error', code: 'CANONICAL_MISSING', message: 'The linked Paseo agent is missing.' };
    if (agent.archivedAt) return { ...state, state: 'error', code: 'CANONICAL_ARCHIVED', message: 'The linked Paseo agent is archived.' };
    const snapshot = agent.current();
    const model = snapshot?.runtimeInfo?.model ?? snapshot?.model;
    const actual = model && snapshot ? { harness: snapshot.provider === 'claude' ? 'claude' as const : snapshot.provider === 'pi' ? 'pi' as const : 'codex' as const,
      providerId: snapshot.provider, model, effort: snapshot.effectiveThinkingOptionId ?? '', fastMode: state.appliedModel?.fastMode ?? false } : state.appliedModel;
    return { ...state, appliedModel: actual, active: Boolean(agent.activeTurn || agent.status === 'running' || agent.status === 'initializing'),
      ...(actual && state.appliedModel && (actual.model !== state.appliedModel.model || actual.providerId !== routeProvider(state.appliedModel))
        ? { state: 'pending' as const, code: 'EXTERNAL_MODEL_CHANGE', message: 'The active Paseo model differs from the last companion configuration.' } : {}) };
  }
  async defaultRoute(paseo: Paseo, id: string): Promise<BotModelRoute> {
    const snapshot = await this.catalog(paseo, id);
    const entry = snapshot.entries.find(e => e.status === 'ready' && e.models?.length && e.provider === 'codex') ??
      snapshot.entries.find(e => e.status === 'ready' && e.models?.length && ['claude', 'pi'].includes(e.provider)) ?? snapshot.entries.find(e => e.status === 'ready' && e.models?.length);
    const model = entry?.models?.find(m => m.isDefault) ?? entry?.models?.[0];
    if (!entry || !model) throwIpcError('PROVIDER_UNAVAILABLE', 'No provider model is ready on this host');
    return { harness: entry.provider === 'claude' ? 'claude' : entry.provider === 'pi' ? 'pi' : 'codex', providerId: entry.provider, model: model.id, effort: '', fastMode: false };
  }
  ensure(paseo: Paseo, id: string) {
    const pending = this.ensureJobs.get(id); if (pending) return pending;
    const job = this.ensureOnce(paseo, id).finally(() => { if (this.ensureJobs.get(id) === job) this.ensureJobs.delete(id); });
    this.ensureJobs.set(id, job); return job;
  }
  private async ensureOnce(paseo: Paseo, id: string) {
    this.assertOpen();
    await this.store.reconcile(id);
    let profile = await this.store.get(id);
    if((await this.store.snapshot()).profileDeletions?.[id])throwIpcError('COMPANION_DELETING','Finish companion deletion before starting a conversation');
    if (!profile.enabled || profile.status !== 'active') throwIpcError('PRECONDITION_FAILED', 'Companion is paused or archived');
    let binding = (await this.store.snapshot()).bindings[id];
    if (binding && this.mcpFactory) {
      try { await this.mcpFactory(id); }
      catch (error) { throw new CompanionError('TOOL_ENDPOINT_UNAVAILABLE', `Companion tools are offline: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!binding) {
      const route = selectedRoute(profile) ?? await this.defaultRoute(paseo, id);
      this.assertOpen();
      if (route.agentDeviceId) throwIpcError('UNSUPPORTED', 'Remote model routes require a companion host transfer');
      // Do not silently grant requested but unimplemented runtime capabilities.
      const packagedSkills = await verifyPackagedSkills(this.store, profile);
      if (profile.skills.some(skill => !packagedSkills.supportedSkillIds.includes(skill)) || profile.capabilities.mcpServers.length || profile.capabilities.toolsets.length)
        throwIpcError('CAPABILITY_NOT_APPLIED', 'Selected skills, MCP servers or toolsets are not attached by this host yet');
      if ((profile.capabilities.modelChainOverride ?? profile.capabilities.modelChain).length > 1) throwIpcError('FALLBACK_UNSUPPORTED', 'Automatic fallback between multiple models is not implemented by this host');
      if (profile.capabilities.allowSchedulerFollow) throwIpcError('AUTONOMY_UNSUPPORTED', 'Autonomous follow-up is not connected on this host');
      let featureValues: Record<string, unknown> | undefined;
      if (route.fastMode) {
        const catalog = await paseo.providers.listFeatures({ provider: `${routeProvider(route)}/${route.model}`, cwd: join(profile.homeDir, 'workspace') });
        if (catalog.error) throwIpcError('PROVIDER_FEATURES_UNAVAILABLE', catalog.error);
        const feature = resolveFastFeature(catalog.features ?? [], route.fastMode); featureValues = { [feature.id]: feature.value };
      }
      const agentId=randomUUID();
      const sessionScope:SessionScope={agentId,role:'canonical'};
      const config: Record<string, unknown> = { provider: `${routeProvider(route)}/${route.model}`, ...await this.instructionsFor(id,sessionScope),
        ...(featureValues ? { featureValues } : {}),
        ...(route.effort ? { thinkingOptionId: route.effort } : {}) };
      const intent: Binding = { agentId, sessionScope, operationId: `cindy-companion:${id}:${randomUUID()}`, phase: 'creating',
        profileVersion: profile.currentVersion, config, cwd: join(profile.homeDir, 'workspace'), title: profile.name,
        appliedVersion: null, appliedCapabilities: { ...profile.capabilities, modelChain: [route] }, appliedProfile: structuredClone(profile) };
      binding = await this.store.transaction(state => state.bindings[id] ?? (state.bindings[id] = intent));
    }
    let agent = paseo.agents.ref(binding.agentId);
    try {
      const found = await agent.refresh();
      if (!found) {
        this.assertOpen();
        if (binding.phase === 'ready') throwIpcError('CANONICAL_MISSING', 'The canonical Paseo agent is missing; a new one was not silently created');
        agent = await paseo.agents.create({ agentId: binding.agentId, idempotencyKey: binding.operationId,
          config: binding.config as unknown as Parameters<Paseo['agents']['create']>[0]['config'], cwd: binding.cwd, title: binding.title,
          labels: { 'cindy-companion.botId': id, 'cindy-companion.operationId': binding.operationId } });
        await agent.refresh();
      }
      if (agent.archivedAt) throwIpcError('CANONICAL_ARCHIVED', 'The canonical Paseo agent is archived');
      await this.store.transaction(state => {
        const current = state.bindings[id]!; current.phase = 'ready'; current.error = undefined;
        current.appliedVersion ??= current.profileVersion; current.workspaceId = agent.workspaceId ?? undefined;
        const p = state.profiles[id]!; p.canonicalSessionId = agent.id; p.canonicalWorkspaceId = current.workspaceId;
        if (!p.sessions.some(s => s.id === agent.id)) p.sessions.push({ id: agent.id, title: p.name, kind: 'chat', role: 'canonical', status: 'active', updatedAt: Date.now(), profileVersion: current.appliedVersion });
      });
    } catch (error) {
      if (!(error instanceof CompanionError) || !['CANONICAL_MISSING', 'CANONICAL_ARCHIVED'].includes(error.code)) {
        await this.store.transaction(state => { const b = state.bindings[id]!; if (b.phase !== 'ready') { b.phase = 'unknown'; b.error = error instanceof Error ? error.message : String(error); } });
      }
      throw error;
    }
    profile = await this.store.get(id);
    return { profile, agentId: agent.id, workspaceId: agent.workspaceId, runtime: await this.state(id) };
  }
  applyProfile(paseo: Paseo, id: string): Promise<RuntimeState> {
    const previous = this.applyJobs.get(id) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(() => this.applyProfileOnce(paseo, id));
    this.applyJobs.set(id, job);
    void job.finally(() => { if (this.applyJobs.get(id) === job) this.applyJobs.delete(id); }).catch(() => {});
    return job;
  }
  private async applyProfileOnce(paseo: Paseo, id: string): Promise<RuntimeState> {
    this.assertOpen();
    const modelState = await this.applyModel(paseo, id);
    const state = await this.store.snapshot(); const b = state.bindings[id]; const p = state.profiles[id]!;
    if (!b || b.phase !== 'ready') return modelState;
    const applied = b.appliedProfile ?? state.versions[id]!.find(v => v.version === b.appliedVersion)?.profile;
    if (!applied || (b.sessionScope && applied.identitySource === p.identitySource && applied.userContextSource === p.userContextSource && applied.capabilities.memory === p.capabilities.memory)) return modelState;
    const agent = paseo.agents.ref(b.agentId) as EvolvingAgent;
    if (!agent.updateInstructions) return modelState;
    await agent.refresh();
    if (agent.activeTurn || agent.status === 'running' || agent.status === 'initializing' || agent.pendingPermissions?.length) return { ...modelState, code: 'AGENT_BUSY', message: 'Saved; instructions will apply after the active turn and pending permissions are settled.' };
    const sessionScope:SessionScope={agentId:b.agentId,role:'canonical'};
    const instructions = await this.instructionsFor(id,sessionScope);
    this.assertOpen(); await agent.updateInstructions(instructions);
    await this.store.transaction(draft => {
      const current = draft.bindings[id]!;
      current.sessionScope=sessionScope;current.config={...current.config,...instructions};
      current.appliedProfile = { ...applied, identitySource: p.identitySource, userContextSource: p.userContextSource,
        capabilities: { ...applied.capabilities, memory: p.capabilities.memory } };
      if (sameRuntimeProfile(draft.profiles[id]!, current.appliedProfile)) current.appliedVersion = p.currentVersion;
    });
    return this.state(id);
  }
  async applyModel(paseo: Paseo, id: string): Promise<RuntimeState> {
    const p = await this.store.get(id); const b = (await this.store.snapshot()).bindings[id];
    if (!b || b.phase !== 'ready') return this.state(id);
    if ((p.capabilities.modelChainOverride ?? p.capabilities.modelChain).length > 1) return { ...await this.state(id), state: 'pending', code: 'FALLBACK_UNSUPPORTED', message: 'Saved; automatic fallback between multiple models is not implemented by this host.' };
    const route = selectedRoute(p); if (!route) return this.state(id);
    const applied = selectedRoute({ ...p, capabilities: b.appliedCapabilities });
    if (JSON.stringify(route) === JSON.stringify(applied)) return this.state(id);
    const speedChanged = route.fastMode !== applied?.fastMode;
    const effortChanged = route.effort !== applied?.effort;
    const agent = paseo.agents.ref(b.agentId) as EvolvingAgent; await agent.refresh();
    if (agent.activeTurn || agent.status === 'running' || agent.status === 'initializing') return { ...await this.state(id), code: 'AGENT_BUSY', message: 'Saved; the current turn is still running.' };
    const currentProvider = agent.current()?.provider;
    if (currentProvider !== routeProvider(route)) return { ...await this.state(id), code: 'PROVIDER_CHANGE_REQUIRES_NEW_SESSION', message: 'Saved; this host cannot change an existing session provider.' };
    if (!agent.setModel || ((effortChanged || route.effort) && !agent.setThinkingOption) || (speedChanged && !agent.setFeature)) return { ...await this.state(id), code: 'HOST_UPGRADE_REQUIRED', message: 'Saved; this Paseo version has no public agent configuration update API.' };
    let speed: { id: string; value: unknown } | undefined;
    if (speedChanged) {
      const catalog = await paseo.providers.listFeatures({ provider: `${routeProvider(route)}/${route.model}`, cwd: join(p.homeDir, 'workspace') });
      if (catalog.error) throwIpcError('PROVIDER_FEATURES_UNAVAILABLE', catalog.error);
      speed = resolveFastFeature(catalog.features ?? [], route.fastMode);
    }
    this.assertOpen();
    await agent.setModel(route.model);
    if (effortChanged || route.effort) await agent.setThinkingOption!(route.effort || null);
    if (speed) await agent.setFeature!(speed.id, speed.value);
    await agent.refresh();
    const snapshot = agent.current();
    if (snapshot?.model !== route.model && snapshot?.runtimeInfo?.model !== route.model) throwIpcError('MODEL_NOT_CONFIRMED', 'The host did not confirm the selected model');
    if (route.effort && snapshot?.effectiveThinkingOptionId !== route.effort) throwIpcError('MODEL_NOT_CONFIRMED', 'The host did not confirm the selected thinking option');
    if (effortChanged && !route.effort && snapshot?.thinkingOptionId !== null) {
      // Providers may resolve null into their advertised default instead of retaining null.
      const catalog = await this.catalog(paseo, id);
      const defaultEffort = catalog.entries.find(entry => entry.provider === routeProvider(route))?.models?.find(model => model.id === route.model)?.defaultThinkingOptionId;
      if (!defaultEffort || snapshot?.effectiveThinkingOptionId !== defaultEffort || snapshot?.thinkingOptionId !== defaultEffort)
        throwIpcError('MODEL_NOT_CONFIRMED', 'The host did not confirm resetting the thinking option to the model default');
    }
    if (speed && !snapshot?.features?.some(feature => feature.id === speed!.id && feature.value === speed!.value)) throwIpcError('MODEL_NOT_CONFIRMED', 'The host did not confirm the selected speed');
    // Model acknowledgement does not imply that systemPrompt, skills or memory were refreshed.
    await this.store.transaction(state => {
      const current = state.bindings[id]!;
      current.appliedCapabilities = { ...current.appliedCapabilities, modelChain: [route], modelChainOverride: [route] };
      const previous = current.appliedProfile ?? state.versions[id]!.find(v => v.version === current.appliedVersion)?.profile;
      if (previous) {
        current.appliedProfile = { ...previous, capabilities: { ...previous.capabilities,
          model: p.capabilities.model, providerId: p.capabilities.providerId, effort: p.capabilities.effort,
          fastMode: p.capabilities.fastMode,
          harness: p.capabilities.harness, modelChain: p.capabilities.modelChain, modelChainOverride: p.capabilities.modelChainOverride } };
        if (sameRuntimeProfile(state.profiles[id]!, current.appliedProfile)) current.appliedVersion = state.profiles[id]!.currentVersion;
      }
    });
    return this.refreshState(paseo, id);
  }
}
