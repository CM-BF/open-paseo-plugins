import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const state = globalThis.__DM_QUOTES__ = {};
const output = await build({ stdin: { contents: `export * from './dm-quotes';`, resolveDir: new URL('../../client', import.meta.url).pathname, loader: 'tsx' },
 bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], plugins: [{ name: 'host', setup(b) {
 b.onResolve({filter:/^(react-native|@tanstack\/react-query|@getpaseo\/plugin\/client(?:\/ui)?|\.\/data)$/}, ({path})=>({path,namespace:'host'}));
 b.onLoad({filter:/.*/,namespace:'host'},({path})=>({contents: path==='react-native'?`export const Pressable='Pressable',Text='Text',View='View';`
 :path==='@tanstack/react-query'?`export const useQuery=options=>({data:globalThis.__DM_QUOTES__.profiles[options.queryKey[1]]??[]});`
 :path==='./data'?`export const useSettingsInvoke=id=>globalThis.__DM_QUOTES__.invokes[id];`
 :path.endsWith('/ui')?`export const Icon='Icon';`
 :`export const defineTranslations=x=>x;export const useTranslation=m=>({t:(k,a={})=>(m.resources[globalThis.__DM_QUOTES__.locale??'en'][k]??k).replace(/{{(\\w+)}}/g,(_,n)=>String(a[n]??''))});` }));
 }}] });
const module={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const {contributeDmQuotes,DmQuoteAction,DmQuotePreview,DmQuotePrefix}=module.exports;
const source={agentId:'agent',reference:{role:'assistant',providerMessageId:'native',turnId:'turn'},position:{epoch:'epoch',seq:3}};
const evidence={projection:'unmerged-native-message',provenance:'unavailable',attachments:'unavailable',sealed:'unavailable'};
const display={version:1,status:'available',botId:'bot',source,excerpt:'ORIGINAL SNAPSHOT',evidence};
const props=(host='a')=>({host:{id:host},agentId:'agent',workspaceId:'workspace',theme:{colors:{surface0:'#fff',foregroundMuted:'#777'}},layout:{compact:false,platform:'web'},message:{reference:{role:'user',providerMessageId:'sent'},position:{epoch:'epoch',seq:4},text:'visible text'},context:{version:'selection-1',value:{source}}});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const text=tree=>tree.root.findAllByType('Text').map(x=>x.props.children).flat().join(' ');
const button=(tree,label)=>tree.root.findAllByType('Pressable').find(x=>x.props.accessibilityLabel===label);
function setup(){state.profiles={a:[{id:'bot',name:'Cindy',enabled:true,status:'active',canonicalSessionId:'agent'}],b:[]};state.locale='en';state.invokes={a:async()=>({ok:true,value:{status:'available',snapshot:{botId:'bot',source,text:'Read from native source'}}}),b:async()=>({ok:false,message:'gone'})};}
async function render(Component,p){let tree;await act(async()=>{tree=create(React.createElement(Component,p))});return tree;}

test('registration requires the complete additive host API, cleans up once and rolls back partial registration',()=>{
 const calls=[];const full={};for(const name of ['addMessageAction','addMessagePrefix','addComposerContext'])full[name]=x=>{calls.push([name,x.id]);return()=>calls.push(['remove',name])};full.setComposerContext=async()=>({version:'x'});
 contributeDmQuotes({addMessageAction:full.addMessageAction})();assert.equal(calls.length,0);
 const cleanup=contributeDmQuotes(full);assert.equal(calls.length,3);cleanup();cleanup();assert.deepEqual(calls.slice(3),[['remove','addMessageAction'],['remove','addMessagePrefix'],['remove','addComposerContext']]);
 calls.length=0;assert.throws(()=>contributeDmQuotes({...full,addMessagePrefix:()=>{throw new Error('registration failed')}}),/registration failed/);assert.deepEqual(calls,[['addComposerContext','cindy-dm-quote'],['remove','addComposerContext']]);
});

test('reply selects only immutable native source identity once and a retained old-host callback cannot select again',async()=>{
 setup();const pending=defer(),calls=[];const p={...props(),hostApi:{setComposerContext:input=>{calls.push(input);return pending.promise}}};
 const tree=await render(DmQuoteAction,p),click=button(tree,'Quote reply').props.onPress;
 act(()=>{click();click()});assert.equal(calls.length,1);assert.deepEqual(calls[0],{id:'cindy-dm-quote',agentId:'agent',value:{source:{agentId:'agent',reference:p.message.reference,position:p.message.position}},focus:true});
 await act(async()=>tree.update(React.createElement(DmQuoteAction,{...p,...props('b')})));act(()=>click());assert.equal(calls.length,1);assert.equal(button(tree,'Quote reply'),undefined);
 await act(async()=>pending.reject(new Error('old host')));assert.equal(text(tree),'');act(()=>tree.unmount());
});

test('pending preview reads authority rather than local text, clears only its version and rejects stale callbacks/results',async()=>{
 setup();const pending=defer(),clears=[],focus=[];state.invokes.a=()=>pending.promise;
 const p={...props(),clear:v=>clears.push(v),focusInput:()=>focus.push('a')};const tree=await render(DmQuotePreview,p);
 const old=button(tree,'Remove quote').props.onPress;
 await act(async()=>tree.update(React.createElement(DmQuotePreview,{...p,...props('b'),context:{version:'selection-2',value:{source}},focusInput:()=>focus.push('b')})));
 act(()=>old());assert.deepEqual(clears,[]);
 await act(async()=>pending.resolve({ok:true,value:{status:'available',snapshot:{botId:'bot',source,text:'OLD HOST SECRET'}}}));assert.doesNotMatch(text(tree),/OLD HOST SECRET/);
 act(()=>button(tree,'Remove quote').props.onPress());assert.deepEqual(clears,['selection-2']);assert.deepEqual(focus,['b']);act(()=>tree.unmount());
});

test('pending preview uses the original bounded excerpt and does not invent an attachment name',async()=>{
 setup();state.invokes.a=async()=>({ok:true,value:{status:'available',snapshot:{botId:'bot',source,text:'  '+ '中'.repeat(400)+'\n'}}});
 const p={...props(),clear(){},focusInput(){}};const tree=await render(DmQuotePreview,p);assert.match(text(tree),/Quoting Cindy/);assert.match(text(tree),new RegExp('中'.repeat(279)+'…'));assert.doesNotMatch(text(tree),new RegExp('中'.repeat(280)));
 await act(async()=>tree.update(React.createElement(DmQuotePreview,{...p,context:{version:'invalid',value:{source,preview:'forged'}}})));assert.equal(text(tree),'');act(()=>tree.unmount());
});

test('removing a quote restores input focus before the host revokes its selection callbacks',async()=>{
 setup();let selection='selection-1',focused=false;const clears=[];
 const p={...props(),clear:version=>{if(selection===version){clears.push(version);selection=null}},focusInput:()=>{if(selection==='selection-1')focused=true}};
 const tree=await render(DmQuotePreview,p);
 try {
  act(()=>button(tree,'Remove quote').props.onPress());
  assert.equal(focused,true);assert.deepEqual(clears,['selection-1']);assert.equal(selection,null);
 } finally {act(()=>tree.unmount())}
});

test('pending preview rejects a different returned identity while permitting enriched IDs and new position hints',async()=>{
 setup();const p={...props(),clear(){},focusInput(){}};
 state.invokes.a=async()=>({ok:true,value:{status:'available',snapshot:{botId:'bot',source:{...source,reference:{...source.reference,providerMessageId:'different'}},text:'WRONG MESSAGE'}}});
 const tree=await render(DmQuotePreview,p);assert.doesNotMatch(text(tree),/WRONG MESSAGE/);assert.match(text(tree),/could not be read/);
 state.invokes.a=async()=>({ok:true,value:{status:'available',snapshot:{botId:'bot',source:{...source,reference:{...source.reference,clientMessageId:'enriched'},position:{epoch:'new',seq:10}},text:'Verified original'}}});
 await act(async()=>tree.update(React.createElement(DmQuotePreview,{...p,context:{...p.context,version:'selection-new'}})));
 assert.match(text(tree),/Verified original/);act(()=>tree.unmount());
});

test('sent quote renders only daemon metadata in its own namespace and same conversation, keeping unavailable distinct from deleted',async()=>{
 setup();const p={...props(),message:{...props().message,inputContexts:[{pluginId:'cindy-companion',id:'cindy-dm-quote',version:'opaque-selection-uuid',data:display}]}};
 const tree=await render(DmQuotePrefix,p);assert.match(text(tree),/Cindy ORIGINAL SNAPSHOT/);assert.doesNotMatch(text(tree),/visible text/);
 for(const data of [{...display,source:{...source,agentId:'other'}},{...display,version:2},{...display,excerpt:'x'.repeat(281)}]){
 await act(async()=>tree.update(React.createElement(DmQuotePrefix,{...p,message:{...p.message,inputContexts:[{...p.message.inputContexts[0],data}]}})));assert.equal(text(tree),'');}
 await act(async()=>tree.update(React.createElement(DmQuotePrefix,{...p,message:{...p.message,inputContexts:[{...p.message.inputContexts[0],pluginId:'other'}]}})));assert.equal(text(tree),'');
 state.locale='zh-CN';await act(async()=>tree.update(React.createElement(DmQuotePrefix,{...p,message:{...p.message,inputContexts:[{...p.message.inputContexts[0],data:{version:1,status:'not-found',source}}]}})));assert.match(text(tree),/原消息不在可查看的记录里/);assert.doesNotMatch(text(tree),/已删除|ORIGINAL SNAPSHOT/);assert.equal(tree.root.findAllByType('Pressable').length,0);act(()=>tree.unmount());
});

test('locate uses exact source identity and neither retained navigation nor late failure crosses a host change',async()=>{
 setup();const pending=defer(),calls=[];const p={...props(),navigation:{locateMessage:input=>{calls.push(input);return pending.promise}},message:{...props().message,inputContexts:[{pluginId:'cindy-companion',id:'cindy-dm-quote',version:'v',data:display}]}};
 const tree=await render(DmQuotePrefix,p),click=tree.root.findByProps({testID:'cindy-dm-quote'}).props.onPress;
 act(()=>click());assert.deepEqual(calls,[source]);
 await act(async()=>tree.update(React.createElement(DmQuotePrefix,{...p,host:{id:'b'}})));act(()=>click());assert.equal(calls.length,1);
 await act(async()=>pending.reject(new Error('old navigation')));assert.doesNotMatch(text(tree),/could not be located/);act(()=>tree.unmount());
});
