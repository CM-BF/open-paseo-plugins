import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CompanionProfile, CompanionCapabilities } from '../shared/contracts';
import { normalizeBotName } from '../shared/vendor/botCreation';
import { buildDefaultBotIdentity } from '../shared/vendor/botProfileDefaults';
import { normalizeBotModelChain } from '../shared/vendor/botModelChain';
import { BOT_SETTINGS_CAPABILITY_FIELDS, BOT_SETTINGS_PATCH_FIELDS } from '../shared/vendor/botRemoteSettings';
import { reconcileBotCapabilityList } from '../shared/vendor/botCapabilitySelection';
import { botProfileDir, ensureBotContentDirs, writeBotProfileFolder, readBotProfileFolder, migrateBotProfileFolder } from './vendor/botProfileFolder';
import { syncBotProfileFromFolder } from './vendor/botProfileFolderSync';
import { botId, CompanionError, record, string, throwIpcError } from './errors';
import type { SavedRoutine } from './schedules';
import type { SavedGroup } from './groups';
import type { SavedGroupHistory, SavedGroupThread } from './group-history';
import type { SavedPresetReceipt, PresetRoutineDraft } from './presets/install-state';
import { avatarDataUrl } from './avatar';
import type { SavedPresetOpening } from './presets/opening';
import type { SavedGroupWorkPlan } from './group-plans';
import type { GroupPlanSettings } from '../shared/group-plans';
import type { SavedPlanRequest } from './group-plan-organizer';
import type { SessionScope } from '../shared/session-scope';
import { taskNeedsSettlement, type SavedCompanionTask } from './companion-tasks';
import type { SavedGroupMedia } from './group-media';
import type { SavedGroupOutbox } from './group-outbox';
import type { NativeSkillsIntent } from './native-skills';

export interface Binding {
  agentId: string; workspaceId?: string; operationId: string; phase: 'creating' | 'ready' | 'unknown';
  profileVersion: number; config: Record<string, unknown>; cwd: string; title: string;
  appliedVersion: number | null; appliedCapabilities: CompanionCapabilities; error?: string;
  appliedProfile?: CompanionProfile;
  sessionScope?: SessionScope;
  desiredSkills?: NativeSkillsIntent;
  appliedSkills?: NativeSkillsIntent;
  skillsSupported?: boolean;
  skillsError?: { code: string; message: string };
}
interface ProfileVersion { version: number; at: number; profile: CompanionProfile }
export interface SavedState {
  format: 1; profiles: Record<string, CompanionProfile>; versions: Record<string, ProfileVersion[]>;
  bindings: Record<string, Binding>; createKeys: Record<string, string>;
  voice: Record<string, unknown>; routines: Record<string, SavedRoutine>;
  groups?: Record<string, SavedGroup>;
  /** Monotonic snapshot generation, including asynchronous native result writes. */
  historyRevision?: number;
  groupHistory?: Record<string, SavedGroupHistory>;
  groupThreads?: Record<string, SavedGroupThread>;
  groupMedia?: Record<string, SavedGroupMedia>;
  groupMediaKeys?: Record<string, string>;
  groupMediaCancelKeys?: Record<string, string>;
  groupOutbox?: Record<string, SavedGroupOutbox>;
  outboxSequence?: number;
  groupCreateKeys?: Record<string, { groupId: string; fingerprint: string }>;
  groupPlans?: Record<string,SavedGroupWorkPlan>;
  groupPlanSettings?: Record<string,GroupPlanSettings>;
  groupPlanOperations?: Record<string,{fingerprint:string;planId:string}>;
  groupPlanRequests?: Record<string,SavedPlanRequest>;
  companionTasks?: Record<string,SavedCompanionTask>;
  taskAgents?:Record<string,string>;
  routineAgents?:Record<string,{botId:string;routineId:string;cwd:string;sessionScope:SessionScope}>;
  profileDeletions?:Record<string,{requestedAt:number}>;
  presetImports?: Record<string, SavedPresetReceipt>;
  presetRoutineDrafts?: Record<string, PresetRoutineDraft>;
  presetOpenings?: Record<string, SavedPresetOpening>;
  folderPending?: string[];
  createPayloads?: Record<string, string>;
  deletedProfiles?: Record<string, { profile: CompanionProfile; versions: ProfileVersion[]; binding?: Binding; deletedAt: number; presetRoutineDrafts?: PresetRoutineDraft[]; presetOpenings?: SavedPresetOpening[] }>;
}
const initial = (): SavedState => ({ format: 1, profiles: {}, versions: {}, bindings: {}, createKeys: {}, voice: {}, routines: {} });
export function defaultCapabilities(): CompanionCapabilities {
  return { model: '', providerId: null, effort: '', fastMode: false, harness: 'codex', modelChain: [],
    modelChainOverride: null, taskModelOverride: null, skillMode: 'allowlist', skillsExcluded: [],
    toolsetMode: 'allowlist', toolsets: [], mcpMode: 'allowlist', mcpServers: [], memory: true, permissions: 'ask' };
}
export class CompanionStore {
  readonly root: string;
  private state: SavedState = initial();
  private queue: Promise<unknown> = Promise.resolve();
  private loadPromise: Promise<void> | null = null;
  constructor(root = join(process.env.PASEO_HOME || join(homedir(), '.paseo'), 'plugin-data', 'cindy-companion')) { this.root = resolve(root); }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(run); this.queue = next; return next;
  }
  async load(): Promise<void> {
    this.loadPromise ??= this.serial(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.safePath(this.root);
      try {
        await this.safePath(join(this.root, 'state.json'));
        const value = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8')) as SavedState;
        if (value.format !== 1 || !value.profiles || !value.bindings || !value.versions) throw new Error('Unsupported companion store format');
        for (const [id, profile] of Object.entries(value.profiles)) {
          botId(id); if (profile.id !== id || !Number.isSafeInteger(profile.currentVersion)) throw new Error('Invalid stored companion');
        }
        this.state = value;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!Object.keys(this.state.profiles).length) {
        const bot = this.makeProfile('cindy', { name: 'Cindy', description: '' });
        this.state.profiles[bot.id] = bot; this.version(this.state, bot); await this.persist(this.state);
      }
      for (const profile of Object.values(this.state.profiles)) await this.reconcileLoaded(profile.id);
    });
    return this.loadPromise;
  }
  async safePath(path: string): Promise<void> {
    const abs = resolve(path);
    if (abs !== this.root && !abs.startsWith(this.root + '/')) throwIpcError('UNSAFE_PATH', 'Path leaves companion data directory');
    const parts = abs.slice(this.root.length).split('/').filter(Boolean);
    let current = this.root;
    for (const part of ['', ...parts]) {
      if (part) current = join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throwIpcError('UNSAFE_PATH', 'Companion paths cannot be symbolic links'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  async checkHome(id: string): Promise<void> {
    botId(id); await this.safePath(join(this.root, 'bots', id, 'memories'));
  }
  private async persist(state: SavedState) {
    const path = join(this.root, 'state.json'); await this.safePath(path);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  }
  async transaction<T>(run: (state: SavedState) => T | Promise<T>): Promise<T> {
    await this.load();
    return this.serial(async () => {
      const draft = structuredClone(this.state); draft.historyRevision = (this.state.historyRevision ?? 0) + 1; const result = await run(draft);
      await this.persist(draft); this.state = draft; return structuredClone(result);
    });
  }
  /** Hold ownership stable during a filesystem read/index build without rewriting the state journal. */
  async withSnapshot<T>(run: (state: SavedState) => T | Promise<T>): Promise<T> {
    await this.load();
    return this.serial(async () => structuredClone(await run(structuredClone(this.state))));
  }
  async snapshot(): Promise<SavedState> { await this.load(); await this.queue.catch(() => {}); return structuredClone(this.state); }
  async list(): Promise<CompanionProfile[]> { return Object.values((await this.snapshot()).profiles); }
  async get(id: string): Promise<CompanionProfile> {
    botId(id); const result = (await this.snapshot()).profiles[id];
    if (!result) throwIpcError('NOT_FOUND', 'Companion not found'); return result;
  }
  private makeProfile(id: string, input: Record<string, unknown>): CompanionProfile {
    const name = string(input.name, 'name', 200).trim();
    const description = string(input.description ?? '', 'description', 65536, true).trim();
    const capabilities = defaultCapabilities();
    if (input.capabilities !== undefined) {
      const requested = record(input.capabilities);
      if (Object.keys(requested).some(key => key !== 'modelChainOverride') || !Array.isArray(requested.modelChainOverride) || requested.modelChainOverride.length !== 1)
        throwIpcError('INVALID_PARAMS', 'Creation accepts exactly one explicit model route');
      const route = record(requested.modelChainOverride[0]);
      if (Object.keys(route).some(key => !['harness', 'providerId', 'model', 'effort', 'fastMode', 'agentDeviceId'].includes(key)) ||
        !['claude', 'codex', 'pi'].includes(String(route.harness)) || typeof route.effort !== 'string' ||
        (typeof route.fastMode !== 'boolean' && route.fastMode !== 'ultrafast') ||
        (route.providerId !== null && typeof route.providerId !== 'string') ||
        (route.agentDeviceId !== undefined && route.agentDeviceId !== null)) throwIpcError('INVALID_PARAMS', 'Invalid local model route');
      string(route.model, 'model', 500); string(route.effort, 'effort', 100, true);
      if (route.providerId !== null) string(route.providerId, 'providerId', 200);
      const normalized = normalizeBotModelChain([route]);
      if (normalized.length !== 1) throwIpcError('INVALID_PARAMS', 'Invalid model route');
      capabilities.modelChainOverride = normalized;
    }
    if (input.avatar !== undefined && input.avatarImageBase64 !== undefined) throwIpcError('INVALID_PARAMS', 'Specify only one avatar source');
    return { id, name, description, identitySource: string(input.identitySource ?? buildDefaultBotIdentity(name, description), 'identitySource', 65536, true).trim(),
      userContextSource: string(input.userContextSource ?? '', 'userContextSource', 65536, true).trim(),
      avatar: input.avatarImageBase64 !== undefined ? avatarDataUrl(input.avatarImageBase64) : typeof input.avatar === 'string' ? input.avatar : id === 'cindy' ? 'cindy://avatar/preset/cindy' : '🤖', avatarColor: typeof input.avatarColor === 'string' ? input.avatarColor : '#8b7cf8',
      enabled: true, status: 'active', currentVersion: 1, skills: [], capabilities,
      homeDir: botProfileDir(this.root, id), createdAt: Date.now(), sessions: [] };
  }
  private version(state: SavedState, profile: CompanionProfile) {
    (state.versions[profile.id] ??= []).push({ version: profile.currentVersion, at: Date.now(), profile: structuredClone(profile) });
  }
  private assertUnique(state: SavedState, profile: CompanionProfile) {
    if (Object.values(state.profiles).some(p => p.id !== profile.id && normalizeBotName(p.name) === normalizeBotName(profile.name)))
      throwIpcError('CONFLICT', 'A companion with this name already exists');
  }
  async create(input: Record<string, unknown>): Promise<CompanionProfile> {
    const allowed = ['operationId', 'name', 'description', 'identitySource', 'userContextSource', 'avatar', 'avatarColor', 'avatarImageBase64', 'capabilities'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throwIpcError('INVALID_PARAMS', 'Unsupported creation field');
    const requestKey = input.operationId === undefined ? randomUUID() : string(input.operationId, 'operationId', 200);
    const key = createHash('sha256').update(requestKey).digest('hex');
    const candidate = this.makeProfile(randomUUID(), input);
    const payload = createHash('sha256').update(JSON.stringify([candidate.name, candidate.description, candidate.identitySource, candidate.userContextSource, candidate.avatar, candidate.avatarColor,
      ...(input.capabilities !== undefined ? [candidate.capabilities.modelChainOverride] : [])])).digest('hex');
    const profile = await this.transaction(state => {
      if (Object.hasOwn(state.createKeys, key)) {
        if (state.createPayloads?.[key] !== payload) throwIpcError('IDEMPOTENCY_CONFLICT', 'This creation key belongs to a different request');
        return state.profiles[state.createKeys[key]!]!;
      }
      const profile = candidate; this.assertUnique(state, profile);
      state.profiles[profile.id] = profile; state.createKeys[key] = profile.id; (state.createPayloads ??= {})[key] = payload; this.version(state, profile);
      state.folderPending = [...new Set([...(state.folderPending ?? []), profile.id])]; return profile;
    });
    await this.syncCurrentFolder(profile.id); return profile;
  }
  async update(id: string, input: Record<string, unknown>, expectedVersion?: number): Promise<CompanionProfile> {
    botId(id);
    await this.reconcile(id);
    const allowed = new Set<string>(BOT_SETTINGS_PATCH_FIELDS);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throwIpcError('INVALID_PARAMS', `Unsupported profile field: ${key}`);
    const profile = await this.transaction(state => {
      const current = state.profiles[id]; if (!current) throwIpcError('NOT_FOUND', 'Companion not found');
      if (expectedVersion !== undefined && expectedVersion !== current.currentVersion) throwIpcError('PRECONDITION_FAILED', 'profile-version-changed');
      const next = structuredClone(current);
      for (const key of ['name', 'description', 'identitySource', 'userContextSource', 'avatar', 'avatarColor'] as const) {
        if (input[key] !== undefined) next[key] = string(input[key], key, key === 'avatar' ? 1800100 : key === 'name' ? 200 : 65536, key !== 'name').trim();
      }
      if (input.expectedAvatar !== undefined && input.expectedAvatar !== current.avatar) throwIpcError('PRECONDITION_FAILED', 'avatar-changed');
      const baseline = input.capabilityBaseline === undefined ? {} : record(input.capabilityBaseline);
      const list = (value: unknown) => {
        if (!Array.isArray(value) || value.length > 300 || value.some(v => typeof v !== 'string' || v.length > 500)) throwIpcError('INVALID_PARAMS', 'Invalid capability list');
        return [...new Set(value as string[])];
      };
      if (input.skills !== undefined) next.skills = baseline.skills ? reconcileBotCapabilityList(list(baseline.skills), list(input.skills), current.skills) : list(input.skills);
      if (input.capabilities !== undefined) {
        const patch = record(input.capabilities);
        for (const key of Object.keys(patch)) if (!(BOT_SETTINGS_CAPABILITY_FIELDS as readonly string[]).includes(key)) throwIpcError('INVALID_PARAMS', `Unsupported capability: ${key}`);
        for (const key of ['memory', 'inputHandoff', 'allowSchedulerFollow']) if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throwIpcError('INVALID_PARAMS', `Invalid ${key}`);
        next.capabilities = { ...next.capabilities, ...patch };
        for (const key of ['mcpServers', 'toolsets'] as const) if (patch[key] !== undefined) next.capabilities[key] = baseline[key] ? reconcileBotCapabilityList(list(baseline[key]), list(patch[key]), current.capabilities[key]) : list(patch[key]);
        for (const key of ['modelChain', 'modelChainOverride'] as const) if (patch[key] !== undefined) {
          if (patch[key] === null && key === 'modelChainOverride') next.capabilities[key] = null;
          else { const routes = normalizeBotModelChain(patch[key]); if (!Array.isArray(patch[key]) || routes.length !== patch[key].length) throwIpcError('INVALID_PARAMS', 'Invalid model chain'); next.capabilities[key] = routes; }
        }
      }
      this.assertUnique(state, next);
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      next.currentVersion++; state.profiles[id] = next; this.version(state, next);
      state.folderPending = [...new Set([...(state.folderPending ?? []), id])]; return next;
    });
    await this.syncCurrentFolder(profile.id); return profile;
  }
  async deleteProfile(id: string, confirmName: string): Promise<void> {
    botId(id);
    await this.transaction(state => {
      const profile = state.profiles[id]; if (!profile) throwIpcError('NOT_FOUND', 'Companion not found');
      if (id === 'cindy') throwIpcError('DEFAULT_COMPANION', 'The default Cindy companion cannot be deleted');
      if (profile.name !== confirmName) throwIpcError('PRECONDITION_FAILED', 'Companion name changed; confirm again');
      if(Object.values(state.companionTasks??{}).some(task=>task.owner.botId===id&&taskNeedsSettlement(task)))throwIpcError('TASK_BUSY','Stop delegated tasks before deleting the companion');
      const presetRoutineDrafts = Object.values(state.presetRoutineDrafts ?? {}).filter(draft => draft.botId === id);
      const presetOpenings = Object.values(state.presetOpenings ?? {}).filter(opening => opening.botId === id);
      (state.deletedProfiles ??= {})[id] = { profile, versions: state.versions[id] ?? [], binding: state.bindings[id], deletedAt: Date.now(),
        ...(presetRoutineDrafts.length ? { presetRoutineDrafts } : {}), ...(presetOpenings.length ? { presetOpenings } : {}) };
      for (const draft of presetRoutineDrafts) delete state.presetRoutineDrafts![draft.data.id];
      for (const opening of presetOpenings) delete state.presetOpenings![opening.agentId];
      delete state.profiles[id]; delete state.versions[id]; delete state.bindings[id];
      delete state.profileDeletions?.[id];
      for (const [key, value] of Object.entries(state.createKeys)) if (value === id) { delete state.createKeys[key]; delete state.createPayloads?.[key]; }
    });
  }
  private async syncCurrentFolder(id: string): Promise<void> {
    await this.serial(() => this.flushFolder(id));
  }
  private async flushFolder(id: string) {
    await this.syncFolder(this.state.profiles[id]!);
    const draft = structuredClone(this.state); draft.folderPending = (draft.folderPending ?? []).filter(value => value !== id);
    await this.persist(draft); this.state = draft;
  }
  async reconcile(id: string): Promise<void> {
    botId(id); await this.load(); await this.serial(() => this.reconcileLoaded(id));
  }
  private async reconcileLoaded(id: string): Promise<void> {
    if (this.state.folderPending?.includes(id)) { await this.flushFolder(id); return; }
    const p = this.state.profiles[id]; if (!p) throwIpcError('NOT_FOUND', 'Companion not found');
    await this.checkHome(id);
    for (const slot of ['SOUL.md', 'system_prompt.md', 'config.json', 'memories/USER.md']) await this.safePath(join(p.homeDir, slot));
    await ensureBotContentDirs(this.root, id);
    await syncBotProfileFromFolder(id, {
      readSnapshot: async () => ({ identitySource: p.identitySource, config: { ...p.capabilities, userContextSource: p.userContextSource }, currentVersion: p.currentVersion }),
      readFolder: () => readBotProfileFolder(this.root, id, { strict: true }),
      seedFolder: async (_id, seed) => { await migrateBotProfileFolder(this.root, id, seed); },
      deriveVersion: async input => {
        const next = structuredClone(p);
        next.identitySource = string(input.identitySource, 'identitySource', 65536, true);
        next.userContextSource = string(input.config.userContextSource ?? '', 'userContextSource', 65536, true);
        next.currentVersion++;
        const draft = structuredClone(this.state); draft.profiles[id] = next; this.version(draft, next);
        await this.persist(draft); this.state = draft;
      },
    });
  }
  async syncFolder(profile: CompanionProfile): Promise<void> {
    await this.checkHome(profile.id);
    for (const slot of ['SOUL.md', 'system_prompt.md', 'config.json', 'memories/USER.md', 'workspace']) await this.safePath(join(profile.homeDir, slot));
    await ensureBotContentDirs(this.root, profile.id);
    await writeBotProfileFolder(this.root, profile.id, {
      identitySource: profile.identitySource, userContextSource: profile.userContextSource,
      config: { name: profile.name, description: profile.description, skills: profile.skills, ...profile.capabilities, profileVersion: profile.currentVersion },
    });
  }
}
