import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const state = globalThis.__CINDY_OPENING_TEST__ = {};
const result = await build({ entryPoints: [new URL('../../client/opening.tsx', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'host', setup(builder) {
    builder.onResolve({ filter: /^(react-native|@getpaseo\/plugin\/client|\.\/data)$/ }, ({ path }) => ({ path, namespace: 'host' }));
    builder.onLoad({ filter: /.*/, namespace: 'host' }, ({ path }) => ({ contents: path === 'react-native'
      ? `export const Pressable='Pressable',Text='Text',View='View';`
      : path === './data' ? `export const useSettingsInvoke=id=>globalThis.__CINDY_OPENING_TEST__.invokes[id];`
      : `export const usePaseo=()=>globalThis.__CINDY_OPENING_TEST__.paseo;` }));
  } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { PresetOpening } = module.exports;
const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const ok = value => ({ ok: true, value });
const available = { available: true, selected: false, uncertain: false };
const selected = { available: false, selected: true, uncertain: false };
const props = host => ({ host: { id: host }, agentId: `agent-${host}`, item: { data: { botId: 'bot', name: 'Bot', greeting: 'Hello', options: ['Start here'] } },
  theme: { colors: { foreground: '#fff', foregroundMuted: '#aaa', surface1: '#333' } } });
function setup() {
  const calls = [], subscriptions = [];
  state.invokes = Object.fromEntries(['a', 'b'].map(host => [host, (op, args) => {
    const pending = defer(); calls.push({ host, op, args, ...pending }); return pending.promise;
  }]));
  state.paseo = { agents: { ref: () => ({ timeline: { subscribe: fn => {
    const ready = defer(); const subscription = { fn, active: true, ...ready }; subscriptions.push(subscription);
    const close = () => { subscription.active = false; }; close.ready = ready.promise; return close;
  } } }) } };
  return { calls, subscriptions };
}
const findChoice = renderer => renderer.root.findAllByType('Pressable').find(button => button.findAllByType('Text').some(text => text.props.children === 'Start here'));

test('starter buttons wait for history, send once, and ignore a status response predating the choice', async () => {
  const { calls, subscriptions } = setup(); let renderer;
  await act(async () => { renderer = create(React.createElement(PresetOpening, props('a'))); });
  assert.equal(findChoice(renderer), undefined); assert.equal(calls.length, 1);
  await act(async () => calls[0].resolve(ok(available)));
  act(() => subscriptions[0].fn({ event: { type: 'timeline' } }));
  assert.equal(calls[1].op, 'preset.opening.status');
  act(() => { const press = findChoice(renderer).props.onPress; press(); press(); });
  assert.equal(calls.filter(call => call.op === 'preset.opening.choose').length, 1);
  await act(async () => calls[2].resolve(ok(selected)));
  assert.equal(findChoice(renderer), undefined);
  await act(async () => calls[1].resolve(ok(available)));
  assert.equal(findChoice(renderer), undefined);
  act(() => renderer.unmount()); assert.equal(subscriptions[0].active, false);
});

test('host replacement drops an old choice callback and a real user-message refresh hides new-host choices', async () => {
  const { calls, subscriptions } = setup(); let renderer;
  await act(async () => { renderer = create(React.createElement(PresetOpening, props('a'))); });
  await act(async () => calls[0].resolve(ok(available)));
  const stalePress = findChoice(renderer).props.onPress;
  act(() => stalePress());
  act(() => renderer.update(React.createElement(PresetOpening, props('b'))));
  assert.equal(subscriptions[0].active, false); assert.equal(calls[2].host, 'b');
  await act(async () => calls[2].resolve(ok(available)));
  act(() => stalePress());
  assert.equal(calls.length, 3);
  await act(async () => calls[1].resolve(ok(selected)));
  assert.ok(findChoice(renderer));
  act(() => subscriptions[1].fn({ event: { type: 'timeline', item: { type: 'user_message' } } }));
  await act(async () => calls[3].resolve(ok({ available: false, selected: false, uncertain: false })));
  assert.equal(findChoice(renderer), undefined);
  act(() => renderer.unmount()); assert.equal(subscriptions[1].active, false);
});

test('a status read begun while choosing cannot restore options after the choice is acknowledged', async () => {
  const { calls, subscriptions } = setup(); let renderer;
  await act(async () => { renderer = create(React.createElement(PresetOpening, props('a'))); });
  await act(async () => calls[0].resolve(ok(available)));
  act(() => findChoice(renderer).props.onPress());
  act(() => subscriptions[0].fn({ event: { type: 'timeline' } }));
  assert.equal(calls[1].op, 'preset.opening.choose'); assert.equal(calls[2].op, 'preset.opening.status');
  await act(async () => calls[1].resolve(ok(selected)));
  await act(async () => calls[2].resolve(ok(available)));
  assert.equal(findChoice(renderer), undefined);
  act(() => renderer.unmount());
});
