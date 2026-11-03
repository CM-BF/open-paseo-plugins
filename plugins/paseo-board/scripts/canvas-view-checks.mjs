import assert from 'node:assert/strict';

/** Runs against the real CanvasFrame and runtime in browser-fixture.tsx, without a daemon. */
export async function runCanvasViewChecks({ evaluate, frame, update, command, until, untilFrame, baseHtml, check }) {
  const geometry = `<style>body{min-width:1800px;min-height:2600px}#resume-anchor{position:absolute;left:360px;top:1100px;width:500px;height:400px}#resume-log{width:280px;height:100px;overflow:auto}#resume-log>div{width:700px;height:800px}</style><section id="resume-anchor"><h2>Reading location</h2><div id="resume-log"><div>Long log</div></div></section>`;
  await evaluate(`window.viewChecks={views:[],finalViews:[],restores:[]};update({viewScope:JSON.stringify(['canvas-view-fixture',hostProps.boardId]),onViewState:view=>viewChecks.views.push(structuredClone(view)),onFinalViewState:view=>viewChecks.finalViews.push(structuredClone(view)),onViewRestored:result=>viewChecks.restores.push(result),focusInteraction:undefined,focusUpdate:undefined,composerActive:false,interactions:[],selectedInteractionId:undefined,selectionMode:'off'})`);
  const replace = async (resume, patches = [], html = baseHtml + geometry) => {
    const version = await evaluate('hostProps.canvas.documentVersion+1');
    const next = resume ? { ...resume, documentVersion: version } : undefined;
    const ready = await evaluate('results.ready');
    await update(`{resumeView:${JSON.stringify(next) ?? 'undefined'},canvas:{...hostProps.canvas,html:${JSON.stringify(html)},documentVersion:${version},revision:hostProps.canvas.revision+1,patches:${JSON.stringify(patches)}},boardRevision:hostProps.boardRevision+1}`);
    await until(`results.ready>${ready}`);
    return version;
  };
  await replace();
  await frame(`(()=>{scrollTo(220,1030);const log=document.querySelector('#resume-log');log.scrollLeft=90;log.scrollTop=310;return true})()`);
  await until('viewChecks.views.some(view=>view.x===220&&view.y===1030&&view.scrolls.some(item=>item.selector==="#resume-log"&&item.y===310))');
  const saved = await evaluate('viewChecks.views.at(-1)');
  const statesBefore = await evaluate('results.states.length');
  await evaluate('window.viewChecks.views=[];window.viewChecks.restores=[];update({resumeView:' + JSON.stringify(saved) + '});reconnect()');
  await until('viewChecks.restores.some(item=>item.status==="restored")');
  assert.deepEqual(await frame(`({x:scrollX,y:scrollY,logX:document.querySelector('#resume-log').scrollLeft,logY:document.querySelector('#resume-log').scrollTop})`), { x: 220, y: 1030, logX: 90, logY: 310 });
  assert.equal(await evaluate('results.states.length'), statesBefore, 'Reading position must not use author state writes');
  check('a real CanvasFrame remount restores both canvas axes and the log viewport without an author-state write');

  const pending = { ...saved, x: 0, y: 1600, anchor: undefined, scrolls: [] };
  const delayedModule = `const globalThis='module-local';const Event='module-local';export const moduleBinding=17;window.resumeModuleMeta=import.meta.url;window.moduleOrder.push('module-start');await new Promise(resolve=>setTimeout(resolve,450));window.resumePatchFinished=true;document.body.style.minHeight='3500px';window.moduleOrder.push('module-end');`;
  // This parser-inserted module uses the same srcdoc base and bypasses runScript.
  const nativeModule = `<script id="resume-native-module" type="module">window.resumeNativeModuleMeta=import.meta.url;</script>`;
  await evaluate('viewChecks.restores=[]');
  await replace(pending, [
    { id: 'view-delayed-journal', selector: 'body', operation: 'append', html: `<script>window.moduleOrder=['classic'];</script><script id="resume-module" type="module">${delayedModule}</script><script>window.moduleOrder.push('after-await');</script>` },
    { id: 'view-module-tail', selector: 'body', operation: 'append', html: `<script type="application/json">{"notExecutable":true}</script><script type="module">window.moduleOrder.push('plain-module');</script><div id="resume-after-journal">Final patch</div>` },
  ], baseHtml + geometry + nativeModule);
  assert.equal(await evaluate('viewChecks.restores.length'), 0);
  await untilFrame('window.resumePatchFinished===true');
  await until('viewChecks.restores.length===1');
  console.log('MEASURE asynchronous-view-restore', JSON.stringify({
    host: await evaluate('({restores:viewChecks.restores,props:{documentVersion:hostProps.canvas.documentVersion,revision:hostProps.canvas.revision,resumeView:hostProps.resumeView},raw:results.raw.filter(item=>["ready","view-restored","error","canvas-activity"].includes(item.type)).slice(-14),errors:results.errors.slice(-3)})'),
    frame: await frame('({context:board.getContext(),x:scrollX,y:scrollY,viewport:{width:innerWidth,height:innerHeight},document:{width:document.scrollingElement.scrollWidth,height:document.scrollingElement.scrollHeight},finished:window.resumePatchFinished,bodyHeight:getComputedStyle(document.body).minHeight})'),
  }));
  assert.deepEqual(await evaluate('viewChecks.restores'), [{ status: 'restored' }]);
  assert.equal(await frame('scrollY'), 1600);
  assert.deepEqual(await frame('window.moduleOrder'), ['classic', 'module-start', 'module-end', 'after-await', 'plain-module']);
  const nativeMeta = await frame('window.resumeNativeModuleMeta');
  assert.equal(typeof nativeMeta, 'string');
  assert.ok(nativeMeta.length > 0);
  assert.deepEqual(await frame(`({source:document.querySelector('#resume-module').textContent,meta:window.resumeModuleMeta,local:typeof window.moduleBinding,tail:!!document.querySelector('#resume-after-journal')})`), { source: delayedModule, meta: nativeMeta, local: 'undefined', tail: true });
  const replayReady = await evaluate('results.ready');
  await update('{boardRevision:hostProps.boardRevision+1}');
  await frame('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await evaluate('results.ready'), replayReady);
  assert.deepEqual(await frame('window.moduleOrder'), ['classic', 'module-start', 'module-end', 'after-await', 'plain-module']);
  check('reading restoration waits for module top-level await and ordered journal replay; module scope, source, import.meta and once-only execution survive');

  await evaluate('viewChecks.restores=[];viewChecks.views=[]');
  await replace(pending, [{ id: 'view-user-journal', selector: 'body', operation: 'append', html: `<script type="module">await new Promise(resolve=>setTimeout(resolve,450));window.resumePatchFinished=true;</script>` }]);
  const point = await evaluate(`(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return{x:r.left+300,y:r.top+300}})()`);
  await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: 180 });
  await until('viewChecks.restores.some(item=>item.status==="cancelled")');
  await untilFrame('window.resumePatchFinished===true');
  assert.ok(await frame('scrollY<1000'), 'An actual wheel overrides the pending saved position');
  assert.equal(await evaluate('viewChecks.restores.length'), 1);
  check('a trusted wheel during slow startup cancels the one-time restoration and retains the user location');

  await evaluate('viewChecks.restores=[];viewChecks.views=[];document.querySelector("iframe").style.display="none"');
  const ready = await evaluate('results.ready');
  await evaluate('update({resumeView:{...' + JSON.stringify(saved) + ',documentVersion:hostProps.canvas.documentVersion}});reconnect()');
  await until(`results.ready>${ready}`);
  // React creates a visible replacement; hide that exact new iframe while restoration waits.
  await evaluate('document.querySelector("iframe").style.display="none"');
  await until('viewChecks.restores.some(item=>item.status==="unavailable")', 5000);
  assert.equal(await evaluate('viewChecks.views.length'), 0, 'A zero-size frame must not replace saved reading position');
  await evaluate('document.querySelector("iframe").style.display="block"');
  await frame('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.equal(await evaluate('viewChecks.views.length'), 0, 'Merely showing an expired restore must not overwrite the prior saved position');
  check('a hidden frame has a bounded restore wait and showing it afterwards cannot silently replace the saved position');

  for (const position of ['fixed', 'sticky']) {
    await evaluate('viewChecks.restores=[];viewChecks.views=[]');
    const fixedHtml = baseHtml + geometry + `<aside id="resume-fixed" style="position:${position};top:0;left:0;width:1800px;height:100vh;z-index:10;background:#fff8">Pinned overlay</aside>`;
    await replace(undefined, [], fixedHtml);
    await frame('scrollTo(210,900);true');
    await until('viewChecks.views.some(item=>item.x===210&&item.y===900)');
    const fixedView = await evaluate('viewChecks.views.at(-1)');
    assert.equal(fixedView.anchor, undefined, `A ${position} ancestor cannot be a document-position anchor`);
    await evaluate('viewChecks.restores=[]');
    await replace({ ...fixedView, anchor: { selector: '#resume-fixed', offsetX: 0, offsetY: 0 } }, [], fixedHtml);
    await until('viewChecks.restores.some(item=>item.status==="restored")');
    assert.deepEqual(await frame('({x:scrollX,y:scrollY})'), { x: 210, y: 900 });
  }
  check('fixed or sticky anchor geometry cannot reset a previously scrolled document to zero');

  await evaluate('viewChecks.restores=[];viewChecks.views=[]');
  const future = await evaluate('hostProps.canvas.revision+5');
  await replace({ ...saved, canvasRevision: future });
  assert.equal(await evaluate('viewChecks.restores.length'), 0, 'Future canvas positions wait for the corresponding content');
  await update(`{canvas:{...hostProps.canvas,revision:${future}},boardRevision:hostProps.boardRevision+10}`);
  await until('viewChecks.restores.some(item=>item.status==="restored")');
  assert.equal(await frame('scrollY'), saved.y);
  check('a future canvas position waits for its snapshot revision before restoration');

  await evaluate('window.previousCanvasFrame=document.querySelector("iframe");window.previousCanvasWindow=previousCanvasFrame.contentWindow;viewChecks.restores=[]');
  const previousScope = await evaluate('results.raw.filter(item=>item.type==="ready").at(-1)');
  const replacementVersion = await replace(undefined);
  const replacementScope = await evaluate('results.raw.filter(item=>item.type==="ready").at(-1)');
  assert.notEqual(replacementScope.sessionId, previousScope.sessionId);
  assert.equal(await evaluate('document.querySelector("iframe")!==previousCanvasFrame&&document.querySelector("iframe").contentWindow!==previousCanvasWindow'), true);
  assert.equal(await frame('board.getContext().documentVersion'), replacementVersion);
  await evaluate('window.replacementCanvasFrame=document.querySelector("iframe");true');
  await update('{canvas:{...hostProps.canvas,data:{...hostProps.canvas.data,viewPatch:1}},boardRevision:hostProps.boardRevision+1}');
  await untilFrame('board.getData().viewPatch===1');
  assert.equal(await evaluate('document.querySelector("iframe")===replacementCanvasFrame'), true);
  check('a document replacement creates a new browsing context and scoped ready receipt, while later data updates retain its exact frame');

  await evaluate('viewChecks.restores=[];viewChecks.views=[]');
  await replace(saved);
  await until('viewChecks.restores.some(item=>item.status==="restored")');
  await until('viewChecks.views.some(item=>item.documentVersion===hostProps.canvas.documentVersion)');
  const accepted = await evaluate('viewChecks.views.length');
  const scope = await evaluate('results.raw.filter(item=>item.type==="ready").at(-1)');
  await frame(`(()=>{const scope=${JSON.stringify(scope)},view=${JSON.stringify(saved)};parent.postMessage({...scope,type:'view-state',view},'*');parent.postMessage({...scope,sessionId:'old-session',type:'view-state',view:{...view,documentVersion:board.getContext().documentVersion}},'*');return true})()`);
  await evaluate('new Promise(resolve=>setTimeout(resolve,50))');
  assert.equal(await evaluate('viewChecks.views.length'), accepted);
  check('stale document and session view reports cannot overwrite current reading state');

  for (const [label, source] of [
    ['syntax', 'export const invalid = ;'],
    ['evaluation', "window.failedModuleRuns=(window.failedModuleRuns||0)+1;throw new Error('expected module evaluation failure')"],
    ['await-rejection', "window.failedModuleRuns=(window.failedModuleRuns||0)+1;await Promise.reject(new Error('expected module await rejection'))"],
  ]) {
    const patchId = 'view-module-failure-' + label;
    await evaluate('viewChecks.restores=[];viewChecks.views=[]');
    await replace(pending, [
      { id: patchId, selector: 'body', operation: 'append', html: `<script id="resume-failed-module" type="module">${source}</script>` },
      { id: patchId + '-later', selector: 'body', operation: 'append', html: '<script>window.mustNotRunAfterModuleFailure=true;</script>' },
    ]);
    await until(`results.errors.some(error=>error.code==='patch-failed'&&error.patchId===${JSON.stringify(patchId)})`, 3000);
    await until('viewChecks.restores.some(item=>item.status==="unavailable")', 4000);
    assert.deepEqual(await frame(`({later:!!window.mustNotRunAfterModuleFailure,runs:window.failedModuleRuns||0,source:document.querySelector('#resume-failed-module').textContent})`), { later: false, runs: label === 'syntax' ? 0 : 1, source });
    await update('{boardRevision:hostProps.boardRevision+1}');
    await frame('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await frame('window.failedModuleRuns||0'), label === 'syntax' ? 0 : 1);
    assert.equal(await frame('!!window.mustNotRunAfterModuleFailure'), false);
  }
  check('inline-module syntax, evaluation and awaited rejection stop later journal entries, restore original source and never replay the failed script');
}
