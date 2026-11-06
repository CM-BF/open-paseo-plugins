#!/usr/bin/env node
// Real production CanvasFrame in an isolated browser; no daemon, remote host or agent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const directory=dirname(fileURLToPath(import.meta.url));
const bundle=await build({entryPoints:[join(directory,'composition-frame-fixture.tsx')],bundle:true,format:'iife',platform:'browser',write:false,loader:{'.txt':'text'},define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'native-fixture',setup(b){b.onResolve({filter:/^react-native$/},()=>({path:'native',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const Platform={OS:"web"}',loader:'js'}))}}]});
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0].text:'<!doctype html><style>body{margin:0}</style><div id="app"></div><script src="/bundle.js"></script>')});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=await mkdtemp(join(tmpdir(),'board-composition-proof-'));
const sourceBundle=await build({stdin:{contents:'export {prepareComponentPatch,describeAuthoring} from "./server/authored-source";',resolveDir:join(directory,'..'),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false});
const sourcePath=join(profile,'source.cjs');await writeFile(sourcePath,sourceBundle.outputFiles[0].text);
const {prepareComponentPatch,describeAuthoring}=createRequire(import.meta.url)(sourcePath);
const chrome=spawn(process.env.BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-pipe',`--user-data-dir=${profile}`,'--no-first-run','--disable-background-networking','--disable-extensions','--disable-renderer-backgrounding','--disable-background-timer-throttling','--window-size=1000,900','about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
let sequence=0,buffer='';const pending=new Map();const exceptions=[];const browserLogs=[];
chrome.stdio[4].on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\0'))>=0){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const entry=pending.get(message.id);if(entry){pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error(message.error.message)):entry.resolve(message.result)}else if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails);else if(message.method==='Log.entryAdded')browserLogs.push(message.params.entry);else if(message.method==='Target.attachedToTarget'){void send('Runtime.enable',{},message.params.sessionId).catch(()=>{});void send('Log.enable',{},message.params.sessionId).catch(()=>{});void send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},message.params.sessionId).catch(()=>{})}}});
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method))},12000);pending.set(id,{resolve,reject,timer});chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0')});
let result, diagnose;
try{
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const command=(method,params)=>send(method,params,sessionId);
 await command('Runtime.enable');await command('Log.enable');await command('Page.enable');await command('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
 const evaluate=async expression=>{const value=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result.value};
 const until=expression=>evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+6000;const run=()=>{if(${expression})return resolve(true);if(Date.now()>deadline)return reject(new Error('condition '+${JSON.stringify(expression)}+' '+JSON.stringify(window.results)));setTimeout(run,20)};run()})`);
 const frame=(id,code)=>evaluate(`frameCall(${JSON.stringify(id)},${JSON.stringify(code)})`);
 diagnose=()=>frame('parent',`({frames:frames.length,slots:Array.from(document.querySelectorAll('paseo-board'),n=>({html:n.outerHTML,frame:Boolean(n.querySelector('iframe')?.contentWindow)}))})`);
 const clickAt=async(x,y,button='left')=>{for(const type of ['mouseMoved','mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{type,x,y,...(type==='mouseMoved'?{}:{button,clickCount:1})})};
 const click=async(id,selector,button='left')=>{const rect=await frame(id,`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);const slot=id==='parent'?{rect:{x:0,y:0}}:(await evaluate('results.slots')).find(item=>item.boardId===id);await command('Page.captureScreenshot',{format:'png'});await clickAt(slot.rect.x+rect.x,slot.rect.y+rect.y,button)};
 await until("window.results?.ready.includes('child-a')&&results.ready.includes('child-b')");
 result=await evaluate('results');assert.equal(result.slots.length,2);assert.equal(result.ready.length,2);
 const idleWrites=await frame('parent',`new Promise(resolve=>{let count=0;const observer=new MutationObserver(records=>count+=records.filter(record=>record.target.matches?.('paseo-board iframe')&&record.attributeName==='style').length);setTimeout(()=>{observer.observe(document.documentElement,{subtree:true,attributes:true});setTimeout(()=>{observer.disconnect();resolve(count)},120)},80)})`);assert.equal(idleWrites,0,'quiet composition slots must not rewrite their own observed iframe style every frame');
 const heap=await frame('child-a','heap');
 assert.equal(await frame('child-a','messageLeaks'),0,'private connect port is hidden from author window listeners');
 await frame('child-a','rawForge()');await frame('parent',`(()=>{const session=document.scripts[0].textContent.match(/"sessionId":"([^"]+)"/)[1];top.postMessage({channel:'paseo-board-frame-v1',boardId:'child-a',sessionId:session,type:'ask',id:'parent-forge',request:{prompt:'forged'}},'*');return true})()`);
 assert.equal((await evaluate('results.asks')).length,0);
 await click('child-a','#comment');await until('results.asks.length===1');assert.equal((await evaluate('results.asks'))[0].hostId,'remote-a');
 assert.equal(await frame('child-a','messageLeaks'),0);
 await click('child-b','#comment');await until('results.asks.length===2');assert.equal((await evaluate('results.asks'))[1].hostId,'remote-b');
 await frame('parent',`document.querySelector('#parent-action').onclick=()=>{const sessionId=document.scripts[0].textContent.match(/"sessionId":"([^"]+)"/)[1];top.postMessage({channel:'paseo-board-frame-v1',boardId:'parent',sessionId,type:'composition-open',id:'a'},'*')};true`);
 await click('parent','#parent-action');assert.equal((await evaluate('results.open')).length,0,'parent raw Open forgery during native activation is refused');
 await frame('parent',`document.querySelector('#parent-action').onclick=()=>{const sessionId=document.scripts[0].textContent.match(/"sessionId":"([^"]+)"/)[1];top.postMessage({channel:'paseo-board-frame-v1',boardId:'parent',sessionId,type:'composition-drafts',id:'a'},'*')};true`);
 await click('parent','#parent-action');assert.equal((await evaluate('results.drafts')).length,0,'parent raw Drafts forgery during native activation is refused');
 const openSlot=(await evaluate('results.slots'))[0];await clickAt(openSlot.rect.x+openSlot.rect.width-22,openSlot.rect.y-14);await until('results.open.length===1');
 await clickAt(openSlot.rect.x+openSlot.rect.width-82,openSlot.rect.y-14);await until('results.drafts.length===1');assert.equal((await evaluate('results.drafts'))[0],'child-a');
 await click('parent','#parent-action');
 await frame('child-a',`board.ask({prompt:'idle after parent click'}).then(value=>window.idleResult=value);true`);
 assert.equal(await frame('child-a','idleResult.status'),'cancelled');
 await frame('child-a','rawForge()');assert.equal((await evaluate('results.asks')).length,2);
 await frame('child-a',`document.querySelector('#value').value='kept';true`);await click('child-a','#save');await until('results.states.length===1');assert.equal((await evaluate('results.states'))[0].state.value,'kept');
 await frame('parent',`document.querySelector('main').style.gridTemplateColumns='350px 400px';true`);await until("results.slots[0].rect.width<380");assert.equal(await frame('child-a','heap'),heap);assert.equal(await frame('child-a',"document.querySelector('#value').value"),'kept');
 await frame('parent',`document.querySelector('main').removeAttribute('style');true`);await until("results.slots[0].rect.width>380");
 await evaluate('updateChild()');await frame('child-b',`new Promise((resolve,reject)=>{const d=Date.now()+3000;const run=()=>{if(document.querySelector('#version').textContent==='2')return resolve(true);if(Date.now()>d)return reject(new Error('child update'));setTimeout(run,20)};run()})`);
 if(process.env.BOARD_COMPOSITION_SCREENSHOT_DIR){await mkdir(process.env.BOARD_COMPOSITION_SCREENSHOT_DIR,{recursive:true});const screenshot=await command('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.BOARD_COMPOSITION_SCREENSHOT_DIR,'nested-boards-active.png'),Buffer.from(screenshot.data,'base64'));}
 await click('child-a','#target','right');await until("results.captures.some(item=>item.id==='child-a'&&item.capture?.status==='ready')");
 assert.ok((await evaluate('results.captures')).find(item=>item.id==='child-a'&&item.capture)?.capture.anchor.image.data.length>100);
 // Select and move the actual declaration, then run its proposal through the
 // production authored-source preparer. Injected iframe/chrome must not leak.
 const a=(await evaluate('results.slots')).find(item=>item.id==='a'),b=(await evaluate('results.slots')).find(item=>item.id==='b');
 for(const type of ['mouseMoved','mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{type,x:a.rect.x+2,y:a.rect.y-27,modifiers:12,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})});
 await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Shift',code:'ShiftLeft',modifiers:0});
 await frame('parent',`new Promise((resolve,reject)=>{const d=Date.now()+2000;const loop=()=>{if(document.querySelector('[data-board-components]')?.shadowRoot?.querySelector('[aria-current=true]'))return resolve(true);if(Date.now()>d)return reject(new Error('slot selection'));setTimeout(loop,20)};loop()})`);
 await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:a.rect.x+2,y:a.rect.y-27});
 await command('Input.dispatchMouseEvent',{type:'mousePressed',x:a.rect.x+2,y:a.rect.y-27,button:'left',clickCount:1});
 await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:b.rect.x+b.rect.width-2,y:b.rect.y-24,buttons:1});
 await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:b.rect.x+b.rect.width-2,y:b.rect.y-24,button:'left',clickCount:1});
 await until('results.edits.length===1');
 const proposal=(await evaluate('results.edits'))[0];assert.ok(proposal.patch.sourceIdentity.authoredHtml.includes('<paseo-board'));assert.ok(!/iframe|blob:|data-board-overlay/.test(proposal.patch.sourceIdentity.authoredHtml));
 const originalCanvas=await evaluate('parentCanvas');const patch=prepareComponentPatch(originalCanvas,{...proposal.patch,id:'composition-move',html:''});
 await evaluate(`applyParentPatch(${JSON.stringify(patch)});finishEdit({status:'applied',canvasRevision:2})`);
 await frame('parent',`new Promise((resolve,reject)=>{const d=Date.now()+2000;const loop=()=>{if(board.getContext().canvasRevision===2)return resolve(true);if(Date.now()>d)return reject(new Error('slot move'));setTimeout(loop,20)};loop()})`);
 assert.equal(await frame('child-a','heap'),heap,'atomic declaration move preserves the loaded child');
 assert.equal(await frame('child-a',"document.querySelector('#value').value"),'kept');
 const materialized=describeAuthoring(await evaluate('parentCanvas'));assert.equal(materialized.replay.complete,true);assert.ok(!/data-board-embedded-frame|blob:/.test(materialized.materializedAuthoredHtml));
 const copy=prepareComponentPatch(originalCanvas,{...proposal.patch,operation:'copy',id:'composition-copy',copyIdPrefix:'composition-copy',html:''});assert.ok(copy.html.includes('paseo-board'));assert.ok(!/iframe|blob:|data-board-overlay/.test(copy.html));
 assert.ok(copy.html.includes('slot-id="composition-copy-slot-0"'),'the server assigns a unique declared slot identity');
 const copiedSource=describeAuthoring({...originalCanvas,revision:2,patches:[copy]});assert.equal(copiedSource.replay.complete,true);assert.ok(copiedSource.materializedAuthoredHtml.includes('slot-id="composition-copy-slot-0"'));
 await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
 // Native first scroll after a state-preserving slot move must remain stable
 // while the source's real marker overlay repositions on the next animation frame.
 const movedSlot=(await evaluate('results.slots')).find(item=>item.id==='a');
 await command('Input.dispatchMouseEvent',{type:'mouseWheel',x:movedSlot.rect.x+280,y:movedSlot.rect.y+210,deltaX:0,deltaY:130});
 await until("results.views['child-a']?.y===130");
 const stableMovedView=await frame('child-a',`new Promise(resolve=>setTimeout(()=>resolve({y:scrollY,heap,markers:document.querySelectorAll('[data-board-markers]').length}),180))`);
 assert.equal(stableMovedView.y,130);assert.equal(stableMovedView.heap,heap);assert.equal(stableMovedView.markers,1);
 await command('Input.dispatchMouseEvent',{type:'mouseWheel',x:movedSlot.rect.x+280,y:movedSlot.rect.y+210,deltaX:0,deltaY:-130});await until("results.views['child-a']?.y===0");
 // Parent region intersecting an embed must fail honestly, without silently omitting it.
 const slot=(await evaluate('results.slots'))[0];
 await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:slot.rect.y-20,modifiers:1});await command('Input.dispatchMouseEvent',{type:'mousePressed',x:10,y:slot.rect.y-20,button:'left',clickCount:1,modifiers:1});await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:slot.rect.x+slot.rect.width+5,y:slot.rect.y+100,buttons:1,modifiers:1});await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:slot.rect.x+slot.rect.width+5,y:slot.rect.y+100,button:'left',clickCount:1,modifiers:1});
 await until("results.captures.some(item=>item.id==='parent'&&item.capture?.status==='failed')");
 assert.equal((await evaluate('results.captures')).find(item=>item.id==='parent'&&item.capture)?.capture.reason,'unsupported-layout');
 await frame('parent',`document.querySelector('[slot-id="b"]').setAttribute('view','preview');true`);await until("results.slots.find(item=>item.id==='b')?.view==='preview'");
 await until("results.ready.filter(id=>id==='child-b').length===2");
 assert.equal(await frame('parent',`document.querySelector('[slot-id="b"] iframe').inert`),true);
 await click('parent','#parent-action');await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab'});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab'});
 assert.equal(await frame('child-b','document.hasFocus()'),false,'preview cannot receive sequential keyboard focus');
 await click('child-b','#comment');assert.equal((await evaluate('results.asks')).length,2,'preview cannot receive a native click');
 await frame('parent',`(()=>{const before=document.querySelector('[slot-id="a"]');const replacement=document.createElement('paseo-board');for(const a of before.attributes)replacement.setAttribute(a.name,a.value);before.replaceWith(replacement);return true})()`);await until("results.ready.filter(id=>id==='child-a').length===2");
 assert.notEqual(await frame('child-a','heap'),heap,'same-ID replacement binds a fresh native frame');
 const latestHeap=await frame('child-a','heap');await until(`results.ticks[${JSON.stringify(latestHeap)}]>1`);
 await evaluate("disableChild('a')");
 await evaluate('new Promise(resolve=>setTimeout(resolve,100))');const stopped=await evaluate(`results.ticks[${JSON.stringify(latestHeap)}]`);
 await evaluate('new Promise(resolve=>setTimeout(resolve,100))');assert.equal(await evaluate(`results.ticks[${JSON.stringify(latestHeap)}]`),stopped,'revocation destroys the old document, including its interval');
 // A removed source may no longer answer, so inspect blanking from the owner
 // via a native load sentinel instead of calling a dead author bridge.
 assert.equal(await frame('parent',`document.querySelector('[slot-id="a"] iframe').isConnected`),true);
 // A native scroll is immediately followed by complete parent removal. Its
 // already sampled private-port position must survive; teardown zero must not.
 await evaluate('remountParent()');await until("results.ready.filter(id=>id==='child-a').length===3&&results.ready.filter(id=>id==='child-b').length===3");
 await frame('child-a',`addEventListener('scroll',()=>top.postMessage({channel:'composition-fixture-quick-remount',x:scrollX,y:scrollY,heap},'*'),{once:true});true`);
 const quickSlot=(await evaluate('results.slots')).find(item=>item.id==='a');
 await command('Input.dispatchMouseEvent',{type:'mouseWheel',x:quickSlot.rect.x+280,y:quickSlot.rect.y+180,deltaX:0,deltaY:130});
 await until("results.quickRemount?.y>0&&results.ready.filter(id=>id==='child-a').length===4");
 const quickPosition=await evaluate('results.quickRemount');
 await frame('child-a',`new Promise((resolve,reject)=>{const d=Date.now()+2500;const loop=()=>{if(scrollY===${quickPosition.y})return resolve(true);if(Date.now()>d)return reject(new Error('quick remount position '+scrollY));setTimeout(loop,20)};loop()})`);
 assert.equal((await evaluate("results.views['child-a']")).y,quickPosition.y);
 if(process.env.BOARD_COMPOSITION_SCREENSHOT_DIR){await mkdir(process.env.BOARD_COMPOSITION_SCREENSHOT_DIR,{recursive:true});const screenshot=await command('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.BOARD_COMPOSITION_SCREENSHOT_DIR,'nested-board-isolated-browser.png'),Buffer.from(screenshot.data,'base64'));}
 result=await evaluate('results');assert.deepEqual(result.errors,[]);assert.deepEqual(exceptions,[]);
 const report={status:'passed',kind:'production-CanvasFrame-isolated-browser',checks:['quiet-slots-do-not-self-schedule-style-mutations','first-native-scroll-after-move-with-markers-stays-stable','two-natural-flow-child-frames','private-port-hidden','raw-child-and-parent-forgery-denied','native-host-routed-Comment','parent-focus-idle-ask-denied','child-state','resize-preserves-heap-controls','independent-data-update','child-native-PNG-capture','parent-overlap-capture-explicit-refusal','native-open-and-drafts-private-control-port','preview-inert','same-ID-slot-replacement','native-slot-move-preserves-child-heap','authored-identity-copy-replay-excludes-runtime-iframe','revocation-stops-child-timers','native-scroll-immediate-parent-remount-retains-position'],result};
 console.log(JSON.stringify({...report,result:undefined}));if(process.env.BOARD_COMPOSITION_OUTPUT)await writeFile(process.env.BOARD_COMPOSITION_OUTPUT,JSON.stringify(report,(key,value)=>key==='data'&&typeof value==='string'&&value.length>100?'[PNG omitted; verified actual bytes]':value,2)+'\n');
}catch(error){console.error(JSON.stringify({status:'failed',error:String(error),result,diagnosis:await diagnose?.().catch(String),exceptions,browserLogs}));process.exitCode=1}
finally{try{await send('Browser.close')}catch{}chrome.kill('SIGTERM');server.close();await new Promise(resolve=>chrome.exitCode!==null?resolve():chrome.once('exit',resolve));await rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100})}
