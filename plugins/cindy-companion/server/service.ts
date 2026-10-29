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

const OPS = ['caps', 'assets.fontChunk', 'profile.get', 'profile.update', 'profile.chooseAvatar', 'lifecycle.run', 'models.default', 'models.features',
  'memory.list', 'memory.read', 'memory.update', 'memory.delete', 'capabilities.catalog', 'history.search',
  'paseo.bootstrap', 'profile.list', 'profile.create', 'profile.ensure', 'paseo.conversation.ensure',
  'conversation.send', 'conversation.history', 'home.get', 'memory.create', 'paseo.openPath',
  'routines.list', 'routines.sources', 'routines.reconcile', 'routines.save', 'routines.saveWithModel', 'routines.saveWithSessionMode', 'routines.history', 'routines.runNow', 'routines.remove'] as const;
export class CompanionService {
  readonly store: CompanionStore;
  readonly runtime: CompanionRuntime;
  readonly routines: CompanionRoutines;
  private readonly memoryStores = new Map<string, CompanionMemoryStore>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly operations = new Set<Promise<unknown>>();
  private closing: Promise<void> | null = null;
  private disposed = false;
  readonly memory: ReturnType<typeof createBotMemoryService>;
  constructor(store = new CompanionStore(), options: { scheduleDriver?: ScheduleDriver } = {}) {
    this.store = store; this.runtime = new CompanionRuntime(store);
    this.routines = new CompanionRoutines(store, this.runtime, options.scheduleDriver ?? new ScheduleCli());
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
      await this.runtime.close();
    })();
    return this.closing;
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
      const id = profiles.find(profile => profile.canonicalSessionId)?.id ?? Object.values(state.routines)[0]?.botId;
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
    if (op === 'caps') return this.caps();
    if (op === 'assets.fontChunk') return readFontChunk(args);
    if (op === 'paseo.bootstrap') return this.bootstrap(paseo, args.botId === undefined ? undefined : botId(args.botId));
    if (op === 'profile.list') return { profiles: await this.store.list() };
    if (op === 'profile.create') return { profile: await this.store.create(args) };
    if (op === 'models.default') return { modelChain: [await this.runtime.defaultRoute(paseo, typeof args.botId === 'string' ? botId(args.botId) : 'cindy')] };
    // Unsupported host-wide operations must remain a visible failure, not fabricated empty catalogs.
    if (/^(voice\.|channels\.|autonomy\.)/.test(op)) return unsupported(op);
    if (op === 'routines.sources') return []; // This adapter has time triggers only; no event connector is registered.
    const id = botId(args.botId);
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
      const raw = string(args.avatarImageBase64, 'avatar', 1800000).replace(/^data:image\/(?:png|jpeg|webp);base64,/, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throwIpcError('INVALID_PARAMS', 'Invalid avatar image');
      const bytes = Buffer.from(raw, 'base64');
      const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' :
        bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg' :
        bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
      if (!mime) throwIpcError('INVALID_PARAMS', 'Avatar must be PNG, JPEG or WebP');
      const profile = await this.store.update(id, { avatar: `data:${mime};base64,${raw}`, ...(args.expectedAvatar === undefined ? {} : { expectedAvatar: args.expectedAvatar }) });
      return { profile, runtime: await this.runtime.state(id) };
    }
    if (['profile.ensure', 'paseo.conversation.ensure'].includes(op)) return this.runtime.ensure(paseo, id);
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
      if (state.bindings[id]?.phase && state.bindings[id]?.phase !== 'ready') throwIpcError('CREATE_OUTCOME_UNKNOWN', 'Resolve pending agent creation before deleting the companion');
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
