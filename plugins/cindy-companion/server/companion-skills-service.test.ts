import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CompanionStore } from './store';
import { CompanionService } from './service';
import { CompanionMcpServer } from './mcp';
import { registerSessionTools } from './session-tools';
import type { Paseo } from './runtime';
import type { SessionScope } from '../shared/session-scope';
import type { RuntimeState } from '../shared/contracts';

const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposals.splice(0).reverse()) await dispose(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cindy-skills-service-')); disposals.push(() => rm(root, { recursive: true, force: true }));
  const store = new CompanionStore(root); await store.load(); const profile = await store.get('cindy');
  const scope: SessionScope = { agentId: 'owned-agent', role: 'canonical' }, cwd = join(profile.homeDir, 'workspace');
  await store.transaction(state => {
    state.bindings.cindy = { agentId: scope.agentId, operationId: 'owned', phase: 'ready', profileVersion: 1, appliedVersion: 1,
      appliedCapabilities: profile.capabilities, cwd, title: 'Cindy', config: {}, workspaceId: 'owned-workspace', sessionScope: scope };
  });
  const native = { refresh: vi.fn(async () => ({})), archivedAt: null as string | null, cwd, workspaceId: 'owned-workspace' };
  const paseo = { agents: { ref: () => native } } as unknown as Paseo;
  const service = new CompanionService(store, { paseoForTools: async () => paseo }); disposals.push(() => service.close());
  const server = new CompanionMcpServer({ root, safePath: path => store.safePath(path), readProfile: id => store.get(id),
    invokeMemory: (id, op, args) => service.invokeMemoryTool(id, op, args),
    validateScope: (id, s) => service.validateSessionScope(id, s), invokeSession: (id, s, op, args) => service.invokeSessionTool(id, s, op, args), registerSessionTools });
  disposals.push(() => server.close());
  const connect = async (s?: SessionScope) => {
    const config = await server.configFor('cindy', s);
    const client = new Client({ name: 'skills-fixture', version: '1' }); disposals.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    return { client, config };
  };
  return { root, store, scope, cwd, native, paseo, service, server, connect };
}
const toolSave = { name: 'Review evidence', description: 'Use when reviewing evidence', body: 'Read the cited original and preserve uncertainty.',
  slug: 'review-evidence', expected_revision: null, idempotency_key: 'learn-once' };
const uiSave = { botId: 'cindy', name: toolSave.name, description: toolSave.description, body: toolSave.body,
  slug: toolSave.slug, expectedRevision: null, operationId: 'ui-once' };
function payload(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find(item => item.type === 'text')!.text!);
}
test('real HTTP skills share the Settings store and preserve operation identity across retries', async () => {
  const f = await fixture(), { client } = await f.connect(f.scope);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  expect(names).toEqual(expect.arrayContaining(['save_teammate_skill', 'list_teammate_skills', 'read_teammate_skill', 'save_bot_skill', 'list_bot_skills']));
  const saved = await client.callTool({ name: 'save_teammate_skill', arguments: { ...toolSave, botId: 'foreign', callerSessionId: 'forged' } });
  expect(saved.isError).toBe(false); const receipt = payload(saved);
  expect(receipt.runtime.status).toBe('pending');
  const read = await f.service.invoke({ op: 'skills.read', args: { botId: 'cindy', slug: toolSave.slug } }, f.paseo);
  expect(read).toMatchObject({ ok: true, value: { body: toolSave.body, revision: receipt.revision } });
  const replay = await client.callTool({ name: 'save_bot_skill', arguments: toolSave });
  const { application: firstApplication, ...firstReceipt } = receipt;
  const { application: replayApplication, ...replayReceipt } = payload(replay);
  expect(firstApplication).toBeDefined(); expect(replayApplication).toBeDefined();
  expect(replayReceipt).toEqual(firstReceipt);
  const changed = await client.callTool({ name: 'save_teammate_skill', arguments: { ...toolSave, body: 'different immutable payload' } });
  expect(changed.isError).toBe(true); expect(payload(changed).code).toBe('IDEMPOTENCY_CONFLICT');
  const listed = payload(await client.callTool({ name: 'list_bot_skills', arguments: { query: 'evidence' } }));
  expect(listed).toMatchObject({ total: 1, skills: [{ slug: toolSave.slug }] });
  expect(listed.skills[0].filePath).toBe(join(f.root, 'bots/cindy/skills/review-evidence/SKILL.md'));
});
test('native refresh runs after durable save and outside its lock, while replay applies the latest library', async () => {
  const f = await fixture(), seen: string[] = [];
  const refresh = vi.spyOn(f.service.runtime, 'applyProfile').mockImplementation(async (_paseo, id) => {
    // Both calls acquire the store serialization boundary; this would deadlock inside mutate.
    const doc = await f.service.skills.read(id, toolSave.slug);
    const state = await f.store.snapshot(); expect(state.profiles[id]).toBeDefined();
    expect(doc).not.toBeNull(); seen.push(doc!.body);
    return { ...await f.service.runtime.state(id), state: 'pending', code: 'AGENT_BUSY' };
  });
  const first = await f.service.invoke({ op: 'skills.save', args: uiSave }, f.paseo);
  expect(first).toMatchObject({ ok: true, value: { application: { state: 'pending', code: 'AGENT_BUSY' } } });
  const changed = { ...uiSave, operationId: 'later-save', body: 'Later saved instructions.', expectedRevision: (first as any).value.revision };
  expect(await f.service.invoke({ op: 'skills.save', args: changed }, f.paseo)).toMatchObject({ ok: true });
  const replay = await f.service.invoke({ op: 'skills.save', args: uiSave }, f.paseo);
  expect(replay).toMatchObject({ ok: true, value: { revision: (first as any).value.revision } });
  expect(seen).toEqual([uiSave.body, changed.body, changed.body]); expect(refresh).toHaveBeenCalledTimes(3);
  expect((await f.service.skills.nativeSnapshot('cindy')).enabledCount).toBe(1);
});
test('a failed native refresh cannot erase the HTTP save receipt and a retry may report a new application state', async () => {
  const f = await fixture(), { client } = await f.connect(f.scope);
  const refresh = vi.spyOn(f.service.runtime, 'applyProfile').mockRejectedValueOnce(new Error('Native acknowledgement lost'));
  const saved = payload(await client.callTool({ name: 'save_teammate_skill', arguments: toolSave }));
  expect(saved).toMatchObject({ operationId: toolSave.idempotency_key, runtime: { status: 'pending' },
    application: { state: 'pending', code: 'NATIVE_SKILLS_APPLY_FAILED' } });
  expect((await f.service.skills.read('cindy', toolSave.slug))?.body).toBe(toolSave.body);
  const next = { ...await f.service.runtime.state('cindy'), state: 'pending', code: 'AGENT_BUSY' } as RuntimeState;
  refresh.mockResolvedValueOnce(next);
  const replay = payload(await client.callTool({ name: 'save_teammate_skill', arguments: toolSave }));
  const { application: _first, ...receipt } = saved, { application: applicationNow, ...replayed } = replay;
  expect(replayed).toEqual(receipt); expect(applicationNow).toEqual(next);
});
test('legacy memory credentials cannot obtain skill tools and cannot impersonate a scoped credential', async () => {
  const f = await fixture(), legacy = await f.connect(), scoped = await f.connect(f.scope);
  expect((await legacy.client.listTools()).tools.some(tool => /teammate_skill|bot_skill/.test(tool.name))).toBe(false);
  const attempted = await legacy.client.callTool({ name: 'save_teammate_skill', arguments: toolSave });
  expect(attempted.isError).toBe(true);
  const res = await fetch(scoped.config.url, { method: 'POST', headers: { ...legacy.config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  expect(res.status).toBe(401);
  expect(await f.service.skills.read('cindy', toolSave.slug)).toBeNull();
});
test('disabling Memory does not disable personal skills; native archival and persisted pause revoke scope', async () => {
  const f = await fixture(); await f.store.update('cindy', { capabilities: { memory: false } });
  const { client } = await f.connect(f.scope);
  expect((await client.callTool({ name: 'save_teammate_skill', arguments: toolSave })).isError).toBe(false);
  expect((await client.callTool({ name: 'memory_list', arguments: {} })).isError).toBe(true);
  f.native.archivedAt = 'archived';
  await expect(client.callTool({ name: 'list_teammate_skills', arguments: {} })).rejects.toThrow();
  f.native.archivedAt = null;
  // Pause is an authority state fixture; public profile.update deliberately cannot set lifecycle fields.
  await f.store.transaction(state => { state.profiles.cindy!.enabled = false; });
  await expect(client.callTool({ name: 'read_teammate_skill', arguments: { slug: toolSave.slug } })).rejects.toThrow();
});
test('group scopes can read their own skills but cannot write or claim another companion', async () => {
  const f = await fixture();
  expect(await f.service.invoke({ op: 'skills.save', args: uiSave }, f.paseo)).toMatchObject({ ok: true });
  const scope: SessionScope = { agentId: 'group-lane', role: 'group', groupId: 'group' };
  await f.store.transaction(state => {
    state.groups = { group: { id: 'group', name: 'G', description: '', botIds: ['cindy'], replyMode: 'all', revision: 1, createdAt: 1, updatedAt: 1,
      messages: [], rounds: [], receipts: {}, continueKeys: {}, lanes: { lane: { agentId: scope.agentId, botId: 'cindy', groupId: 'group', roundId: 'round',
        operationId: 'lane', cwd: f.cwd, title: 'Cindy', phase: 'ready', config: {}, sessionScope: scope } } } };
  });
  const { client } = await f.connect(scope);
  const legacyFile = join(f.root, 'bots/cindy/skills/legacy/SKILL.md'), legacy = '---\nname: Legacy\ndescription: desc\nupdatedAt: old\n---\nOriginal';
  await mkdir(join(legacyFile, '..'), { recursive: true }); await writeFile(legacyFile, legacy);
  expect(payload(await client.callTool({ name: 'list_teammate_skills', arguments: {} })).total).toBe(2);
  expect(await readFile(legacyFile, 'utf8')).toBe(legacy);
  expect(payload(await client.callTool({ name: 'save_teammate_skill', arguments: toolSave })).code).toBe('BOT_SESSION_READ_ONLY');
  await f.store.transaction(state => { state.groups!.group!.botIds = []; });
  await expect(client.callTool({ name: 'list_teammate_skills', arguments: {} })).rejects.toThrow();
  expect(await f.service.invokeSessionTool('foreign', f.scope, 'list_teammate_skills', {})).toMatchObject({ ok: false, code: 'SESSION_SCOPE_REVOKED' });
});
test('revocation during preparation is checked again before any skill bytes are published', async () => {
  const f = await fixture();
  const target = f.service.skills as unknown as { prepare(...args: unknown[]): Promise<unknown> }, original = target.prepare.bind(target);
  vi.spyOn(target, 'prepare').mockImplementation(async (...args) => { const result = await original(...args); f.native.archivedAt = 'archived'; return result; });
  expect(await f.service.invokeSessionTool('cindy', f.scope, 'save_teammate_skill', toolSave)).toMatchObject({ ok: false, code: 'SESSION_SCOPE_REVOKED' });
  expect(await f.service.skills.read('cindy', toolSave.slug)).toBeNull();
});
test('revocation during a real HTTP catalog read prevents returning names and native paths', async () => {
  const f = await fixture(); await f.service.skills.mutate('cindy', { ...uiSave, kind: 'save' });
  const { client } = await f.connect(f.scope);
  const target = f.service.skills as unknown as { scanPaths(id: string): Promise<void> }, scan = target.scanPaths.bind(target);
  vi.spyOn(target, 'scanPaths').mockImplementation(async id => { await scan(id); f.native.archivedAt = 'archived'; });
  const result = payload(await client.callTool({ name: 'list_teammate_skills', arguments: {} }));
  expect(result).toMatchObject({ code: 'SESSION_SCOPE_REVOKED' });
  expect(result).not.toHaveProperty('skills'); expect(result).not.toHaveProperty('value');
});
test('an admitted skill mutation drains before service cleanup and late calls are rejected', async () => {
  const f = await fixture(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const target = f.service.skills as unknown as { apply(...args: unknown[]): Promise<void> }, original = target.apply.bind(target);
  vi.spyOn(target, 'apply').mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
  const saving = f.service.invoke({ op: 'skills.save', args: uiSave }, f.paseo); await started;
  let closed = false; const close = f.service.close().then(() => { closed = true; }); await Promise.resolve();
  expect(closed).toBe(false);
  expect(await f.service.invoke({ op: 'skills.list', args: { botId: 'cindy' } }, f.paseo)).toMatchObject({ ok: false, code: 'PLUGIN_CLOSED' });
  release(); expect(await saving).toMatchObject({ ok: true }); await close;
  expect(await readFile(join(f.root, 'bots/cindy/skills/review-evidence/SKILL.md'), 'utf8')).toContain(toolSave.body);
});
test('large skills can be disabled and deleted through public metadata RPC without returning the full source', async () => {
  const f = await fixture(), file = join(f.root, 'bots/cindy/skills/large/SKILL.md');
  const source = `---\nname: large\ndescription: ${'a'.repeat(1024 * 1024)}\n---\nInstructions\n`;
  await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, source);
  expect(await f.service.invoke({ op: 'skills.read', args: { botId: 'cindy', slug: 'large' } }, f.paseo)).toMatchObject({ ok: false, code: 'SKILL_EDITOR_TOO_LARGE' });
  const metadata = await f.service.invoke({ op: 'skills.inspect', args: { botId: 'cindy', slug: 'large' } }, f.paseo);
  expect(metadata).toMatchObject({ ok: true, value: { editable: false, bytes: Buffer.byteLength(source) } });
  expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThan(1024);
  const disabled = await f.service.invoke({ op: 'skills.enabled', args: { botId: 'cindy', slug: 'large', operationId: 'disable-large', enabled: false, expectedRevision: (metadata as any).value.revision } }, f.paseo);
  expect(disabled).toMatchObject({ ok: true, value: { enabled: false } });
  expect(await readFile(join(f.root, 'bots/cindy/disabled-skills/large/SKILL.md'), 'utf8')).toBe(source);
  expect(await f.service.invoke({ op: 'skills.delete', args: { botId: 'cindy', slug: 'large', operationId: 'delete-large', expectedRevision: (disabled as any).value.revision } }, f.paseo)).toMatchObject({ ok: true });
});
test('Capabilities returns the real bounded personal shelf before native creation and through provider catalog failures', async () => {
  const f = await fixture();
  for (let i = 0; i < 55; i++) {
    const folder = join(f.root, 'bots/cindy/skills', `skill-${String(i).padStart(2, '0')}`);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'SKILL.md'), `---\nname: Skill ${String(i).padStart(2, '0')}\ndescription: Fixture\n---\nInstructions ${i}`);
  }
  const before = await f.service.invoke({ op: 'capabilities.catalog', args: { botId: 'cindy' } }, f.paseo);
  expect(before).toMatchObject({ ok: true, value: { personalPage: { total: 55, nextOffset: 50 }, personalRuntime: { status: 'pending' }, state: 'not-created' } });
  const first = (before as any).value.personal;
  expect(first).toHaveLength(50); expect(first[0]).not.toHaveProperty('filePath');
  const next = await f.service.invoke({ op: 'skills.list', args: { botId: 'cindy', offset: 50, limit: 50 } }, f.paseo);
  expect(next).toMatchObject({ ok: true, value: { total: 55, skills: expect.arrayContaining([expect.objectContaining({ slug: 'skill-54' })]) } });
  await f.store.transaction(state => { state.profiles.cindy!.canonicalSessionId = f.scope.agentId; });
  const commands = vi.fn().mockResolvedValueOnce({ commands: [], error: 'Native catalog offline' }).mockRejectedValueOnce(new Error('Transport offline'));
  Object.assign(f.native, { commands });
  for (const message of ['Native catalog offline', 'Transport offline']) {
    const result = await f.service.invoke({ op: 'capabilities.catalog', args: { botId: 'cindy' } }, f.paseo);
    expect(result).toMatchObject({ ok: true, value: { personal: first, personalPage: { total: 55, nextOffset: 50 }, providerError: { code: 'CAPABILITY_CATALOG_UNAVAILABLE', message } } });
  }
  expect(await f.service.invoke({ op: 'skills.save', args: uiSave }, f.paseo)).toMatchObject({ ok: true });
  expect(await f.service.invoke({ op: 'skills.list', args: { botId: 'cindy', offset: 50, expectedRevision: (before as any).value.personalPage.revision } }, f.paseo))
    .toMatchObject({ ok: false, code: 'SKILL_CATALOG_CHANGED' });
});
