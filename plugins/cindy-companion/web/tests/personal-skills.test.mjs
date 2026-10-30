import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { act, create } from 'react-test-renderer';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const state = globalThis.__PERSONAL_SKILLS_TEST__ = { calls: [], catalogCalls: [], owner: { dataOwnerId: 'a', generation: 1 } };
const web = new URL('..', import.meta.url).pathname;
const mocks = {
  controls: `import {createElement} from 'react';const control=tag=>({children,...props})=>createElement(tag,props,children);export const Button=control('button'),Input=control('input'),Switch=control('switch');`,
  translation: `export const useBotTranslation=()=>({t:(key,vars)=>key+(vars?.total!==undefined?':'+vars.count+'/'+vars.total:'')});`,
  owner: `export const getDataOwnerGeneration=()=>globalThis.__PERSONAL_SKILLS_TEST__.owner;export const isDataOwnerGenerationCurrent=value=>value===globalThis.__PERSONAL_SKILLS_TEST__.owner;`,
  target: `export const useBotSettingsTarget=()=>globalThis.__PERSONAL_SKILLS_TEST__.target;`,
  utils: `export const cn=(...values)=>values.filter(Boolean).join(' ');`,
  bridge: `export const invoke=(op,args)=>{const s=globalThis.__PERSONAL_SKILLS_TEST__;s.calls.push({op,args});return s.invoke(op,args);};`,
};
const bundle = await build({ entryPoints: [web + '/adapters/bot-capability-settings.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'lucide-react'],
  plugins: [{ name: 'platform-boundary', setup(b) {
    b.onResolve({ filter: /.*/ }, args => {
      const p = args.path;
      const key = /components\/ui\/(?:button|input|switch)$/.test(p) ? 'controls'
        : /botPronounContext$/.test(p) ? 'translation' : /dataOwnerGeneration$/.test(p) ? 'owner'
        : p === './settings-target' ? 'target' : /lib\/utils$/.test(p) ? 'utils' : /(?:^|\/)bridge$/.test(p) ? 'bridge' : null;
      if (key) return { path: key, namespace: 'mock' };
    });
    b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path] }));
  } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { BotCapabilitySettings } = module.exports;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const skills = (from, count) => Array.from({ length: count }, (_, i) => ({ slug: `skill-${from + i}`, name: `Skill ${from + i}`, enabled: from + i !== 2 }));
const page = (from, count, total) => ({ skills: skills(from, count), revision: 'catalog-a', total, ...(from + count < total ? { nextOffset: from + count } : {}) });
const catalog = (personalSkills = page(0, 50, 125), extra = {}) => ({ skill: [{ id: 'native', name: 'Native skill', available: false }], mcp: [], toolset: [], personalSkills, personalRuntime: { status: 'pending', reason: 'native-loading-unverified' }, ...extra });
const props = (id = 'one') => ({ bot: { id, canonicalSessionId: `agent-${id}` }, capabilities: { modelChainOverride: [], modelChain: [], mcpServers: [], toolsets: [], mcpMode: 'allowlist', toolsetMode: 'allowlist' }, skills: [], expanded: true, onChange() {} });
function reset(value = catalog()) {
  state.owner = { dataOwnerId: 'a', generation: state.owner.generation + 1 }; state.calls = []; state.catalogCalls = [];
  state.load = async () => value; state.invoke = async (_op, args) => page(args.offset, Math.min(50, 125 - args.offset), 125);
  state.target = { useDefaultModelChain: () => [], capabilities: { watch: (_bot, refresh) => { state.refresh = refresh; return () => {}; }, load: (...args) => { state.catalogCalls.push(args); return state.load(...args); } } };
}
const render = async (input = props()) => { let tree; await act(async () => { tree = create(React.createElement(BotCapabilitySettings, input)); }); return tree; };
const text = tree => JSON.stringify(tree.toJSON());
const button = (tree, key) => tree.root.findAllByType('button').find(node => node.props.children === key);
const changeQuery = async (tree, query) => act(async () => tree.root.findByType('input').props.onChange(query));

test('the original personal rows reuse the catalog page and keep unavailable toggles read-only', async () => {
  reset(); const tree = await render();
  assert.equal(state.calls.length, 0); assert.equal(state.catalogCalls.length, 1);
  assert.equal(tree.root.findAllByType('switch').length, 51);
  assert.equal(tree.root.findByProps({ 'aria-label': 'Skill 2' }).props.checked, false);
  for (const row of tree.root.findAllByType('switch').filter(row => row.props['aria-label'].startsWith('Skill '))) assert.equal(row.props.disabled, true);
  assert.match(text(tree), /paseoSkills.count:50\/125/); assert.doesNotMatch(text(tree), /bots.capabilities.personalHint/);
  assert.equal(tree.root.findByType('input').props.inputClassName, 'pl-8');
  assert.deepEqual(tree.root.findAllByType('legend').map(node => node.props.children), ['bots.capabilities.toolset', 'bots.capabilities.mcp', 'bots.capabilities.skill']);
  assert(tree.root.findAllByType('fieldset').every(node => node.props.className.includes('min-w-0')));
  act(() => tree.unmount());
});

test('Load more drains every page, preserves order, and rejects same-tick duplicate reads', async () => {
  reset(); const pending = deferred(); state.invoke = () => pending.promise; const tree = await render();
  const more = button(tree, 'paseoSkills.more').props.onClick;
  act(() => { more(); more(); }); assert.equal(state.calls.length, 1); assert.equal(state.calls[0].args.offset, 50); assert.equal(state.calls[0].args.expectedRevision, 'catalog-a');
  await act(async () => pending.resolve(page(50, 50, 125)));
  state.invoke = async () => page(100, 25, 125);
  await act(async () => button(tree, 'paseoSkills.more').props.onClick());
  assert.equal(tree.root.findAllByType('switch').filter(row => row.props['aria-label'].startsWith('Skill ')).length, 125);
  assert.match(text(tree), /paseoSkills.count:125\/125/); assert.equal(button(tree, 'paseoSkills.more'), undefined);
  assert.equal(state.catalogCalls.length, 1); act(() => tree.unmount());
});

test('search covers the full library and stale queries cannot overwrite or issue continuation requests', async () => {
  reset(); const tree = await render(); const staleMore = button(tree, 'paseoSkills.more').props.onClick;
  const old = deferred(); state.invoke = async (_op, args) => args.query === 'older' ? old.promise : ({ skills: [{ slug: 'far-away', name: 'Found through description' }], total: 1 });
  await changeQuery(tree, 'older'); await changeQuery(tree, 'outside first page');
  assert.match(text(tree), /Found through description/); assert.doesNotMatch(text(tree), /Skill 0/);
  const count = state.calls.length; act(() => staleMore()); assert.equal(state.calls.length, count);
  await act(async () => old.resolve({ skills: [{ slug: 'old', name: 'Wrong old query' }], total: 1 }));
  assert.doesNotMatch(text(tree), /Wrong old query/); assert.equal(state.catalogCalls.length, 1);
  await changeQuery(tree, ''); assert.match(text(tree), /Skill 0/); assert.match(text(tree), /50\/125/);
  act(() => tree.unmount());
});

test('provider failure does not hide personal rows, and continuation errors retry the same offset', async () => {
  reset(catalog(page(0, 50, 51), { providerError: { code: 'CATALOG_ERROR', message: 'Native directory is unavailable' }, skill: [] }));
  const tree = await render(); state.invoke = async () => { throw new Error('connection lost'); };
  await act(async () => button(tree, 'paseoSkills.more').props.onClick());
  assert.match(text(tree), /Native directory is unavailable/); assert.match(text(tree), /Skill 0/); assert.match(text(tree), /connection lost/);
  state.invoke = async () => page(50, 1, 51);
  await act(async () => button(tree, 'bots.retry').props.onClick());
  assert.deepEqual(state.calls.map(call => call.args.offset), [50, 50]); assert.match(text(tree), /51\/51/);
  act(() => tree.unmount());
});

test('host replacement removes the previous catalog and fences retained pagination callbacks before effects', async () => {
  reset(); const tree = await render(); const old = deferred(); state.invoke = () => old.promise;
  const more = button(tree, 'paseoSkills.more').props.onClick; act(() => more());
  state.owner = { dataOwnerId: 'new-host', generation: state.owner.generation + 1 };
  const next = deferred(); state.load = () => next.promise;
  await act(async () => tree.update(React.createElement(BotCapabilitySettings, props())));
  assert.doesNotMatch(text(tree), /Skill 0/); const count = state.calls.length;
  act(() => more()); assert.equal(state.calls.length, count);
  await act(async () => old.resolve(page(50, 50, 125))); assert.doesNotMatch(text(tree), /Skill 50/);
  await act(async () => next.resolve(catalog({ skills: [{ slug: 'new', name: 'New host skill' }], total: 1 })));
  assert.match(text(tree), /New host skill/); act(() => tree.unmount());
});

test('companion changes and unmount discard late replies and prevent hidden requests', async () => {
  reset(); const tree = await render(); const old = deferred(); state.invoke = () => old.promise;
  const more = button(tree, 'paseoSkills.more').props.onClick; act(() => more());
  state.load = async () => catalog({ skills: [{ slug: 'two', name: 'Second companion' }], total: 1 });
  await act(async () => tree.update(React.createElement(BotCapabilitySettings, props('two'))));
  await act(async () => old.resolve(page(50, 50, 125))); assert.doesNotMatch(text(tree), /Skill 50/);
  assert.match(text(tree), /Second companion/); act(() => tree.unmount());
  const count = state.calls.length; more(); assert.equal(state.calls.length, count);
});

test('a nonprogressing continuation stays visible as an error instead of claiming a complete library', async () => {
  reset(); const tree = await render(); state.invoke = async () => ({ skills: skills(50, 50), total: 125, nextOffset: 50 });
  await act(async () => button(tree, 'paseoSkills.more').props.onClick());
  assert.match(text(tree), /invalid personal skill page/); assert.match(text(tree), /50\/125/);
  assert(button(tree, 'bots.retry')); act(() => tree.unmount());
});

test('closed details do not load catalogs or continue a retained request after collapsing', async () => {
  reset(); const tree = await render({ ...props(), expanded: false });
  assert.equal(state.catalogCalls.length, 0); assert.equal(state.calls.length, 0);
  await act(async () => tree.update(React.createElement(BotCapabilitySettings, props())));
  const more = button(tree, 'paseoSkills.more').props.onClick; const pending = deferred(); state.invoke = () => pending.promise;
  act(() => more()); await act(async () => tree.update(React.createElement(BotCapabilitySettings, { ...props(), expanded: false })));
  const count = state.calls.length; more(); assert.equal(state.calls.length, count);
  await act(async () => pending.resolve(page(50, 50, 125))); assert.doesNotMatch(text(tree), /Skill 50/);
  act(() => tree.unmount());
});

test('a response cannot omit a continuation while more personal results remain', async () => {
  reset(); const tree = await render(); state.invoke = async () => ({ skills: skills(50, 20), total: 125 });
  await act(async () => button(tree, 'paseoSkills.more').props.onClick());
  assert.match(text(tree), /invalid personal skill page/); assert.match(text(tree), /50\/125/);
  act(() => tree.unmount());
});

test('catalog revision changes retain the search but restart at zero only after explicit reload', async () => {
  reset(); const tree = await render();
  state.invoke = async (_op, args) => {
    if (args.offset) throw Object.assign(new Error('changed'), { code: 'SKILL_CATALOG_CHANGED' });
    return page(0, 50, 70);
  };
  await changeQuery(tree, 'skill query');
  assert.equal('expectedRevision' in state.calls[0].args, false);
  await act(async () => button(tree, 'paseoSkills.more').props.onClick());
  assert.equal(state.calls[1].args.expectedRevision, 'catalog-a');
  assert.match(text(tree), /paseoSkills.catalogChanged/); assert.doesNotMatch(text(tree), /Skill 0/);
  assert.equal(tree.root.findByType('input').props.value, 'skill query');
  assert.equal(button(tree, 'paseoSkills.more'), undefined);
  state.invoke = async () => ({ skills: [{ slug: 'updated', name: 'Updated result' }], total: 1, revision: 'catalog-b' });
  await act(async () => button(tree, 'paseoSkills.reload').props.onClick());
  assert.deepEqual(state.calls[2].args, { botId: 'one', query: 'skill query', offset: 0, limit: 50 });
  assert.match(text(tree), /Updated result/); act(() => tree.unmount());
});

test('duplicate slugs and mismatched revision receipts never get silently merged into an incomplete list', async () => {
  for (const response of [
    { skills: [{ slug: 'skill-49', name: 'Duplicate' }], total: 51, revision: 'catalog-a' },
    { skills: skills(50, 1), total: 51, revision: 'catalog-b' },
  ]) {
    reset(catalog(page(0, 50, 51))); const tree = await render(); state.invoke = async () => response;
    await act(async () => button(tree, 'paseoSkills.more').props.onClick());
    assert.match(text(tree), /paseoSkills.catalogChanged/); assert.doesNotMatch(text(tree), /50\/51|51\/51/);
    assert(button(tree, 'paseoSkills.reload')); act(() => tree.unmount());
  }
});
