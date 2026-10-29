import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionStore } from './store';
import { CompanionService } from './service';
import type { Paseo } from './runtime';

const dirs: string[] = []; const services: CompanionService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cindy-companion-test-')); dirs.push(root);
  const store = new CompanionStore(root); const service = new CompanionService(store); services.push(service);
  return { root, store, service };
}
function fakePaseo() {
  const snapshots = new Map<string, Record<string, unknown>>();
  const send = vi.fn(async () => {});
  const archive = vi.fn(async (id: string) => { snapshots.get(id)!.archivedAt = new Date().toISOString(); });
  const ref = (id: string) => ({ id,
    get workspaceId() { return snapshots.has(id) ? 'wks_0123456789abcdef' : null; },
    get archivedAt() { return snapshots.get(id)?.archivedAt ?? null; },
    get activeTurn() { return snapshots.get(id)?.activeTurn ?? null; },
    get status() { return snapshots.get(id)?.status ?? null; },
    current: () => snapshots.get(id) ?? null,
    refresh: vi.fn(async () => snapshots.has(id) ? { agent: snapshots.get(id) } : null),
    send, archive: () => archive(id), commands: async () => ({ commands: [{ name: 'review', description: 'Review changes', kind: 'command' }, { name: 'local-skill', description: 'Provider skill', kind: 'skill' }], error: null }),
    timeline: { refetch: vi.fn(async () => ({ entries: [{ seqStart: 1, seqEnd: 1, timestamp: '2026-10-28T00:00:00Z', item: { type: 'assistant_message', text: 'Remember the blue project' } }], error: null, hasOlder: true, hasNewer: false })) },
  });
  const create = vi.fn(async (input: { agentId: string; config: { provider: string } }) => {
    const [provider, model] = input.config.provider.split('/');
    snapshots.set(input.agentId, { id: input.agentId, provider, model, status: 'idle', workspaceId: 'wks_0123456789abcdef' }); return ref(input.agentId);
  });
  const paseo = { agents: { ref, create }, providers: { waitForReady: vi.fn(async () => ({ entries: [{ provider: 'codex', status: 'ready', models: [{ id: 'model-a', isDefault: true }] }] })) } } as unknown as Paseo;
  return { paseo, snapshots, create, send, archive };
}
const unwrap = <T = Record<string, unknown>>(result: Awaited<ReturnType<CompanionService['invoke']>>) => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`); return result.value as T;
};

describe('durable companion profiles', () => {
  it('creates Cindy once and preserves SOUL, USER and version history across reopen', async () => {
    const { root, store } = await setup();
    expect((await store.list()).map(p => p.id)).toEqual(['cindy']);
    expect((await store.get('cindy')).avatar).toBe('cindy://avatar/preset/cindy');
    const updated = await store.update('cindy', { identitySource: 'Be direct', userContextSource: 'I prefer tea' }, 1);
    expect(updated.currentVersion).toBe(2);
    const again = new CompanionStore(root); expect((await again.get('cindy')).identitySource).toBe('Be direct');
    expect(await readFile(join(root, 'bots/cindy/SOUL.md'), 'utf8')).toBe('Be direct');
    expect(await readFile(join(root, 'bots/cindy/memories/USER.md'), 'utf8')).toBe('I prefer tea');
    expect((await again.snapshot()).versions.cindy).toHaveLength(2);
  });
  it('rejects stale edits and equivalent normalized names', async () => {
    const { store } = await setup(); await store.update('cindy', { description: 'First' }, 1);
    await expect(store.update('cindy', { description: 'Stale' }, 1)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(store.create({ name: 'ＣＩＮＤＹ' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.get('cindy')).description).toBe('First');
  });
  it('serializes concurrent changes and mirrors the newest durable snapshot', async () => {
    const { root, store } = await setup();
    await Promise.all([store.update('cindy', { identitySource: 'older' }), store.update('cindy', { identitySource: 'newer' })]);
    expect((await store.get('cindy')).identitySource).toBe('newer');
    expect(await readFile(join(root, 'bots/cindy/SOUL.md'), 'utf8')).toBe('newer');
  });
  it('preserves concurrent additions using upstream capability baselines', async () => {
    const { store } = await setup(); await store.update('cindy', { skills: ['remote'] });
    expect((await store.update('cindy', { skills: ['local'], capabilityBaseline: { skills: [] } })).skills).toEqual(['remote', 'local']);
  });
  it('deduplicates companion creation by durable operation key', async () => {
    const { root, store } = await setup(); const a = await store.create({ name: 'Alex', operationId: 'request-1' });
    const b = await new CompanionStore(root).create({ name: 'Alex', operationId: 'request-1' });
    expect(b.id).toBe(a.id); expect(await new CompanionStore(root).list()).toHaveLength(2);
    await expect(new CompanionStore(root).create({ name: 'Different', operationId: 'request-1' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('ingests hand-edited SOUL and USER as a new version without accepting permission changes', async () => {
    const { root, store } = await setup(); await store.load();
    await writeFile(join(root, 'bots/cindy/SOUL.md'), 'A hand-edited personality');
    await writeFile(join(root, 'bots/cindy/memories/USER.md'), 'New user preferences');
    await writeFile(join(root, 'bots/cindy/config.json'), '{"permissions":"trusted"}');
    const reopened = new CompanionStore(root); const p = await reopened.get('cindy');
    expect(p).toMatchObject({ identitySource: 'A hand-edited personality', userContextSource: 'New user preferences', currentVersion: 2 });
    expect(p.capabilities.permissions).toBe('ask');
  });
  it('repairs only a recorded interrupted mirror write instead of importing stale files', async () => {
    const { root, store } = await setup(); await store.load();
    await store.transaction(state => { state.profiles.cindy!.identitySource = 'Durable newer identity'; state.folderPending = ['cindy']; });
    const reopened = new CompanionStore(root); expect((await reopened.get('cindy')).identitySource).toBe('Durable newer identity');
    expect(await readFile(join(root, 'bots/cindy/SOUL.md'), 'utf8')).toBe('Durable newer identity');
    expect((await reopened.snapshot()).folderPending).toEqual([]);
  });
  it('rejects path traversal, symlink homes and permission escalation', async () => {
    const { root, store } = await setup(); await store.load();
    await expect(store.get('../escape')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(store.update('cindy', { capabilities: { permissions: 'trusted' } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await rm(join(root, 'bots/cindy/memories'), { recursive: true }); await symlink(tmpdir(), join(root, 'bots/cindy/memories'));
    await expect(store.update('cindy', { userContextSource: 'should not escape' })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });
});
describe('native canonical binding and truthful settings', () => {
  it('commits stable intent before one idempotent native create and restores workspace binding', async () => {
    const { root, store, service } = await setup(); const host = fakePaseo();
    const original = host.create.getMockImplementation()!;
    host.create.mockImplementation(async input => {
      const saved = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
      expect(saved.bindings.cindy.agentId).toBe(input.agentId);
      return original(input);
    });
    const [a, b] = await Promise.all([service.runtime.ensure(host.paseo, 'cindy'), service.runtime.ensure(host.paseo, 'cindy')]);
    expect(a.agentId).toBe(b.agentId); expect(host.create).toHaveBeenCalledTimes(1);
    expect(host.create.mock.calls[0]![0]).toMatchObject({ idempotencyKey: expect.stringContaining('cindy-companion:cindy:') });
    expect((await store.get('cindy')).canonicalWorkspaceId).toBe('wks_0123456789abcdef');
    const reopened = new CompanionService(new CompanionStore(root)); services.push(reopened);
    expect((await reopened.runtime.ensure(host.paseo, 'cindy')).agentId).toBe(a.agentId); expect(host.create).toHaveBeenCalledTimes(1);
  });
  it('recovers an ambiguous create from its native ID without a duplicate', async () => {
    const { root, service } = await setup(); const host = fakePaseo(); const original = host.create.getMockImplementation()!;
    host.create.mockImplementation(async input => { await original(input); throw new Error('connection lost after creation'); });
    await expect(service.runtime.ensure(host.paseo, 'cindy')).rejects.toThrow('connection lost');
    expect((await service.runtime.state('cindy')).state).toBe('unknown');
    const reopened = new CompanionService(new CompanionStore(root)); services.push(reopened);
    expect((await reopened.runtime.ensure(host.paseo, 'cindy')).runtime.state).toBe('ready'); expect(host.create).toHaveBeenCalledTimes(1);
  });
  it('never silently replaces a missing canonical agent', async () => {
    const { service } = await setup(); const host = fakePaseo(); await service.runtime.ensure(host.paseo, 'cindy'); host.snapshots.clear();
    await expect(service.runtime.ensure(host.paseo, 'cindy')).rejects.toMatchObject({ code: 'CANONICAL_MISSING' }); expect(host.create).toHaveBeenCalledTimes(1);
  });
  it('reports a failed tool endpoint instead of claiming an existing companion is ready', async () => {
    const { service } = await setup(); const host = fakePaseo(); await service.runtime.ensure(host.paseo, 'cindy');
    service.runtime.setMcpFactory(async () => { throw new Error('temporary port conflict'); });
    expect(await service.runtime.refreshState(host.paseo, 'cindy')).toMatchObject({ state: 'error', code: 'TOOL_ENDPOINT_UNAVAILABLE' });
    await expect(service.runtime.ensure(host.paseo, 'cindy')).rejects.toMatchObject({ code: 'TOOL_ENDPOINT_UNAVAILABLE' });
    expect(host.create).toHaveBeenCalledTimes(1);
  });
  it('stores new instructions and reports pending rather than claiming live application', async () => {
    const { service } = await setup(); const host = fakePaseo(); await service.runtime.ensure(host.paseo, 'cindy');
    const result = unwrap<{ runtime: { state: string; appliedVersion: number; desiredVersion: number } }>(await service.invoke({ op: 'profile.update', args: { botId: 'cindy', patch: { identitySource: 'New identity' } } }, host.paseo));
    expect(result.runtime).toMatchObject({ state: 'pending', desiredVersion: 2, appliedVersion: 1 });
  });
  it('preserves model choice while reporting absent public update API', async () => {
    const { service, store } = await setup(); const host = fakePaseo(); await service.runtime.ensure(host.paseo, 'cindy');
    const route = { harness: 'codex', providerId: 'codex', model: 'model-b', effort: '', fastMode: false };
    const result = unwrap<{ runtime: { code: string } }>(await service.invoke({ op: 'profile.update', args: { botId: 'cindy', patch: { capabilities: { modelChainOverride: [route] } } } }, host.paseo));
    expect(result.runtime.code).toBe('HOST_UPGRADE_REQUIRED'); expect((await store.get('cindy')).capabilities.modelChainOverride?.[0]?.model).toBe('model-b');
  });
  it('clears explicit thinking effort and confirms the host before recording default as applied', async () => {
    const { service, store } = await setup(); const host = fakePaseo();
    const route = { harness: 'codex', providerId: 'codex', model: 'model-a', effort: 'high', fastMode: false };
    await store.update('cindy', { capabilities: { modelChainOverride: [route] } });
    const { agentId } = await service.runtime.ensure(host.paseo, 'cindy');
    Object.assign(host.snapshots.get(agentId)!, { thinkingOptionId: 'high', effectiveThinkingOptionId: 'high' });
    const originalRef = host.paseo.agents.ref;
    const setThinkingOption = vi.fn(async (id: string | null) => { Object.assign(host.snapshots.get(agentId)!, { thinkingOptionId: id, effectiveThinkingOptionId: id }); });
    host.paseo.agents.ref = ((id: string) => ({ ...originalRef(id), setModel: vi.fn(async () => {}), setThinkingOption })) as typeof originalRef;
    await store.update('cindy', { capabilities: { modelChainOverride: [{ ...route, effort: '' }] } });
    expect(await service.runtime.applyModel(host.paseo, 'cindy')).toMatchObject({ state: 'ready', appliedModel: { effort: '' } });
    expect(setThinkingOption).toHaveBeenCalledWith(null);
    expect((await store.snapshot()).bindings.cindy!.appliedProfile!.capabilities.modelChainOverride![0]!.effort).toBe('');
  });
  it('keeps desired effort pending when a host ignores resetting it to default', async () => {
    const { service, store } = await setup(); const host = fakePaseo();
    const route = { harness: 'codex', providerId: 'codex', model: 'model-a', effort: 'high', fastMode: false };
    await store.update('cindy', { capabilities: { modelChainOverride: [route] } });
    const { agentId } = await service.runtime.ensure(host.paseo, 'cindy');
    Object.assign(host.snapshots.get(agentId)!, { thinkingOptionId: 'high', effectiveThinkingOptionId: 'high' });
    const originalRef = host.paseo.agents.ref;
    host.paseo.agents.ref = ((id: string) => ({ ...originalRef(id), setModel: vi.fn(async () => {}), setThinkingOption: vi.fn(async () => {}) })) as typeof originalRef;
    await store.update('cindy', { capabilities: { modelChainOverride: [{ ...route, effort: '' }] } });
    await expect(service.runtime.applyModel(host.paseo, 'cindy')).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIRMED' });
    expect((await store.snapshot()).bindings.cindy!.appliedProfile!.capabilities.modelChainOverride![0]!.effort).toBe('high');
  });
  it('archives a non-default companion before removing it while preserving files and history', async () => {
    const { service, store, root } = await setup(); const host = fakePaseo(); const profile = await store.create({ name: 'Disposable' });
    const { agentId } = await service.runtime.ensure(host.paseo, profile.id);
    const args = { botId: profile.id, action: 'delete', confirmName: profile.name, keepTaskHistory: true, worktreeDisposition: 'retain' };
    expect(unwrap(await service.invoke({ op: 'lifecycle.run', args }, host.paseo))).toMatchObject({ deleted: true, keepTaskHistory: true });
    expect(host.archive).toHaveBeenCalledWith(agentId); expect(host.snapshots.get(agentId)!.archivedAt).toBeTruthy();
    expect((await store.list()).map(profile => profile.id)).toEqual(['cindy']);
    const reopened = await new CompanionStore(root).snapshot();
    expect(reopened.deletedProfiles![profile.id]!.profile.sessions[0]!.id).toBe(agentId);
    expect(reopened.deletedProfiles![profile.id]!.versions.length).toBeGreaterThan(0);
    expect(await readFile(join(profile.homeDir, 'SOUL.md'), 'utf8')).toBe(profile.identitySource);
  });
  it('preserves the companion on a busy or failed archive and refuses deleting default Cindy', async () => {
    const { service, store } = await setup(); const host = fakePaseo(); const profile = await store.create({ name: 'Disposable' });
    const { agentId } = await service.runtime.ensure(host.paseo, profile.id);
    const args = { botId: profile.id, action: 'delete', confirmName: profile.name, keepTaskHistory: true };
    host.snapshots.get(agentId)!.status = 'running';
    expect(await service.invoke({ op: 'lifecycle.run', args }, host.paseo)).toMatchObject({ ok: false, code: 'AGENT_BUSY' });
    expect(host.archive).not.toHaveBeenCalled();
    host.snapshots.get(agentId)!.status = 'idle'; host.archive.mockRejectedValueOnce(new Error('archive unavailable'));
    expect(await service.invoke({ op: 'lifecycle.run', args }, host.paseo)).toMatchObject({ ok: false });
    expect(await store.get(profile.id)).toMatchObject({ id: profile.id });
    expect(await service.invoke({ op: 'lifecycle.run', args: { ...args, botId: 'cindy', confirmName: 'Cindy' } }, host.paseo)).toMatchObject({ ok: false, code: 'DEFAULT_COMPANION' });
  });
  it('searches actual timeline text and honestly reports its bounded history window', async () => {
    const { service } = await setup(); const host = fakePaseo(); await service.runtime.ensure(host.paseo, 'cindy');
    const result = unwrap<{ results: unknown[]; poolCapped: boolean }>(await service.invoke({ op: 'history.search', args: { botId: 'cindy', query: 'blue' } }, host.paseo));
    expect(result.results).toHaveLength(1); expect(result.poolCapped).toBe(true);
  });
  it('reports only verified provider skills and never presents their selection as applied', async () => {
    const { service } = await setup(); const host = fakePaseo(); await service.runtime.ensure(host.paseo, 'cindy');
    const result = unwrap<{ configurable: boolean; entries: { skill: Array<{ id: string; available: boolean }> } }>(await service.invoke({ op: 'capabilities.catalog', args: { botId: 'cindy' } }, host.paseo));
    expect(result.configurable).toBe(false); expect(result.entries.skill).toEqual([expect.objectContaining({ id: 'local-skill', available: false })]);
    const changed = unwrap<{ runtime: { code: string; state: string } }>(await service.invoke({ op: 'profile.update', args: { botId: 'cindy', patch: { skills: ['local-skill'] } } }, host.paseo));
    expect(changed.runtime).toMatchObject({ code: 'CAPABILITY_NOT_APPLIED', state: 'pending' });
  });
  it('refuses unavailable operations and never calls a real daemon or CLI', async () => {
    const { service } = await setup(); const host = fakePaseo();
    expect(await service.invoke({ op: 'voice.models', args: {} }, host.paseo)).toMatchObject({ ok: false, code: 'UNSUPPORTED' }); expect(host.create).not.toHaveBeenCalled();
  });
});
describe('upstream memory storage and service', () => {
  it('stops admission and drains accepted memory writes before plugin cleanup returns', async () => {
    const { service, store, root } = await setup(); const host = fakePaseo(); await store.load();
    let begin!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    const original = store.get.bind(store); let first = true;
    vi.spyOn(store, 'get').mockImplementation(async id => { if (first) { first = false; begin(); await gate; } return original(id); });
    const write = service.invokeMemoryTool('cindy', 'memory.create', { type: 'user', name: 'accepted', title: 'Accepted', body: 'Saved before closing' });
    await started;
    let closed = false; const closing = service.close().then(() => { closed = true; });
    expect(await service.invoke({ op: 'caps', args: {} }, host.paseo)).toMatchObject({ ok: false, code: 'PLUGIN_CLOSED' });
    expect(await service.invokeMemoryTool('cindy', 'memory.list', {})).toMatchObject({ ok: false, code: 'PLUGIN_CLOSED' });
    expect(closed).toBe(false); release();
    expect(await write).toMatchObject({ ok: true }); await closing; expect(closed).toBe(true);
    expect(await readFile(join(root, 'bots/cindy/memories/user_accepted.md'), 'utf8')).toContain('Saved before closing');
  });
  it('writes original shards/index and protects concurrent agent edits with updatedAt', async () => {
    const { root, service } = await setup(); const host = fakePaseo();
    const created = unwrap<{ filename: string; updatedAt: string }>(await service.invoke({ op: 'memory.create', args: { botId: 'cindy', type: 'user', name: 'tea', title: 'Tea', body: 'I like tea' } }, host.paseo));
    expect(created.filename).toBe('user_tea.md');
    expect(await readFile(join(root, 'bots/cindy/memories/MEMORY.md'), 'utf8')).toContain('user_tea.md');
    const updated = await service.memory.update({ botId: 'cindy', filename: created.filename, expectedUpdatedAt: created.updatedAt, title: 'Tea', body: 'I like green tea' });
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    await expect(service.memory.delete({ botId: 'cindy', filename: created.filename, expectedUpdatedAt: created.updatedAt })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await service.memory.list('cindy', 'green'))).toHaveLength(1);
    await service.memory.delete({ botId: 'cindy', filename: created.filename, expectedUpdatedAt: updated.updatedAt });
    expect(await service.memory.list('cindy')).toEqual([]);
  });
  it('rejects traversal and symlink shards without modifying their targets', async () => {
    const { root, service, store } = await setup(); await store.load();
    await expect(service.memory.read('cindy', '../USER.md')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const outside = join(root, 'outside.md'); await writeFile(outside, 'untouched');
    await symlink(outside, join(root, 'bots/cindy/memories/user_escape.md'));
    await expect(service.memory.read('cindy', 'user_escape.md')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readFile(outside, 'utf8')).toBe('untouched');
  });
});
