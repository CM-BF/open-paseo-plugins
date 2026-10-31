#!/usr/bin/env node
// Real Chromium integration checks, driven over a private DevTools pipe. No daemon or live
// agent is used. BROWSER_PATH may point to another Chromium executable.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const directory = dirname(fileURLToPath(import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'paseo-board-browser-'));
const bundle = await build({ entryPoints: [join(directory, 'browser-fixture.tsx')], bundle: true, format: 'iife', platform: 'browser', write: false, loader: { '.txt': 'text' }, define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'native-fixture', setup(build) { build.onResolve({ filter: /^react-native$/ }, () => ({ path: 'native', namespace: 'fixture' })); build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const Platform = { OS: "web" }', loader: 'js' })); } }] });
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : '<!doctype html><style>body{margin:0}</style><div id="app"></div><script src="/bundle.js"></script>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const chrome = spawn(process.env.BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--use-mock-keychain', '--window-size=1100,850', 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let seq = 0;
let buffer = '';
const commands = new Map();
const logs = [];
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.id && commands.has(message.id)) {
      const entry = commands.get(message.id); commands.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') logs.push(message.params.exceptionDetails);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { commands.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
  commands.set(id, { resolve, reject, timer });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
let passed = 0;
const check = (name) => { passed++; console.log(`PASS ${name}`); };
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  await command('Runtime.enable');
  await command('Page.enable');
  const evaluate = async (expression) => {
    const value = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  };
  const until = async (expression, timeout = 10000) => {
    await evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+${timeout};const loop=()=>{try{if(${expression}){resolve(true);return}}catch{}if(performance.now()>deadline){reject(new Error('condition timeout: '+${JSON.stringify(expression)}));return}setTimeout(loop,20)};loop()})`);
  };
  const frame = (expression) => evaluate(`window.fixtureCall(${JSON.stringify(expression)})`);
  const untilFrame = (expression, timeout = 10000) => frame(`new Promise((resolve,reject)=>{const deadline=performance.now()+${timeout};const loop=()=>{if(${expression})return resolve(true);if(performance.now()>deadline)return reject(new Error('frame condition timeout: '+${JSON.stringify(expression)}));setTimeout(loop,20)};loop()})`);
  const settleFrame = async () => { await frame('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await evaluate('new Promise(resolve=>setTimeout(resolve,0))'); };
  const key = async (name, code = name, modifiers = 0) => {
    const virtual = name === 'Escape' ? 27 : name === 'Alt' ? 18 : undefined;
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, modifiers, ...(virtual ? { windowsVirtualKeyCode: virtual } : {}) });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, modifiers: 0, ...(virtual ? { windowsVirtualKeyCode: virtual } : {}) });
  };
  const clickPoint = async (x, y) => {
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const location = async (selector) => {
    const box = await frame(`(()=>{const selector=${JSON.stringify(selector)};const element=document.querySelector('[data-board-menu]')?.shadowRoot?.querySelector(selector)||document.querySelector('[data-board-markers]')?.shadowRoot?.querySelector(selector)||document.querySelector(selector);const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    const origin = await evaluate(`(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()`);
    return { x: origin.x + box.x, y: origin.y + box.y, width: box.width, height: box.height };
  };
  const click = async (selector) => { const b = await location(selector); await clickPoint(b.x + b.width / 2, b.y + b.height / 2); };
  const rightClickPoint = async (x, y, modifiers = 0) => {
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, modifiers });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1, modifiers });
  };
  const rightClick = async (selector, modifiers = 0) => { const b = await location(selector); await rightClickPoint(b.x + b.width / 2, b.y + b.height / 2, modifiers); };
  const drag = async (from, to, modifiers = 0, whilePressed) => {
    if (modifiers & 1) await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers });
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, modifiers });
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, modifiers });
    if (whilePressed) await whilePressed();
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: 'left', buttons: 1, modifiers });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, modifiers });
    if (modifiers & 1) await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 });
  };
  const noMenu = () => untilFrame("!document.querySelector('[data-board-menu]') && !document.querySelector('[data-board-capture-status]')");
  const composeAfter = async (action) => {
    const before = await evaluate('results.composes.length');
    await action();
    await until(`results.composes.length === ${before + 1}`, 18000);
    await noMenu();
    return evaluate('results.composes.at(-1)');
  };
  const update = (expression) => evaluate(`update(${expression})`);
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until('window.results?.ready === 1');
  assert.equal(await frame('window.boots'), 1);
  assert.deepEqual(await frame('board.getData()'), { n: 0 });
  assert.deepEqual(await frame('board.restoreState()'), { saved: 'original' });
  assert.equal(await evaluate("document.querySelector('iframe').sandbox.value"), 'allow-scripts');
  check('sandbox runs arbitrary JS, SVG and Canvas, and initializes JSON/state before agent code');

  await frame("board.saveState({draft:'first'});board.saveState({draft:'second'})");
  await update("{userState:{draft:'first'},canvas:{...hostProps.canvas,data:{n:0,race:true}}}");
  await frame("new Promise(resolve=>{if(board.getData().race)resolve();else board.onData(resolve)})");
  assert.deepEqual(await frame('board.getState()'), {draft:'second'});
  await until('results.states.length === 1');
  assert.deepEqual(await evaluate('results.states[0]'), {draft:'second'});
  check('an old state acknowledgement cannot overwrite a newer local save');
  await click('#increment');
  await frame("document.querySelector('#field').value='keep typed input'");
  const ticks = await frame('window.ticks');
  await update("{boardRevision:2,canvas:{...hostProps.canvas,data:{n:1},revision:2}} ");
  await until('window.results.ready === 1');
  await frame("new Promise(resolve=>{if(board.getData().n===1)resolve();else board.onData(resolve)})");
  assert.equal(await frame("document.querySelector('#field').value"), 'keep typed input');
  assert.equal(await frame('window.count'), 1);
  assert.ok(await frame('new Promise(resolve=>requestAnimationFrame(()=>resolve(window.ticks)))') > ticks);
  assert.equal(await frame('window.boots'), 1);
  check('live data retains controls, animation clock and the iframe JS heap');

  await frame(`(()=>{window.watchResults=[];window.watchStops=[board.watch('/live/a',(v,c)=>{watchResults.push({value:v,exists:c.exists,revision:c.canvasRevision});if(v&&typeof v==='object')v.changedByListener=true})];return true})()`);
  assert.deepEqual(await frame('watchResults'), [{exists:false,revision:2}]);
  await update('{canvas:{...hostProps.canvas,data:{n:1,live:{a:{score:0.8,phase:"ready"},b:0}}}}');
  await untilFrame('watchResults.length===2');
  assert.deepEqual(await frame('board.getData().live.a'), {score:0.8,phase:'ready'});
  await update('{canvas:{...hostProps.canvas,data:{n:1,live:{a:{phase:"ready",score:0.8},b:1}}}}');
  await untilFrame('board.getData().live.b===1');
  assert.equal(await frame('watchResults.length'), 2);
  assert.equal(await frame("document.querySelector('#field').value"), 'keep typed input');
  assert.equal(await frame('window.boots'), 1);
  check('path watches render initially, isolate callback data and skip sibling/key-order-only changes without remounting controls');

  await frame(`(()=>{window.escapedResults=[];window.unsubEscaped=board.watch('/a~1b/~0',(v,c)=>escapedResults.push({value:v,exists:c.exists}));window.sharedCalls=0;const fn=()=>sharedCalls++;window.offOne=board.watch('/live/a',fn);window.offTwo=board.watch('/live/a',fn);offOne();window.offThrow=board.watch('/live/a',()=>{throw new Error('expected-watch-error')});return true})()`);
  await update('{canvas:{...hostProps.canvas,data:{n:1,live:{a:null},"a/b":{"~":42}}}}');
  await untilFrame('escapedResults.length===2');
  assert.deepEqual(await frame('watchResults.at(-1)'), {value:null,exists:true,revision:2});
  assert.deepEqual(await frame('escapedResults.at(-1)'), {value:42,exists:true});
  assert.equal(await frame('sharedCalls'), 3);
  await update('{canvas:{...hostProps.canvas,data:{n:1,live:{}}}}');
  await untilFrame('watchResults.at(-1).exists===false');
  assert.deepEqual(await frame('escapedResults.at(-1)'), {exists:false});
  assert.equal(await frame('sharedCalls'), 4);
  await frame('watchStops.forEach(off=>off());unsubEscaped();offTwo();offThrow()');
  assert.deepEqual(await frame(`['bad','/x~2','/__proto__/x','/constructor','/prototype'].map(p=>{try{board.watch(p,()=>{});return false}catch{return true}})`), [true,true,true,true,true]);
  const stoppedCalls = await frame('watchResults.length');
  await update('{canvas:{...hostProps.canvas,data:{n:1,live:{a:2}}}}');
  await untilFrame('board.getData().live.a===2');
  assert.equal(await frame('watchResults.length'), stoppedCalls);
  await update('{canvas:{...hostProps.canvas,data:{n:1}}}');
  await untilFrame('!board.getData().live');
  check('path watches distinguish null/removal, decode pointers, reject prototype traversal, isolate listener errors and unsubscribe independently');

  await frame(`(()=>{window.nestedCalls=[];window.nestedStops=[];nestedStops.push(board.watch('/left',(_v,c)=>{if(c.exists)nestedStops.push(board.watch('/right',(v,c)=>nestedCalls.push({value:v,revision:c.canvasRevision})))}));nestedStops.push(board.watch('/right',()=>{}));return true})()`);
  await update('{canvas:{...hostProps.canvas,data:{n:1,left:1,right:2}}}');
  await untilFrame('board.getData().right===2');
  assert.deepEqual(await frame('nestedCalls'), [{value:2,revision:2}]);
  await frame('nestedStops.forEach(off=>off())');
  await update('{canvas:{...hostProps.canvas,data:{n:1}}}');
  await untilFrame('!board.getData().left');
  check('a subscription added during another renderer receives the current snapshot once, never an old value labelled with a new revision');

  await frame(`(()=>{window.subtreeCalls={parent:[],child:[],sibling:[]};window.subtreeStops=[board.watch('/tree',v=>subtreeCalls.parent.push(v)),board.watch('/tree/child/n',v=>subtreeCalls.child.push(v)),board.watch('/other',v=>subtreeCalls.sibling.push(v))];return true})()`);
  await update('{canvas:{...hostProps.canvas,data:{n:1,tree:{child:{n:1}},other:0}}}');
  await untilFrame('board.getData().tree?.child.n===1');
  await update('{canvas:{...hostProps.canvas,data:{n:1,tree:{child:{n:2}},other:0}}}');
  await untilFrame('board.getData().tree?.child.n===2');
  assert.deepEqual(await frame('[subtreeCalls.parent.length,subtreeCalls.child.length,subtreeCalls.sibling.length]'),[3,3,2]);
  await update('{canvas:{...hostProps.canvas,data:{n:1,tree:null,other:0}}}');
  await untilFrame('board.getData().tree===null');
  assert.equal(await frame('subtreeCalls.child.at(-1)===undefined'),true);
  await frame('subtreeStops.forEach(off=>off())');
  check('delta path filtering notifies ancestor and descendant watches while skipping unrelated siblings');

  await frame(`(()=>{window.savedRaf=window.requestAnimationFrame;window.savedCancelRaf=window.cancelAnimationFrame;window.heldFrames=new Map();window.frameSequence=100000;window.requestAnimationFrame=fn=>{const id=++frameSequence;heldFrames.set(id,fn);return id};window.cancelAnimationFrame=id=>heldFrames.delete(id);window.frameValues=[];window.syncValues=[];window.cancelledValues=[];window.frameOff=board.watch('/burst',(v,c)=>frameValues.push({v,revision:c.canvasRevision}),{schedule:'frame'});window.syncOff=board.watch('/burst',v=>syncValues.push(v));window.cancelOff=board.watch('/burst',v=>cancelledValues.push(v),{schedule:'frame'});return true})()`);
  await update('{canvas:{...hostProps.canvas,data:{n:1,burst:1}}}'); await untilFrame('board.getData().burst===1');
  await update('{canvas:{...hostProps.canvas,data:{n:1,burst:2}}}'); await untilFrame('board.getData().burst===2');
  assert.deepEqual(await frame('[frameValues.length,syncValues.length,cancelledValues.length]'),[1,3,1]);
  await frame('cancelOff();window.requestAnimationFrame=savedRaf;window.cancelAnimationFrame=savedCancelRaf;for(const fn of heldFrames.values())fn(performance.now());heldFrames.clear()');
  assert.deepEqual(await frame('frameValues'),[{revision:2},{v:2,revision:2}]);
  assert.equal(await frame('cancelledValues.length'),1);
  await frame('frameOff();syncOff()');
  check('optional frame watches render immediately then deliver the latest value once per frame; sync watches stay synchronous and unsubscribe cancels a queued render');

  await frame(`(()=>{window.themeWrites=[];window.themeEvents=0;window.themeObserver=new MutationObserver(records=>themeWrites.push(...records.map(r=>r.attributeName)));themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['style','data-theme']});window.themeListener=()=>themeEvents++;window.addEventListener('paseo:themechange',themeListener);return true})()`);
  await evaluate("setTheme('light')");
  await update('{canvas:{...hostProps.canvas,data:{n:1,themeCheck:true}}}'); await untilFrame('board.getData().themeCheck===true');
  assert.deepEqual(await frame('[themeWrites.length,themeEvents]'),[0,0]);
  await evaluate("setTheme('dark')"); await untilFrame('document.documentElement.dataset.theme==="dark"');
  assert.equal(await frame('themeEvents'),1);
  await frame('themeWrites=[]'); await evaluate("setTheme('dark')"); await settleFrame();
  assert.deepEqual(await frame('[themeWrites.length,themeEvents]'),[0,1]);
  await evaluate("setTheme('light')"); await untilFrame('document.documentElement.dataset.theme==="light"');
  assert.equal(await frame('themeEvents'),2);
  await frame("themeObserver.disconnect();window.removeEventListener('paseo:themechange',themeListener)");
  check('equal host themes produce zero CSS mutations and no themechange; each changed theme emits once');

  await update('{canvas:{...hostProps.canvas,data:{n:1,records:Array.from({length:20000},(_,id)=>({id,text:"x".repeat(80)}))}}}');
  await untilFrame('board.getData().records?.length===20000');
  const fullDataBytes = await evaluate('JSON.stringify(hostProps.canvas.data).length');
  await frame('window.heapSentinel={zoom:2.75};window.heapReference=heapSentinel;document.querySelector("#paint").style.transform="scale(1.25)";document.querySelector("#field").focus()');
  await update('{canvas:{...hostProps.canvas,data:{...hostProps.canvas.data,n:2}}}'); await untilFrame('board.getData().n===2');
  const scalarTransfer = await frame('transportLog.at(-1)');
  assert.equal(scalarTransfer.type,'delta'); assert.deepEqual(scalarTransfer.paths,['/n']); assert.equal(scalarTransfer.html,false); assert.equal(scalarTransfer.theme,false);
  assert.ok(scalarTransfer.bytes<600 && fullDataBytes>2000000);
  await update('{canvas:{...hostProps.canvas,data:{...hostProps.canvas.data,records:[...hostProps.canvas.data.records,{id:20000,text:"tail"}]}}}'); await untilFrame('board.getData().records.length===20001');
  const appendTransfer = await frame('transportLog.at(-1)'); assert.deepEqual(appendTransfer.ops,['append']); assert.ok(appendTransfer.bytes<700);
  assert.equal(await frame('heapSentinel===heapReference && heapSentinel.zoom===2.75'),true);
  assert.equal(await frame('document.querySelector("#paint").style.transform'),'scale(1.25)');
  assert.equal(await frame('document.activeElement.id'),'field'); assert.equal(await frame('boots'),1);
  assert.equal(await frame('document.querySelector("#field").value'),'keep typed input');
  console.log(`PAYLOAD full-data=${fullDataBytes} scalar-delta=${scalarTransfer.bytes} append-delta=${appendTransfer.bytes}`);
  check('large data scalar edits and record appends transfer compact deltas while input/focus/zoom and the JS heap remain intact');

  // Inject an actual ahead-of-baseline delta through the scoped parent channel. The host must
  // answer the receiver's recovery request with a full snapshot, without changing the iframe.
  const recoveryReady = await evaluate('results.ready'); const recoveryRequests = await evaluate('results.raw.filter(m=>m.type==="snapshot-request").length');
  const corrupted = await frame('({...lastTransport,delta:{...lastTransport.delta,version:lastTransport.delta.version+2,base:{...lastTransport.delta.base,version:lastTransport.delta.version+1}}})');
  await evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify(corrupted)},'*')`);
  await until(`results.raw.filter(m=>m.type==='snapshot-request').length===${recoveryRequests+1}`);
  await untilFrame('transportLog.at(-1).type==="snapshot"');
  assert.equal(await frame('board.getData().records.length'),20001); assert.equal(await frame('heapSentinel===heapReference'),true); assert.equal(await evaluate('results.ready'),recoveryReady);
  const duplicate = await frame('lastTransport');
  await evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify(duplicate)},'*')`); await settleFrame();
  assert.equal(await evaluate('results.raw.filter(m=>m.type==="snapshot-request").length'),recoveryRequests+1);
  await frame(`window.dispatchEvent(new MessageEvent('message',{source:parent,data:{...lastTransport,version:lastTransport.version+100,snapshot:{...lastTransport.snapshot,canvas:{...lastTransport.snapshot.canvas,data:{forged:true}}}}}))`);
  assert.equal(await frame('board.getData().forged===undefined'),true);
  const downgrade = { ...duplicate, version: undefined, protocol: undefined, snapshot: { ...duplicate.snapshot, canvas: { ...duplicate.snapshot.canvas, data: { downgraded: true } } } };
  await evaluate(`document.querySelector('iframe').contentWindow.postMessage(${JSON.stringify(downgrade)},'*')`); await settleFrame();
  assert.equal(await frame('board.getData().downgraded===undefined'),true);
  await update('{canvas:{...hostProps.canvas,data:{n:1}}}'); await untilFrame('board.getData().n===1 && !board.getData().records');
  await frame('document.querySelector("#paint").style.transform=""');
  check('gapped transport requests one complete recovery without remounting; duplicate recovery and synthetic parent messages cannot undo state');

  const patch = { id: 'patch-one', selector: '#target', operation: 'append', html: '<button id="new-control">New animation</button><script>window.patchRuns=(window.patchRuns||0)+1;document.querySelector("#new-control").onclick=()=>window.patchClicks=(window.patchClicks||0)+1</script>' };
  await update(`{boardRevision:3,canvas:{...hostProps.canvas,revision:3,patches:[${JSON.stringify(patch)}]}}`);
  await frame("new Promise(resolve=>{const tick=()=>window.patchRuns?resolve():setTimeout(tick,10);tick()})");
  await click('#new-control');
  await update('{boardRevision:4,canvas:{...hostProps.canvas,revision:4,data:{n:2}}}');
  await frame("new Promise(resolve=>{if(board.getData().n===2)resolve();else board.onData(resolve)})");
  assert.equal(await frame('window.patchRuns'), 1);
  assert.equal(await frame('window.patchClicks'), 1);
  assert.equal(await frame("document.querySelector('#field').value"), 'keep typed input');
  check('append executes its new script exactly once across replay and preserves existing controls');

  await click('#save');
  await until('results.states.length === 2');
  assert.deepEqual(await evaluate('results.states[1]'), { field: 'keep typed input', count: 1 });
  await click('#ask');
  await until('results.asks.length === 1');
  assert.equal(await frame('window.answer.status'), 'submitted');
  assert.equal(await frame("board.ask('background request').then(r=>r.status)"), 'cancelled');
  // Transient activation lasts a few seconds: wait on the browser's own expiry, not a fixed sleep.
  await frame("new Promise(resolve=>{const tick=()=>navigator.userActivation.isActive?setTimeout(tick,20):resolve();tick()})");
  assert.equal(await frame("board.ask('no user gesture').then(r=>r.status)"), 'cancelled');
  check('user-triggered bridge asks and state saves work; idle script asks are rejected');

  await click('#submit');
  await frame("new Promise(resolve=>{const t=()=>window.submits?resolve():setTimeout(t,10);t()})");
  assert.equal(await frame('window.submits'), 1);
  check('interactive forms run local submit handlers without granting form network navigation');
  await click('#link');
  await until('results.links.length === 1');
  assert.equal(await evaluate('results.links[0]'), 'https://example.com/');
  const before = await evaluate('results.asks.length');
  await evaluate("(()=>{const s=results.raw.find(m=>m.type==='ready');window.dispatchEvent(new MessageEvent('message',{source:window,data:{...s,type:'ask',id:'forged-host',request:{prompt:'forged'}}}));document.querySelector('iframe').contentWindow.postMessage({...s,boardId:'other-board',type:'snapshot',snapshot:{...hostProps,canvas:{...hostProps.canvas,data:{n:999}}}},'*')})()");
  assert.equal(await evaluate('results.asks.length'), before);
  assert.equal((await frame('board.getData()')).n, 2);
  await frame("parent.postMessage({channel:'paseo-board-frame-v1',boardId:'test-board',sessionId:'wrong-session',type:'ask',id:'forged',request:{prompt:'no'}},'*')");
  assert.equal(await evaluate('results.asks.length'), before);
  check('wrong-window, wrong-board and wrong-session messages cannot invoke host operations');

  const extras = [
    {id:'prepend', selector:'#target', operation:'prepend', html:'<span id="first">First</span><script>window.prepended=(window.prepended||0)+1</script>'},
    {id:'replace', selector:'#first', operation:'replace', html:'<span id="replacement">Replaced</span><script>window.replaced=(window.replaced||0)+1</script>'},
    {id:'remove', selector:'#new-control', operation:'remove', html:''}
  ];
  await update(`{canvas:{...hostProps.canvas,patches:[...hostProps.canvas.patches,...${JSON.stringify(extras)}]}}`);
  await frame("new Promise(resolve=>{const t=()=>document.querySelector('#replacement')&&!document.querySelector('#new-control')?resolve():setTimeout(t,10);t()})");
  assert.deepEqual(await frame('[window.prepended,window.replaced]'), [1,1]);
  assert.equal(await frame("document.querySelector('#field').value"), 'keep typed input');
  check('prepend, replace and remove apply in order, execute added scripts, and retain unrelated input');
  await update("{selectionMode:'region'}");
  await untilFrame("document.documentElement.dataset.boardSelection==='region'");
  await update('{boardRevision:5,canvas:{...hostProps.canvas,revision:5,data:{n:3}}}');
  const box = await location('#paint');
  const region = await composeAfter(() => drag({x:box.x+5,y:box.y+5},{x:box.x+140,y:box.y+70}));
  assert.equal(region.kind, 'question'); assert.equal(region.anchor.kind, 'region');
  assert.equal(region.anchor.boardRevision, 4); assert.equal(region.anchor.canvasRevision, 4);
  assert.equal(region.anchor.rect.width, 135); assert.equal(region.anchor.rect.height, 65);
  const png = Buffer.from(region.anchor.image.data, 'base64');
  assert.equal(png.readUInt32BE(16), 135); assert.equal(png.readUInt32BE(20), 65);
  await untilFrame('board.getData().n===3');
  assert.equal(await evaluate('results.asks.length'), before);
  check('region release opens one blank composer and then adds its frozen PNG and releases queued updates without a menu or submission');

  const words = await location('#words');
  const nativeText = await composeAfter(() => drag({x:words.x+1,y:words.y+10},{x:words.x+190,y:words.y+10}));
  assert.equal(nativeText.anchor.kind, 'text'); assert.ok(nativeText.anchor.text.includes('stable'));
  assert.ok(nativeText.anchor.image.data.startsWith('iVBORw0KGgo'));
  await frame('getSelection().removeAllRanges()');
  await update("{selectionMode:'text'}");
  await untilFrame("document.documentElement.dataset.boardSelection==='text'");
  const explicitText = await composeAfter(() => drag({x:words.x+1,y:words.y+10},{x:words.x+170,y:words.y+10}));
  assert.equal(explicitText.anchor.kind, 'text');
  await frame('getSelection().removeAllRanges()');
  const doubleText = await composeAfter(async () => {
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x:words.x+80,y:words.y+10,button:'left',clickCount:2});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:words.x+80,y:words.y+10,button:'left',clickCount:2});
  });
  assert.equal(doubleText.anchor.kind, 'text'); assert.ok(doubleText.anchor.text.trim());
  await frame('getSelection().removeAllRanges()');
  check('ordinary native text selection and explicit text mode open pointer-local input on mouse release');

  await update("{selectionMode:'point'}");
  await untilFrame("document.documentElement.dataset.boardSelection==='point'");
  const pointMode = await composeAfter(() => clickPoint(900,600));
  assert.equal(pointMode.anchor.kind, 'point');
  const rightPoint = await composeAfter(() => rightClick('#target'));
  assert.equal(rightPoint.kind, 'question'); assert.equal(rightPoint.anchor.kind, 'point');
  assert.deepEqual(rightPoint.position, {x:rightPoint.anchor.rect.x,y:rightPoint.anchor.rect.y});
  assert.equal(await frame("document.querySelectorAll('[data-board-menu]').length"), 0);
  check('right-click and explicit point selection open the same question composer directly beside the pointer');

  let control = await location('#dragbox');
  await drag({x:control.x+20,y:control.y+20},{x:control.x+50,y:control.y+35});
  const moved = await location('#dragbox');
  assert.equal(moved.x,control.x+30); assert.equal(moved.y,control.y+15);
  const controls = await frame('controlEvents');
  const altRegion = await composeAfter(() => drag({x:moved.x+10,y:moved.y+10},{x:moved.x+150,y:moved.y+55},1));
  assert.equal(altRegion.anchor.kind,'region');
  assert.deepEqual(await location('#dragbox'),moved); assert.deepEqual(await frame('controlEvents'),controls);
  check('ordinary author drags remain native; Option/Alt drags create a region and open input without moving the control');

  const nativeCount = await evaluate('results.composes.length');
  await rightClick('#textarea'); await key('Escape');
  await rightClick('#editable-child'); await key('Escape');
  await rightClick('#target',8); await key('Escape');
  const editing = await location('#textarea');
  await drag({x:editing.x+8,y:editing.y+10},{x:editing.x+75,y:editing.y+10});
  await drag({x:editing.x+8,y:editing.y+10},{x:editing.x+85,y:editing.y+10},1);
  await settleFrame();
  assert.equal(await evaluate('results.composes.length'),nativeCount);
  assert.ok((await frame('controlEvents.contexts')).some(x=>x.target==='textarea'&&!x.prevented));
  assert.ok((await frame('controlEvents.contexts')).some(x=>x.target==='editable-child'&&!x.prevented));
  check('inputs, contenteditable selection and context menus stay native, including Shift+right-click and Alt drags in editors');

  const securityCount = await evaluate('results.composes.length');
  await frame("document.querySelector('#target').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:200}));document.querySelector('#words').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:32,clientX:25,clientY:200}));document.querySelector('#words').dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerId:32,clientX:180,clientY:200}))");
  await evaluate("(()=>{const scope=results.raw.filter(m=>m.type==='ready').at(-1);const old=results.raw.filter(m=>m.type==='compose').at(-1);fixtureCall(`parent.postMessage(${JSON.stringify({...old,...scope,type:'compose',automatic:true})},'*')`)})()");
  await settleFrame();
  assert.equal(await evaluate('results.composes.length'),securityCount);
  check('synthetic context menus, pointer selection and stale automatic composition leases cannot open input');

  await frame('pauseNextCapture()');
  await rightClick('#target');
  await untilFrame('captureGate?.held===true');
  const cancelled = await evaluate('results.composes.length');
  await key('Escape');
  await frame('releaseCapture()'); await noMenu(); await settleFrame();
  assert.equal(await evaluate('results.composes.length'),cancelled);
  await click('#increment'); assert.equal(await frame('count'),2);
  check('Escape cancels a slow capture; late pixels cannot resurrect input and ordinary controls immediately recover');

  const frozen = await frame('board.getContext()');
  await frame('pauseNextCapture()');
  await rightClick('#target');
  await untilFrame('captureGate?.held===true');
  await update("{boardRevision:6,canvas:{...hostProps.canvas,revision:6,data:{n:4},patches:[...hostProps.canvas.patches,{id:'during-capture',selector:'#target',operation:'append',html:'<div id=after-capture>new</div>'}]}}");
  await untilFrame('transportLog.at(-1).patchIds.includes("during-capture")');
  await update("{canvas:{...hostProps.canvas,data:{n:4,captureTail:[1,2]},patches:[...hostProps.canvas.patches,{id:'during-capture-two',selector:'#target',operation:'append',html:'<div id=after-capture-two>second</div><script>window.capturePatchRuns=(window.capturePatchRuns||0)+1</script>'}]}}");
  await untilFrame('transportLog.at(-1).patchIds.includes("during-capture-two")');
  await update("{canvas:{...hostProps.canvas,data:{n:4,captureTail:[1,2,3]}}}");
  await untilFrame('transportLog.at(-1).paths?.includes("/captureTail")');
  assert.equal(await frame('board.getData().n'),3);
  assert.equal(await frame("Boolean(document.querySelector('#after-capture'))"),false);
  await frame('new Promise(resolve=>{const check=()=>navigator.userActivation.isActive?setTimeout(check,20):resolve();check()})');
  const delayed = await evaluate('results.composes.at(-1)');
  assert.equal(delayed.captureStatus, 'pending');
  await frame('releaseCapture()'); await noMenu();
  assert.equal(delayed.anchor.canvasRevision,frozen.canvasRevision);
  assert.equal(delayed.anchor.boardRevision,frozen.boardRevision);
  await untilFrame("board.getData().n===4 && Boolean(document.querySelector('#after-capture'))");
  await untilFrame('window.capturePatchRuns===1');
  assert.deepEqual(await frame('board.getData().captureTail'),[1,2,3]);
  assert.equal(await frame('document.querySelectorAll("#after-capture-two").length'),1);
  check('a slow capture freezes data, patches and revision; its original gesture opens input before capture and accepts pixels after activation expires');

  await frame('pauseNextCapture()'); await rightClick('#target'); await untilFrame('captureGate?.held===true');
  const clearedCount = await evaluate('results.composes.length');
  await update('{selectionClearToken:1}'); await noMenu();
  await frame('releaseCapture()'); await settleFrame();
  assert.equal(await evaluate('results.composes.length'),clearedCount);
  check('host clearing the reference cancels in-flight automatic composition and rejects its late screenshot');

  const beforeDocument = await frame('board.getContext()');
  await frame('board.saveState({field:"saved during replacement",count:8});pauseNextCapture()');
  await rightClick('#target'); await untilFrame('captureGate?.held===true');
  const readyBefore = await evaluate('results.ready');
  await evaluate('replaceDocument()');
  assert.equal(await evaluate('results.ready'),readyBefore);
  // Automatic composition releases the old iframe immediately. Do not await a fixture reply
  // from that soon-to-be-replaced window; observe the real host composition and ready events.
  const replacedCompose = await evaluate('results.composes.at(-1)');
  assert.equal(replacedCompose.captureStatus, 'pending');
  await evaluate("fixtureCall('releaseCapture()'); true");
  assert.equal(replacedCompose.anchor.canvasRevision,beforeDocument.canvasRevision);
  await until(`results.ready===${readyBefore+1}`);
  assert.equal(await frame('board.getContext().documentVersion'),beforeDocument.documentVersion+1);
  assert.equal(await frame('boots'),1);
  assert.deepEqual(await frame('board.restoreState()'),{field:'saved during replacement',count:8});
  check('a queued document replacement waits for capture, opens input with the old frozen reference, then restores saved controls');

  const reconnectReady = await evaluate('results.ready');
  const bad = {id:'bad-script',selector:'#target',operation:'append',html:'<script>window.badRuns=(window.badRuns||0)+1;throw new Error("fixture patch error")</script>'};
  await update(`{boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[${JSON.stringify(patch)},...${JSON.stringify(extras)},${JSON.stringify(bad)}]}}`);
  await until("results.errors.some(e=>e.patchId==='bad-script')");
  await update('{boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,data:{n:5}}}');
  assert.equal(await frame('badRuns'),1);
  await evaluate('reconnect()'); await until(`results.ready===${reconnectReady+1}`);
  await untilFrame('window.replaced===1');
  assert.deepEqual(await frame('[window.patchRuns,window.prepended,window.replaced]'),[1,1,1]);
  assert.equal(await frame("document.querySelectorAll('#replacement').length"),1);
  await evaluate('replaceDocument()'); await until(`results.ready===${reconnectReady+2}`);
  check('reconnect replays patches once, failed scripts are not retried, and explicit replacement clears the old journal');

  await evaluate('document.body.tabIndex=-1;document.body.focus()');
  const firstRight = await composeAfter(() => rightClick('#target'));
  assert.equal(firstRight.anchor.kind,'point');
  await evaluate('document.body.focus()');
  const focusPaint = await location('#paint');
  const firstAlt = await composeAfter(() => drag({x:focusPaint.x+5,y:focusPaint.y+5},{x:focusPaint.x+120,y:focusPaint.y+55},1));
  assert.equal(firstAlt.anchor.kind,'region');
  check('the first right-click and Alt drag after host focus acquire a valid lease and open the composer');

  const bounds = await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return{bottom:r.bottom,height:innerHeight}})()");
  assert.ok(bounds.bottom+10<bounds.height);
  const outsideCount = await evaluate('results.composes.length');
  await drag({x:focusPaint.x+10,y:focusPaint.y+10},{x:focusPaint.x+130,y:bounds.bottom+10},1);
  await untilFrame("document.documentElement.dataset.boardSelection==='off'"); await noMenu(); await settleFrame();
  assert.equal(await evaluate('results.composes.length'),outsideCount);
  await update('{boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,data:{n:6}}}');
  await untilFrame('board.getData().n===6');
  await click('#increment'); assert.equal(await frame('count'),1);
  const longDrag = await composeAfter(() => drag({x:focusPaint.x+5,y:focusPaint.y+5},{x:focusPaint.x+135,y:focusPaint.y+65},1,()=>frame('new Promise(resolve=>{const check=()=>navigator.userActivation.isActive?setTimeout(check,20):resolve();check()})')));
  assert.equal(longDrag.anchor.kind,'region');
  check('outside release cancels selection without a stuck lease; a completed long drag still opens input after activation expires');

  await update('{selectionClearToken:77}');
  await settleFrame();
  const markerAnchor = await frame("(()=>{const r=document.querySelector('#paint').getBoundingClientRect();return {kind:'point',...board.getContext(),rect:{x:r.left+scrollX+20,y:r.top+scrollY+20,width:0,height:0},viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY}}})()");
  const markerQuestion = { id: 'spatial-question', kind: 'fork', text: 'Explain the painted area', status: 'sending', anchor: markerAnchor, resultReferences: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  await frame("document.querySelector('#field').value='marker update preserves draft'");
  const markerTicks = await frame('ticks');
  const beforeMarkerReady = await evaluate('results.ready');
  await update(`{interactions:[${JSON.stringify(markerQuestion)}]}`);
  await untilFrame("document.querySelector('[data-board-markers]')?.shadowRoot.querySelector('[data-board-interaction=spatial-question]')?.dataset.status==='sending'");
  assert.equal(await frame("getComputedStyle(document.querySelector('[data-board-markers]').shadowRoot.querySelector('button'),'::before').animationName"), 'board-halo');
  // The opaque sandbox can live in a separate renderer; emulate its media preference on
  // that target as well as the host, rather than assuming a top-page override propagates.
  const mediaSessions = [sessionId];
  for (const target of (await send('Target.getTargets')).targetInfos.filter(target=>target.type==='iframe')) {
    mediaSessions.push((await send('Target.attachToTarget', {targetId:target.targetId,flatten:true})).sessionId);
  }
  await Promise.all(mediaSessions.map(id=>send('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] }, id)));
  await untilFrame("matchMedia('(prefers-reduced-motion: reduce)').matches");
  assert.equal(await frame("getComputedStyle(document.querySelector('[data-board-markers]').shadowRoot.querySelector('button'),'::before').animationName"), 'none');
  await Promise.all(mediaSessions.map(id=>send('Emulation.setEmulatedMedia', { features: [] }, id)));
  await untilFrame("!matchMedia('(prefers-reduced-motion: reduce)').matches");
  assert.equal(await frame("document.querySelector('#field').value"), 'marker update preserves draft');
  assert.equal(await evaluate('results.ready'), beforeMarkerReady);
  await untilFrame(`ticks > ${markerTicks}`);
  const markerBounds = await location('[data-board-interaction=spatial-question]');
  assert.equal(markerBounds.width, 26); assert.equal(markerBounds.height, 26);
  assert.deepEqual(await frame("(()=>{const button=document.querySelector('[data-board-markers]').shadowRoot.querySelector('button');const face=button.querySelector('.face').getBoundingClientRect();return{width:face.width,height:face.height,opacity:getComputedStyle(button).opacity}})()"), {width:18,height:18,opacity:'0.5'});
  assert.equal(markerBounds.x, markerAnchor.rect.x);
  assert.equal(markerBounds.y, markerAnchor.rect.y);
  const markerPointerCount = await evaluate('results.canvasPointers');
  await click('[data-board-interaction=spatial-question]');
  await until('results.openedInteractions.length===1');
  await untilFrame("getComputedStyle(document.querySelector('[data-board-markers]').shadowRoot.querySelector('button')).opacity==='1'");
  assert.equal(await evaluate('results.canvasPointers'), markerPointerCount);
  assert.deepEqual(await evaluate('results.openedInteractions[0]'), { id: 'spatial-question', position: { x: markerAnchor.rect.x, y: markerAnchor.rect.y } });
  await frame("document.querySelector('[data-board-markers]').shadowRoot.querySelector('button').click()");
  await settleFrame();
  assert.equal(await evaluate('results.openedInteractions.length'), 1);
  const rootStatus = await evaluate('hostProps.interactions[0]');
  const markerFollowup = { ...rootStatus, id: 'spatial-reply', kind: 'reply', sourceInteractionId: 'spatial-question', status: 'processing', createdAt: '2026-01-01T00:01:00Z' };
  await update(`{interactions:[{...hostProps.interactions[0],status:'answered'},${JSON.stringify(markerFollowup)}]}`);
  await untilFrame("document.querySelector('[data-board-markers]').shadowRoot.querySelector('button').dataset.status==='processing'");
  assert.equal(await frame("document.querySelector('[data-board-markers]').shadowRoot.querySelectorAll('button').length"), 1);
  check('optimistic spatial markers appear immediately without rebuilding controls; trusted clicks open the root thread and follow-ups reuse its marker');

  await frame("document.body.style.minHeight='1600px';window.scrollTo(0,130)");
  await untilFrame('scrollY===130');
  await until(`results.interactionPositions.some(p=>p.id==='spatial-question'&&p.position.y===${markerAnchor.rect.y - 130})`);
  assert.equal((await location('[data-board-interaction=spatial-question]')).y, markerAnchor.rect.y - 130);
  await update('{selectedInteractionId:undefined}');
  await settleFrame();
  const closedPositionCount = await evaluate('results.interactionPositions.length');
  await update("{selectedInteractionId:'spatial-question'}");
  await until(`results.interactionPositions.length===${closedPositionCount + 1}`);
  assert.equal(await evaluate('results.interactionPositions.at(-1).position.y'), markerAnchor.rect.y - 130);
  await update("{interactions:hostProps.interactions.map(i=>({...i,status:'answered'})),boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1}} ");
  await untilFrame("document.querySelector('[data-board-markers]').shadowRoot.querySelector('button').dataset.stale==='true'");
  assert.ok((await frame("document.querySelector('[data-board-markers]').shadowRoot.querySelector('button').getAttribute('aria-label')")).includes('旧版本位置'));
  assert.equal((await location('[data-board-interaction=spatial-question]')).y, markerAnchor.rect.y - 130);
  await evaluate('reconnect()');
  await until(`results.ready===${beforeMarkerReady + 1}`);
  await untilFrame("document.querySelector('[data-board-markers]')?.shadowRoot.querySelector('button')?.dataset.status==='answered'");
  assert.equal(await frame("getComputedStyle(document.querySelector('[data-board-markers]').shadowRoot.querySelector('button'),'::before').animationName"), 'none');
  assert.equal(await frame("document.querySelector('[data-board-markers]').shadowRoot.querySelectorAll('button').length"), 1);
  assert.equal(await frame("document.querySelector('[data-board-markers]').shadowRoot.querySelector('button').dataset.stale"), 'true');
  check('markers follow document scrolling, completed replies survive remount, and changed canvas revisions explicitly retain the old location');

  const securityOpens = await evaluate('results.openedInteractions.length');
  const securityPositions = await evaluate('results.interactionPositions.length');
  await evaluate("(()=>{const s=results.raw.filter(m=>m.type==='ready').at(-1);window.dispatchEvent(new MessageEvent('message',{source:window,data:{...s,type:'open-interaction',id:'spatial-question',position:{x:1,y:2}}}));document.querySelector('iframe').contentWindow.postMessage({...s,boardId:'other-board',type:'interactions',markers:[]},'*')})()");
  await frame("(()=>{const s=board.getContext();parent.postMessage({channel:'paseo-board-frame-v1',boardId:s.boardId,sessionId:'wrong-session',type:'open-interaction',id:'spatial-question',position:{x:1,y:2}},'*')})()");
  await evaluate("(()=>{const s=results.raw.filter(m=>m.type==='ready').at(-1);fixtureCall(`parent.postMessage(${JSON.stringify({...s,type:'interaction-position',id:'not-selected',position:{x:1,y:2}})},'*')`)})()");
  await settleFrame();
  assert.equal(await evaluate('results.openedInteractions.length'), securityOpens);
  assert.equal(await evaluate('results.interactionPositions.length'), securityPositions);
  assert.equal(await frame("document.querySelector('[data-board-markers]').shadowRoot.querySelectorAll('button').length"), 1);
  const screenshotPaint = await location('#paint');
  await composeAfter(() => drag({ x: screenshotPaint.x + 5, y: screenshotPaint.y + 5 }, { x: screenshotPaint.x + 145, y: screenshotPaint.y + 70 }, 1));
  const screenshotAnchor = await evaluate('results.anchors.at(-1)');
  const markerPixel = await frame(`new Promise(resolve=>{const img=new Image();img.onload=()=>{const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);resolve([...ctx.getImageData(25,25,1,1).data])};img.src='data:image/png;base64,${screenshotAnchor.image.data}'})`);
  assert.deepEqual(markerPixel, [0,0,0,255]);
  await key('Escape');
  await noMenu();
  await click('#increment');
  assert.equal(await frame('count'), 1);
  check('markers stay out of reference screenshots, reject forged scope and synthetic clicks, and leave canvas controls usable');

  const outsidePointers = await evaluate('results.canvasPointers');
  const outsideControlCount = await frame('count');
  await click('#increment');
  await until(`results.canvasPointers===${outsidePointers+1}`);
  assert.equal(await frame('count'), outsideControlCount+1);
  await frame("document.querySelector('#target').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:32}))");
  await settleFrame();
  assert.equal(await evaluate('results.canvasPointers'),outsidePointers+1);
  await frame('new Promise(resolve=>{const check=()=>navigator.userActivation.isActive?setTimeout(check,20):resolve();check()})');
  await evaluate("(()=>{const scope=results.raw.filter(m=>m.type==='ready').at(-1);fixtureCall(`parent.postMessage(${JSON.stringify({...scope,type:'canvas-pointer'})},'*')`)})()");
  await settleFrame();
  assert.equal(await evaluate('results.canvasPointers'),outsidePointers+1);
  check('trusted canvas pointer events can dismiss host input without blocking controls; markers, synthetic pointers and idle bridge messages cannot dismiss it');

  await composeAfter(() => rightClick('#target'));
  const composePosition = await evaluate('results.composes.at(-1).position');
  assert.ok(composePosition.x > 0 && composePosition.y > 0 && composePosition.y < 700);
  const canvasGeometry = await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
  await evaluate("showInput('在鼠标旁输入')");
  await until("document.activeElement?.dataset.testid==='board-message-input'");
  assert.deepEqual(await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()"), canvasGeometry);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8, text: '\r' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await evaluate('results.inputSubmits.length'), 0);
  assert.ok((await evaluate("document.querySelector('[data-testid=board-message-input]').value")).includes('\n'));
  await evaluate("(()=>{const input=document.querySelector('[data-testid=board-message-input]');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'}));input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',code:'Enter',keyCode:229,isComposing:true}));input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',code:'Enter',keyCode:13}));window.compositionTestEnded=Date.now()})()");
  assert.equal(await evaluate('results.inputSubmits.length'), 0);
  await until('Date.now()-window.compositionTestEnded>60');
  await key('Enter');
  await until('results.inputSubmits.length===1');
  await key('Escape');
  await until('results.inputCloses===1');
  check('context actions provide pointer-local composer coordinates; inline input preserves canvas geometry and supports Enter, Shift+Enter and IME confirmation');

  // New anchors carry optional DOM identity; all references below come from trusted real
  // pointer gestures. The authored markup remains arbitrary HTML, with no component schema.
  await update("{interactions:[],selectedInteractionId:undefined}");
  await frame("getSelection().removeAllRanges();document.body.style.minHeight='0px';window.scrollTo(0,0)");
  const componentHtml = `<section id="component-fixture" style="padding:20px;margin-top:30px;border:1px solid #aaa"><details id="fold-component" open><summary id="fold-summary">Collapsible component</summary><p id="bound-content" style="margin:20px 0;padding:12px;min-height:40px">The component reference stays with this content.</p></details><section id="noid-parent"><p style="padding:12px">Original paragraph without an ID.</p></section><div id="region-parent" style="display:flex;padding:12px;gap:10px"><div id="region-left" style="width:100px;height:60px">Left</div><div id="region-right" style="width:100px;height:60px">Right</div></div><button id="authored-anchor">Ask using an authored anchor</button><script>document.querySelector('#authored-anchor').onclick=()=>{const r=document.querySelector('#bound-content').getBoundingClientRect();const c=board.getContext();board.ask({prompt:'Authored element question',anchor:{kind:'element',boardRevision:c.boardRevision,canvasRevision:c.canvasRevision,selector:'#bound-content',rect:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}}})}</script></section>`;
  const componentPatch = { id:'component-fixture', selector:'body', operation:'append', html:componentHtml };
  await update(`{boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[...hostProps.canvas.patches,${JSON.stringify(componentPatch)}]}}`);
  await untilFrame("Boolean(document.querySelector('#bound-content'))");
  await frame("document.querySelector('#bound-content').scrollIntoView({block:'center'})");
  const componentCompose = await composeAfter(() => rightClick('#bound-content'));
  const componentAnchor = componentCompose.anchor;
  assert.equal(componentAnchor.binding.target.id, 'bound-content');
  assert.equal(componentAnchor.binding.documentVersion, await frame('board.getContext().documentVersion'));
  assert.ok(componentAnchor.binding.ancestors.some(a=>a.id==='fold-component'));
  const interactionAt = (id, anchor) => ({id, kind:'question',text:id,status:'answered',anchor,resultReferences:[],createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'});
  const componentQuestion = interactionAt('component-question', componentAnchor);
  const marker = "document.querySelector('[data-board-markers]').shadowRoot.querySelector('[data-board-interaction=component-question]')";
  await update(`{interactions:[${JSON.stringify(componentQuestion)}],selectedInteractionId:'component-question'}`);
  await untilFrame(`${marker}?.dataset.location==='component'`);
  await frame("document.querySelector('#fold-component').open=false");
  await untilFrame(`${marker}.dataset.location==='collapsed'`);
  assert.deepEqual(await evaluate('hostProps.interactions[0].anchor'), componentAnchor);
  assert.ok(Math.abs((await location('[data-board-interaction=component-question]')).y-(await location('#fold-summary')).y)<30);
  const focusThread = async (id) => {
    const before = await evaluate('results.raw.filter(m=>m.type==="interaction-position").length');
    await evaluate(`(()=>{const scope=results.raw.filter(m=>m.type==='ready').at(-1);document.querySelector('iframe').contentWindow.postMessage({...scope,type:'focus-interaction',id:${JSON.stringify(id)}},'*')})()`);
    await until(`results.raw.filter(m=>m.type==='interaction-position').length>${before}`);
    return evaluate("results.raw.filter(m=>m.type==='interaction-position').at(-1)");
  };
  await focusThread('component-question');
  assert.equal(await frame("document.querySelector('#fold-component').open"),false);
  await frame("document.querySelector('#fold-component').open=true");
  await untilFrame(`${marker}.dataset.location==='component'`);
  await frame("(()=>{const content=document.querySelector('#bound-content');const wrapper=document.createElement('details');wrapper.id='new-wrapper';wrapper.innerHTML='<summary id=new-summary>New wrapper</summary>';content.before(wrapper);wrapper.append(content)})()");
  await untilFrame(`${marker}.dataset.location==='collapsed'`);
  assert.ok(Math.abs((await location('[data-board-interaction=component-question]')).y-(await location('#new-summary')).y)<30);
  assert.equal(await frame("document.querySelector('#new-wrapper').open"),false);
  check('component markers follow collapse, expand and a newly introduced details wrapper without mutating the original reference or opening authored controls');

  await frame("(()=>{const wrapper=document.querySelector('#new-wrapper');wrapper.open=true;const clip=document.createElement('div');clip.id='css-clip';clip.style.cssText='height:0;overflow:hidden';const content=document.querySelector('#bound-content');content.before(clip);clip.append(content)})()");
  await untilFrame(`${marker}.dataset.location==='collapsed'`);
  assert.ok(await frame("document.querySelector('#bound-content').getBoundingClientRect().height")>0);
  await frame("document.querySelector('#css-clip').style.height='120px'");
  await untilFrame(`${marker}.dataset.location==='component'`);
  await frame("(()=>{const style=document.createElement('style');style.textContent='#new-wrapper[data-layout=shifted]{transform:translateX(65px)}';document.head.append(style);document.querySelector('#new-wrapper').setAttribute('data-layout','shifted')})()");
  await untilFrame(`Math.abs(parseFloat(${marker}.style.left)-(document.querySelector('#bound-content').getBoundingClientRect().left+document.querySelector('#bound-content').getBoundingClientRect().width*${componentAnchor.binding.relative.x}))<1`);
  await frame("document.querySelector('#new-wrapper').style.display='none'");
  await untilFrame(`${marker}.dataset.location==='collapsed'`);
  await frame("document.querySelector('#new-wrapper').style.display='block';document.querySelector('#bound-content').style.transform='translateX(70px)'");
  await untilFrame(`${marker}.dataset.location==='component'&&Math.abs(parseFloat(${marker}.style.left)-(document.querySelector('#bound-content').getBoundingClientRect().left+document.querySelector('#bound-content').getBoundingClientRect().width*${componentAnchor.binding.relative.x}))<1`);
  const nestedState = await frame("(()=>{const scroller=document.createElement('div');scroller.id='nested-scroller';scroller.style.cssText='height:160px;overflow:auto';const top=document.createElement('div');top.style.height='500px';const bottom=top.cloneNode();const content=document.querySelector('#bound-content');document.querySelector('#component-fixture').append(scroller);scroller.append(top,content,bottom);scroller.scrollTop=400;scroller.scrollIntoView({block:'center'});return true})()");
  assert.equal(nestedState,true);
  await frame("document.querySelector('#nested-scroller').scrollTop=0");
  await untilFrame(`${marker}.dataset.location==='collapsed'`);
  const nestedPosition = await focusThread('component-question');
  await untilFrame(`${marker}.dataset.location==='component'`);
  assert.equal(await frame("document.querySelector('#new-wrapper').open"),true);
  assert.ok(nestedPosition.position.y>=0&&nestedPosition.position.y<700);
  await frame("document.querySelector('#nested-scroller').scrollTop+=25");
  await untilFrame(`Math.abs(parseFloat(${marker}.style.top)-(document.querySelector('#bound-content').getBoundingClientRect().top+document.querySelector('#bound-content').getBoundingClientRect().height*${componentAnchor.binding.relative.y}))<1`);
  await frame("(()=>{const target=document.querySelector('#bound-content');const native=target.getBoundingClientRect.bind(target);window.boundMeasures=0;target.getBoundingClientRect=()=>{window.boundMeasures++;return native()}})()");
  await frame('new Promise(resolve=>setTimeout(resolve,220))');
  const quietMeasures = await frame('boundMeasures');
  await frame('new Promise(resolve=>setTimeout(resolve,400))');
  assert.equal(await frame('boundMeasures'),quietMeasures);
  check('bound markers respect CSS accordion clipping, arbitrary layout attributes and nested scrolling; focus reveals scroll-clipped components and idle canvases do not scan');

  await update("{interactions:[],selectedInteractionId:undefined}");
  await frame("document.querySelector('#noid-parent > p').scrollIntoView({block:'center'})");
  const pathCompose = await composeAfter(()=>rightClick('#noid-parent > p'));
  assert.equal(pathCompose.anchor.binding.target.id, undefined);
  const pathQuestion = interactionAt('path-question',pathCompose.anchor);
  const pathMarker = "document.querySelector('[data-board-markers]').shadowRoot.querySelector('[data-board-interaction=path-question]')";
  await update(`{interactions:[${JSON.stringify(pathQuestion)}],selectedInteractionId:'path-question'}`);
  await untilFrame(`${pathMarker}?.dataset.location==='component'`);
  await frame("(()=>{window.originalParagraph=document.querySelector('#noid-parent > p');const other=document.createElement('p');other.style.cssText='height:100px';other.textContent='New preceding paragraph';originalParagraph.before(other)})()");
  await untilFrame(`Math.abs(parseFloat(${pathMarker}.style.top)-(originalParagraph.getBoundingClientRect().top+originalParagraph.getBoundingClientRect().height*${pathCompose.anchor.binding.relative.y}))<1`);
  await frame("originalParagraph.replaceWith(originalParagraph.cloneNode(true))");
  await untilFrame(`${pathMarker}.dataset.location==='ancestor'`);
  check('live non-ID nodes remain bound through nth-of-type reordering, while an identical replacement cannot inherit a removed node\'s identity');

  await update(`{interactions:[${JSON.stringify(componentQuestion)}],selectedInteractionId:'component-question'}`);
  const replacement = {id:'bound-content-updated',selector:'#bound-content',operation:'replace',html:'<p id="bound-content" style="height:70px">Updated component content under the same stable ID.</p>'};
  await update(`{boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[...hostProps.canvas.patches,${JSON.stringify(replacement)}]}}`);
  await untilFrame(`${marker}?.dataset.location==='component'&&${marker}.dataset.stale==='true'`);
  assert.ok((await frame(`${marker}.title`)).includes('引用仍为'));
  await frame("document.querySelector('#bound-content').after(document.querySelector('#bound-content').cloneNode(true))");
  await untilFrame(`${marker}.dataset.location==='ancestor'`);
  await frame("document.querySelectorAll('#bound-content')[1].remove()");
  await untilFrame(`${marker}.dataset.location==='component'`);
  await frame("document.querySelector('#component-fixture').remove()");
  await untilFrame(`${marker}.dataset.location==='snapshot'`);
  const missing = await focusThread('component-question');
  assert.ok(missing.position.x>=0&&missing.position.x<1100&&missing.position.y>=0&&missing.position.y<700);
  assert.deepEqual(await evaluate('hostProps.interactions[0].anchor'),componentAnchor);
  check('same-ID patches keep their component binding with a stale-reference label; duplicate IDs and deleted components fall back without guessing, and remain focusable');

  const componentReady=await evaluate('results.ready');
  await evaluate('reconnect()');
  await until(`results.ready===${componentReady+1}`);
  await untilFrame("Boolean(document.querySelector('#bound-content'))");
  await untilFrame(`${marker}?.dataset.location==='component'`);
  assert.equal(await frame(`${marker}.dataset.stale`),'true');
  await update(`{interactions:[${JSON.stringify(pathQuestion)}],selectedInteractionId:'path-question'}`);
  await untilFrame(`${pathMarker}?.dataset.location==='ancestor'`);
  await update(`{interactions:[${JSON.stringify({...componentQuestion,anchor:{...componentAnchor,binding:undefined}})}],selectedInteractionId:'component-question'}`);
  await untilFrame(`${marker}?.dataset.location==='snapshot'`);
  await frame("document.querySelector('#bound-content').style.marginTop='120px'");
  await settleFrame();
  assert.equal(await frame(`parseFloat(${marker}.style.top)+scrollY`),componentAnchor.rect.y);
  const contextBefore = await frame('board.getContext().documentVersion');
  await update(`{interactions:[${JSON.stringify(componentQuestion)}]}`);
  const replaceReady=await evaluate('results.ready');
  await evaluate('replaceDocument()');
  await until(`results.ready===${replaceReady+1}`);
  await untilFrame(`board.getContext().documentVersion===${contextBefore+1}`);
  await untilFrame(`${marker}?.dataset.location==='snapshot'`);
  check('cold restore verifies component identity; stale path-only and legacy references stay frozen, and a whole-document replacement cannot reuse an old binding');

  await update("{interactions:[],selectedInteractionId:undefined}");
  await update(`{boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[${JSON.stringify({...componentPatch,id:'component-fixture-again'})}]}}`);
  await untilFrame("Boolean(document.querySelector('#region-left'))");
  await frame("document.querySelector('#region-parent').scrollIntoView({block:'center'})");
  const regionStart=await location('#region-left');const regionEnd=await location('#region-right');
  const multiCompose=await composeAfter(()=>drag({x:regionStart.x+4,y:regionStart.y+4},{x:regionEnd.x+90,y:regionEnd.y+50},1));
  assert.equal(multiCompose.anchor.binding.target.id,'region-parent');
  await frame('getSelection().removeAllRanges()');
  await frame("document.querySelector('#authored-anchor').scrollIntoView({block:'center'})");
  const authoredAskCount=await evaluate('results.asks.length');
  await click('#authored-anchor');
  await until(`results.asks.length===${authoredAskCount+1}`);
  assert.equal(await evaluate('results.asks.at(-1).anchor.binding.target.id'),'bound-content');
  check('multi-component region selections bind only their containing context, and trusted board.ask anchors capture the same optional identity metadata');

  const focusAnchor=await evaluate('results.asks.at(-1).anchor');
  const focusQuestion=interactionAt('deferred-focus',focusAnchor);
  await update(`{interactions:[${JSON.stringify(focusQuestion)}],selectedInteractionId:'deferred-focus'}`);
  await untilFrame("document.querySelector('[data-board-markers]').shadowRoot.querySelector('button')?.getAttribute('aria-pressed')==='true'");
  await key('Escape');
  await frame("document.querySelector('#bound-content').scrollIntoView({block:'center'});pauseNextCapture()");
  const cancelComposeCount=await evaluate('results.composes.length');
  await rightClick('#bound-content');
  await untilFrame('Boolean(captureGate?.held)');
  const positionsBeforeCancel=await evaluate("results.raw.filter(m=>m.type==='interaction-position'&&m.id==='deferred-focus').length");
  await evaluate("(()=>{const scope=results.raw.filter(m=>m.type==='ready').at(-1);document.querySelector('iframe').contentWindow.postMessage({...scope,type:'focus-interaction',id:'deferred-focus'},'*')})()");
  await update('{selectedInteractionId:undefined}');
  await untilFrame("document.querySelector('[data-board-markers]').shadowRoot.querySelector('button')?.getAttribute('aria-pressed')==='false'");
  await frame('releaseCapture()');
  await until(`results.composes.length===${cancelComposeCount+1}`);
  await settleFrame();
  assert.equal(await evaluate("results.raw.filter(m=>m.type==='interaction-position'&&m.id==='deferred-focus').length"),positionsBeforeCancel);
  assert.equal(await frame("document.querySelector('[data-board-markers]').shadowRoot.querySelector('button').getAttribute('aria-pressed')"),'false');
  check('clearing the selected discussion cancels a focus deferred by screenshot capture, so its late completion cannot scroll or reopen the old thread');

  await key('Escape');
  await update('{interactions:[],selectedInteractionId:undefined}');
  const themeReady = await evaluate('results.ready');
  const themeTicks = await frame('window.ticks');
  await frame(`(()=>{
    document.querySelector('#field').value='theme preserves input';
    const style=document.createElement('style');style.id='fixed-theme-style';
    style.textContent=':root{--foreground:#172033;--background:#ffffff;color:#172033;color-scheme:light} body{background:#ffffff} #fixed-theme button,#fixed-theme input{color:inherit;background:#ffffff} #fixed-dark{color:#f4f6fa;background:#121821;color-scheme:dark} #fixed-dark button,#fixed-dark input{color:inherit;background:#121821}';
    document.head.append(style);
    const section=document.createElement('section');section.id='fixed-theme';
    section.innerHTML='<h1 id="fixed-title">Fixed light canvas</h1><p id="fixed-copy">Readable body text</p><button class="btn btn-primary" id="fixed-button">Authored button</button><input id="fixed-input" value="Light input"><article id="fixed-dark"><h2 id="dark-title">Fixed dark component</h2><button id="dark-button">Dark button</button><input id="dark-input" value="Dark input"></article>';
    document.body.prepend(section);
  })()`);
  for (const scheme of ['dark','light','dark']) {
    await evaluate(`setTheme(${JSON.stringify(scheme)})`);
    await untilFrame(`document.documentElement.dataset.theme===${JSON.stringify(scheme)}`);
    const colors=await frame(`(()=>{const get=id=>{const s=getComputedStyle(document.getElementById(id));return {color:s.color,background:s.backgroundColor,scheme:s.colorScheme}};return {body:getComputedStyle(document.body).color,rootScheme:getComputedStyle(document.documentElement).colorScheme,light:['fixed-title','fixed-copy','fixed-button','fixed-input'].map(get),dark:['dark-title','dark-button','dark-input'].map(get)}})()`);
    assert.equal(colors.body,'rgb(23, 32, 51)');
    assert.equal(colors.rootScheme,'light');
    assert.ok(colors.light.every(c=>c.color==='rgb(23, 32, 51)'&&c.scheme==='light'));
    assert.ok(colors.dark.every(c=>c.color==='rgb(244, 246, 250)'&&c.scheme==='dark'));
    assert.equal(colors.light[2].background,'rgb(255, 255, 255)');
    assert.equal(colors.dark[1].background,'rgb(18, 24, 33)');
  }
  assert.equal(await evaluate('results.ready'),themeReady);
  assert.equal(await frame("document.querySelector('#field').value"),'theme preserves input');
  assert.ok(await frame('window.ticks')>themeTicks);
  check('authored fixed light and dark colors, inherited headings/body, controls and color-scheme survive repeated host theme changes without rebuilding the canvas');
  await frame("document.querySelector('#fixed-theme-style').remove();document.querySelector('#fixed-theme').remove()");
  for (const scheme of ['light','dark']) {
    await evaluate(`setTheme(${JSON.stringify(scheme)})`);
    await untilFrame(`document.documentElement.dataset.theme===${JSON.stringify(scheme)}`);
    assert.equal(await frame('getComputedStyle(document.body).color'),await frame("getComputedStyle(document.documentElement).getPropertyValue('--host-ink').trim() === '' ? '' : (()=>{const node=document.createElement('span');node.style.color='var(--host-ink)';document.body.append(node);const color=getComputedStyle(node).color;node.remove();return color})()"));
    assert.equal(await frame('getComputedStyle(document.documentElement).colorScheme'),scheme);
  }
  check('unstyled canvases still inherit the host palette after fixed author styles are removed');

  // Explicit update records are the only source of spatial navigation. These messages
  // exercise the real sandbox runtime; the host navigation/ack policy has its own tests.
  const sendFrame = (fields) => evaluate(`(()=>{const scope=results.raw.filter(m=>m.type==='ready').at(-1);document.querySelector('iframe').contentWindow.postMessage({...scope,...${JSON.stringify(fields)}},'*')})()`);
  let updateToken = 0;
  const focusChange = async (record, options={}) => {
    const token=++updateToken, requestId=`focus-test-${token}`;
    await sendFrame({type:'focus-update',requestId,update:record,token,targetIndex:0,...options});
    await until(`results.raw.some(m=>m.type==='update-position'&&m.requestId===${JSON.stringify(requestId)})`);
    return evaluate(`results.raw.find(m=>m.type==='update-position'&&m.requestId===${JSON.stringify(requestId)})`);
  };
  const updateRecord = async (id,targets=[],kind='data') => ({id,eventId:id,at:new Date().toISOString(),...(await frame('({boardRevision:board.getContext().boardRevision,canvasRevision:board.getContext().canvasRevision,documentVersion:board.getContext().documentVersion})')),kind,targets});
  const publishFocusPatch = async (patch) => {
    await update(`{boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[...hostProps.canvas.patches,${JSON.stringify(patch)}]}}`);
    await untilFrame(`board.getContext().canvasRevision===${await evaluate('hostProps.canvas.revision')}`);
    await settleFrame();
    return updateRecord(patch.id,[{selector:patch.selector,operation:patch.operation,patchId:patch.id}],'patch');
  };
  await publishFocusPatch({id:'update-focus-fixture',selector:'body',operation:'append',html:`<section id="update-area" style="margin-top:1200px;padding:16px"><div id="update-scroll" style="width:480px;height:230px;overflow:auto;border:2px solid #444"><div id="update-inner" style="width:1800px;height:1100px;position:relative"><article id="update-far" style="position:absolute;left:1400px;top:750px;width:200px;height:90px;background:#ddeeff;color:#123">Far update</article></div></div><details id="update-details"><summary>Collapsed result</summary><p id="update-folded">Hidden result</p></details><section id="update-delete-parent" style="padding:24px;border:1px solid #777"><p id="update-delete">Remove me</p></section><section id="update-path-parent"><p>Anonymous target</p></section></section>`});
  const focusReady=await evaluate('results.ready');
  const focusTicks=await frame('window.ticks');
  const farUpdate=await updateRecord('update-data-far',[{selector:'#update-far'}]);
  await frame("document.querySelector('#field').value='draft survives navigation';document.activeElement?.blur();scrollTo(0,0)");
  const farStyle=await frame("document.querySelector('#update-far').getAttribute('style')");
  assert.equal((await focusChange(farUpdate)).status,'focused');
  const spatial=await frame("(()=>{const target=document.querySelector('#update-far').getBoundingClientRect(),pane=document.querySelector('#update-scroll'),box=pane.getBoundingClientRect();return {x:pane.scrollLeft,y:pane.scrollTop,top:target.top,bottom:target.bottom,left:target.left,right:target.right,pane:{top:box.top,bottom:box.bottom,left:box.left,right:box.right},height:innerHeight}})()");
  assert.ok(spatial.x>1000&&spatial.y>500);
  assert.ok(spatial.top>=spatial.pane.top&&spatial.bottom<=spatial.pane.bottom&&spatial.left>=spatial.pane.left&&spatial.right<=spatial.pane.right);
  assert.ok(spatial.top>=0&&spatial.bottom<=spatial.height);
  assert.equal(await frame("getComputedStyle(document.querySelector('[data-board-update-highlight]').shadowRoot.querySelector('.ring')).animationIterationCount"),'3');
  assert.equal(await frame("document.querySelector('#update-far').getAttribute('style')"),farStyle);
  await untilFrame("!document.querySelector('[data-board-update-highlight]')",5000);
  assert.equal(await evaluate('results.ready'),focusReady);
  assert.equal(await frame("document.querySelector('#field').value"),'draft survives navigation');
  assert.ok(await frame('window.ticks')>focusTicks);
  check('explicit update focus scrolls nested horizontal and vertical containers, pulses exactly three times, cleans its overlay and preserves drafts, styles and the live iframe');

  const insertedUpdate=await publishFocusPatch({id:'update-inserted',selector:'#update-inner',operation:'append',html:'<p id="update-new" style="position:absolute;left:1200px;top:950px;width:180px;height:60px">New result</p>'});
  const insertedReply=await focusChange(insertedUpdate);
  assert.equal(insertedReply.location,'target');
  assert.ok(await frame("(()=>{const target=document.querySelector('#update-new').getBoundingClientRect(),ring=document.querySelector('[data-board-update-highlight]').getBoundingClientRect();return Math.abs(target.left-ring.left)<8&&Math.abs(target.top-ring.top)<8})()"));
  const foldedUpdate=await updateRecord('update-folded-result',[{selector:'#update-folded'}]);
  assert.equal((await focusChange(foldedUpdate)).location,'ancestor');
  assert.equal(await frame("document.querySelector('#update-details').open"),false);
  assert.ok(await frame("(()=>{const a=document.querySelector('#update-details summary').getBoundingClientRect(),b=document.querySelector('[data-board-update-highlight]').getBoundingClientRect();return Math.abs(a.top-b.top)<8})()"));
  const removalUpdate=await publishFocusPatch({id:'update-removed',selector:'#update-delete',operation:'remove'});
  await frame("(()=>{const n=document.createElement('p');n.id='update-delete';n.textContent='Unrelated replacement';document.body.prepend(n)})()");
  assert.equal((await focusChange(removalUpdate)).location,'ancestor');
  assert.ok(await frame("(()=>{const a=document.querySelector('#update-delete-parent').getBoundingClientRect(),b=document.querySelector('[data-board-update-highlight]').getBoundingClientRect();return Math.abs(a.top-b.top)<8})()"));
  await frame("document.querySelector('#update-delete-parent').remove()");
  assert.equal((await focusChange(removalUpdate)).status,'unavailable');
  check('append locates the actual inserted content; collapsed changes highlight their summary without opening; removal uses its captured parent and cannot follow a replacement selector');

  await publishFocusPatch({id:'hidden-tab-fixture',selector:'body',operation:'append',html:'<main id="hidden-tab-main" style="margin-top:1400px;padding:24px;min-height:320px"><h2>Visible dashboard shell</h2><section id="hidden-tab-content" style="display:none"><article id="hidden-data-target" style="width:200px;height:80px">Hidden data result</article><article id="hidden-patch-target" style="width:200px;height:80px">Hidden patch original</article></section></main>'});
  const hiddenDataUpdate=await updateRecord('hidden-tab-data',[{selector:'#hidden-data-target'}]);
  const hiddenPatchUpdate=await publishFocusPatch({id:'hidden-tab-patch',selector:'#hidden-patch-target',operation:'replace',html:'<article id="hidden-patch-target" style="width:200px;height:80px">Hidden patch result</article>'});
  for (const record of [hiddenDataUpdate,hiddenPatchUpdate]) {
    await frame('scrollTo(0,0)');
    const beforeHiddenFocus=await frame("({x:scrollX,y:scrollY,innerX:document.querySelector('#update-scroll').scrollLeft,innerY:document.querySelector('#update-scroll').scrollTop})");
    const unavailable=await focusChange(record);
    assert.equal(unavailable.status,'unavailable'); assert.equal(unavailable.location,undefined);
    assert.deepEqual(await frame("({x:scrollX,y:scrollY,innerX:document.querySelector('#update-scroll').scrollLeft,innerY:document.querySelector('#update-scroll').scrollTop})"),beforeHiddenFocus);
    assert.equal(await frame("Boolean(document.querySelector('[data-board-update-highlight]'))"),false);
    assert.equal(await frame("getComputedStyle(document.querySelector('#hidden-tab-content')).display"),'none');
  }
  await frame("document.querySelector('#hidden-tab-content').style.display='block'");
  for (const [record,selector] of [[hiddenDataUpdate,'#hidden-data-target'],[hiddenPatchUpdate,'#hidden-patch-target']]) {
    const available=await focusChange(record);
    assert.equal(available.status,'focused'); assert.equal(available.location,'target');
    const boxes=await frame(`(()=>{const target=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(),ring=document.querySelector('[data-board-update-highlight]').getBoundingClientRect();return {target:{left:target.left,top:target.top,width:target.width,height:target.height},ring:{left:ring.left,top:ring.top,width:ring.width,height:ring.height}}})()`);
    assert.ok(Math.abs(boxes.target.left-boxes.ring.left)<8&&Math.abs(boxes.target.top-boxes.ring.top)<8);
    assert.ok(Math.abs(boxes.target.width-boxes.ring.width)<8&&Math.abs(boxes.target.height-boxes.ring.height)<8);
  }
  assert.equal(await evaluate('results.ready'),focusReady);
  assert.equal(await frame("document.querySelector('#field').value"),'draft survives navigation');
  check('hidden tab data and patch targets stay unavailable without scrolling or highlighting their dashboard shell; showing the tab lets the same updates highlight only their exact targets');

  const pathUpdate=await updateRecord('update-path',[{selector:'#update-path-parent > p'}]);
  assert.equal((await focusChange(pathUpdate)).status,'focused');
  await frame("(()=>{const n=document.querySelector('#update-path-parent > p');n.replaceWith(n.cloneNode(true))})()");
  assert.equal((await focusChange(pathUpdate)).status,'unavailable');
  await frame("document.querySelector('#update-far').insertAdjacentHTML('afterend','<p id=update-far>Duplicate identity</p>')");
  assert.equal((await focusChange(farUpdate)).status,'unavailable');
  await frame("document.querySelectorAll('#update-far')[1].remove()");
  await publishFocusPatch({id:'update-stable-replacement',selector:'#update-far',operation:'replace',html:'<article id="update-far" style="position:absolute;left:1400px;top:750px;width:200px;height:90px">Same component, updated result</article>'});
  assert.equal((await focusChange(farUpdate)).status,'focused');
  const beforeStale=await frame('({x:scrollX,y:scrollY})');
  assert.equal((await focusChange({...farUpdate,documentVersion:farUpdate.documentVersion-1})).status,'unavailable');
  assert.deepEqual(await frame('({x:scrollX,y:scrollY})'),beforeStale);
  assert.equal((await focusChange(await updateRecord('update-unspecified'))).status,'unavailable');
  assert.equal((await focusChange({...removalUpdate,id:'update-cold-remove',targets:[{selector:'#update-delete',operation:'remove',patchId:'not-replayed'}]})).status,'unavailable');
  check('stable unique IDs survive local replacements, while removed anonymous nodes, duplicate identities, old documents and data without location never jump to guessed content');

  await frame("document.querySelector('#field').scrollIntoView({block:'center'})");
  await click('#field');
  const typingPosition=await frame('({x:scrollX,y:scrollY})');
  assert.equal((await focusChange(farUpdate,{automatic:true})).status,'deferred');
  assert.equal((await focusChange(farUpdate)).status,'deferred');
  assert.deepEqual(await frame('({x:scrollX,y:scrollY})'),typingPosition);
  assert.equal(await frame("document.querySelector('#field').value"),'draft survives navigation');
  await frame('document.activeElement.blur()');
  await until("results.raw.filter(m=>m.type==='canvas-activity').at(-1)?.busy===false",5000);
  await sendFrame({type:'host-activity',composing:true});
  assert.equal((await focusChange(farUpdate,{automatic:true})).status,'deferred');
  await sendFrame({type:'host-activity',composing:false});
  await until("results.raw.filter(m=>m.type==='canvas-activity').at(-1)?.busy===false");
  await frame("document.querySelector('#words').scrollIntoView({block:'center'});pauseNextCapture()");
  await rightClick('#words');
  await untilFrame('Boolean(captureGate?.held)');
  const capturePosition=await frame('({x:scrollX,y:scrollY})');
  assert.equal((await focusChange(farUpdate,{automatic:true})).status,'deferred');
  assert.deepEqual(await frame('({x:scrollX,y:scrollY})'),capturePosition);
  await key('Escape');await frame('releaseCapture()');
  await until("results.raw.filter(m=>m.type==='canvas-activity').at(-1)?.busy===false",5000);
  assert.deepEqual(await frame('({x:scrollX,y:scrollY})'),capturePosition);
  assert.equal((await focusChange(farUpdate,{automatic:true})).status,'focused');
  check('typing, host composition and a held screenshot defer update focus; activity releases without polling and no deferred request secretly scrolls later');

  const frameTarget=(await command('Target.getTargets')).targetInfos.find(t=>t.type==='iframe');
  const motionSession=(await command('Target.attachToTarget',{targetId:frameTarget.targetId,flatten:true})).sessionId;
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},motionSession);
  await untilFrame("matchMedia('(prefers-reduced-motion: reduce)').matches");
  assert.equal((await focusChange(farUpdate)).status,'focused');
  assert.equal(await frame("getComputedStyle(document.querySelector('[data-board-update-highlight]').shadowRoot.querySelector('.ring')).animationName"),'none');
  await untilFrame("!document.querySelector('[data-board-update-highlight]')",4000);
  await send('Emulation.setEmulatedMedia',{features:[]},motionSession);
  await untilFrame("!matchMedia('(prefers-reduced-motion: reduce)').matches");
  const wholeUpdate=await updateRecord('update-document',[],'document');
  assert.equal((await focusChange(wholeUpdate)).location,'document');
  assert.equal(await frame('scrollY'),0);
  await untilFrame("!document.querySelector('[data-board-update-highlight]')",5000);
  check('reduced-motion updates use a short static ring; explicit document replacement can indicate the whole canvas, with all highlight timers ending');

  // Use the production disk-backed store and authored-source replay in Node. Only
  // snapshots actually accepted by that store are handed to the real CanvasFrame.
  const storeBundle = await build({ stdin: { contents: 'export { BoardStore } from "./server/store"; export { describeAuthoring } from "./server/authored-source";', resolveDir: join(directory, '..'), sourcefile: 'concurrent-browser-store.ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, external: ['canvas'] });
  const storeModule = join(profile, 'concurrent-store.cjs');
  await writeFile(storeModule, storeBundle.outputFiles[0].text);
  const { BoardStore, describeAuthoring } = createRequire(import.meta.url)(storeModule);
  const concurrentStore = new BoardStore(join(profile, 'concurrent-board-data')); await concurrentStore.init();
  const concurrentHtml = await evaluate('hostProps.canvas.html') + '<section id="shared-regions"><article id="shared-left">Left original</article><article id="shared-right">Right original</article></section>';
  await concurrentStore.create({ id: 'concurrent-browser', title: 'Real store concurrency', ownerAgentId: 'writer-a', html: concurrentHtml, data: { n: 0 } });
  await concurrentStore.addInteraction({ boardId: 'concurrent-browser', intentId: 'writer-b-shared-edit', kind: 'fork', text: 'Edit the other region on this shared Board' }, 'writer-b');
  const originalConcurrent = await concurrentStore.read('concurrent-browser');
  assert.ok(originalConcurrent.interactions.some(interaction => interaction.kind === 'fork' && interaction.agentId === 'writer-b'));
  const storedProps = (stored) => ({ boardId: stored.id, boardRevision: stored.revision, canvas: stored.canvas, interactions: [], selectionMode: 'off', selectedInteractionId: null });
  const displayStored = async (stored) => {
    await update(JSON.stringify(storedProps(stored)));
    await untilFrame(`board.getContext().boardId==='concurrent-browser' && board.getContext().canvasRevision===${stored.canvas.revision}`);
  };
  const initialReady = await evaluate('results.ready');
  await update(JSON.stringify(storedProps(originalConcurrent))); await until(`results.ready===${initialReady + 1}`);
  await frame("document.querySelector('#field').value='draft during concurrent editing';window.concurrentSentinel={value:'same heap'};window.concurrentReference=window.concurrentSentinel;document.querySelector('#increment').click();document.querySelector('#increment').click()");
  await evaluate('window.concurrentFrame=document.querySelector("iframe");window.concurrentWindow=window.concurrentFrame.contentWindow');
  const concurrentReady = await evaluate('results.ready'); const concurrentTicks = await frame('window.ticks');
  const frozenBase = describeAuthoring(originalConcurrent.canvas).canvasBase;
  const firstWrite = { boardId: originalConcurrent.id, expectedRevision: originalConcurrent.revision, canvasBase: frozenBase, eventId: 'writer-a-first', patch: { id: 'writer-a-first', selector: '#shared-left', operation: 'replace', html: '<article id="shared-left">Writer A preserved</article><script>window.firstWriterRuns=(window.firstWriterRuns||0)+1</script>' } };
  const secondWrite = { boardId: originalConcurrent.id, expectedRevision: originalConcurrent.revision, canvasBase: frozenBase, eventId: 'writer-b-stale', patch: { id: 'writer-b-stale', selector: '#shared-right', operation: 'replace', html: '<article id="shared-right">Writer B from old snapshot</article>' } };
  const simultaneous = await Promise.allSettled([concurrentStore.publish(firstWrite, 'writer-a'), concurrentStore.publish(secondWrite, 'writer-b')]);
  assert.equal(simultaneous[0].status, 'fulfilled');
  assert.equal(simultaneous[1].status, 'rejected'); assert.equal(simultaneous[1].reason.code, 'revision_conflict');
  const afterConcurrent = await concurrentStore.read(originalConcurrent.id);
  await displayStored(afterConcurrent); await untilFrame("document.querySelector('#shared-left').textContent==='Writer A preserved' && window.firstWriterRuns===1");
  assert.equal(await frame("document.querySelector('#shared-right').textContent"), 'Right original');
  await assert.rejects(concurrentStore.publish({ ...secondWrite, expectedRevision: afterConcurrent.revision, eventId: 'writer-b-new-board-old-canvas' }, 'writer-b'), error => error.code === 'revision_conflict');
  await assert.rejects(concurrentStore.publish({ boardId: originalConcurrent.id, expectedRevision: afterConcurrent.revision, canvasBase: frozenBase, eventId: 'stale-parent', patch: { id: 'stale-parent', selector: '#shared-regions', operation: 'replace', html: '<section id="shared-regions"><article id="shared-left">Left original</article><article id="shared-right">Old parent copy</article></section>' } }, 'writer-b'), error => error.code === 'revision_conflict');
  const rejectedSnapshot = await concurrentStore.read(originalConcurrent.id);
  assert.deepEqual(rejectedSnapshot, afterConcurrent); await displayStored(rejectedSnapshot);
  assert.equal(await frame("document.querySelector('#shared-left').textContent"), 'Writer A preserved');
  const currentAuthoring = describeAuthoring(rejectedSnapshot.canvas, '#shared-right');
  assert.equal(currentAuthoring.replay.complete, true);
  assert.ok(currentAuthoring.materializedAuthoredHtml.includes('Writer A preserved'));
  const mergedHtml = currentAuthoring.target.html.replace('Right original', 'Writer B merged');
  assert.notEqual(mergedHtml, currentAuthoring.target.html);
  const mergedSnapshot = await concurrentStore.publish({ boardId: originalConcurrent.id, expectedRevision: rejectedSnapshot.revision, canvasBase: currentAuthoring.canvasBase, eventId: 'writer-b-merged', patch: { id: 'writer-b-merged', selector: currentAuthoring.target.selector, operation: 'replace', html: mergedHtml } }, 'writer-b');
  await displayStored(mergedSnapshot); await untilFrame("document.querySelector('#shared-right').textContent==='Writer B merged'");
  assert.equal(await frame("document.querySelector('#shared-left').textContent"), 'Writer A preserved');
  assert.equal(await frame("document.querySelector('#field').value"), 'draft during concurrent editing');
  assert.equal(await frame('window.count'), 2); assert.equal(await frame("document.querySelector('#count').textContent"), '2');
  assert.equal(await frame('window.concurrentSentinel===window.concurrentReference && window.concurrentSentinel.value==="same heap"'), true);
  assert.equal(await frame('window.firstWriterRuns'), 1); assert.ok(await frame('window.ticks') > concurrentTicks);
  assert.equal(await evaluate('results.ready'), concurrentReady);
  assert.equal(await evaluate('document.querySelector("iframe")===window.concurrentFrame && window.concurrentFrame.contentWindow===window.concurrentWindow'), true);
  assert.deepEqual(mergedSnapshot.canvas.patches.map(patch => patch.id), ['writer-a-first', 'writer-b-merged']);
  assert.deepEqual(mergedSnapshot.updates.map(change => ({ id: change.id, actor: change.actorAgentId })), [{ id: 'writer-a-first', actor: 'writer-a' }, { id: 'writer-b-merged', actor: 'writer-b' }]);
  check('real BoardStore rejects competing stale edits and parent replacement even with a fresh board revision; authored-source retry preserves both regions, typed input, counters, iframe identity and JS heap');

  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  const artifact = process.env.BOARD_TEST_SCREENSHOT;
  if (artifact) await writeFile(artifact, Buffer.from(screenshot.data, 'base64'));
  console.log(`Browser integration: ${passed} checks passed.`);
} catch (error) {
  console.error('Browser check failed:', error);
  console.error('Browser exceptions:', JSON.stringify(logs).slice(-5000));
  process.exitCode = 1;
} finally {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
  chrome.stdio[3].destroy(); chrome.stdio[4].destroy(); chrome.stderr.destroy();
  for (const entry of commands.values()) { clearTimeout(entry.timer); entry.reject(new Error('browser closed')); }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
