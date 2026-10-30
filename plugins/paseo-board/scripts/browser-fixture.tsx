// Test-only host. The real CanvasFrame is bundled against ReactDOM and driven in Chrome.
import { createElement, Fragment, useState } from "react";
// @ts-expect-error react-dom is only needed by this browser fixture.
import { createRoot } from "react-dom/client";
import { CanvasFrame, WebMessageInput } from "../client/web";
import { frameThemeFromColors, DEFAULT_LIGHT_COLORS, DEFAULT_DARK_COLORS } from "../shared/frame-theme";
const host = globalThis as any;
const fragment = `<style>body{padding:24px;margin:0}#target{min-height:120px}button{margin:5px}#words{display:block;font:20px sans-serif;width:600px}#paint{display:block}#dragbox{position:absolute;left:740px;top:90px;width:220px;height:68px;touch-action:none}#editing{position:absolute;left:740px;top:185px;width:220px}#editing textarea,#editable{display:block;width:200px;margin-bottom:12px}#editable{min-height:32px;border:1px solid #888}</style>
<h1>Live canvas fixture</h1><input id="field" value="initial"><button id="increment">Increment</button><output id="count">0</output>
<button id="ask">Ask agent</button><button id="save">Save state</button><a id="link" href="https://example.com/">External</a>
<form id="form"><input id="form-field" value="sample"><button id="submit">Submit locally</button></form><div id="words">A stable sentence that can be selected while live data keeps changing.</div><div id="target"></div><canvas id="paint" width="180" height="100"></canvas><svg width="100" height="100"><circle cx="50" cy="50" r="35" fill="#dc6040"/></svg>
<button id="dragbox" type="button">Draggable canvas control</button><div id="editing"><textarea id="textarea">Editable notes</textarea><div id="editable" contenteditable="true"><span id="editable-child">Editable rich text</span></div></div>
<script>
window.boots=(window.boots||0)+1;window.ticks=0;window.count=0;window.changes=[];window.restored=board.restoreState();
window.controlEvents={downs:0,moves:0,clicks:0,contexts:[]};let dragging;
const dragbox=document.querySelector('#dragbox');dragbox.onpointerdown=e=>{if(e.button!==0)return;controlEvents.downs++;dragging={x:e.clientX,y:e.clientY,left:parseFloat(dragbox.style.left||'740'),top:parseFloat(dragbox.style.top||'90')}};
window.addEventListener('pointermove',e=>{if(!dragging)return;controlEvents.moves++;dragbox.style.left=dragging.left+e.clientX-dragging.x+'px';dragbox.style.top=dragging.top+e.clientY-dragging.y+'px'});
window.addEventListener('pointerup',()=>{dragging=null});dragbox.onclick=()=>controlEvents.clicks++;
document.addEventListener('contextmenu',e=>controlEvents.contexts.push({target:e.target.id,prevented:e.defaultPrevented}));
// Hold only the screenshot's final SVG image decode. The real capture library still clones
// and renders the document; tests control its slow boundary without replacing runtime code.
const NativeImage=window.Image;const imageSrc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
window.captureGate=null;window.captureCompleted=0;
window.pauseNextCapture=()=>{if(window.captureGate)throw new Error('capture already held');window.captureGate={held:false,release:null};return true};
window.Image=function(...args){const image=new NativeImage(...args);Object.defineProperty(image,'src',{configurable:true,get(){return imageSrc.get.call(image)},set(value){const gate=window.captureGate;if(gate&&!gate.held&&String(value).startsWith('data:image/svg+xml')){gate.held=true;gate.release=()=>new Promise((resolve,reject)=>{image.addEventListener('load',()=>{window.captureCompleted++;resolve(true)},{once:true});image.addEventListener('error',reject,{once:true});window.captureGate=null;imageSrc.set.call(image,value)})}else imageSrc.set.call(image,value)}});return image};window.Image.prototype=NativeImage.prototype;
window.releaseCapture=()=>{if(!window.captureGate?.release)throw new Error('capture has not reached image decode');return window.captureGate.release()};
const tick=()=>{window.ticks++;requestAnimationFrame(tick)};requestAnimationFrame(tick);
board.onData(d=>window.changes.push(d));document.querySelector('#increment').onclick=()=>{count++;document.querySelector('#count').textContent=count};
document.querySelector('#ask').onclick=()=>board.ask({prompt:'Explain this',kind:'question'}).then(r=>window.answer=r);
document.querySelector('#save').onclick=()=>board.saveState({field:document.querySelector('#field').value,count});
document.querySelector('#paint').getContext('2d').fillRect(0,0,180,100);document.querySelector('#form').onsubmit=e=>{e.preventDefault();window.submits=(window.submits||0)+1};
window.addEventListener('message',async e=>{if(e.source===parent&&e.data?.channel==='fixture'){try{const value=await eval(e.data.code);parent.postMessage({channel:'fixture-result',id:e.data.id,value},'*')}catch(error){parent.postMessage({channel:'fixture-result',id:e.data.id,error:error.message},'*')}}});
</script>`;
host.results = { asks: [], composes: [], hostAsks: [], anchors: [], errors: [], states: [], links: [], ready: 0, raw: [], openedInteractions: [], interactionPositions: [], inputSubmits: [], inputCloses: 0, canvasPointers: 0 };
let requestId = 0;
const pending = new Map();
let saveTimer: ReturnType<typeof setTimeout>;
host.addEventListener("message", (event: any) => {
  if (event.data?.channel === "paseo-board-frame-v1") host.results.raw.push(event.data);
  if (event.data?.channel !== "fixture-result") return;
  const entry: any = pending.get(event.data.id);
  if (!entry) return;
  pending.delete(event.data.id);
  event.data.error ? entry.reject(new Error(event.data.error)) : entry.resolve(event.data.value);
});
host.fixtureCall = (code: string) => new Promise((resolve, reject) => {
  const id = ++requestId;
  pending.set(id, { resolve, reject });
  host.document.querySelector("iframe").contentWindow.postMessage({ channel: "fixture", id, code }, "*");
});
function App() {
  const [mount, setMount] = useState(0);
  const [selectedAnchor, setSelectedAnchor] = useState<any>();
  const [input, setInput] = useState<string | null>(null);
  host.showInput = (value: string) => setInput(value);
  host.reconnect = () => setMount((n) => n + 1);
  const [props, setProps] = useState({ boardId: "test-board", title: "Test board", canvas: { html: fragment, data: { n: 0 }, patches: [], revision: 1, documentVersion: 1 }, boardRevision: 1, userState: { saved: "original" }, theme: frameThemeFromColors(DEFAULT_LIGHT_COLORS), height: 700, selectionMode: "off" as any, interactions: [] as any[], selectedInteractionId: undefined as string | undefined });
  host.hostProps = props;
  host.update = (next: any) => setProps((previous) => ({ ...previous, ...next }));
  host.setTheme = (scheme: "light" | "dark") => setProps(p => ({ ...p, theme: frameThemeFromColors(scheme === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS) }));
  host.replaceDocument = () => setProps((p) => ({ ...p, selectionMode: "off", boardRevision: p.boardRevision + 1, canvas: { ...p.canvas, patches: [], revision: p.canvas.revision + 1, documentVersion: p.canvas.documentVersion + 1 } }));
  return createElement(Fragment, null, createElement(CanvasFrame, { ...props, key: mount,
    onAsk: async (request: any) => { host.results.asks.push(request); return { status: "submitted" as const, outcome: "saved" }; },
    onCompose: (request: any) => { host.results.composes.push(request); setProps((p) => ({ ...p, selectionMode: "off" })); },
    onSelectionCapture: (capture: any) => {
      const index = host.results.composes.findIndex((request: any) => request.selectionId === capture.selectionId);
      if (index >= 0) host.results.composes[index] = { ...host.results.composes[index], anchor: capture.anchor, captureStatus: capture.status };
      host.results.anchors.push(capture.anchor); setSelectedAnchor(capture.anchor);
    },
    onCanvasPointer: () => host.results.canvasPointers++,
    onOpenInteraction: (id, position) => { host.results.openedInteractions.push({ id, position }); setProps(p => ({ ...p, selectedInteractionId: id })); },
    onInteractionPosition: (id, position) => host.results.interactionPositions.push({ id, position }),
    onAnchor: (anchor) => { host.results.anchors.push(anchor); setSelectedAnchor(anchor); },
    onState: (state) => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { host.results.states.push(state); setProps((p) => ({ ...p, userState: state as any })); }, 200); },
    onError: (error) => host.results.errors.push(error),
    onOpenLink: (url) => host.results.links.push(url),
    onReady: () => host.results.ready++,
    onSelectionEnd: () => setProps((p) => ({ ...p, selectionMode: "off" })),
    onSelectionClear: () => setSelectedAnchor(undefined),
  }), createElement("button", { id: "host-ask", type: "button", style: { margin: 8 }, onClick: () => host.results.hostAsks.push(selectedAnchor ?? null) }, "Host: ask about selection"), input === null ? null : createElement("div", { style: { position: "fixed", left: 200, top: 220, width: 380 } }, createElement(WebMessageInput, { value: input, onChange: setInput, onSubmit: () => host.results.inputSubmits.push(input), onClose: () => { host.results.inputCloses++; setInput(null); } })));
}
createRoot(host.document.getElementById("app")).render(createElement(App));
