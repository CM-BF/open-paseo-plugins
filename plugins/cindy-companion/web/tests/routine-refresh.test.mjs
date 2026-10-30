import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: [new URL('../adapters/routine-refresh.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const { createRoutineRefresh } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const settle = () => new Promise(resolve => setImmediate(resolve));

test('pending work refreshes only while subscribed and stops after true completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = []; let changes = 0;
  const refresh = createRoutineRefresh(async (op, args) => { calls.push({ op, args }); return [{ status: 'success' }]; });
  refresh.track('routines.history', { botId: 'cindy', id: 'routine' }, [{ status: 'running' }]);
  t.mock.timers.tick(6000); await settle(); assert.equal(calls.length, 0);
  const unsubscribe = refresh.subscribe(() => changes++);
  t.mock.timers.tick(2999); await settle(); assert.equal(calls.length, 0);
  t.mock.timers.tick(1); await settle(); assert.equal(calls.length, 1); assert.equal(changes, 1);
  t.mock.timers.tick(6000); await settle(); assert.equal(calls.length, 1); unsubscribe();
});

test('accepted and unknown manual runs remain pending; polling never sends another runNow', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const refresh = createRoutineRefresh(async (op) => { calls.push(op); return [{ status: 'queued', manualPending: true, launchState: 'unknown', error: 'Awaiting reconciliation' }]; });
  const unsubscribe = refresh.subscribe(() => {});
  refresh.accepted('cindy', 'routine', { accepted: true, status: 'queued' });
  t.mock.timers.tick(3000); await settle(); t.mock.timers.tick(3000); await settle();
  assert.deepEqual(calls, ['routines.history', 'routines.history']);
  unsubscribe(); t.mock.timers.tick(9000); await settle(); assert.equal(calls.length, 2);
});

test('late status responses after unsubscribe neither refresh nor rearm polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve, changes = 0, calls = 0;
  const refresh = createRoutineRefresh(() => { calls++; return new Promise(done => { resolve = done; }); });
  const unsubscribe = refresh.subscribe(() => changes++);
  refresh.track('routines.list', { botId: 'cindy' }, [{ activity: 'running' }]);
  t.mock.timers.tick(3000); await settle(); unsubscribe(); resolve([{ activity: 'running' }]); await settle();
  t.mock.timers.tick(9000); await settle(); assert.equal(changes, 0); assert.equal(calls, 1);
});
