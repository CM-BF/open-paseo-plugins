import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CompanionService } from './service';
import { CompanionStore } from './store';
import { CompanionMcpServer } from './mcp';
import { registerSessionTools } from './session-tools';
import type { Paseo } from './runtime';
import type { SessionScope } from '../shared/session-scope';

const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cindy-project-http-')); disposals.push(() => rm(root, { recursive: true, force: true }));
  const store = new CompanionStore(join(root, 'data')); await store.load();
  const profile = await store.get('cindy'), cwd = join(profile.homeDir, 'workspace'), projectDir = join(root, 'project'); await mkdir(projectDir);
  const scope: SessionScope = { agentId: 'owned-agent', role: 'canonical' };
  await store.transaction(state => {
    state.bindings.cindy = { agentId: scope.agentId, operationId: 'owned', phase: 'ready', profileVersion: 1, appliedVersion: 1,
      appliedCapabilities: profile.capabilities, cwd, title: 'Cindy', config: {}, workspaceId: 'owned-workspace', sessionScope: scope };
  });
  const native = { refresh: vi.fn(async () => ({})), archivedAt: null as string | null, cwd, workspaceId: 'owned-workspace' };
  const catalog = vi.fn(async () => ({ projects: [{ projectId: 'project', projectRootPath: projectDir, projectDisplayName: 'Project' }] }));
  const paseo = { agents: { ref: () => native }, projects: { list: catalog }, workspaces: { list: vi.fn(async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } })) } } as unknown as Paseo;
  const service = new CompanionService(store, { paseoForTools: async () => paseo }); disposals.push(() => service.close());
  const server = new CompanionMcpServer({ root: store.root, safePath: path => store.safePath(path), readProfile: id => store.get(id),
    invokeMemory: (id, op, args) => service.invokeMemoryTool(id, op, args), validateScope: (id, s) => service.validateSessionScope(id, s),
    invokeSession: (id, s, op, args) => service.invokeSessionTool(id, s, op, args), registerSessionTools }); disposals.push(() => server.close());
  const connect = async (s?: SessionScope) => {
    const config = await server.configFor('cindy', s), client = new Client({ name: 'project-fixture', version: '1' }); disposals.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })); return client;
  };
  return { store, service, paseo, scope, native, catalog, connect };
}
function payload(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse((result.content as Array<{ text?: string }>).find(item => item.text)?.text ?? '{}');
}
test('Settings and scoped real HTTP share original links; default tool exposes only linked metadata and no mutation tool', async () => {
  const f = await fixture(), client = await f.connect(f.scope);
  expect((await client.listTools()).tools.map(tool => tool.name)).toContain('list_teammate_projects');
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('set_teammate_project');
  const query = { name: 'list_teammate_projects', arguments: {} };
  expect(payload(await client.callTool(query))).toEqual({ projects: [] });
  const candidates = payload(await client.callTool({ ...query, arguments: { include_available: true, botId: 'someone-else' } }));
  expect(candidates.projects).toHaveLength(1); expect(candidates.projects[0].linked).toBe(false);
  const before = await f.service.invoke({ op: 'projects.list', args: { botId: 'cindy' } }, f.paseo); expect(before.ok).toBe(true);
  const value = (before as any).value;
  expect(await f.service.invoke({ op: 'projects.set', args: { botId: 'cindy', projectId: value.projects[0].id, linked: true, expectedRevision: value.revision } }, f.paseo)).toMatchObject({ ok: true });
  const saved = payload(await client.callTool(query)); expect(saved.projects).toHaveLength(1);
  expect(saved.projects[0]).toMatchObject({ linked: true, available_locally: true, context_locations: ['AGENTS.md', 'CLAUDE.md', 'README.md', '.cindy/project-knowledge/TOC.md'] });
  const journal = await readFile(join(f.store.root, 'state.json'));
  await client.callTool(query); expect(await readFile(join(f.store.root, 'state.json'))).toEqual(journal);
  await f.store.update('cindy', { capabilities: { memory: false } });
  expect((await client.callTool(query)).isError).not.toBe(true);
  f.native.archivedAt = new Date().toISOString();
  // Revocation before admission rejects at HTTP authentication, before a tool envelope exists.
  await expect(client.callTool(query)).rejects.toThrow('The native session no longer matches its owned binding');
});
test('legacy credentials have no project tools and forged/group/task scope cannot read catalogs', async () => {
  const f = await fixture(), legacy = await f.connect();
  expect((await legacy.listTools()).tools.map(tool => tool.name)).not.toContain('list_teammate_projects');
  expect((await legacy.callTool({ name: 'list_teammate_projects', arguments: {} })).isError).toBe(true);
  for (const role of ['group', 'plan', 'task'] as const) {
    expect(await f.service.invokeSessionTool('cindy', { ...f.scope, role }, 'list_teammate_projects', {})).toMatchObject({ ok: false });
  }
  expect(f.catalog).not.toHaveBeenCalled();
});
test('native revocation while catalog is in flight rejects all returned project data', async () => {
  const f = await fixture(), client = await f.connect(f.scope), original = await f.catalog();
  f.catalog.mockImplementationOnce(async () => { f.native.archivedAt = 'archived'; return original; });
  const result = await client.callTool({ name: 'list_teammate_projects', arguments: { include_available: true } });
  expect(result.isError).toBe(true); expect(payload(result).projects).toBeUndefined();
});
test('a genuine group grant still cannot read private linked-project metadata', async () => {
  const f = await fixture(), scope: SessionScope = { agentId: 'group-lane', role: 'group', groupId: 'group' };
  await f.store.transaction(state => {
    state.groups = { group: { id: 'group', name: 'G', description: '', botIds: ['cindy'], replyMode: 'all', revision: 1, createdAt: 1, updatedAt: 1,
      messages: [], rounds: [], receipts: {}, continueKeys: {}, lanes: { lane: { agentId: scope.agentId, botId: 'cindy', groupId: 'group', roundId: 'round',
        operationId: 'lane', cwd: f.native.cwd, title: 'Cindy', phase: 'ready', config: {}, sessionScope: scope } } } };
  });
  const client = await f.connect(scope);
  const result = await client.callTool({ name: 'list_teammate_projects', arguments: { include_available: true } });
  expect(result.isError).toBe(true); expect(payload(result)).toMatchObject({ code: 'BOT_MAIN_TASK_REQUIRED' });
  expect(f.catalog).not.toHaveBeenCalled();
});
test('a host-bound routine grant reads projects and loses access when its persisted identity changes', async () => {
  const f = await fixture(), scope: SessionScope = { agentId: 'routine-agent', role: 'routine', routineId: 'routine' };
  await f.store.transaction(state => {
    state.routines.routine = { botId: 'cindy', operationName: 'fixture-routine', phase: 'ready',
      data: { id: 'routine', botId: 'cindy', name: 'Fixture', prompt: 'Read linked projects', enabled: true,
        triggers: [{ id: 'interval', kind: 'interval', intervalMs: 60000 }], revision: 1, createdAt: 1, updatedAt: 1 } };
    state.routineAgents = { 'routine-agent': { botId: 'cindy', routineId: 'routine', cwd: f.native.cwd, sessionScope: scope } };
  });
  const client = await f.connect(scope), query = { name: 'list_teammate_projects', arguments: { include_available: true } };
  const result = await client.callTool(query);
  expect(result.isError).not.toBe(true); expect(payload(result).projects).toHaveLength(1);
  await f.store.transaction(state => { state.routineAgents!['routine-agent'].routineId = 'different'; });
  await expect(client.callTool(query)).rejects.toThrow('The session does not have this collaboration grant');
});
test('accepted read drains before close; new calls after close fail', async () => {
  const f = await fixture(), original = await f.catalog();
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.catalog.mockImplementationOnce(async () => { entered(); await gate; return original; });
  const pending = f.service.invoke({ op: 'projects.list', args: { botId: 'cindy' } }, f.paseo); await enteredPromise;
  let closed = false; const closing = f.service.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); release(); expect(await pending).toMatchObject({ ok: true }); await closing;
  expect(await f.service.invoke({ op: 'projects.list', args: { botId: 'cindy' } }, f.paseo)).toMatchObject({ ok: false, code: 'PLUGIN_CLOSED' });
});
