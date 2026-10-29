import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { act, create } from 'react-test-renderer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const state = globalThis.__LINKED_PROJECTS_TEST__ = { owner: { hostId: 'host-a', botId: 'one', generation: 1 }, calls: [] };
const web = new URL('..', import.meta.url).pathname;
const mocks = {
  controls: `import {createElement} from 'react';const c=tag=>({children,...props})=>createElement(tag,props,children);export const Button=c('button'),Select=c('project-select'),Spinner=c('spinner');`,
  tooltip: `export const Tip=({children})=>children;`,
  translation: `export const useBotTranslation=()=>({t:(key,args)=>key+(args?.name?':'+args.name:args?.device?':'+args.device:'')});`,
  owner: `export const getDataOwnerGeneration=()=>globalThis.__LINKED_PROJECTS_TEST__.owner;export const isDataOwnerGenerationCurrent=value=>value===globalThis.__LINKED_PROJECTS_TEST__.owner;`,
};
const bundle = await build({ stdin: { contents: `export {BotProjectsSettings} from '../vendor/renderer/features/bots/BotProjectsSettings';export {createLinkedProjectsAdapter} from './adapters/linked-projects';`, resolveDir: web },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'lucide-react'],
  plugins: [{ name: 'project-platform-boundary', setup(b) {
    b.onResolve({ filter: /.*/ }, ({ path }) => {
      const key = /components\/ui\/(button|select|spinner)$/.test(path) ? 'controls'
        : path.endsWith('/tooltip') ? 'tooltip' : path.endsWith('/botPronounContext') ? 'translation'
        : path.endsWith('/dataOwnerGeneration') ? 'owner' : null;
      if (key) return { path: key, namespace: 'mock' };
    });
    b.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: mocks[path] }));
  } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { BotProjectsSettings, createLinkedProjectsAdapter } = module.exports;
const row = (id, extra = {}) => ({ id, name: id, path: `/projects/${id}`, linked: false, available: true, ...extra });
const page = (projects = [row('available')], revision = 'rev-1') => ({ projects, revision });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function reset() {
  state.owner = { hostId: 'host-a', botId: 'one', generation: state.owner.generation + 1 }; state.calls = [];
  state.invoke = async () => page();
  const api = createLinkedProjectsAdapter((op, args) => { state.calls.push({ op, args, owner: state.owner }); return state.invoke(op, args); }, () => state.owner);
  globalThis.window = { electronAPI: { localDb: { bots: { projects: api } }, maker: { onBotWorkbenchChanged: api.onChanged } } };
  return api;
}
async function render() { let tree; await act(async () => { tree = create(React.createElement(BotProjectsSettings, { botId: 'one' })); }); return tree; }
const text = tree => JSON.stringify(tree.toJSON());
const add = tree => tree.root.findAllByType('button').find(node => Array.isArray(node.props.children));
const reload = tree => tree.root.findAllByType('button').find(node => node.props.children === 'bots.memory.useLatest');
const remove = (tree, name) => tree.root.findByProps({ 'aria-label': `bots.projects.remove:${name}` });

test('the original page keeps unavailable/foreign links removable and only offers available unlinked directories', async () => {
  reset(); state.invoke = async () => page([row('missing', { linked: true, available: false }), row('foreign', { linked: true, available: false, deviceId: 'other-host' }), row('available'), row('gone', { available: false })]);
  const tree = await render();
  try {
    assert.deepEqual(tree.root.findByType('project-select').props.options, [{ value: 'available', label: 'available', title: '/projects/available' }]);
    assert.equal(remove(tree, 'missing').props.disabled, false); assert.equal(remove(tree, 'foreign').props.disabled, false);
    assert.match(text(tree), /bots.projects.unavailable/); assert.match(text(tree), /bots.projects.otherComputer:other-host/);
    assert.equal(tree.root.findAllByType('li').length, 2);
    assert.equal(tree.root.findAllByType('a').length, 0);
    assert.equal(tree.root.findByType('project-select').props.className, 'min-w-0 flex-1');
    assert(tree.root.findAllByType('p').filter(node => node.props.children?.startsWith?.('/projects/')).every(node => node.props.className.includes('break-all')));
    assert.deepEqual(state.calls.map(x => x.op), ['projects.list']);
  } finally { act(() => tree.unmount()); }
});

test('actual Add waits for the server receipt and same-tick clicks send one CAS write', async () => {
  reset(); const tree = await render(); const pending = deferred(); state.invoke = () => pending.promise;
  try {
    act(() => tree.root.findByType('project-select').props.onValueChange('available'));
    const click = add(tree).props.onClick;
    act(() => { click(); click(); });
    assert.equal(state.calls.length, 2);
    assert.deepEqual(state.calls[1].args, { botId: 'one', projectId: 'available', linked: true, expectedRevision: 'rev-1' });
    assert.equal(tree.root.findAllByType('li').length, 0); assert.equal(add(tree).props.disabled, true);
    await act(async () => pending.resolve(page([row('available', { linked: true })], 'rev-2')));
    assert.equal(tree.root.findAllByType('li').length, 1); assert.equal(tree.root.findByType('project-select').props.value, '');
    assert.equal(state.calls.length, 2, 'own change notification must not trigger a duplicate read during the write');
  } finally { act(() => tree.unmount()); }
});

test('a lost write ACK keeps the old list, disables mutations, and only explicit Reload restores fresh CAS state', async () => {
  const api = reset(); state.invoke = async () => page([row('linked', { linked: true }), row('available')]);
  const tree = await render();
  try {
    state.invoke = async () => { throw Object.assign(new Error('ACK lost'), { code: 'TIMEOUT' }); };
    await act(async () => remove(tree, 'linked').props.onClick());
    assert.equal(tree.root.findAllByType('li').length, 1); assert.match(text(tree), /bots.projects.failed/);
    assert.equal(remove(tree, 'linked').props.disabled, true); assert.equal(add(tree).props.disabled, true);
    assert.equal(tree.root.findByType('project-select').props.disabled, true); assert.equal(reload(tree).props.disabled, false);
    await assert.rejects(api.set('one', 'linked', false), /Reload linked projects/);
    assert.equal(state.calls.length, 2, 'no automatic or stale-version retry');
    state.invoke = async () => page([row('linked'), row('available')], 'rev-2');
    await act(async () => reload(tree).props.onClick());
    assert.equal(tree.root.findAllByType('li').length, 0); assert.equal(reload(tree), undefined);
    assert.deepEqual(state.calls.map(x => x.op), ['projects.list', 'projects.set', 'projects.list']);
    act(() => tree.root.findByType('project-select').props.onValueChange('linked'));
    state.invoke = async () => page([row('linked', { linked: true }), row('available')], 'rev-3');
    await act(async () => add(tree).props.onClick());
    assert.equal(state.calls[3].args.expectedRevision, 'rev-2');
    assert.equal('operationId' in state.calls[3].args, false);
  } finally { act(() => tree.unmount()); }
});

test('failed Reload retains existing links and leaves all writes fenced', async () => {
  const api = reset(); state.invoke = async () => page([row('linked', { linked: true })]); const tree = await render();
  try {
    state.invoke = async () => { throw new Error('offline'); };
    await act(async () => remove(tree, 'linked').props.onClick());
    await act(async () => reload(tree).props.onClick());
    assert.equal(tree.root.findAllByType('li').length, 1); assert.equal(remove(tree, 'linked').props.disabled, true);
    await assert.rejects(api.set('one', 'linked', false), /Reload linked projects/);
    assert.deepEqual(state.calls.map(x => x.op), ['projects.list', 'projects.set', 'projects.list']);
  } finally { act(() => tree.unmount()); }
});

test('late old-host reads and writes neither notify nor replace the new host revision', async () => {
  for (const op of ['list', 'set']) {
    const api = reset(); await api.list('one'); let changes = 0; const unsubscribe = api.onChanged(() => changes++);
    const old = deferred(); state.invoke = () => old.promise;
    const request = op === 'list' ? api.list('one') : api.set('one', 'available', true);
    const rejected = assert.rejects(request, /selected teammate changed/);
    state.owner = { hostId: 'host-b', botId: 'one', generation: state.owner.generation + 1 };
    state.invoke = async () => page([row('host-b')], 'host-b-revision'); await api.list('one');
    old.resolve(page([row('host-a')], 'old-revision')); await rejected;
    assert.equal(changes, 0);
    await api.set('one', 'host-b', true); assert.equal(state.calls.at(-1).args.expectedRevision, 'host-b-revision');
    assert.equal(changes, 0); unsubscribe();
  }
});

test('the mounted original component rejects retained callbacks after host change or unmount', async () => {
  reset(); state.invoke = async () => page([row('linked', { linked: true })]); const tree = await render();
  const click = remove(tree, 'linked').props.onClick;
  state.owner = { hostId: 'host-b', botId: 'one', generation: state.owner.generation + 1 };
  act(() => click()); assert.equal(state.calls.length, 1);
  act(() => tree.unmount()); act(() => click()); assert.equal(state.calls.length, 1);
});

test('unmounted source views discard delayed lists and saves without issuing replacement requests', async () => {
  for (const op of ['list', 'set']) {
    reset(); const late = deferred();
    state.invoke = op === 'list' ? () => late.promise : async () => page([row('linked', { linked: true })]);
    const tree = await render();
    if (op === 'set') { state.invoke = () => late.promise; act(() => remove(tree, 'linked').props.onClick()); }
    act(() => tree.unmount());
    await act(async () => late.resolve(page([row('late')], 'late')));
    assert.equal(state.calls.length, op === 'list' ? 1 : 2);
  }
});

test('overlapping reads cannot restore an older revision or send while the latest list is pending', async () => {
  const api = reset(); const older = deferred(), newer = deferred(); let count = 0;
  state.invoke = () => (++count === 1 ? older.promise : newer.promise);
  const first = api.list('one'), firstRejected = assert.rejects(first, /selected teammate changed/);
  const second = api.list('one'); await assert.rejects(api.set('one', 'available', true), /Reload linked projects/);
  newer.resolve(page([], 'new')); await second; older.resolve(page([], 'old')); await firstRejected;
  state.invoke = async () => page([], 'next'); await api.set('one', 'available', true);
  assert.equal(state.calls.at(-1).args.expectedRevision, 'new');
});

test('invalid receipts and wrong-companion calls never establish a writable revision', async () => {
  const api = reset();
  await assert.rejects(api.list('other'), /teammate changed/); assert.equal(state.calls.length, 0);
  for (const invalid of [page([], ''), page([row('same'), row('same')]), page([row('bad', { linked: 'yes' })])]) {
    state.invoke = async () => invalid; await assert.rejects(api.list('one'), /invalid linked project list/);
    const calls = state.calls.length; await assert.rejects(api.set('one', 'same', true), /Reload linked projects/); assert.equal(state.calls.length, calls);
  }
});

test('the actual Electron shim exposes the original array API and only confirmed scoped change events', async () => {
  reset();
  const seams = {
    bridge: `export const initValue=()=>{const o=globalThis.__LINKED_PROJECTS_TEST__.owner;return o?{host:{id:o.hostId},botId:o.botId}:null;};export class BridgeError extends Error{};export const invoke=(op,args)=>{const s=globalThis.__LINKED_PROJECTS_TEST__;s.calls.push({op,args});return s.invoke(op,args);};`,
    settings: `export const currentBotId=()=>globalThis.__LINKED_PROJECTS_TEST__.owner.botId;export const onRoutinesChanged=()=>()=>{};`,
    presets: `export const presetApi={};`,
    owner: mocks.owner,
  };
  const loaded = await build({ entryPoints: [web + '/electron.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'electron-host-seams', setup(b) {
    b.onResolve({ filter: /.*/ }, ({ path }) => {
      const key = path === './bridge' ? 'bridge' : path === './adapters/settings-target' ? 'settings'
        : path === './adapters/presets' ? 'presets' : path.endsWith('/dataOwnerGeneration') ? 'owner' : null;
      if (key) return { path: key, namespace: 'seam' };
    });
    b.onLoad({ filter: /.*/, namespace: 'seam' }, ({ path }) => ({ contents: seams[path] }));
  } }] });
  globalThis.window = {};
  new Function(loaded.outputFiles[0].text)();
  const { localDb: { bots: { projects } }, maker } = window.electronAPI;
  let changes = 0; const unsubscribe = maker.onBotWorkbenchChanged(({ botId }) => { assert.equal(botId, 'one'); changes++; });
  assert.deepEqual(await projects.list('one'), [row('available')]);
  state.invoke = async () => page([row('available', { linked: true })], 'rev-2');
  assert.deepEqual(await projects.set('one', 'available', true), [row('available', { linked: true })]);
  assert.equal(changes, 1);
  unsubscribe(); await projects.set('one', 'available', false); assert.equal(changes, 1);
  assert.deepEqual(state.calls.map(x => x.op), ['projects.list', 'projects.set', 'projects.set']);
  assert.equal(state.calls.at(-1).args.expectedRevision, 'rev-2');
});
