import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Source-browser checks use the real iframe, native postMessage structured cloning and
// trusted Chromium input. The fixture adapts the host composer/result boundary only.
export async function runAuthoredCommentChecks({ evaluate, frame, update, command, click, key, until, untilFrame, baseHtml, check }) {
  const html = `<section id="comment-fixture" style="position:fixed;left:20px;top:20px;width:560px;padding:20px;z-index:10000;background:var(--host-sheet,#fff);color:var(--host-ink,#222)"><button id="authored-comment-button" type="button">Comment / 评论</button><p id="comment-target" style="margin-top:24px">A real authored comment target.</p><p id="comment-second" style="margin-top:28px">A second comment location.</p></section><script>
window.commentInput=()=>({prompt:'Comment on this element',anchor:document.querySelector('#comment-target')});
window.commentUseAlias=false;
window.commentAttempt=0;window.commentTrace=[];
const commentNode=node=>node instanceof Element?{tag:node.tagName,id:node.id}:node===window?{tag:'WINDOW'}:node===document?{tag:'DOCUMENT'}:null;
const commentDiagnostic=(phase,detail={})=>{
  const entry={phase,attempt:window.commentAttempt,at:performance.now(),focused:document.hasFocus(),active:commentNode(document.activeElement),activation:{isActive:navigator.userActivation?.isActive,hasBeenActive:navigator.userActivation?.hasBeenActive},...detail};
  window.commentTrace.push(entry);if(window.commentTrace.length>96)window.commentTrace.shift();
  parent.postMessage({channel:'authored-comment-diagnostic',entry},'*');
};
const commentEvent=(phase,event)=>commentDiagnostic(phase,{type:event.type,trusted:event.isTrusted,eventPhase:event.eventPhase,prevented:event.defaultPrevented,target:commentNode(event.target),path:event.composedPath().slice(0,6).map(commentNode),x:event.clientX,y:event.clientY,button:event.button,buttons:event.buttons,detail:event.detail,pointerId:event.pointerId,hit:Number.isFinite(event.clientX)?commentNode(document.elementFromPoint(event.clientX,event.clientY)):null});
// These listeners observe only. Runtime capture listeners were installed earlier;
// their stopImmediatePropagation can hide an event from this window observer.
for(const type of ['pointermove','mousemove','pointerdown','mousedown','pointerup','mouseup','click','pointercancel','gotpointercapture','lostpointercapture']){
  window.addEventListener(type,event=>commentEvent('window-capture',event),true);
  document.addEventListener(type,event=>commentEvent('document-capture',event),true);
  document.querySelector('#authored-comment-button').addEventListener(type,event=>commentEvent('button-capture',event),true);
  window.addEventListener(type,event=>commentEvent('window-bubble',event));
}
for(const type of ['focus','blur','focusin','focusout'])window.addEventListener(type,event=>commentEvent('focus-event',event),true);
window.addEventListener('message',event=>{if(event.source===parent&&event.data?.channel==='paseo-board-frame-v1')commentDiagnostic('host-message',{type:event.data.type,id:event.data.id,boardId:event.data.boardId,sessionId:event.data.sessionId})});
const commentSignal=value=>{commentDiagnostic('ask-settled',{status:value.result?.status,error:value.error,synchronous:value.synchronous});parent.postMessage({channel:'authored-comment-test',...value},'*')};
document.querySelector('#authored-comment-button').onclick=event=>{
  commentEvent('handler-enter',event);
  try {
    commentDiagnostic('ask-call',{alias:window.commentUseAlias});
    const promise=(window.commentUseAlias?openai.sendFollowUpMessage:board.ask)(window.commentInput());
    commentDiagnostic('ask-return',{thenable:typeof promise?.then==='function'});
    promise.then(result=>commentSignal({result}),error=>commentSignal({error:{name:error.name,message:error.message},synchronous:false}));
  } catch(error) {commentSignal({error:{name:error.name,message:error.message},synchronous:true});}
};
commentDiagnostic('fixture-installed',{context:board.getContext(),readyState:document.readyState});
</script>`;
  let lastAttempt = { number: 0, phase: 'setup' };
  let paintedDocumentVersion;
  let firstPaint;
  const twoFrames='new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))';
  const frameState = `(()=>{const button=document.querySelector('#authored-comment-button'),r=button?.getBoundingClientRect(),style=button&&getComputedStyle(button),x=r&&r.x+r.width/2,y=r&&r.y+r.height/2,describe=node=>node instanceof Element?{tag:node.tagName,id:node.id}:null;return{context:board.getContext(),readyState:document.readyState,visibility:document.visibilityState,focused:document.hasFocus(),active:describe(document.activeElement),activation:{isActive:navigator.userActivation?.isActive,hasBeenActive:navigator.userActivation?.hasBeenActive},viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY},button:button&&{connected:button.isConnected,disabled:button.disabled,inert:!!button.closest('[inert]'),handler:typeof button.onclick,box:{x:r.x,y:r.y,width:r.width,height:r.height},center:{x,y},display:style.display,visibility:style.visibility,pointerEvents:style.pointerEvents,opacity:style.opacity,hit:describe(document.elementFromPoint(x,y)),hitButton:button.contains(document.elementFromPoint(x,y)),hitStack:document.elementsFromPoint(x,y).slice(0,6).map(describe)},trace:window.commentTrace?.slice(-96)}})()`;
  const hostState = `(()=>{const f=document.querySelector('iframe'),r=f?.getBoundingClientRect(),describe=node=>node instanceof Element?{tag:node.tagName,id:node.id}:null;return{ready:window.results?.ready,readyState:document.readyState,visibility:document.visibilityState,focused:document.hasFocus(),active:describe(document.activeElement),activation:{isActive:navigator.userActivation?.isActive,hasBeenActive:navigator.userActivation?.hasBeenActive},scope:{boardId:window.hostProps?.boardId,documentVersion:window.hostProps?.canvas?.documentVersion,canvasRevision:window.hostProps?.canvas?.revision,boardRevision:window.hostProps?.boardRevision,selectionMode:window.hostProps?.selectionMode},frame:f&&{connected:f.isConnected,box:{x:r.x,y:r.y,width:r.width,height:r.height},clientLeft:f.clientLeft,clientTop:f.clientTop,offsetWidth:f.offsetWidth,offsetHeight:f.offsetHeight,sandbox:f.sandbox.value},composer:!!document.querySelector('#authored-comment-composer'),manual:window.manualAuthoredAsks,asks:window.results?.asks.length,signals:window.authoredCommentSignals?.slice(-3),trace:window.authoredCommentTrace?.slice(-96),nativeEvents:window.authoredHostEvents?.slice(-32),messages:window.authoredFrameMessages?.slice(-24),raw:window.results?.raw.slice(-12).map(m=>({type:m.type,id:m.id,boardId:m.boardId,sessionId:m.sessionId})),errors:window.results?.errors.slice(-3),bridge:window.fixtureTransportDiagnostics?.()}})()`;
  const bounded = async operation => {
    let timer;
    try { return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('diagnostic deadline (3s)')),3000)})]); }
    catch (error) { return { diagnosticError: String(error) }; }
    finally { clearTimeout(timer); }
  };
  try {
  await evaluate(`window.authoredCommentSignals=[];window.authoredCommentTrace=[];window.authoredFrameMessages=[];window.authoredHostEvents=[];window.manualAuthoredAsks=true;window.authoredSubmitStatus='submitted';
    window.addEventListener('message',event=>{
      if(event.source!==document.querySelector('iframe')?.contentWindow)return;
      const data=event.data;
      if(data?.channel==='authored-comment-test')authoredCommentSignals.push(data);
      if(data?.channel==='authored-comment-diagnostic'){authoredCommentTrace.push(data.entry);if(authoredCommentTrace.length>96)authoredCommentTrace.shift()}
      if(data?.channel==='paseo-board-frame-v1'){authoredFrameMessages.push({type:data.type,id:data.id,boardId:data.boardId,sessionId:data.sessionId,kind:data.request?.kind,anchorKind:data.request?.anchor?.kind,at:performance.now()});if(authoredFrameMessages.length>24)authoredFrameMessages.shift()}
    });
    for(const type of ['pointermove','mousemove','pointerdown','mousedown','pointerup','mouseup','click','focus','blur'])window.addEventListener(type,event=>{authoredHostEvents.push({type,trusted:event.isTrusted,target:{tag:event.target?.tagName,id:event.target?.id},focused:document.hasFocus(),x:event.clientX,y:event.clientY,buttons:event.buttons,at:performance.now()});if(authoredHostEvents.length>32)authoredHostEvents.shift()},true);true`);
  const initialFrame = await evaluate('({ready:results.ready,documentVersion:hostProps.canvas.documentVersion})');
  await update(`{selectionMode:'off',interactions:[],selectedInteractionId:undefined,boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,html:${JSON.stringify(baseHtml + html)},patches:[],revision:hostProps.canvas.revision+1,documentVersion:hostProps.canvas.documentVersion+1}}`);
  // A version change replaces the iframe document. A fixture request sent before the
  // new ready handshake can be lost with the departing document and never reply.
  await until(`results.ready===${initialFrame.ready + 1}&&hostProps.canvas.documentVersion===${initialFrame.documentVersion + 1}`);
  await untilFrame("Boolean(document.querySelector('#authored-comment-button'))");
  const context = await frame('board.getContext()');
  assert.equal(context.documentVersion, initialFrame.documentVersion + 1);
  const latestSignal = () => evaluate('authoredCommentSignals.at(-1)');
  // The fixture bridge clones evaluation results; setup must not return a function.
  const configure = code => frame(`${code}; true`);
  const clickAuthored = async label => {
    lastAttempt = { number: lastAttempt.number + 1, label, phase: 'preconditions' };
    // Bring the actual CDP target forward; native input supplies focus and user
    // activation to the iframe. Never synthesize a click or call board.ask here.
    await command('Page.bringToFront');
    await until("document.visibilityState==='visible'&&document.hasFocus()",3000);
    await frame(twoFrames);
    await evaluate(twoFrames);
    if(paintedDocumentVersion!==context.documentVersion){
      lastAttempt.phase='paint-new-iframe';
      // A ready message/DOM hit test precedes Chromium's composited input surface.
      // Match the real host harness's screenshot barrier, then let both renderer
      // surfaces advance. Native hover below, not this screenshot, proves routing.
      const screenshot=await command('Page.captureScreenshot',{format:'png',fromSurface:true});
      assert.ok(screenshot.data,'native Comment precondition: composed screenshot');
      firstPaint=Buffer.from(screenshot.data,'base64');
      await Promise.all([frame(twoFrames),evaluate(twoFrames)]);
      paintedDocumentVersion=context.documentVersion;
    }
    lastAttempt.paint={documentVersion:paintedDocumentVersion,pngBytes:firstPaint?.length};
    lastAttempt.phase='geometry';
    const canvas = await frame(frameState);
    const host = await evaluate(hostState);
    lastAttempt.before = { canvas, host };
    assert.equal(host.scope.selectionMode,'off','native Comment precondition: host selection mode');
    assert.equal(host.ready,initialFrame.ready+1,'native Comment precondition: ready generation');
    assert.equal(host.composer,false,'native Comment precondition: composer already open');
    assert.equal(canvas.context.boardId,host.scope.boardId,'native Comment precondition: Board scope');
    assert.equal(canvas.context.documentVersion,host.scope.documentVersion,'native Comment precondition: document scope');
    assert.equal(canvas.context.boardRevision,host.scope.boardRevision,'native Comment precondition: Board revision');
    assert.equal(canvas.context.canvasRevision,host.scope.canvasRevision,'native Comment precondition: canvas revision');
    assert.ok(canvas.button?.connected&&!canvas.button.disabled&&!canvas.button.inert,'native Comment precondition: enabled attached button');
    assert.equal(canvas.button.handler,'function','native Comment precondition: authored handler installed');
    assert.ok(canvas.button.box.width>0&&canvas.button.box.height>0&&canvas.button.visibility==='visible'&&canvas.button.display!=='none'&&canvas.button.pointerEvents!=='none'&&Number(canvas.button.opacity)>0,'native Comment precondition: visible pointer target');
    assert.ok(canvas.button.hitButton,'native Comment precondition: iframe hit reaches button');
    const center=canvas.button.center;
    assert.ok(center.x>=0&&center.y>=0&&center.x<canvas.viewport.width&&center.y<canvas.viewport.height,'native Comment precondition: center inside iframe viewport');
    assert.ok(host.frame?.connected&&host.frame.offsetWidth>0&&host.frame.offsetHeight>0,'native Comment precondition: attached iframe');
    const x=host.frame.box.x+(host.frame.clientLeft+center.x)*host.frame.box.width/host.frame.offsetWidth;
    const y=host.frame.box.y+(host.frame.clientTop+center.y)*host.frame.box.height/host.frame.offsetHeight;
    const hit=await evaluate(`(()=>{const hit=document.elementFromPoint(${x},${y});return{isFrame:hit===document.querySelector('iframe'),tag:hit?.tagName,id:hit?.id}})()`);
    lastAttempt.point={x,y,hit};
    assert.ok(hit.isFrame,'native Comment precondition: host hit reaches current iframe');
    await configure(`window.commentAttempt=${lastAttempt.number};commentDiagnostic('armed')`);
    lastAttempt.phase='native-hover';
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'none',buttons:0,modifiers:0,pointerType:'mouse'});
    // Do not click while the input router still targets the host's IFRAME element.
    // A single native move must actually arrive at the child button first. This
    // only observes dispatch; no synthetic DOM event or user activation is added.
    const hoverPredicate=`entry.attempt===${lastAttempt.number}&&entry.phase==='button-capture'&&['pointermove','mousemove'].includes(entry.type)&&entry.trusted&&entry.buttons===0&&entry.target?.id==='authored-comment-button'&&entry.hit?.id==='authored-comment-button'`;
    await until(`authoredCommentTrace.some(entry=>${hoverPredicate})`,3000);
    lastAttempt.nativeHover=await evaluate(`authoredCommentTrace.find(entry=>${hoverPredicate})`);
    lastAttempt.phase='native-click';
    // Exactly one native press/release, with no second move or click retry.
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1,modifiers:0,pointerType:'mouse'});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1,modifiers:0,pointerType:'mouse'});
    lastAttempt.phase='await-handler';
    await until(`authoredCommentTrace.some(entry=>entry.attempt===${lastAttempt.number}&&entry.phase==='handler-enter')`,3000);
    const entered=await evaluate(`authoredCommentTrace.find(entry=>entry.attempt===${lastAttempt.number}&&entry.phase==='handler-enter')`);
    assert.equal(entered.trusted,true,'authored Comment must receive trusted native input');
    assert.equal(entered.activation.isActive,true,'authored Comment must receive transient user activation');
    assert.equal(entered.target?.id,'authored-comment-button','authored Comment native target');
    lastAttempt.phase='await-result';
  };
  const open = async () => {
    const signalCount = await evaluate('authoredCommentSignals.length');
    const askCount = await evaluate('results.asks.length');
    await clickAuthored('open-composer');
    await until(`Boolean(document.querySelector('#authored-comment-composer')) || authoredCommentSignals.length>${signalCount}`);
    const signal = await latestSignal();
    if (await evaluate(`authoredCommentSignals.length>${signalCount}`)) {
      const error = signal?.error;
      // Chromium names the concrete DOM class (for example HTMLParagraphElement).
      if (error?.name === 'DataCloneError' && /\bHTML[A-Za-z]*Element object could not be cloned\b/.test(error.message)) {
        throw new Error(`AUTHORED_COMMENT_CLONE_REPRODUCED: ${error.message}`);
      }
      assert.fail(`Comment did not open a composer: ${JSON.stringify(signal)}`);
    }
    assert.equal(await evaluate('results.asks.length'), askCount + 1);
    return evaluate('structuredClone(results.asks.at(-1))');
  };
  const finish = async (action, expected) => {
    const signalCount = await evaluate('authoredCommentSignals.length');
    await key(action);
    await until(`authoredCommentSignals.length===${signalCount + 1}&&!document.querySelector('#authored-comment-composer')`);
    assert.deepEqual((await latestSignal()).result, expected);
  };
  const direct = await open();
  assert.equal(direct.anchor.kind, 'element');
  assert.equal(direct.anchor.selector, '#comment-target');
  assert.equal(direct.anchor.binding.target.id, 'comment-target');
  assert.equal(direct.anchor.boardRevision, context.boardRevision);
  assert.equal(direct.anchor.canvasRevision, context.canvasRevision);
  assert.deepEqual(direct.anchor.rect, await frame("(()=>{const r=document.querySelector('#comment-target').getBoundingClientRect();return{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}})()"));
  await finish('Escape', { status: 'cancelled', outcome: null });
  check('trusted authored Comment accepts an HTMLElement, delivers a cloneable bound reference and returns native composer cancellation');

  await configure("window.commentUseAlias=true;window.commentInput=()=>({prompt:'Wrapped target comment',kind:'change',anchor:{target:document.querySelector('#comment-second'),kind:'element',text:'Second location'}})");
  const wrapped = await open();
  assert.equal(wrapped.anchor.selector, '#comment-second');
  assert.equal(wrapped.anchor.binding.target.id, 'comment-second');
  assert.equal(wrapped.anchor.text, 'Second location');
  await finish('Enter', { status: 'submitted', outcome: 'saved' });
  check('the authored follow-up alias accepts an explicit target wrapper and returns a submitted result after native Enter');

  await configure("window.commentUseAlias=false;window.commentInput=()=>({prompt:'Retain old reference',anchor:{kind:'point',boardRevision:0,canvasRevision:0,selector:'#comment-target',rect:{x:11,y:12,width:0,height:0,element:document.querySelector('#comment-target')},viewport:{width:800,height:600,scrollX:4,scrollY:6,target:document.body},target:document.body,metadata:document.querySelector('#comment-target')}})");
  const old = await open();
  assert.deepEqual(old.anchor, { kind:'point', boardRevision:0, canvasRevision:0, selector:'#comment-target', rect:{x:11,y:12,width:0,height:0}, viewport:{width:800,height:600,scrollX:4,scrollY:6} });
  await finish('Escape', { status: 'cancelled', outcome: null });
  check('complete plain references retain old semantic versions and geometry while extra DOM fields never cross native postMessage');

  const malformed = [
    "({prompt:'Bad kind',kind:document.body})",
    "({prompt:'Disconnected',anchor:document.createElement('p')})",
    "({prompt:'Foreign',anchor:{target:document.implementation.createHTMLDocument('foreign').body.appendChild(document.createElement('p'))}})",
    "({prompt:'Wrong wrapper kind',anchor:{target:document.querySelector('#comment-target'),kind:'point'}})",
    "({prompt:'Bad text',anchor:{target:document.querySelector('#comment-target'),text:'x'.repeat(12001)}})",
    "({prompt:'Core DOM',anchor:{kind:'element',boardRevision:0,canvasRevision:0,selector:document.querySelector('#comment-target')}})",
    "({prompt:'Core size',anchor:{kind:'point',boardRevision:0,canvasRevision:0,rect:{x:1,y:2,width:document.body,height:0}}})",
    "({prompt:'Core pixels',anchor:{kind:'board',boardRevision:0,canvasRevision:0,image:{mimeType:'image/png',data:document.body}}})",
    "({prompt:'Core binding',anchor:{kind:'point',boardRevision:0,canvasRevision:0,binding:{documentVersion:0,key:'bad',target:document.body,ancestors:[],relative:{x:0,y:0}}}})",
  ];
  for (const input of malformed) {
    await configure(`window.commentInput=()=>${input}`);
    const before = await evaluate('({signals:authoredCommentSignals.length,asks:results.asks.length})');
    await clickAuthored('reject-malformed-anchor');
    await until(`authoredCommentSignals.length===${before.signals + 1}`);
    const signal = await latestSignal();
    assert.equal(signal.error?.name, 'TypeError');
    assert.equal(signal.synchronous, false);
    assert.match(signal.error.message, /board\.ask/);
    assert.equal(await evaluate('results.asks.length'), before.asks);
    assert.equal(await evaluate("Boolean(document.querySelector('#authored-comment-composer'))"), false);
  }
  await configure("window.commentInput=()=>({prompt:'Valid after rejected references',anchor:document.querySelector('#comment-target')})");
  await open();
  await finish('Escape', { status:'cancelled', outcome:null });
  check('invalid core data and disconnected or foreign targets reject asynchronously without opening a composer or exhausting ask slots');

  await evaluate("window.authoredSubmitStatus='queued'");
  for (let index = 0; index < 9; index++) {
    await open();
    await finish('Enter', { status:'queued', outcome:'已加入待发送列表，尚未发送给 agent' });
  }
  check('queued acknowledgements release every pending ask and report staging truthfully across more than eight successive authored comments');

  const anchor = direct.anchor;
  const markerId = (parent, comment) => `@comment:${parent.length}:${parent}:${comment}`;
  const batch = { id:'comment-batch',kind:'change',text:'Two changes',status:'answered',createdAt:'2026-01-01',updatedAt:'2026-01-01',resultReferences:[],comments:[{id:'first',text:'First target',anchor},{id:'second',text:'Second target',anchor:wrapped.anchor}] };
  await update(`{interactions:[${JSON.stringify(batch)}],selectedInteractionId:undefined}`);
  await untilFrame("document.querySelector('[data-board-markers]')?.shadowRoot.querySelectorAll('button').length===2");
  assert.deepEqual(await frame("Array.from(document.querySelector('[data-board-markers]').shadowRoot.querySelectorAll('.face'),node=>node.textContent)"), ['1.1','1.2']);
  for (const comment of batch.comments) {
    const id = markerId(batch.id, comment.id);
    const before = await evaluate('results.openedInteractions.length');
    await click(`[data-board-interaction=${JSON.stringify(id)}]`);
    await until(`results.openedInteractions.length===${before + 1}`);
    assert.equal((await evaluate('results.openedInteractions.at(-1)')).id, id);
    await until(`results.interactionPositions.some(position=>position.id===${JSON.stringify(id)})`);
  }
  const followup = { ...batch, id:'comment-followup',comments:undefined,kind:'reply',sourceInteractionId:batch.id,status:'processing',createdAt:'2026-01-02' };
  await update(`{interactions:[${JSON.stringify(batch)},${JSON.stringify(followup)}]}`);
  await untilFrame("Array.from(document.querySelector('[data-board-markers]').shadowRoot.querySelectorAll('button')).every(node=>node.dataset.status==='processing')");
  assert.equal(await frame("document.querySelector('[data-board-markers]').shadowRoot.querySelectorAll('button').length"), 2);
  check('two native comment markers display 1.1/1.2, preserve distinct click and position receipts, and inherit one follow-up status');

  await configure("window.commentInput=()=>({prompt:'Board control cannot be a target',anchor:document.querySelector('[data-board-markers]')})");
  const signals = await evaluate('authoredCommentSignals.length');
  await clickAuthored('reject-board-overlay');
  await until(`authoredCommentSignals.length===${signals + 1}`);
  assert.match((await latestSignal()).error?.message ?? '', /outside Board controls/);
  check('an explicit Board overlay target is refused instead of being rebound to unrelated canvas content');
  await evaluate('window.manualAuthoredAsks=false;window.authoredSubmitStatus=undefined');
  } catch (failure) {
    const [host,canvas]=await Promise.all([bounded(()=>evaluate(hostState)),bounded(()=>frame(frameState))]);
    const diagnostic={revision:'authored-click-path-2',failure:String(failure),lastAttempt,host,canvas,observerLimit:'Iframe diagnostic capture listeners run after runtime capture listeners; stopImmediatePropagation may prevent observation. Host message receipts and native mousedown/up remain separate evidence.'};
    console.error('AUTHORED_COMMENT_CLICK_DIAGNOSTICS',JSON.stringify(diagnostic));
    try {
      const root=process.env.BOARD_AUTHORED_SCREENSHOT_DIR||tmpdir();
      await mkdir(root,{recursive:true});
      const directory=await mkdtemp(join(root,'authored-comment-failure-'));
      await writeFile(join(directory,'diagnostics.json'),JSON.stringify(diagnostic,null,2)+'\n');
      if(firstPaint)await writeFile(join(directory,'before-input.png'),firstPaint);
      const screenshot=await bounded(()=>command('Page.captureScreenshot',{format:'png'}));
      if(screenshot.data)await writeFile(join(directory,'failure.png'),Buffer.from(screenshot.data,'base64'));
      else await writeFile(join(directory,'screenshot-error.json'),JSON.stringify(screenshot));
      console.error('ARTIFACT authored-comment-failure',directory);
    } catch(error) { console.error('Authored Comment artifact error:',String(error)); }
    throw failure;
  }
}
