import assert from 'node:assert/strict';

// Real buildBoardDocument output, the production capture path, and independent Chrome PNGs.
// No live position changes are used to decide whether a sticky node may be captured.
export async function runStickyCaptureChecks({load, run, evaluate, reports, command, baseline}) {
  const base = '<style>html,body{margin:0;padding:0;max-width:none;background:white;color:#183048}*{box-sizing:border-box}#tabs{position:sticky;top:0;z-index:5;box-shadow:0 0 0 6px white;height:32px;width:600px;background:#276ea3}#tabs button{width:80px;height:28px;background:#b4d6e9;border:0}header{margin-top:18px;height:120px;background:#efbb68}main{height:2000px;background:linear-gradient(#dce8f0,#c4d8e4)}</style>';
  const fixture = base + '<nav id="tabs"><button aria-label="Tab A"></button><button aria-label="Tab B"></button></nav><header></header><main></main>';
  const success = (result, name, tolerance = 0.005) => { assert.equal(result.error, undefined, name); assert(result.pixelDiff.fraction < tolerance, `${name}: ${JSON.stringify(result.pixelDiff)}`); };
  const geometry = async (name, region) => {
    const value = await evaluate(`(async()=>{const node=document.getElementById('tabs'),scroller=document.getElementById('scroll'),rect=node.getBoundingClientRect(),r=scroller?.getBoundingClientRect(),style=getComputedStyle(node),plan=await capturePlanForTest(${JSON.stringify(region)},new AbortController().signal);return {rect:rect.toJSON(),port:r?{left:r.left+scroller.clientLeft,top:r.top+scroller.clientTop,right:r.left+scroller.clientLeft+scroller.clientWidth,bottom:r.top+scroller.clientTop+scroller.clientHeight}:{left:0,top:0,right:innerWidth,bottom:innerHeight},scroll:scroller?[scroller.scrollLeft,scroller.scrollTop]:[scrollX,scrollY],insets:{top:style.top,right:style.right,bottom:style.bottom,left:style.left},content:document.getElementById('content')?.getBoundingClientRect().toJSON(),parent:node.parentElement.getBoundingClientRect().toJSON(),needed:plan.needed.has(node)}})()`);
    console.log('MEASURE sticky-geometry', JSON.stringify({name,...value}));
    assert.equal(value.needed, true, `${name} must actually retain the sticky node`);
    const viewportRect = {left:region.x-value.scroll[0],top:region.y-value.scroll[1],right:region.x+region.width-value.scroll[0],bottom:region.y+region.height-value.scroll[1]};
    // Nested scroll offsets move contents, not the document-coordinate selection.
    const selection = value.content ? {left:region.x,top:region.y,right:region.x+region.width,bottom:region.y+region.height} : viewportRect;
    assert(value.rect.right>selection.left && value.rect.left<selection.right && value.rect.bottom>selection.top && value.rect.top<selection.bottom, `${name} sticky must intersect the crop`);
    return value;
  };
  await load(fixture);
  const below = await run('sticky-six-pixel-halo-twelve-pixels-below', {x:30,y:44,width:500,height:100});
  const point = await run('sticky-tab-point-at-scroll-zero', {x:0,y:0,width:240,height:160});
  await evaluate('document.querySelector("#tabs").style.boxShadow="none"');
  const without = await run('sticky-same-region-without-halo', {x:30,y:44,width:500,height:100});
  if (baseline) {
    assert.match(below.error, /Sticky content/); assert.match(point.error, /Sticky content/); success(without, 'baseline without halo');
    console.log('PASS original issue reproduces: halo and point fail; the same region without halo succeeds');
    return;
  }
  success(below, 'six pixel halo excludes twelve-pixel gap'); success(point, 'unscrolled sticky point'); success(without, 'without halo');
  await load(fixture);
  await evaluate('scrollTo(0,80)');
  const activeTop = await geometry('active-window-top', {x:0,y:80,width:240,height:160});
  assert.equal(activeTop.scroll[1],80); assert.equal(activeTop.rect.top,0);
  const stuck = await run('sticky-active-window-top', {x:0,y:80,width:240,height:160});
  assert.match(stuck.error, /Sticky content/, 'a displaced sticky header must not silently capture its old position');
  success(await run('sticky-active-six-pixel-halo-twelve-pixels-below', {x:30,y:124,width:500,height:100}), 'active sticky outside its actual shadow bounds');
  await evaluate('document.querySelector("#tabs").style.boxShadow="0 0 0 6px white, 0 0 0 6px white, inset 0 0 0 90px white"');
  success(await run('sticky-active-multiple-and-inset-halos', {x:30,y:124,width:500,height:100}), 'multiple shadow union and inset do not inflate paint');
  await load(fixture.replace('<nav', '<div style="height:180px;background:#b7a4ce"></div><nav'));
  await evaluate('scrollTo(0,80)');
  success(await run('sticky-window-before-threshold', {x:0,y:160,width:600,height:180}), 'window scroll before threshold');
  await load('<style>html,body{margin:0;padding:0;max-width:none;background:white}#tabs{position:sticky;top:0;width:300px;height:100px;background:#317856}#tabs div{position:absolute;left:200px;top:0;width:150px;height:100px;background:#2459c3;z-index:99}#cover{position:relative;z-index:1;margin-top:-100px;width:600px;height:100px;background:#d84951}</style><div style="height:200px"></div><div id="tabs"><div></div></div><div id="cover"></div><div style="height:1800px"></div>');
  await evaluate('scrollTo(0,80)');
  success(await run('sticky-auto-z-index-keeps-child-stacking-context', {x:0,y:180,width:600,height:160}), 'relative clone retains sticky stacking context');

  const nested = '<style>html,body{margin:0;padding:0;max-width:none;background:white}#scroll{margin:40px;width:600px;height:300px;overflow:auto;border:8px solid #445366}#content{display:flow-root;width:900px;height:900px;background:linear-gradient(90deg,#c6e6e0,#edd2b0)}#tabs{position:sticky;top:12px;left:15px;margin-top:120px;margin-left:140px;width:240px;height:40px;background:#873e72;box-shadow:0 0 0 6px #ab7d9c}</style><div id="scroll"><div id="content"><div id="tabs"></div></div></div>';
  await load(nested);
  success(await run('sticky-nested-scroll-zero', {x:40,y:40,width:600,height:300}), 'nested scroll zero');
  await evaluate('document.querySelector("#scroll").scrollTop=50;document.querySelector("#scroll").scrollLeft=60');
  success(await run('sticky-nested-two-axes-before-threshold', {x:40,y:40,width:600,height:300}), 'nested two axes before threshold');
  await evaluate('document.querySelector("#scroll").scrollTop=180;document.querySelector("#scroll").scrollLeft=200');
  const activeStart = await geometry('active-nested-two-axes', {x:40,y:40,width:600,height:300});
  assert.equal(activeStart.rect.top, activeStart.port.top+12); assert.equal(activeStart.rect.left,activeStart.port.left+15);
  assert.match((await run('sticky-nested-two-axes-active', {x:40,y:40,width:600,height:300})).error, /Sticky content/);
  await load(nested.replace('top:12px;left:15px;', 'bottom:12px;right:15px;'));
  success(await run('sticky-nested-end-insets-scroll-zero', {x:40,y:40,width:600,height:300}), 'nested bottom/right at scroll zero');
  await evaluate('document.querySelector("#scroll").scrollTop=20;document.querySelector("#scroll").scrollLeft=20');
  success(await run('sticky-nested-end-insets-before-threshold', {x:40,y:40,width:600,height:300}), 'nested bottom/right not constrained');
  await load(nested.replace('display:flow-root;', 'display:flex;align-items:flex-end;justify-content:flex-end;').replace('margin-top:120px;margin-left:140px;', 'margin:0;flex:none;').replace('top:12px;left:15px;', 'bottom:12px;right:15px;'));
  await evaluate('document.querySelector("#scroll").scrollTop=20;document.querySelector("#scroll").scrollLeft=20');
  const activeEnd = await geometry('active-nested-end-insets', {x:40,y:40,width:600,height:300});
  assert.equal(activeEnd.rect.right,activeEnd.port.right-15); assert.equal(activeEnd.rect.bottom,activeEnd.port.bottom-12);
  assert(activeEnd.content.right-activeEnd.rect.right>100 && activeEnd.content.bottom-activeEnd.rect.bottom>100, 'flex end item is displaced from both normal end edges');
  assert.match((await run('sticky-nested-end-insets-active', {x:40,y:40,width:600,height:300})).error, /Sticky content/);

  await load(fixture.replace('position:sticky;top:0;', 'position:sticky;top:10%;'));
  await geometry('document-percent-inset', {x:0,y:0,width:600,height:220});
  const percentage = await evaluate('getComputedStyle(document.getElementById("tabs")).top');
  const percentCapture = await run('sticky-document-percent-inset', {x:0,y:0,width:600,height:220});
  // Engines may resolve computed insets to pixels. The same native comparison is
  // required then; unresolved viewport-relative units are explicitly unsupported.
  if (percentage.endsWith('px')) success(percentCapture, 'resolved percent inset');
  else assert.match(percentCapture.error, /Sticky content/);
  await load(fixture.replace('#tabs{', '#tabs{margin-top:-15px;'));
  const negative = await geometry('negative-natural-start', {x:0,y:0,width:600,height:160}); assert.equal(negative.rect.top,0);
  success(await run('sticky-negative-natural-start-scroll-zero', {x:0,y:0,width:600,height:160}), 'negative normal start has identical unscrolled clone constraint');
  await load(base + '<section style="height:60px"><nav id="tabs"><button></button></nav></section><main></main>');
  await evaluate('scrollTo(0,40)');
  const clamp = await geometry('parent-end-clamp', {x:0,y:40,width:600,height:160});
  assert(clamp.rect.top<0); assert.equal(clamp.rect.bottom,clamp.parent.bottom);
  assert.match((await run('sticky-parent-end-clamp', {x:0,y:40,width:600,height:160})).error, /Sticky content/);

  await load(fixture.replace('#tabs{', '#tabs{transform:translateX(1px);'));
  await geometry('transformed-sticky', {x:0,y:0,width:240,height:160});
  assert.match((await run('sticky-transformed-conservative-refusal', {x:0,y:0,width:240,height:160})).error, /Sticky content/);
  await load(fixture + '<input id="focus" value="retain caret" style="position:absolute;left:700px;top:10px">');
  await evaluate('document.getElementById("focus").focus();document.getElementById("focus").setSelectionRange(2,7);window.captureMutations=[];window.captureMutationObserver=new MutationObserver(records=>captureMutations.push(...records.map(r=>({id:r.target.id,type:r.type,attribute:r.attributeName}))));captureMutationObserver.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true})');
  success(await run('sticky-keeps-live-focus-style-scroll', {x:0,y:0,width:240,height:160}), 'sticky capture with active input');
  const unchanged = await evaluate('({mutations:captureMutations,focus:document.activeElement.id,value:document.getElementById("focus").value,range:[document.getElementById("focus").selectionStart,document.getElementById("focus").selectionEnd],scroll:[scrollX,scrollY],position:getComputedStyle(document.getElementById("tabs")).position})');
  assert.deepEqual(unchanged,{mutations:[],focus:'focus',value:'retain caret',range:[2,7],scroll:[0,0],position:'sticky'});
  reports.push({name:'sticky-no-live-mutation-focus-or-scroll',...unchanged,restored:true});

  const shadows = '<style>html,body{margin:0;padding:0;max-width:none;background:white}#box{position:absolute;left:300px;top:180px;width:100px;height:80px;background:#81a8c3;box-shadow:-130px 0 0 6px #d84951, 130px 0 12px -4px #3766d1, 0 -110px 8px 4px #2c9360, inset 0 0 0 90px #873e72}</style><div id="box"></div>';
  await load(shadows);
  for (const [name, region] of [
    ['shadow-negative-offset-spread', {x:150,y:165,width:140,height:110}],
    ['shadow-positive-offset-negative-spread-blur', {x:410,y:160,width:150,height:120}],
    ['shadow-multiple-top-blur', {x:270,y:50,width:160,height:120}],
  ]) success(await run(name, region), name);
  await load('<style>html,body{margin:0;padding:0;max-width:none;background:white}#scaled{position:absolute;left:300px;top:100px;transform:scale(3);transform-origin:top left}#box{width:50px;height:50px;background:#ccc;box-shadow:0 0 0 20px #d84951}</style><div id="scaled"><div id="box"></div></div>');
  success(await run('scaled-ancestor-shadow-paint-is-retained', {x:240,y:40,width:45,height:100}), 'scaled shadow outside its CSS-pixel bounds');
  await load('<style>html,body{margin:0;padding:0;max-width:none;background:white}#text{position:absolute;left:450px;top:100px;margin:0;font:40px monospace;color:#17365d;text-shadow:-200px 0 2px #d44,0 -70px 0 #293}</style><p id="text">MMMM</p>');
  const text = await run('text-shadow-negative-offset-multiple-layers', {x:240,y:90,width:125,height:65}, {redPaint:true});
  assert.equal(text.error,undefined);
  const paint=text.pixelDiff.redPaint;
  // Native screen text and SVG-image text use different subpixel rasterization.
  // Verify actual red shadow paint and its spatial distribution, not a relaxed
  // global differing-pixel percentage that could hide a missing or shifted shadow.
  assert(paint.native.mass>150000 && paint.actual.mass>150000, 'the cropped red shadow must actually paint');
  assert(paint.actual.bbox.every((value,i)=>Math.abs(value-paint.native.bbox[i])<=1), 'shadow edges match within one antialiased pixel');
  assert(paint.actual.center.every((value,i)=>Math.abs(value-paint.native.center[i])<0.25), 'shadow weighted center matches');
  assert(paint.massDifferenceFraction<0.01 && paint.xProjectionDifferenceFraction<0.06 && paint.yProjectionDifferenceFraction<0.01, 'shadow ink and directional projections match');
  assert(text.pixelDiff.meanChannelError<1.5 && text.pixelDiff.peakChannelError<=32, 'only bounded antialias intensity differences are tolerated');
  await load('<style>html,body{margin:0;padding:0;max-width:none;background:white}#target{width:300px;height:200px;background:#a3bfd0}#outside{position:absolute;left:800px;top:80px;width:70px;height:60px;box-shadow:0 0 0 6px #e43}</style><div id="target"></div><div id="outside"></div>');
  const mutation = await evaluate('(async()=>{captureProbe={};let ran=false,error;window.beforeCaptureSerialize=()=>{document.getElementById("outside").style.boxShadow="-600px 0 0 6px #e43";ran=true};try{await captureForTest({x:0,y:0,width:300,height:200},new AbortController().signal)}catch(e){error=e.message}return {ran,error}})()');
  assert.equal(mutation.ran,true); assert.match(mutation.error,/changed/); reports.push({name:'outside-shadow-moving-into-selection-invalidates',...mutation});
  console.log('PASS sticky natural-position crops and directional shadow PNGs match native pixels; active sticky remains explicitly refused');
}
