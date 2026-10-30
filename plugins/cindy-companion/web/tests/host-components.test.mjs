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
        : path === './data' ? `export const useCompanions=id=>globalThis.__CINDY_HOST_TEST__.rosters[id]; export const useGroups=id=>globalThis.__CINDY_HOST_TEST__.groups?.[id]??{data:[]}; export const useSettingsInvoke=id=>globalThis.__CINDY_HOST_TEST__.invokes[id];`
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
  data.groups = {};
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

test('original create menu opens the selected surface and cannot act after switching hosts', async () => {
  const state = setupSidebar(); let renderer, menu; let closes = 0;
  await act(async () => { renderer = create(React.createElement(Teammates, state.props('a'))); });
  act(() => button(renderer, 'Create teammate').props.onPress());
  await act(async () => { menu = create(React.createElement(state.popovers[0], { theme, close() { closes++; } })); });
  act(() => textButton(menu, 'Discover Teammates').props.onPress());
  assert.equal(renderer.root.findByType('Settings').props.view, 'presets');
  act(() => renderer.root.findByType('Settings').props.onClose());
  act(() => textButton(menu, 'New teammate').props.onPress());
  assert.equal(renderer.root.findByType('Settings').props.view, 'teammate-create');
  act(() => renderer.root.findByType('Settings').props.onClose());
  act(() => textButton(menu, 'New Group Chat').props.onPress());
  assert.equal(renderer.root.findByType('Settings').props.view, 'group-create');
  act(() => renderer.update(React.createElement(Teammates, state.props('b'))));
  for (const label of ['Discover Teammates', 'New teammate', 'New Group Chat']) {
    act(() => textButton(menu, label).props.onPress());
  }
  assert.equal(renderer.root.findAllByType('Settings').length, 0);
  assert.equal(state.popovers.length, 1);
  assert.equal(state.calls.length, 0);
  assert.equal(closes, 6);
  act(() => { menu.unmount(); renderer.unmount(); });
});

test('group entries mix by activity, open the shared screen and follow its selected route', async () => {
  const state = setupSidebar(); let renderer; const routes = [];
  data.rosters.a.data.profiles = [{ ...bot, createdAt: 1, sessions: [] }];
  data.groups.a = { data: [{ id: 'group-1', name: 'Planning', updatedAt: 2, members: [
    { ...bot, botId: 'cindy' }, { ...bot, botId: 'alice' },
  ], round: null }] };
  const props = currentScreen => ({ ...state.props('a'), currentScreen, openScreen: route => routes.push(route) });
  await act(async () => { renderer = create(React.createElement(Teammates, props(undefined))); });
  const labels = renderer.root.findAllByType('Pressable').map(node => node.props.accessibilityLabel);
  assert.ok(labels.indexOf('Planning') < labels.indexOf('Cindy'));
  act(() => button(renderer, 'Planning').props.onPress());
  assert.deepEqual(routes, [{ screenId: 'group', params: { groupId: 'group-1' } }]);
  assert.equal(state.calls.length, 0);
  act(() => renderer.update(React.createElement(Teammates, props(routes[0]))));
  assert.equal(button(renderer, 'Planning').props.accessibilityState.selected, true);
  act(() => renderer.update(React.createElement(Teammates, props({ screenId: 'group', params: { groupId: 'other' } }))));
  assert.equal(button(renderer, 'Planning').props.accessibilityState.selected, false);
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

test('switching group or view replaces the frame and drops stale navigation and requests', async () => {
  const state = setupFrame(); let renderer; const groups = [];
  const props = (view, groupId) => ({ ...state.props('a'),
    init: { ...state.props('a').init, view, groupId }, onNavigateGroup: id => groups.push(id) });
  await act(async () => { renderer = create(React.createElement(SettingsFrame, props('group', 'one')), { createNodeMock: state.createNodeMock }); });
  const old = state.nodes.at(-1);
  act(() => state.send(old, { type: 'request', id: 'save', op: 'groups.send', args: { groupId: 'one' } }));
  await flush();
  act(() => renderer.update(React.createElement(SettingsFrame, props('group', 'two'))));
  const next = state.nodes.at(-1); assert.notEqual(old, next);
  act(() => {
    state.send(old, { type: 'navigate-group', groupId: 'one' });
    state.send(old, { type: 'groups-changed' });
    state.send(next, { type: 'navigate-group', groupId: 'two' });
    state.send(next, { type: 'groups-changed' });
  });
  await act(async () => state.calls[0].resolve({ ok: true }));
  assert.deepEqual(groups, ['two']);
  assert.equal(state.events.filter(event => event === 'changed').length, 1);
  assert.equal(old.messages.length, 0); assert.equal(next.messages.length, 0);
  act(() => renderer.update(React.createElement(SettingsFrame, props('presets', undefined))));
  assert.notEqual(state.nodes.at(-1), next);
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

test('work artifact navigation verifies against the captured host and does not navigate after a host switch', async () => {
  const state = setupFrame(); let renderer; const opened = [];
  const props = host => ({ ...state.props(host), init: { ...state.props(host).init, view: 'group', groupId: 'one' }, onOpenWorkFile: input => opened.push(input) });
  await act(async () => { renderer = create(React.createElement(SettingsFrame, props('a')), { createNodeMock: state.createNodeMock }); });
  const old = state.nodes.at(-1);
  act(() => state.send(old, { type: 'request', id: 'file-a', op: 'paseo.openWorkArtifact', args: { groupId: 'one', planId: 'plan', position: 0, path: 'report.md' } }));
  await flush(); assert.equal(state.calls[0].op, 'groups.plans.artifact'); assert.equal(state.calls[0].host, 'a');
  act(() => renderer.update(React.createElement(SettingsFrame, props('b'))));
  await act(async () => state.calls[0].resolve({ ok: true, value: { workspaceId: 'wks_a', path: 'report.md' } }));
  assert.deepEqual(opened, []); assert.equal(old.messages.length, 0);
  const current = state.nodes.at(-1);
  act(() => state.send(current, { type: 'request', id: 'file-b', op: 'paseo.openWorkArtifact', args: { groupId: 'one', planId: 'plan', position: 0, path: 'report.md' } }));
  await flush(); assert.equal(state.calls[1].host, 'b');
  await act(async () => state.calls[1].resolve({ ok: true, value: { workspaceId: 'wks_b', path: 'report.md' } }));
  assert.deepEqual(opened, [{ workspaceId: 'wks_b', path: 'report.md', serverId: 'b' }]);
  assert.deepEqual(current.messages.at(-1).result, { ok: true, value: null });
  act(() => renderer.unmount());
});

test('work artifacts report absent navigation, cross-group requests, and unsafe returned locations without opening a file', async () => {
  const state = setupFrame(); let renderer; const opened = [];
  const props = { ...state.props('a'), init: { ...state.props('a').init, view: 'group', groupId: 'one' } };
  await act(async () => { renderer = create(React.createElement(SettingsFrame, props), { createNodeMock: state.createNodeMock }); });
  const node = state.nodes.at(-1);
  act(() => state.send(node, { type: 'request', id: 'missing', op: 'paseo.openWorkArtifact', args: { groupId: 'one' } }));
  await flush(); assert.match(node.messages.at(-1).error, /Update the Paseo/); assert.equal(state.calls.length, 0);
  act(() => renderer.update(React.createElement(SettingsFrame, { ...props, onOpenWorkFile: value => opened.push(value) })));
  act(() => state.send(node, { type: 'request', id: 'foreign', op: 'paseo.openWorkArtifact', args: { groupId: 'two' } }));
  await flush(); assert.match(node.messages.at(-1).error, /another group/); assert.equal(state.calls.length, 0);
  for (const [i, path] of ['../secret', '/tmp/foreign', 'C:/foreign', 'file\\name'].entries()) {
    act(() => state.send(node, { type: 'request', id: `unsafe-${i}`, op: 'paseo.openWorkArtifact', args: { groupId: 'one' } }));
    await flush();
    await act(async () => state.calls[i].resolve({ ok: true, value: { workspaceId: 'wks_a', path } }));
    assert.match(node.messages.at(-1).error, /invalid work file/);
  }
  assert.deepEqual(opened, []);
  act(() => renderer.unmount());
});

test('task artifacts retain the frozen result receipt and await native navigation failures', async () => {
  const state = setupFrame(); let renderer; const navigation = deferred(); const opened = [];
  const props = { ...state.props('a'), init: { ...state.props('a').init, view: 'group', groupId: 'one' },
    onOpenWorkFile: input => { opened.push(input); return navigation.promise; } };
  await act(async () => { renderer = create(React.createElement(SettingsFrame, props), { createNodeMock: state.createNodeMock }); });
  const node = state.nodes.at(-1);
  const args = { groupId: 'one', botId: 'cindy', taskId: 'task', parentAgentId: 'parent', receiptId: 'first-result', path: 'report.md' };
  act(() => state.send(node, { type: 'request', id: 'file', op: 'paseo.openTaskArtifact', args }));
  await flush(); assert.equal(state.calls[0].op, 'companion.tasks.artifact'); assert.deepEqual(state.calls[0].args, args);
  await act(async () => state.calls[0].resolve({ ok: true, value: { workspaceId: 'wks_a', path: 'report.md' } }));
  assert.equal(node.messages.length, 0); assert.deepEqual(opened, [{ workspaceId: 'wks_a', path: 'report.md', serverId: 'a' }]);
  await act(async () => navigation.reject(new Error('Workspace changed')));
  assert.match(node.messages.at(-1).error, /Workspace changed/);
  act(() => renderer.unmount());
});

test('real frame keeps process drafts across group documents and isolates host/topic generations', async () => {
  const state=setupFrame();let renderer;const group='draft-'+crypto.randomUUID();
  const props=(host,groupId=group)=>({...state.props(host),init:{...state.props(host).init,view:'group',groupId}});
  await act(async()=>{renderer=create(React.createElement(SettingsFrame,props('a')),{createNodeMock:state.createNodeMock})});
  let n=0;const request=(node,op,args)=>{const id='draft-'+(++n);state.send(node,{type:'request',id,op:'paseo.groupDrafts.'+op,args:{groupId:group,...args}});return node.messages.find(x=>x.id===id)};
  const a=state.nodes.at(-1),first=request(a,'get',{}).result.value;
  const draft={text:'Unsent original',trackedMentions:[],quote:null,division:false,attachments:[]};
  assert.equal(request(a,'save',{generation:first.generation,sequence:1,draft}).result.ok,true);
  const topic=request(a,'get',{rootId:'root'}).result.value;
  assert.equal(topic.draft,null);request(a,'save',{rootId:'root',generation:topic.generation,sequence:1,draft:{...draft,text:'Topic only'}});
  act(()=>renderer.update(React.createElement(SettingsFrame,props('b'))));const b=state.nodes.at(-1);
  assert.equal(request(b,'get',{}).result.value.draft,null);
  const oldCount=a.messages.length;request(a,'save',{generation:first.generation,sequence:2,draft:{...draft,text:'Late old host'}});assert.equal(a.messages.length,oldCount);
  act(()=>renderer.update(React.createElement(SettingsFrame,props('a'))));const reopened=state.nodes.at(-1),restored=request(reopened,'get',{}).result.value;
  assert.equal(restored.draft.text,'Unsent original');assert.equal(request(reopened,'get',{rootId:'root'}).result.value.draft.text,'Topic only');
  assert.match(request(reopened,'save',{generation:first.generation,sequence:999,draft:{...draft,text:'Stale generation'}}).error,/another view/);
  const cleared=request(reopened,'discard',{generation:restored.generation}).result.value;
  assert.match(request(reopened,'save',{generation:restored.generation,sequence:999,draft}).error,/another view/);
  assert.equal(request(reopened,'get',{}).result.value.draft,null);assert.ok(cleared.generation>restored.generation);assert.equal(state.calls.length,0);
  act(()=>renderer.unmount());
});

test('frame draft bridge rejects cross-group writes and unsealed local file data',async()=>{
 const state=setupFrame();let renderer;const group='draft-'+crypto.randomUUID();const props={...state.props('a'),init:{...state.props('a').init,view:'group',groupId:group}};
 await act(async()=>{renderer=create(React.createElement(SettingsFrame,props),{createNodeMock:state.createNodeMock})});const node=state.nodes.at(-1);
 const req=(id,op,args)=>{state.send(node,{type:'request',id,op:'paseo.groupDrafts.'+op,args});return node.messages.find(x=>x.id===id)};
 assert.match(req('cross','get',{groupId:'other'}).error,/another group/);
 const generation=req('open','get',{groupId:group}).result.value.generation;
 const draft={text:'x',trackedMentions:[],quote:null,division:false,attachments:[{mediaId:'opaque',name:'x',mimeType:'text/plain',size:1,category:'file',sha256:'a'.repeat(64),path:'/private/local',file:{bytes:'not retained'}}]};
 assert.match(req('invalid','save',{groupId:group,generation,sequence:1,draft}).error,/completed attachment/);assert.equal(state.calls.length,0);
 act(()=>renderer.unmount());
});

test('every real frame permits original submit forms while keeping an opaque origin and blocked top navigation', async () => {
  const state = setupFrame(); let renderer;
  for (const view of ['settings', 'teammate-create', 'group-create', 'presets', 'group']) {
    const props = { ...state.props('a'), init: { ...state.props('a').init, view } };
    await act(async () => {
      if (renderer) renderer.update(React.createElement(SettingsFrame, props));
      else renderer = create(React.createElement(SettingsFrame, props), { createNodeMock: state.createNodeMock });
    });
    const frame = renderer.root.findByType('iframe');
    // Chromium blocks even React preventDefault submit handlers without allow-forms.
    assert.deepEqual(new Set(frame.props.sandbox.split(/\s+/)), new Set(['allow-scripts', 'allow-downloads', 'allow-forms']));
    assert.equal(frame.props.referrerPolicy, 'no-referrer');
    assert.equal(frame.props.srcDoc, props.document);
  }
  act(() => renderer.unmount());
});
