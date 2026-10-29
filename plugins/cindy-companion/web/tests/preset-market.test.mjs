import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const state = globalThis.__PRESET_MARKET_TEST__ = { owner: 'host-a', generation: 1, profiles: [], refreshed: 0, navigated: [] };
globalThis.window = { electronAPI: {} };
const web = new URL('..', import.meta.url).pathname;
const mocks = {
  '@radix-ui/react-dialog': `import {createElement} from 'react';const component=name=>({children,...props})=>createElement(name,props,children);export const Root=component('dialog-root'),Portal=component('dialog-portal'),Overlay=component('dialog-overlay'),Content=component('dialog-content'),Title=component('dialog-title'),Description=component('dialog-description'),Close=component('dialog-close');`,
  'react-router-dom': `export const useNavigate=()=>value=>globalThis.__PRESET_MARKET_TEST__.navigated.push(value);export const useParams=()=>({});`,
  'react-i18next': `const t=(key,values)=>key+(values?.name?':'+values.name:'');export const useTranslation=()=>({t,i18n:{language:'en',resolvedLanguage:'en'}});`,
  '@/components/ui/button': `import {createElement} from 'react';export const Button=({children,...props})=>createElement('button',props,children);`,
  '@/contexts/AuthContext': `export const useAuth=()=>({dataOwnerId:globalThis.__PRESET_MARKET_TEST__.owner});`,
  '@/contexts/dataOwnerGeneration': `export const getDataOwnerGeneration=()=>globalThis.__PRESET_MARKET_TEST__.generation;export const isDataOwnerGenerationCurrent=value=>value===globalThis.__PRESET_MARKET_TEST__.generation;`,
  '@/components/sidebar/sidebarNavigationPrefs': `import {Plug} from 'lucide-react';export const SIDEBAR_NAVIGATION_ITEM_ICONS={plugins:Plug};`,
  './botStore': `export const useBotProfiles=()=>globalThis.__PRESET_MARKET_TEST__.profiles;export const ensureBotProfilesLoaded=async()=>{globalThis.__PRESET_MARKET_TEST__.refreshed++;};`,
  './BotDeleteDialog': `export const BotDeleteDialog=()=>null;`,
  './botMarketDisplay': `export const bundledPluginNames={};export const botRoutineRhythm=()=>undefined;`,
  '@/lib/utils': `export const cn=(...values)=>values.filter(Boolean).join(' ');`,
};
const result = await build({
  stdin: { contents: `export {BotMarketDialog} from '../vendor/renderer/features/bots/BotMarketDialog';export {readNativeBotPackage} from '../server/presets/catalog';`, resolveDir: web, loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'lucide-react'],
  plugins: [{ name: 'market-platform-boundary', setup(builder) {
    builder.onResolve({filter: /.*/}, args => mocks[args.path] ? { path: args.path, namespace: 'mock' } : undefined);
    builder.onLoad({filter: /.*/, namespace: 'mock'}, args => ({ contents: mocks[args.path] }));
  } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { BotMarketDialog, readNativeBotPackage } = module.exports;
const originalEntry = (await readNativeBotPackage('engineer-bot')).entry;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const button = (renderer, label) => renderer.root.findAllByType('button').find(item => item.props.children === label);
const complete = { requestId: 'receipt-1', botId: 'teammate-1', saved: true, status: 'complete', checks: [] };
const render = async props => { let renderer; await act(async () => { renderer = create(React.createElement(BotMarketDialog, { onClose() {}, ...props })); }); return renderer; };

test('original market sends the selected package identity once and opens only the confirmed teammate', async () => {
  const pending = deferred(), calls = [], opened = [];
  const api = { list: async () => [originalEntry], invite: input => { calls.push(input); return pending.promise; }, status: async () => undefined };
  const renderer = await render({ api, onOpenBot: async id => opened.push(id) });
  assert.equal(renderer.root.findAllByProps({ 'data-open-detail': true })[0].props.children, originalEntry.locales.en.name);
  const invite = button(renderer, 'bots.market.invite');
  act(() => { invite.props.onClick(); invite.props.onClick(); });
  assert.deepEqual(calls, [{ packageId: originalEntry.packageId, packageVersion: originalEntry.packageVersion, packageHash: originalEntry.packageHash, locale: 'en' }]);
  assert.equal(opened.length, 0);
  await act(async () => pending.resolve(complete));
  assert.deepEqual(opened, ['teammate-1']);
  act(() => renderer.unmount());
});

test('partial saves retain original item names and retry the same package instead of claiming a completed install', async () => {
  let calls = 0; const opened = [];
  const api = { list: async () => [originalEntry], status: async () => undefined, invite: async () => { calls++; return { ...complete, status: 'needs-attention', checks: [{ entryId: 'skill-engineer-bot-ops', status: 'needs-attention', message: 'IO_ERROR' }] }; } };
  const renderer = await render({ api, onOpenBot: async id => opened.push(id) });
  await act(async () => button(renderer, 'bots.market.invite').props.onClick());
  const tree = JSON.stringify(renderer.toJSON(), (key, value) => key === 'src' ? '[image]' : value);
  assert.match(tree, /bots\.market\.partialReady/);
  assert.ok(tree.includes('bots.market.itemFailed.skill:' + originalEntry.locales.en.itemNames['skill-engineer-bot-ops']));
  assert.equal(opened.length, 0);
  assert.ok(button(renderer, 'bots.market.open'));
  await act(async () => button(renderer, 'bots.market.retry').props.onClick());
  assert.equal(calls, 2); assert.equal(opened.length, 0);
  act(() => renderer.unmount());
});

test('closing while invite is pending does not navigate when its receipt arrives', async () => {
  const pending = deferred(), opened = [];
  const api = { list: async () => [originalEntry], invite: () => pending.promise, status: async () => undefined };
  const renderer = await render({ api, onOpenBot: async id => opened.push(id) });
  act(() => button(renderer, 'bots.market.invite').props.onClick());
  act(() => renderer.unmount());
  await act(async () => pending.resolve(complete));
  assert.equal(opened.length, 0);
});

test('catalog response from the previous host is ignored after owner replacement', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const api = { list: () => (++count === 1 ? first.promise : second.promise), invite: async () => complete, status: async () => undefined };
  const renderer = await render({ api });
  state.owner = 'host-b'; state.generation++;
  await act(async () => renderer.update(React.createElement(BotMarketDialog, { api, onClose() {} })));
  await act(async () => first.resolve([originalEntry]));
  assert.equal(renderer.root.findAllByProps({ 'data-open-detail': true }).length, 0);
  await act(async () => second.resolve([]));
  assert.match(JSON.stringify(renderer.toJSON()), /bots\.market\.empty/);
  act(() => renderer.unmount());
});
