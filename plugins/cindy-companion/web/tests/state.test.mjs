import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const bundle=await build({stdin:{contents:"export * from './state'; export {useBotSettingsTarget} from './adapters/settings-target';",resolveDir:new URL('..',import.meta.url).pathname,loader:'ts'},bundle:true,write:false,format:'iife',globalName:'Settings',platform:'browser',plugins:[{name:'view-boundaries',setup(build){
 build.onResolve({filter:/^(react)$|adapters\/i18n$|\.\/i18n$|vendor\/renderer\/lib\/toast$/},args=>({path:args.path,namespace:'test-boundary'}));
 build.onLoad({filter:/.*/,namespace:'test-boundary'},args=>({loader:'js',contents:args.path==='react'?"export const useSyncExternalStore=(subscribe,get)=>get();export const useRef=value=>({current:value});export const useState=()=>[null,()=>{}];export const useEffect=()=>{};":args.path.endsWith('i18n')?"export const i18n={language:'en'};":"export const toast={warning:(message)=>{globalThis.notices.push(message);return 'notice';},error:()=>{},dismiss:()=>{}};"}));
}}]});
function setup(){
 const listeners=new Map(),sent=[];const parent={postMessage:message=>sent.push(message)};
 const window={parent,addEventListener:(name,fn)=>{const value=listeners.get(name)??[];value.push(fn);listeners.set(name,value);},dispatchEvent:event=>{for(const fn of listeners.get(event.type)??[])fn(event);}};
 const context=vm.createContext({window,notices:[],Event,TextEncoder,setTimeout:()=>1,clearTimeout:()=>{}});vm.runInContext(bundle.outputFiles[0].text,context);
 const runtime={state:'ready',agentId:'agent',desiredVersion:1,appliedVersion:1};
 const profile={id:'cindy',name:'Cindy',capabilities:{modelChain:[],modelChainOverride:null}};
 context.Settings.setBootstrap({bot:profile,profiles:[profile],runtime,caps:{ops:[]},models:{entries:[]},defaultModelChain:[{harness:'codex',model:'actual-default',effort:'medium',fastMode:false,providerId:null}]});
 return {api:context.Settings,notices:context.notices,sent,reply:result=>window.dispatchEvent({type:'message',source:parent,data:{channel:'cindy-companion',type:'response',id:sent.at(-1).id,result}})};
}
test('the model page inherits the fetched host default, not an empty companion chain',()=>{
 const x=setup();assert.equal(x.api.useBotSettingsTarget().useDefaultModelChain()[0].model,'actual-default');
});
test('failed profile writes preserve the current saved state and remain rejected',async()=>{
 const x=setup();const before=x.api.snapshot();const operation=x.api.updateProfile('cindy',{name:'Changed'});const rejected=assert.rejects(operation,/Cannot save/);x.reply({ok:false,code:'IO_ERROR',message:'Cannot save'});await rejected;assert.equal(x.api.snapshot(),before);assert.equal(x.notices.length,0);
});
test('saved but pending settings remain pending and announce the application boundary',async()=>{
 const x=setup();const operation=x.api.updateProfile('cindy',{name:'Changed'});x.reply({ok:true,value:{profile:{...x.api.snapshot().bot,name:'Changed'},runtime:{state:'pending',desiredVersion:2,appliedVersion:1,message:'Reload this companion to apply.'}}});await operation;assert.equal(x.api.snapshot().bot.name,'Changed');assert.equal(x.api.snapshot().runtime.state,'pending');assert.match(x.notices[0],/Saved.*Reload/);
});
test('profile refresh uses the actual host list operation and adopts newly persisted teammates',async()=>{
 const x=setup();const operation=x.api.refreshProfiles();assert.equal(x.sent.at(-1).op,'profile.list');const profile={...x.api.snapshot().bot,id:'new',name:'New'};x.reply({ok:true,value:{profiles:[x.api.snapshot().bot,profile]}});await operation;assert.equal(x.api.snapshot().profiles.length,2);
});
test('capability adapter keeps the bounded personal page separate and strips native filesystem metadata',async()=>{
 const x=setup();const operation=x.api.useBotSettingsTarget().capabilities.load(x.api.snapshot().bot,[],()=>true);
 assert.equal(x.sent.at(-1).op,'capabilities.catalog');
 x.reply({ok:true,value:{personal:[{slug:'saved',name:'Saved',enabled:false,filePath:'/private/host/SKILL.md',bodyStartLine:5}],personalPage:{total:2,nextOffset:1,revision:'catalog-a'},personalRuntime:{status:'pending',reason:'native-loading-unverified'},providerError:{code:'NOT_CREATED',message:'Native session has not started'},entries:{skill:[],mcp:[],toolset:[]}}});
 const result=await operation;assert.equal(result.skill.length,0);assert.equal(result.personalSkills.total,2);assert.equal(result.personalSkills.nextOffset,1);assert.equal(result.personalSkills.skills[0].enabled,false);
 assert.equal('filePath' in result.personalSkills.skills[0],false);assert.equal('bodyStartLine' in result.personalSkills.skills[0],false);assert.equal(result.providerError.code,'NOT_CREATED');assert.equal(result.personalRuntime.status,'pending');
});
test('capability adapter rejects contradictory personal totals instead of reporting a complete list',async()=>{
 const x=setup();const operation=x.api.useBotSettingsTarget().capabilities.load(x.api.snapshot().bot,[],()=>true);
 const rejected=assert.rejects(operation,/invalid personal skill page/);
 x.reply({ok:true,value:{personal:[{slug:'saved',name:'Saved'}],personalPage:{total:0},entries:{skill:[],mcp:[],toolset:[]}}});await rejected;
});
test('legacy catalogs are complete only without a continuation; unversioned partial libraries fail explicitly',async()=>{
 const x=setup();const operation=x.api.useBotSettingsTarget().capabilities.load(x.api.snapshot().bot,[],()=>true);
 const rejected=assert.rejects(operation,/cannot provide stable personal skill pagination/);
 x.reply({ok:true,value:{personal:[{slug:'saved',name:'Saved'}],personalPage:{total:2,nextOffset:1},entries:{skill:[],mcp:[],toolset:[]}}});await rejected;
 const complete=x.api.useBotSettingsTarget().capabilities.load(x.api.snapshot().bot,[],()=>true);
 x.reply({ok:true,value:{personal:[{slug:'only',name:'Only'}],entries:{skill:[],mcp:[],toolset:[]}}});assert.equal((await complete).personalSkills.total,1);
});
