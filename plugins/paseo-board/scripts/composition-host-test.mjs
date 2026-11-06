#!/usr/bin/env node
// Production BoardView + registered public host services; isolated browser only.
// RPCs terminate in the fixture, including explicit comment sends. No live agent.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = dirname(fileURLToPath(import.meta.url));
const bundle = await build({ entryPoints: [join(directory, 'composition-host-fixture.tsx')], bundle: true, format: 'iife', platform: 'browser', write: false,
  loader: { '.txt': 'text' }, define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'fixture-public-adapter', setup(build) {
    build.onResolve({ filter: /^(react-native|@getpaseo\/plugin(?:\/client(?:\/ui)?)?)$/ }, () => ({ path: join(directory, 'board-host-adapter.tsx') }));
  } }] });
const server = createServer((req, res) => { res.setHeader('content-type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/bundle.js' ? bundle.outputFiles[0].text : '<!doctype html><meta charset="utf-8"><style>html,body,#app{margin:0;width:100%;height:100%;font:14px system-ui}#app{display:flex;flex-direction:column}button{font:inherit}</style><div id="app"></div><script src="/bundle.js"></script>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(join(tmpdir(), 'board-composition-host-'));
const chrome = spawn(process.env.BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--disable-background-networking', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1280,1000', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let sequence = 0, buffer = '', stage = 'boot', passed = 0;
const pending = new Map(), exceptions = [], independentFailures = [];
chrome.stdio[4].on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\0')) >= 0) {
  const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); const entry = pending.get(message.id);
  if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
  else if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
} });
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15000); pending.set(id, { resolve, reject, timer }); chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); });
const check = text => { passed++; console.log(`PASS ${text}`); };
let evaluate, command;
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }), { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  command = (method, params) => send(method, params, sessionId);
  await command('Runtime.enable'); await command('Page.enable'); await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  evaluate = async expression => { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  const until = (condition, timeout = 8000) => evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+${timeout};const loop=()=>{try{if(${condition})return resolve(true)}catch{}if(performance.now()>deadline)return reject(new Error('Timeout: '+${JSON.stringify(condition)}));setTimeout(loop,20)};loop()})`);
  const frame = (slot, code) => evaluate(`compositionFixture.frame(${JSON.stringify(slot)},${JSON.stringify(code)})`);
  const untilFrame = (slot, condition) => frame(slot, `new Promise((resolve,reject)=>{const deadline=performance.now()+6000;const loop=()=>{if(${condition})return resolve(true);if(performance.now()>deadline)return reject(new Error('Frame condition: '+${JSON.stringify(condition)}));setTimeout(loop,20)};loop()})`);
  const clickPoint = async (x, y) => { await command('Page.captureScreenshot', { format: 'png' }); for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await command('Input.dispatchMouseEvent', { type, x, y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) }); };
  const hostClick = async selector => { await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`); const r = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`); await clickPoint(r.x + r.width / 2, r.y + r.height / 2); };
  const framePoint = async (slot, selector) => {
    const target = await frame(slot, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    const origin = await evaluate(`(()=>{const r=document.querySelector('iframe[data-board-id="parent"]').getBoundingClientRect();return {x:r.x,y:r.y}})()`);
    const offset = slot === 'parent' ? { x: 0, y: 0 } : await frame('parent', `(()=>{const r=document.querySelector('paseo-board[slot-id="${slot}"] iframe').getBoundingClientRect();return{x:r.x,y:r.y}})()`);
    return { x: origin.x + offset.x + target.x + target.width / 2, y: origin.y + offset.y + target.y + target.height / 2 };
  };
  const frameClick = async (slot, selector) => { const point = await framePoint(slot, selector); await clickPoint(point.x, point.y); };
  const nativeScroll = async (slot, x, y) => {
    const previous = await frame(slot, `({x:scrollX,y:scrollY})`);
    const origin = await evaluate(`(()=>{const r=document.querySelector('iframe[data-board-id="parent"]').getBoundingClientRect();return{x:r.x,y:r.y}})()`);
    const bounds = await frame('parent', `(()=>{const r=document.querySelector('paseo-board[slot-id="${slot}"] iframe').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    await frame(slot, `window.fixtureWheel=null;addEventListener('wheel',event=>window.fixtureWheel={trusted:event.isTrusted,x:event.deltaX,y:event.deltaY},{once:true});true`);
    await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: origin.x + bounds.x + 50, y: origin.y + bounds.y + Math.min(280, bounds.height - 20), deltaX: x - previous.x, deltaY: y - previous.y });
    await untilFrame(slot, `scrollX===${x}&&scrollY===${y}`);
    assert.equal(await frame(slot, 'fixtureWheel?.trusted'), true);
    await until(`compositionFixture.view('${slot}')?.view.x===${x}&&compositionFixture.view('${slot}')?.view.y===${y}`);
    // Detect the previous next-layout zero, not merely a transient saved sample.
    await frame(slot, `new Promise((resolve,reject)=>{const started=performance.now();const check=()=>{if(scrollX!==${x}||scrollY!==${y})return reject(new Error('Native reading position changed after capture: '+JSON.stringify({x:scrollX,y:scrollY})));if(performance.now()-started>=180)return resolve(true);requestAnimationFrame(check)};requestAnimationFrame(check)})`);
    assert.equal(await evaluate(`compositionFixture.view('${slot}')?.view.y`), y);
  };
  const slotHeaderClick = async (slot, label) => {
    // DevTools can inspect the browser's closed shadow tree without opening it
    // to authored page scripts. Only the resulting native pointer is an action.
    const targets = await send('Target.getTargets');
    const parent = targets.targetInfos.find(item => item.type === 'iframe' && item.url === 'about:srcdoc');
    assert.ok(parent, 'Actual opaque parent renderer is exposed to this private test browser');
    const { sessionId: parentSession } = await send('Target.attachToTarget', { targetId: parent.targetId, flatten: true });
    try {
      await send('DOM.enable', {}, parentSession);
      const { root } = await send('DOM.getDocument', { depth: -1, pierce: true }, parentSession);
      const descend = node => [node, ...(node.children ?? []).flatMap(descend), ...(node.shadowRoots ?? []).flatMap(descend), ...(node.contentDocument ? descend(node.contentDocument) : [])];
      const attr = (node, key) => { const index = node.attributes?.indexOf(key) ?? -1; return index < 0 ? undefined : node.attributes[index + 1]; };
      const element = descend(root).find(node => node.nodeName === 'PASEO-BOARD' && attr(node, 'slot-id') === slot);
      assert.ok(element, `Actual slot ${slot} exists`);
      const button = descend(element).find(node => node.nodeName === 'BUTTON' && descend(node).some(child => child.nodeValue === label));
      assert.ok(button, `Actual header action ${label} exists`);
      const { model } = await send('DOM.getBoxModel', { backendNodeId: button.backendNodeId }, parentSession);
      const point = { x: (model.border[0] + model.border[4]) / 2, y: (model.border[1] + model.border[5]) / 2 };
      const origin = await evaluate(`(()=>{const r=document.querySelector('iframe[data-board-id="parent"]').getBoundingClientRect();return{x:r.x,y:r.y}})()`);
      await clickPoint(point.x + origin.x, point.y + origin.y);
    } finally { await send('Target.detachFromTarget', { sessionId: parentSession }); }
  };
  const press = async (key, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key, code: key, modifiers, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : key.toUpperCase().charCodeAt(0), ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) }); };
  const shape = slot => frame(slot, `({heap,host:fixtureHost,count:window.clicks,value:document.querySelector('#value').value,x:scrollX,y:scrollY})`);
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}${process.env.COMPOSITION_VIEW_TRACE ? '?trace=1' : ''}` });
  await until('compositionFixture?.ready.some(item=>item.boardId==="parent")');
  await untilFrame('parent', 'document.querySelectorAll("paseo-board iframe").length===3');
  assert.equal(await evaluate('compositionFixture.calls.filter(item=>item.name==="board.read"&&item.input.boardId==="same").length'), 0);
  check('ungranted authored slots cannot read another Board, even when its host is registered');

  stage = 'public-source-modal';
  await hostClick('[data-testid="board-more-open"]'); await hostClick('[data-testid="board-composition-open"]');
  await hostClick('[aria-label="host-a / same"]'); await hostClick('[aria-label="host-b / same"]'); await hostClick('[aria-label="保存来源"]');
  await until('compositionFixture.sources().sources.length===2'); await hostClick('[aria-label="关闭窗口"]');
  await until('compositionFixture.ready.filter(item=>item.boardId==="same").length===3');
  const initial = await Promise.all(['a', 'b', 'c'].map(shape));
  assert.deepEqual(initial.map(item => item.host), ['host-a', 'host-b', 'host-b']); assert.equal(new Set(initial.map(item => item.heap)).size, 3);
  await until('compositionFixture.calls.some(item=>item.name==="board.composition.sync-source")');
  assert.deepEqual(await evaluate('compositionFixture.calls.filter(item=>item.name==="board.composition.set-sources"||item.name==="board.composition.sync-source").map(item=>item.hostId)'), ['host-a', 'host-a']);
  assert.deepEqual(await evaluate('window.fixtureModalErrors??[]'), []);
  check('isolated source Modal keeps its parent service; identical source IDs resolve independently on two public installations');

  stage = 'source-and-parent-comments';
  for (const [slot, hostId, boardId] of [['b', 'host-b', 'same'], ['a', 'host-a', 'same'], ['parent', 'host-a', 'parent']]) {
    const count = await evaluate('compositionFixture.calls.filter(item=>item.name==="board.interact").length');
    await frameClick(slot, '#comment'); await until('Boolean(document.querySelector("textarea"))');
    assert.ok((await evaluate('document.querySelector("textarea").value')).includes(`Comment ${hostId} ${boardId}`));
    await hostClick('[aria-label="主会话发送"]'); await until(`compositionFixture.calls.filter(item=>item.name==='board.interact').length===${count + 1}`);
    const sent = await evaluate('compositionFixture.calls.filter(item=>item.name==="board.interact").at(-1)'); assert.equal(sent.hostId, hostId); assert.equal(sent.input.boardId, boardId); assert.equal(sent.input.anchor.selector, '#target');
    await untilFrame(slot, 'askResults.some(item=>item.status==="submitted")');
    if (slot !== 'parent' && await evaluate('Boolean(document.querySelector("[aria-label=\\"关闭窗口\\"]"))')) {
      await hostClick('[aria-label="关闭窗口"]'); await until('!document.querySelector("[data-fixture-modal]")');
    } else { await frameClick('parent', 'h1'); await until('!document.querySelector("[data-testid=\\"board-local-popover\\"]")'); }
  }
  assert.equal(await evaluate('compositionFixture.fallbackCalls.length'), 0);
  check('native source and parent Comment actions submit only to their own mock host/Board and preserve cloneable references');

  stage = 'single-comment-receipt-identity';
  const receiptStart = await evaluate('compositionFixture.calls.filter(item=>item.name==="board.interact").length');
  const answersBeforeMismatch = await frame('b', 'askResults.length');
  const sourceInteractionsBeforeMismatch = await evaluate('compositionFixture.board("host-b","same").interactions.length');
  await frameClick('b', '#comment'); await until('Boolean(document.querySelector("textarea"))');
  const preservedText = await evaluate('document.querySelector("textarea").value');
  let frozenSend;
  for (const patch of ['{expectedCreatedAt:undefined}', '{expectedCreatedAt:"another-source-entity"}', '{text:"a different accepted comment"}']) {
    const callsBefore = await evaluate('compositionFixture.calls.filter(item=>item.name==="board.interact").length');
    await evaluate(`compositionFixture.nextReceiptPatch=${patch};true`);
    await hostClick(frozenSend ? '[aria-label="重试原发送"]' : '[aria-label="主会话发送"]');
    await until(`compositionFixture.calls.filter(item=>item.name==='board.interact').length===${callsBefore + 1}`);
    await until('document.body.textContent.includes("返回的发送记录与这条评论不一致")');
    await until('Boolean(document.querySelector("[aria-label=\\"重试原发送\\"]"))');
    assert.equal(await evaluate('document.querySelector("textarea").value'), preservedText);
    assert.equal(await frame('b', 'askResults.length'), answersBeforeMismatch, 'A mismatched receipt cannot resolve the authored promise as submitted');
    const saved = await evaluate('compositionFixture.drafts("host-b","same").drafts');
    assert.equal(saved.length, 1, 'The original durable draft remains recoverable');
    const input = await evaluate('compositionFixture.calls.filter(item=>item.name==="board.interact").at(-1).input');
    frozenSend ??= input; assert.deepEqual(input, frozenSend, 'Native retries preserve the original request and source identity');
    assert.equal(saved[0].compose.intentId, input.intentId);
    assert.equal(saved[0].compose.expectedCreatedAt, input.expectedCreatedAt);
    assert.equal(await evaluate('compositionFixture.board("host-b","same").interactions.length'), sourceInteractionsBeforeMismatch);
  }
  await hostClick('[aria-label="重试原发送"]');
  await untilFrame('b', `askResults.length===${answersBeforeMismatch + 1}`);
  assert.equal(await frame('b', 'askResults.at(-1).status'), 'submitted');
  await until('compositionFixture.drafts("host-b","same").drafts.length===0');
  const receiptCalls = await evaluate(`compositionFixture.calls.filter(item=>item.name==='board.interact').slice(${receiptStart})`);
  assert.equal(receiptCalls.length, 4);
  for (const call of receiptCalls) { assert.equal(call.hostId, 'host-b'); assert.deepEqual(call.input, frozenSend); }
  assert.equal(await evaluate('compositionFixture.board("host-b","same").interactions.length'), sourceInteractionsBeforeMismatch + 1);
  if (await evaluate('Boolean(document.querySelector("[aria-label=\\"关闭窗口\\"]"))')) await hostClick('[aria-label="关闭窗口"]');
  await until('!document.querySelector("[data-fixture-modal]")');
  check('single native comment sends retain their draft and unresolved ask on mismatched identity or payload receipts, then retry the same request and clear only after its exact receipt');

  stage = 'embedded-comment-queue';
  const sendsBeforeQueue = await evaluate('compositionFixture.calls.filter(item=>item.name==="board.interact").length');
  for (const slot of ['b', 'c']) {
    await frameClick(slot, '#comment'); await until('Boolean(document.querySelector("textarea"))');
    await hostClick('[data-testid="board-comment-stage"]'); await until('!document.querySelector("[data-fixture-modal]")');
    await untilFrame(slot, 'askResults.some(item=>item.status==="queued")');
  }
  assert.equal(await evaluate('compositionFixture.calls.filter(item=>item.name==="board.interact").length'), sendsBeforeQueue);
  assert.equal(await evaluate('compositionFixture.drafts("host-b","same").drafts.filter(item=>item.queuedAt!==undefined).length'), 2);
  assert.equal(await evaluate('compositionFixture.drafts("host-a","same").drafts.length'), 0);
  assert.equal(await evaluate('compositionFixture.drafts("host-a","parent").drafts.length'), 0);
  await slotHeaderClick('b', '待发送 2'); await until('Boolean(document.querySelector("[data-testid=\\"board-drafts\\"]"))');
  await hostClick('[aria-label="统一发送到主会话"]');
  await until(`compositionFixture.calls.filter(item=>item.name==='board.interact').length===${sendsBeforeQueue + 1}`);
  const batch = await evaluate('compositionFixture.calls.filter(item=>item.name==="board.interact").at(-1)');
  assert.equal(batch.hostId, 'host-b'); assert.equal(batch.input.boardId, 'same'); assert.equal(batch.input.comments.length, 2);
  await until('compositionFixture.drafts("host-b","same").drafts.length===0');
  if (await evaluate('Boolean(document.querySelector("[aria-label=\\"关闭窗口\\"]"))')) await hostClick('[aria-label="关闭窗口"]');
  await until('!document.querySelector("[data-fixture-modal]")');
  check('two duplicate source slots share only their own queue; native header Send All sends one ordered source-host batch');

  stage = 'embedded-component-edit';
  const textHost = "document.querySelector('[data-board-component-inline]')";
  const textEditor = `${textHost}?.shadowRoot.querySelector('[aria-label="组件文字"]')`;
  const originalText = await frame('b', "document.querySelector('#target').textContent");
  const editHeap = (await shape('b')).heap;
  const proposeText = async text => {
    const point = await framePoint('b', '#target');
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await command('Input.dispatchMouseEvent', { type, ...point, modifiers: 12, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
    await untilFrame('b', `document.querySelector('[data-board-components]')?.shadowRoot.querySelector('[aria-current=true]')?.textContent==='#target'`);
    const textOffset = await frame('b', `(()=>{const n=document.querySelector('#target').firstChild,e=document.querySelector('#target').getBoundingClientRect();for(let offset=0;offset<n.length;offset++){const r=document.createRange();r.setStart(n,offset);r.setEnd(n,offset+1);const b=r.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;if(document.elementFromPoint(x,y)?.id==='target')return{x:x-e.x-e.width/2,y:y-e.y-e.height/2,hit:'target'};}return {hit:document.elementFromPoint(e.x+e.width/2,e.y+e.height/2)?.outerHTML.slice(0,700)}})()`);
    assert.equal(textOffset.hit, 'target', 'Native text point must hit authored text rather than its comment marker');
    const textPoint = { x: point.x + textOffset.x, y: point.y + textOffset.y };
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...textPoint });
    for (const clickCount of [1, 2]) for (const type of ['mousePressed', 'mouseReleased']) await command('Input.dispatchMouseEvent', { type, ...textPoint, button: 'left', clickCount });
    await untilFrame('b', `${textEditor}?.isContentEditable`); await command('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']}); await command('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:0}); await command('Input.insertText', { text }); assert.equal(await frame('b', `${textEditor}.textContent`), text); await press('Enter', 4);
    await until('document.querySelectorAll("[data-testid=\\"board-component-edit\\"]").length===1');
    assert.equal(await evaluate('document.querySelectorAll("[data-fixture-modal]").length'), 1, 'Duplicate source slot must not share the active component-edit writer');
  };
  await proposeText('Cancelled source edit'); await hostClick('[aria-label="取消修改"]'); await until('!document.querySelector("[data-fixture-modal]")');
  assert.equal(await frame('b', "document.querySelector('#target').textContent"), originalText); assert.equal(await evaluate('compositionFixture.calls.filter(item=>item.name==="board.edit").length'), 0);
  await proposeText('Saved source edit'); await hostClick('[aria-label="保存修改"]'); await until('!document.querySelector("[data-fixture-modal]")');
  await untilFrame('b', "document.querySelector('#target').textContent==='Saved source edit'"); await untilFrame('c', "document.querySelector('#target').textContent==='Saved source edit'");
  assert.equal((await shape('b')).heap, editHeap); assert.equal(await frame('a', "document.querySelector('#target').textContent"), originalText);
  assert.deepEqual(await evaluate('compositionFixture.calls.filter(item=>item.name==="board.edit").map(item=>({hostId:item.hostId,boardId:item.input.boardId}))'), [{ hostId: 'host-b', boardId: 'same' }]);
  await frameClick('b', '#value'); await press('Escape');
  check('native embedded component editing has one source-owned review Modal; Cancel writes nothing and Save updates only that host');

  stage = 'layout-preserves-source';
  await frameClick('b', '#control'); await untilFrame('b', 'window.clicks===1'); await frame('b', `document.querySelector('#value').value='retained B'; true`);
  const before = await shape('b');
  await frame('parent', `document.querySelector('[slot-id="b"]').style.height='460px'; true`);
  await evaluate('compositionFixture.patchParent()');
  await untilFrame('parent', 'document.querySelector("#layout").firstElementChild.getAttribute("slot-id")==="c"');
  const after = await shape('b'); assert.equal(after.heap, before.heap); assert.equal(after.value, 'retained B'); assert.equal(after.count, 1);
  await frameClick('b', '#save'); await until('compositionFixture.calls.some(item=>item.name==="board.state"&&item.hostId==="host-b")');
  assert.equal(await evaluate('compositionFixture.board("host-b","same").userState.value'), 'retained B');
  assert.deepEqual(await evaluate('compositionFixture.board("host-a","same").userState'), {});
  check('author resize and authoritative DOM reorder keep the source iframe heap, input, handlers and host-bound state writes');

  stage = 'instance-view-restoration';
  for (const [slot, y] of [['a', 110], ['b', 240], ['c', 370]]) await nativeScroll(slot, 70, y);
  console.log('MEASURE independent-views-before-remount', JSON.stringify(await evaluate('["a","b","c"].map(slot=>({slot,view:compositionFixture.view(slot)}))')));
  assert.equal(await evaluate('compositionFixture.ordinaryView("host-b")??null'), null);
  const beforeRemount = await evaluate('compositionFixture.ready.length'); await evaluate('compositionFixture.remount()');
  await until(`compositionFixture.ready.length>=${beforeRemount + 4}`);
  try {
    for (const [slot, y] of [['a', 110], ['b', 240], ['c', 370]]) await untilFrame(slot, `scrollY===${y}&&scrollX===70`);
    check('duplicate source slots restore their own two-axis view after parent remount without taking the normal Board position');
  } catch (error) {
    independentFailures.push({ stage, error: String(error) });
    console.error('View diagnostics:', JSON.stringify(await evaluate('Promise.all(["a","b","c"].map(async slot=>({slot,saved:compositionFixture.view(slot),frame:await compositionFixture.frame(slot,"({x:scrollX,y:scrollY,heap})")})))')));
  }

  stage = 'same-slot-dom-replacement';
  // A new DOM element may keep the declared slot ID and source, but must get a
  // new CanvasFrame session. A move/resize above must keep its old live session.
  const oldSlot = await shape('a');
  const oldSession = await frame('a', `document.scripts[0].textContent.match(/"sessionId":"([^"]+)"/)[1]`);
  const readyBeforeSlotReplacement = await evaluate('compositionFixture.ready.length');
  await frame('parent', `(()=>{const original=document.querySelector('paseo-board[slot-id="a"]'),replacement=document.createElement('paseo-board');for(const {name,value} of original.attributes)replacement.setAttribute(name,value);original.replaceWith(replacement);return true})()`);
  await until(`compositionFixture.ready.length===${readyBeforeSlotReplacement + 1}`);
  await untilFrame('a', `scrollX===${oldSlot.x}&&scrollY===${oldSlot.y}`);
  const newSlot = await shape('a');
  const newSession = await frame('a', `document.scripts[0].textContent.match(/"sessionId":"([^"]+)"/)[1]`);
  assert.notEqual(newSlot.heap, oldSlot.heap); assert.notEqual(newSession, oldSession);
  assert.equal(await evaluate(`compositionFixture.distinctSources(${JSON.stringify(oldSlot.heap)},${JSON.stringify(newSlot.heap)})`), true);
  await nativeScroll('a', oldSlot.x, oldSlot.y + 125);
  const beforeRetiredProbe = await evaluate("compositionFixture.view('a')");
  const rawBefore = await evaluate('compositionFixture.rawViewMessages.length');
  // This is a native window message from the new source carrying the retired
  // session, not a synthetic event or a fabricated private-port receipt.
  await frame('a', `top.postMessage({channel:'paseo-board-frame-v1',boardId:'same',sessionId:${JSON.stringify(oldSession)},type:'view-state',view:{documentVersion:1,canvasRevision:1,x:0,y:999,scrolls:[]}},'*');true`);
  await until(`compositionFixture.rawViewMessages.length>${rawBefore}`);
  const retiredProbe = await evaluate('compositionFixture.rawViewMessages.at(-1)');
  assert.equal(retiredProbe.trusted, true); assert.equal(retiredProbe.data.sessionId, oldSession);
  assert.deepEqual(await evaluate("compositionFixture.view('a')"), beforeRetiredProbe);
  check('same-ID slot DOM replacement creates a new native window/session, restores its view, saves new native scrolling and rejects the retired session');

  stage = 'passive-preview';
  const beforePreviewReady = await evaluate('compositionFixture.ready.length');
  const interactiveHeap = (await shape('c')).heap;
  await frame('parent', `document.querySelector('[slot-id="c"]').setAttribute('view','preview'); true`);
  await untilFrame('parent', `document.querySelector('[slot-id="c"] iframe').inert===true`);
  // inert is set on the locator before its new document is loaded. Wait for the
  // new authored bridge, rather than sending evaluation into the retired frame.
  await until(`compositionFixture.ready.length===${beforePreviewReady + 1}`);
  assert.notEqual((await shape('c')).heap, interactiveHeap);
  await untilFrame('c', 'scrollY===0');
  const writes = await evaluate('compositionFixture.calls.filter(item=>["board.interact","board.state","board.updates-seen"].includes(item.name)).length');
  await frame('c', `document.querySelector('#comment').click(); document.querySelector('#save').click(); true`);
  await untilFrame('c', 'askResults.some(item=>item.status==="cancelled")');
  assert.equal(await evaluate('compositionFixture.calls.filter(item=>["board.interact","board.state","board.updates-seen"].includes(item.name)).length'), writes);
  assert.equal(await evaluate('compositionFixture.calls.filter(item=>item.name==="board.updates-seen"&&item.input.boardId==="same").length'), 0);
  check('passive previews are inert and cannot send, persist source state or mark source updates seen');

  stage = 'same-id-source-replacement';
  const oldGrant = await evaluate('compositionFixture.sources().sources.find(source=>source.ref.hostId==="host-b").sourceCreatedAt');
  const beforeReplacement = await evaluate('compositionFixture.ready.length');
  const replacement = await evaluate('compositionFixture.recreateSource()');
  assert.notEqual(replacement.createdAt, oldGrant);
  await until(`compositionFixture.cached('host-b','same')?.createdAt===${JSON.stringify(replacement.createdAt)}`);
  assert.equal(await evaluate('compositionFixture.cached("host-b","same").revision'), 1, 'A new low revision must replace the old high-revision entity');
  assert.equal(await evaluate('compositionFixture.sources().sources.find(source=>source.ref.hostId==="host-b").sourceCreatedAt'), oldGrant);
  assert.equal(await evaluate('compositionFixture.ready.length'), beforeReplacement, 'The replacement is not automatically embedded under the old grant');
  await hostClick('[data-testid="board-more-open"]'); await hostClick('[data-testid="board-composition-open"]');
  await hostClick('[aria-label="host-b / same"]'); await hostClick('[aria-label="host-b / same"]'); await hostClick('[aria-label="保存来源"]');
  await until(`compositionFixture.sources().sources.find(source=>source.ref.hostId==='host-b').sourceCreatedAt===${JSON.stringify(replacement.createdAt)}`);
  await hostClick('[aria-label="关闭窗口"]');
  await until(`compositionFixture.ready.length===${beforeReplacement + 2}`);
  await untilFrame('b', "document.querySelector('#target').textContent==='A meaningful local reference'");
  assert.equal(await evaluate('compositionFixture.fallbackCalls.length'), 0);
  check('same-ID low-revision source recreation invalidates its old grant and needs explicit native re-selection before embedding');

  stage = 'revoke-only-one-host';
  const survivor = await shape('a'); await evaluate('compositionFixture.dispose("host-b")');
  await until('!document.querySelector("[data-fixture-modal-error]")');
  assert.equal((await shape('a')).heap, survivor.heap);
  await frame('a', 'scrollTo(0,0); true'); await frameClick('a', '#control'); await untilFrame('a', 'window.clicks===1');
  assert.equal(await evaluate('compositionFixture.fallbackCalls.length'), 0); assert.deepEqual(await evaluate('window.fixtureModalErrors??[]'), []); assert.deepEqual(exceptions, []);
  check('retiring one host leaves the other source live without fallback RPC or a parent remount');
  assert.deepEqual(independentFailures, [], 'Independent integration failures remain recorded');
  console.log(`Composition host integration: ${passed} checks passed (public transport/native primitives adapted; no daemon UI or real delivery).`);
} catch (error) {
  console.error(`Composition integration failed at ${stage}:`, error);
  if (evaluate && process.env.COMPOSITION_VIEW_TRACE) console.error('Native view trace:', JSON.stringify(await evaluate('compositionFixture.viewTrace').catch(() => null)));
  if (evaluate && stage === 'instance-view-restoration') console.error('View diagnostics:', JSON.stringify(await evaluate('Promise.all(["a","b","c"].map(async slot=>({slot,saved:compositionFixture.view(slot),frame:await compositionFixture.frame(slot,"({x:scrollX,y:scrollY,heap})")})))').catch(() => null)));
  if (evaluate) console.error('Composition diagnostics:', JSON.stringify(await evaluate('({calls:compositionFixture?.calls,errors:compositionFixture?.errors,ready:compositionFixture?.ready,modals:window.fixtureModalErrors??[],text:document.body.innerText.slice(-2500)})').catch(() => null)));
  if (process.env.COMPOSITION_FAILURE_SCREENSHOT && command) { const shot = await command('Page.captureScreenshot', { format: 'png' }).catch(() => null); if (shot) await writeFile(process.env.COMPOSITION_FAILURE_SCREENSHOT, Buffer.from(shot.data, 'base64')); }
  process.exitCode = 1;
} finally {
  const exited = new Promise(resolve => { if (chrome.exitCode !== null) resolve(); else chrome.once('exit', resolve); });
  await send('Browser.close').catch(() => undefined); chrome.kill(); await exited;
  await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
