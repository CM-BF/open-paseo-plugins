#!/usr/bin/env node
// Isolated Chromium measurement of the real buildBoardDocument renderer. No daemon or user
// board is touched. CAPTURE_BASELINE_REV enables a before/after run against a Git revision.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const directory = dirname(fileURLToPath(import.meta.url));
const plugin = resolve(directory, '..');
const scratch = await mkdtemp(join(tmpdir(), 'board-capture-perf-'));
const output = process.env.CAPTURE_OUTPUT || join(tmpdir(), `board-capture-performance-${Date.now()}.json`);
let source = await readFile(join(plugin, 'shared/assets/board-runtime.txt'), 'utf8');
if (process.env.CAPTURE_BASELINE_REV) source = execFileSync('git', ['show', `${process.env.CAPTURE_BASELINE_REV}:plugins/paseo-board/shared/assets/board-runtime.txt`], {cwd:plugin,encoding:'utf8'});
source = source.replace('const captureRegion = async', 'const captureRegion = window.captureForTest = async');
source = source.replace('const image = new Image();', 'const decodeStarted=performance.now();const image = new Image();').replace('await ready;', 'await ready;window.captureProbe.decodeMs=performance.now()-decodeStarted;');
source = source.replace('const plan = await capturePlan(region, signal);', 'const planStart=performance.now();const plan = await capturePlan(region, signal);window.captureProbe.planMs=performance.now()-planStart;');
const result = await build({entryPoints:[join(plugin,'shared/document.ts')],bundle:true,format:'esm',platform:'node',write:false,loader:{'.txt':'text'},plugins:[{name:'capture-probe',setup(b){b.onLoad({filter:/board-runtime\.txt$/},()=>({contents:source,loader:'text'})); b.onLoad({filter:/html-to-image\.txt$/},async args=>({contents:(await readFile(args.path,'utf8')).replace('async function w(t,e,n){','async function w(t,e,n){if(t instanceof Element)window.captureProbe.cloneElements=(window.captureProbe.cloneElements||0)+1;')+`\nconst originalSvg=$t; $t=async(...a)=>{const s=performance.now();try{return await originalSvg(...a)}finally{window.captureProbe.svgMs=performance.now()-s}};const originalImage=g;g=async(...a)=>{const s=performance.now();try{return await originalImage(...a)}finally{if(String(a[0]).startsWith('data:image/svg+xml'))window.captureProbe.decodeMs=performance.now()-s}};const originalSerialize=M;M=async(...a)=>{const s=performance.now();const v=await originalSerialize(...a);window.captureProbe.serializeMs=performance.now()-s;window.captureProbe.svgBytes=v.length;return v};`,loader:'text'}));}}]});
await writeFile(join(scratch,'renderer.mjs'), result.outputFiles[0].text);
const {buildBoardDocument} = await import(pathToFileURL(join(scratch,'renderer.mjs')));
let html='';
const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(html)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chrome=spawn(process.env.BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-pipe',`--user-data-dir=${join(scratch,'profile')}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--use-mock-keychain','--window-size=2066,1000','about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe']});
let seq=0,buffer='';const pending=new Map();
chrome.stdio[4].on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\0'))>=0){const msg=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const p=pending.get(msg.id);if(p){pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result)}}});
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject,timer:setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout ${method}`))},60000)});chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0')});
const reports=[];
try {
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const command=(method,params)=>send(method,params,sessionId);
 await command('Page.enable');await command('Runtime.enable');
 await command('Emulation.setDeviceMetricsOverride',{width:2066,height:1000,deviceScaleFactor:1,mobile:false});
 const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 const load=async fragment=>{
   html=buildBoardDocument({boardId:'capture-perf-fixture',sessionId:'capture-perf-session',title:'Capture performance fixture',boardRevision:1,userState:{},theme:{scheme:'light',tokens:{}},canvas:{html:fragment,data:{},patches:[],revision:1,documentVersion:1}});
   await command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/?run=${reports.length}`});
   await evaluate(`new Promise(resolve=>{const check=()=>document.readyState==='complete'&&window.captureForTest?resolve(true):setTimeout(check,10);check()})`);
 };
 const run=async(name,region)=>{
   const native=(await command('Page.captureScreenshot',{format:'png',clip:{x:region.x,y:region.y,width:region.width,height:region.height,scale:1},captureBeyondViewport:true})).data;
   const value=await evaluate(`(async()=>{window.captureProbe={};const tasks=[];const observer=new PerformanceObserver(list=>tasks.push(...list.getEntries().map(e=>e.duration)));observer.observe({type:'longtask'});const started=performance.now();let screenshot,error;try{screenshot=await captureForTest(${JSON.stringify(region)},new AbortController().signal)}catch(e){error=e.message}const totalMs=performance.now()-started;window.captureProbe.cloneAndEmbedMs=(window.captureProbe.svgMs||0)-(window.captureProbe.serializeMs||0);await new Promise(r=>setTimeout(r,60));observer.disconnect();window.lastScreenshot=screenshot;return {totalMs,...window.captureProbe,longestTaskMs:Math.max(0,...tasks),longTasks:tasks.length,pngBytes:screenshot?.data.length,error,elements:document.querySelectorAll('*').length,width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}})()`);
   if (!value.error) { value.pixelDiff=await evaluate(`(async()=>{const read=async data=>{const i=new Image();i.src='data:image/png;base64,'+data;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;c.getContext('2d').drawImage(i,0,0);return {width:i.width,height:i.height,pixels:c.getContext('2d').getImageData(0,0,i.width,i.height).data}};const a=await read(lastScreenshot.data),b=await read(${JSON.stringify(native)});if(a.width!==b.width||a.height!==b.height)return {dimensions:[a.width,a.height,b.width,b.height]};let different=0,total=0;for(let i=0;i<a.pixels.length;i+=4){let max=0;for(let j=0;j<4;j++){const d=Math.abs(a.pixels[i+j]-b.pixels[i+j]);max=Math.max(max,d);total+=d}if(max>20)different++}return {fraction:different/(a.width*a.height),meanChannelError:total/a.pixels.length}})()`); }
   if(process.env.CAPTURE_IMAGES && !value.error){await mkdir(process.env.CAPTURE_IMAGES,{recursive:true});await writeFile(join(process.env.CAPTURE_IMAGES,name+'-native.png'),Buffer.from(native,'base64'));await writeFile(join(process.env.CAPTURE_IMAGES,name+'-capture.png'),Buffer.from(await evaluate('lastScreenshot.data'),'base64'));}
   reports.push({name,region,...value});console.log(JSON.stringify(reports.at(-1)));return value;
 };
 const counts=process.env.CAPTURE_COUNTS==='none'?[]:process.env.CAPTURE_COUNTS?.split(',').map(Number)||[8,32];
 for(const count of counts){
   const fragment=`<style>html,body{padding:0;margin:0;max-width:none;width:2066px;background:#f4f5f8;color:#183048}main{padding:12px}section{box-sizing:border-box;display:grid;grid-template-columns:repeat(10,1fr);grid-template-rows:repeat(7,1fr);gap:2px;height:252px;margin:0 0 4px;background:white;border:1px solid #bbb;padding:8px}article{background:#edf2fa;border-radius:2px;display:flex;align-items:center;justify-content:space-between;font:12px system-ui}b{color:#315080}i{width:16px;height:12px;background:#6192db}</style><main>${Array.from({length:count},(_,i)=>`<section id="section-${i}">${Array.from({length:70},(_,j)=>`<article><b>${i} / ${j}</b><i></i></article>`).join('')}</section>`).join('')}</main>`;
   await load(fragment);
   await run(`${count}-sections-small`,{x:70,y:50,width:240,height:160});
   await run(`${count}-sections-large`,{x:30,y:25,width:1400,height:750});
 }
 if(!process.env.CAPTURE_BASELINE_REV) {
   assert(reports.every(r=>!r.error && r.pixelDiff?.fraction < 0.015), 'long-board crops match native pixels (font rasterization tolerance 1.5%)');
   const base='<style>html,body{padding:0;margin:0;max-width:none;width:2066px;min-height:1600px;background:white;color:#17365d}*{box-sizing:border-box}.box{width:300px;height:180px;padding:12px;border:4px solid #507095;background:#d7e6f6}#grid{display:grid;grid-template-columns:repeat(3,300px);gap:25px;padding:20px;background:linear-gradient(90deg,#f0d0d0,#d0d0f0);border:10px solid #506070;width:1020px}#overflow{position:absolute;left:1600px;top:30px;width:70px;height:70px}#overflow>i{position:absolute;left:-1240px;top:80px;width:75px;height:50px;background:#e64b38}#shadow{position:absolute;left:1150px;top:100px;width:50px;height:80px;box-shadow:-180px 0 12px 3px #14a080}#scroll{position:absolute;top:500px;left:40px;width:420px;height:180px;overflow:auto;border:6px solid #6090b0}#scroll>div{width:700px;height:100px;background:linear-gradient(90deg,#c03,#09c)}#paint{position:absolute;left:520px;top:500px;width:240px;height:160px}#pseudo{position:absolute;left:1500px;top:100px}#pseudo::before{content:"";position:absolute;left:-750px;top:50px;width:60px;height:60px;background:#7654d0}</style>';
   await load(base+'<div id="grid">'+Array.from({length:12},(_,i)=>'<div class="box" style="background:hsl('+i*29+' 60% 80%)"></div>').join('')+'</div><div id="overflow"><i></i></div><div id="shadow"></div><div id="pseudo"></div><div id="scroll">'+Array.from({length:8},()=>'<div></div>').join('')+'</div><canvas id="paint" width="240" height="160"></canvas>');
   let r=await run('overlap-overflow-shadow-pseudo-gradient',{x:30,y:40,width:1000,height:370});
   assert(!r.error && r.pixelDiff.fraction<0.005,'overlaps, pseudo paint, overflow and inherited backgrounds remain accurate');
   await evaluate('document.querySelector("#scroll").scrollTop=145;document.querySelector("#scroll").scrollLeft=130');
   r=await run('nested-scroll-clipping',{x:40,y:500,width:420,height:180});
   assert(!r.error && r.pixelDiff.fraction<0.005,'nested scrolling preserves clip and content position');
   await evaluate('document.querySelector("#paint").getContext("2d").fillStyle="#17a36f";document.querySelector("#paint").getContext("2d").fillRect(0,0,240,160)');
   r=await run('canvas-fresh-first',{x:520,y:500,width:240,height:160});
   assert(!r.error && r.pixelDiff.fraction<0.005,'current Canvas pixels are included');
   await evaluate('document.querySelector("#paint").getContext("2d").fillStyle="#d1378b";document.querySelector("#paint").getContext("2d").fillRect(0,0,240,160)');
   r=await run('canvas-fresh-second',{x:520,y:500,width:240,height:160});
   assert(!r.error && r.pixelDiff.fraction<0.005,'later Canvas pixels are not cached from an old capture');
   await evaluate('scrollTo(0,400)');
   assert.equal(await evaluate('scrollY'),400);
   r=await run('document-scroll',{x:30,y:420,width:900,height:250});
   assert(!r.error && r.pixelDiff.fraction<0.005,'document coordinates survive window scroll');
   await evaluate('document.body.insertAdjacentHTML("beforeend",`<div id="fixed" style="position:fixed;left:1400px;top:20px;width:120px;height:80px;background:#7640b0"></div>`)');
   r=await run('fixed-content-after-document-scroll',{x:1380,y:410,width:160,height:110});
   assert(!r.error && r.pixelDiff.fraction<0.005,'fixed content uses its displayed scrolled coordinates');
   await load('<style>html,body{margin:0;padding:0;max-width:none;background:white;height:1200px}canvas{display:block}</style><canvas id="gl" width="240" height="160"></canvas><script>window.gl=document.querySelector("canvas").getContext("webgl");window.drawGL=()=>{gl.clearColor(0.1,0.7,0.3,1);gl.clear(gl.COLOR_BUFFER_BIT)};drawGL();addEventListener("paseo:capture",drawGL)</script>');
   assert.equal(await evaluate('Boolean(window.gl)'),true);
   r=await run('webgl-capture-redraw',{x:0,y:0,width:240,height:160});
   assert(!r.error && r.pixelDiff.fraction<0.005,'WebGL redraw event supplies current pixels');
   await evaluate('document.body.insertAdjacentHTML("beforeend",`<div data-board-overlay style="position:fixed;left:0;top:0;width:240px;height:160px;background:red"></div>`)');
   const noOverlay=await evaluate('(async()=>{captureProbe={};const shot=await captureForTest({x:0,y:0,width:240,height:160},new AbortController().signal);const i=new Image();i.src="data:image/png;base64,"+shot.data;await i.decode();const c=document.createElement("canvas");c.width=240;c.height=160;c.getContext("2d").drawImage(i,0,0);return Array.from(c.getContext("2d").getImageData(100,100,1,1).data)})()');
   assert(noOverlay[1]>150 && noOverlay[0]<50,'selection and marker overlays are excluded');
   await load('<style>html,body{margin:0;padding:0;max-width:none;background:white}.dense{display:inline-block;width:6px;height:6px;background:#123}</style>'+Array.from({length:2100},()=>'<i class="dense"></i>').join(''));
   r=await run('bounded-complex-selection',{x:0,y:0,width:2000,height:800});
   assert.match(r.error,/too complex to capture promptly/);
   const invalidation=await evaluate(`(async()=>{
     const original=HTMLCanvasElement.prototype.toDataURL;
     const c=new AbortController();window.captureProbe={};
     const animation=document.querySelector('i').animate([{opacity:1},{opacity:0.5}],{duration:1000,iterations:Infinity});
     const pending=captureForTest({x:0,y:0,width:2000,height:800},c.signal).then(()=>null,e=>e.name);
     const abort=()=>HTMLCanvasElement.prototype.toDataURL!==original?c.abort():setTimeout(abort,0);setTimeout(abort,0);
     const error=await pending;const restored=HTMLCanvasElement.prototype.toDataURL===original;
     const resumed=animation.playState==='running';animation.cancel();
     window.captureProbe={};const changing=captureForTest({x:0,y:0,width:2000,height:800},new AbortController().signal).then(()=>null,e=>e.message);
     const change=()=>HTMLCanvasElement.prototype.toDataURL!==original?document.querySelector('i').textContent='changed':setTimeout(change,0);setTimeout(change,0);
     return {error,restored,resumed,mutationError:await changing,restoredAgain:HTMLCanvasElement.prototype.toDataURL===original};
   })()`);
   assert.equal(invalidation.error,'AbortError');assert(invalidation.restored && invalidation.restoredAgain && invalidation.resumed);assert.match(invalidation.mutationError,/Canvas changed/);
   reports.push({name:'cancellation-mutation-animation-restoration',...invalidation});
   console.log('PASS native-pixel comparisons, scrolled/overlapping content, fresh Canvas/WebGL pixels, overlays, bounded complexity and cancellation');
 }
 assert(reports.every(r=>r.pngBytes||r.error||r.restored),'captures produce a result or explicit error');
 await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify({baselineRevision:process.env.CAPTURE_BASELINE_REV||null,node:process.version,browser:await send('Browser.getVersion'),reports},null,2));
 console.log(`Evidence: ${output}`);
}finally{chrome.kill('SIGTERM');await new Promise(resolve=>chrome.exitCode===null?chrome.once('exit',resolve):resolve());server.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('browser closed'))}await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
