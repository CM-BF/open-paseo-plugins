import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CompanionSkillDocument, CompanionSkillMetadata, CompanionSkillMutation, CompanionSkillReceipt } from '../shared/companion-skills';
import { normalizeBotSkillSlug, parseBotSkillFile, saveBotSkill, BotSkillStoreError, BOT_SKILL_MAX_BODY_BYTES } from './vendor/skills/botSkillStore';
import { buildBotSkillQueryIndex, searchBotSkillQueryIndex } from './vendor/skills/botSkillQueryIndex';
import { cachedBotSkillRuntime, invalidateBotSkillRuntime } from './vendor/skills/botSkillRuntimeCache';
import { iterateBotSkillQuerySummaries, iterateBotSkillRuntimeSummaries } from './vendor/skills/botSkillRuntimeSource';
import { projectCompanionSkillMounts } from './companion-skills-projection';
import { botId, string, throwIpcError } from './errors';
import type { CompanionStore, SavedState } from './store';
import type { NativeSkillsSnapshot } from './native-skills';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const revisionFromHash = (sourceHash: string, enabled: boolean) => hash(JSON.stringify([enabled, sourceHash]));
const revision = (source: string, enabled: boolean) => revisionFromHash(hash(source), enabled);
const EDITOR_BYTES = 1024 * 1024;
interface SourceMetadata { runtime: string; query: string }
/** Order-independent metadata evidence: constant memory, no source/body reads. */
function metadataSet() {
  const sum = Buffer.alloc(32); let count = 0;
  return {
    add(value: unknown[]) {
      const digest = createHash('sha256').update(JSON.stringify(value)).digest();
      let carry = 0;
      for (let i = sum.length - 1; i >= 0; i--) {
        const next = sum[i]! + digest[i]! + carry; sum[i] = next & 255; carry = next >>> 8;
      }
      count++;
    },
    stamp: () => `${count}:${sum.toString('hex')}`,
  };
}
interface Located { source?: string; sourceHash: string; bytes: number; enabled: boolean; dir: string; file: string; revision: string }
/** Called while the store's mutation lock is held; it must not re-enter the store. */
export type SkillAccess = (state: SavedState) => Promise<void>;
interface Intent {
  version: 1; botId: string; fingerprint: string; phase: 'prepared' | 'completed';
  operationId: string; slug: string; kind: CompanionSkillMutation['kind'];
  before: { revision: string; enabled: boolean; sourceHash: string } | null;
  after: { revision: string; enabled: boolean; sourceHash: string } | null;
  /** Only an unfinished content write retains source bytes. */
  source?: string;
  receipt?: CompanionSkillReceipt;
}

/** Original parsing, validation, catalog and projection; owner-scoped atomic publication. */
export class CompanionSkills {
  private readonly store: CompanionStore;
  constructor(store: CompanionStore) { this.store = store; }
  private root(id: string) { return join(this.store.root, 'bots', botId(id)); }
  private owner(state: SavedState, id: string): void {
    botId(id);
    if (!Object.hasOwn(state.profiles, id)) throwIpcError('NOT_FOUND', 'Companion not found');
    if (state.profileDeletions?.[id]) throwIpcError('COMPANION_DELETING', 'Companion deletion is pending');
  }
  private slug(value: unknown): string {
    const slug = string(value, 'slug', 64);
    if (normalizeBotSkillSlug(slug) !== slug) throwIpcError('INVALID_PARAMS', 'Invalid skill slug');
    return slug;
  }
  private async exists(path: string) {
    try { return await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async directory(path: string): Promise<void> {
    await this.store.safePath(path);
    const stat = await this.exists(path);
    if (stat && !stat.isDirectory()) throwIpcError('UNSAFE_PATH', 'Skill path is not a directory');
  }
  private async digest(file: string, capture: boolean): Promise<{ sourceHash: string; bytes: number; source?: string }> {
    await this.store.safePath(file);
    const handle = await open(file, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile()) throwIpcError('UNSAFE_PATH', 'Skill entrypoint is not a regular file');
      const keep = capture && before.size <= EDITOR_BYTES, chunks: Buffer[] = [];
      const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let offset = 0;
      while (offset < before.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (!bytesRead) throwIpcError('PRECONDITION_FAILED', 'Skill changed while it was read');
        digest.update(buffer.subarray(0, bytesRead)); if (keep) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throwIpcError('PRECONDITION_FAILED', 'Skill changed while it was read');
      return { sourceHash: digest.digest('hex'), bytes: offset, ...(keep ? { source: Buffer.concat(chunks).toString('utf8') } : {}) };
    } finally { await handle.close(); }
  }
  private async locate(id: string, slug: string, capture = false): Promise<Located | null> {
    let found: Located | null = null;
    for (const enabled of [true, false]) {
      const dir = join(this.root(id), enabled ? 'skills' : 'disabled-skills', slug);
      await this.directory(dir);
      for (const name of ['SKILL.md', 'skill.md']) {
        const file = join(dir, name); await this.store.safePath(file);
        const stat = await this.exists(file); if (!stat) continue;
        if (!stat.isFile()) throwIpcError('UNSAFE_PATH', 'Skill entrypoint is not a regular file');
        if (found) throwIpcError('SKILL_CONFLICT', 'The same skill exists in both enabled and disabled shelves');
        const value = await this.digest(file, capture);
        found = { dir, file, ...value, enabled, revision: revisionFromHash(value.sourceHash, enabled) }; break;
      }
    }
    return found;
  }
  /** Check precisely the paths consumed by upstream scanners before handing them over. */
  private async scanPaths(id: string): Promise<SourceMetadata> {
    const root = this.root(id); await this.directory(root);
    const runtime = metadataSet(), query = metadataSet();
    for (const shelf of ['skills', 'disabled-skills']) {
      const dir = join(root, shelf); await this.directory(dir);
      const entries = await opendir(dir, { bufferSize: 32 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;
      });
      if (!entries) continue;
      for await (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const child = join(dir, entry.name); await this.store.safePath(child);
        if (!entry.isDirectory()) continue;
        for (const name of ['SKILL.md', 'skill.md']) {
          const file = join(child, name); await this.store.safePath(file);
          const stat = await lstat(file, { bigint: true }).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;
          });
          if (!stat) continue;
          if (stat.isSymbolicLink()) throwIpcError('UNSAFE_PATH', 'Skill entrypoints cannot be symbolic links');
          // ctime catches same-size edits even if an editor restores mtime. The
          // filename is included; resources under the Skill remain outside this index.
          const value = [shelf, entry.name, name, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
          query.add(value); if (shelf === 'skills') runtime.add(value);
        }
      }
    }
    // The upstream projection/index write only beneath these generated roots.
    for (const name of ['.runtime-skills', '.runtime-skills/skills', '.runtime-skills/skills/personal-skill-library', '.runtime-skills/.claude-plugin', '.claude-plugin']) await this.directory(join(root, name));
    for (const name of ['.runtime-skills/catalog.jsonl', '.runtime-skills/query-catalog.jsonl', '.runtime-skills/skills/personal-skill-library/SKILL.md', '.runtime-skills/.claude-plugin/plugin.json', '.claude-plugin/plugin.json']) await this.store.safePath(join(root, name));
    return { runtime: runtime.stamp(), query: query.stamp() };
  }
  private async atomic(path: string, value: string, beforePublish?: () => Promise<void>): Promise<void> {
    await this.store.safePath(path); await this.directory(dirname(path));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
      await this.store.safePath(path); await beforePublish?.(); await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  async read(id: string, value: unknown, access?: SkillAccess): Promise<CompanionSkillDocument | null> {
    const slug = this.slug(value);
    return this.store.withSnapshot(async state => {
      this.owner(state, id); await access?.(state);
      const current = await this.locate(id, slug, true); await access?.(state);
      if (!current) return null;
      if (current.source === undefined)
        throwIpcError('SKILL_EDITOR_TOO_LARGE', 'Use skills.inspect for its revision and enabled state. The original source is too large for this editor, but remains searchable and projectable');
      return { ...parseBotSkillFile(current.source), slug, source: current.source, enabled: current.enabled, revision: current.revision };
    });
  }
  async inspect(id: string, value: unknown, access?: SkillAccess): Promise<CompanionSkillMetadata | null> {
    const slug = this.slug(value);
    return this.store.withSnapshot(async state => {
      this.owner(state, id); await access?.(state);
      const current = await this.locate(id, slug); await access?.(state);
      return current ? { slug, revision: current.revision, enabled: current.enabled, bytes: current.bytes, editable: current.bytes <= EDITOR_BYTES } : null;
    });
  }
  async query(id: string, input: { query?: string; offset?: number; limit?: number; expectedRevision?: string } = {}, access?: SkillAccess, nativePaths = false) {
    if (input.query !== undefined) string(input.query, 'query', 4096, true);
    if (input.expectedRevision !== undefined) string(input.expectedRevision, 'expectedRevision', 200);
    for (const [key, value] of Object.entries({ offset: input.offset, limit: input.limit }))
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throwIpcError('INVALID_PARAMS', `Invalid ${key}`);
    // Query generation is serialized, but read-only callers never migrate original source.
    return this.store.withSnapshot(async state => {
      this.owner(state, id); await access?.(state); const metadata = await this.scanPaths(id);
      const root = this.root(id);
      const cached = await cachedBotSkillRuntime(root, async () => ({ pluginRoot: root, skills: [], catalogRevision: randomUUID(),
        artifacts: [await buildBotSkillQueryIndex(root, iterateBotSkillQuerySummaries(this.store.root, id, { migrate: false }))] }), 'query', metadata.query) as Awaited<ReturnType<typeof cachedBotSkillRuntime>> & { catalogRevision?: string };
      if (typeof cached.catalogRevision !== 'string') throwIpcError('SKILL_CATALOG_CHANGED', 'The skill catalog was rebuilt; restart the search from its first page');
      if (input.expectedRevision !== undefined && input.expectedRevision !== cached.catalogRevision)
        throwIpcError('SKILL_CATALOG_CHANGED', 'The skill library changed between pages; reload the first page');
      const result = await searchBotSkillQueryIndex(join(root, '.runtime-skills/query-catalog.jsonl'), input);
      await access?.(state);
      // File paths are a separate native mount concern, not editable RPC authority.
      return { ...result, revision: cached.catalogRevision,
        skills: nativePaths ? result.skills : result.skills.map(({ filePath: _path, bodyStartLine: _line, ...skill }) => skill) };
    });
  }
  /** Extra metadata survives the original cache's structuredClone. */
  private async runtimeProjection(id: string) {
    const metadata = await this.scanPaths(id); await this.ensureManifest(id);
    const cached = await cachedBotSkillRuntime(this.root(id), async () => {
      let enabledCount = 0;
      const source = iterateBotSkillRuntimeSummaries(this.store.root, id);
      async function* counted() { for await (const skill of source) { enabledCount++; yield skill; } }
      const projection = await projectCompanionSkillMounts(this.root(id), counted());
      return { ...projection, sourceToken: randomUUID(), enabledCount };
    }, 'runtime', metadata.runtime) as Awaited<ReturnType<typeof cachedBotSkillRuntime>> & { sourceToken?: string; enabledCount?: number };
    if (typeof cached.sourceToken !== 'string' || !Number.isSafeInteger(cached.enabledCount) || cached.enabledCount! < 0)
      throwIpcError('SKILL_RUNTIME_UNAVAILABLE', 'Skill projection identity is unavailable');
    return { ...cached, sourceToken: cached.sourceToken, enabledCount: cached.enabledCount! };
  }
  async projection(id: string) {
    return this.store.withSnapshot(async state => {
      this.owner(state, id); return this.runtimeProjection(id);
    });
  }
  async nativeSnapshot(id: string): Promise<NativeSkillsSnapshot> {
    return this.store.withSnapshot(async state => {
      this.owner(state, id);
      const profile = state.profiles[id]!, projection = await this.runtimeProjection(id);
      // Profile selections are bounded; the complete shelf is never collected just to classify these IDs.
      const localSkillIds: string[] = [];
      for (const slug of profile.skills) {
        if (normalizeBotSkillSlug(slug) !== slug) continue;
        let owned = false;
        for (const shelf of ['skills', 'disabled-skills']) {
          const dir = join(this.root(id), shelf, slug); await this.directory(dir);
          for (const name of ['SKILL.md', 'skill.md']) {
            const file = join(dir, name); await this.store.safePath(file);
            const stat = await this.exists(file);
            if (stat && !stat.isFile()) throwIpcError('UNSAFE_PATH', 'Skill entrypoint is not a regular file');
            owned ||= Boolean(stat);
          }
        }
        if (owned) localSkillIds.push(slug);
      }
      return { profile, token: projection.sourceToken, enabledCount: projection.enabledCount, localSkillIds,
        mounts: projection.enabledCount ? [{ directory: projection.pluginRoot }] : [] };
    });
  }
  private ensureManifest(id: string) {
    // Same manifest bytes as upstream ensureLayout; never installs into a global catalog.
    return this.atomic(join(this.root(id), '.claude-plugin', 'plugin.json'), JSON.stringify({
      name: `cindy-bot-${id}`, description: 'Skills this Cindy Bot learned for itself.', version: '1.0.0',
    }, null, 2) + '\n');
  }
  private validate(input: CompanionSkillMutation): void {
    string(input.operationId, 'operationId', 200);
    if (!['save', 'source', 'enabled', 'delete'].includes(input.kind)) throwIpcError('INVALID_PARAMS', 'Invalid skill operation');
    if (input.expectedRevision !== null && (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision))) throwIpcError('INVALID_PARAMS', 'An exact skill revision is required');
    if (input.kind !== 'save') this.slug(input.slug);
    if (input.kind === 'save') {
      string(input.name, 'name', 256); string(input.description, 'description', 1120); string(input.body, 'body', BOT_SKILL_MAX_BODY_BYTES);
      if (input.slug !== undefined) this.slug(input.slug);
    }
    if (input.kind === 'source') {
      string(input.source, 'source', EDITOR_BYTES);
      if (Buffer.byteLength(parseBotSkillFile(input.source).body) > BOT_SKILL_MAX_BODY_BYTES) throwIpcError('SKILL_BODY_TOO_LARGE', 'Skill body exceeds the original 64 KiB limit');
    }
    if ((input.kind === 'enabled' || input.kind === 'delete') && input.expectedRevision === null) throwIpcError('INVALID_PARAMS', 'The existing skill revision is required');
    if (input.kind === 'enabled' && typeof input.enabled !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid skill enabled state');
  }
  private async render(id: string, input: Extract<CompanionSkillMutation, { kind: 'save' }>): Promise<{ slug: string; source: string }> {
    const staging = join(this.store.root, '.skill-staging', randomUUID());
    await this.store.safePath(staging);
    try {
      const saved = await saveBotSkill(staging, id, input);
      return { slug: saved.record.slug, source: await readFile(saved.record.filePath, 'utf8') };
    } catch (error) {
      if (error instanceof BotSkillStoreError) throwIpcError(error.errorCode, error.message);
      throw error;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  private async prepare(id: string, input: CompanionSkillMutation, fingerprint: string): Promise<Intent> {
    const rendered = input.kind === 'save' ? await this.render(id, input) : null;
    const slug = rendered?.slug ?? this.slug(input.slug);
    const current = await this.locate(id, slug);
    if ((current?.revision ?? null) !== input.expectedRevision) throwIpcError('PRECONDITION_FAILED', 'Skill changed since it was read');
    const source = rendered?.source ?? (input.kind === 'source' ? input.source : undefined);
    const enabled = input.kind === 'enabled' ? input.enabled : current?.enabled ?? true;
    if (input.kind !== 'save' && input.kind !== 'source' && !current) throwIpcError('NOT_FOUND', 'Skill not found');
    return { version: 1, botId: id, fingerprint, phase: 'prepared', operationId: input.operationId, slug, kind: input.kind,
      before: current ? { revision: current.revision, enabled: current.enabled, sourceHash: current.sourceHash } : null,
      after: input.kind === 'delete' ? null : { revision: source !== undefined ? revision(source, enabled) : revisionFromHash(current!.sourceHash, enabled), enabled, sourceHash: source !== undefined ? hash(source) : current!.sourceHash },
      ...(source !== undefined ? { source } : {}) };
  }
  private async loadIntent(path: string): Promise<Intent | null> {
    await this.store.safePath(path);
    try {
      const intent = JSON.parse(await readFile(path, 'utf8')) as Intent;
      if (intent.version !== 1 || !['prepared', 'completed'].includes(intent.phase)) throw new Error('Invalid skill operation receipt');
      return intent;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async apply(id: string, intent: Intent, path: string, authorize: () => Promise<void>): Promise<void> {
    let current = await this.locate(id, intent.slug);
    const stillCurrent = async (expected: Located | null) => {
      const observed = await this.locate(id, intent.slug);
      if ((observed?.revision ?? null) !== (expected?.revision ?? null) || observed?.file !== expected?.file)
        throwIpcError('PRECONDITION_FAILED', 'Skill changed during publication');
    };
    const trash = `${path}.deleted`;
    if (!intent.after) {
      if (current) {
        if (current.revision !== intent.before?.revision) throwIpcError('PRECONDITION_FAILED', 'Skill changed after deletion was prepared');
        await this.store.safePath(trash);
        if (await this.exists(trash)) throwIpcError('SKILL_OPERATION_UNKNOWN', 'Both the skill and its deletion receipt exist');
        await authorize(); await stillCurrent(current); await rename(current.dir, trash);
      } else {
        await this.directory(trash);
        if (!await this.exists(trash)) throwIpcError('SKILL_OPERATION_UNKNOWN', 'The prepared deletion cannot be verified');
        let sourceHash: string | undefined;
        for (const name of ['SKILL.md', 'skill.md']) {
          const file = join(trash, name); await this.store.safePath(file);
          if (await this.exists(file)) { sourceHash = (await this.digest(file, false)).sourceHash; break; }
        }
        if (sourceHash === undefined || sourceHash !== intent.before?.sourceHash) throwIpcError('SKILL_OPERATION_UNKNOWN', 'The deleted skill no longer matches its receipt');
      }
    } else if (current?.revision !== intent.after.revision) {
      const intermediate = current && intent.source !== undefined && current.sourceHash === intent.after.sourceHash && current.enabled === intent.before?.enabled;
      if ((current?.revision ?? null) !== (intent.before?.revision ?? null) && !intermediate)
        throwIpcError('PRECONDITION_FAILED', 'Skill changed after this save was prepared');
      if (intent.source !== undefined && hash(intent.source) !== intent.after.sourceHash) throwIpcError('SKILL_OPERATION_UNKNOWN', 'Saved skill bytes do not match their intent');
      const initialDir = current?.dir ?? join(this.root(id), intent.after.enabled ? 'skills' : 'disabled-skills', intent.slug);
      await this.directory(initialDir);
      if (!current && await this.exists(initialDir)) throwIpcError('SKILL_CONFLICT', 'A resource folder already uses this skill name');
      if (intent.source !== undefined && current?.sourceHash !== intent.after.sourceHash) {
        if (current) {
          const expected = current;
          await this.atomic(current.file, intent.source, async () => { await authorize(); await stillCurrent(expected); });
        }
        else {
          const staging = `${path}.created`; await this.directory(staging);
          await this.atomic(join(staging, 'SKILL.md'), intent.source);
          await mkdir(dirname(initialDir), { recursive: true, mode: 0o700 });
          await authorize(); await stillCurrent(null);
          if (await this.exists(initialDir)) throwIpcError('SKILL_CONFLICT', 'A resource folder now uses this skill name');
          await rename(staging, initialDir);
        }
      }
      current = await this.locate(id, intent.slug);
      if (current && current.enabled !== intent.after.enabled) {
        const target = join(this.root(id), intent.after.enabled ? 'skills' : 'disabled-skills', intent.slug);
        await this.directory(target);
        if (await this.exists(target)) throwIpcError('SKILL_CONFLICT', 'The destination skill shelf is occupied');
        await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await authorize(); await stillCurrent(current);
        if (await this.exists(target)) throwIpcError('SKILL_CONFLICT', 'The destination skill shelf is now occupied');
        await rename(current.dir, target);
      }
      if ((await this.locate(id, intent.slug))?.revision !== intent.after.revision) throwIpcError('SKILL_OPERATION_UNKNOWN', 'Saved skill bytes could not be verified');
    }
    invalidateBotSkillRuntime(this.root(id));
  }
  async mutate(id: string, input: CompanionSkillMutation, access?: SkillAccess): Promise<CompanionSkillReceipt> {
    botId(id); this.validate(input);
    // Explicit keys prevent alternate object insertion orders from changing retry identity.
    const fingerprint = hash(JSON.stringify(input.kind === 'save'
      ? [input.kind, input.slug ?? null, input.name, input.description, input.body, input.expectedRevision]
      : [input.kind, input.slug, input.kind === 'source' ? input.source : input.kind === 'enabled' ? input.enabled : null, input.expectedRevision]));
    const path = join(this.store.root, 'skill-operations', id, `${hash(input.operationId)}.json`);
    return this.store.transaction(async state => {
      this.owner(state, id);
      const authorize = async () => { this.owner(state, id); await access?.(state); };
      await authorize();
      let intent = await this.loadIntent(path);
      if (intent && (intent.botId !== id || intent.operationId !== input.operationId || intent.fingerprint !== fingerprint))
        throwIpcError('IDEMPOTENCY_CONFLICT', 'This operation ID belongs to a different skill change');
      if (intent?.phase === 'completed') {
        if (!intent.receipt) throwIpcError('SKILL_OPERATION_UNKNOWN', 'The skill receipt is incomplete');
        return intent.receipt;
      }
      if (!intent) { intent = await this.prepare(id, input, fingerprint); await authorize(); await this.atomic(path, JSON.stringify(intent)); }
      await this.apply(id, intent, path, authorize);
      if (input.kind !== 'delete') await this.ensureManifest(id);
      const receipt: CompanionSkillReceipt = { operationId: input.operationId, slug: intent.slug, kind: input.kind,
        revision: intent.after?.revision ?? null, enabled: intent.after?.enabled ?? null,
        runtime: { status: 'pending', reason: 'native-loading-unverified' } };
      const completed = { ...intent, phase: 'completed' as const, receipt }; delete completed.source;
      await this.atomic(path, JSON.stringify(completed));
      // The confirmed delete stays durable even if disposal of its private trash fails.
      if (input.kind === 'delete') await rm(`${path}.deleted`, { recursive: true, force: true }).catch(() => {});
      return receipt;
    });
  }
}
