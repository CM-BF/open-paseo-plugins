import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { ServiceJournal } from "./journal";
import { BoardBridge } from "./bridge";
import { runtimePaths, writeRuntime } from "./runtime";
const syncFault = vi.hoisted(() => ({ directory: "", remaining: 0 }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    if (String(args[0]) !== syncFault.directory || args[1] !== "r" || syncFault.remaining < 1) return handle;
    return new Proxy(handle, { get(target, property) {
      if (property === "sync") return async () => { syncFault.remaining--; throw Object.assign(new Error("Injected directory fsync error after rename"), { code: "EIO" }); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } };
});
const exec = promisify(execFile);

describe("installed latest-state producer and feed transport", () => {
  let dir: string, store: BoardStore, service: BoardService, bridge: BoardBridge, counter: number;
  beforeEach(async () => {
    syncFault.directory = ""; syncFault.remaining = 0;
    dir = await mkdtemp("/tmp/pf-"); counter = 0;
    store = new BoardStore(join(dir, "data")); await store.create({ id: "board", title: "Feed transport", ownerAgentId: "owner" });
    const journal = new ServiceJournal(join(dir, "service.json")); await journal.init(); await journal.bind("own-token", { agentId: "owner", cwd: dir });
    service = new BoardService(store, journal, () => undefined); bridge = new BoardBridge(service);
    await writeRuntime(runtimePaths(dir)); await bridge.start(runtimePaths(dir).socket);
  });
  afterEach(async () => { await bridge.close(); await service.dispose(); await rm(dir, { recursive: true, force: true }); });
  async function run(body: string, binding = "own-token") {
    const script = join(dir, `producer-${++counter}.mjs`);
    await writeFile(script, `import { createFeed } from ${JSON.stringify(runtimePaths(dir).feedSdk)};\nconst config = ${JSON.stringify({ boardId: "board", sourceId: "worker", path: "/live/a", stateFile: join(dir, "producer.json"), focusSelectors: ["#a"] })};\n${body}`);
    const result = await exec(process.execPath, [script], { env: { ...process.env, PASEO_BOARD_HOME: dir, PASEO_BOARD_BINDING: binding }, timeout: 5000 });
    return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
  }
  it("runs the dependency-free SDK across real processes and recovers sequence from its protected journal", async () => {
    const first = await run('const f = await createFeed(config); console.log(JSON.stringify(await f.set({ score: 1 })));');
    const second = await run('const f = await createFeed(config); console.log(JSON.stringify(await f.set({ score: 2 }, {attention:"milestone"})));');
    expect(first).toMatchObject({ generation: 1, seq: 1 }); expect(second).toMatchObject({ generation: 1, seq: 2 });
    const board = (await store.read("board"))!; expect(board.canvas.data).toEqual({ live: { a: { score: 2 } } });
    expect(board.updates).toHaveLength(1); expect(board.interactions).toHaveLength(0); expect(board.feeds![0].actorAgentId).toBe("owner");
    const journal = await readFile(join(dir, "producer.json"), "utf8"); expect(journal).not.toContain("own-token"); expect(JSON.parse(journal).pending).toBeUndefined();
    expect((await stat(join(dir, "producer.json"))).mode & 0o777).toBe(0o600);
  });
  it("retains one unknown write, blocks a new value, and restarts using the exact same sequence", async () => {
    const dispatch = bridge.dispatch.bind(bridge); let writes = 0;
    bridge.dispatch = async line => { const result = await dispatch(line); if (JSON.parse(line).input.action === "set") { writes++; return undefined; } return result; };
    const first = await run('const f = await createFeed(config); let failure; try { await f.set({score:1}); } catch(e) { failure=e.message; } try { await f.set({score:2}); } catch(e) { console.log(JSON.stringify({failure,blocked:e.code})); }');
    expect(first.blocked).toBe("pending_write"); expect(writes).toBe(3);
    const pending = JSON.parse(await readFile(join(dir, "producer.json"), "utf8")); expect(pending).toMatchObject({ seq: 0, pending: { seq: 1, value: { score: 1 } }, lastError: { confirmed: false } });
    expect((await store.read("board"))!.feeds![0].seq).toBe(1);
    bridge.dispatch = dispatch;
    const next = await run('const f = await createFeed(config); console.log(JSON.stringify(await f.set({score:2})));');
    expect(next.seq).toBe(2);
    const raw = JSON.parse(await readFile(join(dir, "data/boards/board.json"), "utf8")); expect(raw.history.filter((x: { operation: string; payload: { action: string } }) => x.operation === "feed" && x.payload.action === "set")).toHaveLength(2);
  });
  it("does not hide confirmed conflicts; explicit restart adopts manual edits and fences old generations", async () => {
    await run('const f = await createFeed(config); await f.set("original");');
    const board = (await store.read("board"))!;
    await store.publish({ boardId: "board", expectedRevision: board.revision, eventId: "manual", dataPatch: [{ path: "/live/a", operation: "set", expected: { exists: true, value: "original" }, value: "manual" }] });
    expect(await run('const f = await createFeed(config); try { await f.set("stale"); } catch(e) { console.log(JSON.stringify({code:e.code})); }')).toEqual({ code: "data_conflict" });
    expect((await store.read("board"))!.canvas.data.live).toEqual({ a: "manual" });
    const next = await run('const f = await createFeed({...config,restart:true}); console.log(JSON.stringify(await f.set("adopted")));');
    expect(next).toMatchObject({ generation: 2, seq: 1 });
    await expect(store.feed({ boardId: "board", sourceId: "worker", action: "set", generation: 1, seq: 2, value: "late" }, "owner")).rejects.toHaveProperty("code", "generation_conflict");
  });
  it("binds CLI and MCP feed calls to identity and never accepts a forged actor field", async () => {
    await store.addInteraction({ boardId: "board", intentId: "side", kind: "fork", text: "Work" }, "side"); await service.journal.bind("side-token", { agentId: "side", cwd: dir });
    const invoke = (binding: string | undefined, input: object, client = "mcp") => bridge.dispatch(JSON.stringify({ protocol: 1, client, operation: "feed", binding, input }));
    expect(await invoke(undefined, { action: "status", boardId: "board", sourceId: "worker" })).toMatchObject({ ok: false });
    await run('await createFeed(config);');
    expect(await invoke("side-token", { action: "set", boardId: "board", sourceId: "worker", generation: 1, seq: 1, value: "forged", actorAgentId: "owner" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const cli = await exec(runtimePaths(dir).cli, ["feed", "--json", JSON.stringify({ action: "set", boardId: "board", sourceId: "worker", generation: 1, seq: 1, value: "actual" })], { env: { ...process.env, PASEO_BOARD_BINDING: "own-token" }, timeout: 5000 });
    expect(JSON.parse(cli.stdout).ack.seq).toBe(1);
    expect(await invoke("own-token", { action: "set", boardId: "board", sourceId: "worker", generation: 1, seq: 2, value: "mcp" })).toMatchObject({ ok: true, result: { ack: { seq: 2 } } });
    expect(await invoke("revoked-token", { action: "set", boardId: "board", sourceId: "worker", generation: 1, seq: 3, value: "wrong" }, "cli")).toMatchObject({ ok: false });
  });
  it("rejects concurrent local writes and keeps an identical retry after the queue is released", async () => {
    const result = await run('const f = await createFeed(config); const first=f.set(1); let blocked; try { await f.set(2); } catch(e) { blocked=e.code; } const ack=await first; console.log(JSON.stringify({blocked,seq:ack.seq}));');
    expect(result).toEqual({ blocked: "producer_busy", seq: 1 });
  });
  it("recovers a dead producer lock and refuses changing the source without resolving an unknown write", async () => {
    await run('const f = await createFeed(config); await f.set(1);');
    const exited = await exec(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    const lockPath = join(dir, "producer.json.lock"); await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: Number(exited.stdout), nonce: "dead-fixture" }));
    expect(await run('const f = await createFeed(config); console.log(JSON.stringify(await f.set(2)));')).toMatchObject({ generation: 1, seq: 2 });
    const dispatch = bridge.dispatch.bind(bridge);
    bridge.dispatch = async line => { const result = await dispatch(line); return JSON.parse(line).input.action === "set" ? undefined : result; };
    const denied = await run('const f = await createFeed(config); try { await f.set(3); } catch {} try { await f.reopen({discardRejected:true}); } catch(e) { console.log(JSON.stringify({code:e.code})); }');
    expect(denied.code).toBe("pending_write");
    bridge.dispatch = dispatch;
    expect(await run('const f = await createFeed(config); console.log(JSON.stringify(await f.retry()));')).toMatchObject({ generation: 1, seq: 3 });
  });

  it("pins each live SDK instance to its own generation, even when another handle rewrites the journal", async () => {
    const result = await run(`const f1=await createFeed(config); await f1.set("generation-1");
      const f2=await createFeed({...config,restart:true}); await f2.set("generation-2");
      const blocked=[]; for(const op of [()=>f1.set("old"),()=>f1.retry(),()=>f1.close()]) {try{await op();blocked.push("WRONG");}catch(e){blocked.push(e.code);}}
      const continued=await f2.set("generation-2-continued");
      await f1.reopen(); const explicit=await f1.set("generation-3"); let oldF2; try{await f2.set("old-generation-2");}catch(e){oldF2=e.code;}
      console.log(JSON.stringify({blocked,continued,explicit,oldF2}));`);
    expect(result.blocked).toEqual(["generation_conflict", "generation_conflict", "generation_conflict"]);
    expect(result.continued).toMatchObject({ generation: 2, seq: 2 });
    expect(result.explicit).toMatchObject({ generation: 3, seq: 1 }); expect(result.oldF2).toBe("generation_conflict");
    expect((await store.read("board"))!.canvas.data.live).toEqual({ a: "generation-3" });
  });

  it("keeps an ambiguous post-rename fsync failure unknown and replays its committed ACK", async () => {
    await run('await createFeed(config);');
    syncFault.directory = join(dir, "data/boards"); syncFault.remaining = 1;
    const dispatch = bridge.dispatch.bind(bridge); let writes = 0; let firstResponse: unknown;
    bridge.dispatch = async line => {
      if (JSON.parse(line).input.action !== "set") return dispatch(line);
      writes++;
      if (writes === 1) { firstResponse = await dispatch(line); return firstResponse; }
      return { ok: false, error: { code: "EIO", message: "Continuing storage response uncertainty" } };
    };
    const result = await run(`const f=await createFeed(config); let unknown,reopen,restart;
      try{await f.set({durable:"once"});}catch(e){unknown=e.code;}
      try{await f.reopen({discardRejected:true});}catch(e){reopen=e.code;}
      try{await createFeed({...config,restart:true});}catch(e){restart=e.code;}
      console.log(JSON.stringify({unknown,reopen,restart}));`);
    expect(firstResponse).toMatchObject({ ok: false, error: { code: "EIO" } }); expect(syncFault.remaining).toBe(0);
    expect(result).toEqual({ unknown: "outcome_unknown", reopen: "pending_write", restart: "pending_write" });
    expect(writes).toBe(3);
    const journal = JSON.parse(await readFile(join(dir, "producer.json"), "utf8"));
    expect(journal).toMatchObject({ seq: 0, pending: { generation: 1, seq: 1, value: { durable: "once" } }, lastError: { code: "outcome_unknown", confirmed: false } });
    const committed = (await store.read("board"))!; const ack = committed.feeds![0].lastAck;
    expect(committed.canvas.data.live).toEqual({ a: { durable: "once" } });
    bridge.dispatch = dispatch;
    expect(await run('const f=await createFeed(config); console.log(JSON.stringify(await f.retry()));')).toEqual(ack);
    expect((await store.read("board"))!.revision).toBe(committed.revision);
  });

});
