import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';

// Exercise real component hooks and event handlers. Only the RN/host boundary is
// mocked; these tests are independent of (and do not replace) live Paseo UI tests.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const require = createRequire(import.meta.url);
const listeners = new Map();
globalThis.window = {
  addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
  removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
};
const emit = (type, event) => { for (const listener of [...(listeners.get(type) ?? [])]) listener(event); };
const data = globalThis.__CINDY_HOST_TEST__ = {};
async function loadComponent(path, sidebar = false) {
  const result = await build({
    entryPoints: [new URL(`../../client/${path}`, import.meta.url).pathname],
    bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    plugins: [{ name: 'mock-host-boundary', setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: 'rn', namespace: 'host-mock' }));
      if (sidebar) builder.onResolve({ filter: /^\.\/(data|settings|web)$/ }, ({ path }) => ({ path, namespace: 'host-mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'host-mock' }, ({ path }) => ({ contents: path === 'rn'
        ? `export const Platform={OS:'web'}; export const ActivityIndicator='ActivityIndicator',Image='Image',Pressable='Pressable',Text='Text',TextInput='TextInput',View='View';`
        : path === './data' ? `export const useCompanions=id=>globalThis.__CINDY_HOST_TEST__.rosters[id]; export const useSettingsInvoke=id=>globalThis.__CINDY_HOST_TEST__.invokes[id];`
        : path === './settings' ? `import {createElement} from 'react'; export const CompanionSettings=props=>createElement('Settings',props);`
        : `import {createElement} from 'react'; export const canRenderSettingsFrame=true; export const AvatarContext=({children,onOpen})=>createElement('AvatarContext',{onOpen},children);`,
      }));
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const { Teammates } = await loadComponent('sidebar.tsx', true);
const { SettingsFrame } = await loadComponent('web.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const success = agentId => ({ ok: true, value: { agentId } });
const theme = { colors: { foreground: '#fff', foregroundMuted: '#888', surface0: '#181818', statusDanger: '#f00', border: '#333' } };
const bot = { id: 'cindy', name: 'Cindy', avatar: 'cindy://avatar/preset/dash', avatarColor: 'violet', status: 'active' };
function setupSidebar() {
  const calls = [], navigations = [], popovers = [];
  data.rosters = Object.fromEntries(['a', 'b'].map(id => [id, { data: { profiles: [bot] }, isPending: false }]));
  data.invokes = Object.fromEntries(['a', 'b'].map(id => [id, (op, args) => {
    const pending = deferred(); calls.push({ host: id, op, args, ...pending }); return pending.promise;
  }]));
  const props = id => ({ host: { id, label: id }, theme, layout: { compact: false }, onProfiles() {},
    navigation: { openAgent: value => navigations.push(value) }, openScreen() { assert.fail('Unexpected compatibility route'); },
    openPopover: Content => popovers.push(Content) });
  return { calls, navigations, popovers, props };
}
const button = (renderer, label) => renderer.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === label);
const textButton = (renderer, text) => renderer.root.findAllByType('Pressable').find(node => node.findAllByType('Text').some(child => child.props.children === text));
const flush = () => act(async () => { await Promise.resolve(); });

test('sidebar prevents same-tick duplicate chat and discards old-host completion without unlocking the new request', async () => {
  const state = setupSidebar(); let renderer;
  await act(async () => { renderer = create(React.createElement(Teammates, state.props('a'))); });
  act(() => { const press = button(renderer, 'Cindy').props.onPress; press(); press(); });
  assert.equal(state.calls.length, 1);
  assert.match(renderer.root.findByType('Image').props.source.uri, /^data:image\/png;base64,/);
  act(() => renderer.update(React.createElement(Teammates, state.props('b'))));
  act(() => button(renderer, 'Cindy').props.onPress());
  assert.equal(state.calls.length, 2);
  await act(async () => { state.calls[0].resolve(success('old')); });
  assert.deepEqual(state.navigations, []);
  assert.equal(button(renderer, 'Cindy').props.accessibilityState.busy, true);
  await act(async () => { state.calls[1].resolve(success('new')); });
  assert.deepEqual(state.navigations, [{ agentId: 'new', serverId: 'b' }]);
  act(() => renderer.unmount());
});

test('a context menu retained across a host switch cannot start chat or settings on the previous host', async () => {
  const state = setupSidebar(); let renderer, menu; let closes = 0;
  await act(async () => { renderer = create(React.createElement(Teammates, state.props('a'))); });
  act(() => button(renderer, 'Cindy').props.onLongPress());
  await act(async () => { menu = create(React.createElement(state.popovers[0], { host: { id: 'a' }, theme, close() { closes++; } })); });
  act(() => renderer.update(React.createElement(Teammates, state.props('b'))));
  act(() => { textButton(menu, 'Chat').props.onPress(); textButton(menu, 'Settings').props.onPress(); });
  await flush();
  assert.equal(closes, 2); assert.equal(state.calls.length, 0);
  assert.equal(renderer.root.findAllByType('Settings').length, 0);
  act(() => { menu.unmount(); renderer.unmount(); });
});

test('the teammate ring follows native navigation when the host provides currentAgentId', async () => {
  const state = setupSidebar(); let renderer;
  data.rosters.a.data.profiles = [{ ...bot, canonicalSessionId: 'canonical', sessions: [{ id: 'history' }] }];
  const props = currentAgentId => ({ ...state.props('a'), currentAgentId });
  await act(async () => { renderer = create(React.createElement(Teammates, props('canonical'))); });
  assert.equal(button(renderer, 'Cindy').props.accessibilityState.selected, true);
  for (const [id, selected] of [['history', true], ['unrelated', false], [null, false]]) {
    act(() => renderer.update(React.createElement(Teammates, props(id))));
    assert.equal(button(renderer, 'Cindy').props.accessibilityState.selected, selected);
  }
  act(() => button(renderer, 'Cindy').props.onPress());
  await act(async () => { state.calls[0].resolve(success('canonical')); });
  assert.equal(button(renderer, 'Cindy').props.accessibilityState.selected, false);
  act(() => renderer.update(React.createElement(Teammates, state.props('a'))));
  assert.equal(button(renderer, 'Cindy').props.accessibilityState.selected, true);
  act(() => renderer.unmount());
});

test('create uses one operation id for retries, blocks double submit and drops callbacks after host change/unmount', async () => {
  const state = setupSidebar(); let renderer, editor; let closes = 0;
  await act(async () => { renderer = create(React.createElement(Teammates, state.props('a'))); });
  act(() => button(renderer, 'Create teammate').props.onPress());
  const Content = state.popovers[0]; const props = id => ({ host: { id }, theme, close() { closes++; } });
  await act(async () => { editor = create(React.createElement(Content, props('a'))); });
  act(() => editor.root.findByType('TextInput').props.onChangeText('  Alice  '));
  act(() => { const press = textButton(editor, 'Create').props.onPress; press(); press(); });
  assert.equal(state.calls.length, 1); assert.equal(state.calls[0].args.name, 'Alice');
  await act(async () => { state.calls[0].reject(new Error('Temporary offline')); });
  act(() => textButton(editor, 'Create').props.onPress());
  assert.equal(state.calls[1].args.operationId, state.calls[0].args.operationId);
  act(() => editor.update(React.createElement(Content, props('b'))));
  await act(async () => { state.calls[1].resolve(success('old')); });
  assert.equal(closes, 0);
  act(() => textButton(editor, 'Create').props.onPress());
  assert.equal(state.calls[2].host, 'b');
  assert.notEqual(state.calls[2].args.operationId, state.calls[1].args.operationId);
  act(() => editor.unmount());
  await act(async () => { state.calls[2].resolve(success('new')); });
  assert.equal(closes, 0);
  act(() => renderer.unmount());
});

function setupFrame() {
  const nodes = [], calls = [], events = [];
  const invokes = Object.fromEntries(['a', 'b'].map(id => [id, (op, args) => {
    const pending = deferred(); calls.push({ host: id, op, args, ...pending }); return pending.promise;
  }]));
  const props = (host, botId = 'cindy') => ({ document: '<html></html>', init: { botId, host: { id: host, label: host }, theme: 'dark', locale: 'en' },
    invoke: invokes[host], onClose: () => events.push('close'), onChanged: () => events.push('changed'), onNavigateAgent: id => events.push(id),
    onHandle: handle => events.push(handle), onReady: () => events.push('ready') });
  const createNodeMock = element => {
    if (element.type !== 'iframe') return null;
    const messages = []; const contentWindow = { postMessage: value => messages.push(value) };
    const node = { contentWindow, messages }; nodes.push(node); return node;
  };
  const send = (node, message) => emit('message', { source: node.contentWindow, data: { channel: 'cindy-companion', ...message } });
  return { nodes, calls, events, props, createNodeMock, send };
}

test('frame remounts for a new host, rejects old sources and suppresses old pending responses', async () => {
  const state = setupFrame(); let renderer;
  await act(async () => { renderer = create(React.createElement(SettingsFrame, state.props('a')), { createNodeMock: state.createNodeMock }); });
  const old = state.nodes.at(-1);
  act(() => state.send(old, { type: 'ready' }));
  assert.equal(old.messages[0].host.id, 'a');
  state.send({ contentWindow: {} }, { type: 'request', id: 'foreign', op: 'profile.update', args: {} });
  state.send(old, { type: 'request', id: 'save', op: 'profile.update', args: { botId: 'cindy' } });
  await flush(); assert.equal(state.calls.length, 1); assert.equal(state.calls[0].host, 'a');
  act(() => renderer.update(React.createElement(SettingsFrame, state.props('b'))));
  const current = state.nodes.at(-1); assert.notEqual(current, old);
  act(() => { state.send(current, { type: 'ready' }); state.send(old, { type: 'close' }); });
  assert.equal(current.messages[0].host.id, 'b');
  await act(async () => state.calls[0].resolve(success('old')));
  assert.equal(old.messages.length, 1); assert.equal(current.messages.length, 1);
  assert.equal(state.events.includes('close'), false);
  state.send(current, { type: 'request', id: 'save', op: 'profile.update', args: { botId: 'cindy' } });
  await flush(); assert.equal(state.calls[1].host, 'b');
  await act(async () => state.calls[1].resolve(success('new')));
  assert.equal(current.messages[1].id, 'save');
  act(() => renderer.unmount()); assert.equal(listeners.get('message').size, 0);
});

test('frame captures the request invoke and cancels requests that have not started before disposal', async () => {
  const state = setupFrame(); let renderer;
  await act(async () => { renderer = create(React.createElement(SettingsFrame, state.props('a')), { createNodeMock: state.createNodeMock }); });
  const old = state.nodes.at(-1);
  act(() => {
    state.send(old, { type: 'request', id: 'queued', op: 'profile.update', args: {} });
    renderer.update(React.createElement(SettingsFrame, state.props('b')));
  });
  await flush(); assert.equal(state.calls.length, 0);
  const current = state.nodes.at(-1);
  act(() => {
    state.send(current, { type: 'request', id: 'captured', op: 'profile.update', args: {} });
    renderer.update(React.createElement(SettingsFrame, { ...state.props('b'), invoke: state.props('a').invoke }));
  });
  await flush(); assert.equal(state.calls.length, 1); assert.equal(state.calls[0].host, 'b');
  await act(async () => state.calls[0].resolve(success('new')));
  act(() => renderer.unmount());
});

test('ready frame Escape asks the original page to flush before the host closes', async () => {
  const state = setupFrame(); let renderer; let prevented = false;
  await act(async () => { renderer = create(React.createElement(SettingsFrame, state.props('a')), { createNodeMock: state.createNodeMock }); });
  const node = state.nodes.at(-1);
  act(() => state.send(node, { type: 'ready' }));
  act(() => emit('keydown', { key: 'Escape', preventDefault() { prevented = true; } }));
  assert.equal(prevented, true); assert.equal(node.messages.at(-1).type, 'request-close');
  assert.equal(state.events.includes('close'), false);
  act(() => state.send(node, { type: 'close' }));
  assert.equal(state.events.at(-1), 'close');
  act(() => renderer.unmount());
});
