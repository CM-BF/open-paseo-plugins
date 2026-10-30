import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const bundle=await build({entryPoints:[new URL('../../vendor/renderer/features/bots/botSettingsAutosave.ts',import.meta.url).pathname],bundle:true,write:false,format:'iife',globalName:'Autosave',platform:'browser'});
const context=vm.createContext({setTimeout,clearTimeout});vm.runInContext(bundle.outputFiles[0].text,context);
const {createBotSettingsAutosave}=context.Autosave;
const payload=name=>({name,description:'',identitySource:'',userContextSource:'',avatar:'',avatarColor:'violet',skills:[],capabilities:{model:'',providerId:null,effort:'',fastMode:false,modelChain:[],toolsets:[],mcpServers:[],skillsExcluded:[]}});
test('failed save remains dirty and blocks the same leave decision used by BotSettings',async()=>{
 let baseline=payload('before'),draft=payload('edited'),fail=true;const statuses=[];
 const controller=createBotSettingsAutosave({readPayload:()=>draft,readBaseline:()=>baseline,commit:async value=>{if(fail)throw Error('disk unavailable');baseline=value;},onStatusChange:value=>statuses.push(value)});
 await controller.flush();assert.equal(controller.isDirty(),true);assert.equal(statuses.at(-1),'error');assert.equal(baseline.name,'before');
 fail=false;await controller.retry();assert.equal(controller.isDirty(),false);assert.equal(baseline.name,'edited');assert.equal(statuses.at(-1),'saved');controller.cancel();
});
test('concurrent close/blur flushes serialize and persist edits typed while a request is in flight',async()=>{
 let baseline=payload('before'),draft=payload('first'),release;const writes=[];
 const first=new Promise(resolve=>{release=resolve;});
 const controller=createBotSettingsAutosave({readPayload:()=>draft,readBaseline:()=>baseline,commit:async value=>{writes.push(value.name);if(writes.length===1)await first;baseline=value;}});
 const initial=controller.flush();draft=payload('last');const closing=controller.flush();assert.deepEqual(writes,['first']);release();await Promise.all([initial,closing]);assert.deepEqual(writes,['first','last']);assert.equal(controller.isDirty(),false);controller.cancel();
});
