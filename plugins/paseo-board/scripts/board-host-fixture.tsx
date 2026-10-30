// Isolated browser integration fixture: real BoardView, useBoard/TanStack Query, CanvasFrame,
// sandbox runtime and controls, with only the Paseo transport/native primitives adapted.
import { createElement, useState } from "react";
// @ts-expect-error ReactDOM is only used by this fixture.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BoardView } from "../client/board";
import { DEFAULT_LIGHT_COLORS } from "../shared/frame-theme";
import type { Board, Interaction } from "../shared/contracts";
const global = globalThis as any;
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const fragment = `<style>body{padding:24px;margin:0;font:16px sans-serif}#point{position:absolute;top:140px;left:120px;width:100px;height:70px;background:#ebf5ed}#field{display:block;margin-top:40px}#words{margin-top:100px;width:600px}#far{margin-top:850px}</style><h1>Actual BoardView fixture</h1><button id="control">Keep running</button><output id="count">0</output><input id="field" value="initial"><div id="point">Point here</div><p id="words">A stable sentence for selecting the original location.</p><div id="far">Far below</div><script>
window.boots=1;window.ticks=0;window.count=0;function tick(){ticks++;requestAnimationFrame(tick)}requestAnimationFrame(tick);document.querySelector('#control').onclick=()=>{count++;document.querySelector('#count').textContent=count};
window.addEventListener('message',async e=>{if(e.source===parent&&e.data?.channel==='host-fixture'){try{const value=await eval(e.data.code);parent.postMessage({channel:'host-fixture-result',id:e.data.id,value},'*')}catch(error){parent.postMessage({channel:'host-fixture-result',id:e.data.id,error:error.message},'*')}}});
</script>`;
let persisted: Board = { schemaVersion: 1, id: "host-fixture", title: "Host integration fixture", ownerAgentId: "owner-fixture", revision: 1, createdAt: now(), updatedAt: now(), canvas: { html: fragment, revision: 1, documentVersion: 1, data: { summary: "Isolated test fixture" }, patches: [] }, decisions: [], interactions: [], events: [], observations: [], userState: {}, extraction: {} };
const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
let submitMode: "held" | "accept" | "reject" = "held";
const pending = new Map<string, { input: any; resolve(value: Interaction): void; reject(error: Error): void }>();
const advance = () => { persisted = { ...persisted, revision: persisted.revision + 1, updatedAt: now() }; };
const fixture: any = global.hostFixture = {
  calls: [] as any[], links: [] as string[], openedAgents: [] as string[], ready: 0, responseClicks: 0, responseResults: [] as any[],
  board: () => copy(persisted),
  mode: (next: typeof submitMode) => { submitMode = next; },
  pending: () => [...pending.keys()],
  accept: (id = [...pending.keys()][0], status: Interaction["status"] = "delivered") => {
    const item = pending.get(id); if (!item) throw new Error(`No pending ${id}`);
    const time = now(); const result: Interaction = { ...item.input, status, agentId: "discussion-fixture", resultReferences: [], createdAt: time, updatedAt: time };
    delete (result as any).boardId; (result as any).id = item.input.intentId; delete (result as any).intentId;
    persisted.interactions = [...persisted.interactions.filter(entry => entry.id !== result.id), result]; advance(); pending.delete(id); item.resolve(copy(result)); return result;
  },
  reject: (id = [...pending.keys()][0]) => { const item = pending.get(id); if (!item) throw new Error(`No pending ${id}`); pending.delete(id); item.reject(new Error("Fixture delivery unavailable")); },
  updateInteraction: (id: string, patch: Partial<Interaction>) => { persisted.interactions = persisted.interactions.map(item => item.id === id ? { ...item, ...copy(patch), updatedAt: now() } : item); advance(); },
  updateCanvas: () => { persisted.canvas = { ...persisted.canvas, revision: persisted.canvas.revision + 1, data: { ...persisted.canvas.data, next: true } }; advance(); },
  seed: (items: Interaction[]) => { persisted.interactions = copy(items); advance(); },
  refetch: () => query.invalidateQueries({ queryKey: ["paseo-board"] }),
  rpc: async (name: string, input: any) => {
    fixture.calls.push({ name, input: copy(input) });
    if (name === "board.read") return input.sinceRevision === persisted.revision ? { board: null, unchanged: true } : { board: copy(persisted), unchanged: false };
    if (name === "board.state") { persisted.userState = copy(input.state); return { saved: true }; }
    if (name === "board.interact") {
      if (input.sourceInteractionId && !persisted.interactions.some(item => item.id === input.sourceInteractionId)) throw new Error("Fixture source interaction does not exist");
      return new Promise<Interaction>((resolve, reject) => {
        pending.set(input.intentId, { input, resolve, reject });
        if (submitMode === "accept") fixture.accept(input.intentId);
        if (submitMode === "reject") fixture.reject(input.intentId);
      });
    }
    throw new Error(`Unexpected RPC ${name}`);
  },
};
let requestId = 0;
const frameRequests = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
global.addEventListener("message", (event: any) => {
  if (event.data?.channel === "host-response-fixture" && event.data.clicked) fixture.responseClicks++;
  if (event.data?.channel === "host-response-fixture" && event.data.result) fixture.responseResults.push(event.data.result);
  if (event.data?.channel === "paseo-board-frame-v1" && event.data.type === "ready") fixture.ready++;
  if (event.data?.channel !== "host-fixture-result") return;
  const entry = frameRequests.get(event.data.id); if (!entry) return; frameRequests.delete(event.data.id);
  event.data.error ? entry.reject(new Error(event.data.error)) : entry.resolve(event.data.value);
});
global.fixtureCall = (code: string) => new Promise((resolve, reject) => {
  const id = ++requestId; frameRequests.set(id, { resolve, reject });
  global.document.querySelector('iframe[data-board-id="host-fixture"]').contentWindow.postMessage({ channel: "host-fixture", id, code }, "*");
});
function App() {
  const [mount, setMount] = useState(0);
  fixture.remount = () => { query.clear(); setMount(value => value + 1); };
  return createElement(QueryClientProvider, { client: query }, createElement(BoardView, { key: mount, boardId: "host-fixture", onBack: () => {}, host: { id: "fixture-host" }, theme: { colors: DEFAULT_LIGHT_COLORS }, navigation: { openAgent: ({ agentId }: any) => fixture.openedAgents.push(agentId) } } as any));
}
createRoot(global.document.getElementById("app")).render(createElement(App));
