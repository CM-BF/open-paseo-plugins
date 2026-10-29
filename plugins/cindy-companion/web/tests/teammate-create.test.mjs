import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window = new EventTarget();
const state = globalThis.__TEAMMATE_CREATE_TEST__ = { owner: { dataOwnerId: 'host-a', generation: 1 }, profiles: [], defaultModelChain: [{ harness: 'codex', model: 'default' }], calls: [], posts: [] };
const web = new URL('..', import.meta.url).pathname;
const mocks = {
  dialog: `import {createElement} from 'react';const component=name=>({children,...props})=>createElement(name,props,children);export const Root=component('dialog-root'),Portal=component('dialog-portal'),Overlay=component('dialog-overlay'),Content=component('dialog-content'),Title=component('dialog-title');`,
  translation: `export const useTranslation=()=>({t:key=>key});`,
  button: `import {createElement} from 'react';export const Button=({children,...props})=>createElement('button',props,children);`,
  owner: `export const getDataOwnerGeneration=()=>globalThis.__TEAMMATE_CREATE_TEST__.owner;export const isDataOwnerGenerationCurrent=value=>value===globalThis.__TEAMMATE_CREATE_TEST__.owner;`,
  auth: `export const useAuth=()=>({dataOwnerId:globalThis.__TEAMMATE_CREATE_TEST__.owner.dataOwnerId});`,
  state: `export const snapshot=()=>globalThis.__TEAMMATE_CREATE_TEST__;export const useSnapshot=snapshot;export const subscribe=()=>()=>{};export const updateProfile=()=>{};export const refreshProfiles=()=>{};`,
  bridge: `export const invoke=(op,args)=>{const s=globalThis.__TEAMMATE_CREATE_TEST__;s.calls.push({op,args});return s.invoke(op,args);};export const post=(type,fields)=>globalThis.__TEAMMATE_CREATE_TEST__.posts.push({type,...fields});`,
  portrait: `import {createElement} from 'react';export const BOT_PORTRAIT_COUNT=17;export const galleryPortrait=async()=> 'data:image/png;base64,aW1hZ2U=';export const BotPortraitPicker=props=>createElement('portrait-picker',props);`,
  models: `import {createElement} from 'react';export const BotModelChainEditor=props=>createElement('model-picker',props);`,
  providers: `export const useProviders=()=>({providers:[],loaded:true});`,
  navigation: `export const useNavigate=()=>()=>{};`,
  notice: `export const showHostSettingsNotice=()=>{};`,
};
const result = await build({ entryPoints: [web + '/../vendor/renderer/features/bots/BotRosterView.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'lucide-react'],
  plugins: [{ name: 'original-roster-platform-boundary', setup(builder) {
    builder.onResolve({filter: /.*/}, args => {
      const p = args.path;
      const key = p === '@radix-ui/react-dialog' ? 'dialog' : p === 'react-i18next' ? 'translation' : p === 'react-router-dom' ? 'navigation'
        : /components\/ui\/button$/.test(p) ? 'button' : /dataOwnerGeneration$/.test(p) ? 'owner' : /AuthContext$/.test(p) ? 'auth'
        : p === '../state' ? 'state' : p === '../bridge' ? 'bridge' : /BotPortraitPicker$/.test(p) ? 'portrait'
        : /BotModelChainEditor$/.test(p) ? 'models' : /useProviders$/.test(p) ? 'providers' : /paseoHostStatus$/.test(p) ? 'notice' : null;
      if (key) return { path: key, namespace: 'mock' };
      if (p === './botStore') return { path: web + '/adapters/bot-store.ts' };
    });
    builder.onLoad({filter: /.*/, namespace: 'mock'}, args => ({ contents: mocks[args.path] }));
  } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { BotRosterView } = module.exports;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const reset = () => { state.calls = []; state.posts = []; state.profiles = []; state.defaultModelChain = [{ harness: 'codex', model: 'default' }]; };
const render = async props => { let renderer; await act(async () => { renderer = create(React.createElement(BotRosterView, props)); }); return renderer; };
const submit = renderer => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });

test('original create form sends portrait and model atomically, and ignores same-tick duplicate submit/close', async () => {
  reset(); const pending = deferred(), opened = [], closes = []; state.invoke = () => pending.promise;
  const renderer = await render({ onCreated: bot => opened.push(bot.id), onClose: () => closes.push(true) });
  act(() => renderer.root.findByType('input').props.onChange({ target: { value: '  My teammate  ' } }));
  const route = { harness: 'claude', model: 'actual-model', effort: 'medium', fastMode: false, providerId: null };
  act(() => renderer.root.findByType('model-picker').props.onChange([route]));
  act(() => { submit(renderer); submit(renderer); window.dispatchEvent(new Event('cindy-request-close')); });
  assert.equal(state.calls.length, 1); assert.equal(state.calls[0].op, 'profile.create');
  assert.deepEqual({ ...state.calls[0].args, operationId: undefined }, { operationId: undefined, name: 'My teammate', description: '', avatarImageBase64: 'aW1hZ2U=', capabilities: { modelChainOverride: [route] } });
  assert.deepEqual(closes, []); assert.deepEqual(opened, []);
  await act(async () => pending.resolve({ profile: { id: 'created' } }));
  assert.deepEqual(opened, ['created']); assert.deepEqual(closes, []);
  act(() => renderer.unmount());
});

test('creation retries keep the same operation id and preserve fields after host failure', async () => {
  reset(); let attempt = 0; state.invoke = async () => { if (++attempt === 1) throw new Error('failed'); return { profile: { id: 'retry-profile' } }; };
  const renderer = await render({ onCreated() {}, onClose() {} });
  act(() => renderer.root.findByType('input').props.onChange({ target: { value: 'Retry' } }));
  await act(async () => submit(renderer)); assert.equal(renderer.root.findByType('input').props.value, 'Retry');
  assert.match(JSON.stringify(renderer.toJSON()), /bots.createWizard.createFailed/);
  await act(async () => submit(renderer)); assert.deepEqual(state.calls[0], state.calls[1]);
  act(() => renderer.unmount());
});

test('host replacement and unmount prevent a late profile receipt from navigating', async () => {
  reset(); const pending = deferred(), opened = []; state.invoke = () => pending.promise;
  const renderer = await render({ onCreated: bot => opened.push(bot.id), onClose() {} });
  act(() => renderer.root.findByType('input').props.onChange({ target: { value: 'Old host' } }));
  act(() => submit(renderer)); state.owner = { dataOwnerId: 'host-b', generation: 2 };
  act(() => renderer.unmount()); await act(async () => pending.resolve({ profile: { id: 'old-host-profile' } }));
  assert.deepEqual(opened, []); assert.deepEqual(state.posts, []);
});

test('portrait preparation and absent model prevent creating a misleading default profile', async () => {
  reset(); state.defaultModelChain = []; state.invoke = async () => { throw new Error('must not run'); };
  const renderer = await render({ onCreated() {}, onClose() {} });
  act(() => renderer.root.findByType('input').props.onChange({ target: { value: 'No model' } }));
  act(() => renderer.root.findByType('portrait-picker').props.onPreparingChange(true));
  await act(async () => submit(renderer)); assert.equal(state.calls.length, 0);
  act(() => renderer.root.findByType('portrait-picker').props.onPreparingChange(false));
  await act(async () => submit(renderer)); assert.equal(state.calls.length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /bots.guided.modelRequired/);
  act(() => renderer.unmount());
});
