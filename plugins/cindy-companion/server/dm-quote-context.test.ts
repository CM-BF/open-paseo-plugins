import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getEventListeners } from 'node:events';
import { createPaseoClient, type PaseoAgent } from '@getpaseo/client';
import { afterEach, expect, test, vi } from 'vitest';
import { DM_QUOTE_CONTEXT_ID, dmQuoteDisplaySchema } from '../shared/dm-quotes';
import { CompanionStore } from './store';
import { CompanionService } from './service';
import { registerDmQuoteContext, type DmQuoteInputContextResolver } from './dm-quote-context';

const disposals: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function abortListeners(signal: unknown) {
  if (!(signal instanceof AbortSignal)) throw new Error('Expected a real AbortSignal');
  return getEventListeners(signal, 'abort');
}
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'cindy-dm-context-'));
  disposals.push(() => rm(path, { recursive: true, force: true }));
  const store = new CompanionStore(path); await store.load();
  const profile = await store.get('cindy'), cwd = join(profile.homeDir, 'workspace');
  const agentId = 'owned-agent', workspaceId = 'owned-workspace';
  await store.transaction(state => { state.bindings.cindy = {
    agentId, operationId: 'owned-create', phase: 'ready', profileVersion: 1, appliedVersion: 1,
    appliedCapabilities: profile.capabilities, config: {}, cwd, workspaceId, title: 'Cindy',
  }; });
  // Real installed SDK handles, never connected. Only native read responses are controlled.
  const paseo = createPaseoClient({ url: 'ws://127.0.0.1:1', reconnect: { enabled: false } });
  disposals.push(() => paseo.close());
  const snapshot: PaseoAgent = { id: agentId, workspaceId, cwd, provider: 'codex', model: null,
    createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', lastUserMessageAt: null,
    status: 'idle', currentModeId: null, availableModes: [], pendingPermissions: [], persistence: null,
    title: 'Cindy', labels: {}, capabilities: { supportsStreaming: true, supportsSessionPersistence: true,
      supportsDynamicModes: false, supportsMcpServers: true, supportsReasoningStream: true,
      supportsToolInvocations: true, supportsRewindConversation: false, supportsRewindFiles: false, supportsRewindBoth: false } };
  const native = paseo.agents.ref(snapshot);
  vi.spyOn(paseo.agents, 'ref').mockReturnValue(native);
  const refresh = vi.spyOn(native, 'refresh').mockImplementation(async () => ({ agent: snapshot, project: null }));
  const text = 'Authoritative daemon source';
  type Page = Awaited<ReturnType<typeof native.timeline.refetch>>;
  const page: Page = { requestId: 'read', agentId, agent: null, direction: 'tail', projection: 'projected',
    epoch: 'epoch', reset: false, staleCursor: false, gap: false, window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
    startCursor: { epoch: 'epoch', seq: 1 }, endCursor: { epoch: 'epoch', seq: 1 }, hasOlder: false, hasNewer: false,
    entries: [{ provider: 'codex', timestamp: snapshot.createdAt, seqStart: 1, seqEnd: 1,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], collapsed: [], turnId: 'source-turn',
      item: { type: 'user_message', messageId: 'native-source', clientMessageId: 'source-client', text } }], error: null };
  const refetch = vi.spyOn(native.timeline, 'refetch').mockImplementation(async () => page);
  const send = vi.spyOn(native, 'send').mockRejectedValue(new Error('Must never send'));
  const service = new CompanionService(store); disposals.push(() => service.close());
  let captured: DmQuoteInputContextResolver | undefined;
  const remove = vi.fn(), host = { addInputContextResolver: vi.fn((resolver: DmQuoteInputContextResolver) => {
    captured = resolver; return remove;
  }) };
  const cleanup = registerDmQuoteContext(host, service); disposals.push(cleanup);
  if (!captured) throw new Error('Resolver was not registered');
  const resolver = captured;
  const request = { agent: { id: agentId, workspaceId, parentAgentId: null, provider: 'codex', cwd, title: 'Cindy' },
    clientMessageId: 'new-visible-input', value: { source: { agentId, reference: { role: 'user' as const, clientMessageId: 'source-client' } } } };
  const controller = new AbortController(), context = { paseo, signal: controller.signal };
  return { path, store, service, paseo, snapshot, native, refresh, refetch, send, page, text, host, remove, cleanup, resolver, request, controller, context };
}

test('registered resolver rereads authoritative text using the supplied SDK without sending or persisting', async () => {
  const f = await fixture(), before = await readFile(join(f.path, 'state.json'));
  expect(f.host.addInputContextResolver).toHaveBeenCalledOnce();
  expect(f.resolver.id).toBe(DM_QUOTE_CONTEXT_ID);
  const result = await f.resolver.resolve(f.request, f.context);
  expect(result.modelContext).toContain(f.text);
  expect(dmQuoteDisplaySchema.parse(result.displayData)).toMatchObject({ status: 'available', excerpt: f.text,
    source: { reference: { providerMessageId: 'native-source' } }, evidence: { attachments: 'unavailable', sealed: 'unavailable' } });
  expect(f.refetch).toHaveBeenCalledTimes(2); expect(f.send).not.toHaveBeenCalled();
  expect(await readFile(join(f.path, 'state.json'))).toEqual(before);
});

test('old hosts do not register a resolver or touch the service', () => {
  const prepareDmQuote = vi.fn<CompanionService['prepareDmQuote']>();
  const cleanup = registerDmQuoteContext({}, { prepareDmQuote });
  cleanup(); cleanup();
  expect(prepareDmQuote).not.toHaveBeenCalled();
});

test('daemon target identity and strict selection reject foreign sessions and client text', async () => {
  const f = await fixture();
  await expect(f.resolver.resolve({ ...f.request, agent: { ...f.request.agent, id: 'foreign' } }, f.context))
    .rejects.toMatchObject({ code: 'DM_QUOTE_DIFFERENT_CONVERSATION' });
  for (const value of [{ ...f.request.value, excerpt: 'forged' },
    { source: { ...f.request.value.source, text: 'forged' } }])
    await expect(f.resolver.resolve({ ...f.request, value }, f.context)).rejects.toThrow();
  expect(f.refetch).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
});

test('captures the selection before service admission instead of following later caller mutation', async () => {
  const f = await fixture();
  const resolving = f.resolver.resolve(f.request, f.context);
  f.request.value.source.reference.clientMessageId = 'changed-after-admission';
  f.request.agent.id = 'another-agent';
  expect(await resolving).toMatchObject({ displayData: { status: 'available',
    source: { agentId: 'owned-agent', reference: { clientMessageId: 'source-client' } } } });
});

test.each(['binding', 'paused', 'archived'] as const)('revocation during real source read (%s) returns no quote', async kind => {
  const f = await fixture();
  f.refetch.mockImplementationOnce(async () => {
    if (kind === 'binding') await f.store.transaction(state => { state.bindings.cindy!.operationId = 'new-owner'; });
    if (kind === 'paused') await f.store.transaction(state => { state.profiles.cindy!.enabled = false; });
    if (kind === 'archived') f.snapshot.archivedAt = 'archived';
    return f.page;
  });
  await expect(f.resolver.resolve(f.request, f.context)).rejects.toMatchObject({ code: 'DM_SOURCE_REVOKED' });
  expect(f.send).not.toHaveBeenCalled();
});

test('the original signal still cancels after the caller replaces its context signal', async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  f.refetch.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return f.page; });
  const pending = f.resolver.resolve(f.request, f.context);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'DM_SOURCE_CLOSED' });
  try {
    await entered.promise;
    f.context.signal = new AbortController().signal;
    f.controller.abort();
  } finally { release.resolve(); }
  await rejected;
  expect(f.refetch).toHaveBeenCalledTimes(1);
});

test.each(['request', 'registration'] as const)('already aborted %s rejects before reading the source', async source => {
  const f = await fixture();
  if (source === 'request') f.controller.abort();
  else f.cleanup();
  await expect(f.resolver.resolve(f.request, f.context)).rejects.toMatchObject({ code: 'DM_SOURCE_CLOSED' });
  expect(f.refresh).not.toHaveBeenCalled(); expect(f.refetch).not.toHaveBeenCalled();
  expect(getEventListeners(f.controller.signal, 'abort')).toHaveLength(0);
});

test.each(['success', 'failure', 'request-abort', 'registration-abort'] as const)('both source listeners are removed after %s', async outcome => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  f.refetch.mockImplementationOnce(async () => {
    entered.resolve(); await release.promise;
    if (outcome === 'failure') throw new Error('Native read failed');
    return f.page;
  });
  const additions = vi.spyOn(AbortSignal.prototype, 'addEventListener');
  try {
    const pending = f.resolver.resolve(f.request, f.context);
    const result = pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    try {
      await entered.promise;
      expect(additions.mock.contexts).toHaveLength(2);
      for (const signal of additions.mock.contexts) expect(abortListeners(signal)).toHaveLength(1);
      if (outcome === 'request-abort') f.controller.abort();
      if (outcome === 'registration-abort') f.cleanup();
    } finally { release.resolve(); }
    const settled = await result;
    expect(settled.ok).toBe(outcome === 'success');
    if (!settled.ok) expect(settled.error).toMatchObject({ code: outcome === 'failure' ? 'DM_QUOTE_SOURCE_UNAVAILABLE' : 'DM_SOURCE_CLOSED' });
    for (const signal of additions.mock.contexts) expect(abortListeners(signal)).toHaveLength(0);
  } finally { additions.mockRestore(); }
});

test('registration cleanup aborts pending reads and rejects retained callbacks without deleting newer registrations', async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  f.refetch.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return f.page; });
  const pending = f.resolver.resolve(f.request, f.context);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'DM_SOURCE_CLOSED' });
  try { await entered.promise; f.cleanup(); f.cleanup(); }
  finally { release.resolve(); }
  await rejected;
  const nextCleanup = registerDmQuoteContext(f.host, f.service);
  f.cleanup();
  expect(f.remove).toHaveBeenCalledTimes(1);
  await expect(f.resolver.resolve(f.request, f.context)).rejects.toMatchObject({ code: 'DM_SOURCE_CLOSED' });
  nextCleanup(); expect(f.remove).toHaveBeenCalledTimes(2);
});

test('service close rejects new preparations and drains an already admitted native read', async () => {
  const f = await fixture(), entered = deferred<void>(), release = deferred<void>();
  f.refetch.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return f.page; });
  const pending = f.resolver.resolve(f.request, f.context);
  let closed = false;
  let closing: Promise<void> | undefined;
  try {
    await entered.promise;
    closing = f.service.close().then(() => { closed = true; });
    await expect(f.resolver.resolve(f.request, f.context)).rejects.toMatchObject({ code: 'PLUGIN_CLOSED' });
    expect(closed).toBe(false);
  } finally { release.resolve(); }
  expect(await pending).toMatchObject({ displayData: { status: 'available' } });
  await closing; expect(closed).toBe(true); expect(f.send).not.toHaveBeenCalled();
});

test('a missing authoritative source retains the unavailable note without a fabricated excerpt', async () => {
  const f = await fixture(); f.refetch.mockResolvedValue({ ...f.page, entries: [] });
  const result = await f.resolver.resolve(f.request, f.context);
  expect(result.displayData).toEqual({ version: 1, status: 'not-found', source: f.request.value.source });
  expect(result.modelContext).not.toContain(f.text);
  expect(f.send).not.toHaveBeenCalled();
});
