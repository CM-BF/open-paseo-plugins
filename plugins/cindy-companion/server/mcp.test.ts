import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CompanionMcpServer } from './mcp';
import type { CompanionMcpDependencies } from './mcp';
import { z } from 'zod';
import { CompanionService } from './service';
import { CompanionStore } from './store';

const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
async function fixture(beforeInvoke?: (op: string) => Promise<void>, session: Partial<Pick<CompanionMcpDependencies, 'validateScope' | 'invokeSession' | 'registerSessionTools'>> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cindy-mcp-'));
  disposals.push(() => rm(root, { recursive: true, force: true }));
  const store = new CompanionStore(root);
  await store.load();
  const service = new CompanionService(store);
  disposals.push(async () => service.close());
  const create = () => new CompanionMcpServer({ ...session, root, safePath: path => store.safePath(path), readProfile: id => store.get(id),
    invokeMemory: async (id, op, args) => { await beforeInvoke?.(op); return service.invokeMemoryTool(id, op, args); } });
  const server = create(); disposals.push(() => server.close());
  const config = await server.configFor('cindy');
  return { root, store, service, server, config, create };
}

describe('companion MCP over real loopback HTTP', () => {
  it('shares durable memory with Settings and rejects stale edits', async () => {
    const { config, service } = await fixture();
    const client = new Client({ name: 'cindy-test', version: '1' });
    disposals.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toContain('memory_write');
    const saved = await client.callTool({ name: 'memory_write', arguments: { type: 'user', name: 'language', title: 'Language', body: 'Prefers Chinese' } });
    expect(saved.isError).toBe(false);
    const read = await service.invokeMemoryTool('cindy', 'memory.read', { filename: 'user_language.md' });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.message);
    const memory = read.value as { body: string; updatedAt: string };
    expect(memory.body).toBe('Prefers Chinese');
    const updated = await service.invokeMemoryTool('cindy', 'memory.update', { filename: 'user_language.md', title: 'Language', body: 'Prefers concise Chinese', expectedUpdatedAt: memory.updatedAt });
    expect(updated.ok).toBe(true);
    const stale = await client.callTool({ name: 'memory_update', arguments: { filename: 'user_language.md', title: 'Language', body: 'Stale content', expectedUpdatedAt: memory.updatedAt } });
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale)).toContain('bot-memory-changed');
  });

  it('isolates teammate authorization and refuses browser origins', async () => {
    const { config, store } = await fixture();
    const other = await store.create({ name: 'Another teammate' });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const headers = { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const foreign = await fetch(config.url.replace(/cindy$/, other.id), { method: 'POST', headers, body });
    expect(foreign.status).toBe(401);
    const browser = await fetch(config.url, { method: 'POST', headers: { ...headers, origin: 'null' }, body });
    expect(browser.status).toBe(403);
    const unauthenticated = await fetch(config.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(unauthenticated.status).toBe(401);
  });

  it('reads edited identity files and immediately honors the Memory switch', async () => {
    const { config, root, store } = await fixture();
    const client = new Client({ name: 'cindy-test', version: '1' });
    disposals.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    await writeFile(join(root, 'bots/cindy/SOUL.md'), 'Use concise Chinese.');
    const context = await client.callTool({ name: 'companion_context', arguments: {} });
    expect(context.isError).toBe(false);
    expect(JSON.stringify(context)).toContain('Use concise Chinese.');
    await store.update('cindy', { capabilities: { memory: false } });
    const denied = await client.callTool({ name: 'memory_list', arguments: {} });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('MEMORY_DISABLED');
  });

  it('keeps the endpoint stable across plugin reload and closes startup races', async () => {
    const { root, config, server, create } = await fixture();
    expect((await stat(join(root, 'mcp-endpoint.json'))).mode & 0o777).toBe(0o600);
    await server.close();
    const replacement = create(); disposals.push(() => replacement.close());
    expect(await replacement.configFor('cindy')).toEqual(config);
    await replacement.close();
    const cancelled = create();
    const pending = cancelled.configFor('cindy');
    await cancelled.close();
    await expect(pending).rejects.toThrow('closed');
  });

  it('drains an accepted memory write before cleanup returns', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = new Promise<void>(resolve => { entered = resolve; });
    const { config, server, service } = await fixture(async op => {
      if (op === 'memory.create') { entered(); await gate; }
    });
    const client = new Client({ name: 'cindy-test', version: '1' });
    disposals.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    const pending = client.callTool({ name: 'memory_write', arguments: { type: 'reference', name: 'drain', title: 'Drain', body: 'Durable before cleanup' } });
    const settled = pending.catch(() => undefined); // Shutdown may close the response transport after committing.
    await writing;
    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    await settled;
    const memory = await service.invokeMemoryTool('cindy', 'memory.read', { filename: 'reference_drain.md' });
    expect(memory.ok && (memory.value as { body: string }).body).toBe('Durable before cleanup');
  });

  it('retries a temporary port conflict without changing the saved endpoint', async () => {
    const { config, server, create } = await fixture();
    await server.close();
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(Number(new URL(config.url).port), '127.0.0.1', resolve));
    const retrying = create(); disposals.push(() => retrying.close());
    try { await expect(retrying.configFor('cindy')).rejects.toMatchObject({ code: 'EADDRINUSE' }); }
    finally { await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())); }
    expect(await retrying.configFor('cindy')).toEqual(config);
  });

  it('keeps same-name memories separate for two valid companion tokens and revokes writes', async () => {
    const { config, server, store } = await fixture();
    const other = await store.create({ name: 'Second companion' });
    const secondConfig = await server.configFor(other.id);
    const clients = [new Client({ name: 'first', version: '1' }), new Client({ name: 'second', version: '1' })];
    for (let i = 0; i < clients.length; i++) {
      const client = clients[i]!; const target = [config, secondConfig][i]!;
      disposals.push(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(target.url), { requestInit: { headers: target.headers } }));
      const result = await client.callTool({ name: 'memory_write', arguments: { type: 'reference', name: 'same_name', title: 'Separate', body: `Companion ${i}` } });
      expect(result.isError).toBe(false);
    }
    for (let i = 0; i < clients.length; i++) {
      const result = await clients[i]!.callTool({ name: 'memory_read', arguments: { filename: 'reference_same_name.md' } });
      expect(JSON.stringify(result)).toContain(`Companion ${i}`);
      expect(JSON.stringify(result)).not.toContain(`Companion ${1 - i}`);
    }
    await store.update('cindy', { capabilities: { memory: false } });
    expect((await clients[0]!.callTool({ name: 'memory_write', arguments: { type: 'reference', name: 'blocked', title: 'Blocked', body: 'Blocked' } })).isError).toBe(true);
    expect((await clients[0]!.callTool({ name: 'memory_delete', arguments: { filename: 'reference_same_name.md', expectedUpdatedAt: 'not-used' } })).isError).toBe(true);
    const context = await clients[0]!.callTool({ name: 'companion_context', arguments: {} });
    expect(context.isError).toBe(false); expect(JSON.stringify(context)).toContain('memoryEnabled\\":false');
    await store.deleteProfile(other.id, other.name);
    await expect(clients[1]!.callTool({ name: 'memory_list', arguments: {} })).rejects.toThrow();
  });
});

it('binds session tools to the signed native scope, separates legacy tokens, and rechecks revocation', async () => {
  let allowed = true;
  const received: unknown[] = [];
  const f = await fixture(undefined, {
    validateScope: async (botId, scope) => { if (!allowed || botId !== 'cindy' || scope.agentId !== 'agent-a' || scope.role !== 'group' || scope.groupId !== 'group-a') throw Error('Session ownership is no longer valid'); },
    invokeSession: async (botId, scope, op, args) => { received.push({ botId, scope, op, args }); return { ok: true, value: { caller: scope.agentId } }; },
    registerSessionTools: (mcp, context) => { mcp.registerTool('session_probe', { inputSchema: { callerSessionId: z.string().optional() } }, args => context.invoke('probe', args)); },
  });
  const scope = { agentId: 'agent-a', role: 'group' as const, groupId: 'group-a' };
  const config = await f.server.configFor('cindy', scope);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const legacyAsSession = await fetch(config.url, { method: 'POST', headers: { ...headers, ...f.config.headers }, body });
  expect(legacyAsSession.status).toBe(401);
  const sessionAsLegacy = await fetch(f.config.url, { method: 'POST', headers: { ...headers, ...config.headers }, body });
  expect(sessionAsLegacy.status).toBe(401);
  const forged = config.url.replace(/[^/]+$/, Buffer.from(JSON.stringify({ ...scope, agentId: 'agent-b' })).toString('base64url'));
  expect((await fetch(forged, { method: 'POST', headers: { ...headers, ...config.headers }, body })).status).toBe(401);
  const legacy = new Client({ name: 'legacy', version: '1' }); disposals.push(() => legacy.close());
  await legacy.connect(new StreamableHTTPClientTransport(new URL(f.config.url), { requestInit: { headers: f.config.headers } }));
  expect((await legacy.listTools()).tools.some(tool => tool.name === 'session_probe')).toBe(false);
  const client = new Client({ name: 'scoped', version: '1' }); disposals.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  expect((await client.listTools()).tools.some(tool => tool.name === 'session_probe')).toBe(true);
  const result = await client.callTool({ name: 'session_probe', arguments: { callerSessionId: 'agent-forged' } });
  expect(result.isError).toBe(false);
  expect(received).toEqual([{ botId: 'cindy', scope, op: 'probe', args: { callerSessionId: 'agent-forged' } }]);
  allowed = false;
  await expect(client.callTool({ name: 'session_probe', arguments: {} })).rejects.toThrow();
  expect(received).toHaveLength(1);
  allowed = true;
  await client.close(); await legacy.close(); await f.server.close();
  const replacement = f.create(); disposals.push(() => replacement.close());
  expect(await replacement.configFor('cindy', scope)).toEqual(config);
});

it('drains an accepted session operation before endpoint cleanup', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let committed = false;
  const f = await fixture(undefined, {
    validateScope: async () => {},
    invokeSession: async () => { entered(); await gate; committed = true; return { ok: true, value: null }; },
    registerSessionTools: (mcp, context) => { mcp.registerTool('session_probe', { inputSchema: {} }, () => context.invoke('probe', {})); },
  });
  const config = await f.server.configFor('cindy', { agentId: 'agent-a', role: 'canonical' });
  const client = new Client({ name: 'scoped', version: '1' }); disposals.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  const pending = client.callTool({ name: 'session_probe', arguments: {} }).catch(() => undefined);
  await started;
  let closed = false; const closing = f.server.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); expect(committed).toBe(false);
  release(); await closing; await pending; expect(committed).toBe(true);
});

it('bounds native ownership validation before accepting more scoped HTTP requests', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const full = new Promise<void>(resolve => { entered = resolve; });
  let validating = 0;
  const f = await fixture(undefined, {
    validateScope: async () => { if (++validating === 16) entered(); await gate; },
    invokeSession: async () => ({ ok: true, value: null }),
    registerSessionTools: () => {},
  });
  const config = await f.server.configFor('cindy', { agentId: 'agent-a', role: 'canonical' });
  const request = () => fetch(config.url, { method: 'POST',
    headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const pending = Array.from({ length: 16 }, request);
  try {
    await full;
    const denied = await request();
    expect(denied.status).toBe(429);
    expect(validating).toBe(16);
    await denied.text();
  } finally {
    release();
    await Promise.all(pending.map(async result => { await (await result).text(); }));
  }
});
