import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { componentDragHtml } from './component-drag-fixture.mjs';

// Native Chromium gestures against CanvasFrame. Only the enclosing host approval
// callback is adapted; accepted semantics pass through the real source preparer.
export async function runComponentDragChecks({ evaluate, frame, update, command, click, clickPoint, location, key, until, untilFrame, settleFrame, setReducedMotion, profile, directory, check }) {
  const bundled = await build({ stdin: { contents: 'export { prepareComponentPatch, describeAuthoring } from "./server/authored-source";', resolveDir: join(directory, '..'), loader: 'ts' }, bundle:true, platform:'node', format:'cjs', write:false });
  const modulePath=join(profile,'component-drag-server.cjs'); await writeFile(modulePath,bundled.outputFiles[0].text);
  const {prepareComponentPatch,describeAuthoring}=createRequire(import.meta.url)(modulePath);
  const panel="document.querySelector('[data-board-components]')?.shadowRoot";
  const overlay="document.querySelector('[data-board-component-drag-preview]')";
  const line="document.querySelector('[data-board-component-drop-line]')";
  const sourceHtml=()=>frame("document.querySelector('#drag-fixture')?.outerHTML||Array.from(document.querySelectorAll('body > .drag-card,body > #drag-nest'),n=>n.outerHTML).join('')");
  const order=(parent='#drag-list')=>frame(`Array.from(document.querySelector(${JSON.stringify(parent)}).children,n=>n.id)`);
  const rect=selector=>frame(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}})()`);
  let pressed=false,lastPoint,fixtureRun=0;
  const stage=async value=>{console.log('STAGE drag',value);await evaluate(`window.componentDragStage=${JSON.stringify(value)}`)};
  const screenshot=async name=>{if(!process.env.BOARD_DRAG_SCREENSHOT_DIR)return;await mkdir(process.env.BOARD_DRAG_SCREENSHOT_DIR,{recursive:true});const result=await command('Page.captureScreenshot',{format:'png'});const file=join(process.env.BOARD_DRAG_SCREENSHOT_DIR,name+'.png');await writeFile(file,Buffer.from(result.data,'base64'));console.log('ARTIFACT drag-screenshot',file)};
  const reset=async mode=>{
    const label=`${++fixtureRun}-${mode}`;await stage('reset-'+label);
    if(pressed){await key('Escape');await release()}
    await key('Escape');await key('Escape');
    const ready=await evaluate('results.ready');
    await update(`{boardId:'drag-browser',boardRevision:1,userState:{unrelated:'kept'},interactions:[],selectedInteractionId:null,selectionMode:'off',height:700,canvas:{html:${JSON.stringify(componentDragHtml(mode))},data:{n:0},patches:[],revision:1,documentVersion:hostProps.canvas.documentVersion+1}}`);
    await until(`results.ready===${ready+1}`);await stage('frame-bridge-and-heap-'+label);await untilFrame('window.dragFixtureBridgeReady&&window.dragFixtureReady&&Boolean(window.dragInnerToken)');await settleFrame();await stage('ready-'+label);
    return sourceHtml();
  };
  const pick=async selector=>{
    await key('Escape');await update("{selectionMode:'off'}");
    await frame(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);await settleFrame();
    const box=await location(selector),x=box.x+5,y=box.y+5;
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,modifiers:12});
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1,modifiers:12});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1,modifiers:12});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Shift',code:'ShiftLeft',modifiers:0});
    await untilFrame(`${panel}?.querySelector('[aria-current=true]')?.textContent===${JSON.stringify(selector)}`);
  };
  const move=async point=>{lastPoint=point;await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y,button:'left',buttons:1});};
  const begin=async(selector,destination)=>{
    await stage('select-'+selector);await pick(selector);const point=typeof destination==='function'?await destination():destination;const box=await location(selector);const start={x:box.x+8,y:box.y+8};
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',...start});
    await command('Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',clickCount:1});pressed=true;
    await move(point);await settleFrame();
  };
  const release=async()=>{if(!pressed)return;await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:lastPoint.x,y:lastPoint.y,button:'left',clickCount:1});pressed=false;await settleFrame();};
  const edge=async(selector,kind)=>{const b=await location(selector);return kind==='top'?{x:b.x+b.width/2,y:b.y+3}:kind==='bottom'?{x:b.x+b.width/2,y:b.y+b.height-3}:kind==='left'?{x:b.x+3,y:b.y+b.height/2}:{x:b.x+b.width-3,y:b.y+b.height/2};};
  const gap=async(a,b,axis='y')=>{const first=await location(a),second=await location(b);return axis==='x'?{x:(first.x+first.width+second.x)/2,y:second.y+second.height/2}:{x:second.x+second.width/2,y:(first.y+first.height+second.y)/2};};
  const propose=async()=>{await stage('release-and-stage-proposal');const index=await evaluate('results.componentEdits.length');await release();await until(`results.componentEdits.length===${index+1}`);return {index,request:await evaluate(`results.componentEdits[${index}]`)};};
  const cancel=async draft=>{await evaluate(`finishComponentEdit(${draft.index},{status:'cancelled'})`);await settleFrame();await key('Escape');};
  const commit=async draft=>{
    const canvas=await evaluate('hostProps.canvas'),revision=canvas.revision+1;
    assert.deepEqual(draft.request.canvasBase,{revision:canvas.revision,documentVersion:canvas.documentVersion});
    const patch=prepareComponentPatch(canvas,{...draft.request.patch,id:`drag-commit-${draft.index}`,html:''});
    await update(`{boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:${revision},patches:[...hostProps.canvas.patches,${JSON.stringify(patch)}]}}`);
    await evaluate(`finishComponentEdit(${draft.index},{status:'applied',canvasRevision:${revision}})`);
    await untilFrame(`board.getContext().canvasRevision===${revision}`);await settleFrame();
    assert.equal(describeAuthoring(await evaluate('hostProps.canvas')).replay.complete,true);
    return patch;
  };
  const isBetween=(patch,a,b)=>patch.position==='after'&&patch.destination===a||patch.position==='before'&&patch.destination===b;
  const preview=()=>frame(`(()=>{const host=${overlay},shadow=host?.shadowRoot,placeholder=shadow?.querySelector('[data-board-drag-placeholder]'),r=placeholder?.getBoundingClientRect();return {present:Boolean(host),position:host?.dataset.position,destination:host?.dataset.destination,orientation:host?.dataset.orientation,motion:host?.dataset.motion,inert:shadow?.querySelector('[data-board-preview-root]')?.inert,pointerEvents:host?getComputedStyle(host).pointerEvents:null,placeholder:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,order:shadow?Array.from(shadow.querySelector('#drag-list')?.children||[],n=>n.id):[],scripts:shadow?.querySelectorAll('script,[onclick]').length,animations:shadow?Array.from(shadow.querySelectorAll('*')).flatMap(n=>n.getAnimations().map(a=>({duration:a.effect?.getTiming().duration,playState:a.playState}))):[],line:${line}?{position:${line}.dataset.position,destination:${line}.dataset.destination,orientation:${line}.dataset.orientation,width:${line}.getBoundingClientRect().width,height:${line}.getBoundingClientRect().height}:null}})()`);
  const waitPreview=async(settled=true)=>{await untilFrame(`Boolean(${overlay}?.shadowRoot?.querySelector('[data-board-drag-placeholder]'))`);if(settled)await untilFrame(`!Array.from(${overlay}.shadowRoot.querySelectorAll('*')).some(n=>n.getAnimations().some(a=>a.playState==='running'))`,2500);return preview();};
  const nativeInput=async text=>{await click('#drag-input');await command('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',commands:['selectAll']});await command('Input.insertText',{text});await command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});};
  const identity=()=>frame(`({nodes:Object.entries(dragNodes).every(([id,n])=>document.getElementById(id)===n),iframeWindow:document.querySelector('#drag-frame').contentWindow===dragWindow,token:dragInnerToken,boots:dragBoots,heap:dragHeap===dragHeapOriginal,value:document.querySelector('#drag-input').value,focus:document.activeElement===document.querySelector('#drag-input'),start:document.querySelector('#drag-input').selectionStart,end:document.querySelector('#drag-input').selectionEnd})`);

  // This first check intentionally uses no new UI hooks: the old implementation
  // produces append at the same trusted edge drop, preserving a causal baseline.
  let original=await reset('column');await nativeInput('Live native draft');
  await begin('#drag-card-c',()=>edge('#drag-card-b','top'));
  const first=await propose();
  console.log('MEASURE natural-drag-edge',JSON.stringify({selector:first.request.patch.selector,destination:first.request.patch.destination,position:first.request.patch.position}));
  assert.equal(first.request.patch.destination,'#drag-card-b');assert.equal(first.request.patch.position,'before','Automatic pointer sibling insertion: expected before, rather than append, at the native sibling top edge');
  assert.equal(await sourceHtml(),original,'A drop stages a semantic edit without changing authored DOM');
  assert.deepEqual(await order(),['drag-card-a','drag-card-b','drag-card-c','drag-card-d']);
  // The adapted host review may restore the original input's focus before it
  // applies its approved result, just as the real host does after a modal closes.
  await click('[data-component-action="preview-toggle"]');await nativeInput('Still live before approval');
  const before=await identity();await commit(first);const after=await identity();
  assert.deepEqual(after,before);assert.deepEqual(await order(),['drag-card-a','drag-card-c','drag-card-b','drag-card-d']);
  await key('Escape');await click('#drag-button');assert.equal(await frame('dragClicks'),1);
  assert.ok((await frame('dragNativeEvents')).filter(e=>['pointerdown','pointerup'].includes(e.type)).every(e=>e.trusted));
  check('a native sibling-edge drop inserts before without placement keys; only approved server semantics move the original node while input, caret, iframe heap and listener survive');

  original=await reset('column');await begin('#drag-card-d',()=>gap('#drag-card-a','#drag-card-b'));
  const spaces=await waitPreview();assert.ok(isBetween(spaces,'#drag-card-a','#drag-card-b'),JSON.stringify(spaces));
  assert.deepEqual(spaces.order,['drag-card-a','drag-card-d','drag-card-b','drag-card-c']);
  assert.equal(spaces.inert,true);assert.equal(spaces.pointerEvents,'none');assert.equal(spaces.scripts,0);assert.ok(spaces.placeholder.width>50&&spaces.placeholder.height>30,JSON.stringify(spaces));
  const reflow=await frame(`(()=>{const shadow=${overlay}.shadowRoot,a=shadow.querySelector('#drag-card-d').getBoundingClientRect(),b=shadow.querySelector('#drag-card-b').getBoundingClientRect(),live=document.querySelector('#drag-card-b').getBoundingClientRect();return {placeholderBottom:a.bottom,nextTop:b.top,previewTop:b.top,liveTop:live.top}})()`);
  assert.ok(reflow.nextTop>=reflow.placeholderBottom-1,JSON.stringify(reflow));assert.ok(reflow.previewTop>reflow.liveTop+40,JSON.stringify(reflow));
  assert.equal(await sourceHtml(),original);await screenshot('between-containers-preview');
  const count=await evaluate('results.componentEdits.length');await key('Escape');await release();assert.equal(await evaluate('results.componentEdits.length'),count);assert.equal(await sourceHtml(),original);assert.equal(await frame(`Boolean(${overlay}||${line})`),false);
  check('dragging into the actual container gap makes inert sibling copies give way with a visible placeholder; Escape restores the exact authored structure without a write');

  await begin('#drag-card-d',()=>edge('#drag-card-b','bottom'));const trailing=await propose();assert.equal(trailing.request.patch.destination,'#drag-card-b');assert.equal(trailing.request.patch.position,'after');await cancel(trailing);assert.equal(await sourceHtml(),original);
  check('a native lower-edge drop proposes after the sibling and host cancellation leaves the source intact');

  original=await reset('body');await begin('#drag-card-c',()=>gap('#drag-card-a','#drag-card-b'));const bodyPreview=await waitPreview();assert.ok(isBetween(bodyPreview,'#drag-card-a','#drag-card-b'),JSON.stringify(bodyPreview));assert.equal(await frame(`${overlay}.shadowRoot.querySelector('#drag-card-c').parentElement.localName`),'body');assert.equal(await sourceHtml(),original);const bodyDraft=await propose();assert.ok(isBetween(bodyDraft.request.patch,'#drag-card-a','#drag-card-b'));await commit(bodyDraft);assert.deepEqual(await frame("Array.from(document.querySelectorAll('body>.drag-card'),n=>n.id)"),['drag-card-a','drag-card-c','drag-card-b','drag-card-d']);
  check('a real gap between direct body containers inserts siblings without requiring an extra wrapper');

  original=await reset('row');await begin('#drag-card-d',()=>gap('#drag-card-a','#drag-card-b','x'));const rowPreview=await waitPreview();assert.ok(isBetween(rowPreview,'#drag-card-a','#drag-card-b'),JSON.stringify(rowPreview));assert.deepEqual(rowPreview.order,['drag-card-a','drag-card-d','drag-card-b','drag-card-c']);assert.equal(rowPreview.line.orientation,'vertical');assert.ok(rowPreview.line.height>20&&rowPreview.line.width<=6,JSON.stringify(rowPreview));assert.equal(await sourceHtml(),original);const row=await propose();assert.ok(isBetween(row.request.patch,'#drag-card-a','#drag-card-b'));await commit(row);assert.deepEqual(await order(),rowPreview.order);
  check('a real horizontal flex gap accepts sibling insertion and its vertical indicator and preview agree with the committed source');

  original=await reset('grid');await begin('#drag-card-d',()=>edge('#drag-card-c','top'));const gridPreview=await waitPreview();assert.equal(gridPreview.position,'before');assert.equal(gridPreview.destination,'#drag-card-c');assert.deepEqual(gridPreview.order,['drag-card-a','drag-card-b','drag-card-d','drag-card-c']);assert.equal(gridPreview.line.orientation,'horizontal');assert.equal(await sourceHtml(),original);const grid=await propose();assert.equal(grid.request.patch.position,'before');assert.equal(grid.request.patch.destination,'#drag-card-c');await commit(grid);assert.deepEqual(await order(),gridPreview.order);
  check('the first container edge of the next grid row supplies a between-row insertion with a horizontal indicator');

  original=await reset('row');await begin('#drag-card-c',async()=>{const nest=await location('#drag-nest');return {x:nest.x+nest.width/2,y:nest.y+nest.height/2}});const nested=await propose();assert.equal(nested.request.patch.destination,'#drag-nest');assert.equal(nested.request.patch.position,'append');assert.equal(await sourceHtml(),original);await commit(nested);assert.equal(await frame("document.querySelector('#drag-card-c').parentElement.id"),'drag-nest');
  check('the center of an empty container still accepts nesting, alongside the new sibling insertion zones');

  original=await reset('column');const beforeInvalid=await evaluate('results.componentEdits.length');await begin('#drag-card-a',()=>edge('#drag-card-b','top'));await release();await settleFrame();assert.equal(await evaluate('results.componentEdits.length'),beforeInvalid,'Moving before the already-next sibling is a no-op, not an edit');assert.equal(await sourceHtml(),original);
  await begin('#drag-card-c',()=>edge('#drag-input','bottom'));await release();assert.equal(await evaluate('results.componentEdits.length'),beforeInvalid,'A component cannot be dropped into its own descendant');assert.equal(await sourceHtml(),original);
  check('no-op sibling drops and a component dropped into its own descendants do not create semantic edits');

  await begin('#drag-card-d',()=>edge('#drag-card-b','top'));await waitPreview();const beforeStale=await evaluate('results.componentEdits.length');await frame("(()=>{const old=document.querySelector('#drag-card-d'),replacement=old.cloneNode(true);replacement.firstElementChild.textContent='Concurrent replacement';old.replaceWith(replacement);return true})()");await release();assert.equal(await evaluate('results.componentEdits.length'),beforeStale,'The same ID cannot redirect the pending drag to a replacement');assert.equal(await frame("document.querySelector('#drag-card-d')===dragNodes['drag-card-d']"),false);assert.equal(await frame(`Boolean(${overlay})`),false);
  check('a same-ID source replacement cancels the pending drag instead of redirecting it to the new element');

  original=await reset('column');await begin('#drag-card-d',()=>edge('#drag-card-b','top'));await waitPreview();const targetStaleCount=await evaluate('results.componentEdits.length');await frame("(()=>{const old=document.querySelector('#drag-card-b'),replacement=old.cloneNode(true);replacement.firstElementChild.textContent='Concurrent destination replacement';old.replaceWith(replacement);return true})()");await release();assert.equal(await evaluate('results.componentEdits.length'),targetStaleCount,'The same ID cannot redirect a drop into a new destination element');assert.equal(await frame("document.querySelector('#drag-card-d')===dragNodes['drag-card-d']&&document.querySelector('#drag-card-d').parentElement.id==='drag-list'"),true);assert.equal(await frame(`Boolean(${overlay})`),false);
  check('a same-ID destination replacement invalidates the chosen insertion target while preserving the original source');

  original=await reset('complex-target');
  const complexCount=await evaluate('results.componentEdits.length');
  const complexBounds=await frame("(()=>{const node=document.querySelector('#drag-complex-target');window.dragCapturedErrors=[];addEventListener('error',e=>dragCapturedErrors.push(e.message));addEventListener('unhandledrejection',e=>dragCapturedErrors.push(String(e.reason)));return {descendants:node.querySelectorAll('*').length,directChildren:node.children.length}})()");
  assert.ok(complexBounds.descendants>2000&&complexBounds.directChildren<160,JSON.stringify(complexBounds));
  await begin('#drag-card-d',()=>edge('#drag-card-b','left'));
  await untilFrame(`${line}?.dataset.destination==='#drag-card-b'&&${line}?.dataset.position==='before'`);
  const complexBox=await location('#drag-complex-target');
  await move({x:complexBox.x+complexBox.width/2,y:complexBox.y+complexBox.height/2});await settleFrame();
  await untilFrame(`!${line}&&!${overlay}`);
  // With no new pointer movement, keys must not revive the last valid target.
  await key('Tab');await key('ArrowRight');
  assert.equal(await frame(`Boolean(${line}||${overlay})`),false);
  await release();
  assert.equal(await evaluate('results.componentEdits.length'),complexCount,'A target identity failure must clear the previous valid slot instead of submitting it');
  assert.deepEqual(await frame('dragCapturedErrors'),[]);
  assert.equal(await sourceHtml(),original);assert.equal((await identity()).nodes,true);
  assert.equal(await frame("document.querySelector('#drag-card-d').parentElement.id"),'drag-list');
  console.log('MEASURE over-budget-drag-target',JSON.stringify(complexBounds));
  check('moving from a valid small target to an over-budget original container clears the old slot without a proposal, browser exception or source mutation');

  original=await reset('column');await pick('#drag-card-d');await click('[data-component-action="more"]');assert.equal(await frame(`${panel}.querySelector('.component-drag-animation').checked`),true);await click('[data-component-action="more"]');
  await frame(`(()=>{window.dragAnimationTrace=[];window.dragAnimationTraceDone=false;const deadline=performance.now()+650;const sample=()=>{const host=${overlay},copy=host?.shadowRoot.querySelector('#drag-card-b'),live=document.querySelector('#drag-card-b');if(copy){const a=copy.getBoundingClientRect(),b=live.getBoundingClientRect();window.dragAnimationTrace.push({at:performance.now(),x:a.x-b.x,y:a.y-b.y,liveX:b.x,liveY:b.y})}if(performance.now()<deadline)requestAnimationFrame(sample);else window.dragAnimationTraceDone=true};requestAnimationFrame(sample);return true})()`);
  await begin('#drag-card-d',()=>gap('#drag-card-a','#drag-card-b'));const animated=await waitPreview(false);assert.equal(animated.motion,'animated');await untilFrame('window.dragAnimationTraceDone');const animationTrace=await frame('dragAnimationTrace');
  assert.ok(animationTrace.length>=4,JSON.stringify(animationTrace));const offsets=animationTrace.map(p=>p.y);assert.ok(Math.max(...offsets)-Math.min(...offsets)>30,JSON.stringify(animationTrace));assert.ok(new Set(offsets.map(y=>Math.round(y))).size>=4,'The rendered sibling must traverse intermediate positions, not just advertise an animation');assert.ok(animationTrace.at(-1).y>40,JSON.stringify(animationTrace));assert.ok(animationTrace.every(p=>Math.abs(p.liveY-animationTrace[0].liveY)<1),'Only preview copies animate; original siblings stay fixed');assert.equal(await sourceHtml(),original);await key('Escape');await release();
  await pick('#drag-card-d');await click('[data-component-action="more"]');await click('.component-drag-animation');assert.equal(await frame(`${panel}.querySelector('.component-drag-animation').checked`),false);await click('[data-component-action="more"]');await begin('#drag-card-d',()=>gap('#drag-card-a','#drag-card-b'));const off=await waitPreview(false);assert.equal(off.motion,'static');assert.deepEqual(off.order,['drag-card-a','drag-card-d','drag-card-b','drag-card-c']);assert.ok(off.animations.every(a=>a.duration===0||a.playState!=='running'),JSON.stringify(off));await key('Escape');await release();assert.equal(await sourceHtml(),original);
  await pick('#drag-card-d');await click('[data-component-action="more"]');await click('.component-drag-animation');assert.equal(await frame(`${panel}.querySelector('.component-drag-animation').checked`),true);await key('Escape');
  await stage('reduced-motion-precondition');await setReducedMotion(true);await untilFrame("matchMedia('(prefers-reduced-motion: reduce)').matches");await begin('#drag-card-d',()=>gap('#drag-card-a','#drag-card-b'));const reduced=await waitPreview(false);assert.equal(reduced.motion,'static');assert.equal(await frame("matchMedia('(prefers-reduced-motion: reduce)').matches"),true);assert.ok(reduced.animations.every(a=>a.duration===0||a.playState!=='running'),JSON.stringify(reduced));assert.deepEqual(reduced.order,off.order);await key('Escape');await release();await setReducedMotion(false);
  check('the native animation checkbox and reduced-motion preference keep the placement preview usable while disabling movement animation');

  await command('Emulation.setDeviceMetricsOverride',{width:420,height:860,deviceScaleFactor:1,mobile:false});original=await reset('column');await begin('#drag-card-c',()=>gap('#drag-card-a','#drag-card-b'));const compact=await waitPreview();assert.ok(isBetween(compact,'#drag-card-a','#drag-card-b'),JSON.stringify(compact));assert.ok(compact.placeholder.x>=-1&&compact.placeholder.x+compact.placeholder.width<=421,JSON.stringify(compact));assert.ok(compact.line.width>40&&compact.line.height<=6,JSON.stringify(compact));assert.equal(await sourceHtml(),original);await screenshot('between-containers-compact');const compactDraft=await propose();assert.ok(isBetween(compactDraft.request.patch,'#drag-card-a','#drag-card-b'));await commit(compactDraft);assert.deepEqual(await order(),['drag-card-a','drag-card-c','drag-card-b','drag-card-d']);
  const ready=await evaluate('results.ready');await key('Escape');await update("{selectionMode:'off'}");await evaluate('reconnect()');await until(`results.ready===${ready+1}`);await untilFrame("document.querySelector('#drag-list')?.children[1]?.id==='drag-card-c'");assert.equal(describeAuthoring(await evaluate('hostProps.canvas')).replay.complete,true);await command('Emulation.clearDeviceMetricsOverride');
  check('420px sibling gap preview stays visible and its authoritative move survives a cold CanvasFrame replay');
  console.log('MEASURE component-drag-preview',JSON.stringify({gap:spaces,reflow,row:rowPreview,grid:gridPreview,animationTrace,animationOff:off.motion,reducedMotion:reduced.motion,compact}));
}
