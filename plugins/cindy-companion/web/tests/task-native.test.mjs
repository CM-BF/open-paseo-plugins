import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const state = globalThis.__TASK_NATIVE__ = {};
const bundled = await build({ stdin: {contents:`export {TaskOwnerChip} from './task-owner';export {NativeCompanionTaskCard} from './task-card'; export {taskTransformer} from './task-transformer';`,resolveDir:new URL('../../client',import.meta.url).pathname,loader:'tsx'},
 bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime'],plugins:[{name:'host',setup(builder){
  builder.onResolve({filter:/^(react-native|@getpaseo\/plugin\/client(?:\/ui)?|\.\/data)$/},({path})=>({path,namespace:'host'}));
  builder.onLoad({filter:/.*/,namespace:'host'},({path})=>({contents:path==='react-native'?`export const ActivityIndicator='ActivityIndicator',Image='Image',Pressable='Pressable',Text='Text',TextInput='TextInput',View='View';`
   :path==='./data'?`export const useSettingsInvoke=id=>globalThis.__TASK_NATIVE__.invokes[id];`
   :path.endsWith('/ui')?`export const Icon='Icon';`
   :`export const defineTranslations=value=>value;export const useTranslation=messages=>({locale:globalThis.__TASK_NATIVE__.locale??'en',t:(key,args={})=>{let value=key.split('.').reduce((o,k)=>o?.[k],messages.resources[globalThis.__TASK_NATIVE__.locale??'en'])??key;return value.replace(/{{(\\w+)}}/g,(_,k)=>String(args[k]??''))}});` }));
 }}]});
const module={exports:{}};new Function('require','module','exports',bundled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const {TaskOwnerChip,NativeCompanionTaskCard,taskTransformer}=module.exports;
const base={id:'task',requestingBotId:'bot',targetBotId:null,parentSessionId:'parent',childSessionId:'child',title:'Build report',objective:'Build',revision:1,status:'running',control:'active',activity:'running',createdAt:1,acceptedAt:1,completedAt:null,resultSummary:null,artifacts:[],lastError:null,results:[],queue:[],responsibility:'owned'};
const props=(host='a',data={})=>({host:{id:host},agentId:'parent',item:{data:{botId:'bot',taskId:'task',parentAgentId:'parent',...data}},theme:{colors:{foreground:'#fff',foregroundMuted:'#999',surface0:'#111',surface1:'#222',surface2:'#333',border:'#444',accent:'#fa0',statusSuccess:'#0f0',statusDanger:'#f00'}},layout:{compact:false},onOpenAgent:id=>state.opens.push({host,id})});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const ok=task=>({ok:true,value:{task}});
const render=async(p=props())=>{let tree;await act(async()=>{tree=create(React.createElement(NativeCompanionTaskCard,p))});return tree};
const press=(tree,label)=>tree.root.findAllByType('Pressable').find(node=>node.props.accessibilityLabel===label);
const text=tree=>JSON.stringify(tree.toJSON());
function setup(task=base){state.locale='en';state.opens=[];state.calls=[];state.invokes={a:(op,args)=>{state.calls.push({host:'a',op,args});return Promise.resolve(ok(task));},b:(op,args)=>{state.calls.push({host:'b',op,args});return Promise.resolve(ok({...task,title:'Other host'}));}};}
function tool(name='cindy_memory.start_session_task',value={action:'start_session_task',botId:'bot',taskId:'task',accepted:true,task:base}){return{phase:'complete',item:{type:'tool_call',callId:'call',name,status:'completed',error:null,detail:{type:'unknown',input:{},output:{content:[{type:'text',text:JSON.stringify(value)}],isError:false}}}};}
test('only successful scoped delegation tool receipts become native cards; failures and lookalikes stay visible',()=>{
 assert.deepEqual(taskTransformer.transform(tool()).items[0].data,{botId:'bot',taskId:'task',parentAgentId:'parent'});
 assert.ok(taskTransformer.transform(tool('mcp__cindy_memory__start_session_task')));
 for(const name of ['echo','start_session_task','foreign.start_session_task','mcp__foreign__start_session_task'])assert.equal(taskTransformer.transform(tool(name)),undefined);
 const failed=tool();failed.item.status='failed';failed.item.error='failed';assert.equal(taskTransformer.transform(failed),undefined);
 const mcpError=tool();mcpError.item.detail.output.isError=true;assert.equal(taskTransformer.transform(mcpError),undefined);
 assert.equal(taskTransformer.transform(tool(undefined,{action:'start_session_task',accepted:true,botId:'foreign',taskId:'task',task:base})),undefined);
 const checking=tool('cindy_memory.check_session_task',{action:'check_session_task',botId:'bot',taskId:'task',task:{...base,results:[{id:'receipt',status:'completed'}]}});
 assert.equal(taskTransformer.transform(checking).items[0].data.receiptId,'receipt');
});
test('a card on a different parent conversation never reads or controls that task',async()=>{
 setup();const tree=await render({...props(),agentId:'foreign'});assert.equal(state.calls.length,0);assert.match(text(tree),/does not belong/);act(()=>tree.unmount());
});
test('native Stop is singleflight and accepted-but-unconfirmed remains unknown with a recovery action',async()=>{
 setup();const pending=defer();let task=base;
 state.invokes.a=(op,args)=>{state.calls.push({op,args});return op.endsWith('.stop')?pending.promise:Promise.resolve(ok(task));};
 const tree=await render();const stop=press(tree,'Stop').props.onPress;act(()=>{stop();stop()});assert.equal(state.calls.filter(x=>x.op.endsWith('.stop')).length,1);
 assert.doesNotMatch(text(tree),/"Stopped"/);
 task={...base,revision:2,control:'unknown',activity:'unknown',status:'failed',lastError:'STOP_NOT_CONFIRMED'};
 await act(async()=>pending.resolve(ok(task)));assert.match(text(tree),/stop is not yet confirmed/);assert.ok(press(tree,'Stop'));act(()=>tree.unmount());
});
test('native task explains exact-stop and admission uncertainty without exposing codes or claiming completion',async t=>{
 for(const [code,expected] of [['TASK_STOP_REQUIRES_NATIVE',/Open the task session and stop it there/],['ADMISSION_OUTCOME_UNKNOWN',/may have been sent/]]){
  const task={...base,status:'failed',control:'unknown',activity:'unknown',lastError:code};setup(task);
  const tree=await render();t.after(()=>act(()=>tree.unmount()));assert.match(text(tree),expected);assert.doesNotMatch(text(tree),new RegExp(code));
  assert.equal(tree.root.findByProps({testID:'cindy-task-card'}).props.accessibilityLabel,'Task status unavailable');
  assert.ok(press(tree,'Stop'));assert.equal(press(tree,'Continue task'),undefined);
  act(()=>press(tree,'Open task').props.onPress());assert.deepEqual(state.opens,[{host:'a',id:'child'}]);act(()=>tree.unmount());
 }
});
test('Chinese native task recovery distinguishes an unsent input from an uncertain send',async t=>{
 for(const [task,expected] of [[{...base,status:'failed',control:'paused',activity:'idle',blocked:{code:'HOST_UPGRADE_REQUIRED',message:'raw backend fallback'}},/这条内容尚未发送/],[{...base,status:'failed',control:'paused',activity:'idle',blocked:{code:'PROVIDER_ADMISSION_UNAVAILABLE',message:'raw backend fallback'}},/这条内容尚未发送/],[{...base,status:'failed',control:'unknown',activity:'unknown',lastError:'ADMISSION_OUTCOME_UNKNOWN'},/这条内容可能已经发送/]]){
  setup(task);state.locale='zh-CN';const tree=await render();t.after(()=>act(()=>tree.unmount()));
  assert.match(text(tree),expected);assert.doesNotMatch(text(tree),/HOST_UPGRADE_REQUIRED|PROVIDER_ADMISSION_UNAVAILABLE|ADMISSION_OUTCOME_UNKNOWN|raw backend fallback|升级/);
  assert.ok(press(tree,'停止'));assert.equal(Boolean(press(tree,'继续任务')),task.control==='paused');act(()=>tree.unmount());
 }
});
test('native lost-ACK note retry keeps the original operation while polling advances revision',async()=>{
 setup();const first=defer();let task=base,notes=0;
 state.invokes.a=(op,args)=>{state.calls.push({op,args});if(op.endsWith('.message'))return ++notes===1?first.promise:Promise.resolve(ok(task));return Promise.resolve(ok(task));};
 const tree=await render();act(()=>press(tree,'Add a note').props.onPress());act(()=>tree.root.findByType('TextInput').props.onChangeText('Check edges'));
 act(()=>{const submit=tree.root.findByType('TextInput').props.onSubmitEditing;submit();submit()});assert.equal(notes,1);
 task={...base,revision:2,queue:[{id:'n',text:'Check edges',status:'queued'}]};await act(async()=>first.reject(new Error('ACK lost')));
 assert.equal(tree.root.findByType('TextInput').props.value,'Check edges');assert.match(text(tree),/ACK lost/);
 await act(async()=>tree.root.findByType('TextInput').props.onSubmitEditing());
 const inputs=state.calls.filter(x=>x.op.endsWith('.message'));assert.equal(inputs.length,2);assert.equal(inputs[0].args.operationId,inputs[1].args.operationId);assert.match(text(tree),/Queued for/);act(()=>tree.unmount());
});
test('old host callbacks and file responses cannot navigate, mutate, or replace the new host card',async()=>{
 const receipt={id:'receipt',runSequence:1,text:'Frozen result',status:'completed',title:'Original report',workingDir:'/owned',artifacts:[{path:'result.md'}],createdAt:2};
 setup({...base,results:[receipt]});const pending=defer(),files=[];
 const original=state.invokes.a;state.invokes.a=(op,args)=>op.endsWith('.artifact')?pending.promise:original(op,args);
 const p={...props('a',{receiptId:'receipt'}),navigation:{openFile:async value=>files.push(value)}};const tree=await render(p);
 assert.match(text(tree),/Original report/);assert.equal(press(tree,'Stop'),undefined);assert.equal(press(tree,'Add a note'),undefined);
 const open=press(tree,'Open task').props.onPress;
 const file=tree.root.findAllByType('Pressable').find(node=>node.findAllByType('Text').some(t=>t.props.children==='result.md'));
 act(()=>file.props.onPress());await act(async()=>tree.update(React.createElement(NativeCompanionTaskCard,props('b'))));act(()=>open());
 await act(async()=>pending.resolve({ok:true,value:{workspaceId:'workspace',path:'result.md'}}));assert.deepEqual(files,[]);assert.deepEqual(state.opens,[]);assert.match(text(tree),/Other host/);act(()=>tree.unmount());
});


test('task files reject an invalid host path and await a valid native navigation failure visibly',async()=>{
 const receipt={id:'receipt',runSequence:1,text:'Result',status:'completed',title:'Report',workingDir:'/owned',artifacts:[{path:'report.md'}],createdAt:2};
 setup({...base,results:[receipt]});const original=state.invokes.a,nav=[],pending=defer();let bad=true;
 state.invokes.a=(op,args)=>op.endsWith('.artifact')?Promise.resolve({ok:true,value:{workspaceId:'workspace',path:bad?'../private':'report.md'}}):original(op,args);
 const tree=await render({...props('a',{receiptId:'receipt'}),navigation:{openFile:value=>{nav.push(value);return pending.promise}}});
 const file=()=>tree.root.findAllByType('Pressable').find(node=>node.findAllByType('Text').some(t=>t.props.children==='report.md'));
 await act(async()=>file().props.onPress());assert.deepEqual(nav,[]);assert.match(text(tree),/valid task file/);
 bad=false;act(()=>file().props.onPress());await act(async()=>{await Promise.resolve()});assert.deepEqual(nav,[{workspaceId:'workspace',path:'report.md',serverId:'a'}]);
 await act(async()=>pending.reject(new Error('Workspace unavailable')));assert.match(text(tree),/Workspace unavailable/);act(()=>tree.unmount());
});


test('an unsent blocked task shows its exact host requirement and resumes the same task without replaying the objective',async()=>{
 const blocked={...base,revision:2,status:'failed',control:'paused',activity:'idle',blocked:{code:'HOST_UPGRADE_REQUIRED',message:'Task has not been sent; upgrade the host.'}};setup(blocked);
 const tree=await render();assert.match(text(tree),/input has not been sent/);assert.doesNotMatch(text(tree),/HOST_UPGRADE_REQUIRED/);assert.ok(press(tree,'Stop'));assert.equal(tree.root.findAllByType('ActivityIndicator').length,0);
 await act(async()=>press(tree,'Continue task').props.onPress());const call=state.calls.find(x=>x.op==='companion.tasks.message');assert.equal(call.args.mode,'resume');assert.equal(call.args.taskId,'task');assert.equal(call.args.message,undefined);assert.ok(call.args.operationId);act(()=>tree.unmount());
});

test('owner pill queries the exact current child and keeps creation ownership after follow-up responsibility is released',async()=>{
 setup();const owner={botId:'bot',name:'Cindy',avatar:'cindy://avatar/preset/dash',avatarColor:'violet',taskId:'task',responsibility:'released'};
 state.invokes.a=(op,args)=>{state.calls.push({op,args});return Promise.resolve({ok:true,value:{owner}})};
 let tree;await act(async()=>{tree=create(React.createElement(TaskOwnerChip,{...props(),workspaceId:'workspace',agentId:'child',onOpenBot:id=>state.opens.push(id)}))});
 assert.deepEqual(state.calls,[{op:'companion.tasks.owner',args:{agentId:'child',workspaceId:'workspace'}}]);
 const button=tree.root.findByType('Pressable');assert.equal(button.props.style.height,24);assert.equal(button.props.style.maxWidth,200);assert.match(tree.root.findByType('Image').props.source.uri,/^data:image/);assert.match(text(tree),/Cindy's background task/);
 act(()=>button.props.onPress());assert.deepEqual(state.opens,['bot']);act(()=>tree.unmount());
});

test('owner pill discards old host reads and retained callbacks when the active agent changes',async()=>{
 setup();const first=defer(),second=defer(),owner={botId:'bot',name:'Cindy',avatar:'C',avatarColor:'violet',taskId:'task',responsibility:'owned'};
 state.invokes.a=()=>first.promise;state.invokes.b=()=>second.promise;
 const p=host=>({...props(host),workspaceId:'workspace',agentId:host==='a'?'child-a':'child-b',onOpenBot:id=>state.opens.push({host,id})});
 let tree;await act(async()=>{tree=create(React.createElement(TaskOwnerChip,p('a')))});await act(async()=>first.resolve({ok:true,value:{owner}}));
 const stale=tree.root.findByType('Pressable').props.onPress;
 act(()=>tree.update(React.createElement(TaskOwnerChip,p('b'))));assert.equal(tree.toJSON(),null);act(()=>stale());assert.deepEqual(state.opens,[]);
 await act(async()=>second.resolve({ok:true,value:{owner:null}}));assert.equal(tree.toJSON(),null);act(()=>tree.unmount());
});
