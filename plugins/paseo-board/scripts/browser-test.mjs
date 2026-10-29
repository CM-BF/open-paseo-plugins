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
    const box = await frame(`(()=>{const selector=${JSON.stringify(selector)};const element=document.querySelector('[data-board-menu]')?.shadowRoot?.querySelector(selector)||document.querySelector(selector);const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
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
  const menu = () => untilFrame("document.querySelector('[data-board-menu]')?.shadowRoot?.querySelector('[data-board-action=question]')?.disabled === false", 18000);
  const noMenu = () => untilFrame("!document.querySelector('[data-board-menu]')");
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
  await frame("new Promise(resolve=>{const t=()=>document.documentElement.dataset.boardSelection==='region'?resolve():setTimeout(t,10);t()})");
  await update('{boardRevision:5,canvas:{...hostProps.canvas,revision:5,data:{n:3}}}');
  assert.equal((await frame('board.getData()')).n, 2);
  const box = await location('#paint');
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + 5, y: box.y + 5, button: 'left', clickCount: 1 });
  await update('{canvas:{...hostProps.canvas,data:{n:3,midDrag:true}}}');
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 140, y: box.y + 70, button: 'left', buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 140, y: box.y + 70, button: 'left', clickCount: 1 });
  await until('results.anchors.length === 1', 18000);
  const anchor = await evaluate('results.anchors[0]');
  assert.equal(anchor.kind, 'region'); assert.equal(anchor.boardRevision, 4);
  assert.equal(anchor.canvasRevision, 4); assert.equal(anchor.rect.width, 135); assert.equal(anchor.rect.height, 65);
  assert.ok(anchor.image?.data.startsWith('iVBORw0KGgo'));
  const png = Buffer.from(anchor.image.data, 'base64');
  assert.equal(png.readUInt32BE(16), 135); assert.equal(png.readUInt32BE(20), 65);
  const pixel = await frame(`new Promise(resolve=>{const img=new Image();img.onload=()=>{const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);resolve([...ctx.getImageData(40,30,1,1).data])};img.src='data:image/png;base64,${anchor.image.data}'})`);
  assert.deepEqual(pixel, [0,0,0,255]);
  await writeFile(join(profile, 'region.png'), png);
  await key('Escape');
  await update("{selectionMode:'off'}");
  await frame("new Promise(resolve=>{if(board.getData().n===3)resolve();else board.onData(resolve)})");
  check('region capture emits a valid cropped PNG and a frozen version while newer data queues');

  await update("{selectionMode:'text'}");
  const words = await location('#words');
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: words.x + 1, y: words.y + 10, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: words.x + 190, y: words.y + 10, button: 'left', buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: words.x + 190, y: words.y + 10, button: 'left', clickCount: 1 });
  await until('results.anchors.length === 2', 18000);
  assert.equal(await evaluate('results.anchors[1].kind'), 'text');
  assert.ok((await evaluate('results.anchors[1].text')).includes('stable'));
  await key('Escape');
  await update("{selectionMode:'point'}");
  await clickPoint(900, 600);
  await until('results.anchors.length === 3', 18000);
  assert.equal(await evaluate('results.anchors[2].kind'), 'point');
  assert.equal(await evaluate('results.anchors[2].rect.width'), 0);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until("hostProps.selectionMode === 'off'");
  await click('#increment'); assert.equal(await frame('count'), 2);
  check('text, blank-space pointing and Escape work; normal controls recover after selection');

  await evaluate('reconnect()');
  await until('results.ready === 2');
  await frame("new Promise(resolve=>{const t=()=>window.replaced?resolve():setTimeout(t,10);t()})");
  assert.deepEqual(await frame('[window.patchRuns,window.prepended,window.replaced]'), [1,1,1]);
  assert.equal(await frame("document.querySelectorAll('#replacement').length"), 1);
  assert.deepEqual(await frame('window.restored'), {field:'keep typed input',count:1});
  check('reconnect reconstructs the document and replays the patch journal once with saved state available');
  const bad = { id: 'bad-script', selector: '#target', operation: 'append', html: '<script>window.badRuns=(window.badRuns||0)+1;throw new Error("fixture patch error")</script>' };
  await update(`{boardRevision:6,canvas:{...hostProps.canvas,revision:6,patches:[...hostProps.canvas.patches,${JSON.stringify(bad)}]}}`);
  await until("results.errors.some(e=>e.patchId === 'bad-script')");
  await update('{boardRevision:7,canvas:{...hostProps.canvas,revision:7,data:{n:4}}}');
  assert.equal(await frame('window.badRuns'), 1);
  check('partially failed patch reports its ID and is never executed twice');

  await update("{selectionMode:'point'}");
  await frame("new Promise(resolve=>{const t=()=>document.documentElement.dataset.boardSelection==='point'?resolve():setTimeout(t,10);t()})");
  await frame("board.saveState({field:'saved during refresh',count:8})");
  await update("{boardRevision:8,canvas:{...hostProps.canvas,patches:[],revision:8,documentVersion:2}}");
  assert.equal(await frame('board.getContext().documentVersion'), 1);
  assert.equal(await evaluate('results.ready'), 2);
  await update("{selectionMode:'off'}");
  await until('results.ready === 3');
  assert.deepEqual(await frame('board.getState()'), { field: 'saved during refresh', count: 8 });
  assert.equal(await frame('window.boots'), 1);
  assert.equal(await frame('window.patchRuns || 0'), 0);
  check('explicit document replacement restores saved state and clears the old patch journal');

  // Shortcut integration starts from the fresh document, with all original checks retained.
  const shortcutAsks = await evaluate('results.asks.length');
  let control = await location('#dragbox');
  await drag({ x: control.x + 20, y: control.y + 20 }, { x: control.x + 50, y: control.y + 35 });
  const movedControl = await location('#dragbox');
  assert.equal(movedControl.x, control.x + 30);
  assert.equal(movedControl.y, control.y + 15);
  const controlEvents = await frame('controlEvents');
  const altStart = { x: movedControl.x + 10, y: movedControl.y + 10 };
  const altEnd = { x: movedControl.x + 150, y: movedControl.y + 55 };
  await drag(altStart, altEnd, 1);
  await menu();
  assert.deepEqual(await location('#dragbox'), movedControl);
  assert.deepEqual(await frame('controlEvents'), controlEvents);
  const shortcutRegion = await evaluate('results.anchors.at(-1)');
  assert.equal(shortcutRegion.kind, 'region');
  assert.equal(shortcutRegion.rect.width, 140);
  assert.equal(shortcutRegion.rect.height, 45);
  assert.equal(await evaluate('hostProps.selectionMode'), 'off');
  await rightClickPoint(altStart.x + 30, altStart.y + 15);
  await menu();
  await click('[data-board-action="question"]');
  await until('results.composes.length === 1');
  assert.deepEqual(await evaluate('results.composes[0]'), { kind: 'question', anchor: shortcutRegion });
  assert.equal(await evaluate('results.asks.length'), shortcutAsks);
  await noMenu();
  check('ordinary control drags work; Alt/Option drag selects without moving the control and reuses the region for a question');

  const pointTarget = await location('#target');
  const point = { x: Math.round(pointTarget.x + 30), y: Math.round(pointTarget.y + 30) };
  await rightClickPoint(point.x, point.y);
  await menu();
  const pointAnchor = await evaluate('results.anchors.at(-1)');
  assert.equal(pointAnchor.kind, 'point');
  const frameOrigin = await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()");
  assert.deepEqual(pointAnchor.rect, { x: point.x - frameOrigin.x, y: point.y - frameOrigin.y, width: 0, height: 0 });
  assert.equal(pointAnchor.selector, '#target');
  await click('[data-board-action="change"]');
  await until('results.composes.length === 2');
  assert.deepEqual(await evaluate('results.composes[1]'), { kind: 'change', anchor: pointAnchor });
  assert.equal(await evaluate("Object.hasOwn(results.composes[1],'prompt')"), false);
  await noMenu();
  await rightClickPoint(point.x + 180, point.y + 20);
  await menu();
  await click('[data-board-action="fork"]');
  await until('results.composes.length === 3');
  assert.equal(await evaluate('results.composes[2].kind'), 'fork');
  assert.equal(await evaluate('results.composes[2].anchor.kind'), 'point');
  assert.equal(await evaluate('results.asks.length'), shortcutAsks);
  await noMenu();
  check('right-click in interaction mode anchors the clicked position; question/change/fork open native composition without sending a prompt');

  await frame('window.getSelection().removeAllRanges()');
  const selectedWords = await location('#words');
  await drag({ x: selectedWords.x + 1, y: selectedWords.y + 10 }, { x: selectedWords.x + 190, y: selectedWords.y + 10 });
  const nativeText = await frame('window.getSelection().toString()');
  assert.ok(nativeText.includes('stable'));
  await rightClickPoint(selectedWords.x + 80, selectedWords.y + 10);
  await menu();
  const textAnchor = await evaluate('results.anchors.at(-1)');
  assert.equal(textAnchor.kind, 'text');
  assert.equal(textAnchor.text, nativeText);
  await click('[data-board-action="question"]');
  await until('results.composes.length === 4');
  assert.deepEqual(await evaluate('results.composes[3].anchor'), textAnchor);
  await noMenu();
  check('right-click preserves native text selection and passes the selected text and snapshot to the composer');

  const cancellationCounts = await evaluate('({anchors:results.anchors.length,composes:results.composes.length,asks:results.asks.length})');
  await rightClickPoint(point.x, point.y);
  await menu();
  await frame("document.querySelector('[data-board-menu]').shadowRoot.querySelector('[data-board-action=question]').click()");
  await settleFrame();
  assert.equal(await evaluate('results.composes.length'), cancellationCounts.composes);
  await key('Escape');
  await noMenu();
  await rightClickPoint(point.x, point.y);
  await menu();
  const countBeforeDismiss = await frame('count');
  await click('#increment');
  await noMenu();
  assert.equal(await frame('count'), countBeforeDismiss);
  await click('#increment');
  assert.equal(await frame('count'), countBeforeDismiss + 1);
  assert.equal(await evaluate('results.composes.length'), cancellationCounts.composes);
  assert.equal(await evaluate('results.asks.length'), cancellationCounts.asks);
  check('Escape and outside clicks dismiss menus without activating underlying controls; synthetic menu clicks cannot compose');

  await frame('window.getSelection().removeAllRanges()');
  const nativeCounts = await evaluate('({anchors:results.anchors.length,composes:results.composes.length})');
  await rightClick('#target', 8);
  await settleFrame();
  assert.equal(await frame("Boolean(document.querySelector('[data-board-menu]'))"), false);
  await key('Escape');
  for (const selector of ['#field', '#textarea', '#editable-child']) {
    await rightClick(selector);
    await settleFrame();
    assert.equal(await frame("Boolean(document.querySelector('[data-board-menu]'))"), false, `${selector} must keep its native context menu`);
    assert.equal(await frame('controlEvents.contexts.at(-1).prevented'), false);
    await key('Escape');
  }
  const inputBox = await location('#field');
  await drag({ x: inputBox.x + 10, y: inputBox.y + 10 }, { x: inputBox.x + 90, y: inputBox.y + 10 }, 1);
  await settleFrame();
  assert.equal(await frame("Boolean(document.querySelector('[data-board-menu]'))"), false);
  assert.deepEqual(await evaluate('({anchors:results.anchors.length,composes:results.composes.length})'), nativeCounts);
  check('Shift+right-click and input/textarea/contenteditable context menus remain native; Alt dragging text input is not hijacked');

  await frame('window.getSelection().removeAllRanges();pauseNextCapture()');
  const slowCounts = await evaluate('({anchors:results.anchors.length,composes:results.composes.length})');
  const slowBox = await location('#paint');
  await drag({ x: slowBox.x + 5, y: slowBox.y + 5 }, { x: slowBox.x + 135, y: slowBox.y + 65 }, 1);
  await untilFrame('window.captureGate?.held === true');
  await key('Escape');
  await frame('releaseCapture()');
  await settleFrame();
  assert.deepEqual(await evaluate('({anchors:results.anchors.length,composes:results.composes.length})'), slowCounts);
  assert.equal(await frame("Boolean(document.querySelector('[data-board-menu]'))"), false);
  await click('#increment');
  assert.equal(await frame('count'), countBeforeDismiss + 2);
  check('Escape cancels a slow screenshot: its late completion cannot resurrect an anchor or menu, and controls recover');

  await frame('pauseNextCapture()');
  const frozenContext = await frame('board.getContext()');
  const frozenData = await frame('board.getData()');
  const frozenWords = await frame("document.querySelector('#words').textContent");
  await drag({ x: slowBox.x + 10, y: slowBox.y + 10 }, { x: slowBox.x + 140, y: slowBox.y + 70 }, 1);
  await untilFrame('window.captureGate?.held === true');
  const newerWords = 'New DOM text must not change an already selected snapshot.';
  const replacementPatch = { id: 'shortcut-replace-words', selector: '#words', operation: 'replace', html: `<div id="words">${newerWords}</div>` };
  await update(`{boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,data:{n:5,shortcut:true},patches:[${JSON.stringify(replacementPatch)}]}}`);
  await settleFrame();
  assert.deepEqual(await frame('board.getData()'), frozenData);
  assert.equal(await frame("document.querySelector('#words').textContent"), frozenWords);
  await frame('releaseCapture()');
  await menu();
  const frozenAnchor = await evaluate('results.anchors.at(-1)');
  assert.equal(frozenAnchor.boardRevision, frozenContext.boardRevision);
  assert.equal(frozenAnchor.canvasRevision, frozenContext.canvasRevision);
  await click('[data-board-action="change"]');
  await until('results.composes.length === 5');
  assert.deepEqual(await evaluate('results.composes[4].anchor'), frozenAnchor);
  await untilFrame('board.getData().shortcut === true');
  assert.equal(await frame("document.querySelector('#words').textContent"), newerWords);
  await rightClickPoint(slowBox.x + 30, slowBox.y + 30);
  await menu();
  const currentPoint = await evaluate('results.anchors.at(-1)');
  assert.equal(currentPoint.kind, 'point');
  assert.equal(currentPoint.boardRevision, frozenContext.boardRevision + 1);
  await key('Escape');
  await noMenu();
  check('slow selections freeze data, DOM patches and revision; composition keeps that snapshot and later right-clicks use the new document state');

  await frame('pauseNextCapture()');
  const beforeClear = await evaluate('({anchors:results.anchors.length,composes:results.composes.length})');
  await drag({ x: slowBox.x + 5, y: slowBox.y + 5 }, { x: slowBox.x + 130, y: slowBox.y + 60 }, 1);
  await untilFrame('window.captureGate?.held === true');
  await update('{selectionClearToken:1}');
  await settleFrame();
  await frame('releaseCapture()');
  await settleFrame();
  assert.deepEqual(await evaluate('({anchors:results.anchors.length,composes:results.composes.length})'), beforeClear);
  assert.equal(await frame("Boolean(document.querySelector('[data-board-menu]'))"), false);
  check('host clearing the reference cancels an in-flight capture; late pixels cannot attach to a cleared composer');

  const beforeDocument = await frame('board.getContext()');
  const readyBeforeDocument = await evaluate('results.ready');
  await rightClickPoint(point.x, point.y);
  await menu();
  const documentAnchor = await evaluate('results.anchors.at(-1)');
  await update('{boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,documentVersion:hostProps.canvas.documentVersion+1,patches:[]}}');
  await settleFrame();
  assert.equal(await evaluate('results.ready'), readyBeforeDocument);
  assert.equal(await frame('board.getContext().documentVersion'), beforeDocument.documentVersion);
  await click('[data-board-action="fork"]');
  await until('results.composes.length === 6');
  assert.deepEqual(await evaluate('results.composes[5].anchor'), documentAnchor);
  await until(`results.ready === ${readyBeforeDocument + 1}`);
  assert.equal(await frame('board.getContext().documentVersion'), beforeDocument.documentVersion + 1);
  assert.equal(await frame("Boolean(document.querySelector('[data-board-menu]'))"), false);
  assert.equal(await evaluate('results.asks.length'), shortcutAsks);
  check('a pending full-document update waits for menu composition; its fork preserves the old anchor before the new document mounts');

  let focusAnchorCount = await evaluate('results.anchors.length');
  await evaluate('document.body.tabIndex=-1;document.body.focus()');
  assert.equal(await evaluate("document.activeElement === document.querySelector('iframe')"), false);
  await rightClick('#target');
  await menu();
  await until(`results.anchors.length === ${focusAnchorCount + 1}`);
  assert.equal(await evaluate('results.anchors.at(-1).kind'), 'point');
  await key('Escape');
  await noMenu();
  await evaluate('document.body.focus()');
  assert.equal(await evaluate("document.activeElement === document.querySelector('iframe')"), false);
  const focusPaint = await location('#paint');
  await drag({ x: focusPaint.x + 5, y: focusPaint.y + 5 }, { x: focusPaint.x + 120, y: focusPaint.y + 55 }, 1);
  await menu();
  await until(`results.anchors.length === ${focusAnchorCount + 2}`);
  assert.equal(await evaluate('results.anchors.at(-1).kind'), 'region');
  await key('Escape');
  await noMenu();
  check('the first right-click and Alt selection after host focus acquire a valid frame lock and deliver their anchors');

  const frameBounds = await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {bottom:r.bottom,height:innerHeight}})()");
  assert.ok(frameBounds.bottom + 10 < frameBounds.height, 'fixture needs visible host space below the iframe');
  const edgeAnchorCount = await evaluate('results.anchors.length');
  await drag({ x: focusPaint.x + 10, y: focusPaint.y + 10 }, { x: focusPaint.x + 130, y: frameBounds.bottom + 10 }, 1);
  await untilFrame("document.documentElement.dataset.boardSelection === 'off'").catch(async (error) => {
    console.error('Cross-frame release state:', await frame("({mode:document.documentElement.dataset.boardSelection,capture:document.documentElement.hasPointerCapture(1),menu:Boolean(document.querySelector('[data-board-menu]')),focus:document.activeElement?.tagName})"));
    throw error;
  });
  await noMenu();
  await settleFrame();
  assert.equal(await evaluate('results.anchors.length'), edgeAnchorCount);
  await update('{boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,data:{n:6,afterOutsideRelease:true}}}');
  await untilFrame('board.getData().afterOutsideRelease === true');
  await click('#increment');
  assert.equal(await frame('count'), 1);
  check('Alt drag released outside the iframe cancels without an anchor or menu and cannot leave the canvas permanently frozen');

  await drag({ x: focusPaint.x + 5, y: focusPaint.y + 5 }, { x: focusPaint.x + 135, y: focusPaint.y + 65 }, 1,
    () => frame('new Promise(resolve=>{const tick=()=>navigator.userActivation.isActive?setTimeout(tick,20):resolve();tick()})'));
  await menu();
  const hostQuestionAnchor = await evaluate('results.anchors.at(-1)');
  assert.equal(hostQuestionAnchor.kind, 'region');
  const hostQuestionButton = await evaluate("(()=>{const r=document.querySelector('#host-ask').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await clickPoint(hostQuestionButton.x, hostQuestionButton.y);
  await until('results.hostAsks.length === 1');
  assert.deepEqual(await evaluate('results.hostAsks[0]'), hostQuestionAnchor);
  assert.equal(await evaluate('results.asks.length'), shortcutAsks);
  check('a completed selection remains attached to the original host-side Ask button even after a long drag outlives user activation');

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
