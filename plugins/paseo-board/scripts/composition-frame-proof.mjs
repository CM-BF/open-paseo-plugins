#!/usr/bin/env node
// Isolated browser mechanism proof, not a daemon acceptance test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const parentDocument = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src blob:; connect-src blob: *"><style>body{margin:0}main{padding:20px;display:grid;gap:18px}paseo-board{display:block;height:220px;width:380px;border:2px solid #888;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}.over{position:absolute;top:105px;left:60px;background:#fff;padding:8px;z-index:5}</style><main><h1>Parent author</h1><paseo-board id="slot"></paseo-board><p id="after">Normal flow after child</p></main><button class="over" id="cover">Parent overlay</button><script>
const send=(type,data={})=>top.postMessage({parentProof:true,type,...data},'*');
addEventListener('message',async event=>{
 if(event.source!==top||event.data.type!=='mount')return;
 const {url,publicSession}=event.data;
 window.url=url; window.publicSession=publicSession;
 try{const value=await fetch(url);send('fetch',{ok:true,text:await value.text()})}catch(error){send('fetch',{ok:false,error:error.name})}
 const child=document.createElement('iframe');child.sandbox='allow-scripts';document.querySelector('#slot').append(child);child.removeAttribute('sandbox');window.child=child;send('slot-ready',{frameIndex:0});
 child.addEventListener('load',()=>{let readable=false;try{readable=!!child.contentDocument?.body?.textContent}catch{}send('dom',{readable});send('geometry',{slot:document.querySelector('#slot').getBoundingClientRect().toJSON(),after:document.querySelector('#after').getBoundingClientRect().toJSON()})});
 // Native postMessage is trusted; a source/session-looking payload is not authority.
 top.postMessage({childProof:true,type:'ready',secret:'forged',session:publicSession,hostId:'remote-b'},'*');
 top.postMessage({childProof:true,type:'ask',session:publicSession,hostId:'remote-b',trusted:true},'*');
});
document.querySelector('#cover').onclick=event=>send('parent-click',{trusted:event.isTrusted});
send('ready');
<\/script>`;
const childTemplate = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>body{margin:0;background:#def}button{margin:110px 20px 0;width:200px;height:40px}</style><h2 style="margin:0">Private child source</h2><button id="comment">Comment on remote-b</button><script>const scope=__SCOPE__;let topReadable=false;try{topReadable=!!top.document}catch{}top.postMessage({...scope,childProof:true,type:"ready",topReadable,button:document.querySelector('button').getBoundingClientRect().toJSON()},"*");document.querySelector("button").onclick=e=>top.postMessage({...scope,childProof:true,type:"ask",trusted:e.isTrusted,activation:navigator.userActivation.isActive},"*");<\/script>`;
const topDocument = `<!doctype html><style>body{margin:0}iframe#parent{width:600px;height:600px;border:0}</style><iframe id="parent" sandbox="allow-scripts"></iframe><script>
window.results={events:[],accepted:[],rejected:0};
const secret=crypto.randomUUID(),session=crypto.randomUUID();let bound=null;
const childSource=${JSON.stringify(childTemplate).replace(/</g,'\\u003c')}.replace('__SCOPE__',JSON.stringify({secret,session,hostId:'remote-b'}));
const url=URL.createObjectURL(new Blob([childSource],{type:'text/html'}));
const parent=document.querySelector('#parent');
addEventListener('message',event=>{
 const data=event.data;
 if(data?.parentProof&&event.source===parent.contentWindow){results.events.push(data);if(data.type==='ready')parent.contentWindow.postMessage({type:'mount',url,publicSession:session},'*');if(data.type==='slot-ready'){try{parent.contentWindow.frames[data.frameIndex].location=url;results.navigationAttempted=true}catch(error){results.navigationError=error.message}}return}
 if(!data?.childProof)return;
 if(!event.isTrusted||data.secret!==secret||data.session!==session||data.hostId!=='remote-b'){results.rejected++;return}
 if(data.type==='ready'&&!bound){bound=event.source;results.bound=true;results.button=data.button;results.topReadable=data.topReadable;return}
 if(event.source!==bound){results.rejected++;return}
 if(data.type==='ask'&&data.trusted&&data.activation&&navigator.userActivation.isActive){results.accepted.push({hostId:data.hostId,session:data.session,sourceBound:true,topFocused:document.activeElement===parent})}
});
parent.srcdoc=${JSON.stringify(parentDocument).replace(/</g,'\\u003c')};
<\/script>`;
const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(topDocument)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=await mkdtemp(join(tmpdir(),'board-composition-proof-'));
const chrome=spawn(process.env.BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-pipe',`--user-data-dir=${profile}`,'--no-first-run','--disable-background-networking','--disable-extensions','--disable-renderer-backgrounding','--disable-background-timer-throttling','--window-size=1000,900','about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
let sequence=0,buffer='';const pending=new Map();const exceptions=[];const browserLogs=[];
chrome.stdio[4].on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\0'))>=0){const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const entry=pending.get(message.id);if(entry){pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error(message.error.message)):entry.resolve(message.result)}else if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails);else if(message.method==='Log.entryAdded')browserLogs.push(message.params.entry);else if(message.method==='Target.attachedToTarget'){void send('Runtime.enable',{},message.params.sessionId).catch(()=>{});void send('Log.enable',{},message.params.sessionId).catch(()=>{});void send('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},message.params.sessionId).catch(()=>{})}}});
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method))},12000);pending.set(id,{resolve,reject,timer});chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0')});
let result;
try{
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const command=(method,params)=>send(method,params,sessionId);
 await command('Runtime.enable');await command('Log.enable');await command('Page.enable');await command('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true});await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
 const evaluate=async expression=>{const value=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result.value};
 await evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+6000;const run=()=>{if(window.results?.bound&&results.events.some(e=>e.type==='geometry'))return resolve(true);if(Date.now()>deadline)return reject(new Error('proof mount deadline '+JSON.stringify(window.results)));setTimeout(run,20)};run()})`);
 result=await evaluate('results');
 assert.equal(result.events.find(e=>e.type==='fetch')?.ok,false,'opaque parent cannot fetch host blob even with blob fetch allowed by its CSP');
 assert.equal(result.events.find(e=>e.type==='dom')?.readable,false,'opaque parent cannot read child DOM');
 assert.equal(result.topReadable,false,'removing the child sandbox cannot escape inherited parent sandbox restrictions');
 assert.equal(result.rejected,2,'forged native parent messages are rejected');
 const geometry=result.events.find(e=>e.type==='geometry');assert.ok(geometry.after.y>=geometry.slot.bottom,'child remains in natural parent layout');
 const button=result.button, point={x:geometry.slot.x+2+button.x+button.width/2,y:geometry.slot.y+2+button.y+button.height/2};
 await command('Page.captureScreenshot',{format:'png'});
 for(const type of ['mouseMoved','mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{type,...point,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})});
 await evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+3000;const run=()=>{if(results.accepted.length===1)return resolve(true);if(Date.now()>deadline)return reject(new Error('native click deadline '+JSON.stringify(results)));setTimeout(run,20)};run()})`);
 result=await evaluate('results');assert.equal(result.accepted[0].hostId,'remote-b');assert.equal(result.accepted[0].sourceBound,true);
 // A parent overlay participates in the browser's real stacking/hit testing above the slot.
 for(const type of ['mouseMoved','mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{type,x:110,y:122,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})});
 await evaluate(`new Promise((resolve,reject)=>{const deadline=Date.now()+3000;const run=()=>{if(results.events.some(e=>e.type==='parent-click'&&e.trusted))return resolve(true);if(Date.now()>deadline)return reject(new Error('parent overlay deadline'));setTimeout(run,20)};run()})`);
 result=await evaluate('results');assert.equal(result.accepted.length,1);assert.deepEqual(exceptions,[]);
 if(process.env.BOARD_COMPOSITION_SCREENSHOT_DIR){await mkdir(process.env.BOARD_COMPOSITION_SCREENSHOT_DIR,{recursive:true});const screenshot=await command('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.BOARD_COMPOSITION_SCREENSHOT_DIR,'opaque-parent-host-blob-probe.png'),Buffer.from(screenshot.data,'base64'));}
 console.log(JSON.stringify({status:'passed',mechanism:'opaque-parent-host-blob-native-child',checks:['parent-fetch-blocked','child-dom-isolated','inherited-sandbox-remains-after-child-attribute-removal','natural-flow','parent-overlay-hit','secret-window-bound','parent-forgery-rejected','native-child-click-target-host'],result}));
 if(process.env.BOARD_COMPOSITION_PROOF_OUTPUT)await writeFile(process.env.BOARD_COMPOSITION_PROOF_OUTPUT,JSON.stringify({status:'passed',result},null,2)+'\n');
}catch(error){console.error(JSON.stringify({status:'failed',error:String(error),result,exceptions,browserLogs}));process.exitCode=1}
finally{try{await send('Browser.close')}catch{}chrome.kill('SIGTERM');server.close();await new Promise(resolve=>chrome.exitCode!==null?resolve():chrome.once('exit',resolve));await rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:100})}
