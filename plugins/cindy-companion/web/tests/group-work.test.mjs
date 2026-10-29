import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window = { setInterval, clearInterval };
const state = globalThis.__WORK_TEST__ = { generation: 1, calls: [], posts: [] };
const web = new URL('..', import.meta.url).pathname;
const mocks = {
  translation: `export const useTranslation=()=>({t:(key)=>key,i18n:{language:'en'}});`,
  controls: `import {createElement} from 'react';const c=tag=>({children,...props})=>createElement(tag,props,children);export const Button=c('button'),Switch=c('switch'),Tip=c('tip'),DropdownMenu=c('menu'),DropdownMenuContent=c('menu-content'),DropdownMenuItem=c('menu-item'),DropdownMenuLabel=c('menu-label'),DropdownMenuSeparator=c('separator'),DropdownMenuTrigger=c('menu-trigger');`,
  avatar: `export const BotAvatar=()=>null;`,
  toast: `export const toast={error:value=>globalThis.__WORK_TEST__.posts.push({error:value})};`,
  owner: `export const getDataOwnerGeneration=()=>({dataOwnerId:'host',generation:globalThis.__WORK_TEST__.generation});export const isDataOwnerGenerationCurrent=owner=>owner.generation===globalThis.__WORK_TEST__.generation;`,
  bridge: `export class BridgeError extends Error {constructor(code,message){super(message);this.code=code}};export const invoke=(op,args)=>{const s=globalThis.__WORK_TEST__;s.calls.push({op,args});return s.invoke(op,args)};export const post=(type,fields)=>globalThis.__WORK_TEST__.posts.push({type,...fields});`,
  markdown: `import {createElement} from 'react';export const MarkdownRenderer=props=>createElement('markdown',props);`,
};
const built = await build({ stdin: { contents: `export {GroupTaskCard} from './group-task';export {CompanionTaskCard} from './companion-task-card';export {WorkPlanMessage,WorkHandoffFiles} from './work-plan';export {WorkProjectDirectory} from './work-directory';export {useGroupPlans,observeGroupPlans} from './adapters/group-plans';`, resolveDir: web, loader: 'tsx' },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', nodePaths: [web+'/node_modules'], external: ['react','react/jsx-runtime','lucide-react'],
  plugins: [{ name: 'work-host-boundary', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      const p=args.path;
      const mock=p==='react-i18next'?'translation':/(?:^|\/)(?:button|switch|tooltip|dropdown-menu)$/.test(p)?'controls':/BotAvatar$/.test(p)?'avatar':/lib\/toast$/.test(p)?'toast':/dataOwnerGeneration$/.test(p)?'owner':/(?:^|\/)bridge$/.test(p)?'bridge':/memory-markdown$/.test(p)?'markdown':null;
      if(mock)return{path:mock,namespace:'mock'};
      if(p.startsWith('@/'))return{path:web+'/../vendor/renderer/'+p.slice(2)+(/menuStyles|utils/.test(p)?'.ts':'.tsx')};
      if(p==='@cindy/maker-shared/botTimeline')return{path:web+'/../vendor/shared/botTimeline.ts'};
    });
    builder.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:mocks[args.path]}));
  }}] });
const module={exports:{}};new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const {GroupTaskCard,CompanionTaskCard,WorkPlanMessage,WorkHandoffFiles,WorkProjectDirectory,useGroupPlans,observeGroupPlans}=module.exports;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const flush=async()=>{await Promise.resolve();await Promise.resolve()};
const settings={revision:1,organizerBotId:'a',projectDir:null,autoContinue:false};
const members=[{botId:'a',name:'A',status:'active',avatar:null,avatarColor:null},{botId:'b',name:'B',status:'active',avatar:null,avatarColor:null}];
const plan=(overrides={})=>({id:'plan',groupId:'group',revision:1,request:'Make it',sourceMessageId:'source',kind:'work',status:'proposed',organizerBotId:'a',organizerName:'A',currentStep:null,workDir:'/owned/work',branch:null,createdAt:1,updatedAt:1,execution:{state:'idle'},steps:[{position:0,botId:'a',botName:'A',task:'Build',status:'pending',artifacts:[]},{position:1,botId:'b',botName:'B',task:'Check',status:'pending',artifacts:[]}],...overrides});
const render=async(Component,props)=>{let tree;await act(async()=>{tree=create(React.createElement(Component,props))});return tree};
const texts=tree=>JSON.stringify(tree.toJSON());
const button=(tree,label)=>tree.root.findAllByType('button').find(value=>value.props.children===label);
const control=(calls)=>({pending:null,action:(...args)=>{calls.push(args);return Promise.resolve(null)},settings:(...args)=>{calls.push(args);return Promise.resolve(true)}});

test('original work card routes start and edits and never removes its last step',async()=>{
  const calls=[],p=plan();const tree=await render(WorkPlanMessage,{plan:p,members,settings,control:control(calls),locale:'en',onOpenArtifact:async()=>{}});
  act(()=>button(tree,'bots.groupChat.plan.start').props.onClick());
  assert.equal(calls[0][0],p);assert.equal(calls[0][1],'start');
  const reassign=tree.root.findAllByType('menu-item').filter(value=>!value.props.variant)[1];
  act(()=>reassign.props.onSelect());assert.equal(calls[1][1],'edit');assert.deepEqual(calls[1][2],{position:0,action:'reassign',botId:'b'});
  await act(async()=>tree.update(React.createElement(WorkPlanMessage,{plan:plan({steps:[p.steps[0]]}),members,settings,control:control(calls),locale:'en',onOpenArtifact:async()=>{}})));
  assert.equal(tree.root.findAllByType('menu-item').find(value=>value.props.variant==='danger').props.disabled,true);
  act(()=>tree.unmount());
});

test('original waiting card chooses real next/retry; unknown execution never exposes completion or retry',async()=>{
  const calls=[],first=plan().steps[0],second=plan().steps[1];
  const props={members,settings,control:control(calls),locale:'en',onOpenArtifact:async()=>{}};
  const tree=await render(WorkPlanMessage,{...props,plan:plan({status:'waiting',currentStep:0,steps:[{...first,status:'done'},second]})});
  act(()=>button(tree,'bots.groupChat.timeline.continuePlan').props.onClick());assert.equal(calls.at(-1)[1],'continue');
  await act(async()=>tree.update(React.createElement(WorkPlanMessage,{...props,plan:plan({status:'waiting',currentStep:0,steps:[{...first,status:'failed'},second]})})));
  act(()=>button(tree,'bots.groupChat.timeline.retryStep').props.onClick());assert.equal(calls.at(-1)[1],'retry');
  await act(async()=>tree.update(React.createElement(WorkPlanMessage,{...props,plan:plan({status:'waiting',execution:{state:'unknown'},currentStep:0,steps:[{...first,status:'failed'},second]})})));
  assert.equal(button(tree,'bots.groupChat.timeline.retryStep'),undefined);assert.match(texts(tree),/paseoWork.execution.unknown/);assert.equal(tree.root.findAllByProps({'data-testid':'bot-group-plan-end'}).length,0);
  act(()=>tree.unmount());
});
test('work cards explain unsent and exact-stop states and open only the recorded native lane',async()=>{
 for(const [code,stateName,expected] of [['HOST_UPGRADE_REQUIRED','idle',/has not been sent/],['PROVIDER_ADMISSION_UNAVAILABLE','idle',/has not been sent/],['GROUP_LANE_BUSY','idle',/has not been sent/],['GROUP_STOP_REQUIRES_NATIVE','unknown',/Open the task session and stop it there/]]){
  state.posts=[];const first=plan().steps[0],p=plan({status:'waiting',currentStep:0,execution:{state:stateName,code},steps:[{...first,status:'failed',agentId:'exact-work-lane'}]});
  const tree=await render(WorkPlanMessage,{plan:p,members,settings,control:control([]),locale:'en',onOpenArtifact:async()=>{}});
  assert.match(texts(tree),expected);assert.doesNotMatch(texts(tree),new RegExp(code));
  act(()=>button(tree,'paseoGroups.openTask').props.onClick());assert.deepEqual(state.posts,[{type:'navigate-agent',agentId:'exact-work-lane'}]);
  if(stateName==='unknown')assert.equal(button(tree,'bots.groupChat.timeline.retryStep'),undefined);
  assert.equal(tree.root.findAllByProps({'data-testid':'bot-group-plan-end'}).length,0);act(()=>tree.unmount());
 }
});

test('handoff chip sends only the exact owned plan, step and relative artifact and rejects traversal',async()=>{
  const opened=[],p=plan({status:'done',currentStep:0,steps:[{...plan().steps[0],status:'done',artifacts:[{path:'src/result.md',size:4},{path:'../secret',size:4}]}]});
  const tree=await render(WorkHandoffFiles,{plan:p,position:0,onOpenArtifact:async(...args)=>opened.push(args)});
  const chip=name=>tree.root.findAllByType('button').find(value=>value.findAllByType('span').some(span=>span.children.includes(name)));
  await act(async()=>{chip('result.md').props.onClick();await flush()});
  assert.deepEqual(opened,[[p,0,'src/result.md']]);
  await act(async()=>{chip('secret').props.onClick();await flush()});
  assert.equal(opened.length,1);act(()=>tree.unmount());
});

function HookView({groupId='group'}) {
  const work=useGroupPlans(groupId);state.work=work;
  return work.data?.plans.map(p=>React.createElement(WorkPlanMessage,{key:p.id,plan:p,members,settings:work.data.settings,control:work,locale:'en',onOpenArtifact:async()=>{}}))??null;
}
test('actual card hook prevents same-tick duplicates, retries an unconfirmed action with its ID, and discards unmounted replies',async()=>{
  state.generation=1;state.calls=[];state.posts=[];const first=deferred(),second=deferred();let actions=0;
  state.invoke=(op)=>op.endsWith('.list')?Promise.resolve({plans:[plan()],settings}):++actions===1?first.promise:second.promise;
  const tree=await render(HookView,{});const start=button(tree,'bots.groupChat.plan.start').props.onClick;
  act(()=>{start();start()});assert.equal(actions,1);
  await act(async()=>{first.reject(new Error('ack lost'));await flush()});
  act(()=>button(tree,'bots.groupChat.plan.start').props.onClick());assert.equal(actions,2);
  const writes=state.calls.filter(value=>value.op.endsWith('.start'));assert.deepEqual(writes[0],writes[1]);
  act(()=>tree.unmount());await act(async()=>second.resolve({accepted:true,plan:plan({revision:2,status:'running',execution:{state:'running'}})}));
  assert.deepEqual(state.posts,[]);
});

test('retained old-group callbacks and old-host responses cannot mutate or navigate the new scope',async()=>{
  state.generation=1;state.calls=[];state.posts=[];const reply=deferred();
  state.invoke=(op,args)=>op.endsWith('.list')?Promise.resolve({plans:[plan({groupId:args.groupId})],settings}):reply.promise;
  const tree=await render(HookView,{});const old=button(tree,'bots.groupChat.plan.start').props.onClick;
  await act(async()=>tree.update(React.createElement(HookView,{groupId:'other'})));
  act(()=>old());assert.equal(state.calls.filter(value=>value.op.endsWith('.start')).length,0);
  act(()=>button(tree,'bots.groupChat.plan.start').props.onClick());state.generation++;
  await act(async()=>reply.resolve({accepted:true,plan:plan({groupId:'other',revision:2,status:'running',execution:{state:'running'}})}));
  assert.deepEqual(state.posts,[]);assert.doesNotMatch(texts(tree),/paseoWork.execution.running/);act(()=>tree.unmount());
});

test('an accepted note with a lost ACK keeps its operation across a newer polled revision',async()=>{
  state.generation=1;state.calls=[];state.posts=[];let revision=1,nativeNotes=0;const receipts=new Map();
  state.invoke=async(op,args)=>{
    if(op.endsWith('.list'))return{plans:[plan({revision,status:'running',execution:{state:'running'}})],settings};
    if(!receipts.has(args.operationId)){nativeNotes++;revision=2;receipts.set(args.operationId,{accepted:true,plan:plan({revision,status:'running',execution:{state:'running'}}),delivery:'queued'});throw new Error('ACK lost after acceptance')}
    return receipts.get(args.operationId);
  };
  function NoteComposer(){const work=useGroupPlans('group');state.work=work;const p=work.data?.plans[0];return p?React.createElement('button',{onClick:()=>work.action(p,'note',{text:'Keep this exact note'})},'add-note'):null}
  const tree=await render(NoteComposer,{});
  await act(async()=>{tree.root.findByType('button').props.onClick();await flush()});
  assert.equal(state.work.data.plans[0].revision,2);assert.match(state.work.error,/ACK lost/);
  await act(async()=>tree.root.findByType('button').props.onClick());
  const writes=state.calls.filter(value=>value.op.endsWith('.note'));assert.equal(writes.length,2);assert.deepEqual(writes[0],writes[1]);assert.equal(writes[1].args.expectedRevision,1);assert.equal(nativeNotes,1);
  act(()=>tree.unmount());
});

test('plan reads coalesce, discard a pre-mutation read, and stop polling after disposal',async()=>{
  const reads=[],values=[],timers=[];const request=()=>{const p=deferred();reads.push(p);return p.promise};
  const subscription=observeGroupPlans('group',value=>values.push(value),assert.fail,request,{set:fn=>{timers.push(fn);return timers.length},clear:()=>{}});
  subscription.refresh();subscription.refresh();assert.equal(reads.length,1);
  reads[0].resolve({plans:[plan()],settings});await flush();assert.equal(values.length,0);assert.equal(reads.length,2);
  subscription.dispose();reads[1].resolve({plans:[plan({revision:2})],settings});await flush();assert.equal(values.length,0);assert.equal(timers.length,0);
});

test('folder selection saves only a loaded host path after explicit selection and ignores a cancelled read',async()=>{
  state.generation=1;state.calls=[];const first=deferred(),late=deferred(),saved=[];let reads=0;
  state.invoke=()=>++reads===1?first.promise:late.promise;
  const controller={pending:null,settings:async(...args)=>{saved.push(args);return true}};
  const tree=await render(WorkProjectDirectory,{groupId:'group',settings,control:controller});
  act(()=>button(tree,'bots.groupChat.settings.projectDirChoose').props.onClick());
  assert.deepEqual(state.calls[0],{op:'groups.plans.directories',args:{groupId:'group'}});assert.equal(saved.length,0);
  await act(async()=>first.resolve({path:'/real/host',parent:'/',directories:[{name:'project',path:'/real/host/project'}]}));
  await act(async()=>button(tree,'paseoWork.directory.select').props.onClick());
  assert.deepEqual(saved,[[settings,{projectDir:'/real/host'}]]);assert.equal(tree.root.findAllByProps({'data-testid':'work-directory-browser'}).length,0);
  act(()=>button(tree,'bots.groupChat.settings.projectDirChoose').props.onClick());
  act(()=>button(tree,'common.cancel').props.onClick());
  await act(async()=>late.resolve({path:'/late',parent:'/',directories:[]}));
  assert.equal(tree.root.findAllByProps({'data-testid':'work-directory-browser'}).length,0);assert.equal(saved.length,1);act(()=>tree.unmount());
});

const taskView=(extra={})=>({id:'delegation',title:'Build the feature',objective:'Implement it',agentId:'native-task',state:'running',createdAt:Date.now(),resultText:'',files:[],stale:false,canAddNote:true,canStop:true,...extra});
test('original DOM task card exposes native-stop recovery without treating unknown as stopped',async()=>{
 let opened=0,stopped=0;
 const tree=await render(CompanionTaskCard,{view:taskView({state:'unknown',error:'TASK_STOP_REQUIRES_NATIVE',canAddNote:false,stale:true}),actions:{open(){opened++},stop:async()=>{stopped++},note:async()=>({delivery:'unknown'}),openFile:async()=>{}}});
 assert.match(texts(tree),/Open the task session and stop it there/);assert.doesNotMatch(texts(tree),/TASK_STOP_REQUIRES_NATIVE/);
 const labels=tree.root.findAllByType('button');act(()=>labels.find(v=>v.props.children?.includes?.('bots.collab.watchWork')).props.onClick());
 await act(async()=>labels.find(v=>v.props.children?.includes?.('bots.collab.stop')).props.onClick());
 assert.equal(opened,1);assert.equal(stopped,1);assert.equal(tree.root.findByProps({'data-bot-task-card':'unknown'}).props['data-bot-task-card'],'unknown');act(()=>tree.unmount());
});
const chip=(tree,key)=>tree.root.findAllByType('button').find(value=>value.children.includes(key));
test('original task card Stop is single-flight and acceptance never invents a cancelled task',async()=>{
  state.generation=1;let calls=0;const pending=deferred();
  const tree=await render(CompanionTaskCard,{view:taskView(),actions:{open(){},stop:()=>{calls++;return pending.promise},note:async()=>({delivery:'queued'}),openFile:async()=>{}}});
  act(()=>{chip(tree,'bots.collab.stop').props.onClick();chip(tree,'bots.collab.stop').props.onClick()});assert.equal(calls,1);
  await act(async()=>pending.resolve());assert.equal(tree.root.findByProps({'data-bot-task-card':'running'}).props['data-bot-task-card'],'running');act(()=>tree.unmount());
});

test('original completed receipt stays frozen even when the live task runs again and opens its recorded file',async()=>{
  state.generation=1;const opened=[],receipt={runSequence:1,status:'completed',title:'First delivery',text:'Original result',workingDir:'/owned',artifacts:[{absolutePath:'/owned/first.md'}]};
  const tree=await render(CompanionTaskCard,{view:taskView({receipt}),attached:true,actions:{open(){},stop:async()=>{},note:async()=>({delivery:'queued'}),openFile:async path=>opened.push(path)}});
  assert.equal(tree.root.findAllByProps({'data-bot-task-card':'completed'}).length,1);assert.equal(chip(tree,'bots.collab.stop'),undefined);assert.equal(chip(tree,'bots.collab.addNote'),undefined);
  const markdown=tree.root.findAllByType('markdown');assert.equal(markdown[0].props.content,'Original result');
  await act(async()=>markdown[1].props.onOpenLink('/changed-by-content'));assert.deepEqual(opened,['/owned/first.md']);act(()=>tree.unmount());
});

test('task note keeps an unconfirmed draft and old host callbacks cannot stop or navigate',async()=>{
  state.generation=1;const pending=deferred();let sent=0,stops=0,opened=0;
  const tree=await render(CompanionTaskCard,{view:taskView(),actions:{open(){opened++},stop:async()=>{stops++},note:()=>{sent++;return pending.promise},openFile:async()=>{}}});
  act(()=>chip(tree,'bots.collab.addNote').props.onClick());act(()=>tree.root.findByType('input').props.onChange({target:{value:'A precise addition'}}));
  act(()=>{tree.root.findByType('form').props.onSubmit({preventDefault(){}});tree.root.findByType('form').props.onSubmit({preventDefault(){}})});assert.equal(sent,1);
  await act(async()=>pending.resolve({delivery:'unknown'}));assert.equal(tree.root.findByType('input').props.value,'A precise addition');assert.match(texts(tree),/paseoTasks.noteUnknown/);
  const stop=chip(tree,'bots.collab.stop').props.onClick,open=chip(tree,'bots.collab.watchWork').props.onClick;state.generation++;
  act(()=>{stop();open()});assert.equal(stops,0);assert.equal(opened,0);act(()=>tree.unmount());
});


test('historical handoff chips keep their frozen artifacts and bind the message instead of a later retry',async()=>{
 const opened=[],p=plan({steps:[{...plan().steps[0],artifacts:[{path:'new.txt',size:1}]}]});
 const message={id:'history',planId:'plan',planStep:0,artifacts:[{path:'old.txt',size:2}]};
 const tree=await render(WorkHandoffFiles,{plan:p,position:0,message,onOpenArtifact:async(...args)=>opened.push(args)});
 assert.doesNotMatch(texts(tree),/new.txt/);
 await act(async()=>{tree.root.findByType('button').props.onClick();await flush()});
 assert.deepEqual(opened,[[p,0,'old.txt','history']]);act(()=>tree.unmount());
});

test('group tasks read only their persisted exact parent and group, preserve frozen results, and bind artifact RPC',async()=>{
 state.generation=1;state.calls=[];state.posts=[];
 const receipt={id:'receipt',runSequence:1,text:'Earlier result',status:'completed',title:'First title',workingDir:'/owned',artifacts:[{path:'old.md'}],createdAt:2};
 const task={id:'task',requestingBotId:'a',parentSessionId:'parent',childSessionId:'child',groupId:'group',title:'New title',objective:'Build',status:'running',control:'active',activity:'running',revision:2,createdAt:1,results:[receipt],artifacts:[{path:'new.md'}]};
 state.invoke=(op,args)=>Promise.resolve(op==='companion.tasks.get'?{task}:null);
 const message={id:'result-message',authorBotId:'a',taskId:'task',taskParentSessionId:'parent',taskResult:receipt};
 const tree=await render(GroupTaskCard,{groupId:'group',message});
 assert.deepEqual(state.calls[0].args,{botId:'a',taskId:'task',parentAgentId:'parent',groupId:'group'});
 assert.match(texts(tree),/First title/);assert.equal(tree.root.findAllByProps({'data-bot-task-card':'running'}).length,0);
 const expanded=tree.root.findAllByType('button').find(b=>b.findAllByType('svg').length&&b.props['aria-expanded']===false);
 act(()=>expanded.props.onClick());
 const file=tree.root.findAllByType('markdown').find(m=>m.props.onOpenLink);
 await act(async()=>file.props.onOpenLink());
 assert.deepEqual(state.calls.at(-1),{op:'paseo.openTaskArtifact',args:{botId:'a',taskId:'task',parentAgentId:'parent',receiptId:'receipt',groupId:'group',path:'old.md'}});
 const open=tree.root.findAllByType('button').find(b=>b.props.title)?.props.onClick;
 state.generation++;act(()=>open());assert.deepEqual(state.posts,[]);act(()=>tree.unmount());
});
