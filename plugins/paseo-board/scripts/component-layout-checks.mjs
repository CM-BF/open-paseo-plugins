import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { componentLayoutHtml } from './component-layout-fixture.mjs';

// Actual frame gestures and the actual server source preparer. The enclosing
// fixture adapts the host review callback; board-host-test covers its real UI.
export async function runComponentLayoutChecks({ evaluate, frame, update, command, click, clickPoint, location, drag, key, until, untilFrame, settleFrame, profile, directory, baseHtml, check }) {
  const server = await build({ stdin: { contents: 'export {prepareComponentPatch,describeAuthoring} from "./server/authored-source";', resolveDir: join(directory, '..'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false });
  const modulePath = join(profile, 'component-layout-core.cjs'); await writeFile(modulePath, server.outputFiles[0].text);
  const { prepareComponentPatch, describeAuthoring } = createRequire(import.meta.url)(modulePath);
  const ready = await evaluate('results.ready');
  await update(`{boardId:'layout-browser',boardRevision:1,userState:{unrelated:'retained'},interactions:[],selectedInteractionId:null,selectionMode:'off',height:700,canvas:{html:${JSON.stringify(baseHtml + componentLayoutHtml)},data:{n:0},patches:[],revision:1,documentVersion:hostProps.canvas.documentVersion+1}}`);
  await until(`results.ready===${ready + 1}`); await untilFrame('window.layoutReady');
  const panel = "document.querySelector('[data-board-components]')?.shadowRoot";
  const preview = "document.querySelector('[data-board-component-layout]')?.shadowRoot";
  const action = name => `[data-component-action="layout-${name}"]`;
  const screenshot = async name => {
    if(!process.env.BOARD_LAYOUT_SCREENSHOT_DIR)return;
    await mkdir(process.env.BOARD_LAYOUT_SCREENSHOT_DIR,{recursive:true});
    const shot=await command('Page.captureScreenshot',{format:'png'}),file=join(process.env.BOARD_LAYOUT_SCREENSHOT_DIR,name+'.png');
    await writeFile(file,Buffer.from(shot.data,'base64'));console.log('ARTIFACT layout-screenshot',file);
  };
  // Observe the final native event result even when the component boundary stops
  // propagation at window. These wrappers delegate unchanged; they never select
  // an option, cancel an event, grant trust, or add a fallback input path.
  const installDiagnostics = () => frame(`(()=>{if(window.layoutDiagnosticsInstalled&&typeof window.observeLayoutSelect==='function')return true;window.layoutDiagnosticsInstalled=true;window.layoutEventTrace=[];const inside=e=>e.composedPath().some(n=>n instanceof Element&&n.matches('[data-board-components]'));const record=(e,phase)=>{if(phase!=='select-target'&&!inside(e))return;const path=e.composedPath(),target=path[0],item={phase,type:e.type,key:e.key,code:e.code,trusted:e.isTrusted,composed:e.composed,prevented:e.defaultPrevented,target:target?.tagName,classes:target?.className,x:e.clientX,y:e.clientY};window.layoutEventTrace.push(item);if(window.layoutEventTrace.length>100)window.layoutEventTrace.shift();queueMicrotask(()=>{item.finalPrevented=e.defaultPrevented;const shadow=document.querySelector('[data-board-components]')?.shadowRoot;item.focus=shadow?.activeElement?.className;item.value=shadow?.querySelector('.layout-collapse')?.value})};window.observeLayoutSelect=select=>{for(const name of ['input','change'])select.addEventListener(name,e=>record(e,'select-target'),true)};for(const name of ['pointerdown','pointerup','mousedown','mouseup','click','keydown','keyup','input','change','focusin','focusout'])window.addEventListener(name,e=>record(e,'window-capture'),true);for(const name of ['preventDefault','stopImmediatePropagation']){const original=Event.prototype[name];Event.prototype[name]=function(...args){record(this,name);return original.apply(this,args)}}return true})()`);
  await installDiagnostics();
  let configuredSelector;
  const press = async name => { const codes = { Home:36, ArrowDown:40, Enter:13, Backspace:8, Tab:9 }; await command('Input.dispatchKeyEvent', { type:'keyDown', key:name, code:name, windowsVirtualKeyCode:codes[name] }); await command('Input.dispatchKeyEvent', { type:'keyUp', key:name, code:name, windowsVirtualKeyCode:codes[name] }); };
  const pick = async (selector,{keepClipboard=false}={}) => {
    if(!keepClipboard)await key('Escape'); await update("{selectionMode:'off'}");
    await frame(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})`); await settleFrame();
    const b = await location(selector), x=b.x+Math.min(5,b.width/2), y=b.y+Math.min(5,b.height/2);
    await command('Input.dispatchMouseEvent', {type:'mouseMoved',x,y,modifiers:12});
    await command('Input.dispatchMouseEvent', {type:'mousePressed',x,y,button:'left',clickCount:1,modifiers:12});
    await command('Input.dispatchMouseEvent', {type:'mouseReleased',x,y,button:'left',clickCount:1,modifiers:12});
    await command('Input.dispatchKeyEvent', {type:'keyUp',key:'Shift',code:'ShiftLeft',modifiers:0});
    await untilFrame(`${panel}?.querySelector('[aria-current=true]')?.textContent===${JSON.stringify(selector)}`);
  };
  const pickFixtureChild = async selector => {
    // The fixture section has its own padding. A table/SVG edge can belong to a
    // child, so choose those exact authored nodes through the real hierarchy UI.
    await pick('#layout-fixture');await click('[data-component-action="hierarchy"]');
    const matches=await frame(`Array.from(${panel}.querySelectorAll('.children button')).filter(button=>button.textContent===${JSON.stringify(selector)}).map(button=>button.getAttribute('data-component-index'))`);
    assert.equal(matches.length,1,`One exact direct child in the hierarchy: ${selector}`);
    const buttonSelector=`.children [data-component-index="${matches[0]}"]`;
    await frame(`${panel}.querySelector(${JSON.stringify(buttonSelector)}).scrollIntoView({block:'nearest'})`);await settleFrame();
    assert.equal(await frame(`(()=>{const shadow=${panel},button=shadow.querySelector(${JSON.stringify(buttonSelector)}),r=button.getBoundingClientRect(),hit=shadow.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(hit===button||button.contains(hit))})()`),true,`Hierarchy child is a visible real pointer target: ${selector}`);
    await click(buttonSelector);
    await untilFrame(`${panel}?.querySelector('[aria-current=true]')?.textContent===${JSON.stringify(selector)}`);
  };
  const chooseHierarchy = async (relation,label) => {
    await click('[data-component-action="hierarchy"]');
    const matches=await frame(`Array.from(${panel}.querySelectorAll(${JSON.stringify('.'+relation+' button')})).filter(button=>button.textContent===${JSON.stringify(label)}).map(button=>button.getAttribute('data-component-index'))`);
    assert.equal(matches.length,1,`Unique ${relation} component: ${label}`);
    const selector=`.${relation} [data-component-index="${matches[0]}"]`;
    await frame(`${panel}.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);await settleFrame();
    assert.equal(await frame(`(()=>{const shadow=${panel},button=shadow.querySelector(${JSON.stringify(selector)}),r=button.getBoundingClientRect(),hit=shadow.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&(hit===button||button.contains(hit))})()`),true,`Visible hierarchy target: ${label}`);
    await click(selector);await untilFrame(`${panel}?.querySelector('[aria-current=true]')?.textContent===${JSON.stringify(label)}`);
  };
  const input = async (selector, value) => {
    await click(selector);
    assert.equal(await frame(`${panel}.activeElement===${panel}.querySelector(${JSON.stringify(selector)})`), true, `Focus before typing ${selector}`);
    await command('Input.dispatchKeyEvent', {type:'keyDown',key:'a',code:'KeyA',commands:['selectAll']});
    if (value) await command('Input.insertText', {text:String(value)}); else await press('Backspace');
    assert.equal(await frame(`${panel}.querySelector(${JSON.stringify(selector)}).value`), String(value));
  };
  const configure = async (selector, collapse, height, title) => {
    await installDiagnostics(); configuredSelector=selector;
    await pick(selector); await click('[data-component-action="layout"]');
    await frame('window.layoutEventTrace=[]');
    // Native change is non-composed. Observe it on this exact select rather
    // than mistaking its absence outside the shadow root for a failed input.
    await frame(`window.observeLayoutSelect(${panel}.querySelector('.layout-collapse'))`);
    const checkpoints=[];
    const checkpoint=async step=>checkpoints.push(await frame(`(()=>{const shadow=${panel},select=shadow.querySelector('.layout-collapse'),r=select.getBoundingClientRect(),hit=shadow.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {step:${JSON.stringify(step)},value:select.value,index:select.selectedIndex,focus:shadow.activeElement?.className,documentFocus:document.activeElement?.tagName,hasFocus:document.hasFocus(),open:select.matches(':open'),box:{x:r.x,y:r.y,width:r.width,height:r.height},hit:{tag:hit?.tagName,classes:hit?.className},options:Array.from(select.options,o=>({value:o.value,selected:o.selected}))}})()`));
    await checkpoint('before-click');
    await click('.layout-collapse'); await checkpoint('after-click');
    assert.equal(await frame(`${panel}.activeElement===${panel}.querySelector('.layout-collapse')`),true,'Native select owns focus before typeahead');
    // macOS headless Chromium does not service the native popup's Home/Arrow
    // navigation, including on a blank page. Native typeahead does, and produces
    // browser-trusted input/change. Each configure call selects a fresh panel.
    const initialValue=await frame(`${panel}.querySelector('.layout-collapse').value`);
    const character={none:'不',contents:'保',group:'外'}[collapse];
    for(const type of ['keyDown','keyUp']) await command('Input.dispatchKeyEvent',{type,key:character,code:character,windowsVirtualKeyCode:0});
    await command('Input.dispatchKeyEvent',{type:'char',text:character,key:character,code:'KeyC',windowsVirtualKeyCode:0});
    await checkpoint('after-native-typeahead'); await press('Tab'); await checkpoint('after-Tab');
    const selected=await frame(`${panel}.querySelector('.layout-collapse').value`);
    const events=await frame('window.layoutEventTrace');
    const nativeChanges=events.filter(event=>event.target==='SELECT'&&['input','change'].includes(event.type));
    const changedNatively=initialValue===collapse||['input','change'].every(type=>nativeChanges.some(event=>event.type===type&&event.phase==='select-target'&&event.trusted&&event.value===collapse));
    if(selected!==collapse||!changedNatively||process.env.BOARD_LAYOUT_DIAG==='1') {
      console.log('DIAG layout-native-select',JSON.stringify({selector,expected:collapse,initialValue,selected,checkpoints,events,hostFocus:await evaluate('({tag:document.activeElement?.tagName,hasFocus:document.hasFocus()})')}));
      if(process.env.BOARD_LAYOUT_DIAG_SCREENSHOT){const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(process.env.BOARD_LAYOUT_DIAG_SCREENSHOT,Buffer.from(shot.data,'base64'));}
    }
    assert.equal(selected, collapse);
    assert.equal(changedNatively,true,'A changed native selection must produce trusted browser input and change');
    assert.ok(nativeChanges.every(event=>event.trusted),'No synthetic select events');
    if(title) await input('.layout-title',title);
    await input('.layout-height',height===null?'':String(height));
  };
  const previewState = () => frame(`(()=>{const shadow=${panel},button=shadow?.querySelector(${JSON.stringify(action('preview'))}),r=button?.getBoundingClientRect(),hit=r?shadow.elementFromPoint(r.x+r.width/2,r.y+r.height/2):null,source=document.querySelector(${JSON.stringify(configuredSelector)});let remaining=60;const structure=(node,depth=0)=>{if(!node||!remaining--||depth>5)return null;return {type:node.nodeType,tag:node.localName,id:node.id,comment:node.nodeType===8?node.textContent:undefined,part:node.getAttribute?.('data-paseo-layout-part'),key:node.getAttribute?.('data-paseo-layout-key'),children:Array.from(node.childNodes||[]).filter(n=>n.nodeType!==3||n.textContent.trim()).slice(0,15).map(n=>structure(n,depth+1))}};return {selector:${JSON.stringify(configuredSelector)},selected:shadow?.querySelector('[aria-current=true]')?.textContent,status:shadow?.querySelector('.status')?.textContent,menuHidden:shadow?.querySelector('.layout-tools')?.hidden,values:{collapse:shadow?.querySelector('.layout-collapse')?.value,title:shadow?.querySelector('.layout-title')?.value,height:shadow?.querySelector('.layout-height')?.value},disabled:{preview:button?.disabled,save:shadow?.querySelector(${JSON.stringify(action('save'))})?.disabled},button:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,hit:{tag:hit?.tagName,action:hit?.getAttribute('data-component-action'),matches:hit===button||Boolean(button?.contains(hit))},focus:{tag:shadow?.activeElement?.tagName,classes:shadow?.activeElement?.className,documentTag:document.activeElement?.tagName,hasFocus:document.hasFocus()},source:{connected:source?.isConnected,metadata:source?.getAttribute('data-paseo-layout'),parentPart:source?.parentElement?.getAttribute('data-paseo-layout-part'),html:source?.outerHTML.slice(0,6500),structure:structure(source)},preview:Boolean(${preview}),events:window.layoutEventTrace?.slice(-20)}})()`);
  const showPreview = async () => {
    const before=await previewState();
    try { await click(action('preview')); await untilFrame(`Boolean(${preview})`); }
    catch(error) {
      console.log('DIAG layout-preview',JSON.stringify({before,after:await previewState(),hostErrors:await evaluate('results.errors.slice(-3)')}));
      if(process.env.BOARD_LAYOUT_DIAG_SCREENSHOT){const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(process.env.BOARD_LAYOUT_DIAG_SCREENSHOT,Buffer.from(shot.data,'base64'));}
      throw error;
    }
  };
  const propose = async () => {
    const index=await evaluate('results.componentEdits.length'); await click(action('save'));
    await until(`results.componentEdits.length===${index+1}`);
    const request=await evaluate(`results.componentEdits[${index}]`);
    assert.equal(request.patch.operation,'layout'); assert.ok(request.patch.sourceIdentity.fingerprint);
    return {index,request};
  };
  const commit = async ({index,request}, beforeCommit) => {
    const canvas=await evaluate('hostProps.canvas'), revision=canvas.revision+1;
    const patch=prepareComponentPatch(canvas,{...request.patch,id:`layout-commit-${index}`,html:''});
    if(beforeCommit) await beforeCommit();
    await update(`{boardRevision:hostProps.boardRevision+1,canvas:{...hostProps.canvas,revision:${revision},patches:[...hostProps.canvas.patches,${JSON.stringify(patch)}]}}`);
    await evaluate(`finishComponentEdit(${index},{status:'applied',canvasRevision:${revision}})`);
    await untilFrame(`board.getContext().canvasRevision===${revision}`); await settleFrame();
    assert.equal(describeAuthoring(await evaluate('hostProps.canvas')).replay.complete,true);
    return patch;
  };
  const closeTools = async () => { await key('Escape'); await key('Escape'); await update("{selectionMode:'off'}"); await untilFrame(`!document.querySelector('[data-board-components]')`); };
  const rect = selector => frame(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,width:r.width}})()`);
  const equalRect = (actual, expected, label) => { for(const name of ['x','width']) assert.ok(Math.abs(actual[name]-expected[name])<1,`${label} ${name}: ${JSON.stringify({actual,expected})}`); };
  const flexGeometry = (selector,parentSelector,peerSelector) => frame(`(()=>{const target=document.querySelector(${JSON.stringify(selector)}),group=target.parentElement?.parentElement?.matches('details[data-paseo-layout-part=group]')?target.parentElement.parentElement:null;const measure=node=>{if(!node)return null;const rect=node.getBoundingClientRect(),style=getComputedStyle(node),names=['display','box-sizing','flex','flex-basis','flex-grow','flex-shrink','order','width','min-width','max-width','padding-left','padding-right','border-left-width','border-right-width','margin-left','margin-right','column-gap'];return {tag:node.localName,id:node.id,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},style:Object.fromEntries(names.map(name=>[name,style.getPropertyValue(name)]))}};return {parent:measure(document.querySelector(${JSON.stringify(parentSelector)})),peer:measure(document.querySelector(${JSON.stringify(peerSelector)})),target:measure(target),group:measure(group)}})()`);
  const assertFlexGeometry = (before,after,label) => {
    try { equalRect(after.target.rect,before.target.rect,label+' target');equalRect(after.peer.rect,before.peer.rect,label+' peer'); }
    catch(error) { console.log('MEASURE layout-flex-geometry',JSON.stringify({label,before,after}));throw error; }
  };
  const nativeClick = async selector => { await frame(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`); await settleFrame(); await click(selector); await settleFrame(); };

  const original=await frame("document.querySelector('#layout-body').outerHTML"), requests=await evaluate('results.componentEdits.length');
  await configure('#layout-body','contents',180); await showPreview();
  assert.deepEqual(await frame(`({original:document.querySelector('#layout-body').outerHTML,heading:Boolean(${preview}.querySelector('#layout-body summary #layout-body-heading')),height:${preview}.querySelector('#layout-body [data-paseo-layout-part=body]').style.maxHeight,inert:${preview}.querySelector('[data-board-preview-root]').inert,scripts:${preview}.querySelectorAll('script').length})`),{original,heading:true,height:'180px',inert:true,scripts:0});
  await frame(`${panel}.querySelector(${JSON.stringify(action('save'))}).click()`); await settleFrame();
  assert.equal(await evaluate('results.componentEdits.length'),requests,'Synthetic Save cannot stage a layout');
  await click(action('cancel')); await untilFrame(`!${preview}`);
  assert.equal(await frame("document.querySelector('#layout-body').outerHTML"),original);
  check('layout preview uses an inert copy with native disclosure and bounded scrolling; cancelling and synthetic Save leave the authored container unchanged');

  await configure('#layout-body','contents',180); await showPreview();
  const cancelled=await propose(); await evaluate(`finishComponentEdit(${cancelled.index},{status:'cancelled'})`); await settleFrame();
  assert.equal(await frame("document.querySelector('#layout-body').outerHTML"),original);
  await configure('#layout-body','contents',180); await showPreview(); await commit(await propose()); await closeTools();
  assert.deepEqual(await frame("({same:document.querySelector('#layout-body')===layoutBody,heading:document.querySelector('#layout-body summary #layout-body-heading')===layoutBodyChildren.find(n=>n.id==='layout-body-heading'),children:layoutBodyChildren.every(n=>layoutBody.contains(n)),height:getComputedStyle(document.querySelector('#layout-body [data-paseo-layout-part=body]')).maxHeight})"),{same:true,heading:true,children:true,height:'180px'});
  await nativeClick('#layout-body summary'); assert.equal(await frame("document.querySelector('#layout-body details').open"),false);
  await nativeClick('#layout-body summary'); assert.equal(await frame("document.querySelector('#layout-body details').open"),true);
  const bodyBox=await location('#layout-body [data-paseo-layout-part=body]');
  await command('Input.dispatchMouseEvent',{type:'mouseWheel',x:bodyBox.x+bodyBox.width/2,y:bodyBox.y+Math.min(70,bodyBox.height/2),deltaX:0,deltaY:180});
  await untilFrame("document.querySelector('#layout-body [data-paseo-layout-part=body]').scrollTop>0");
  check('host cancellation leaves the source intact; an authoritative layout save moves the real heading and children, and genuine disclosure clicks and wheel scrolling work');

  await configure('#layout-body','none',null); await click(action('reset')); await showPreview(); await commit(await propose()); await closeTools();
  assert.equal(await frame("layoutBody.childNodes.length===layoutBodyChildren.length&&layoutBodyChildren.every((n,i)=>layoutBody.childNodes[i]===n)"),true);
  assert.equal(await frame("document.querySelector('#layout-body').outerHTML"),original);
  assert.equal(await frame("getComputedStyle(layoutBody).overflowY"),'visible');
  check('explicit restoration removes only managed wrappers and returns the original heading order, child identities and authored overflow rules');

  const fixedHeightOriginal=await frame("({html:document.querySelector('#layout-no-heading').outerHTML,height:document.querySelector('#layout-no-heading').getBoundingClientRect().height})");
  await configure('#layout-no-heading','contents',180,'自定义正文标题'); await showPreview();
  assert.equal(await frame(`${preview}.querySelector('#layout-no-heading summary').textContent`),'自定义正文标题');
  await commit(await propose()); await closeTools();
  assert.equal(await frame("document.querySelector('#layout-no-heading summary').textContent"),'自定义正文标题');
  await nativeClick('#layout-no-heading summary');
  const closedHeight=await frame("document.querySelector('#layout-no-heading').getBoundingClientRect().height");
  assert.ok(closedHeight<80 && closedHeight<fixedHeightOriginal.height/3,JSON.stringify({closedHeight,original:fixedHeightOriginal.height}));
  const fixedHeightKey=String(await evaluate('hostProps.canvas.documentVersion'))+':'+await frame("JSON.parse(document.querySelector('#layout-no-heading').getAttribute('data-paseo-layout')).key");
  await until(`hostProps.userState.__paseoContainerViews?.[${JSON.stringify(fixedHeightKey)}]===false`);
  const fixedReady=await evaluate('results.ready'); await evaluate('reconnect()'); await until(`results.ready===${fixedReady+1}`); await untilFrame('window.layoutReady');
  assert.deepEqual(await frame("({title:document.querySelector('#layout-no-heading summary').textContent,open:document.querySelector('#layout-no-heading details').open,short:document.querySelector('#layout-no-heading').getBoundingClientRect().height<80})"),{title:'自定义正文标题',open:false,short:true});
  await nativeClick('#layout-no-heading summary');
  await configure('#layout-no-heading','none',null); await click(action('reset')); await showPreview(); await commit(await propose()); await closeTools();
  assert.equal(await frame("document.querySelector('#layout-no-heading').outerHTML"),fixedHeightOriginal.html);
  assert.equal(await frame("document.querySelector('#layout-no-heading').getBoundingClientRect().height"),fixedHeightOriginal.height);
  check('a heading-free fixed-height container accepts a custom summary, truly shrinks when folded, retains its title and folded state after reload, and restores its authored height');

  await frame("document.querySelector('#layout-target').scrollIntoView({block:'start'})"); await settleFrame();
  const gridBefore=await rect('#layout-target'), gridPeerBefore=await rect('#layout-grid-peer');
  await configure('#layout-target','group',240,'Outer group'); await showPreview();
  const handle=await location('[data-component-layout-resize]');
  await drag({x:handle.x+handle.width/2,y:handle.y+handle.height/2},{x:handle.x+handle.width/2,y:handle.y+handle.height/2+55});
  const draggedHeight=Number(await frame(`${panel}.querySelector('.layout-height').value`));
  assert.equal(draggedHeight,295); assert.equal(await frame("layoutOriginal.hasAttribute('data-paseo-layout')"),false);
  await screenshot('group-preview');
  const grouped=await propose();
  await evaluate('window.layoutFrame=document.querySelector("iframe"); true');
  await commit(grouped,()=>frame("layoutInput.value='Live typed draft';layoutInput.focus();layoutInput.setSelectionRange(3,9);window.layoutHeap={retained:true}"));
  assert.deepEqual(await frame("({same:document.querySelector('#layout-target')===layoutOriginal,input:document.querySelector('#layout-input')===layoutInput,heading:document.querySelector('#layout-heading')===layoutHeading,value:layoutInput.value,focused:document.activeElement===layoutInput,start:layoutInput.selectionStart,end:layoutInput.selectionEnd,boots:layoutBoots,heap:layoutHeap.retained})"),{same:true,input:true,heading:true,value:'Live typed draft',focused:true,start:3,end:9,boots:1,heap:true});
  assert.equal(await evaluate('document.querySelector("iframe")===window.layoutFrame'),true);
  equalRect(await rect('#layout-target'),gridBefore,'Grid target'); equalRect(await rect('#layout-grid-peer'),gridPeerBefore,'Grid peer');
  await closeTools(); await nativeClick('#layout-button'); assert.equal(await frame('layoutClicks'),1);
  check('dragging the preview edge sets the saved height; group wrapping preserves grid geometry, original nodes, listener, input, focus, caret and iframe heap');

  const groupKey=await frame("JSON.parse(layoutOriginal.getAttribute('data-paseo-layout')).key");
  await configure('#layout-target','group',310,'Renamed group'); await showPreview(); await commit(await propose()); await closeTools();
  assert.deepEqual(await frame("({key:JSON.parse(layoutOriginal.getAttribute('data-paseo-layout')).key,groups:document.querySelectorAll('#layout-grid details[data-paseo-layout-part=group]').length,title:layoutOriginal.parentElement.previousElementSibling.textContent})"),{key:groupKey,groups:1,title:'Renamed group'});
  // Make the inner target visible through the real outer scroll container.
  await configure('#layout-inner','contents',120); await showPreview(); await commit(await propose()); await closeTools();
  await nativeClick('#layout-inner summary');
  assert.deepEqual(await frame("({inner:document.querySelector('#layout-inner details').open,outer:layoutOriginal.parentElement.parentElement.open,heading:document.querySelector('#layout-inner summary #layout-inner-heading')===layoutInnerHeading})"),{inner:false,outer:true,heading:true});
  const viewKey=String(await evaluate('hostProps.canvas.documentVersion'))+':'+await frame("JSON.parse(layoutInner.getAttribute('data-paseo-layout')).key");
  await until(`hostProps.userState.__paseoContainerViews?.[${JSON.stringify(viewKey)}]===false`);
  await nativeClick('#layout-author-save');await until('hostProps.userState.zoom===1.75');
  assert.equal(await evaluate(`hostProps.userState.__paseoContainerViews?.[${JSON.stringify(viewKey)}]`),false,'Author-only save retains the current fold');
  await nativeClick('#layout-author-save-stale');await until('hostProps.userState.zoom===2.5');
  assert.equal(await evaluate(`hostProps.userState.__paseoContainerViews?.[${JSON.stringify(viewKey)}]`),false,'An older author state snapshot cannot overwrite a newer fold');
  const beforeReload=await evaluate('results.ready'); await evaluate('reconnect()'); await until(`results.ready===${beforeReload+1}`); await untilFrame('window.layoutReady');
  assert.equal(await frame("document.querySelector('#layout-inner details').open"),false);
  assert.equal(await frame("document.querySelectorAll('#layout-grid details[data-paseo-layout-part=group]').length"),1);
  assert.equal(await frame('layoutBoots'),1); assert.equal(await frame('board.getState().zoom'),2.5);
  await nativeClick('#layout-inner summary'); await nativeClick('#layout-button'); assert.equal(await frame('layoutClicks'),1);
  check('repeated layout edits reuse one group; author-only and stale full-state saves retain the current nested fold, and cold replay restores both author zoom and disclosure state without duplicating handlers');

  await frame("document.querySelector('#layout-flex').scrollIntoView({block:'start'})"); await settleFrame();
  const flexBeforeDetails=await flexGeometry('#layout-flex-target','#layout-flex','#layout-flex-peer');
  assert.equal(flexBeforeDetails.target.style['box-sizing'],'content-box');assert.match(flexBeforeDetails.target.style['flex-basis'],/^0(?:px|%)$/);
  await configure('#layout-flex-target','group',180,'Flex group'); await showPreview(); await commit(await propose()); await closeTools();
  assertFlexGeometry(flexBeforeDetails,await flexGeometry('#layout-flex-target','#layout-flex','#layout-flex-peer'),'Content-box zero-basis flex');
  await frame("document.querySelector('#layout-flex-border').scrollIntoView({block:'start'})");await settleFrame();
  const borderBefore=await flexGeometry('#layout-flex-border-target','#layout-flex-border','#layout-flex-border-peer');
  assert.equal(borderBefore.target.style['box-sizing'],'border-box');assert.match(borderBefore.target.style['flex-basis'],/^0(?:px|%)$/);
  await configure('#layout-flex-border-target','group',180,'Border-box flex group');await showPreview();await commit(await propose());await closeTools();
  assertFlexGeometry(borderBefore,await flexGeometry('#layout-flex-border-target','#layout-flex-border','#layout-flex-border-peer'),'Border-box zero-basis flex');
  await frame("document.querySelector('#layout-flex-percent').scrollIntoView({block:'start'})");await settleFrame();
  const percentBefore=await flexGeometry('#layout-flex-percent-target','#layout-flex-percent','#layout-flex-percent-peer');
  assert.equal(percentBefore.target.style['box-sizing'],'content-box');assert.equal(percentBefore.target.style['flex-basis'],'0%');
  await configure('#layout-flex-percent-target','group',180,'Zero percent flex group');await showPreview();await commit(await propose());await closeTools();
  assertFlexGeometry(percentBefore,await flexGeometry('#layout-flex-percent-target','#layout-flex-percent','#layout-flex-percent-peer'),'Content-box zero-percent flex');
  check('group wrappers preserve original target and sibling widths for content-box/border-box zero-pixel basis and content-box zero-percent flex shorthand, including padding, borders and margins');
  await command('Emulation.setDeviceMetricsOverride',{width:420,height:850,deviceScaleFactor:1,mobile:false}); await settleFrame();
  const compactLayout=await frame("(()=>{const measure=(id,parentId,peerId)=>{const target=document.querySelector(id),wrapper=target.parentElement.parentElement;const r=target.getBoundingClientRect(),w=wrapper.getBoundingClientRect(),p=document.querySelector(parentId).getBoundingClientRect(),peer=document.querySelector(peerId).getBoundingClientRect();return {target:{left:r.left,right:r.right,width:r.width},wrapper:{left:w.left,right:w.right,width:w.width},parent:{left:p.left,right:p.right,width:p.width},peer:{left:peer.left,right:peer.right,width:peer.width}}};return {viewport:innerWidth,grid:measure('#layout-target','#layout-grid','#layout-grid-peer'),flex:measure('#layout-flex-target','#layout-flex','#layout-flex-peer'),borderFlex:measure('#layout-flex-border-target','#layout-flex-border','#layout-flex-border-peer'),percentFlex:measure('#layout-flex-percent-target','#layout-flex-percent','#layout-flex-percent-peer')}})()");
  assert.equal(compactLayout.viewport,420);
  for(const [kind,m] of Object.entries({grid:compactLayout.grid,flex:compactLayout.flex,borderFlex:compactLayout.borderFlex,percentFlex:compactLayout.percentFlex})) {
    assert.ok(m.wrapper.left>=m.parent.left-1 && m.wrapper.right<=m.parent.right+1 && m.wrapper.width>60,`${kind} wrapper must fit its compact parent: ${JSON.stringify(m)}`);
    assert.ok(m.target.left>=m.wrapper.left-1 && m.target.right<=m.wrapper.right+1,`${kind} target must fit its wrapper: ${JSON.stringify(m)}`);
    assert.ok(m.peer.right<=m.wrapper.left+1,`${kind} keeps its preceding sibling order: ${JSON.stringify(m)}`);
  }
  console.log('MEASURE compact-container-layout',JSON.stringify(compactLayout));
  await frame("document.querySelector('#layout-grid').scrollIntoView({block:'start'})");await settleFrame();await screenshot('groups-compact-420');
  await command('Emulation.clearDeviceMetricsOverride'); await settleFrame();
  equalRect(await rect('#layout-target'),gridBefore,'Expanded grid target');
  assertFlexGeometry(flexBeforeDetails,await flexGeometry('#layout-flex-target','#layout-flex','#layout-flex-peer'),'Expanded content-box flex');
  assertFlexGeometry(borderBefore,await flexGeometry('#layout-flex-border-target','#layout-flex-border','#layout-flex-border-peer'),'Expanded border-box flex');
  assertFlexGeometry(percentBefore,await flexGeometry('#layout-flex-percent-target','#layout-flex-percent','#layout-flex-percent-peer'),'Expanded zero-percent flex');
  check('saved outer groups adapt from desktop to a 420px viewport without overflowing their grid or flex parent or changing sibling order');
  await configure('#layout-flex-target','none',null); await click(action('reset')); await showPreview(); await commit(await propose()); await closeTools();
  assert.equal(await frame("document.querySelector('#layout-flex-target').parentElement.id"),'layout-flex');
  assertFlexGeometry(flexBeforeDetails,await flexGeometry('#layout-flex-target','#layout-flex','#layout-flex-peer'),'Restored content-box flex');
  await configure('#layout-flex-border-target','none',null);await click(action('reset'));await showPreview();await commit(await propose());await closeTools();
  assert.equal(await frame("document.querySelector('#layout-flex-border-target').parentElement.id"),'layout-flex-border');
  assertFlexGeometry(borderBefore,await flexGeometry('#layout-flex-border-target','#layout-flex-border','#layout-flex-border-peer'),'Restored border-box flex');
  await configure('#layout-flex-percent-target','none',null);await click(action('reset'));await showPreview();await commit(await propose());await closeTools();
  assert.equal(await frame("document.querySelector('#layout-flex-percent-target').parentElement.id"),'layout-flex-percent');
  assertFlexGeometry(percentBefore,await flexGeometry('#layout-flex-percent-target','#layout-flex-percent','#layout-flex-percent-peer'),'Restored zero-percent flex');
  check('outer groups retain flex order and item geometry, and restoration returns the original direct flex item');

  const innerDetailsLabel=await frame("'#'+document.querySelector('#layout-inner > details').id");
  const selectInnerPart=async part=>{await pick('#layout-inner');await chooseHierarchy('children',innerDetailsLabel);if(part!=='details')await chooseHierarchy('children',part==='body'?'div':'summary');if(part==='heading')await chooseHierarchy('children','#layout-inner-heading');};
  for(const part of ['details','summary','body','heading']) {
    await selectInnerPart(part);
    const before=await frame("document.querySelector('#layout-fixture').outerHTML"),requestsBefore=await evaluate('results.componentEdits.length');
    await click('[data-component-action="cut"]');await settleFrame();
    assert.match(await frame(`${panel}.querySelector('.status').textContent`),/不能|恢复/);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'x',code:'KeyX',modifiers:4});await command('Input.dispatchKeyEvent',{type:'keyUp',key:'x',code:'KeyX',modifiers:0});
    const handle=await location('[data-component-action="drag"]');
    await drag({x:handle.x+handle.width/2,y:handle.y+handle.height/2},{x:handle.x+handle.width/2+35,y:handle.y+handle.height/2-25});await settleFrame();
    assert.equal(await evaluate('results.componentEdits.length'),requestsBefore,`Cannot propose moving managed ${part}`);
    assert.equal(await frame("document.querySelector('#layout-fixture').outerHTML"),before,`Managed ${part} remains in place`);
    assert.equal(await frame("Boolean(document.querySelector('[data-board-component-ghost]'))"),false);
  }
  await closeTools();
  check('real hierarchy selection plus Cut, keyboard Cut and drag refuse independent moves of managed contents details, summary, scroll body and original heading without changing authored DOM');

  const outerLabel=await frame("'#'+document.querySelector('#layout-target').parentElement.parentElement.id");
  await pick('#layout-target');await chooseHierarchy('ancestors',outerLabel);await click('[data-component-action="cut"]');
  await pick('#layout-move-destination',{keepClipboard:true});const moveIndex=await evaluate('results.componentEdits.length');await click('[data-component-action="paste"]');
  await until(`results.componentEdits.length===${moveIndex+1}`);
  const moveRequest=await evaluate(`results.componentEdits[${moveIndex}]`);assert.equal(moveRequest.patch.operation,'move');assert.equal(moveRequest.patch.selector,outerLabel);
  await commit({index:moveIndex,request:moveRequest},()=>frame("window.layoutMoveGroup=layoutOriginal.parentElement.parentElement;layoutInput.value='Input survives whole group move';true"));await closeTools();
  assert.deepEqual(await frame("({same:layoutOriginal===document.querySelector('#layout-target'),group:layoutOriginal.parentElement.parentElement===layoutMoveGroup,parent:layoutMoveGroup.parentElement.id,value:layoutInput.value})"),{same:true,group:true,parent:'layout-move-destination',value:'Input survives whole group move'});
  await configure('#layout-target','none',null);await click(action('reset'));await showPreview();await commit(await propose());await closeTools();
  assert.deepEqual(await frame("({same:layoutOriginal===document.querySelector('#layout-target'),parent:layoutOriginal.parentElement.id,groupConnected:layoutMoveGroup.isConnected,nested:Boolean(layoutOriginal.querySelector('#layout-inner > details')),value:layoutInput.value})"),{same:true,parent:'layout-move-destination',groupConnected:false,nested:true,value:'Input survives whole group move'});
  const previousClicks=await frame('layoutClicks');await nativeClick('#layout-button');assert.equal(await frame('layoutClicks'),previousClicks+1);
  check('moving the complete outer group remains valid through the actual source preparer; subsequent restoration retains the original component, nested disclosure, input and listener at its new parent');

  const authoredSelectionClicks=await frame('window.layoutAuthorSelectionClicks');
  for(const selector of ['#layout-native','#layout-table','#layout-unsupported-button','#layout-unsupported-svg']) {
    await pickFixtureChild(selector);
    assert.equal(await frame(`${panel}.querySelector('[data-component-action=layout]').disabled`),true,selector);
    assert.ok(await frame(`${panel}.querySelector('[data-component-action=layout]').title.length>0`));
    assert.equal(await frame('window.layoutAuthorSelectionClicks'),authoredSelectionClicks,'Hierarchy selection must not execute author clicks');
  }
  await closeTools(); await nativeClick('#layout-native > summary');
  assert.equal(await frame("document.querySelector('#layout-native').open"),false);
  assert.equal(await frame('window.layoutAuthorSelectionClicks'),authoredSelectionClicks+1);
  check('real hierarchy selection identifies unsupported native disclosures, tables, controls and SVG without author clicks; layout remains disabled with a reason while ordinary disclosure clicks stay native');

  await configure('#layout-stale','group',180,'Stale group'); await showPreview();
  const beforeConflict=await evaluate('results.componentEdits.length');
  await frame("window.removedLayoutTarget=document.querySelector('#layout-stale');removedLayoutTarget.replaceWith(removedLayoutTarget.cloneNode(true))");
  await untilFrame(`${panel}.querySelector(${JSON.stringify(action('save'))}).disabled`);
  assert.equal(await frame("document.querySelector('#layout-stale').hasAttribute('data-paseo-layout')"),false);
  assert.equal(await evaluate('results.componentEdits.length'),beforeConflict);
  await key('Escape'); await closeTools();
  const authored=await evaluate('hostProps.canvas');
  const lastRequest=(await evaluate('results.componentEdits')).at(-1).patch;
  assert.throws(()=>prepareComponentPatch(authored,{...lastRequest,id:'stale-layout-proof',sourceIdentity:{...lastRequest.sourceIdentity,fingerprint:'00000000'}}));
  check('same-ID source replacement invalidates a pending layout without redirecting it, and the actual server preparer refuses stale structural identity');
}
