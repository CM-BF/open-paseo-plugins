import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import React from 'react';
import { act, create } from 'react-test-renderer';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.window=new EventTarget();window.setTimeout=setTimeout;window.matchMedia=()=>({matches:true});
globalThis.document=new EventTarget();document.visibilityState='visible';document.hasFocus=()=>true;document.querySelector=()=>null;document.activeElement=null;
globalThis.HTMLElement=class{};globalThis.requestAnimationFrame=fn=>fn();
const state=globalThis.__HISTORY_TEST__={calls:[],posts:[],host:'first'};
const web=new URL('..',import.meta.url).pathname;
const mocks={
 translation:`export const useTranslation=()=>({t:(key,vars)=>key+(vars?.name?':'+vars.name:''),i18n:{language:'en'}});`,
 controls:`import {createElement} from 'react';const c=tag=>({children,...props})=>createElement(tag,props,children);export const Button=c('button'),Tip=c('tip'),Popover=c('popover'),PopoverAnchor=c('anchor'),PopoverContent=c('popover-content'),PopoverTrigger=c('popover-trigger'),DropdownMenu=c('dropdown'),DropdownMenuContent=c('menu'),DropdownMenuItem=c('menu-item'),DropdownMenuTrigger=c('trigger'),DropdownMenuLabel=c('menu-label'),DropdownMenuSeparator=c('separator');`,
 avatar:`export const BotAvatar=()=>null;export const BotGroupAvatarStack=()=>null;`,
 mention:`export const useBotGroupMentionPicker=({onTextChange})=>({list:null,tracked:[],setTracked(){},reset(){},onChange:onTextChange,onKeyDown:()=>false,textareaProps:{}});`,
 send:`import {createElement} from 'react';export const SendButton=props=>createElement('send-button',props);`,
 bridge:`export class BridgeError extends Error{constructor(code,message){super(message);this.code=code;}}export const initValue=()=>({host:{id:globalThis.__HISTORY_TEST__.host}});export const invoke=(op,args)=>{const s=globalThis.__HISTORY_TEST__;s.calls.push({op,args});return s.invoke(op,args)};export const post=(type,fields)=>globalThis.__HISTORY_TEST__.posts.push({type,...fields});`,
 markdown:`import {createElement} from 'react';export const MarkdownRenderer=({content})=>createElement('markdown',{},content);`,
 spinner:`export const Spinner=()=>null;`,
 group:`import {useState} from 'react';export const mergeMessages=(a,b)=>[...new Map([...a,...b].map(v=>[v.id,v])).values()];export const useGroup=()=>{const[data,setData]=useState(globalThis.__HISTORY_TEST__.group);return{data,setData,error:'',refresh(){}};};`,
 history:`export const useGroupHistory=()=>globalThis.__HISTORY_TEST__.history;`,
 work:`export const useGroupPlans=()=>({data:null,error:'',pending:null,refresh(){}});`,
 settings:`export const GroupSettings=()=>null;`,
};
const result=await build({stdin:{contents:`export {GroupHistoryThread} from './group-history-thread';export {GroupChat} from './group-chat';export {GroupHistoryMessageView} from './group-history-message';export {createHistoryIntents,historyError} from './group-history-rpc';export {observeHistory,mergeHistoryMessages,readGroupHistory,useGroupHistory} from './group-history-store';`,resolveDir:web,loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},nodePaths:[web+'/node_modules'],external:['react','react/jsx-runtime','lucide-react'],plugins:[{name:'host-boundary',setup(b){b.onResolve({filter:/.*/},a=>{const p=a.path;
 let name=p==='react-i18next'?'translation':/(?:^|\/)(button|tooltip|popover|dropdown-menu)$/.test(p)?'controls':/(?:BotAvatar|BotGroupAvatars)$/.test(p)?'avatar':/useBotGroupMentionPicker$/.test(p)?'mention':/SendButton$/.test(p)?'send':/(?:^|\/)bridge$/.test(p)?'bridge':/(?:MarkdownRenderer|memory-markdown)$/.test(p)?'markdown':/spinner$/.test(p)?'spinner':null;
 if(a.importer.endsWith('/group-chat.tsx'))name=p==='./adapters/group-store'?'group':p==='./group-history-store'?'history':p==='./adapters/group-plans'?'work':p==='./group-settings'?'settings':name;
 if(name)return{path:name,namespace:'mock'};
 if(p.startsWith('@/')){const base=web+'/../vendor/renderer/'+p.slice(2);return{path:base+(existsSync(base+'.ts')?'.ts':'.tsx')}}
 });b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path]}));}}]});
const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const{GroupHistoryThread,GroupChat,GroupHistoryMessageView,createHistoryIntents,historyError,observeHistory,mergeHistoryMessages,readGroupHistory,useGroupHistory}=module.exports;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve()};
const members=[{botId:'a',name:'A',avatar:null,avatarColor:null,status:'active'},{botId:'b',name:'B',avatar:null,avatarColor:null,status:'active'}];
const message=(id,content,sequence=1)=>({id,content,sequence,createdAt:1000,historyRevision:1,kind:'message',authorKind:'user',authorName:'You'});
const round={id:'round',status:'unknown',position:0,createdAt:1,updatedAt:2,code:'GROUP_STOP_REQUIRES_NATIVE',steps:[{botId:'a',botName:'A',status:'unknown',agentId:'exact-native'}]};
let unique=0;
const reset=()=>{state.calls=[];state.posts=[];state.root='root-'+(++unique);state.thread={groupId:'g',rootId:state.root,revision:1,root:message(state.root,'Original'),replies:[],quoteSources:[],hasMore:false,readBefore:0,following:false,round:null,sharedReplies:{}};state.group={group:{id:'g',name:'Group',members,revision:1,replyMode:'all',round:null},messages:[state.thread.root],hasOlder:false};state.history={data:{groupId:'g',revision:1,messages:[state.thread.root],quoteSources:[],threads:[]},error:'',refresh(){}};state.invoke=async op=>{if(op==='groups.threads.get')return structuredClone(state.thread);throw new Error('Unexpected '+op)};};
const render=async(C,props)=>{let tree;await act(async()=>{tree=create(React.createElement(C,props))});return tree};
const thread=extra=>render(GroupHistoryThread,{groupId:'g',rootId:state.root,members,readOnly:false,onClose(){},onChanged(){},onRevealShare(){},...extra});
const text=tree=>JSON.stringify(tree.toJSON());
const button=(tree,key)=>tree.root.findAllByType('button').find(v=>v.props.children===key||v.props['aria-label']===key);

test('lost mutation ACK retries immutable identity after newer reads and coalesces double clicks',async()=>{
 const calls=[],first=deferred();let n=0;const controller=createHistoryIntents((op,args)=>{calls.push({op,args});return ++n===1?first.promise:Promise.resolve({revision:4})});
 const args={groupId:'g',rootId:'r',following:true};const a=controller.run('follow','groups.threads.follow',args),b=controller.run('follow','groups.threads.follow',args);assert.equal(a,b);assert.equal(calls.length,1);
 first.reject(new Error('lost ACK'));await assert.rejects(a);await controller.run('follow','groups.threads.follow',args);assert.deepEqual(calls[0],calls[1]);
 await controller.run('follow','groups.threads.follow',{...args,following:false});assert.notEqual(calls[2].args.operationId,calls[1].args.operationId);controller.dispose();await assert.rejects(controller.run('x','op',{}));
});
test('history polling ignores superseded reads, lower revisions and late host responses after disposal',async()=>{
 const reads=[],values=[],timers=[];const observer=observeHistory(()=>{const d=deferred();reads.push(d);return d.promise},v=>values.push(v),()=>{}, {set:f=>{timers.push(f);return timers.length},clear(){}});
 observer.refresh();reads[0].resolve({revision:1});await flush();assert.equal(values.length,0);assert.equal(reads.length,2);reads[1].resolve({revision:5});await flush();assert.deepEqual(values,[{revision:5}]);
 timers.pop()();reads[2].resolve({revision:4});await flush();assert.equal(values.length,1);observer.refresh();observer.dispose();reads[3].resolve({revision:6});await flush();assert.equal(values.length,1);
});
test('history tombstones and reaction revisions do not roll backwards',()=>{
 const newest={...message('m','',1),deleted:true,historyRevision:8};const merged=mergeHistoryMessages([newest],[{...message('m','stale',1),historyRevision:7}]);assert.equal(merged[0].deleted,true);assert.equal(merged[0].content,'');
});
test('original topic panel keeps a rejected reply and uses the same client identity after revision advances',async()=>{
 reset();let attempt=0;state.invoke=async(op,args)=>{if(op==='groups.threads.get')return structuredClone(state.thread);if(op==='groups.threads.reply'){if(++attempt===1)throw new Error('ACK lost');return{accepted:true,message:{...message('reply','Question',2),threadRootId:state.root},round:null}};throw new Error(op)};
 const tree=await thread();act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'Question'}}));await act(async()=>tree.root.findByType('send-button').props.onClick());assert.equal(tree.root.findByType('textarea').props.value,'Question');assert.match(text(tree),/ACK lost/);
 state.thread.revision=2;await act(async()=>tree.root.findByType('send-button').props.onClick());const sends=state.calls.filter(v=>v.op==='groups.threads.reply');assert.deepEqual(sends[0],sends[1]);assert.equal(tree.root.findByType('textarea').props.value,'');assert.equal(tree.root.findAllByProps({'data-bot-group-message-id':'reply'}).length,1);act(()=>tree.unmount());
});
test('send-and-share partial failure retries only the share, never the accepted reply',async()=>{
 reset();let shared=0;state.invoke=async op=>{if(op==='groups.threads.get')return structuredClone(state.thread);if(op==='groups.threads.reply')return{accepted:true,message:{...message('reply','Hello',2),threadRootId:state.root},round:null};if(op==='groups.threads.shareToMain'){if(++shared===1)throw new Error('share ACK lost');return{messageId:'main-share',revision:3}};throw new Error(op)};
 const tree=await thread();act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'Hello'}}));act(()=>tree.root.findByProps({role:'checkbox'}).props.onClick());await act(async()=>tree.root.findByType('send-button').props.onClick());assert.match(text(tree),/alsoSendFailed/);assert.equal(tree.root.findByType('textarea').props.value,'');
 await act(async()=>button(tree,'bots.groupChat.server.thread.retryPost').props.onClick());assert.equal(state.calls.filter(v=>v.op==='groups.threads.reply').length,1);const shares=state.calls.filter(v=>v.op==='groups.threads.shareToMain');assert.deepEqual(shares[0],shares[1]);assert.doesNotMatch(text(tree),/alsoSendFailed/);act(()=>tree.unmount());
});
test('follow waits for a server read and a reply double click cannot create two sends',async()=>{
 reset();const follow=deferred(),send=deferred();state.invoke=async op=>op==='groups.threads.get'?structuredClone(state.thread):op==='groups.threads.follow'?follow.promise:op==='groups.threads.reply'?send.promise:Promise.reject(new Error(op));
 const tree=await thread();const toggle=tree.root.findByProps({'data-thread-follow':''});act(()=>toggle.props.onClick());assert.equal(tree.root.findByProps({'data-thread-follow':''}).props['aria-pressed'],false);
 state.thread.following=true;state.thread.revision=2;await act(async()=>follow.resolve({following:true,revision:2}));assert.equal(tree.root.findByProps({'data-thread-follow':''}).props['aria-pressed'],true);
 act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'Once'}}));act(()=>{tree.root.findByType('send-button').props.onClick();tree.root.findByType('send-button').props.onClick()});assert.equal(state.calls.filter(v=>v.op==='groups.threads.reply').length,1);
 act(()=>tree.unmount());await act(async()=>send.resolve({accepted:true,message:{...message('late','Once'),threadRootId:state.root},round:null}));
});
test('unknown stop has an independent recovery action while a nonempty draft stays intact',async()=>{
 reset();state.thread.round=round;state.invoke=async op=>op==='groups.threads.get'?structuredClone(state.thread):op==='groups.threads.stop'?{accepted:true,round}:Promise.reject(new Error(op));
 const tree=await thread();act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'Unsent context'}}));assert.match(text(tree),/Open the task session and stop it there/);
 act(()=>button(tree,'paseoGroups.openTask').props.onClick());assert.deepEqual(state.posts,[{type:'navigate-agent',agentId:'exact-native'}]);await act(async()=>button(tree,'bots.groupChat.composer.stop').props.onClick());assert.equal(state.calls.find(v=>v.op==='groups.threads.stop').args.roundId,'round');assert.equal(tree.root.findByType('textarea').props.value,'Unsent context');assert.match(text(tree),/Open the task session/);act(()=>tree.unmount());
});
test('unsupported topic service exposes an error and never renders successful empty history',async()=>{
 reset();state.invoke=async()=>{const error=new Error('not connected');error.code='UNSUPPORTED';throw error};const tree=await thread();assert.match(text(tree),/not connected on this host/);assert.equal(tree.root.findByType('send-button').props.disabled,true);assert.equal(tree.root.findAllByProps({'data-testid':'bot-group-thread-replies'}).length,0);act(()=>tree.unmount());
});
test('main quote keeps original preview and stable send identity on lost ACK, and removal preserves draft',async()=>{
 reset();let attempts=0;state.invoke=async(op,args)=>{assert.equal(op,'groups.history.send');if(++attempts===1)throw new Error('lost quote ACK');return{accepted:true,message:{...message('sent','Reply',2),quote:{messageId:state.root,authorKind:'user',authorName:'You',excerpt:'Original',attachmentCount:0,attachmentName:null,sequence:1}},round:null}};
 const tree=await render(GroupChat,{groupId:'g'});act(()=>button(tree,'bots.groupChat.server.quoteReply').props.onClick({stopPropagation(){}}));assert.equal(tree.root.findAllByProps({'data-testid':'bot-group-quote-preview'}).length,1);
 act(()=>tree.root.findByType('textarea').props.onChange({target:{value:'Reply'}}));await act(async()=>tree.root.findByType('send-button').props.onClick());assert.equal(tree.root.findByType('textarea').props.value,'Reply');await act(async()=>tree.root.findByType('send-button').props.onClick());assert.deepEqual(state.calls[0],state.calls[1]);assert.deepEqual(state.calls[0].args.quote,{messageId:state.root});assert.equal(tree.root.findAllByProps({'data-testid':'bot-group-quote-preview'}).length,0);
 act(()=>tree.unmount());
 reset();const second=await render(GroupChat,{groupId:'g'});act(()=>button(second,'bots.groupChat.server.quoteReply').props.onClick({stopPropagation(){}}));act(()=>second.root.findByType('textarea').props.onChange({target:{value:'Keep this'}}));act(()=>button(second,'bots.groupChat.quote.remove').props.onClick());assert.equal(second.root.findByType('textarea').props.value,'Keep this');act(()=>second.unmount());
});


test('original reaction controls wait for acknowledgement and retain the exact failed toggle identity',async()=>{
 reset();let attempts=0;state.invoke=async(op)=>{assert.equal(op,'groups.history.react');if(++attempts===1)throw new Error('reaction ACK lost');return{accepted:true,revision:4}};
 const tree=await render(GroupHistoryMessageView,{groupId:'g',message:state.thread.root,members,locale:'en',historyEnabled:true,onChanged(){}});
 await act(async()=>button(tree,'👍').props.onClick());assert.match(text(tree),/reaction ACK lost/);
 await act(async()=>button(tree,'👍').props.onClick());assert.deepEqual(state.calls[0],state.calls[1]);assert.equal(state.calls[0].args.present,true);assert.equal(tree.root.findAllByProps({'data-reaction-corner':'right'}).length,0);act(()=>tree.unmount());
});
test('shared reply cards never display an unavailable source fallback and live quote tombstones hide excerpts',async()=>{
 reset();const hidden={...message('shared','untrusted fallback'),threadShare:{messageId:'reply',threadRootId:state.root,status:'unavailable',authorKind:'bot',authorBotId:'a',authorName:'A',sharedByAuthor:false,content:'untrusted source text',attachments:[],createdAt:1,edited:false}};
 const tree=await render(GroupHistoryMessageView,{groupId:'g',message:hidden,members,locale:'en',onThread(){}});assert.doesNotMatch(text(tree),/untrusted/);assert.match(text(tree),/sourceUnavailable/);
 const quoted={...message('quote','My reply'),quote:{messageId:'source',authorName:'A',authorKind:'bot',excerpt:'old private excerpt',attachmentCount:0,attachmentName:null,sequence:1}};
 await act(async()=>tree.update(React.createElement(GroupHistoryMessageView,{groupId:'g',message:quoted,members,locale:'en',quoteSources:[{...message('source','',1),deleted:true,historyRevision:2}],onLocate(){}})));
 assert.doesNotMatch(text(tree),/old private excerpt/);assert.equal(tree.root.findByProps({'data-testid':'bot-group-quote'}).props['data-quote-state'],'deleted');act(()=>tree.unmount());
});
test('a closed topic ignores a late read and does not mark old pages or unfocused views as read',async()=>{
 reset();document.hasFocus=()=>false;const pending=deferred();state.invoke=()=>pending.promise;const tree=await thread();assert.equal(state.calls[0].args.markRead,false);act(()=>tree.unmount());await act(async()=>pending.resolve(state.thread));assert.equal(state.calls.length,1);document.hasFocus=()=>true;
});

test('the real history hook drains byte pages and retains full bodies and all requested IDs',async()=>{
 reset();const body='中文'.repeat(8000),rows=[message('one',body,1),message('two',body,2),message('three',body,3)];
 state.invoke=async(op,args)=>{assert.equal(op,'groups.history.get');assert.deepEqual(args.messageIds,['one','two','three']);const older=args.beforeSequence!==undefined;return{groupId:'g',revision:older?4:3,messages:older?rows.slice(0,2):rows.slice(2),quoteSources:[],threads:[],nextBeforeSequence:older?null:3}};
 let value;function Probe(){value=useGroupHistory('g',rows,'en');return React.createElement('history-probe',{},value.error||String(value.data?.messages.length??0))}
 const tree=await render(Probe,{});assert.equal(value.data.messages.length,3);assert.deepEqual(value.data.messages.map(row=>row.content),[body,body,body]);assert.equal(value.data.revision,4);assert.equal(value.data.nextBeforeSequence,null);assert(state.calls.some(call=>call.args.beforeSequence===3));act(()=>tree.unmount());
});
test('history pagination rejects nonprogress and incomplete results and stops requesting after close',async()=>{
 const result=()=>({groupId:'g',revision:1,messages:[message('two','second',2)],quoteSources:[],threads:[],nextBeforeSequence:2});
 await assert.rejects(readGroupHistory('g',['one','two'],async()=>result()),/invalid history continuation/);
 await assert.rejects(readGroupHistory('g',['one','two'],async()=>({...result(),nextBeforeSequence:null})),/incomplete message history/);
 const pending=deferred();let calls=0,alive=true;const read=readGroupHistory('g',['one','two'],()=>{calls++;return pending.promise},()=>alive);alive=false;pending.resolve(result());await assert.rejects(read,/closed/);assert.equal(calls,1);
});
test('topic older pages use the returned cursor and preserve prior share references with full messages',async()=>{
 reset();const latest={...state.thread,replies:[{...message('new','New full body',3),threadRootId:state.root}],hasMore:true,nextBeforeSequence:3,sharedReplies:{new:{messageId:'main-new',bySelf:true}}};
 state.invoke=async(op,args)=>{assert.equal(op,'groups.threads.get');return args.beforeSequence===3?{...latest,replies:[{...message('old','Old full body',1),threadRootId:state.root}],hasMore:false,nextBeforeSequence:null,sharedReplies:{old:{messageId:'main-old',bySelf:true}}}:latest};
 const tree=await thread();await act(async()=>button(tree,'bots.groupChat.timeline.loadEarlier').props.onClick());assert.match(text(tree),/Old full body/);assert.match(text(tree),/New full body/);assert.equal(tree.root.findAllByProps({'data-bot-group-message-id':'old'}).length,1);assert.equal(tree.root.findAllByProps({'data-bot-group-message-id':'new'}).length,1);assert.equal(button(tree,'bots.groupChat.timeline.loadEarlier'),undefined);assert.equal(state.calls.find(call=>call.args.beforeSequence===3).args.markRead,false);act(()=>tree.unmount());
});
test('a retained draft cannot send while the reopened topic is still loading',async()=>{
 reset();const first=await thread();act(()=>first.root.findByType('textarea').props.onChange({target:{value:'Retained draft'}}));act(()=>first.unmount());const read=deferred();state.calls=[];state.invoke=()=>read.promise;
 const next=await thread();assert.equal(next.root.findByType('textarea').props.value,'Retained draft');await act(async()=>next.root.findByType('textarea').props.onKeyDown({nativeEvent:{isComposing:false},keyCode:13,key:'Enter',shiftKey:false,preventDefault(){}}));assert.equal(state.calls.filter(call=>call.op==='groups.threads.reply').length,0);act(()=>next.unmount());await act(async()=>read.resolve(state.thread));
});
test('group deletion disables topic Stop and Continue and retained callbacks cannot dispatch them',async()=>{
 reset();state.thread.round=round;let tree=await thread({readOnly:true});const stop=button(tree,'bots.groupChat.composer.stop');assert.equal(stop.props.disabled,true);act(()=>stop.props.onClick());assert.equal(state.calls.some(call=>call.op==='groups.threads.stop'),false);act(()=>tree.unmount());
 state.thread.round={...round,status:'waiting'};tree=await thread({readOnly:true});const resume=button(tree,'bots.groupChat.timeline.continue');assert.equal(resume.props.disabled,true);act(()=>resume.props.onClick());assert.equal(state.calls.some(call=>call.op==='groups.threads.continue'),false);act(()=>tree.unmount());
});
