import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle=await build({entryPoints:[new URL('../adapters/model-options.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
const {speedChoices}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
test('speed controls use actual provider features, not the model name',()=>{
 assert.deepEqual(speedChoices([]),[]);
 assert.deepEqual(speedChoices([{type:'toggle',id:'plan_mode',value:false,label:'Plan'}]),[]);
 assert.deepEqual(speedChoices([{type:'select',id:'service_tier',value:'default',label:'Speed',options:[{id:'default',label:'Standard'},{id:'priority',label:'Fast'},{id:'ultrafast',label:'UltraFast'},{id:'experimental',label:'Experimental'}]}]).map(choice=>choice.value),[false,true,'ultrafast']);
});
test('legacy fast toggle remains boolean and no unknown tier is silently offered',()=>{
 assert.deepEqual(speedChoices([{type:'toggle',id:'fast_mode',value:false,label:'Fast'}]).map(choice=>choice.value),[false,true]);
 assert.deepEqual(speedChoices([{type:'select',id:'service_tier',value:'experimental',label:'Speed',options:[{id:'experimental',label:'Experimental'}]}]),[]);
});
