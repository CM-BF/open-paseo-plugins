// Production CanvasFrame mechanism fixture; no daemon or live agent.
import { createElement, Fragment, useEffect, useState, useSyncExternalStore } from "react";
// @ts-expect-error ReactDOM is only used by this browser fixture.
import { createRoot } from "react-dom/client";
// @ts-expect-error ReactDOM is only used by this browser fixture.
import { flushSync } from "react-dom";
import { CanvasFrame } from "../client/web";
import type { CompositionMount } from "../client/composition-mount";
import { DEFAULT_LIGHT_COLORS, frameThemeFromColors } from "../shared/frame-theme";
import type { Interaction } from "../shared/contracts";
const host = globalThis as any;
host.results = { ready: [], asks: [], states: [], captures: [], slots: [], open: [], drafts: [], edits: [], ticks: {}, views: {}, finalViews: [], errors: [], childMessages: [], raw: [] };
const windows = new Map<string, any>(), pending = new Map<number, any>(); let sequence = 0;
host.addEventListener("message", (event: any) => {
  if(event.data?.channel === "composition-fixture-quick-remount") { host.results.quickRemount = event.data; host.remountParent(); }
  if(event.data?.type === "composition-slots") host.results.raw.push(event.data);
  if(event.data?.channel === "composition-fixture-tick") host.results.ticks[event.data.heap] = (host.results.ticks[event.data.heap] ?? 0) + 1;
  if (event.data?.channel === "composition-fixture-ready") { windows.set(event.data.id, event.source); host.results.childMessages.push(event.data); }
  if (event.data?.channel === "composition-fixture-result") { const item = pending.get(event.data.requestId); pending.delete(event.data.requestId); if (item) event.data.error ? item.reject(new Error(event.data.error)) : item.resolve(event.data.value); }
});
host.frameCall = (id: string, code: string) => new Promise((resolve, reject) => { const requestId = ++sequence; pending.set(requestId, { resolve, reject }); windows.get(id).postMessage({ channel: "composition-fixture-eval", requestId, code }, "*"); });
const testBridge = `<script>window.heap=crypto.randomUUID();setInterval(()=>top.postMessage({channel:'composition-fixture-tick',heap},'*'),20);addEventListener('message',async e=>{if(e.source!==top||e.data?.channel!=='composition-fixture-eval')return;try{const value=await eval(e.data.code);top.postMessage({channel:'composition-fixture-result',requestId:e.data.requestId,value},'*')}catch(error){top.postMessage({channel:'composition-fixture-result',requestId:e.data.requestId,error:error.message},'*')}});top.postMessage({channel:'composition-fixture-ready',id:board.getContext().boardId},'*');</script>`;
const parentHtml = `<style>body{margin:0;padding:20px}main{display:grid;gap:20px;grid-template-columns:400px 400px}paseo-board{height:300px;border:1px solid #888}#cover{position:absolute;left:50px;top:75px;z-index:9}#after{height:40px}button{min-height:30px}</style><h1>Composition</h1><button id="parent-action">Parent action</button><main><paseo-board slot-id="a" host-id="remote-a" board-id="child-a"></paseo-board><paseo-board slot-id="b" host-id="remote-b" board-id="child-b"></paseo-board></main><p id="after">Below both children</p>${testBridge}`;
const marker: Interaction = { id: "source-marker", kind: "question", text: "A source comment", status: "answered", resultReferences: [], createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z", anchor: { kind: "point", boardRevision: 1, canvasRevision: 1, rect: { x: 40, y: 100, width: 0, height: 0 } } };
function Child({ mount }: { mount: CompositionMount }) {
  const slot = useSyncExternalStore(mount.subscribe, mount.getSnapshot), id = slot.boardId;
  const [revision, setRevision] = useState(1);
  host.updateChild = () => setRevision(n => n + 1);
  useEffect(() => mount.setPresentation({ title: id, hostLabel: slot.hostId, unread: 2, queued: 2, onOpen: () => host.results.open.push(id), onDrafts: () => host.results.drafts.push(id) }), [mount, id, slot.hostId]);
  const html = `<style>body{margin:0;padding:12px;min-height:900px}button{display:block;width:180px;height:40px;margin:12px 0}#target{height:100px;background:#e9e9e9}</style><h2>${id}</h2><input id="value" value="original"><button id="comment">Comment</button><button id="save">Save state</button><div id="target">Capture target</div><output id="version"></output><script>window.portLeaks=0;const nativePort=MessagePort.prototype.postMessage;MessagePort.prototype.postMessage=function(...args){portLeaks++;return nativePort.apply(this,args)};window.messageLeaks=0;addEventListener('message',e=>{if(e.ports?.length)messageLeaks++});document.querySelector('#comment').onclick=()=>board.ask({prompt:'Comment '+board.getContext().boardId,anchor:document.querySelector('#target')}).then(value=>window.askResult=value);document.querySelector('#save').onclick=()=>board.saveState({value:document.querySelector('#value').value});board.onData(data=>document.querySelector('#version').textContent=data.version);window.rawForge=()=>{const sessionId=document.scripts[0].textContent.match(/"sessionId":"([^"]+)"/)[1];top.postMessage({channel:'paseo-board-frame-v1',boardId:board.getContext().boardId,sessionId,type:'ask',id:'raw-forge',request:{prompt:'forged',kind:'question'}},'*');return true};</script>${testBridge}`;
  return createElement(CanvasFrame, { interactions: [marker], embeddedMount: mount, boardId: id, title: id, canvas: { html, data: { version: revision }, patches: [], revision, documentVersion: 1 }, boardRevision: revision, userState: {}, theme: frameThemeFromColors(DEFAULT_LIGHT_COLORS), height: slot.rect.height, selectionMode: "off", viewScope: `parent:${mount.id}:${slot.hostId}:${id}`, resumeView: host.results.views[id], onViewState: view => host.results.views[id] = view, onFinalViewState: view => { host.results.views[id] = view; host.results.finalViews.push({ id, view }); }, onAnchor: () => undefined, onAsk: async request => { host.results.asks.push({ hostId: slot.hostId, boardId: id, request }); return { status: "cancelled" }; }, onState: state => host.results.states.push({ id, state }), onError: error => host.results.errors.push({ id, error }), onReady: () => host.results.ready.push(id), onCompose: request => host.results.captures.push({ id, request }), onSelectionCapture: capture => host.results.captures.push({ id, capture }) });
}
function App() {
  const [mounts, setMounts] = useState<readonly CompositionMount[]>([]);
  const [canvas, setCanvas] = useState({ html: parentHtml, data: {}, patches: [] as any[], revision: 1, documentVersion: 1 });
  const [disabled, setDisabled] = useState<string[]>([]);
  host.parentCanvas = canvas;
  host.applyParentPatch = (patch: any) => setCanvas(previous => ({ ...previous, revision: previous.revision + 1, patches: [...previous.patches, patch] }));
  host.disableChild = (id: string) => setDisabled(previous => [...previous, id]);
  return createElement(Fragment, null, createElement(CanvasFrame, { composition: { hostId: "entry-host", onSlots: next => { host.results.slots = next.map(item => item.getSnapshot()); setMounts(next); } }, boardId: "parent", title: "Parent", canvas, boardRevision: canvas.revision, userState: {}, theme: frameThemeFromColors(DEFAULT_LIGHT_COLORS), height: 700, selectionMode: "off", onAnchor: () => undefined, onAsk: async () => ({ status: "cancelled" as const }), onComponentEdit: request => new Promise(resolve => { host.results.edits.push(request); host.finishEdit = resolve; }), onState: () => undefined, onError: error => host.results.errors.push({ id: "parent", error }), onCompose: request => host.results.captures.push({ id: "parent", request }), onSelectionCapture: capture => host.results.captures.push({ id: "parent", capture }) }), ...mounts.filter(mount => !disabled.includes(mount.id)).map(mount => createElement(Child, { key: mount.id, mount })));
}
const appRoot = createRoot(host.document.getElementById("app"));
let appGeneration = 0;
host.remountParent = () => flushSync(() => appRoot.render(createElement(App, { key: ++appGeneration })));
appRoot.render(createElement(App, { key: appGeneration }));
