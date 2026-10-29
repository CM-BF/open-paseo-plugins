import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanionService } from './service';
import { CompanionStore } from './store';
import { ScheduleCli, type NativeSchedule, type ScheduleDriver } from './schedules';
import { ScheduleSdk, scheduleCadence } from './schedule-sdk';
import type { Paseo } from './runtime';

const roots: string[] = []; const services: CompanionService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function fakeDriver() {
  const data = new Map<string, NativeSchedule>();
  const driver: ScheduleDriver = {
    list: vi.fn(async () => [...data.values()]),
    inspect: vi.fn(async id => data.get(id)!),
    create: vi.fn(async input => { const [provider, model] = input.provider.split('/'); const record = { id: `schedule-${data.size + 1}`, name: input.name, status: 'active', runs: [], prompt: input.prompt,
      cadence: scheduleCadence(input.cadence), target: { type: 'new-agent', config: { cwd: input.cwd, provider, model, modeId: input.mode } } }; data.set(record.id, record); return record; }),
    update: vi.fn(async (id, input) => { const record = { ...data.get(id)!, prompt: input.prompt }; data.set(id, record); return record; }),
    pause: vi.fn(async id => { data.get(id)!.status = 'paused'; }), resume: vi.fn(async id => { data.get(id)!.status = 'active'; }),
    remove: vi.fn(async id => { data.delete(id); }), run: vi.fn(async id => {
      const now = new Date().toISOString(); data.get(id)!.runs!.push({ id: `run-${data.get(id)!.runs!.length + 1}`, status: 'succeeded', startedAt: now, scheduledFor: now, endedAt: now });
      return data.get(id);
    }),
  };
  return { driver, data };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cindy-routine-test-')); roots.push(root);
  const { driver, data } = fakeDriver(); const store = new CompanionStore(root); const service = new CompanionService(store, { scheduleDriver: driver }); services.push(service);
  const paseo = { providers: { waitForReady: async () => ({ entries: [{ provider: 'codex', status: 'ready', modes: [{ id: 'auto' }], models: [{ id: 'test-model', isDefault: true }] }] }) } } as unknown as Paseo;
  return { root, service, store, driver, data, paseo };
}
const input = () => ({ name: 'Daily review', prompt: 'Review the work', enabled: true, sessionMode: 'fresh', triggers: [{ id: 't1', kind: 'cron', expression: '0 9 * * *', timezone: 'America/Los_Angeles' }] });
it('keeps bundled disabled routine drafts entirely local until explicitly enabled', async () => {
  const { service, store, paseo, driver } = await setup();
  const data = { ...input(), enabled: false, id: 'preset-draft', botId: 'cindy', revision: 1, createdAt: 1, updatedAt: 1 };
  await store.transaction(state => { state.presetRoutineDrafts = { [data.id]: { botId: 'cindy', data: data as never } }; });
  expect(await service.routines.list('cindy', paseo)).toMatchObject([{ id: data.id, enabled: false, backendState: 'draft' }]);
  expect(await service.routines.history('cindy', data.id, paseo)).toEqual([]);
  expect(driver.list).not.toHaveBeenCalled(); expect(driver.create).not.toHaveBeenCalled();
  await service.routines.save(paseo, 'cindy', { ...input(), enabled: false, prompt: 'Edited locally' }, data.id);
  expect(driver.create).not.toHaveBeenCalled(); expect((await store.snapshot()).presetRoutineDrafts![data.id]!.data.prompt).toBe('Edited locally');
  const enabled = await service.routines.save(paseo, 'cindy', input(), data.id);
  expect(enabled.id).toBe(data.id); expect(driver.create).toHaveBeenCalledOnce();
  expect((await store.snapshot()).presetRoutineDrafts![data.id]).toBeUndefined();
});
it('deletes an imported routine draft without touching native schedules and refuses cross-companion access', async () => {
  const { service, store, paseo, driver } = await setup();
  const data = { ...input(), enabled: false, id: 'preset-draft', botId: 'cindy', revision: 1, createdAt: 1, updatedAt: 1 };
  await store.transaction(state => { state.presetRoutineDrafts = { [data.id]: { botId: 'cindy', data: data as never } }; });
  await expect(service.routines.remove('other', data.id, paseo)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await service.routines.remove('cindy', data.id, paseo);
  expect(driver.remove).not.toHaveBeenCalled(); expect((await store.snapshot()).presetRoutineDrafts).toEqual({});
});
it('runs real routine operations through an injected native schedule driver and persists the binding', async () => {
  const { root, service, driver, paseo, data } = await setup();
  const saved = await service.routines.save(paseo, 'cindy', input());
  expect(driver.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex/test-model', cadence: { cron: '0 9 * * *', timezone: 'America/Los_Angeles' } }));
  const persisted = (await new CompanionStore(root).snapshot()).routines[saved.id]!; expect(persisted.scheduleId).toBe('schedule-1');
  await service.routines.save(paseo, 'cindy', { ...input(), enabled: false }, saved.id); expect(driver.pause).toHaveBeenCalledWith('schedule-1');
  expect((await service.routines.list('cindy'))[0]?.enabled).toBe(false);
  data.get('schedule-1')!.runs = [{ id: 'run-1', status: 'succeeded', startedAt: '2026-10-28T00:00:00Z', endedAt: '2026-10-28T00:00:01Z', agentId: 'agent-1', output: 'Reviewed' }];
  expect(await service.routines.history('cindy', saved.id)).toMatchObject([{ status: 'success', resultText: 'Reviewed' }]);
  await service.routines.run('cindy', saved.id); expect(driver.run).toHaveBeenCalledWith('schedule-1');
  await vi.waitFor(async () => expect((await service.routines.history('cindy', saved.id))[0]?.status).toBe('success'));
  await service.routines.remove('cindy', saved.id); expect(await service.routines.list('cindy')).toEqual([]);
});
it('injects current identity and memory only into the immutable owned routine directory without elevating permissions', async () => {
  const { service, store, paseo } = await setup();
  service.runtime.setMcpFactory(async id => ({ type: 'http', url: `http://127.0.0.1/fake/${id}`, headers: { Authorization: 'fixture-only' } }));
  const routine = await service.routines.save(paseo, 'cindy', input());
  const saved = (await store.snapshot()).routines[routine.id]!;
  expect(saved.execution!.cwd).toBe(join((await store.get('cindy')).homeDir, 'routines', routine.id, 'workspace'));
  const other = { config: { provider: 'codex', model: 'test-model', cwd: '/unrelated/workspace', systemPrompt: 'Unrelated instructions' } };
  expect(await service.routines.beforeCreate(other, paseo)).toBe(other);
  const siblingDirectory = { config: { ...other.config, cwd: `${saved.execution!.cwd}-other` } };
  expect(await service.routines.beforeCreate(siblingDirectory, paseo)).toBe(siblingDirectory);
  await store.update('cindy', { identitySource: 'Updated after schedule creation', userContextSource: 'Current preferences' });
  const owned = { config: { ...other.config, cwd: saved.execution!.cwd, modeId: 'full-access', providerOptions: { sandbox_mode: 'danger-full-access', approval_policy: 'never', web_search: 'disabled' },
    mcpServers: { other: { type: 'http' as const, url: 'http://127.0.0.1/other' } } } };
  const result = await service.routines.beforeCreate(owned, paseo);
  expect(result.config.systemPrompt).toContain('Updated after schedule creation'); expect(result.config.systemPrompt).toContain('Current preferences');
  expect(result.config.systemPrompt).toContain('mcp__cindy_memory__companion_context');
  expect(result.config.systemPrompt).toContain('do not require a dot separator');
  expect(saved.nativePrompt).toContain('mcp__cindy_memory__companion_context');
  expect(result.config.mcpServers).toMatchObject({ other: owned.config.mcpServers.other, cindy_memory: { url: 'http://127.0.0.1/fake/cindy' } });
  expect(result.config.modeId).toBe('auto'); expect(result.config.providerOptions).toMatchObject({ approval_policy: 'on-request', sandbox_mode: 'workspace-write', web_search: 'disabled' });
  expect(result.config.toolPolicy).toBeUndefined(); expect(owned.config.modeId).toBe('full-access');
  await expect(service.routines.beforeCreate({ config: { ...owned.config, model: 'external-model' } }, paseo)).rejects.toMatchObject({ code: 'ROUTINE_BINDING_MISMATCH' });
  await rm(saved.execution!.cwd, { recursive: true }); await symlink(tmpdir(), saved.execution!.cwd);
  await expect(service.routines.beforeCreate(owned, paseo)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
});
it('refuses routine creation when an explicit approval mode cannot be verified', async () => {
  const { service, paseo, driver } = await setup();
  paseo.providers.waitForReady = (async () => ({ entries: [{ provider: 'codex', status: 'ready', models: [{ id: 'test-model', isDefault: true }] }] })) as typeof paseo.providers.waitForReady;
  await expect(service.routines.save(paseo, 'cindy', input())).rejects.toMatchObject({ code: 'PERMISSION_MODE_UNAVAILABLE' });
  expect(driver.create).not.toHaveBeenCalled();
});
it('prefers the public schedule SDK and forwards the complete companion config', async () => {
  const { service, paseo, driver } = await setup();
  service.runtime.setMcpFactory(async () => ({ type: 'http', url: 'http://127.0.0.1/fake' }));
  const actions = {
    create: vi.fn(async () => ({ schedule: { id: 'native-sdk', status: 'active' }, error: null })), list: vi.fn(async () => ({ schedules: [], error: null })),
    inspect: vi.fn(async () => ({ schedule: { id: 'native-sdk', status: 'active' }, error: null })), logs: vi.fn(async () => ({ runs: [], error: null })),
    update: vi.fn(async () => ({ schedule: { id: 'native-sdk' }, error: null })), pause: vi.fn(async () => ({ error: null })), resume: vi.fn(async () => ({ error: null })),
    delete: vi.fn(async () => ({ error: null })), runOnce: vi.fn(async () => ({ error: 'not ready' })),
  };
  Object.assign(paseo, { schedules: actions });
  const routine = await service.routines.save(paseo, 'cindy', input());
  expect(driver.create).not.toHaveBeenCalled();
  expect(actions.create).toHaveBeenCalledWith(expect.objectContaining({ runOnCreate: false, target: { type: 'new-agent', config: expect.objectContaining({ provider: 'codex', model: 'test-model', modeId: 'auto',
    systemPrompt: expect.stringContaining('companion_context'), mcpServers: { cindy_memory: { type: 'http', url: 'http://127.0.0.1/fake' } }, providerOptions: { approval_policy: 'on-request', sandbox_mode: 'workspace-write' } }) } }));
  expect(await service.routines.history('cindy', routine.id, paseo)).toEqual([]); expect(actions.logs).toHaveBeenCalledWith({ id: 'native-sdk' });
  expect(await service.routines.run('cindy', routine.id, paseo)).toMatchObject({ accepted: true, status: 'queued' });
  await vi.waitFor(async () => expect(await service.routines.history('cindy', routine.id, paseo)).toMatchObject([{ status: 'queued', launchState: 'unknown', error: expect.stringContaining('not ready') }]));
  expect(ScheduleSdk.from(paseo)).not.toBeNull();
});
it('validates interval cadence without silently changing an unsupported interval', () => {
  expect(scheduleCadence({ everyMs: 60_000 })).toMatchObject({ expression: '*/1 * * * *', timezone: 'UTC' });
  expect(scheduleCadence({ everyMs: 7_200_000 })).toMatchObject({ expression: '0 */2 * * *' });
  expect(() => scheduleCadence({ everyMs: 70_000 })).toThrow(); expect(() => scheduleCadence({ everyMs: 7 * 60_000 })).toThrow();
});
it('rejects unsupported Cindy trigger and session semantics before native creation', async () => {
  const { service, driver, paseo } = await setup();
  await expect(service.routines.save(paseo, 'cindy', { ...input(), sessionMode: 'persistent' })).rejects.toMatchObject({ code: 'UNSUPPORTED_SESSION_MODE' });
  await expect(service.routines.save(paseo, 'cindy', { ...input(), triggers: [{ id: 'once', kind: 'once', at: Date.now() + 100000 }] })).rejects.toMatchObject({ code: 'UNSUPPORTED_TRIGGER' });
  expect(driver.create).not.toHaveBeenCalled();
});
it('keeps ambiguous native creation in durable unknown state and never fabricates success', async () => {
  const { service, store, driver, paseo } = await setup();
  vi.mocked(driver.create).mockRejectedValue(new Error('response lost'));
  await expect(service.routines.save(paseo, 'cindy', input())).rejects.toMatchObject({ code: 'SCHEDULE_OUTCOME_UNKNOWN' });
  const saved = Object.values((await store.snapshot()).routines)[0]!; expect(saved.phase).toBe('unknown');
  await expect(service.routines.run('cindy', saved.data.id)).rejects.toMatchObject({ code: 'SCHEDULE_OUTCOME_UNKNOWN' });
  expect(driver.run).not.toHaveBeenCalled();
});
it('recovers a lost create acknowledgement by verifying immutable native intent and restoring disabled state', async () => {
  const { service, store, driver, paseo, data } = await setup(); const create = vi.mocked(driver.create).getMockImplementation()!;
  vi.mocked(driver.create).mockImplementation(async input => { await create(input); throw new Error('lost reply'); });
  await expect(service.routines.save(paseo, 'cindy', { ...input(), enabled: false })).rejects.toMatchObject({ code: 'SCHEDULE_OUTCOME_UNKNOWN' });
  const uncertain = Object.values((await store.snapshot()).routines)[0]!; expect(uncertain.scheduleId).toBeUndefined();
  expect(await service.routines.list('cindy', paseo)).toMatchObject([{ id: uncertain.data.id, enabled: false, backendState: 'ready' }]);
  expect(data.get('schedule-1')!.status).toBe('paused'); expect(driver.pause).toHaveBeenCalledWith('schedule-1');
  expect((await store.snapshot()).routines[uncertain.data.id]).toMatchObject({ phase: 'ready', scheduleId: 'schedule-1' });
  await service.routines.remove('cindy', uncertain.data.id, paseo); expect(data.size).toBe(0); expect(driver.create).toHaveBeenCalledTimes(1);
});
it('does not recover a same-name foreign schedule or delete it', async () => {
  const { service, store, driver, paseo, data } = await setup(); const create = vi.mocked(driver.create).getMockImplementation()!;
  vi.mocked(driver.create).mockImplementation(async input => { await create(input); throw new Error('lost reply'); });
  await expect(service.routines.save(paseo, 'cindy', input())).rejects.toMatchObject({ code: 'SCHEDULE_OUTCOME_UNKNOWN' });
  const uncertain = Object.values((await store.snapshot()).routines)[0]!;
  data.get('schedule-1')!.target = { type: 'new-agent', config: { cwd: '/unrelated', provider: 'codex', model: 'test-model', modeId: 'auto' } };
  await expect(service.routines.reconcile('cindy', uncertain.data.id, paseo)).rejects.toMatchObject({ code: 'ROUTINE_BINDING_MISMATCH' });
  await expect(service.routines.remove('cindy', uncertain.data.id, paseo)).rejects.toMatchObject({ code: 'ROUTINE_BINDING_MISMATCH' });
  expect(driver.remove).not.toHaveBeenCalled(); expect((await store.snapshot()).routines[uncertain.data.id]!.phase).toBe('unknown');
});
it('preserves exact legacy prompt ownership when recovering an intent created before normalized tool discovery', async () => {
  const { service, store, driver, paseo, data } = await setup(); const create = vi.mocked(driver.create).getMockImplementation()!;
  vi.mocked(driver.create).mockImplementation(async input => { await create(input); throw new Error('lost reply'); });
  await expect(service.routines.save(paseo, 'cindy', input())).rejects.toMatchObject({ code: 'SCHEDULE_OUTCOME_UNKNOWN' });
  const uncertain = Object.values((await store.snapshot()).routines)[0]!;
  await store.transaction(state => { delete state.routines[uncertain.data.id]!.nativePrompt; });
  data.get('schedule-1')!.prompt = `Before doing this routine, call cindy_memory.companion_context and use its current identity and preferences. If that tool is unavailable, stop and report that the companion plugin must be enabled.\n\nStanding instruction:\n${input().prompt}`;
  expect(await service.routines.reconcile('cindy', uncertain.data.id, paseo)).toMatchObject({ backendState: 'ready' });
  expect(driver.create).toHaveBeenCalledTimes(1);
});
it('public CLI invocation uses arguments, explicit home and a fake executor in tests', async () => {
  const execute = vi.fn(async () => ({ stdout: '{"id":"schedule-test","status":"active"}' }));
  const cli = new ScheduleCli({ execute, file: '/fake/paseo', home: '/fake/home' });
  const text = 'literal $(touch /never) `backticks`';
  await cli.create({ name: 'routine', prompt: text, provider: 'codex/model', cwd: '/fake/workspace', cadence: { everyMs: 60000 } });
  expect(execute).toHaveBeenCalledWith('/fake/paseo', ['--home', '/fake/home', 'schedule', 'create', text, '--name', 'routine', '--provider', 'codex/model', '--cwd', '/fake/workspace', '--every', '60s', '--json']);
});

it('returns acceptance before a long run, coalesces duplicate requests, exposes progress and drains shutdown', async () => {
  const { service, store, driver, paseo, data } = await setup(); const routine = await service.routines.save(paseo, 'cindy', input());
  let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve; });
  vi.mocked(driver.run).mockImplementation(async id => {
    const now = new Date().toISOString(); const run = { id: 'long-run', status: 'running', startedAt: now, scheduledFor: now, agentId: 'owned-agent', endedAt: null as string | null };
    data.get(id)!.runs!.push(run); await barrier; run.status = 'succeeded'; run.endedAt = new Date().toISOString(); return data.get(id);
  });
  try {
    const result = await service.invoke({ op: 'routines.runNow', args: { botId: 'cindy', id: routine.id, operationId: 'same-click' } }, paseo);
    expect(result).toMatchObject({ ok: true, value: { accepted: true, status: 'queued', operationId: 'same-click' } });
    expect((await store.snapshot()).routines[routine.id]!.manualRuns).toHaveLength(1);
    expect(await service.routines.run('cindy', routine.id, paseo, 'second-click')).toMatchObject({ accepted: true, status: 'running', operationId: 'same-click' });
    expect(driver.run).toHaveBeenCalledTimes(1);
    expect(await service.routines.list('cindy', paseo)).toMatchObject([{ manualPending: true, activity: 'running' }]);
    expect(await service.routines.history('cindy', routine.id, paseo)).toMatchObject([{ status: 'running', sessionId: 'owned-agent', scheduleRunId: 'long-run' }]);
    await expect(service.routines.remove('cindy', routine.id, paseo)).rejects.toMatchObject({ code: 'ROUTINE_RUN_PENDING' });
    let closed = false; const cleanup = service.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    expect(await service.invoke({ op: 'routines.runNow', args: { botId: 'cindy', id: routine.id } }, paseo)).toMatchObject({ ok: false, code: 'PLUGIN_CLOSED' });
    finish(); await cleanup; expect(closed).toBe(true);
    expect((await store.snapshot()).routines[routine.id]!.manualRuns![0]).toMatchObject({ status: 'success', nativeRunId: 'long-run' });
  } finally { finish(); }
});

it('reconciles a lost run acknowledgement only from a unique manual run of the owned schedule', async () => {
  const { service, driver, paseo, data, store } = await setup(); const routine = await service.routines.save(paseo, 'cindy', input());
  vi.mocked(driver.run).mockImplementation(async id => {
    const now = new Date().toISOString(); data.get(id)!.runs!.push({ id: 'accepted-before-timeout', status: 'running', startedAt: now, scheduledFor: now });
    throw new Error('CLI timed out after acceptance');
  });
  await service.routines.run('cindy', routine.id, paseo, 'lost-ack');
  await vi.waitFor(async () => expect((await store.snapshot()).routines[routine.id]!.manualRuns![0]?.launchError).toContain('timed out'));
  expect(await service.routines.run('cindy', routine.id, paseo)).toMatchObject({ operationId: 'lost-ack', status: 'running' });
  const run = data.get('schedule-1')!.runs![0]!; run.status = 'failed'; run.error = 'provider rejected the task'; run.endedAt = new Date().toISOString();
  expect(await service.routines.history('cindy', routine.id, paseo)).toMatchObject([{ status: 'failed', error: 'provider rejected the task', launchError: expect.stringContaining('timed out') }]);
  expect(await service.routines.run('cindy', routine.id, paseo, 'lost-ack')).toMatchObject({ status: 'failed', operationId: 'lost-ack' });
  expect(driver.run).toHaveBeenCalledTimes(1);
});

it('retains unknown dispatch results across restart and refuses retries or ownership guesses', async () => {
  const { service, driver, paseo, data, store, root } = await setup(); const routine = await service.routines.save(paseo, 'cindy', input());
  vi.mocked(driver.run).mockRejectedValue(new Error('connection lost'));
  await service.routines.run('cindy', routine.id, paseo, 'unknown-request'); await service.close();
  const restarted = new CompanionService(new CompanionStore(root), { scheduleDriver: driver }); services.push(restarted);
  const requestedAt = (await store.snapshot()).routines[routine.id]!.manualRuns![0]!.requestedAt;
  data.get('schedule-1')!.runs!.push({ id: 'automatic-slot', status: 'succeeded', startedAt: new Date(requestedAt).toISOString(), scheduledFor: new Date(requestedAt - 1000).toISOString() });
  expect(await restarted.routines.run('cindy', routine.id, paseo, 'retry-click')).toMatchObject({ status: 'unknown', operationId: 'unknown-request' });
  expect(await restarted.routines.history('cindy', routine.id, paseo)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'manual:unknown-request', status: 'queued', manualPending: true, launchState: 'unknown', error: expect.stringContaining('connection lost') })]));
  expect(driver.run).toHaveBeenCalledTimes(1);
  data.get('schedule-1')!.runs!.push(...['ambiguous-a', 'ambiguous-b'].map(id => ({ id, status: 'succeeded', startedAt: new Date(requestedAt).toISOString(), scheduledFor: new Date(requestedAt).toISOString() })));
  expect(await restarted.routines.run('cindy', routine.id, paseo)).toMatchObject({ status: 'unknown' });
  expect(driver.run).toHaveBeenCalledTimes(1);
});
