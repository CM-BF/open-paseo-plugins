// Isolated browser integration fixture: real BoardView, useBoard/TanStack Query, CanvasFrame,
// sandbox runtime and controls, with only the Paseo transport/native primitives adapted.
import { createElement, useState } from "react";
// @ts-expect-error ReactDOM is only used by this fixture.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BoardView } from "../client/board";
import { BoardHome } from "../client/home";
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
const fixtureBoardId = fixtureParams.get("board") ?? "host-fixture";
const fixtureHostId = fixtureParams.get("host") ?? "fixture-host";
const fixtureServerKey = fixtureParams.get("drafts") === "1" ? `host-fixture-server:${fixtureHostId}:${fixtureBoardId}` : undefined;
const retainedFixture = fixtureServerKey ? JSON.parse(global.sessionStorage.getItem(fixtureServerKey) ?? "null") : null;
const fragment = `<style>body{padding:24px;margin:0;font:16px sans-serif}#point{position:absolute;top:140px;left:120px;width:100px;height:70px;background:#ebf5ed}#field{display:block;margin-top:40px}#words{margin-top:100px;width:600px}#far{margin-top:850px}</style><h1>Actual BoardView fixture</h1><button id="control">Keep running</button><output id="count">0</output><input id="field" value="initial"><div id="point">Point here</div><p id="words">A stable sentence for selecting the original location.</p><div id="edit-preview-fixture" style="display:none;position:absolute;inset:0;pointer-events:none"><div id="edit-preview-home" style="position:absolute;left:28px;top:290px;pointer-events:auto"><article id="edit-preview-source" style="box-sizing:border-box;width:250px;height:96px;border:2px solid #247865;background:#cff3e4;padding:16px">Preview result stays visible</article></div><section id="edit-preview-target" style="position:absolute;right:24px;top:600px;box-sizing:border-box;width:300px;min-height:110px;border:2px solid #51678c;padding:8px;pointer-events:auto">Destination near the canvas edge</section></div><div id="far">Far below</div><script>
const NativeImage=window.Image;const imageSrc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
window.captureGate=null;window.captureCompleted=0;
window.pauseNextCapture=()=>{if(window.captureGate)throw new Error('capture already held');window.captureGate={held:false,release:null};return true};
window.Image=function(...args){const image=new NativeImage(...args);Object.defineProperty(image,'src',{configurable:true,get(){return imageSrc.get.call(image)},set(value){const gate=window.captureGate;if(gate&&!gate.held&&String(value).startsWith('data:image/svg+xml')){gate.held=true;gate.fail=()=>new Promise(resolve=>{image.addEventListener('error',()=>resolve(true),{once:true});window.captureGate=null;imageSrc.set.call(image,'data:image/svg+xml,invalid-svg')});gate.release=()=>new Promise((resolve,reject)=>{image.addEventListener('load',()=>{window.captureCompleted++;resolve(true)},{once:true});image.addEventListener('error',reject,{once:true});window.captureGate=null;imageSrc.set.call(image,value)})}else imageSrc.set.call(image,value)}});return image};window.Image.prototype=NativeImage.prototype;
window.failCapture=()=>{if(!window.captureGate?.fail)throw new Error('capture has not reached image decode');return window.captureGate.fail()};
window.releaseCapture=()=>{if(!window.captureGate?.release)throw new Error('capture has not reached image decode');return window.captureGate.release()};

window.boots=1;window.ticks=0;window.count=0;function tick(){ticks++;requestAnimationFrame(tick)}requestAnimationFrame(tick);document.querySelector('#control').onclick=()=>{count++;document.querySelector('#count').textContent=count};
window.addEventListener('message',async e=>{if(e.source===parent&&e.data?.channel==='paseo-board-frame-v1'&&e.data.type==='focus-interaction')parent.postMessage({channel:'host-fixture-focus',id:e.data.id},'*');if(e.source===parent&&e.data?.channel==='paseo-board-frame-v1'&&e.data.type==='focus-update')parent.postMessage({channel:'host-fixture-update',request:e.data},'*');if(e.source===parent&&e.data?.channel==='host-fixture'){try{const value=await eval(e.data.code);parent.postMessage({channel:'host-fixture-result',id:e.data.id,value},'*')}catch(error){parent.postMessage({channel:'host-fixture-result',id:e.data.id,error:error.message},'*')}}});
</script>`;
let persisted: Board = retainedFixture?.board ?? { schemaVersion: 1, id: fixtureBoardId, title: "Host integration fixture", ownerAgentId: "owner-fixture", revision: 1, createdAt: now(), updatedAt: now(), canvas: { html: fragment, revision: 1, documentVersion: 1, data: { summary: "Isolated test fixture" }, patches: [] }, decisions: [], interactions: [], updates: [], seenUpdateIds: [], events: [], observations: [], userState: {}, extraction: {} };
const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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
const cursor = () => ({ epoch: "fixture", sequence: eventSequence });
const summary = (): BoardSummary => ({ id: persisted.id, title: persisted.title, ownerAgentId: persisted.ownerAgentId, revision: persisted.revision, createdAt: persisted.createdAt, updatedAt: persisted.updatedAt, decisionCount: persisted.decisions.length, pendingCount: persisted.interactions.filter(item => !["answered", "applied", "rejected"].includes(item.status)).length, unreadUpdateCount: persisted.updates.filter(update => !persisted.seenUpdateIds.includes(update.id)).length, latestUpdateRevision: persisted.updates.at(-1)?.boardRevision ?? 0, status: persisted.interactions.some(item => item.status === "failed") ? "error" : persisted.interactions.some(item => ["saved", "sending", "delivered", "processing"].includes(item.status)) ? "processing" : "idle" });
const summaries = () => [summary(), { ...summary(), id: "another-board", title: "Another project", unreadUpdateCount: 3, latestUpdateRevision: 4, status: "idle" as const }];
const changes = (since?: BoardEventCursor, compact = false) => {
  if (since?.epoch !== "fixture" || since.sequence > eventSequence) return { mode: "snapshot", boards: summaries(), cursor: cursor() };
  const events = eventJournal.filter(event => event.cursor.sequence > since.sequence);
  return compact ? { mode: "compact", fromCursor: since, changes: [...new Map(events.map(event => [event.summary.id, event])).values()].sort((a, b) => a.cursor.sequence - b.cursor.sequence), cursor: cursor() } : { mode: "delta", changes: events, cursor: cursor() };
};
if (new URLSearchParams(global.location.search).get("push") !== "off") installBoardEventTransport((_hostId, listener) => { eventListeners.add(listener); global.queueMicrotask(() => { if (eventListeners.has(listener)) listener.reconnect(); }); return () => { eventListeners.delete(listener); }; });
const notify = (reason: "metadata" | "attention" = "metadata") => {
  // Mutations such as addUpdate complete their persisted fields synchronously
  // after advance(). Publish the fully committed projection at the microtask edge.
  global.queueMicrotask(() => { eventSequence++; const event = { cursor: cursor(), summary: summary(), canvasRevision: persisted.canvas.revision, reason }; eventJournal.push(copy(event)); for (const listener of eventListeners) listener.change(copy(event)); });
};
const persistFixture = () => { if (fixtureServerKey) global.sessionStorage.setItem(fixtureServerKey, JSON.stringify({ board: persisted, calls: fixture.calls, sideSequence, readFails })); };
const advance = () => { persisted = { ...persisted, revision: persisted.revision + 1, updatedAt: now() }; persistFixture(); notify(); };
const fixture: any = global.hostFixture = {
  componentIdentitySource: componentIdentityFor.toString(),
  uiEvents: [] as any[], raw: [] as any[], calls: (retainedFixture?.calls ?? []) as any[], links: [] as string[], openedAgents: [] as string[], anchors: [] as any[], focusRequests: [] as string[], updateRequests: [] as any[], updatePositions: [] as any[], ready: 0, responseClicks: 0, responseResults: [] as any[],
  board: () => copy(persisted),
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
    const destination = item.input.destination;
    let kind = item.input.kind;
    let agentId = "owner-fixture";
    if (destination === "new-side" || destination === "side" && !persisted.sideAgentId || !destination && kind === "fork") {
      kind = "fork"; agentId = `discussion-fixture-${++sideSequence}`; persisted.sideAgentId = agentId;
    } else if (destination === "side") { kind = "reply"; agentId = persisted.sideAgentId!; }
    else if (destination === "main") kind = "question";
    const time = now(); const result: Interaction = { ...item.input, kind, status, agentId, resultReferences: [], createdAt: time, updatedAt: time };
    delete (result as any).boardId; (result as any).id = item.input.intentId; delete (result as any).intentId;
    persisted.interactions = [...persisted.interactions.filter(entry => entry.id !== result.id), result]; advance(); if (settle) { pending.delete(id); if (submitMode === "lost-response") item.reject(new Error("Fixture interaction response lost after commit")); else item.resolve(copy(result)); } return result;
  },
  commitPending: (id = [...pending.keys()][0]) => fixture.accept(id, "delivered", false),
  reject: (id = [...pending.keys()][0]) => { const item = pending.get(id); if (!item) throw new Error(`No pending ${id}`); pending.delete(id); item.reject(new Error("Fixture delivery unavailable")); },
  updateInteraction: (id: string, patch: Partial<Interaction>) => { persisted.interactions = persisted.interactions.map(item => item.id === id ? { ...item, ...copy(patch), updatedAt: now() } : item); advance(); },
  updateCanvas: () => { persisted.canvas = { ...persisted.canvas, revision: persisted.canvas.revision + 1, data: { ...persisted.canvas.data, next: true } }; advance(); },
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
    if (name === "board.read" && readFails) throw new Error("Fixture read unavailable");
    if (name === "board.read") return input.sinceRevision === persisted.revision ? { board: null, unchanged: true } : { board: copy(persisted), unchanged: false };
    if (name === "board.list") return { boards: summaries(), cursor: cursor() };
    if (name === "board.changes") return holdChanges ? new Promise(resolve => pendingChanges.push(() => resolve(changes(input.cursor, input.compact)))) : changes(input.cursor, input.compact);
    if (name === "board.check") {
      const result = () => { if (checkFails) throw new Error("Fixture compact check unavailable"); return { changed: input.cursor.epoch !== "fixture" || input.cursor.sequence !== eventSequence }; };
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
      const live = new Set(persisted.updates.map(item => item.id));
      persisted.seenUpdateIds = [...new Set([...persisted.seenUpdateIds, ...input.updateIds])].filter((id: any) => live.has(id));
      notify("attention");
      return copy(persisted);
    }
    if (name === "board.state") { persisted.userState = copy(input.state); return { saved: true }; }
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
      const existing = persisted.interactions.find(item => item.id === input.intentId);
      if (existing) {
        for (const key of ["text", "anchor", "destination", "sourceInteractionId"]) if (JSON.stringify((existing as any)[key]) !== JSON.stringify(input[key])) throw new Error("Fixture interaction idempotency conflict");
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
  const frame = global.document.querySelector(`iframe[data-board-id="${fixtureBoardId}"]`);
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
global.addEventListener("message", (event: any) => {
  if (event.data?.channel === "paseo-board-frame-v1") fixture.raw.push(event.data);
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
    const accepted = fromMain && event.data.boardId === fixtureBoardId && event.data.sessionId === current.sessionId;
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
  global.document.querySelector(`iframe[data-board-id="${fixtureBoardId}"]`).contentWindow.postMessage({ channel: "host-fixture", id, code }, "*");
});
function App() {
  const [mount, setMount] = useState(0);
  const [index, setIndex] = useState(false);
  fixture.index = () => { query.clear(); setIndex(true); };
  fixture.remount = () => { query.clear(); setMount(value => value + 1); };
  return createElement(QueryClientProvider, { client: query }, createElement(index ? BoardHome : BoardView, { key: mount, boardId: fixtureBoardId, onBack: () => { fixture.backCalls++; setIndex(true); }, host: { id: fixtureHostId }, theme: { colors: DEFAULT_LIGHT_COLORS }, navigation: { openAgent: ({ agentId }: any) => fixture.openedAgents.push(agentId) } } as any));
}
createRoot(global.document.getElementById("app")).render(createElement(App));
