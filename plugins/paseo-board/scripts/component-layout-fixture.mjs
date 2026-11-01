// Shared authored document for actual CanvasFrame edits and cold static publication.
// No production layout behavior is implemented in this fixture.
export const componentLayoutHtml = `<style>
#layout-fixture{font:16px/1.45 system-ui;padding:18px;color:#183126;background:#f4f7f4}
#layout-grid{display:grid;grid-template-columns:140px minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}
#layout-grid-peer{grid-column:1;grid-row:1;padding:12px;background:#e4eadd}
#layout-target{grid-column:2 / span 2;grid-row:1;align-self:start;min-width:0;margin:7px 9px;padding:14px;border:2px solid #52745a;background:#e4f4e8}
#layout-target>h3{margin:0 0 12px}#layout-target input{display:block;width:180px;max-width:100%;box-sizing:border-box;margin:8px 0}#layout-button{max-width:100%;white-space:normal}
.layout-tall{height:330px;background:linear-gradient(#d1e5cf,#edf5e9);padding:12px;box-sizing:border-box}
#layout-inner{padding:12px;border:1px solid #57745e;margin:18px 0;background:#f2f6ed}
#layout-inner h4{margin:0 0 8px}#layout-inner .layout-tall{height:230px}
#layout-flex{display:flex;gap:18px;align-items:flex-start;margin-top:22px}
#layout-flex-target{flex:2 1 0;box-sizing:content-box;min-width:0;order:2;margin:5px 11px;padding:13px;background:#dae8ed;border:1px solid #58717e}
#layout-flex-peer{flex:1 1 0;min-width:0;order:1;padding:12px;background:#e4eadd}
#layout-flex-border{display:flex;gap:18px;align-items:flex-start;margin-top:22px}
#layout-flex-border-target{flex:2 1 0;box-sizing:border-box;min-width:0;order:2;margin:5px 11px;padding:13px;border:3px solid #58717e;background:#dae8ed}
#layout-flex-border-peer{flex:1 1 0;min-width:0;order:1;padding:12px;background:#e4eadd}
#layout-flex-percent{display:flex;gap:18px;align-items:flex-start;margin-top:22px}
#layout-flex-percent-target{flex:2;box-sizing:content-box;min-width:0;order:2;margin:6px 10px;padding:17px;border:2px solid #58717e;background:#dae8ed}
#layout-flex-percent-peer{flex:1;min-width:0;order:1;padding:12px;background:#e4eadd}
#layout-body{margin-top:22px;padding:15px;border:2px solid #71825c;overflow-y:visible!important;max-height:700px}
#layout-body h3{margin:0 0 9px}#layout-stale{margin-top:22px;padding:20px;background:#eee2ce}
#layout-native{margin-top:22px;padding:12px;border:1px solid #889}#layout-table{margin-top:12px}
#layout-no-heading{height:360px;min-height:320px;padding:12px;border:2px solid #88735e;margin-top:22px;overflow-wrap:anywhere}
#layout-move-destination{margin-top:22px;padding:18px;border:2px dashed #58715e;min-height:80px}
</style>
<section id="layout-fixture">
<button id="layout-author-save" type="button">Save author zoom only</button><button id="layout-author-save-stale" type="button">Save older author state</button>
<div id="layout-grid"><aside id="layout-grid-peer">Unchanged grid sibling</aside><article id="layout-target"><h3 id="layout-heading">Original heading</h3><input id="layout-input" value="Initial authored input"><button id="layout-button" type="button">Count original listener</button><output id="layout-count">0</output><section id="layout-inner"><h4 id="layout-inner-heading">Nested heading</h4><div class="layout-tall">Nested content stays independently collapsible.</div></section><div class="layout-tall">The outer component has enough content for a real scrollbar.</div></article></div>
<div id="layout-flex"><article id="layout-flex-target"><h3>Flex component</h3><div class="layout-tall">Flex item placement must move to its wrapper.</div></article><aside id="layout-flex-peer">Unchanged flex sibling</aside></div>
<div id="layout-flex-border"><article id="layout-flex-border-target"><h3>Border-box flex component</h3><div class="layout-tall">A zero-basis border-box item still contributes its real padding and border.</div></article><aside id="layout-flex-border-peer">Border-box flex sibling</aside></div>
<div id="layout-flex-percent"><article id="layout-flex-percent-target"><h3>Percentage-basis flex component</h3><div class="layout-tall">The common flex:2 shorthand uses zero percent basis.</div></article><aside id="layout-flex-percent-peer">Zero percent flex sibling</aside></div>
<article id="layout-body"><span id="layout-before-heading">Leading sibling</span><h3 id="layout-body-heading">Move the real heading</h3><input id="layout-body-input" value="Body draft"><div class="layout-tall">Contents collapse preserves these child nodes.</div></article>
<div id="layout-no-heading"><p id="layout-plain-text">A fixed-height author container with no heading.</p><div class="layout-tall">A user supplied summary must survive saving and cold replay.</div></div>
<section id="layout-stale"><h3>Identity conflict target</h3><p>Keep this original selection.</p></section>
<details id="layout-native" open><summary>Native author disclosure</summary><section id="layout-native-content">Native content remains ordinary HTML.</section></details>
<table id="layout-table"><tbody><tr id="layout-row"><td>Table row is not a layout container.</td></tr></tbody></table>
<button id="layout-unsupported-button" type="button">Native control</button>
<svg id="layout-unsupported-svg" width="150" height="60"><rect width="130" height="40" fill="#587"></rect></svg>
<section id="layout-move-destination"><p>Ordinary destination for a complete group.</p></section>
</section>
<script>
window.layoutBoots=(window.layoutBoots||0)+1;window.layoutClicks=0;
window.layoutOriginal=document.querySelector('#layout-target');window.layoutInput=document.querySelector('#layout-input');
window.layoutHeading=document.querySelector('#layout-heading');window.layoutOriginalChildren=Array.from(layoutOriginal.childNodes);
window.layoutBody=document.querySelector('#layout-body');window.layoutBodyChildren=Array.from(layoutBody.childNodes);
window.layoutInner=document.querySelector('#layout-inner');window.layoutInnerHeading=document.querySelector('#layout-inner-heading');
document.querySelector('#layout-button').addEventListener('click',()=>{document.querySelector('#layout-count').textContent=String(++window.layoutClicks)});
window.layoutAuthorSelectionClicks=0;for(const id of ['layout-native','layout-table','layout-unsupported-button','layout-unsupported-svg'])document.getElementById(id).addEventListener('click',()=>window.layoutAuthorSelectionClicks++);
window.layoutInitialAuthorState=board.getState();document.querySelector('#layout-author-save').addEventListener('click',()=>board.saveState({zoom:1.75}));document.querySelector('#layout-author-save-stale').addEventListener('click',()=>board.saveState({...window.layoutInitialAuthorState,zoom:2.5}));
window.layoutReady=true;
</script>`;
