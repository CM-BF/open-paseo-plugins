// Isolated browser integration fixture: real BoardView, useBoard/TanStack Query, CanvasFrame,
// sandbox runtime and controls, with only the Paseo transport/native primitives adapted.
import { createElement, useState } from "react";
// @ts-expect-error ReactDOM is only used by this fixture.
import { createRoot } from "react-dom/client";
// @ts-expect-error ReactDOM is only used by this fixture.
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BoardView } from "../client/board";
import { BoardHome } from "../client/home";
import { readBoardView } from "../client/view-store";
import { createDraftStore } from "../client/draft-store";
import { createBatchStore } from "../client/batch-store";
import { interactionMarkers } from "../shared/frame-contract";
import { DEFAULT_LIGHT_COLORS } from "../shared/frame-theme";
import type { Board, BoardChange, BoardEventCursor, BoardSummary, CanvasUpdate, Interaction } from "../shared/contracts";
import { componentIdentityFor } from "../shared/component-identity";
import { installBoardEventTransport, type BoardEventListener } from "../client/board-events";
const global = globalThis as any;
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
// Only the dedicated draft scope retains its mock server across a full page
// reload. Production draft persistence is never copied into this fixture key.
const fixtureParams = new URLSearchParams(global.location.search);
const resumeScope = fixtureParams.get("resume") === "1";
const fixtureBoardId = fixtureParams.get("board") ?? "host-fixture";
const fixtureHostId = fixtureParams.get("host") ?? "fixture-host";
const fixtureServerKey = (fixtureParams.get("drafts") === "1" || resumeScope) ? `host-fixture-server:${fixtureHostId}:${fixtureBoardId}` : undefined;
const retainedFixture = fixtureServerKey ? JSON.parse(global.sessionStorage.getItem(fixtureServerKey) ?? "null") : null;
const fragment = `<style>body{padding:24px;margin:0;font:16px sans-serif}#point{position:absolute;top:140px;left:120px;width:100px;height:70px;background:#ebf5ed}#field{display:block;margin-top:40px}#words{margin-top:100px;width:600px}#far{margin-top:850px}</style><h1>Actual BoardView fixture</h1><button id="control">Keep running</button><output id="count">0</output><input id="field" value="initial"><div id="point">Point here</div><div id="side-remount-reference" style="position:absolute;right:24px;top:84px;width:200px;height:32px">Side selection reference</div><p id="words">A stable sentence for selecting the original location.</p><div id="edit-preview-fixture" style="display:none;position:absolute;inset:0;pointer-events:none"><div id="edit-preview-home" style="position:absolute;left:28px;top:290px;pointer-events:auto"><article id="edit-preview-source" style="box-sizing:border-box;width:250px;height:96px;border:2px solid #247865;background:#cff3e4;padding:16px">Preview result stays visible</article></div><section id="edit-preview-target" style="position:absolute;right:24px;top:600px;box-sizing:border-box;width:300px;min-height:110px;border:2px solid #51678c;padding:8px;pointer-events:auto">Destination near the canvas edge</section></div><div id="far">Far below</div><script>
const NativeImage=window.Image;const imageSrc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
window.captureGate=null;window.captureCompleted=0;
window.pauseNextCapture=()=>{if(window.captureGate)throw new Error('capture already held');window.captureGate={held:false,release:null};return true};
window.Image=function(...args){const image=new NativeImage(...args);Object.defineProperty(image,'src',{configurable:true,get(){return imageSrc.get.call(image)},set(value){const gate=window.captureGate;if(gate&&!gate.held&&String(value).startsWith('data:image/svg+xml')){gate.held=true;gate.fail=()=>new Promise(resolve=>{image.addEventListener('error',()=>resolve(true),{once:true});window.captureGate=null;imageSrc.set.call(image,'data:image/svg+xml,invalid-svg')});gate.release=()=>new Promise((resolve,reject)=>{image.addEventListener('load',()=>{window.captureCompleted++;resolve(true)},{once:true});image.addEventListener('error',reject,{once:true});window.captureGate=null;imageSrc.set.call(image,value)})}else imageSrc.set.call(image,value)}});return image};window.Image.prototype=NativeImage.prototype;
window.failCapture=()=>{if(!window.captureGate?.fail)throw new Error('capture has not reached image decode');return window.captureGate.fail()};
window.releaseCapture=()=>{if(!window.captureGate?.release)throw new Error('capture has not reached image decode');return window.captureGate.release()};

window.boots=1;window.ticks=0;window.count=0;function tick(){ticks++;requestAnimationFrame(tick)}requestAnimationFrame(tick);document.querySelector('#control').onclick=()=>{count++;document.querySelector('#count').textContent=count};
let fixtureViewScope=null,fixtureRetirementScroll=null;
window.addEventListener('message',async e=>{
  if(e.source===parent&&e.data?.channel==='paseo-board-frame-v1'&&e.data.type==='view-port'&&e.ports[0]){
    fixtureViewScope={boardId:e.data.boardId,sessionId:e.data.sessionId};
    const port=e.ports[0],send=port.postMessage;
    port.postMessage=function(message,...rest){
      // Queue a read-only intent before native send: the receiving observer may
      // remove this iframe immediately. The trusted port event, not this intent,
      // is the independent proof that native send actually happened.
      if(message?.type==='view-state')parent.postMessage({channel:'host-fixture-port-send-intent',message,sendIntentAtAbsolute:performance.timeOrigin+performance.now(),retirementScroll:fixtureRetirementScroll},'*');
      return send.call(this,message,...rest);
    };
  }
  // Negative-test scheduling only: the trusted parent arms a real child scroll
  // and production capture. A native port observer later remounts before the
  // production consumer; this bridge never constructs a view payload.
  if(e.source===parent&&e.data?.channel==='host-fixture-retirement'&&e.data.type==='scroll'&&e.data.boardId===fixtureViewScope?.boardId&&e.data.sessionId===fixtureViewScope?.sessionId&&e.data.deltaY===125&&typeof e.data.requestId==='string'){
    const before={x:scrollX,y:scrollY,token:window.resumeBootToken},startedAtAbsolute=performance.timeOrigin+performance.now();
    scrollBy({top:e.data.deltaY,left:0,behavior:'instant'});
    fixtureRetirementScroll={requestId:e.data.requestId,...fixtureViewScope,parentMatched:e.source===parent,before,after:{x:scrollX,y:scrollY,token:window.resumeBootToken},startedAtAbsolute,finishedAtAbsolute:performance.timeOrigin+performance.now()};
  }
  if(e.source===parent&&e.data?.channel==='paseo-board-frame-v1'&&e.data.type==='restore-view')parent.postMessage({channel:'host-fixture-restore',request:e.data,at:performance.now(),context:board.getContext(),scroll:{x:scrollX,y:scrollY}},'*');if(e.source===parent&&e.data?.channel==='paseo-board-frame-v1'&&e.data.type==='focus-interaction')parent.postMessage({channel:'host-fixture-focus',id:e.data.id},'*');if(e.source===parent&&e.data?.channel==='paseo-board-frame-v1'&&e.data.type==='focus-update')parent.postMessage({channel:'host-fixture-update',request:e.data},'*');if(e.source===parent&&e.data?.channel==='host-fixture'){try{const value=await eval(e.data.code);parent.postMessage({channel:'host-fixture-result',id:e.data.id,value},'*')}catch(error){parent.postMessage({channel:'host-fixture-result',id:e.data.id,error:error.message},'*')}}
});
</script>${fixtureParams.get("batch") === "1" ? `<section id="batch-authored-target" style="position:absolute;top:360px;left:28px;width:360px;padding:12px;border:1px solid #aaa">A section with an authored Comment action</section><button id="batch-authored-comment" style="position:absolute;top:430px;left:28px">Comment</button><script>window.batchAskResults=[];window.batchAskErrors=[];document.querySelector('#batch-authored-comment').onclick=()=>board.ask({prompt:'Review this authored section',anchor:document.querySelector('#batch-authored-target')}).then(result=>batchAskResults.push(result),error=>batchAskErrors.push(error.message));</script>` : ""}`;
let persisted: Board = retainedFixture?.board ?? { schemaVersion: 1, id: fixtureBoardId, title: "Host integration fixture", ownerAgentId: "owner-fixture", revision: 1, createdAt: now(), updatedAt: now(), canvas: { html: fragment, revision: 1, documentVersion: 1, data: { summary: "Isolated test fixture" }, patches: [] }, decisions: [], interactions: [], updates: [], seenUpdateIds: [], events: [], observations: [], userState: {}, extraction: {} };
// Resume exercises normal inactive-cache retention; existing scopes deliberately
// retain their zero-GC behavior to preserve their original cold-remount contract.
const query = new QueryClient({ defaultOptions: { queries: { retry: false, ...(resumeScope ? {} : { gcTime: 0 }) } } });
const resumeFragment = fragment.replace('</style>', '#resume-surface{position:absolute;left:0;top:0;width:2100px;height:2500px;background:linear-gradient(135deg,#f5f8ff,#e7f4ed)}#resume-surface>h1{position:absolute;left:30px;top:30px}#resume-log{position:absolute;left:680px;top:730px;width:460px;height:210px;overflow:auto;overscroll-behavior:contain;border:2px solid #327759;background:white}#resume-log-content{width:1100px;height:1200px;padding:16px;box-sizing:border-box;background:repeating-linear-gradient(#fff 0 31px,#eee 31px 32px)}#resume-input{position:absolute;left:690px;top:665px;width:320px}#resume-status{position:absolute;left:680px;top:635px}#resume-unread{position:absolute;left:1740px;top:2050px;width:180px;height:80px;background:#ffd8a8}</style>') + `<main id="resume-surface"><h1>Resume surface</h1><output id="resume-status">Initial authoritative content</output><input id="resume-input" value=""><div id="resume-log"><div id="resume-log-content">${Array.from({length:60}, (_,i)=>`<p>Saved experiment log ${i+1}</p>`).join('')}</div></div><div id="resume-unread">Unread distant place</div></main><script>window.resumeBootToken=crypto.randomUUID();window.resumeWheelEvents=[];window.resumeInputEvents=[];document.addEventListener('wheel',e=>{window.resumeWheelEvents.push({trusted:e.isTrusted,target:e.target.id,x:e.deltaX,y:e.deltaY});},{passive:true});document.addEventListener('input',e=>{window.resumeInputEvents.push({trusted:e.isTrusted,target:e.target.id,value:e.target.value});});parent.postMessage({channel:'resume-fixture-boot',token:window.resumeBootToken},'*');</script>`;
const resumeBoards = new Map<string, Board>(retainedFixture?.resumeBoards ?? []);
if (resumeScope && !resumeBoards.size) for (const host of [fixtureHostId, "other-host"]) for (const id of [fixtureBoardId, "another-board"]) {
  const item = copy(persisted); item.id=id; item.title = id === fixtureBoardId ? "Host integration fixture" : "Another project"; item.workspaceId = "resume-workspace"; item.ownerAgentId = id === fixtureBoardId ? "agent-a" : "agent-b"; item.canvas.html=resumeFragment;
  resumeBoards.set(`${host}:${id}`, item);
}
let activeHost = fixtureHostId;
let holdReads = false;
let snapshotHeldReads = false;
const pendingReads: Array<() => void> = [];
let holdFailureReads = false;
const pendingFailureReads: Array<() => void> = [];
let eventEpoch: string = retainedFixture?.eventEpoch ?? "fixture";
let submitMode: "held" | "accept" | "reject" | "lost-response" = "held";
let sideSequence = retainedFixture?.sideSequence ?? 0;
let choiceMode: "held" | "accept" | "reject" | "lost-response" = "accept";
let readFails = retainedFixture?.readFails ?? false;
let renameMode: "held" | "accept" | "reject" | "lost-response" = "accept";
let pendingRename: { input: any; resolve(value: Board): void; reject(error: Error): void } | undefined;
const renameReceipts = new Map<string, string>();
let editMode: "accept" | "reject" | "handler-error" | "lost-response" = "accept";
const editReceipts = new Map<string, string>();
let pendingChoice: { input: any; resolve(value: Board): void; reject(error: Error): void } | undefined;
const pending = new Map<string, { input: any; resolve(value: Interaction): void; reject(error: Error): void }>();
const eventListeners = new Set<BoardEventListener>();
let eventSequence = 0;
let holdChanges = false;
let holdCheck = false;
let checkFails = false;
const eventJournal: BoardChange[] = [];
const pendingChanges: Array<() => void> = [];
const pendingChecks: Array<() => void> = [];
const cursor = () => ({ epoch: eventEpoch, sequence: eventSequence });
const summary = (persistedBoard: Board = persisted): BoardSummary => { const persisted = persistedBoard; return ({ id: persisted.id, title: persisted.title, ownerAgentId: persisted.ownerAgentId, workspaceId: persisted.workspaceId, revision: persisted.revision, createdAt: persisted.createdAt, updatedAt: persisted.updatedAt, decisionCount: persisted.decisions.length, pendingCount: persisted.interactions.filter(item => !["answered", "applied", "rejected"].includes(item.status)).length, unreadUpdateCount: persisted.updates.filter(update => !persisted.seenUpdateIds.includes(update.id)).length, latestUpdateRevision: persisted.updates.at(-1)?.boardRevision ?? 0, status: persisted.interactions.some(item => item.status === "failed") ? "error" : persisted.interactions.some(item => ["saved", "sending", "delivered", "processing"].includes(item.status)) ? "processing" : "idle" }); };
const summaries = () => resumeScope ? [...resumeBoards.entries()].filter(([key]) => key.startsWith(`${activeHost}:`)).map(([,board])=>summary(board)) : [summary(), { ...summary(), id: "another-board", title: "Another project", unreadUpdateCount: 3, latestUpdateRevision: 4, status: "idle" as const }];
const changes = (since?: BoardEventCursor, compact = false) => {
  if (!since || since.epoch !== eventEpoch || since.sequence > eventSequence) return { mode: "snapshot", boards: summaries(), cursor: cursor() };
  const events = eventJournal.filter(event => event.cursor.sequence > since.sequence);
  return compact ? { mode: "compact", fromCursor: since, changes: [...new Map(events.map(event => [event.summary.id, event])).values()].sort((a, b) => a.cursor.sequence - b.cursor.sequence), cursor: cursor() } : { mode: "delta", changes: events, cursor: cursor() };
};
if (new URLSearchParams(global.location.search).get("push") !== "off") installBoardEventTransport((_hostId, listener) => { eventListeners.add(listener); global.queueMicrotask(() => { if (eventListeners.has(listener)) listener.reconnect(); }); return () => { eventListeners.delete(listener); }; });
const notify = (reason: "metadata" | "attention" = "metadata") => {
  // Mutations such as addUpdate complete their persisted fields synchronously
  // after advance(). Publish the fully committed projection at the microtask edge.
  global.queueMicrotask(() => { eventSequence++; const event = { cursor: cursor(), summary: summary(), canvasRevision: persisted.canvas.revision, reason }; eventJournal.push(copy(event)); for (const listener of eventListeners) listener.change(copy(event)); });
};
const persistFixture = () => { if (fixtureServerKey) global.sessionStorage.setItem(fixtureServerKey, JSON.stringify({ board: persisted, calls: fixture.calls, sideSequence, readFails, ...(resumeScope ? { resumeBoards: [...resumeBoards], eventEpoch } : {}) })); };
const advance = () => { persisted = { ...persisted, revision: persisted.revision + 1, updatedAt: now() }; persistFixture(); notify(); };
const fixture: any = global.hostFixture = {
  resumeScope,
  resumeBoots: [] as any[],
  readMetrics: [] as any[],
  failureReadMetrics: [] as any[],
  holdReads: (next: boolean, snapshot = false) => { holdReads=next; snapshotHeldReads=snapshot; if (!next) for (const finish of pendingReads.splice(0)) finish(); },
  pendingReads: () => pendingReads.length,
  holdFailureReads: (next: boolean) => { holdFailureReads=next; },
  pendingFailureReads: () => pendingFailureReads.length,
  rejectFailureReads: () => { for (const reject of pendingFailureReads.splice(0)) reject(); },
  resumeBoard: (id=fixtureBoardId, host=fixtureHostId) => copy(resumeBoards.get(`${host}:${id}`)),
  resumeMutation: (kind: "patch" | "attention" | "epoch", value: string) => {
    const board = resumeBoards.get(`${fixtureHostId}:${fixtureBoardId}`)!;
    if (kind === "attention") board.seenUpdateIds = [value];
    else if (kind === "patch") { board.revision++; board.canvas.revision++; board.canvas.patches.push({ id: `resume-${board.revision}`, selector: "#resume-status", operation: "replace", html: `<output id="resume-status">${value}</output>` }); }
    else { eventEpoch=`reset-${value}`; eventSequence=0; eventJournal.splice(0); board.revision=1; board.canvas={...board.canvas, revision:1, documentVersion:board.canvas.documentVersion+1, patches:[], data:{summary:value}, html:resumeFragment.replace("Initial authoritative content",value)}; }
    eventSequence++; const event: BoardChange = {cursor:cursor(), summary:summary(board), canvasRevision:board.canvas.revision, reason:kind === "attention" ? "attention" : "metadata"}; eventJournal.push(copy(event)); persistFixture();
    if (activeHost === fixtureHostId) for (const listener of eventListeners) listener.change(copy(event));
    return copy(board);
  },
  resumeUnread: (id="resume-unread") => {
    const board = resumeBoards.get(`${fixtureHostId}:${fixtureBoardId}`)!; board.revision++;
    board.updates.push({id,eventId:id,at:now(),boardRevision:board.revision,canvasRevision:board.canvas.revision,documentVersion:board.canvas.documentVersion,kind:"patch",targets:[{selector:"#resume-unread"}]} as CanvasUpdate);
    eventSequence++; const event:BoardChange={cursor:cursor(),summary:summary(board),canvasRevision:board.canvas.revision,reason:"metadata"}; eventJournal.push(copy(event)); persistFixture(); if(activeHost===fixtureHostId)for(const listener of eventListeners)listener.change(copy(event));
  },
  resumeReplaceWithUpdate: (value:string,id:string) => {
    const board=resumeBoards.get(`${fixtureHostId}:${fixtureBoardId}`)!;board.revision++;
    board.canvas={...board.canvas,revision:board.canvas.revision+1,documentVersion:board.canvas.documentVersion+1,patches:[],html:resumeFragment.replace("Initial authoritative content",value)};
    // Keep the old update in history. A new-document initial candidate must not
    // be overwritten by the old document's deferred automatic candidate.
    board.updates.push({id,eventId:id,at:now(),boardRevision:board.revision,canvasRevision:board.canvas.revision,documentVersion:board.canvas.documentVersion,kind:"document",targets:[{selector:"#resume-unread"}]} as CanvasUpdate);
    eventSequence++;const event:BoardChange={cursor:cursor(),summary:summary(board),canvasRevision:board.canvas.revision,reason:"metadata"};eventJournal.push(copy(event));persistFixture();if(activeHost===fixtureHostId)for(const listener of eventListeners)listener.change(copy(event));return copy(board);
  },
  cacheBoard: (id=fixtureBoardId, host=fixtureHostId) => { const cached = query.getQueryData<any>(["paseo-board",host,id]); return copy(cached && "epoch" in cached && "board" in cached ? cached.board ?? null : cached ?? null); },
  boardQueryState: (id=fixtureBoardId, host=fixtureHostId) => { const state=query.getQueryState(["paseo-board",host,id]); return state ? {status:state.status,fetchStatus:state.fetchStatus} : null; },
  eventCursor: () => copy(cursor()),
  componentIdentitySource: componentIdentityFor.toString(),
  uiEvents: [] as any[], raw: [] as any[], calls: (retainedFixture?.calls ?? []) as any[], links: [] as string[], openedAgents: [] as string[], anchors: [] as any[], focusRequests: [] as string[], updateRequests: [] as any[], updatePositions: [] as any[], ready: 0, responseClicks: 0, responseResults: [] as any[],
  board: () => copy(persisted),
  // These helpers observe the production stores. reviseDraft is an explicit
  // concurrency fixture, never used to simulate a user's composer interaction.
  drafts: () => createDraftStore({ hostId: fixtureHostId, boardId: fixtureBoardId }).list(),
  batches: () => createBatchStore({ hostId: fixtureHostId, boardId: fixtureBoardId }).list(),
  markers: () => interactionMarkers(persisted.interactions),
  reviseDraft: (id: string, text: string) => {
    const store = createDraftStore({ hostId: fixtureHostId, boardId: fixtureBoardId });
    const saved = store.list().drafts.find(item => item.id === id);
    if (!saved) throw new Error("Concurrent fixture draft does not exist");
    return store.put({ ...saved, open: false, compose: { ...saved.compose, text } }, saved.revision);
  },
  pageInstance: global.crypto.randomUUID(),
  backCalls: 0,
  persistServer: persistFixture,
  mode: (next: typeof submitMode) => { submitMode = next; },
  choiceMode: (next: typeof choiceMode) => { choiceMode = next; },
  readFails: (next: boolean) => { readFails = next; persistFixture(); },
  editMode: (next: typeof editMode) => { editMode = next; },
  renameMode: (next: typeof renameMode) => { renameMode = next; },
  eventDisconnect: (unsupported = false) => { for (const listener of eventListeners) listener.error(Object.assign(new Error(unsupported ? "Fixture host does not support events" : "Fixture event connection lost"), { code: unsupported ? "plugin_events_unsupported" : "plugin_events_disconnected" })); },
  eventReconnect: () => { for (const listener of eventListeners) listener.reconnect(); },
  holdChanges: (next: boolean) => { holdChanges = next; if (!next) for (const resolve of pendingChanges.splice(0)) resolve(); },
  holdCheck: (next: boolean) => { holdCheck = next; if (!next) for (const resolve of pendingChecks.splice(0)) resolve(); },
  checkFails: (next: boolean) => { checkFails = next; },
  renameElsewhere: (title: string) => { persisted.title = title; advance(); },
  acceptRename: () => {
    if (!pendingRename) throw new Error("No pending rename");
    const request = pendingRename; pendingRename = undefined;
    if (request.input.expectedTitle !== persisted.title) { request.reject(new Error("Board 名称已被修改，请核对当前名称后重试。")); return; }
    persisted.title = request.input.title; advance(); renameReceipts.set(request.input.eventId, JSON.stringify(request.input)); request.resolve(copy(persisted));
  },
  pendingChoice: () => pendingChoice?.input,
  acceptChoice: () => {
    if (!pendingChoice) throw new Error('No pending side choice');
    const request = pendingChoice; pendingChoice = undefined;
    if (request.input.expectedRevision !== persisted.revision) { request.reject(new Error('Fixture side choice revision conflict')); return; }
    persisted.sideAgentId = request.input.agentId; delete persisted.pendingSideInteractionId; advance(); request.resolve(copy(persisted));
  },
  setPendingSide: (id: string) => { persisted.pendingSideInteractionId = id; advance(); },
  pending: () => [...pending.keys()],
  accept: (id = [...pending.keys()][0], status: Interaction["status"] = "delivered", settle = true) => {
    const item = pending.get(id); if (!item) throw new Error(`No pending ${id}`);
    if (item.input.boardId !== persisted.id || item.input.expectedCreatedAt !== undefined && item.input.expectedCreatedAt !== persisted.createdAt) {
      pending.delete(id); item.reject(new Error("Fixture interaction Board incarnation changed")); return;
    }
    const destination = item.input.destination;
    let kind = item.input.kind;
    let agentId = "owner-fixture";
    if (destination === "new-side" || destination === "side" && !persisted.sideAgentId || !destination && kind === "fork") {
      kind = "fork"; agentId = `discussion-fixture-${++sideSequence}`; persisted.sideAgentId = agentId;
    } else if (destination === "side") { kind = "reply"; agentId = persisted.sideAgentId!; }
    else if (destination === "main") kind = item.input.comments || item.input.kind === "change" ? "change" : "question";
    const time = now(); const result: Interaction = { ...item.input, kind, status, agentId, resultReferences: [], createdAt: time, updatedAt: time };
    delete (result as any).boardId; (result as any).id = item.input.intentId; delete (result as any).intentId;
    persisted.interactions = [...persisted.interactions.filter(entry => entry.id !== result.id), result]; advance(); if (settle) { pending.delete(id); if (submitMode === "lost-response") item.reject(new Error("Fixture interaction response lost after commit")); else item.resolve(copy(result)); } return result;
  },
  commitPending: (id = [...pending.keys()][0]) => fixture.accept(id, "delivered", false),
  reject: (id = [...pending.keys()][0]) => { const item = pending.get(id); if (!item) throw new Error(`No pending ${id}`); pending.delete(id); item.reject(new Error("Fixture delivery unavailable")); },
  updateInteraction: (id: string, patch: Partial<Interaction>) => { persisted.interactions = persisted.interactions.map(item => item.id === id ? { ...item, ...copy(patch), updatedAt: now() } : item); advance(); },
  setCanvasData: (data: Board["canvas"]["data"]) => { persisted.canvas = { ...persisted.canvas, revision: persisted.canvas.revision + 1, data }; advance(); },
  updateCanvas: () => { persisted.canvas = { ...persisted.canvas, revision: persisted.canvas.revision + 1, data: { ...persisted.canvas.data, next: true } }; advance(); },
  // An authored change (one more agent patch), unlike updateCanvas's data-only write.
  appendHtml: (id: string, html: string) => { persisted.canvas = { ...persisted.canvas, revision: persisted.canvas.revision + 1, patches: [...persisted.canvas.patches, { id, at: now(), source: "agent", selector: "body", operation: "append", html } as any] }; advance(); },
  patchCanvas: (text: string) => { persisted.canvas = { ...persisted.canvas, revision: persisted.canvas.revision + 1, patches: [...persisted.canvas.patches, { id: `share-edit-${persisted.canvas.patches.length + 1}`, at: now(), source: "agent", selector: "#far", operation: "append", html: `<p class="share-edit">${text}</p>` } as any] }; advance(); },
  addUpdate: (value: Partial<CanvasUpdate> & { id: string }, patch?: any) => {
    if (patch) persisted.canvas = { ...persisted.canvas, revision: persisted.canvas.revision + 1, patches: [...persisted.canvas.patches, { id: `patch-${value.id}`, at: now(), source: "agent", ...copy(patch) }] };
    advance();
    const update: CanvasUpdate = { eventId: value.id, at: now(), boardRevision: persisted.revision, canvasRevision: persisted.canvas.revision, documentVersion: persisted.canvas.documentVersion, kind: 'patch', targets: [], ...copy(value) };
    persisted.updates = [...persisted.updates, update].slice(-80);
    return update;
  },
  seed: (items: Interaction[]) => { persisted.interactions = copy(items); advance(); },
  refetch: () => query.invalidateQueries({ queryKey: ["paseo-board"] }),
  rpc: async (name: string, input: any) => {
    fixture.calls.push({ name, input: copy(input) }); persistFixture();
    if (name === "board.read" && holdFailureReads) {
      const host=activeHost,started=performance.now(),epochAtStart=eventEpoch;
      return new Promise((_resolve,reject)=>pendingFailureReads.push(()=>{
        fixture.failureReadMetrics.push({host,boardId:input.boardId,started,finished:performance.now(),epochAtStart});
        reject(new Error("Fixture held read failed after connection recovery"));
      }));
    }
    if (name === "board.read" && readFails) throw new Error("Fixture read unavailable");
    if (name === "board.read" && resumeScope) {
      const host = activeHost, started = performance.now(), epochAtStart=eventEpoch;
      const snapshotted=holdReads&&snapshotHeldReads, captured=snapshotted?copy(resumeBoards.get(`${host}:${input.boardId}`)):undefined;
      return new Promise(resolve => { const finish=()=>{ const board=snapshotted?captured:resumeBoards.get(`${host}:${input.boardId}`); const result={board:board?copy(board):null,unchanged:false}; fixture.readMetrics.push({host,boardId:input.boardId,started,finished:performance.now(),epochAtStart,snapshotted,bytes:new TextEncoder().encode(JSON.stringify(result)).length,revision:board?.revision,documentVersion:board?.canvas.documentVersion}); resolve(result); }; if (holdReads) pendingReads.push(finish); else finish(); });
    }
    if (name === "board.read") return input.sinceRevision === persisted.revision ? { board: null, unchanged: true } : { board: copy(persisted), unchanged: false };
    if (name === "board.list") return { boards: summaries(), cursor: cursor() };
    if (name === "board.changes") return holdChanges ? new Promise(resolve => pendingChanges.push(() => resolve(changes(input.cursor, input.compact)))) : changes(input.cursor, input.compact);
    if (name === "board.check") {
      const result = () => { if (checkFails) throw new Error("Fixture compact check unavailable"); return { changed: input.cursor.epoch !== eventEpoch || input.cursor.sequence !== eventSequence }; };
      return holdCheck ? new Promise((resolve, reject) => pendingChecks.push(() => { try { resolve(result()); } catch (error) { reject(error); } })) : result();
    }
    if (name === "board.edit") {
      const previous = editReceipts.get(input.eventId);
      if (previous) {
        if (previous !== JSON.stringify(input)) return { status: "rejected", eventId: input.eventId, code: "idempotency_conflict" };
        return { status: "applied", eventId: input.eventId, board: copy(persisted) };
      }
      if (input.canvasBase.documentVersion !== persisted.canvas.documentVersion || input.canvasBase.revision !== persisted.canvas.revision) return { status: "rejected", eventId: input.eventId, code: "revision_conflict" };
      if (editMode === "reject") return { status: "rejected", eventId: input.eventId, code: "edit_conflict" };
      if (editMode === "handler-error") throw Object.assign(new Error("Request failed: Anonymous component no longer matches its authored source; select it again requestType=plugin.rpc.invoke.request code=handler_error"), { requestType: "plugin.rpc.invoke.request", code: "handler_error" });
      persisted.canvas = { ...persisted.canvas, revision: persisted.canvas.revision + 1, patches: [...persisted.canvas.patches, { ...copy(input.patch), html: "", at: now(), source: "user" }] };
      advance(); editReceipts.set(input.eventId, JSON.stringify(input));
      if (editMode === "lost-response") throw new Error("Fixture component save response lost");
      return { status: "applied", eventId: input.eventId, board: copy(persisted) };
    }
    if (name === "board.rename") {
      const previous = renameReceipts.get(input.eventId);
      if (previous) {
        if (previous !== JSON.stringify(input)) throw new Error("Fixture rename idempotency conflict");
        return copy(persisted);
      }
      if (renameMode === "reject") throw new Error("Fixture rename unavailable");
      if (input.expectedTitle !== persisted.title) throw new Error("Board 名称已被修改，请核对当前名称后重试。");
      if (renameMode === "lost-response") {
        persisted.title = input.title; advance(); renameReceipts.set(input.eventId, JSON.stringify(input));
        throw new Error("Fixture rename response lost");
      }
      return new Promise<Board>((resolve, reject) => { pendingRename = { input, resolve, reject }; if (renameMode === "accept") fixture.acceptRename(); });
    }
    if (name === "board.updates-seen") {
      if(resumeScope){const board=resumeBoards.get(`${activeHost}:${input.boardId}`)!;const live=new Set(board.updates.map(item=>item.id));board.seenUpdateIds=[...new Set([...board.seenUpdateIds,...input.updateIds])].filter((id:any)=>live.has(id));eventSequence++;const event:BoardChange={cursor:cursor(),summary:summary(board),canvasRevision:board.canvas.revision,reason:"attention"};eventJournal.push(copy(event));persistFixture();for(const listener of eventListeners)listener.change(copy(event));return copy(board);}
      const live = new Set(persisted.updates.map(item => item.id));
      persisted.seenUpdateIds = [...new Set([...persisted.seenUpdateIds, ...input.updateIds])].filter((id: any) => live.has(id));
      notify("attention");
      return copy(persisted);
    }
    if (name === "board.state") { persisted.userState = copy(input.state); return { saved: true }; }
    // Share links: none by default; ?share=changed seeds one with unpublished authored changes.
    if (name === "board.release.share-status") {
      const canvas = persisted.canvas, key = "s" + "a".repeat(20);
      return { current: { canvasBase: { revision: canvas.revision, documentVersion: canvas.documentVersion }, documentVersion: canvas.documentVersion, patchCount: canvas.patches.length },
        shares: fixtureParams.get("share") === "changed" ? [{ seriesId: "share-fixture", githubHost: "github.com", account: "fixture", repository: "fixture/site", shareKey: key, adoptable: false,
          link: `https://fixture.github.io/site/boards/${key}/`, verified: true, state: "changed", releaseId: "release-" + "b".repeat(64), title: "Fixture share", publishedJobId: "fixture-share-job",
          settingsAvailable: true, source: { canvasBase: { revision: 0, documentVersion: 0 }, documentVersion: 0, patchCount: 0 } }] : [] };
    }
    // Live data: off by default; ?live=blocked seeds a channel the owner has to act on.
    if (name === "board.live.get") {
      const status = { state: "off", seq: 0, attempts: 0, withheld: [] };
      if (fixtureParams.get("live") !== "blocked") return { channel: null, status, preview: null, backend: null, originProblems: [], consentDigest: null };
      return { channel: { channelId: `c${"a".repeat(32)}`, origin: "https://api.example.test", deploymentId: "fixture-deployment", marks: [{ path: "/live", subtree: false }], state: "blocked", eventId: "fixture-live-event" },
        status: { ...status, state: "blocked", lastError: { code: "token_rejected", message: "后端拒绝了写入令牌", at: "2026-11-10T00:00:00.000Z" } }, preview: null, backend: null, originProblems: [], consentDigest: null };
    }
    if (name === "board.side-agent") {
      if (!persisted.interactions.some(item => item.kind === 'fork' && item.agentId === input.agentId)) throw new Error('Fixture side agent is unrelated');
      return new Promise<Board>((resolve, reject) => {
        if (choiceMode === 'reject') { reject(new Error('Fixture side selection unavailable')); return; }
        if (choiceMode === 'lost-response') {
          persisted.sideAgentId = input.agentId; delete persisted.pendingSideInteractionId; advance();
          reject(new Error('Fixture side selection response lost')); return;
        }
        pendingChoice = { input, resolve, reject };
        if (choiceMode === 'accept') fixture.acceptChoice();
      });
    }
    if (name === "board.interact") {
      if (input.boardId !== persisted.id || input.expectedCreatedAt !== undefined && input.expectedCreatedAt !== persisted.createdAt) throw new Error("Fixture interaction Board incarnation changed");
      const existing = persisted.interactions.find(item => item.id === input.intentId);
      if (existing) {
        for (const key of ["expectedCreatedAt", "text", "anchor", "comments", "destination", "sourceInteractionId"]) if (JSON.stringify((existing as any)[key]) !== JSON.stringify(input[key])) throw new Error("Fixture interaction idempotency conflict");
        return copy(existing);
      }
      if (input.sourceInteractionId && !persisted.interactions.some(item => item.id === input.sourceInteractionId)) throw new Error("Fixture source interaction does not exist");
      return new Promise<Interaction>((resolve, reject) => {
        pending.set(input.intentId, { input, resolve, reject });
        if (submitMode === "accept" || submitMode === "lost-response") fixture.accept(input.intentId);
        if (submitMode === "reject") fixture.reject(input.intentId);
      });
    }
    throw new Error(`Unexpected RPC ${name}`);
  },
};
for (const name of ["pointerdown", "pointerup", "click"]) global.addEventListener(name, (event: any) => {
  if (!event.isTrusted) return;
  fixture.uiEvents.push({ type: name, label: event.target?.closest?.("[aria-label]")?.getAttribute("aria-label"), tag: event.target?.tagName, x: event.clientX, y: event.clientY });
  fixture.uiEvents = fixture.uiEvents.slice(-24);
}, true);
global.addEventListener("pagehide", persistFixture);
let requestId = 0;
const frameRequests = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
let mainFrameSequence = 0;
let mainReadyCount = 0;
const mainFrames = new WeakMap<object, { id: number; readySession?: string }>();
const currentMainFrame = () => {
  const frame = global.document.querySelector(resumeScope ? "iframe[data-board-id]" : `iframe[data-board-id="${fixtureBoardId}"]`);
  if (!frame) return undefined;
  let entry = mainFrames.get(frame);
  if (!entry) { entry = { id: ++mainFrameSequence }; mainFrames.set(frame, entry); }
  const sessionId = frame.srcdoc.match(/"channel":"paseo-board-frame-v1","boardId":"[^"]+","sessionId":"([^"]+)"/)?.[1];
  return { frame, entry, sessionId };
};
fixture.mainReady = () => {
  const current = currentMainFrame();
  return current ? { frameId: current.entry.id, sessionId: current.sessionId, ready: Boolean(current.sessionId && current.entry.readySession === current.sessionId), count: mainReadyCount } : null;
};
fixture.readyRecords = [];
fixture.viewDiagnostics = [];
fixture.restoreRequests = [];
fixture.retirementMessages = [];
fixture.retirementOutbound = [];
fixture.viewPortChannels = [];
fixture.viewPortMessages = [];
let retirementSource:object | null=null;
let retirementFrame:{isConnected:boolean} | null=null;
let retirementProbe:any;
let retirementSequence=0;
fixture.traceView = (phase:string, detail?:unknown) => {
  const current=currentMainFrame(),frame=current?.frame,boardId=frame?.dataset.boardId??fixtureBoardId;
  const cached=resumeScope?fixture.cacheBoard(boardId,activeHost):persisted;
  const version=cached?.canvas.documentVersion;
  let disk:unknown;try{disk=JSON.parse(global.localStorage.getItem("@paseo:board-view:v1")??"null")?.records?.filter((record:any)=>record.kind==="view"&&record.hostId===fixtureHostId&&[fixtureBoardId,"another-board"].includes(record.boardId));}catch(e){disk=String(e);}
  const owned=resumeScope?resumeBoards.get(`${fixtureHostId}:${fixtureBoardId}`):persisted;
  const entry={phase,at:performance.now(),detail,activeHost,route:fixture.route?.(),hidden:global.document.hidden,
    frame:current?{id:current.entry.id,boardId,sessionId:current.sessionId,ready:current.entry.readySession===current.sessionId,rect:frame.getBoundingClientRect().toJSON(),embeddedDocumentVersion:Number(frame.srcdoc.match(/"documentVersion":(\d+)/)?.[1])}:null,
    cached:cached?{revision:cached.revision,documentVersion:version,canvasRevision:cached.canvas.revision}:null,
    currentMemory:version===undefined?null:readBoardView(activeHost,boardId,version),
    ownedMemory:owned?readBoardView(fixtureHostId,fixtureBoardId,owned.canvas.documentVersion):null,disk,
    follow:global.document.querySelector('button[aria-label="暂停跟随更新"]')?true:global.document.querySelector('button[aria-label="继续跟随更新"]')?false:null,
    raw:fixture.raw.filter((m:any)=>["view-state","view-restored","ready"].includes(m.type)).slice(-6)};
  fixture.viewDiagnostics.push(entry);fixture.viewDiagnostics=fixture.viewDiagnostics.slice(-160);return entry;
};
// Observe native channels without starting them or changing production message
// delivery. The constructor runs after the real WindowProxy-authenticated ready.
const NativeMessageChannel=global.MessageChannel;
let observedChannelSequence=0;
global.MessageChannel=function(...args:any[]){
  const channel=new NativeMessageChannel(...args),current=currentMainFrame();
  const binding:any={id:++observedChannelSequence,createdAt:performance.now(),hostId:activeHost,frameId:current?.entry.id,sessionId:current?.sessionId,boardId:current?.frame.dataset.boardId,ports:[]};
  fixture.viewPortChannels.push(binding);fixture.viewPortChannels=fixture.viewPortChannels.slice(-80);
  for(const side of ["port1","port2"]){
    const port=channel[side],entry:any={id:`${binding.id}:${side}`,side};binding.ports.push(entry);
    const close=port.close;port.close=function(...closeArgs:any[]){entry.closedAt=performance.now();return close.apply(this,closeArgs);};
    const nativeAdd=port.addEventListener,nativeRemove=port.removeEventListener,observedEvents=new WeakMap<object,{row:any;retired?:any}>();
    let productionListener:unknown;
    const afterHostListener=(event:any)=>{
      const observed=observedEvents.get(event);if(!observed)return;
      if(observed.retired){
        const retired=observed.retired,target=resumeBoards.get(`${retired.targetHost}:${fixtureBoardId}`)!;
        retired.targetMemoryAfter=readBoardView(retired.targetHost,fixtureBoardId,target.canvas.documentVersion);
        retired.oldMemoryAfter=readBoardView(retired.oldHost,fixtureBoardId,resumeBoards.get(`${retired.oldHost}:${fixtureBoardId}`)!.canvas.documentVersion);
        retired.afterAt=performance.now();retired.afterAtAbsolute=performance.timeOrigin+retired.afterAt;retired.afterPhase="native-after-production-consumer-slot";
      }
      fixture.traceView("port-after-host-listener",observed.row);
    };
    port.addEventListener("message",(event:any)=>{
      const message=event.data;if(message?.channel!=="paseo-board-frame-v1"||message.type!=="view-state")return;
      const current=currentMainFrame(),row:any={portId:entry.id,boundSession:binding.sessionId,boundHost:binding.hostId,receivedAt:performance.now(),receivedAtAbsolute:performance.timeOrigin+performance.now(),trusted:event.isTrusted,message:copy(message),currentSession:current?.sessionId,currentFrameId:current?.entry.id};
      fixture.raw.push(message);fixture.viewPortMessages.push(row);fixture.viewPortMessages=fixture.viewPortMessages.slice(-100);
      fixture.traceView("port-before-host",row);
      const observed:{row:any;retired?:any}={row};observedEvents.set(event,observed);
      const probe=retirementProbe;
      if(probe&&event.isTrusted&&entry.id===probe.oldPortId&&message.boardId===fixtureBoardId&&message.sessionId===probe.oldSession&&message.view?.x===probe.expectedView.x&&message.view?.y===probe.expectedView.y&&!probe.replacedAt){
        // Keep this native event and native dispatch intact. Same-scope remount
        // removes/closes its production listener; cross-host remount updates
        // the existing mutable reader. Neither callback is invoked here.
        probe.nativeDispatchStarted=row.receivedAt;probe.nativeDispatchStartedAbsolute=row.receivedAtAbsolute;
        probe.oldFrameConnectedAtDispatch=retirementFrame?.isConnected===true;probe.sessionAtDispatch=current?.sessionId;
        probe.memoryAtDispatch=readBoardView(probe.oldHost,fixtureBoardId,resumeBoards.get(`${probe.oldHost}:${fixtureBoardId}`)!.canvas.documentVersion);
        fixture.retireMount(probe.other);
        const next=currentMainFrame();probe.newSession=next?.sessionId;probe.newFrameId=next?.entry.id;probe.replacedAt=performance.now();probe.replacedAtAbsolute=performance.timeOrigin+probe.replacedAt;
        fixture.retirementProbe=copy(probe);fixture.traceView("retirement-native-dispatch-replaced",fixture.retirementProbe);
        const retired:any={...copy(probe),...row,currentSession:next?.sessionId,currentFrameId:next?.entry.id,trustedMessage:event.isTrusted,oldPortMatched:true,oldFrameRemoved:retirementFrame?.isConnected===false,portClosedAt:entry.closedAt,productionListenerRemovedAt:entry.productionListenerRemovedAt};
        fixture.retirementMessages.push(retired);fixture.retirementMessages=fixture.retirementMessages.slice(-16);
        observed.retired=retired;
      }
      global.queueMicrotask(()=>fixture.traceView("port-between-listeners-microtask",row));
    });
    // A microtask from the earlier observer can run before a later native event
    // listener. Append this read-only observer after the actual host listener;
    // the browser still invokes every callback itself with the original event.
    let afterHostRegistered=false;
    port.addEventListener=function(type:string,listener:unknown,...options:any[]){
      const result=nativeAdd.call(this,type,listener,...options);
      if(type==="message"&&!afterHostRegistered){afterHostRegistered=true;productionListener=listener;nativeAdd.call(this,"message",afterHostListener);}
      return result;
    };
    port.removeEventListener=function(type:string,listener:unknown,...options:any[]){
      const result=nativeRemove.call(this,type,listener,...options);
      if(type==="message"&&listener===productionListener)entry.productionListenerRemovedAt=performance.now();
      return result;
    };
  }
  return channel;
};
global.MessageChannel.prototype=NativeMessageChannel.prototype;
Object.setPrototypeOf(global.MessageChannel,NativeMessageChannel);
for(const type of ["pointerdown","click"])global.addEventListener(type,(event:any)=>{
  const target=event.target?.closest?.('[data-testid^="resume-"]');
  if(target)fixture.traceView("native-"+type,{trusted:event.isTrusted,target:target.getAttribute("data-testid"),x:event.clientX,y:event.clientY});
},true);
// Controlled native-dispatch boundary, confined to two dedicated test buttons.
// A trusted pointer task only arms the case and requests child scroll/capture.
// Once the exact real view reaches the authenticated port, its observer above
// synchronously remounts before native dispatch reaches the production consumer.
// No busy wait, MessageEvent, payload, callback invocation or redispatch is used.
global.addEventListener("pointerdown",(event:any)=>{
  const target=event.target?.closest?.('[data-testid="resume-retire-same"],[data-testid="resume-retire-other-host"]');
  if(!target||!event.isTrusted)return;
  const current=currentMainFrame();if(!current?.sessionId)throw new Error("Retirement probe requires a current ready frame");
  const other=target.getAttribute("data-testid")==="resume-retire-other-host";
  retirementSource=current.frame.contentWindow;
  retirementFrame=current.frame;
  const targetHost=other?"other-host":fixtureHostId;
  const oldReport=fixture.viewPortMessages.findLast((item:any)=>item.message.sessionId===current.sessionId&&item.boundSession===current.sessionId);
  const oldPort=fixture.viewPortChannels.flatMap((item:any)=>item.ports).find((item:any)=>item.id===oldReport?.portId);
  if(!oldPort)throw new Error("Retirement probe requires the current authenticated view port");
  const at=performance.now();
  retirementProbe={at,atAbsolute:performance.timeOrigin+at,scrollRequestId:`retirement-${++retirementSequence}`,other,trustedPointer:event.isTrusted,oldSession:current.sessionId,oldFrameId:current.entry.id,oldPortId:oldPort.id,targetHost,oldHost:activeHost,
    memoryBefore:readBoardView(fixtureHostId,fixtureBoardId,resumeBoards.get(`${fixtureHostId}:${fixtureBoardId}`)!.canvas.documentVersion),
    targetMemoryBefore:readBoardView(targetHost,fixtureBoardId,resumeBoards.get(`${targetHost}:${fixtureBoardId}`)!.canvas.documentVersion)};
  retirementProbe.expectedView={x:retirementProbe.memoryBefore.view.x,y:retirementProbe.memoryBefore.view.y+125};
  fixture.retirementProbe=copy(retirementProbe);fixture.traceView("retirement-native-armed",fixture.retirementProbe);
  // Same parent/source FIFO: real scroll first, then the unchanged runtime's
  // authenticated capture request. No payload or production callback is faked.
  current.frame.contentWindow.postMessage({channel:"host-fixture-retirement",boardId:fixtureBoardId,sessionId:current.sessionId,type:"scroll",deltaY:125,requestId:retirementProbe.scrollRequestId},"*");
  current.frame.contentWindow.postMessage({channel:"paseo-board-frame-v1",boardId:fixtureBoardId,sessionId:current.sessionId,type:"flush-view"},"*");
},true);
global.addEventListener("message", (event: any) => {
  if (event.data?.channel === "paseo-board-frame-v1") fixture.raw.push(event.data);
  if(retirementProbe&&event.data?.channel==="host-fixture-port-send-intent"&&event.data.message?.sessionId===retirementProbe.oldSession){
    const current=currentMainFrame(),port=fixture.viewPortChannels.flatMap((item:any)=>item.ports).find((item:any)=>item.id===retirementProbe.oldPortId);
    const row:any={...copy(retirementProbe),receivedAt:performance.now(),receivedAtAbsolute:performance.timeOrigin+performance.now(),sendIntentAtAbsolute:event.data.sendIntentAtAbsolute,retirementScroll:copy(event.data.retirementScroll),trustedMessage:event.isTrusted,sourceWasOld:event.source===retirementSource,sourceWasNull:event.source===null,message:copy(event.data.message),portClosedAt:port?.closedAt,currentSession:current?.sessionId,oldFrameRemoved:retirementFrame?.isConnected===false};
    fixture.retirementOutbound.push(row);fixture.retirementOutbound=fixture.retirementOutbound.slice(-16);
    global.queueMicrotask(()=>{const target=resumeBoards.get(`${row.targetHost}:${fixtureBoardId}`)!;row.targetMemoryAfter=readBoardView(row.targetHost,fixtureBoardId,target.canvas.documentVersion);row.afterAt=performance.now();});
  }
  if(event.data?.channel==="paseo-board-frame-v1"&&["view-state","view-restored","ready"].includes(event.data.type)){
    const current=currentMainFrame();const detail={message:copy(event.data),trusted:event.isTrusted,sourceIsCurrent:!!current&&event.source===current.frame.contentWindow,sessionMatchesCurrent:!!current&&event.data.sessionId===current.sessionId};
    fixture.traceView("message-before-host",detail);global.queueMicrotask(()=>fixture.traceView("message-after-host-microtask",detail));
  }
  if(event.data?.channel==="host-fixture-restore"){
    const current=currentMainFrame();fixture.restoreRequests.push({...copy(event.data),receivedAt:performance.now(),sourceIsCurrent:!!current&&event.source===current.frame.contentWindow,currentSession:current?.sessionId});fixture.restoreRequests=fixture.restoreRequests.slice(-40);fixture.traceView("restore-request-observed",fixture.restoreRequests.at(-1));
  }
  if (event.data?.channel === "resume-fixture-boot") fixture.resumeBoots.push({token:event.data.token, at:performance.now(), accepted:event.source===currentMainFrame()?.frame.contentWindow});
  if (event.data?.channel === "host-fixture-update") fixture.updateRequests.push(event.data.request);
  if (event.data?.channel === "paseo-board-frame-v1" && event.data.type === "update-position") fixture.updatePositions.push(event.data);
  if (event.data?.channel === "host-fixture-focus") fixture.focusRequests.push(event.data.id);
  if (event.data?.channel === "host-response-fixture" && event.data.clicked) fixture.responseClicks++;
  if (event.data?.channel === "host-response-fixture" && event.data.result) fixture.responseResults.push(event.data.result);
  if (event.data?.channel === "paseo-board-frame-v1" && event.data.type === "ready") {
    // A response visual has its own runtime and ready event. Only the current
    // main iframe's WindowProxy AND embedded session establish main readiness.
    fixture.ready++;
    const current = currentMainFrame();
    const fromMain = current && event.source === current.frame.contentWindow;
    const accepted = fromMain && event.data.boardId === (resumeScope ? current.frame.dataset.boardId : fixtureBoardId) && event.data.sessionId === current.sessionId;
    if (accepted) { current.entry.readySession = current.sessionId; mainReadyCount++; }
    fixture.readyRecords.push({ boardId: event.data.boardId, sessionId: event.data.sessionId, mainFrameId: current?.entry.id, accepted: Boolean(accepted) });
    fixture.readyRecords = fixture.readyRecords.slice(-24);
  }
  if (event.data?.channel === "paseo-board-frame-v1" && event.data.type === "anchor") fixture.anchors.push(event.data.anchor);
  if (event.data?.channel !== "host-fixture-result") return;
  const entry = frameRequests.get(event.data.id); if (!entry) return; frameRequests.delete(event.data.id);
  event.data.error ? entry.reject(new Error(event.data.error)) : entry.resolve(event.data.value);
});
global.fixtureCall = (code: string) => new Promise((resolve, reject) => {
  const id = ++requestId; frameRequests.set(id, { resolve, reject });
  global.document.querySelector(resumeScope ? "iframe[data-board-id]" : `iframe[data-board-id="${fixtureBoardId}"]`).contentWindow.postMessage({ channel: "host-fixture", id, code }, "*");
});
function ResumeApp() {
  const [route, setRoute] = useState({host:fixtureHostId, agent:"agent-a"});
  const [mount, setMount] = useState(0);
  const [, setRevision] = useState(0);
  const tabKey = `resume-fixture-tab:${route.host}:${route.agent}`;
  const [stale, setStale] = useState(false);
  const tab = { state: stale ? fixture.staleTabValue : JSON.parse(global.sessionStorage.getItem(tabKey) ?? "null"), setState: (value:any) => { global.sessionStorage.setItem(tabKey,JSON.stringify(value)); fixture.tabWrites.push({scope:tabKey,value:copy(value)}); } };
  fixture.tabWrites ??= [];
  fixture.route=()=>copy(route);
  fixture.captureTabEcho=()=>{fixture.staleTabValue=JSON.parse(global.sessionStorage.getItem(tabKey) ?? "null");return copy(fixture.staleTabValue);};
  fixture.staleTabRerender=()=>{setStale(true);setRevision(n=>n+1);};
  fixture.retireMount=(other:boolean)=>flushSync(()=>{activeHost=other?"other-host":fixtureHostId;setStale(false);setRoute({host:activeHost,agent:"agent-a"});setMount(n=>n+1);});
  const switchRoute=(host:string,agent:string)=>{fixture.traceView("switchRoute-before",{host,agent});activeHost=host;setStale(false);setRoute({host,agent});global.queueMicrotask(()=>fixture.traceView("switchRoute-microtask",{host,agent}));};
  return createElement(QueryClientProvider, {client:query},
    createElement("nav", {"data-testid":"resume-agent-nav",style:{display:"flex",gap:8,padding:4,height:32,flexShrink:0}},
      ...[[fixtureHostId,"agent-a","A"],[fixtureHostId,"agent-b","B"],["other-host","agent-a","Other host"]].map(([host,agent,label])=>createElement("button",{key:label,"data-testid":`resume-${label.replaceAll(" ","-")}`,onClick:()=>switchRoute(host,agent)},label)),
      createElement("button",{"data-testid":"resume-reopen",onClick:()=>setMount(n=>n+1)},"Reopen"),
      createElement("button",{"data-testid":"resume-retire-same"},"Queue old visit"),
      createElement("button",{"data-testid":"resume-retire-other-host"},"Queue other host")),
    createElement(BoardHome,{key:`${route.host}:${route.agent}:${mount}`,host:{id:route.host},agentId:route.agent,workspaceId:"resume-workspace",entryScope:{hostId:route.host,surface:"agent",workspaceId:"resume-workspace",agentId:route.agent},tab,theme:{colors:DEFAULT_LIGHT_COLORS},navigation:{openAgent:({agentId}:any)=>fixture.openedAgents.push(agentId)}} as any));
}
function App() {
  const [mount, setMount] = useState(0);
  const [index, setIndex] = useState(false);
  const [entryHost,setEntryHost]=useState(fixtureHostId);
  // A first visit is a distinct host scope, not erasure of a user's saved view.
  fixture.index = (firstVisit=false) => { query.clear();if(firstVisit)setEntryHost("first-entry-host");setIndex(true); };
  fixture.remount = () => { query.clear(); setMount(value => value + 1); };
  return createElement(QueryClientProvider, { client: query }, createElement(index ? BoardHome : BoardView, { key: mount, boardId: fixtureBoardId, onBack: () => { fixture.backCalls++; setIndex(true); }, host: { id: entryHost }, theme: { colors: DEFAULT_LIGHT_COLORS }, navigation: { openAgent: ({ agentId }: any) => fixture.openedAgents.push(agentId) } } as any));
}
createRoot(global.document.getElementById("app")).render(createElement(resumeScope ? ResumeApp : App));
