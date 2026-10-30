import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const bundle=await build({entryPoints:[new URL('../bridge.ts',import.meta.url).pathname],bundle:true,write:false,format:'iife',globalName:'Bridge',platform:'browser'});
function setup(){
 const events=new Map();const sent=[];const timers=new Map();let timerId=0;
 const parent={postMessage:message=>sent.push(message)};
 const window={parent,addEventListener:(name,fn)=>{const list=events.get(name)??[];list.push(fn);events.set(name,list);},dispatchEvent:event=>{for(const fn of events.get(event.type)??[])fn(event);}};
 const context=vm.createContext({window,TextEncoder,Event,setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(bundle.outputFiles[0].text,context);
 const message=(data,source=parent)=>window.dispatchEvent({type:'message',source,data:{channel:'cindy-companion',...data}});
 return {api:context.Bridge,sent,timers,parent,window,message};
}
test('accepts only the parent and matching request id; unwraps actual host success',async()=>{
 const x=setup();const response=x.api.invoke('profile.get',{botId:'owned'});const request=x.sent[0];
 x.message({type:'response',id:request.id,result:{ok:true,value:'foreign'}},{});
 assert.equal(x.timers.size,1);
 x.message({type:'response',id:'unknown',result:{ok:true,value:'wrong'}});
 assert.equal(x.timers.size,1);
 x.message({type:'response',id:request.id,result:{ok:true,value:{profile:{id:'owned'}}}});
 assert.equal((await response).profile.id,'owned');assert.equal(x.timers.size,0);
});
test('host failures and memory revision conflicts remain rejected',async()=>{
 const x=setup();const response=x.api.invoke('memory.update',{botId:'owned'});
 const rejected=assert.rejects(response,error=>error.code==='PRECONDITION_FAILED'&&/bot-memory-changed/.test(error.message));
 x.message({type:'response',id:x.sent[0].id,result:{ok:false,code:'PRECONDITION_FAILED',message:'bot-memory-changed'}});
 await rejected;
});
test('bounds outgoing messages and rejects pending work on frame disposal',async()=>{
 const x=setup();await assert.rejects(x.api.invoke('x'.repeat(129),{}));await assert.rejects(x.api.invoke('profile.update',{body:'x'.repeat(2*1024*1024)}));assert.equal(x.sent.length,0);
 const request=x.api.invoke('profile.update',{});const rejected=assert.rejects(request,/Settings closed/);x.window.dispatchEvent(new Event('pagehide'));await rejected;assert.equal(x.timers.size,0);
});
test('a close request is delegated to the settings guard; it does not emit close itself',()=>{
 const x=setup();let guarded=0;x.window.addEventListener('cindy-request-close',()=>guarded++);
 x.message({type:'request-close'},{});assert.equal(guarded,0);
 x.message({type:'request-close'});assert.equal(guarded,1);assert.equal(x.sent.length,0);
});
