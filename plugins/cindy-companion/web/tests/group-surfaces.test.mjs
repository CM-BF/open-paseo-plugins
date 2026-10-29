import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window = new EventTarget();
const state = globalThis.__GROUP_SURFACE_TEST__ = { generation: 1, profiles: [], calls: [], posts: [], data: null, readError: '', refreshes: 0 };
const web = new URL('..', import.meta.url).pathname;
const mocks = {
  dialog: `import {createElement} from 'react';const component=name=>({children,...props})=>createElement(name,props,children);export const Root=component('dialog-root'),Portal=component('dialog-portal'),Overlay=component('dialog-overlay'),Content=component('dialog-content'),Title=component('dialog-title'),Description=component('dialog-description'),Close=component('dialog-close');`,
  translation: `const t=(key,values)=>key+(values?.name?':'+values.name:'');export const useTranslation=()=>({t,i18n:{language:'en',resolvedLanguage:'en'}});`,
  button: `import {createElement} from 'react';export const Button=({children,...props})=>createElement('button',props,children);`,
  input: `import {createElement} from 'react';export const Input=props=>createElement('input',props);`,
  field: `import {createElement} from 'react';export const FormField=({children,label,...props})=>createElement('field',{label,...props},children({}));`,
  owner: `export const getDataOwnerGeneration=()=>globalThis.__GROUP_SURFACE_TEST__.generation;export const isDataOwnerGenerationCurrent=value=>value===globalThis.__GROUP_SURFACE_TEST__.generation;`,
  bots: `export const useBotProfiles=()=>globalThis.__GROUP_SURFACE_TEST__.profiles;`,
  avatar: `export const BotAvatar=()=>null;export const BotGroupAvatarStack=()=>null;`,
  utils: `export const cn=(...values)=>values.filter(Boolean).join(' ');`,
  bridge: `export const initValue=()=>({host:{id:'test'}}); export class BridgeError extends Error {constructor(code,message){super(message);this.code=code;}} export const invoke=(op,args)=>{const s=globalThis.__GROUP_SURFACE_TEST__;s.calls.push({op,args});return s.invoke(op,args);};export const post=(type,fields)=>globalThis.__GROUP_SURFACE_TEST__.posts.push({type,...fields});`,
  groupHook: `import {useState} from 'react';export const mergeMessages=(a,b)=>[...new Map([...a,...b].map(m=>[m.id,m])).values()].sort((a,b)=>a.sequence-b.sequence);export const useGroup=()=>{const s=globalThis.__GROUP_SURFACE_TEST__;const[data,setData]=useState(s.data);s.setData=setData;return{data,setData,error:s.readError,refresh:()=>{s.refreshes++;}};};`,
  mention: `export const useBotGroupMentionPicker=({onTextChange})=>({list:null,tracked:[],setTracked(){},reset(){},onChange:onTextChange,onKeyDown:()=>false,textareaProps:{}});`,
  markdown: `import {createElement} from 'react';export const MarkdownRenderer=({content})=>createElement('markdown',{},content);`,
  send: `import {createElement} from 'react';export const SendButton=props=>createElement('send-button',props);`,
  confirm: `export const useConfirmDialog=()=>({confirm:async()=>true});`,
  spinner: `export const Spinner=()=>null;`,
  tip: `import {createElement} from 'react';export const Tip=({children})=>createElement('tip',{},children);`,
  history: `export const useGroupHistory=()=>({data:null,error:'',refresh(){}});`,
  work: `export const useGroupPlans=()=>globalThis.__GROUP_SURFACE_TEST__.work??({data:null,error:'',pending:null,refresh(){}});`,
  dropdown: `import {createElement} from 'react';const c=tag=>({children,...props})=>createElement(tag,props,children);export const DropdownMenu=c('dropdown'),DropdownMenuTrigger=c('dropdown-trigger'),DropdownMenuContent=c('dropdown-content'),DropdownMenuItem=c('dropdown-item'),DropdownMenuLabel=c('dropdown-label'),DropdownMenuSeparator=c('dropdown-separator');`,
};
const built = await build({
  stdin: { contents: `export {BotGroupCreateDialog} from '../vendor/renderer/features/bots/BotGroupCreateDialog';export {GroupChat} from './group-chat';export {GroupSettings} from './group-settings';export {observeGroup,mergeGroupSnapshot} from './adapters/group-store';`, resolveDir: web, loader: 'tsx' },
  bundle: true, nodePaths: [web + '/node_modules'], write: false, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'empty' }, external: ['react', 'react/jsx-runtime', 'lucide-react'],
  plugins: [{ name: 'group-platform-boundary', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      const p = args.path;
      const mock = p === '@radix-ui/react-dialog' ? 'dialog' : p === 'react-i18next' ? 'translation'
        : /(?:^|\/)button$/.test(p) ? 'button' : /(?:^|\/)input$/.test(p) ? 'input' : /form-field$/.test(p) ? 'field'
        : /dataOwnerGeneration$/.test(p) ? 'owner' : /(?:botStore|bot-store)$/.test(p) ? 'bots'
        : /(?:BotAvatar|BotGroupAvatars)$/.test(p) ? 'avatar' : /lib\/utils$/.test(p) ? 'utils'
        : /(?:^|\/)bridge$/.test(p) ? 'bridge' : /useBotGroupMentionPicker$/.test(p) ? 'mention'
        : /memory-markdown$/.test(p) ? 'markdown' : /SendButton$/.test(p) ? 'send'
        : p === './group-history-store' && args.importer.endsWith('group-chat.tsx') ? 'history' : /adapters\/group-plans$/.test(p) ? 'work' : /dropdown-menu$/.test(p) ? 'dropdown' : /tooltip$/.test(p) ? 'tip'
        : /confirm-dialog-provider$/.test(p) ? 'confirm' : /spinner$/.test(p) ? 'spinner'
        : p === './adapters/group-store' && args.importer.endsWith('group-chat.tsx') ? 'groupHook' : null;
      if (mock) return { path: mock, namespace: 'mock' };
      if (p === '@/components/chat/MarkdownRenderer') return { path: 'markdown', namespace: 'mock' };
      if (p.startsWith('@/')) { const base=web+'/../vendor/renderer/'+p.slice(2); return {path:base+(existsSync(base+'.ts')?'.ts':'.tsx')}; }
      if (p === './botGroupStore') return { path: web + '/adapters/group-store.ts' };
      if (p === './botGroupPresentation') return { path: web + '/adapters/group-presentation.ts' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: mocks[args.path] }));
  } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { BotGroupCreateDialog, GroupChat, GroupSettings, observeGroup, mergeGroupSnapshot } = module.exports;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const profile = (id, createdAt = 0) => ({ id, name: id, status: 'active', enabled: true, createdAt });
const round = (status = 'running') => ({ id: 'round-1', status, createdAt: 1, updatedAt: 2, steps: [{ botId: 'a', botName: 'a', status: 'running', agentId: 'native-a' }] });
const snapshot = (r = null) => ({ group: { id: 'group-1', name: 'Discussion', revision: 1, replyMode: 'all', members: [{ ...profile('a'), botId: 'a' }, { ...profile('b'), botId: 'b' }], round: r }, messages: [], hasOlder: false });
const reset = () => { state.work = undefined; state.calls = []; state.posts = []; state.profiles = [profile('b', 2), profile('a', 1)]; state.refreshes = 0; state.data = snapshot(); state.readError = ''; };
const render = async (Component, props) => { let renderer; await act(async () => { renderer = create(React.createElement(Component, props)); }); return renderer; };

test('division tag routes the actual composer through plan creation and retains a rejected request', async () => {
  reset(); const plans = [], pending = deferred();
  state.work = { data: { plans: [], settings: { revision: 1, organizerBotId: null, projectDir: null, autoContinue: false } }, pending: null, error: '',
    createPlan: (...args) => { plans.push(args); return pending.promise; }, refresh() {} };
  state.invoke = async () => { throw new Error('ordinary discussion must not be sent'); };
  const tree = await render(GroupChat, { groupId: 'group-1' });
  act(() => tree.root.findByType('dropdown-item').props.onSelect());
  act(() => tree.root.findByType('textarea').props.onChange({ target: { value: 'Arrange a real deliverable' } }));
  act(() => { tree.root.findByType('send-button').props.onClick(); tree.root.findByType('send-button').props.onClick(); });
  assert.equal(plans.length, 1); assert.deepEqual(plans[0], ['Arrange a real deliverable', []]); assert.equal(state.calls.length, 0);
  await act(async () => pending.resolve(null));
  assert.equal(tree.root.findByType('textarea').props.value, 'Arrange a real deliverable'); assert.equal(tree.root.findAllByProps({ 'data-testid': 'bot-group-division-tag' }).length, 1);
  act(() => tree.unmount());
});

test('active work supplements target the owned plan and a queued receipt says it is for the next turn', async () => {
  reset(); const calls = [], p = { id: 'work', groupId: 'group-1', revision: 1, status: 'running', kind: 'work', organizerName: 'A', organizerBotId: 'a', currentStep: 0, execution: { state: 'running' }, steps: [{ position: 0, botId: 'a', botName: 'A', task: 'Build', status: 'running', artifacts: [] }] };
  state.work = { data: { plans: [p], settings: { revision: 1, autoContinue: false } }, pending: null, error: '', action: async (...args) => { calls.push(args); return { accepted: true, plan: p, delivery: 'queued' }; }, refresh() {} };
  const tree = await render(GroupChat, { groupId: 'group-1' });
  act(() => tree.root.findByType('textarea').props.onChange({ target: { value: 'Keep the original spacing' } }));
  await act(async () => tree.root.findByType('send-button').props.onClick());
  assert.deepEqual(calls[0], [p, 'note', { text: 'Keep the original spacing' }]); assert.equal(state.calls.length, 0);
  assert.match(JSON.stringify(tree.toJSON()), /paseoWork.noteQueued/);
  act(() => tree.root.findByType('send-button').props.onClick());
  assert.equal(calls.at(-1)[1], 'stop'); act(() => tree.unmount());
});

test('an unknown organizer request retains an exact Stop recovery action even when a lost ACK kept the draft', async () => {
  reset(); const cancellations = [], pending = deferred();
  state.work = { data: { plans: [], requests: [], settings: { revision: 1, autoContinue: false } }, pending: null, error: '', refresh() {}, cancelRequest: id => { cancellations.push(id); return pending.promise; } };
  const tree = await render(GroupChat, { groupId: 'group-1' });
  act(() => tree.root.findByType('textarea').props.onChange({ target: { value: 'An unconfirmed request' } }));
  state.work.data.requests = [{ id: 'exact-request', organizerName: 'A', status: 'unknown', code: 'STOP_NOT_CONFIRMED' }];
  await act(async () => tree.update(React.createElement(GroupChat, { groupId: 'group-1' })));
  assert.equal(tree.root.findByType('send-button').props.disabled, true);
  const stop = tree.root.findAllByType('button').find(value => value.props.children === 'bots.groupChat.composer.stop');
  act(() => stop.props.onClick()); assert.deepEqual(cancellations, ['exact-request']);
  await act(async () => pending.resolve({ accepted: true, request: state.work.data.requests[0] }));
  assert.match(JSON.stringify(tree.toJSON()), /stop is not yet confirmed/);assert.equal(tree.root.findByType('textarea').props.value, 'An unconfirmed request');
  act(() => tree.unmount());
});
test('organizer native-stop recovery explains the state, opens the exact lane and retains Stop',async()=>{
 reset();const cancellations=[];
 state.work={data:{plans:[],requests:[{id:'organizer-request',organizerName:'A',agentId:'organizer-native',status:'unknown',code:'GROUP_STOP_REQUIRES_NATIVE'}],settings:{revision:1,autoContinue:false}},pending:null,error:'',refresh(){},cancelRequest:async id=>cancellations.push(id)};
 const tree=await render(GroupChat,{groupId:'group-1'});
 assert.match(JSON.stringify(tree.toJSON()),/Open the task session and stop it there/);assert.doesNotMatch(JSON.stringify(tree.toJSON()),/GROUP_STOP_REQUIRES_NATIVE/);
 const buttons=tree.root.findAllByType('button');act(()=>buttons.find(v=>v.props.children==='paseoGroups.openTask').props.onClick());
 assert.deepEqual(state.posts,[{type:'navigate-agent',agentId:'organizer-native'}]);
 await act(async()=>buttons.find(v=>v.props.children==='bots.groupChat.composer.stop').props.onClick());assert.deepEqual(cancellations,['organizer-request']);
 assert.equal(tree.root.findByType('textarea').props.readOnly,true);assert.doesNotMatch(JSON.stringify(tree.toJSON()),/bots.groupChat.plan.stopped/);act(()=>tree.unmount());
});
test('discussion native-stop recovery maps codes and preserves the owned round Stop target',async()=>{
 reset();state.data=snapshot({...round('unknown'),code:'GROUP_STOP_REQUIRES_NATIVE',steps:[{botId:'a',botName:'A',status:'unknown',agentId:'native-discussion'}]});
 state.invoke=async()=>({accepted:true,round:state.data.group.round});const tree=await render(GroupChat,{groupId:'group-1'});
 assert.match(JSON.stringify(tree.toJSON()),/Open the task session and stop it there/);assert.doesNotMatch(JSON.stringify(tree.toJSON()),/GROUP_STOP_REQUIRES_NATIVE/);
 act(()=>tree.root.findAllByType('button').find(v=>v.props.children==='paseoGroups.openTask').props.onClick());assert.deepEqual(state.posts,[{type:'navigate-agent',agentId:'native-discussion'}]);
 await act(async()=>tree.root.findByType('send-button').props.onClick());assert.deepEqual(state.calls[0],{op:'groups.stop',args:{groupId:'group-1',roundId:'round-1'}});
 assert.equal(tree.root.findByType('send-button').props.isStreaming,true);act(()=>tree.unmount());
});
test('group cleanup only checks native archival and does not clear pending state from an acknowledgement',async()=>{
 reset();state.data=snapshot();state.data.group.cleanupPending=[{agentId:'retired-lane',title:'Former teammate work',code:'GROUP_ARCHIVE_REQUIRES_NATIVE'}];
 const pending=deferred();state.invoke=()=>pending.promise;const tree=await render(GroupChat,{groupId:'group-1'});
 assert.match(JSON.stringify(tree.toJSON()),/archive it there/);assert.doesNotMatch(JSON.stringify(tree.toJSON()),/GROUP_ARCHIVE_REQUIRES_NATIVE/);
 act(()=>tree.root.findAllByType('button').find(v=>v.props.children==='paseoGroups.openTask').props.onClick());assert.deepEqual(state.posts,[{type:'navigate-agent',agentId:'retired-lane'}]);
 const confirm=tree.root.findAllByType('button').find(v=>v.props.children==='paseoWork.confirmCleanup').props.onClick;
 act(()=>{confirm();confirm()});assert.deepEqual(state.calls,[{op:'groups.cleanup',args:{groupId:'group-1'}}]);
 await act(async()=>pending.resolve(state.data));assert.match(JSON.stringify(tree.toJSON()),/Former teammate work/);assert.ok(state.refreshes>0);act(()=>tree.unmount());
});
test('completed organizer cleanup keeps the completed plan and calls only request cleanup reconciliation',async()=>{
 reset();const calls=[];state.work={data:{plans:[],requests:[{id:'settled-request',organizerName:'A',agentId:'organizer-native',status:'complete',code:'STOP_REQUESTED',cleanupPending:true,cleanupCode:'GROUP_ARCHIVE_REQUIRES_NATIVE'}],settings:{revision:1,autoContinue:false}},pending:null,error:'',refresh(){},cancelRequest:async id=>calls.push(id)};
 const tree=await render(GroupChat,{groupId:'group-1'});assert.match(JSON.stringify(tree.toJSON()),/archive it there/);
 const button=tree.root.findAllByType('button').find(v=>v.props.children==='paseoWork.confirmCleanup');assert.equal(button.props.disabled,false);
 await act(async()=>button.props.onClick());assert.deepEqual(calls,['settled-request']);assert.equal(state.work.data.requests[0].status,'complete');assert.equal(state.calls.length,0);
 assert.equal(tree.root.findAllByType('button').some(v=>v.props.children==='bots.groupChat.composer.stop'),false);
 state.work.data.requests[0]={...state.work.data.requests[0],status:'failed',code:'PROVIDER_ADMISSION_UNAVAILABLE'};
 await act(async()=>tree.update(React.createElement(GroupChat,{groupId:'group-1'})));
 assert.match(JSON.stringify(tree.toJSON()),/has not been sent/);assert.match(JSON.stringify(tree.toJSON()),/archive it there/);
 assert.doesNotMatch(JSON.stringify(tree.toJSON()),/PROVIDER_ADMISSION_UNAVAILABLE/);act(()=>tree.unmount());
});
test('a deleting group can confirm native cleanup while other mutations remain disabled',async()=>{
 reset();const group={...snapshot().group,mutation:'deleting',cleanupPending:[{agentId:'retired-lane',title:'Pending work',code:'GROUP_ARCHIVE_REQUIRES_NATIVE'}]};
 let changes=0;state.invoke=async()=>({group});const tree=await render(GroupSettings,{group,onClose(){},onChanged(){changes++}});
 const confirm=tree.root.findAllByType('button').find(v=>v.props.children==='paseoWork.confirmCleanup');assert.equal(confirm.props.disabled,false);
 await act(async()=>confirm.props.onClick());assert.deepEqual(state.calls,[{op:'groups.cleanup',args:{groupId:'group-1'}}]);assert.equal(changes,1);
 assert.equal(tree.root.findByType('input').props.disabled,true);assert.match(JSON.stringify(tree.toJSON()),/Pending work/);act(()=>tree.unmount());
});

test('original create form orders selected members and guards duplicate submit and busy host close', async () => {
  reset(); const pending = deferred(), opened = [], closed = [];
  state.invoke = () => pending.promise;
  const renderer = await render(BotGroupCreateDialog, { initialBotIds: ['b', 'a'], onCreated: id => opened.push(id), onOpenChange: value => closed.push(value) });
  act(() => renderer.root.findByType('input').props.onChange('  Review  '));
  act(() => { renderer.root.findByType('form').props.onSubmit(); renderer.root.findByType('form').props.onSubmit(); window.dispatchEvent(new Event('cindy-request-close')); });
  assert.equal(state.calls.length, 1); assert.deepEqual(state.calls[0].args.botIds, ['a', 'b']);
  assert.equal(state.calls[0].args.name, 'Review'); assert.match(state.calls[0].args.operationId, /^[\da-f-]{36}$/);
  assert.deepEqual(closed, []); assert.deepEqual(opened, []);
  await act(async () => pending.resolve(snapshot()));
  assert.deepEqual(opened, ['group-1']);
  act(() => renderer.unmount());
});

test('original create form enforces member minimum and ignores late success after unmount', async () => {
  reset(); const pending = deferred(), opened = [];
  state.invoke = () => pending.promise;
  const renderer = await render(BotGroupCreateDialog, { initialBotIds: ['a'], onCreated: id => opened.push(id), onOpenChange() {} });
  act(() => renderer.root.findByType('input').props.onChange('Group'));
  await act(async () => renderer.root.findByType('form').props.onSubmit());
  assert.equal(state.calls.length, 0); assert.match(JSON.stringify(renderer.toJSON()), /minMembers/);
  act(() => renderer.root.findAllByProps({ role: 'checkbox' })[1].props.onClick());
  act(() => renderer.root.findByType('form').props.onSubmit());
  act(() => renderer.unmount()); await act(async () => pending.resolve(snapshot()));
  assert.deepEqual(opened, []);
});

test('failed creation retries the same immutable operation rather than creating a second group', async () => {
  reset(); let attempts = 0;
  state.invoke = async () => { if (++attempts === 1) throw new Error('lost response'); return snapshot(); };
  const renderer = await render(BotGroupCreateDialog, { initialBotIds: ['a', 'b'], onCreated() {}, onOpenChange() {} });
  act(() => renderer.root.findByType('input').props.onChange('Retry group'));
  await act(async () => renderer.root.findByType('form').props.onSubmit());
  await act(async () => renderer.root.findByType('form').props.onSubmit());
  assert.equal(state.calls.length, 2); assert.deepEqual(state.calls[0], state.calls[1]);
  act(() => renderer.unmount());
});

test('discussion keeps a failed draft and idempotency key, then displays only acknowledged send state', async () => {
  reset(); let attempts = 0; const pending = deferred();
  state.invoke = () => ++attempts === 1 ? Promise.reject(new Error('response lost')) : pending.promise;
  const renderer = await render(GroupChat, { groupId: 'group-1' });
  act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: 'Discuss this' } }));
  await act(async () => renderer.root.findByType('send-button').props.onClick());
  assert.equal(renderer.root.findByType('textarea').props.value, 'Discuss this');
  assert.match(JSON.stringify(renderer.toJSON()), /response lost/);
  act(() => { renderer.root.findByType('send-button').props.onClick(); renderer.root.findByType('send-button').props.onClick(); });
  assert.equal(state.calls.length, 2); assert.deepEqual(state.calls[0], state.calls[1]);
  await act(async () => pending.resolve({ accepted: true, message: { id: 'message-1', sequence: 1, authorKind: 'user', authorName: 'You', kind: 'message', content: 'Discuss this', createdAt: 1 }, round: round('running') }));
  assert.equal(renderer.root.findByType('textarea').props.value, '');
  assert.equal(renderer.root.findByType('send-button').props.isStreaming, true);
  assert.equal(renderer.root.findAllByProps({ 'data-bot-group-message-id': 'message-1' }).length, 1);
  act(() => renderer.unmount());
});

test('accepted Stop retains running state until the host confirms stopping or stopped', async () => {
  reset(); state.data = snapshot(round('running')); const pending = deferred(); state.invoke = () => pending.promise;
  const renderer = await render(GroupChat, { groupId: 'group-1' });
  act(() => renderer.root.findByType('send-button').props.onClick());
  assert.equal(state.calls[0].op, 'groups.stop'); assert.equal(renderer.root.findByType('send-button').props.isStreaming, true);
  await act(async () => pending.resolve({ accepted: true, round: { ...round('stopping'), updatedAt: 3 } }));
  assert.equal(renderer.root.findByType('send-button').props.isStreaming, true);
  assert.equal(renderer.root.findByType('send-button').props.disabled, true);
  assert.match(JSON.stringify(renderer.toJSON()), /paseoGroups.stopping/);
  act(() => state.setData(snapshot({ ...round('stopped'), updatedAt: 4 })));
  assert.equal(renderer.root.findByType('send-button').props.isStreaming, false);
  act(() => renderer.unmount());
});

test('typing during a discussion sends an independent queued reply and never replaces the active Stop target', async () => {
  reset(); state.data = snapshot({ ...round('running'), kind: 'talk' });
  state.invoke = async op => op === 'groups.send' ? { accepted: true,
    message: { id: 'side-message', sequence: 1, authorKind: 'user', kind: 'message', content: '@b question', createdAt: 3 },
    round: { ...round('queued'), id: 'side-round', kind: 'reply', createdAt: 3, updatedAt: 3, steps: [{ botId: 'b', botName: 'b', status: 'queued' }] },
  } : { accepted: true, round: { ...round('stopping'), updatedAt: 4 } };
  const renderer = await render(GroupChat, { groupId: 'group-1' });
  act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: '@b question' } }));
  assert.equal(renderer.root.findByType('send-button').props.isStreaming, false);
  await act(async () => renderer.root.findByType('send-button').props.onClick());
  assert.equal(state.calls[0].op, 'groups.send');
  assert.equal(renderer.root.findAllByProps({ 'data-pending-round-id': 'side-round' }).length, 1);
  assert.equal(renderer.root.findByType('send-button').props.isStreaming, true);
  await act(async () => renderer.root.findByType('send-button').props.onClick());
  assert.deepEqual(state.calls[1], { op: 'groups.stop', args: { groupId: 'group-1', roundId: 'round-1' } });
  act(() => renderer.unmount());
});

test('a supplementary message states deferred delivery until the host records a real later recipient', async () => {
  reset(); state.data = snapshot(round('running'));
  const message = { id: 'note', sequence: 1, authorKind: 'user', kind: 'message', content: 'More context', createdAt: 3, delivery: 'deferred', code: 'HOST_UPGRADE_REQUIRED' };
  state.invoke = async () => ({ accepted: true, message, round: round('running') });
  const renderer = await render(GroupChat, { groupId: 'group-1' });
  act(() => renderer.root.findByType('textarea').props.onChange({ target: { value: 'More context' } }));
  await act(async () => renderer.root.findByType('send-button').props.onClick());
  assert.match(JSON.stringify(renderer.toJSON()), /paseoGroups.deferred/);
  act(() => state.setData({ ...snapshot(round('running')), messages: [{ ...message, delivery: 'delivered' }] }));
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /paseoGroups.deferred/);
  act(() => renderer.unmount());
});

test('settings close waits for actual autosave and failures keep the editable draft', async () => {
  reset(); let pending = deferred(), closes = 0; state.invoke = () => pending.promise;
  const renderer = await render(GroupSettings, { group: snapshot().group, onClose: () => closes++, onChanged() {} });
  act(() => renderer.root.findByType('input').props.onChange('Updated'));
  act(() => { renderer.root.findByType('input').props.onBlur(); window.dispatchEvent(new Event('cindy-request-close')); });
  assert.equal(state.calls.length, 1); assert.equal(closes, 0);
  await act(async () => pending.reject(new Error('save rejected')));
  assert.equal(closes, 0); assert.equal(renderer.root.findByType('input').props.value, 'Updated');
  pending = deferred(); act(() => window.dispatchEvent(new Event('cindy-request-close')));
  await act(async () => pending.resolve({ group: { ...snapshot().group, name: 'Updated', revision: 2 } }));
  assert.equal(closes, 1); assert.equal(state.calls.length, 2);
  act(() => renderer.unmount());
});

test('observer coalesces refresh, recovers after failure and ignores all late reads on disposal', async () => {
  let reads = [], timers = [], emitted = [], failures = [];
  const request = () => { const value = deferred(); reads.push(value); return value.promise; };
  const observer = observeGroup('g', value => emitted.push(value), value => failures.push(value), request,
    { set: (callback, delay) => { assert.equal(delay, 2000); timers.push(callback); return timers.length; }, clear() {} });
  observer.refresh(); observer.refresh(); assert.equal(reads.length, 1);
  reads[0].resolve(snapshot()); await flush(); assert.equal(reads.length, 2); assert.equal(emitted.length, 0);
  reads[1].reject(new Error('temporary offline')); await flush(); assert.equal(failures.length, 1); assert.equal(timers.length, 1);
  timers[0](); assert.equal(reads.length, 3);
  observer.dispose(); reads[2].resolve(snapshot()); await flush(); observer.refresh();
  assert.equal(emitted.length, 0); assert.equal(reads.length, 3); assert.equal(timers.length, 1);
});

test('a pre-mutation poll cannot overwrite a newer confirmed round or loaded older history', () => {
  const before = snapshot(round('running'));
  before.messages = [{ id: 'm2', sequence: 2 }]; before.hasOlder = true;
  const accepted = { ...snapshot({ ...round('stopping'), updatedAt: 4 }), messages: [{ id: 'm1', sequence: 1 }, { id: 'm2', sequence: 2 }] };
  const merged = mergeGroupSnapshot(accepted, before);
  assert.equal(merged.group.round.status, 'stopping'); assert.equal(merged.hasOlder, false);
  assert.deepEqual(merged.messages.map(value => value.sequence), [1, 2]);
});


test('a group with unfinished deletion keeps Delete retry and close available while ordinary edits are read-only',async()=>{
 reset();state.data.group.mutation='deleting';const closes=[];state.invoke=async()=>({deleted:true});
 const tree=await render(GroupSettings,{group:state.data.group,onClose:()=>closes.push(true),onChanged(){}});
 assert.equal(tree.root.findByType('input').props.disabled,true);
 const remove=tree.root.findAllByType('button').find(node=>node.props.children==='bots.groupChat.settings.delete');assert.equal(remove.props.disabled,false);
 await act(async()=>remove.props.onClick());assert.equal(state.calls.at(-1).op,'groups.delete');
 assert.deepEqual(state.calls.at(-1).args,{groupId:'group-1',expectedRevision:1});act(()=>tree.unmount());
 const chat=await render(GroupChat,{groupId:'group-1'});assert.equal(chat.root.findByType('textarea').props.readOnly,true);assert.equal(chat.root.findByType('send-button').props.disabled,true);act(()=>chat.unmount());
});
