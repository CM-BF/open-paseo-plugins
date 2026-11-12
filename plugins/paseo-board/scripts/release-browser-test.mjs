#!/usr/bin/env node
// Real standalone exported documents, including the actual host preview component.
// Only isolated loopback servers, temporary Board data and a private Chromium profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { componentLayoutHtml } from './component-layout-fixture.mjs';
import { createReleaseApiFixture, runReleaseApiChecks } from './release-api-checks.mjs';
import { createLiveFixture, runLiveChecks } from './release-live-checks.mjs';
import { createReleaseGlassFixture, runReleaseGlassChecks } from './release-glass-checks.mjs';

const directory = dirname(fileURLToPath(import.meta.url)), root = dirname(directory);
const temporary = await mkdtemp(join(tmpdir(), 'paseo-release-browser-'));
const core = await build({ stdin: { contents: `export {BoardStore} from './server/store';export {BoardCopies} from './server/board-copy';export {buildRelease,ReleaseRepository} from './server/static-release';export {describeAuthoring} from './server/authored-source';export {componentIdentityFor} from './shared/component-identity';export {DOMParser} from 'linkedom';export {LiveDataPublisher} from './server/live-data';`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.txt': 'text' } });
const coreFile = join(temporary, 'core.cjs'); await writeFile(coreFile, core.outputFiles[0].text);
const { BoardStore, BoardCopies, buildRelease, ReleaseRepository, describeAuthoring, componentIdentityFor, DOMParser, LiveDataPublisher } = createRequire(import.meta.url)(coreFile);
const store = new BoardStore(join(temporary, 'boards'));
const publicData = { label: 'Visible public data', nested: { value: 42 }, unusual: '</script><script>window.escapedFromData=true</script>\u2028\u2029' };
const content = `<style>body{margin:0;background:#172e27;color:#eef5f1;font:17px/1.5 Georgia}main{padding:24px}button,input{font:inherit}#shape{width:120px;height:70px}</style>
<main><h1 id="final">PRIVATE_OLD_CONTENT</h1><p id="data"></p><p id="unusual"></p><input id="input" value=""><button id="increment" type="button">Increment</button><output id="count"></output>
<form id="form" action="https://must-not-send.invalid/private" method="post"><button id="submit" type="submit">Local submit</button></form><output id="submitted">0</output><button id="ask" type="button">Ask agent</button><svg id="shape" viewBox="0 0 120 70"><circle cx="35" cy="35" r="25" fill="#76c2a4"/></svg><p id="patched"></p></main>
<script>
window.boots=(window.boots||0)+1;window.state=board.restoreState();window.count=state.count||0;window.localSubmits=0;
document.querySelector('#data').textContent=board.getData().label;document.querySelector('#unusual').textContent=board.getData().unusual;
board.watch('/nested/value',(value,meta)=>window.watched={value,meta});window.initialContext=board.getContext();
document.querySelector('#input').value=state.input||'';document.querySelector('#count').textContent=count;
document.querySelector('#increment').onclick=()=>{document.querySelector('#count').textContent=++window.count;board.saveState({count,input:document.querySelector('#input').value})};
document.querySelector('#form').onsubmit=event=>{event.preventDefault();document.querySelector('#submitted').textContent=++window.localSubmits};
document.querySelector('#ask').onclick=async()=>window.askResult=await board.ask({prompt:'Private agent request'});
try{window.parentReadable=Boolean(parent.document)}catch{window.parentReadable=false}try{window.privateStorage=localStorage.length}catch{window.privateStorage='denied'}
window.ready=true;
</script>`;
let source = await store.create({ id: 'PRIVATE_SOURCE_BOARD', title: 'Published fixture', ownerAgentId: 'PRIVATE_AGENT_ID', html: content, data: { secret: 'PRIVATE_CANVAS_DATA' } });
source = await store.publish({ boardId: source.id, expectedRevision: source.revision, canvasBase: { revision: 1, documentVersion: 1 }, eventId: 'PRIVATE_EDIT_RECEIPT', patch: { id: 'PRIVATE_PATCH_ID', selector: '#final', operation: 'replace', html: '<h1 id="final">Final publication</h1>' } });
// Existing fragment journals use the body as their append/prepend destination.
// Exercise the persisted journal through cold source replay, copy and publication.
for (const patch of [
  { id:'root-append',selector:'body',operation:'append',html:'<aside id="root-card"><span id="root-note">Before later patch</span><button id="root-button" type="button" onclick="this.textContent=\'Root listener works\'">Root control</button></aside><script>window.rootPatchBoots=(window.rootPatchBoots||0)+1</script>' },
  { id:'root-prepend',selector:'body',operation:'prepend',html:'<header id="root-first">Prepended content</header>' },
  { id:'root-later-edit',selector:'#root-note',operation:'replace',html:'<span id="root-note">Later journal patch retained</span>' },
]) source = await store.publish({boardId:source.id,expectedRevision:source.revision,canvasBase:{revision:source.canvas.revision,documentVersion:source.canvas.documentVersion},eventId:patch.id,patch});
assert.deepEqual((await new BoardStore(join(temporary,'boards')).read(source.id)).canvas,source.canvas);
source.userState = { secret: 'PRIVATE_USER_STATE' };
source.events.push({ id: 'PRIVATE_EVENT_ID', source: 'agent', kind: 'test', summary: 'PRIVATE_DISCUSSION', at: 'today', revision: 1 });
const options = { board: source, boardId: source.id, expectedCanvasBase: { revision: source.canvas.revision, documentVersion: source.canvas.documentVersion }, publicData };
const release = buildRelease(options), second = buildRelease({ ...options, publicData: { ...publicData, label: 'Second version' } });
const fullDocument = buildRelease({ ...options, board: { ...source, canvas: { ...source.canvas, html: `<!doctype html><html lang="zh-CN" dir="rtl" class="release-document" style="--document-color:rgb(19,31,43);font-size:19px"><head><style>html.release-document body.full-body{background:var(--document-color)}#full-title{font-size:29px}</style><script>window.headBootstrap=board.getData().nested.value</script></head><body class="full-body"><h1 id="full-title">Full document</h1><script>window.fullReady=board.getData().nested.value===42</script></body></html>`, patches: [] } } });
const repository = new ReleaseRepository(join(temporary, 'releases'));
await repository.create(options); await repository.export(release.manifest.releaseId, { directory: join(temporary, 'export') });
const copies = new BoardCopies(join(temporary, 'copies'), store), request = { boardId: source.id, canvasBase: options.expectedCanvasBase, eventId: 'copy-browser-fixture', title: 'Manual publication copy' };
const copy = await copies.copy(request);
const editedCopy = await store.publish({ boardId: copy.id, expectedRevision: copy.revision, canvasBase: { revision: copy.canvas.revision, documentVersion: copy.canvas.documentVersion }, eventId: 'copy-manual-edit', patch: { id: 'copy-manual-patch', selector: '#final', operation: 'replace', html: '<h1 id="final">Manually edited copy</h1>' } });
const copyRelease = buildRelease({ ...options, board: editedCopy, boardId: editedCopy.id, expectedCanvasBase: { revision: editedCopy.canvas.revision, documentVersion: editedCopy.canvas.documentVersion } });
// Publish semantic edits through the real store before cold materialization.
// The browser below must use native disclosure/scrolling with no editor bridge.
let layoutBoard = await store.create({ id:'layout-publication',title:'Container publication',ownerAgentId:'owner',html:componentLayoutHtml,data:{} });
for (const [selector,layout] of [['#layout-target',{collapse:'contents',maxHeight:240}],['#layout-inner',{collapse:'contents',maxHeight:120}]]) {
  const authoring=describeAuthoring(layoutBoard.canvas);
  const document=new DOMParser().parseFromString(`<html><head></head><body>${authoring.materializedAuthoredHtml}</body></html>`,'text/html');
  const id=`public-layout-${layoutBoard.canvas.revision}`;
  layoutBoard=await store.edit({boardId:layoutBoard.id,canvasBase:authoring.canvasBase,eventId:id,patch:{id,operation:'layout',selector,sourceIdentity:componentIdentityFor(document.querySelector(selector)),layout}});
}
layoutBoard.userState={zoom:9,privateNote:'PRIVATE_LAYOUT_USER_STATE',__paseoContainerViews:{'1:public-layout-1':false,'1:PRIVATE_LAYOUT_VIEW':false}};
const layoutRelease=buildRelease({board:layoutBoard,boardId:layoutBoard.id,expectedCanvasBase:{revision:layoutBoard.canvas.revision,documentVersion:layoutBoard.canvas.documentVersion},publicData:{}});
assert.equal(JSON.stringify(layoutRelease.files).includes('PRIVATE_LAYOUT_USER_STATE'),false);
assert.equal(JSON.stringify(layoutRelease.files).includes('PRIVATE_LAYOUT_VIEW'),false);
const previewBundle = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ReleasePreview} from './client/release-web';createRoot(document.getElementById('app')).render(React.createElement(ReleasePreview,{html:window.releaseHtml}));`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false, define: { 'process.env.NODE_ENV': '"test"' } });
const files = new Map([['/', release.files['index.html']], ['/publication/nested/', release.files['index.html']], ['/second/', second.files['index.html']], ['/full/', fullDocument.files['index.html']], ['/copy/', copyRelease.files['index.html']], ['/layout/', layoutRelease.files['index.html']]]);
const requests = [];
let apiFixture, liveFixture;
const glassFixture = await createReleaseGlassFixture({ buildRelease, store, directory });
files.set('/glass/', glassFixture.release.files['index.html']);
const server = createServer((request, response) => {
  requests.push({ method: request.method, url: request.url });
  if (request.url === '/preview.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(previewBundle.outputFiles[0].text); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/preview') { response.end(`<!doctype html><div id="app"></div><script>window.releaseHtml=${JSON.stringify(release.files['index.html']).replace(/</g, '\\u003c')}</script><script src="/preview.js"></script>`); return; }
  if (request.url === '/api-preview') { response.end(`<!doctype html><div id="app"></div><script>window.releaseHtml=${JSON.stringify(apiFixture.release.files['index.html']).replace(/</g, '\\u003c')}</script><script src="/preview.js"></script>`); return; }
  if (request.url === '/live-preview') { response.end(`<!doctype html><div id="app"></div><script>window.releaseHtml=${JSON.stringify(liveFixture.release.files['index.html']).replace(/</g, '\\u003c')}</script><script src="/preview.js"></script>`); return; }
  if (request.url === '/glass-preview') { response.end(`<!doctype html><div id="app"></div><script>window.releaseHtml=${JSON.stringify(glassFixture.release.files['index.html']).replace(/</g, '\\u003c')}</script><script src="/preview.js"></script>`); return; }
  if (!files.has(request.url)) { response.writeHead(404).end(); return; }
  response.end(files.get(request.url));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const rejectedRequests = [], rejectedServer = createServer((request, response) => { rejectedRequests.push(request.url); response.end('This endpoint must never receive a publication request.'); });
await new Promise(resolve => rejectedServer.listen(0, '127.0.0.1', resolve));
const rejectedUrl = `http://127.0.0.1:${rejectedServer.address().port}/release-navigation`;
apiFixture = await createReleaseApiFixture({ buildRelease, options, origin, temporary, rejectedUrl });
files.set('/api/', apiFixture.release.files['index.html']);
liveFixture = await createLiveFixture({ buildRelease, options, origin, temporary, LiveDataPublisher });
files.set('/live/', liveFixture.release.files['index.html']); files.set('/live-unavailable/', liveFixture.unavailableRelease.files['index.html']);
const chrome = spawn(process.env.BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${join(temporary, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--use-mock-keychain', '--window-size=1000,800', 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let sequence = 0, buffer = '', passed = 0, contextEpoch = 0;
const commands = new Map(), contexts = new Map(), errors = [], networkRequests = new Map(), blockedRequests = [];
chrome.stdio[4].on('data', chunk => {
  buffer += chunk.toString(); let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.id && commands.has(message.id)) { const entry = commands.get(message.id); commands.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
    else if (message.method === 'Target.attachedToTarget') {
      const child = message.params.sessionId;
      void send('Runtime.enable', {}, child).then(() => send('Page.enable', {}, child)).then(() => send('Network.enable', {}, child)).then(() => send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, child)).catch(error => errors.push(String(error)));
    }
    else if (message.method === 'Runtime.executionContextCreated') { const context = message.params.context; if (context.auxData?.isDefault) contexts.set(`${message.sessionId}:${context.auxData.frameId}`, { id: context.id, frameId: context.auxData.frameId, sessionId: message.sessionId, epoch: ++contextEpoch }); }
    else if (message.method === 'Runtime.executionContextDestroyed') { for (const [key, context] of contexts) if (context.sessionId === message.sessionId && context.id === message.params.executionContextId) contexts.delete(key); }
    else if (message.method === 'Runtime.executionContextsCleared') { for (const [key, context] of contexts) if (context.sessionId === message.sessionId) contexts.delete(key); }
    else if (message.method === 'Network.requestWillBeSent') networkRequests.set(`${message.sessionId}:${message.params.requestId}`, message.params.request.url);
    else if (message.method === 'Network.loadingFailed') blockedRequests.push({ sessionId: message.sessionId, requestId: message.params.requestId, type: message.params.type, url: networkRequests.get(`${message.sessionId}:${message.params.requestId}`), reason: message.params.blockedReason, error: message.params.errorText });
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { commands.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15000); commands.set(id, { resolve, reject, timer }); chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); });
const check = name => { passed++; console.log(`PASS ${name}`); };
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }), { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  await command('Runtime.enable'); await command('Page.enable'); await command('Network.enable'); await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const evaluate = async (expression, context) => { const result = await send('Runtime.evaluate', { expression, contextId: context?.id, awaitPromise: true, returnByValue: true }, context?.sessionId ?? sessionId); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; };
  let authoredContext;
  const frame = expression => { if (!authoredContext) throw new Error('Release frame has not finished cold startup'); return evaluate(expression, authoredContext); };
  const ready = async (expression = 'window.ready', expected = {}) => {
    const deadline = Date.now() + 8000; authoredContext = undefined; let diagnostics;
    while (Date.now() < deadline) {
      const tree = (await command('Page.getFrameTree')).frameTree;
      if ((!expected.url || tree.frame.url === expected.url) && (!expected.loaderId || tree.frame.loaderId === expected.loaderId) && (!expected.notLoader || tree.frame.loaderId !== expected.notLoader)) {
        diagnostics = [];
        for (const context of [...contexts.values()]) {
          if (context.epoch <= (expected.afterEpoch ?? 0)) continue;
          try {
            const state = await evaluate(`({published:window.board?.getContext?.().published===true,ready:Boolean(${expression}),url:location.href,body:document.body?.innerText.slice(-200)})`, context);
            diagnostics.push(state);
            if (state.published && state.ready) { authoredContext = context; return; }
          } catch (error) { if (!/Cannot find context|Execution context was destroyed/.test(String(error))) throw error; }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Static release did not finish cold startup: ${JSON.stringify(diagnostics)}`);
  };
  const openAt = async (url, expression) => { const afterEpoch = contextEpoch, result = await command('Page.navigate', { url }); await ready(expression, { url, loaderId: result.loaderId, afterEpoch }); };
  const open = (path, expression) => openAt(origin + path, expression);
  const setHidden = async hidden => { const { windowId } = await send('Browser.getWindowForTarget', { targetId }); await send('Browser.setWindowBounds', { windowId, bounds: { windowState: hidden ? 'minimized' : 'normal' } }); };
  const click = async selector => {
    const box = await frame(`new Promise(resolve=>{const target=document.querySelector(${JSON.stringify(selector)});target.scrollIntoView({block:'nearest'});requestAnimationFrame(()=>requestAnimationFrame(()=>{const r=target.getBoundingClientRect();window.releaseClick=null;document.addEventListener('click',event=>{window.releaseClick={hit:target.contains(event.target),trusted:event.isTrusted,id:event.target.id}},{capture:true,once:true});resolve({x:r.x+r.width/2,y:r.y+r.height/2})}))})`);
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    const clicked = await frame("new Promise((resolve,reject)=>{const end=performance.now()+2000;const loop=()=>{if(window.releaseClick)return resolve(window.releaseClick);if(performance.now()>end)return reject(new Error('No trusted release click'));setTimeout(loop,20)};loop()})");
    assert.equal(clicked.trusted && clicked.hit, true, JSON.stringify({ selector, clicked, box }));
  };
  const publicFiles = JSON.stringify(release.files);
  for (const secret of ['PRIVATE_SOURCE_BOARD', 'PRIVATE_AGENT_ID', 'PRIVATE_CANVAS_DATA', 'PRIVATE_USER_STATE', 'PRIVATE_DISCUSSION', 'PRIVATE_PATCH_ID', 'PRIVATE_OLD_CONTENT']) assert.equal(publicFiles.includes(secret), false, secret);
  assert.equal((await store.read(source.id)).canvas.patches.at(-1).html.includes('Manually edited copy'), false);
  assert.equal((await copies.copy(request)).canvas.patches.at(-1).html.includes('Manually edited copy'), true);
  check('publication files contain final materialized content and explicit public data; an editable copy retains manual edits without changing its source');
  await open('/');
  assert.equal(await frame("document.querySelector('#final').textContent"), 'Final publication');
  assert.deepEqual(await frame('board.getData()'), publicData); assert.equal(await frame("document.querySelector('#unusual').textContent"), publicData.unusual);
  assert.equal(await frame('window.escapedFromData'), undefined); assert.equal(await evaluate('window.escapedFromData'), undefined);
  assert.deepEqual(await frame('window.watched.value'), 42); assert.equal(await frame('window.initialContext.published'), true);
  assert.deepEqual(await frame("(()=>{const values=[];board.watch('/nested/value',x=>values.push(x),{schedule:'sync'});board.watch('/nested/value',x=>values.push(x),{schedule:'frame'});return values})()"), [42, 42]);
  assert.equal(await frame("getComputedStyle(document.body).backgroundColor"), 'rgb(23, 46, 39)'); assert.equal(await frame("document.querySelector('#shape circle').getBBox().width"), 50);
  assert.equal(await frame('window.parentReadable'), false); assert.equal(await frame('window.privateStorage'), 'denied');
  check('standalone cold startup initializes data/watch before authored JS, preserves CSS and SVG, escapes bootstrap values and isolates private storage');
  const rootState = `({first:document.querySelector('#root-first')?.textContent,note:document.querySelector('#root-note')?.textContent,boots:window.rootPatchBoots,order:Boolean(document.querySelector('#root-first').compareDocumentPosition(document.querySelector('#final'))&Node.DOCUMENT_POSITION_FOLLOWING)})`;
  const expectedRoot = {first:'Prepended content',note:'Later journal patch retained',boots:1,order:true};
  assert.deepEqual(await frame(rootState),expectedRoot);
  await click('#root-button'); assert.equal(await frame("document.querySelector('#root-button').textContent"),'Root listener works');
  check('persisted body append/prepend journals and later edits cold-render in the exported viewer with their original interactive controls');
  await frame("document.querySelector('#input').value='Visitor draft'"); await click('#increment');
  await evaluate('new Promise(resolve=>setTimeout(resolve,20))'); const oldLoader = (await command('Page.getFrameTree')).frameTree.frame.loaderId, afterEpoch = contextEpoch; await command('Page.reload'); await ready(undefined, { notLoader: oldLoader, afterEpoch });
  assert.deepEqual(await frame('board.getState()'), { count: 1, input: 'Visitor draft' }); assert.equal(await frame('window.boots'), 1);
  assert.deepEqual(await frame(rootState),expectedRoot);
  await open('/publication/nested/'); assert.deepEqual(await frame('board.getState()'), {}); await click('#increment');
  await open('/second/'); assert.deepEqual(await frame('board.getState()'), {}); assert.equal(await frame("document.querySelector('#data').textContent"), 'Second version');
  await open('/'); assert.deepEqual(await frame('board.getState()'), { count: 1, input: 'Visitor draft' });
  check('visitor state survives a full reload and stays isolated by release and hosting subpath');
  await click('#submit'); assert.equal(await frame('window.localSubmits'), 1); assert.equal(await evaluate('location.pathname'), '/');
  await click('#ask'); assert.equal(await frame('window.askResult.status'), 'cancelled'); assert.match(await evaluate("document.querySelector('[role=status]').textContent"), /不连接 agent/);
  assert.equal(await frame("fetch('https://blocked.invalid/secret').then(()=>false,()=>true)"), true);
  await evaluate("window.postMessage({channel:'paseo-board-release-v1',type:'state',state:{forged:true}},'*')");
  assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify('paseo-board-release:' + release.manifest.releaseId + ':/')}))`), { count: 1, input: 'Visitor draft' });
  // Before-request CSP denial can omit requestWillBeSent (and therefore URL).
  // Associate only a new Document failure in this page/author session with the
  // single navigation attempted after its checkpoint, not earlier fetch errors.
  const assertBlockedNavigation = async (url, received) => {
    const navigationStart = blockedRequests.length, navigationSession = authoredContext.sessionId;
    await frame(`setTimeout(()=>{location.href=${JSON.stringify(url)}},0)`);
    const matchingDenial = () => blockedRequests.slice(navigationStart).find(request =>
      request.type === 'Document' && [navigationSession, sessionId].includes(request.sessionId) &&
      (!request.url || request.url === url) &&
      (request.reason === 'csp' || request.error === 'net::ERR_BLOCKED_BY_CSP'));
    const blockedDeadline = Date.now() + 2000;
    while (!matchingDenial() && received().length === 0 && Date.now() < blockedDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(received(), [], `Publication navigation reached its receiver: ${url}`);
    assert.ok(matchingDenial(), JSON.stringify(blockedRequests.slice(navigationStart)));
    assert.equal(await evaluate('location.href'), origin + '/');
    // Chrome can replace a CSP-blocked iframe with an error document. Check actual
    // zero receiver requests and the browser denial, then reopen a fresh document.
    console.log('MEASURE release-navigation', JSON.stringify({ target: new URL(url).origin === origin ? 'same-origin' : 'other-origin', received: received().length, blocked: matchingDenial() }));
  };
  await assertBlockedNavigation(rejectedUrl, () => rejectedRequests);
  await open('/');
  const sameOriginPath = '/release-same-origin-navigation?probe=1';
  await assertBlockedNavigation(origin + sameOriginPath, () => requests.filter(request => request.url === sameOriginPath));
  check('forms keep their local submit handler while navigation/network/agent actions and forged state messages cannot reach private services');
  await open('/full/', 'window.fullReady');
  assert.deepEqual(await frame("({language:document.documentElement.lang,direction:document.documentElement.dir,rootClass:document.documentElement.className,bodyClass:document.body.className,fontSize:getComputedStyle(document.documentElement).fontSize,headData:window.headBootstrap})"), {language:'zh-CN',direction:'rtl',rootClass:'release-document',bodyClass:'full-body',fontSize:'19px',headData:42});
  assert.equal(await frame("getComputedStyle(document.body).backgroundColor"), 'rgb(19, 31, 43)'); assert.equal(await frame("document.querySelector('#full-title').textContent"), 'Full document');
  await open('/copy/'); assert.equal(await frame("document.querySelector('#final').textContent"), 'Manually edited copy');
  assert.deepEqual(await frame(rootState),expectedRoot);
  await click('#root-button'); assert.equal(await frame("document.querySelector('#root-button').textContent"),'Root listener works');
  check('complete authored documents and manually edited publication copies cold-render through the same standalone viewer');
  await open('/layout/','window.layoutReady');
  assert.deepEqual(await frame('board.getState()'),{},'A new public visitor never inherits the working Board user state or fold namespace');
  assert.deepEqual(await frame("({boot:layoutBoots,disclosures:document.querySelectorAll('details[data-paseo-layout-key]').length,outer:getComputedStyle(document.querySelector('#layout-target > details > [data-paseo-layout-part=body]')).maxHeight,inner:getComputedStyle(document.querySelector('#layout-inner > details > [data-paseo-layout-part=body]')).maxHeight,heading:Boolean(document.querySelector('#layout-target > details > summary #layout-heading')),editor:Boolean(document.querySelector('[data-board-components]'))})"),{boot:1,disclosures:2,outer:'240px',inner:'120px',heading:true,editor:false});
  await click('#layout-button'); assert.equal(await frame('layoutClicks'),1);
  await click('#layout-inner > details > summary');
  assert.deepEqual(await frame("({outer:document.querySelector('#layout-target > details').open,inner:document.querySelector('#layout-inner > details').open})"),{outer:true,inner:false});
  await frame("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await click('#layout-target > details > summary');
  assert.equal(await frame("document.querySelector('#layout-target > details').open"),false);
  await click('#layout-author-save');assert.equal(await frame('board.getState().zoom'),1.75);
  assert.deepEqual(await frame("Object.values(board.getState().__paseoContainerViews)"),[false,false]);
  await click('#layout-author-save-stale');assert.equal(await frame('board.getState().zoom'),2.5);
  assert.deepEqual(await frame("Object.values(board.getState().__paseoContainerViews)"),[false,false]);
  await evaluate('new Promise(resolve=>setTimeout(resolve,50))');
  await open('/layout/','window.layoutReady');
  assert.deepEqual(await frame("({outer:document.querySelector('#layout-target > details').open,inner:document.querySelector('#layout-inner > details').open,boot:layoutBoots,zoom:board.getState().zoom})"),{outer:false,inner:false,boot:1,zoom:2.5});
  await click('#layout-target > details > summary'); await click('#layout-inner > details > summary');
  const layoutScroll=await frame("(()=>{const n=document.querySelector('#layout-target > details > [data-paseo-layout-part=body]');n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+Math.min(70,r.height/2)}})()");
  await command('Input.dispatchMouseEvent',{type:'mouseWheel',x:layoutScroll.x,y:layoutScroll.y,deltaX:0,deltaY:160});
  await frame("new Promise((resolve,reject)=>{const end=performance.now()+2000;const loop=()=>{if(document.querySelector('#layout-target > details > [data-paseo-layout-part=body]').scrollTop>0)return resolve(true);if(performance.now()>end)return reject(new Error('Published layout did not scroll'));setTimeout(loop,20)};loop()})");
  check('semantic layouts export without private view state; native nested disclosures and author-only/stale state saves preserve visitor folds and zoom across a full reload while scrolling and authored handlers remain usable');
  await open('/preview');
  assert.equal(await frame("document.querySelector('#final').textContent"), 'Final publication'); assert.deepEqual(await frame('board.getState()'), {});
  await frame("document.querySelector('#increment').click()"); assert.equal(await frame('window.count'), 1);
  assert.equal(await frame('window.parentReadable'), false);
  check('the actual host ReleasePreview renders the nested opaque exported viewer and keeps local interaction available without private Board access');
  await runReleaseApiChecks({ assert, command, evaluate, frame, open, click, ready, api: apiFixture, rejectedUrl, rejectedRequests, check });
  await runReleaseGlassChecks({ assert, command, evaluate, frame, open, check, glass: glassFixture });
  const nestedBanner = async () => { for (const context of [...contexts.values()]) { try { const text = await evaluate("document.querySelector('[data-live]')?.textContent||''", context); if (text) return text; } catch {} } return ''; };
  await runLiveChecks({ assert, frame, evaluate, open, openAt, setHidden, nestedBanner, live: liveFixture, check, pagePort: server.address().port });
  assert.deepEqual(errors, [], 'Unexpected browser runtime exception');
  console.log(`Static release browser integration: ${passed} checks passed.`);
} catch (error) { console.error('Release browser check failed:', error); console.error('Browser exceptions:', errors); process.exitCode = 1; }
finally {
  try { await send('Browser.close'); } catch { try { process.kill(-chrome.pid, 'SIGTERM'); } catch {} }
  if (chrome.exitCode === null) await new Promise(resolve => { const timer = setTimeout(() => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch {} resolve(); }, 3000); chrome.once('exit', () => { clearTimeout(timer); resolve(); }); });
  for (const entry of commands.values()) { clearTimeout(entry.timer); entry.reject(new Error('Browser closed')); } commands.clear();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => rejectedServer.close(resolve)), apiFixture.close(), liveFixture?.close()]); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
