// Real BoardView/query/CanvasFrame integration. Only public transport and native
// primitives are adapted. No connection, credentials, daemon or live agent.
import { createElement, useState } from "react";
// @ts-expect-error ReactDOM is fixture-only.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BoardView } from "../client/board";
import { BoardInstallationProvider, createBoardInstallation } from "../client/transport";
import { readBoardView } from "../client/view-store";
import { boardFromCache } from "../client/board-cache";
import { createDraftStore } from "../client/draft-store";
import type { Board, BoardSummary, Interaction } from "../shared/contracts";
import type { CompositionSnapshot, CompositionSourcesState } from "../shared/composition";
import { DEFAULT_LIGHT_COLORS } from "../shared/frame-theme";
import { componentIdentityFor } from "../shared/component-identity";

const page = globalThis as any;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const bridge = (hostId: string) => `<script>window.heap=crypto.randomUUID();window.clicks=0;window.askResults=[];window.askErrors=[];window.fixtureHost=${JSON.stringify(hostId)};addEventListener('message',async e=>{if(e.source!==top||e.data?.channel!=='composition-host-eval')return;try{const value=await eval(e.data.code);top.postMessage({channel:'composition-host-result',id:e.data.id,value},'*')}catch(error){top.postMessage({channel:'composition-host-result',id:e.data.id,error:error.message},'*')}});document.querySelector('#control').onclick=()=>{window.clicks++;document.querySelector('#count').textContent=window.clicks};document.querySelector('#comment').onclick=()=>board.ask({prompt:'Comment '+window.fixtureHost+' '+board.getContext().boardId,anchor:document.querySelector('#target')}).then(value=>window.askResults.push(value),error=>window.askErrors.push(error.message));document.querySelector('#save').onclick=()=>board.saveState({value:document.querySelector('#value').value});top.postMessage({channel:'composition-host-ready',hostId:window.fixtureHost,boardId:board.getContext().boardId,heap:window.heap},'*');</script>`;
const controls = `<input id="value" value="original"><button id="control">Count</button><output id="count">0</output><button id="comment">Comment</button><button id="save">Save local state</button><p id="target">A meaningful local reference</p>`;
const sourceHtml = (hostId: string) => `<style>body{margin:0;padding:12px;font:14px system-ui;min-width:900px;min-height:1800px}button{display:block;height:32px;margin:4px}#target{width:200px;padding:10px;background:#eee}</style><h2>${hostId} same ID</h2>${controls}<div id="far" style="margin-top:1000px">Unread source update</div>${bridge(hostId)}`;
const parentHtml = `<style>body{margin:0;padding:12px;font:14px system-ui}#layout{display:grid;gap:12px;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:12px}paseo-board{height:430px;border:1px solid #ddd}button{height:32px;margin:4px}</style><h1>Composition integration</h1>${controls}<main id="layout"><paseo-board id="slot-a" slot-id="a" host-id="host-a" board-id="same"></paseo-board><paseo-board id="slot-b" slot-id="b" host-id="host-b" board-id="same"></paseo-board><paseo-board id="slot-c" slot-id="c" host-id="host-b" board-id="same"></paseo-board></main>${bridge("host-a")}`;
function makeBoard(hostId: string, id: string): Board {
  return { schemaVersion: 1, id, title: `${hostId} / ${id}`, ownerAgentId: `${hostId}-owner`, revision: 1, createdAt: now(), updatedAt: now(),
    canvas: { html: id === "parent" ? parentHtml : sourceHtml(hostId), data: {}, revision: 1, documentVersion: 1, patches: [] }, decisions: [], interactions: [],
    updates: id === "parent" ? [] : [{ id: "unread", eventId: "unread", at: now(), boardRevision: 1, canvasRevision: 1, documentVersion: 1, kind: "document", targets: [{ selector: "#far" }] }],
    seenUpdateIds: [], events: [], observations: [], userState: {}, extraction: {} };
}
const boards = new Map([ ["host-a", new Map([["parent", makeBoard("host-a", "parent")], ["same", makeBoard("host-a", "same")]])], ["host-b", new Map([["same", makeBoard("host-b", "same")]])] ]);
const summary = (board: Board): BoardSummary => ({ id: board.id, title: board.title, ownerAgentId: board.ownerAgentId, revision: board.revision, createdAt: board.createdAt, updatedAt: board.updatedAt, decisionCount: 0, pendingCount: 0, unreadUpdateCount: board.updates.filter(item => !board.seenUpdateIds.includes(item.id)).length, latestUpdateRevision: board.updates.at(-1)?.boardRevision ?? 0, status: "idle" });
let sources: CompositionSourcesState = { boardId: "parent", boardCreatedAt: boards.get("host-a")!.get("parent")!.createdAt, revision: 0, sources: [] };
const snapshot = (hostId: string, board: Board): CompositionSnapshot => {
  const empty = { included: 0, total: 0, truncated: false };
  return { sourceRef: { hostId, boardId: board.id }, revision: board.revision, canvasRevision: board.canvas.revision, documentVersion: board.canvas.documentVersion, observedAt: now(), title: board.title, createdAt: board.createdAt, updatedAt: board.updatedAt,
    coverage: { source: "persistent-store", liveBrowserObserved: false, historyComplete: false, text: { ...empty, replayComplete: true }, data: empty, updates: empty, interactions: empty, note: "Fixture bounded persistent-store observation" }, text: board.title, data: [], updates: [], interactions: [], unreadUpdateCount: 1, pendingCount: 0 };
};
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const fixture: any = page.compositionFixture = { calls: [], opens: [], navigation: [], ready: [], fallbackCalls: [], sources: () => clone(sources), board: (host: string, id: string) => clone(boards.get(host)?.get(id)),
  cached: (host: string, id: string) => boardFromCache(query.getQueryCache().findAll({ queryKey: ["paseo-board", host, id] })[0]?.state.data as any),
  view: (slot: string) => { const hostId = slot === "a" ? "host-a" : "host-b"; return readBoardView(hostId, "same", 1, JSON.stringify(["host-a", "parent", slot, boards.get(hostId)!.get("same")!.createdAt])); },
  ordinaryView: (host: string) => readBoardView(host, "same", 1), drafts: (host: string, id: string) => createDraftStore({ hostId: host, boardId: id }).list(),
};
const sourceWindows = new Map<string, unknown>();
fixture.distinctSources = (oldHeap: string, newHeap: string) => sourceWindows.has(oldHeap) && sourceWindows.has(newHeap) && sourceWindows.get(oldHeap) !== sourceWindows.get(newHeap);
fixture.rawViewMessages = [];
// Optional read-only native-port diagnostics; never synthesize a production view
// receipt. Matching removeEventListener preserves the production cleanup path.
if (new URLSearchParams(page.location.search).has("trace")) {
  const originalAdd = page.MessagePort.prototype.addEventListener, originalRemove = page.MessagePort.prototype.removeEventListener;
  const wrapped = new WeakMap<object, Map<unknown, unknown>>(); fixture.viewTrace = [];
  page.MessagePort.prototype.addEventListener = function(type: string, listener: any, options: unknown) {
    if (type !== "message" || typeof listener !== "function") return originalAdd.call(this, type, listener, options);
    let listeners = wrapped.get(this); if (!listeners) { listeners = new Map(); wrapped.set(this, listeners); }
    let wrapper = listeners.get(listener);
    if (!wrapper) {
      wrapper = function(this: unknown, event: any) {
        const observed = ["view-state", "view-restored"].includes(event.data?.type);
        const row = observed ? { at: performance.now(), message: clone(event.data), before: ["a", "b", "c"].map(slot => fixture.view(slot)), after: undefined as unknown } : undefined;
        const result = listener.call(this, event);
        if (row) { row.after = ["a", "b", "c"].map(slot => fixture.view(slot)); fixture.viewTrace.push(row); }
        return result;
      };
      listeners.set(listener, wrapper);
    }
    return originalAdd.call(this, type, wrapper, options);
  };
  page.MessagePort.prototype.removeEventListener = function(type: string, listener: unknown, options: unknown) { return originalRemove.call(this, type, wrapped.get(this)?.get(listener) ?? listener, options); };
}
page.hostFixture = { links: [], rpc(name: string, input: unknown) { fixture.fallbackCalls.push({ name, input }); throw new Error("A composition operation fell back to the carrier SDK transport"); } };
const nativeClients = new Map<string, any>();
for (const hostId of ["host-a", "host-b"]) {
  const eventListeners = new Set<any>(); let sequence = 0;
  const cursor = () => ({ epoch: hostId, sequence });
  const notify = (board: Board, reason = "metadata") => { sequence++; for (const listener of eventListeners) listener.onEvent({ cursor: cursor(), summary: summary(board), canvasRevision: board.canvas.revision, reason }); };
  const client = {
    paseo: { hosts: { list: async () => ({ self: { serverId: hostId, label: hostId }, hosts: [] }) }, agents: { list: async () => ({ entries: [] }) } },
    openScreen: (input: unknown) => fixture.opens.push({ hostId, input }),
    subscribeEvent: (_contract: unknown, listener: any) => { eventListeners.add(listener); queueMicrotask(() => { if (eventListeners.has(listener)) listener.onReconnect(); }); return { ready: Promise.resolve(), dispose: async () => { eventListeners.delete(listener); } }; },
    rpc: async (contract: any, raw: any) => {
      const input = contract.input.parse(raw); fixture.calls.push({ hostId, name: contract.name, input: clone(input) });
      const local = boards.get(hostId)!; const board = local.get(input.boardId); let result: unknown;
      switch (contract.name) {
        case "board.list": result = { boards: [...local.values()].map(summary), cursor: cursor() }; break;
        case "board.read": result = { board: board ? clone(board) : null, unchanged: false }; break;
        case "board.changes": result = { mode: "snapshot", boards: [...local.values()].map(summary), cursor: cursor() }; break;
        case "board.check": result = { changed: input.cursor.epoch !== hostId || input.cursor.sequence !== sequence }; break;
        case "board.composition.sources": if (hostId !== "host-a" || input.boardId !== "parent") throw new Error("Wrong parent source host"); result = clone(sources); break;
        case "board.composition.set-sources":
          if (hostId !== "host-a" || input.boardId !== "parent" || input.expectedRevision !== sources.revision) throw new Error("Wrong source grant destination");
          sources = { ...sources, revision: sources.revision + 1, sources: input.sources.map((source: any) => ({ ref: { hostId: source.hostId, boardId: source.boardId }, sourceCreatedAt: source.sourceCreatedAt, grantedAt: now() })) }; result = clone(sources); break;
        case "board.composition.inspect": if (!board) throw new Error("Missing source"); result = snapshot(hostId, board); break;
        case "board.composition.sync-source":
          if (hostId !== "host-a" || input.boardId !== "parent" || input.expectedSourcesRevision !== sources.revision || !sources.sources.some(source => JSON.stringify(source.ref) === JSON.stringify(input.ref) && source.sourceCreatedAt === input.snapshot.createdAt)) throw new Error("Unpermitted snapshot destination or source incarnation");
          result = { sourceCreatedAt: input.snapshot.createdAt, revision: input.snapshot.revision, canvasRevision: input.snapshot.canvasRevision, documentVersion: input.snapshot.documentVersion, observedAt: input.snapshot.observedAt, receivedAt: now() }; break;
        case "board.interact": {
          if (!board) throw new Error("Wrong interaction board");
          if (input.expectedCreatedAt !== undefined && input.expectedCreatedAt !== board.createdAt) throw new Error("Wrong interaction board incarnation");
          const interaction: Interaction = { id: input.intentId, expectedCreatedAt: input.expectedCreatedAt, kind: input.kind, destination: input.destination, text: input.text, anchor: input.anchor, comments: input.comments, sourceInteractionId: input.sourceInteractionId, status: "delivered", resultReferences: [], agentId: board.ownerAgentId, createdAt: now(), updatedAt: now() };
          if (fixture.nextReceiptPatch) { result = { ...interaction, ...fixture.nextReceiptPatch }; delete fixture.nextReceiptPatch; break; }
          board.interactions.push(interaction); board.revision++; result = clone(interaction); queueMicrotask(() => notify(board)); break;
        }
        case "board.edit": {
          if (!board || input.canvasBase.revision !== board.canvas.revision || input.canvasBase.documentVersion !== board.canvas.documentVersion) throw new Error("Wrong component edit board or revision");
          if (input.patch.operation !== "text" || input.patch.selector !== "#target") throw new Error("Only the fixture's exact text edit is accepted");
          const authored = new page.DOMParser().parseFromString(board.canvas.html, "text/html");
          const target = authored.querySelector("#target");
          for (const patch of board.canvas.patches) if (patch.operation === "text" && patch.selector === "#target") target.textContent = patch.text;
          if (JSON.stringify(componentIdentityFor(target)) !== JSON.stringify(input.patch.sourceIdentity) || target.textContent !== input.patch.expectedText) throw new Error("The fixture text identity changed");
          board.revision++; board.canvas.revision++; board.canvas.patches.push(clone(input.patch));
          result = { status: "applied", eventId: input.eventId, board: clone(board) }; queueMicrotask(() => notify(board)); break;
        }
        case "board.state": if (!board || input.expectedCreatedAt !== board.createdAt) throw new Error("Wrong state board incarnation"); board.userState = clone(input.state); result = { saved: true }; break;
        case "board.updates-seen": if (!board) throw new Error("Wrong seen board"); board.seenUpdateIds.push(...input.updateIds); result = clone(board); break;
        default: throw new Error(`Unexpected isolated RPC ${contract.name}`);
      }
      const parsed = contract.output.safeParse(result);
      if (!parsed.success) { fixture.errors ??= []; fixture.errors.push({ hostId, name: contract.name, issues: parsed.error.issues }); throw parsed.error; }
      return parsed.data;
    },
  };
  nativeClients.set(hostId, { client, notify });
}
const installations = new Map([...nativeClients].map(([hostId, value]) => [hostId, createBoardInstallation(value.client as unknown as PluginClientContext)]));
fixture.dispose = (hostId: string) => installations.get(hostId)!.dispose();
fixture.recreateSource = () => {
  const replacement = makeBoard("host-b", "same");
  replacement.createdAt = new Date(Date.parse(boards.get("host-b")!.get("same")!.createdAt) + 1000).toISOString();
  boards.get("host-b")!.set("same", replacement);
  nativeClients.get("host-b").notify(replacement);
  return clone(replacement);
};
fixture.patchParent = () => {
  const parent = boards.get("host-a")!.get("parent")!;
  const authored = new page.DOMParser().parseFromString(parent.canvas.html, "text/html");
  parent.revision++; parent.canvas.revision++;
  parent.canvas.patches.push({ id: "move-slot-c", operation: "move", selector: '#slot-c', sourceIdentity: componentIdentityFor(authored.querySelector('#slot-c')), destination: '#slot-a', destinationIdentity: componentIdentityFor(authored.querySelector('#slot-a')), position: "before", html: "" });
  nativeClients.get("host-a").notify(parent);
};
const pending = new Map<number, any>(); let requestId = 0;
page.addEventListener("message", (event: any) => {
  if (event.data?.channel === "composition-host-ready") { fixture.ready.push(event.data); sourceWindows.set(event.data.heap, event.source); }
  if (event.data?.channel === "paseo-board-frame-v1" && event.data.type === "view-state") fixture.rawViewMessages.push({ data: clone(event.data), trusted: event.isTrusted });
  if (event.data?.channel === "composition-host-result") { const item = pending.get(event.data.id); pending.delete(event.data.id); if (item) { clearTimeout(item.timer); event.data.error ? item.reject(new Error(event.data.error)) : item.resolve(event.data.value); } }
});
const callWindow = (target: { postMessage(message: unknown, origin: string): void }, code: string) => new Promise((resolve, reject) => {
  const id = ++requestId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture frame timeout: ${code.slice(0, 120)}`)); }, 8000);
  pending.set(id, { resolve, reject, timer }); target.postMessage({ channel: "composition-host-eval", id, code }, "*");
});
fixture.frame = async (slot: string, code: string) => {
  const parent = page.document.querySelector('iframe[data-board-id="parent"]')?.contentWindow;
  if (!parent) throw new Error("Parent iframe unavailable");
  if (slot === "parent") return callWindow(parent, code);
  const index = await callWindow(parent, `(()=>{const child=document.querySelector('paseo-board[slot-id="${slot}"] iframe');return Array.from({length:frames.length},(_,index)=>index).find(index=>frames[index]===child?.contentWindow)})()`);
  if (typeof index !== "number") throw new Error(`Slot ${slot} unavailable`);
  return callWindow(parent.frames[index], code);
};
function App() {
  const [mount, remount] = useState(0); fixture.remount = () => remount(value => value + 1);
  return <QueryClientProvider client={query}><BoardInstallationProvider installation={installations.get("host-a")!} host={{ id: "host-a", label: "host-a" }}>
    <BoardView key={mount} host={{ id: "host-a", label: "host-a" }} boardId="parent" onBack={() => undefined} theme={{ colors: DEFAULT_LIGHT_COLORS }} layout={{ compact: false, platform: "web" }} navigation={{ openAgent: (input: unknown) => fixture.navigation.push(input) } as any} />
  </BoardInstallationProvider></QueryClientProvider>;
}
createRoot(page.document.getElementById("app")).render(createElement(App));
