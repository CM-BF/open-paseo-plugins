#!/usr/bin/env node
// Real BoardView + query + sandbox integration, driven by a private Chromium DevTools pipe.
// Paseo transport/native primitives are adapted: this is NOT a real-daemon UI check.
// BROWSER_PATH may point to another Chromium executable. No user browser state is accessed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const directory = dirname(fileURLToPath(import.meta.url));
const bundle = await build({ entryPoints: [join(directory, 'board-host-fixture.tsx')], bundle: true, format: 'iife', platform: 'browser', write: false, loader: { '.txt': 'text' }, define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'host-adapters', setup(build) { build.onResolve({ filter: /^(react-native|@getpaseo\/plugin(?:\/client(?:\/ui)?)?)$/ }, () => ({ path: join(directory, 'board-host-adapter.tsx') })); } }] });
const profile = await mkdtemp(join(tmpdir(), 'paseo-board-host-'));
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : '<!doctype html><meta charset="utf-8"><style>html,body,#app{margin:0;width:100%;height:100%;font:14px system-ui}#app{display:flex;flex-direction:column}button{font:inherit}</style><div id="app"></div><script src="/bundle.js"></script>');
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
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
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
  const key = async (name, code = name, modifiers = 0) => {
    const virtual = name === 'Escape' ? 27 : name === 'Enter' ? 13 : name === 'Alt' ? 18 : undefined;
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, modifiers, ...(name === 'Enter' ? {text:'\r'} : {}), ...(virtual ? { windowsVirtualKeyCode: virtual } : {}) });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, modifiers: 0, ...(virtual ? { windowsVirtualKeyCode: virtual } : {}) });
  };
  const clickPoint = async (x, y) => {
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const location = async (selector) => {
    const box = await frame(`(()=>{const selector=${JSON.stringify(selector)};const element=document.querySelector('[data-board-menu]')?.shadowRoot?.querySelector(selector)||document.querySelector('[data-board-markers]')?.shadowRoot?.querySelector(selector)||document.querySelector(selector);const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    const origin = await evaluate(`(()=>{const r=document.querySelector('iframe[data-board-id="host-fixture"]').getBoundingClientRect();return {x:r.x,y:r.y}})()`);
    return { x: origin.x + box.x, y: origin.y + box.y, width: box.width, height: box.height };
  };
  const click = async (selector) => { const b = await location(selector); await clickPoint(b.x + b.width / 2, b.y + b.height / 2); };
  const rightClickPoint = async (x, y, modifiers = 0) => {
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1, modifiers });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', clickCount: 1, modifiers });
  };
  const menu = () => untilFrame("document.querySelector('[data-board-menu]')?.shadowRoot?.querySelector('[data-board-action=question]')?.disabled === false", 18000);
  const hostLocation = (selector) => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  const hostClick = async (selector) => { await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); const r = await hostLocation(selector); await clickPoint(r.x + r.width / 2, r.y + r.height / 2); };
  const marker = (id) => `[data-board-interaction="${id}"]`;
  const untilMarker = (id, status) => untilFrame(`document.querySelector('[data-board-markers]')?.shadowRoot?.querySelector(${JSON.stringify(marker(id))})?.dataset.status===${JSON.stringify(status)}`);
  const canvasRect = () => hostLocation('iframe[data-board-id="host-fixture"]');
  const input = '[data-testid="board-message-input"]';
  const popover = '[data-testid="board-local-popover"]';
  const sendText = (text) => command('Input.insertText', { text });
  const submitCount = () => evaluate("hostFixture.calls.filter(item=>item.name==='board.interact').length");
  const noPopover = () => until(`!document.querySelector(${JSON.stringify(popover)})`);
  const closePopover = async () => {
    await hostClick(`${popover} button[aria-label="关闭"]`);
    await noPopover();
  };
  const openAt = async (x = 155, y = 170, kind = 'question') => {
    const r = await canvasRect();
    await rightClickPoint(r.x + x, r.y + y);
    await menu();
    await click(`[data-board-action=${kind}]`);
    await until(`document.querySelector(${JSON.stringify(input)})`);
    return { x: r.x + x, y: r.y + y };
  };
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await command('Page.bringToFront');
  await until('window.hostFixture?.ready >= 1');
  await until("document.querySelector('[data-testid=board-canvas-container]')");
  await frame('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await frame('window.boots'), 1);
  assert.equal(await evaluate("document.querySelector('[data-fixture-modal]')!==null"), false);
  const original = await canvasRect();
  await command('Page.captureScreenshot', { format: 'png' });
  await click('#control');
  await untilFrame('window.count===1');
  await frame("document.querySelector('#field').value='preserved draft'");
  const beforeTicks = await frame('window.ticks');
  const point = await openAt();
  await until("document.querySelector('[data-testid=board-reference-bar]')?.textContent.includes('已引用')");
  assert.deepEqual(await canvasRect(), original);
  assert.equal(await frame("document.querySelector('#field').value"), 'preserved draft');
  assert.equal(await frame('window.count'), 1);
  assert.equal(await frame('window.boots'), 1);
  assert.ok(await frame('window.ticks') > beforeTicks);
  assert.equal(await evaluate("document.querySelector('[data-fixture-modal]')!==null"), false);
  const nearby = await hostLocation(popover);
  assert.ok(Math.abs(nearby.x - point.x) <= 24, `Popover x ${nearby.x} should be beside pointer ${point.x}`);
  assert.ok(Math.abs(nearby.y - point.y) <= 30, `Popover ${JSON.stringify(nearby)} should be beside pointer ${JSON.stringify(point)}; canvas ${JSON.stringify(original)}`);
  assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(input)})`), true);
  await key('Escape'); await noPopover();
  await hostClick('button[aria-label="清除引用"]');
  assert.deepEqual(await canvasRect(), original);
  check('actual BoardView reference appears/clears without moving or resizing the canvas; live controls and heap survive; context composition is beside the pointer without a modal');

  await hostClick('button[aria-label="框选"]');
  assert.deepEqual(await canvasRect(), original);
  await key('Escape');
  await hostClick('button[aria-label="交互"]');
  assert.deepEqual(await canvasRect(), original);
  check('selection instructions occupy the existing toolbar and preserve the canvas rectangle');

  await openAt();
  await sendText('First line');
  await key('Enter', 'Enter', 8);
  await sendText('Second line');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(input)}).value`), 'First line\nSecond line');
  assert.equal(await submitCount(), 0);
  // Exercise DOM composition events received by the real WebMessageInput, with actual
  // CDP key events for the confirmation Enter. This does not mock its key handler.
  await evaluate(`document.querySelector(${JSON.stringify(input)}).dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'}))`);
  await key('Enter');
  assert.equal(await submitCount(), 0);
  await evaluate(`document.querySelector(${JSON.stringify(input)}).dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}))`);
  await key('Enter');
  assert.equal(await submitCount(), 0);
  await evaluate('new Promise(resolve=>setTimeout(resolve,80))');
  await key('Enter');
  await until("hostFixture.pending().length===1");
  const id = await evaluate('hostFixture.pending()[0]');
  await untilMarker(id, 'sending');
  assert.equal(await evaluate('hostFixture.board().interactions.length'), 0);
  await key('Enter');
  assert.equal(await submitCount(), 1);
  assert.deepEqual(await canvasRect(), original);
  check('Shift+Enter inserts a newline, IME confirmation never sends, Enter submits once, and the sending marker exists before RPC acceptance');

  await evaluate('hostFixture.accept()');
  await untilMarker(id, 'delivered');
  await until(`!document.querySelector(${JSON.stringify(input)})`);
  await evaluate(`hostFixture.updateInteraction(${JSON.stringify(id)},{status:'processing'})`);
  await untilMarker(id, 'processing');
  const answer = { status: 'answered', response: 'The original question is answered here.', responseRevision: 1, responseSource: 'explicit', responseCanvas: { revision: 1, documentVersion: 1, data: {}, patches: [], html: `<style>body{margin:0}button{position:absolute;left:20px;top:20px;width:150px;height:36px}</style><button id="visual-answer" onclick="this.textContent='Animation started';parent.postMessage({channel:'host-response-fixture',clicked:true},'*')">Start animation</button><button id="visual-ask" style="left:190px" onclick="board.ask({prompt:'Explain the selected figure',anchor:{kind:'region',boardRevision:board.getContext().boardRevision,canvasRevision:board.getContext().canvasRevision,text:'Fixture visual selection',rect:{x:12,y:24,width:50,height:40}}}).then(result=>parent.postMessage({channel:'host-response-fixture',result},'*'))">Ask about figure</button>` } };
  await evaluate(`hostFixture.updateInteraction(${JSON.stringify(id)},${JSON.stringify(answer)})`);
  await untilMarker(id, 'answered');
  await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('The original question is answered here.')`);
  assert.equal(await frame('window.boots'), 1);
  assert.equal(await frame("document.querySelector('#field').value"), 'preserved draft');
  const iframeTitles = await evaluate("[...document.querySelectorAll('iframe')].map(frame=>({title:frame.title,id:frame.dataset.boardId,sandbox:frame.sandbox.value}))");
  assert.equal(iframeTitles.length, 2);
  assert.ok(iframeTitles.every(frame => frame.sandbox === 'allow-scripts'));
  await evaluate("[...document.querySelectorAll('iframe')].find(frame=>frame.dataset.boardId!=='host-fixture').scrollIntoView({block:'nearest'})");
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const responseFrame = await evaluate("(()=>{const frame=[...document.querySelectorAll('iframe')].find(frame=>frame.dataset.boardId!=='host-fixture');const rect=frame.getBoundingClientRect();return{x:rect.x,y:rect.y,width:rect.width,height:rect.height}})()");
  assert.ok(responseFrame.width > 100 && responseFrame.height > 100);
  await clickPoint(responseFrame.x + 90, responseFrame.y + 38);
  await until("hostFixture.responseClicks===1");
  assert.deepEqual(await canvasRect(), original);
  await closePopover();
  await click(marker(id));
  await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('The original question is answered here.')`);
  check('polling updates the original marker through delivered, processing and answered; clicking it reopens text and a working sandboxed visual response at that location');

  await evaluate("[...document.querySelectorAll('iframe')].find(frame=>frame.dataset.boardId!=='host-fixture').scrollIntoView({block:'nearest'})");
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const figure = await evaluate("(()=>{const rect=[...document.querySelectorAll('iframe')].find(frame=>frame.dataset.boardId!=='host-fixture').getBoundingClientRect();return{x:rect.x,y:rect.y}})()");
  const beforeGeneratedAsk = await submitCount();
  await clickPoint(figure.x + 265, figure.y + 38);
  await until(`document.querySelector(${JSON.stringify(input)})?.value.includes('Explain the selected figure')`);
  assert.equal(await submitCount(), beforeGeneratedAsk);
  assert.equal(await evaluate('hostFixture.responseResults.length'), 0);
  await key('Enter');
  await until('hostFixture.pending().length===1');
  const visualFollowup = await evaluate('hostFixture.pending()[0]');
  const visualCall = await evaluate("hostFixture.calls.filter(item=>item.name==='board.interact').at(-1).input");
  assert.equal(visualCall.sourceInteractionId, id);
  assert.deepEqual(visualCall.anchor, await evaluate(`hostFixture.board().interactions.find(item=>item.id===${JSON.stringify(id)}).anchor`));
  assert.ok(visualCall.text.includes('"responseRevision":1'));
  assert.ok(visualCall.text.includes('"quote":"Fixture visual selection"'));
  assert.ok(visualCall.text.includes('"rect":{"x":12,"y":24,"width":50,"height":40}'));
  assert.equal(await evaluate('hostFixture.responseResults.length'), 0);
  await evaluate('hostFixture.accept()');
  await until('hostFixture.responseResults.length===1');
  assert.equal(await evaluate('hostFixture.responseResults[0].status'), 'submitted');
  await evaluate(`hostFixture.updateInteraction(${JSON.stringify(visualFollowup)},{status:'answered',response:'Figure follow-up answered in this original thread.'})`);
  await untilMarker(id, 'answered');
  check('generated visual questions wait for explicit send and RPC acceptance; their callback resolves once and retains response-version context alongside the original main-canvas anchor');

  await closePopover();
  const priorReady = await evaluate('hostFixture.ready');
  await evaluate('hostFixture.remount()');
  await until(`hostFixture.ready>${priorReady}`);
  await untilMarker(id, 'answered');
  await click(marker(id));
  await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('First line')`);
  await evaluate('hostFixture.updateCanvas()');
  await untilFrame("board.getData().next===true");
  await untilFrame(`document.querySelector('[data-board-markers]')?.shadowRoot?.querySelector(${JSON.stringify(marker(id))})?.textContent.includes('旧位置')`);
  await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('旧位置')`);
  check('durable interactions recover after remount, and a newer canvas marks the original anchor as stale');

  await closePopover();
  await openAt(280, 190, 'fork');
  await sendText('Discuss this choice'); await key('Enter');
  await until('hostFixture.pending().length===1');
  const fork = await evaluate('hostFixture.pending()[0]');
  await untilMarker(fork, 'sending');
  await evaluate('hostFixture.accept()');
  await untilMarker(fork, 'delivered');
  await evaluate(`hostFixture.updateInteraction(${JSON.stringify(fork)},{status:'answered',response:'Fork answer attached to the original marker.'})`);
  await untilMarker(fork, 'answered');
  await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('Fork answer attached')`);
  await hostClick(`${popover} button[aria-label="继续追问"]`);
  await until(`document.querySelector(${JSON.stringify(input)})`);
  await sendText('A follow-up at this point'); await key('Enter');
  await until('hostFixture.pending().length===1');
  const reply = await evaluate('hostFixture.pending()[0]');
  const replyCall = await evaluate("hostFixture.calls.filter(item=>item.name==='board.interact').at(-1).input");
  assert.equal(replyCall.kind, 'reply'); assert.equal(replyCall.sourceInteractionId, fork);
  await untilMarker(fork, 'sending');
  assert.equal(await frame("document.querySelector('[data-board-markers]').shadowRoot.querySelectorAll('[data-board-interaction]').length"), 2);
  await evaluate('hostFixture.accept()');
  await evaluate(`hostFixture.updateInteraction(${JSON.stringify(reply)},{status:'answered',response:'Follow-up response at the same original point.'})`);
  await untilMarker(fork, 'answered');
  await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('Follow-up response at the same original point.')`);
  await closePopover(); await click(marker(fork));
  await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('A follow-up at this point')`);
  check('fork follow-ups use the source interaction and update one spatial thread marker; reopening retains both question and later answer');

  await closePopover();
  await openAt(480, 190);
  await sendText('A message that fails'); await key('Enter');
  await until('hostFixture.pending().length===1');
  const failed = await evaluate('hostFixture.pending()[0]');
  await untilMarker(failed, 'sending');
  await evaluate('hostFixture.reject()');
  await untilMarker(failed, 'failed');
  await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('Fixture delivery unavailable')`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(input)}).value`), 'A message that fails');
  assert.deepEqual(await canvasRect(), original);
  check('transport rejection leaves a failed marker, preserves the draft, and displays the error without shifting the canvas');

  const originalFailedCall = await evaluate("hostFixture.calls.filter(item=>item.name==='board.interact').at(-1).input");
  await key('Escape'); await noPopover();
  await click(marker(failed));
  await until(`document.querySelector(${JSON.stringify(popover + ' button[aria-label="重试发送"]')})`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(popover + ' button[aria-label="继续追问"]')})!==null`), false);
  await hostClick(`${popover} button[aria-label="重试发送"]`);
  await until(`document.querySelector(${JSON.stringify(input)})?.value==='A message that fails'`);
  await key('Enter');
  await until('hostFixture.pending().length===1');
  assert.equal(await evaluate('hostFixture.pending()[0]'), failed);
  const retried = await evaluate("hostFixture.calls.filter(item=>item.name==='board.interact').at(-1).input");
  assert.deepEqual(retried, originalFailedCall);
  assert.equal(retried.sourceInteractionId, undefined);
  assert.equal(await evaluate(`hostFixture.board().interactions.some(item=>item.id===${JSON.stringify(failed)})`), false);
  await evaluate('hostFixture.accept()');
  await untilMarker(failed, 'delivered');
  assert.equal(await evaluate(`hostFixture.board().interactions.filter(item=>item.id===${JSON.stringify(failed)}).length`), 1);
  check('reopening a failed unsaved marker offers retry, reuses the original intent ID and anchor, and never references that missing intent as a parent');

  await closePopover();
  await command('Emulation.setDeviceMetricsOverride', { width: 900, height: 650, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const smallerCanvas = await canvasRect();
  await openAt(smallerCanvas.width - 35, smallerCanvas.height - 45, 'change');
  const edgePopover = await hostLocation(popover);
  assert.ok(edgePopover.x >= smallerCanvas.x && edgePopover.y >= smallerCanvas.y);
  assert.ok(edgePopover.x + edgePopover.width <= smallerCanvas.x + smallerCanvas.width);
  assert.ok(edgePopover.y + edgePopover.height <= smallerCanvas.y + smallerCanvas.height);
  assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(input)})`), true);
  await key('Escape'); await noPopover();
  assert.deepEqual(await canvasRect(), smallerCanvas);
  check('on a smaller desktop viewport the local composer flips inside the canvas boundaries, stays focused and closes with Escape');

  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  if (process.env.BOARD_HOST_TEST_SCREENSHOT) await writeFile(process.env.BOARD_HOST_TEST_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  console.log(`BoardView browser integration: ${passed} checks passed (Paseo transport/native primitives adapted; not a daemon UI verification).`);
} catch (error) {
  console.error('BoardView check failed:', error);
  console.error('Browser exceptions:', JSON.stringify(logs).slice(-5000));
  process.exitCode = 1;
} finally {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
  chrome.stdio[3].destroy(); chrome.stdio[4].destroy(); chrome.stderr.destroy();
  for (const entry of commands.values()) { clearTimeout(entry.timer); entry.reject(new Error('browser closed')); }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
