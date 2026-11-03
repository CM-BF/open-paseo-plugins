// Authored fixtures only. All selection/reorder behavior comes from the runtime.
export function componentDragHtml(mode = 'column') {
  const row=mode === 'row'||mode === 'complex-target';
  const layout = row ? 'display:flex;gap:20px;align-items:start' : mode === 'grid' ? 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px' : 'display:flex;flex-direction:column;gap:18px';
  // Hidden authored history stays in structural identity, without changing the
  // visible hit target or tripping the independent direct-child count bound.
  const complexTarget=mode === 'complex-target'?`<section id="drag-complex-target" style="margin-top:20px;padding:20px;height:150px;border:2px solid #537e91;background:#e0f1ea"><h3 style="margin:0">Large original container</h3>${Array.from({length:30},()=>'<div hidden>'+Array.from({length:70},()=>'<span>Stored history</span>').join('')+'</div>').join('')}</section>`:'';
  const html = `<!doctype html><html><head><style>
html,body{margin:0;padding:0;background:#f5f6f8;color:#193043;font:15px/1.4 system-ui}*{box-sizing:border-box}
body.drag-body{padding:20px}body.drag-body>.drag-card{margin-bottom:18px;width:min(900px,100%)}
#drag-fixture{padding:20px;width:min(940px,100%)}#drag-list{${layout};padding:12px;border:2px solid #73879b;background:#e9eff4}
.drag-card{position:relative;min-width:0;min-height:110px;padding:12px;border:2px solid #7b96a6;border-radius:8px;background:#fff}#drag-list>.drag-card{${row ? 'flex:1 1 0;' : ''}}
.drag-card h3{font-size:16px;margin:0 0 8px}.drag-card p{margin:0}.drag-card input{max-width:100%;width:190px;height:26px}.drag-card button{height:26px;margin-right:4px}.drag-card iframe{display:block;width:90px;height:24px;border:0;margin-top:4px}#drag-card-c{min-height:132px}
#drag-nest{margin-top:20px;border:2px dashed #537e91;padding:20px;min-height:150px;background:#e0f1ea}#drag-nest p{margin:0;pointer-events:none}#drag-fixture:after{content:'';display:block;height:210px}
@media(max-width:480px){#drag-fixture{padding:12px}.drag-card{padding:8px}#drag-list{gap:14px;padding:8px}.drag-card h3{font-size:14px}}
</style></head><body><main id="drag-fixture"><section id="drag-list">
<article class="drag-card" id="drag-card-a"><h3>Card A</h3><p>First sibling</p></article>
<article class="drag-card" id="drag-card-b"><h3>Card B</h3><p>Second sibling</p></article>
<article class="drag-card" id="drag-card-c"><h3>Card C with live controls</h3><input id="drag-input" value="Authored input"><button id="drag-button" type="button">Original listener</button><output id="drag-count">0</output><iframe id="drag-frame" srcdoc="&lt;script&gt;window.token=Math.random().toString(36).slice(2);addEventListener('message',e=&gt;{if(e.data==='drag-probe')parent.postMessage({type:'drag-probe-result',token:window.token},'*')});parent.postMessage({type:'drag-probe-result',token:window.token},'*')&lt;/script&gt;"></iframe></article>
<article class="drag-card" id="drag-card-d"><h3>Card D</h3><p>Last sibling</p></article>
</section>${complexTarget}<section id="drag-nest"><p>Drop inside this empty container</p></section></main><script>
// Test-only bridge: each replacement document must answer the host fixture's
// scoped read/observation requests. It is never bundled into the product runtime.
window.addEventListener('message',async e=>{if(e.source===parent&&e.data?.channel==='fixture'){try{const value=await eval(e.data.code);parent.postMessage({channel:'fixture-result',id:e.data.id,value},'*')}catch(error){parent.postMessage({channel:'fixture-result',id:e.data.id,error:error.message},'*')}}});
window.dragFixtureBridgeReady=true;
window.dragBoots=(window.dragBoots||0)+1;window.dragClicks=0;window.dragNativeEvents=[];window.dragNodes=Object.fromEntries(Array.from(document.querySelectorAll('#drag-fixture [id],body.drag-body [id]'),n=>[n.id,n]));window.dragWindow=document.querySelector('#drag-frame').contentWindow;window.dragHeap={sentinel:'retained'};window.dragHeapOriginal=window.dragHeap;
document.querySelector('#drag-button').addEventListener('click',()=>{document.querySelector('#drag-count').textContent=String(++window.dragClicks)});
for(const name of ['pointerdown','pointermove','pointerup'])addEventListener(name,e=>{window.dragNativeEvents.push({type:e.type,trusted:e.isTrusted,buttons:e.buttons});if(window.dragNativeEvents.length>80)window.dragNativeEvents.shift()},true);
addEventListener('message',e=>{if(e.source===window.dragWindow&&e.data?.type==='drag-probe-result')window.dragInnerToken=e.data.token});window.dragWindow.postMessage('drag-probe','*');window.dragFixtureReady=true;
</script></body></html>`;
  return mode === 'body'
    ? html.replace('<body><main id="drag-fixture"><section id="drag-list">', '<body class="drag-body">')
      .replace('</section><section id="drag-nest">', '<section id="drag-nest">')
      .replace('</section></main><script>', '</section><script>')
    : html;
}
