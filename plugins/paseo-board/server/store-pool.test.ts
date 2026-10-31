import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoardStorePool, type StorePoolOptions } from "./store-pool";
import { boardPartition } from "./store-worker-protocol";
import workerSource from "./assets/store-worker.txt";
import type { BoardChange } from "../shared/contracts";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { DOMParser } from "linkedom";
import { componentIdentityFor } from "../shared/component-identity";
import { describeAuthoring } from "./authored-source";

describe("bounded Board worker processes", () => {
  let directory: string;
  let pools: BoardStorePool[];
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "board-pool-")); pools = []; });
  afterEach(async () => { await Promise.all(pools.map(pool => pool.close())); await rm(directory, { recursive: true, force: true }); });
  function pool(options: StorePoolOptions = {}) { const result = new BoardStorePool(directory, options); pools.push(result); return result; }
  const create = (store: BoardStorePool, id: string) => store.create({ id, title: id, ownerAgentId: "owner", html: "<main>Original canvas</main>" });
  function nextChange(store: BoardStorePool, match: (event: BoardChange) => boolean) {
    return new Promise<BoardChange>((resolve, reject) => {
      const timeout = setTimeout(() => { remove(); reject(new Error("No expected worker event")); }, 5000);
      const remove = store.subscribe(event => { if (match(event)) { clearTimeout(timeout); remove(); resolve(event); } });
    });
  }
  function interceptCalls(body: string) {
    return `const register = process.on.bind(process); process.on = function(name, handler) { return register(name, name === 'message' ? function(message) { ${body}; return handler(message); } : handler); };\n` + workerSource;
  }

  it("uses fixed independent processes and commits one Board in FIFO order", async () => {
    const store = pool({ workers: 2 });
    await create(store, "one"); await create(store, "two");
    const pids = store.diagnostics().map(slot => slot.pid);
    expect(new Set(pids).size).toBe(2); expect(pids).not.toContain(process.pid);
    const changes: BoardChange[] = []; const remove = store.subscribe(event => changes.push(event));
    const results = await Promise.all([
      store.rename({ boardId: "one", expectedTitle: "one", title: "second", eventId: "a" }),
      store.rename({ boardId: "one", expectedTitle: "second", title: "third", eventId: "b" }),
    ]);
    expect(results.map(board => board.title)).toEqual(["second", "third"]);
    expect(changes.map(event => event.summary.title)).toEqual(["second", "third"]);
    expect((await store.summarySnapshot()).boards.find(board => board.id === "one")?.title).toBe("third");
    expect(store.diagnostics().map(slot => slot.pid)).toEqual(pids);
    remove();
  });

  it("dispatches component edits through real workers with durable exact retries and fresh source replay", async () => {
    // Build only in memory: package verification separately proves the committed asset.
    // This exercises the source protocol even while a concurrent integration build is pending.
    const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
    const compiled = await build({ absWorkingDir: pluginRoot, preserveSymlinks: true, entryPoints: [join(pluginRoot, "server/store-worker.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", write: false, logLevel: "silent" });
    const store = pool({ workers: 2, workerSource: compiled.outputFiles[0].text });
    const created = await store.create({ id: "edited", title: "Edited", html: '<main><section id="left"><p id="text">Old</p></section><section id="right"></section></main>' });
    const document = new DOMParser().parseFromString(created.canvas.html, "text/html");
    const text = { boardId: created.id, canvasBase: { revision: 1, documentVersion: 1 }, eventId: "text", patch: { id: "text", operation: "text" as const, selector: "#text", sourceIdentity: componentIdentityFor(document.querySelector("#text")!), expectedText: "Old", text: "Written in worker" } };
    const edited = await store.edit(text);
    const moved = await store.edit({ boardId: created.id, canvasBase: { revision: edited.canvas.revision, documentVersion: 1 }, eventId: "move", patch: { id: "move", operation: "move", selector: "#text", sourceIdentity: text.patch.sourceIdentity, destination: "#right", destinationIdentity: componentIdentityFor(document.querySelector("#right")!), position: "append" } });
    const pids = store.diagnostics().map(slot => slot.pid);
    expect(new Set(pids).size).toBe(2); expect(pids).not.toContain(process.pid);
    expect(await store.edit(text)).toEqual(moved);
    await expect(store.edit({ ...text, patch: { ...text.patch, text: "Different retry" } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(store.edit({ ...text, eventId: "stale", patch: { ...text.patch, id: "stale" } })).rejects.toMatchObject({ code: "revision_conflict" });
    const read = (await store.read(created.id))!;
    const source = describeAuthoring(read.canvas);
    expect(source.replay.complete).toBe(true);
    expect(source.materializedAuthoredHtml).toContain('<section id="right"><p id="text">Written in worker</p></section>');
    expect(read.canvas.patches).toHaveLength(2);
    expect(store.diagnostics().map(slot => slot.pid)).toEqual(pids);
  });

  it("enforces queue and byte budgets before startup and snapshots caller-owned input", async () => {
    const store = pool({ workers: 1, maxPendingPerWorker: 2, maxPendingPerBoard: 1, maxBytesPerWorker: 1000 });
    const input = { id: "one", title: "original", data: { note: "original" } };
    const first = store.create(input); input.title = "mutated"; input.data.note = "mutated";
    await expect(store.read("one")).rejects.toMatchObject({ code: "backpressure" });
    await expect(store.create({ id: "huge", title: "large", html: "x".repeat(2000) })).rejects.toMatchObject({ code: "backpressure" });
    expect(await first).toMatchObject({ title: "original", canvas: { data: { note: "original" } } });
    expect(store.diagnostics()[0]).toMatchObject({ pending: 0, bytes: 0 });
    expect(await store.read("one")).toMatchObject({ title: "original" });
  });

  it("keeps authorization and durable identical feed retries inside the worker", async () => {
    const store = pool({ workers: 1 }); await create(store, "one");
    await expect(store.feed({ boardId: "one", sourceId: "source", action: "open", path: "/records", mode: "records", expectedGeneration: 0, requestId: "open" }, "intruder")).rejects.toMatchObject({ code: "forbidden" });
    await store.feed({ boardId: "one", sourceId: "source", action: "open", path: "/records", mode: "records", expectedGeneration: 0, requestId: "open" }, "owner");
    const append = { boardId: "one", sourceId: "source", action: "append" as const, generation: 1, seq: 1, records: [{ point: 1 }], attention: "quiet" as const };
    const ack = await store.feed(append, "owner");
    const oldPid = store.diagnostics()[0].pid!;
    const recovered = nextChange(store, event => event.summary.id === "one" && event.reason === "content");
    process.kill(oldPid, "SIGKILL");
    await recovered;
    expect(store.diagnostics()[0].pid).not.toBe(oldPid);
    expect(await store.feed(append, "owner")).toEqual(ack);
    expect((await store.read("one"))?.canvas.data).toEqual({ records: [{ point: 1 }] });
  });

  it("recovers a committed write whose event and result were lost without replaying it", async () => {
    const source = `const originalSend = process.send.bind(process); process.send = function(message, ...rest) { if (message.type === 'commit' && message.notice.summary.title === 'Committed before crash') process.exit(27); return originalSend(message, ...rest); };\n` + workerSource;
    const store = pool({ workers: 1, workerSource: source }); await create(store, "one");
    const recovered = nextChange(store, event => event.summary.title === "Committed before crash");
    const request = { boardId: "one", expectedTitle: "one", title: "Committed before crash", eventId: "rename" };
    await expect(store.rename(request)).rejects.toMatchObject({ code: "outcome_unknown" });
    const event = await recovered;
    expect(event).toMatchObject({ summary: { revision: 2 }, canvasRevision: 1 });
    expect(await store.rename(request)).toMatchObject({ revision: 2, title: "Committed before crash" });
    const envelope = JSON.parse(await readFile(join(directory, "boards", "one.json"), "utf8"));
    expect(envelope.history.filter((entry: any) => entry.operation === "rename")).toHaveLength(1);
  });

  it("marks unsent queued writes as not executed and keeps another partition available", async () => {
    const store = pool({ workers: 2, timeoutMs: 700, workerSource: interceptCalls("if (message.type === 'call' && message.method === 'read' && message.args[0] === 'blocked') return") });
    const other = ["a", "b", "c"].find(id => boardPartition(id, 2) !== boardPartition("blocked", 2))!;
    await create(store, "blocked"); await create(store, other);
    const blocked = store.read("blocked").catch(error => error);
    const queued = store.rename({ boardId: "blocked", expectedTitle: "blocked", title: "Not executed", eventId: "queued" }).catch(error => error);
    expect(await store.read(other)).toMatchObject({ id: other });
    expect((await blocked).code).toBe("worker_unavailable");
    expect((await queued).code).toBe("worker_unavailable");
    expect(JSON.parse(await readFile(join(directory, "boards", "blocked.json"), "utf8")).board.title).toBe("blocked");
  });

  it("isolates CPU-heavy Board work from the coordinator event loop", async () => {
    const store = pool({ workers: 1, workerSource: interceptCalls("if (message.type === 'call' && message.method === 'read') { const end = Date.now() + 300; while (Date.now() < end) {} }") });
    await create(store, "one");
    let finished = false;
    const reading = store.read("one").then(board => { finished = true; return board; });
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    expect(finished).toBe(false);
    expect(await reading).toMatchObject({ id: "one" });
  });

  it("refuses competing coordinators, malformed leases and live orphan ownership", async () => {
    const first = pool({ workers: 1 }); await first.init();
    await expect(pool({ workers: 1 }).init()).rejects.toMatchObject({ code: "worker_busy" });
    await first.close();
    await writeFile(join(directory, ".store-pool-owner.json"), JSON.stringify({ pid: 99999999 }));
    await expect(pool().init()).rejects.toMatchObject({ code: "worker_busy" });
    await writeFile(join(directory, ".store-pool-owner.json"), JSON.stringify({ pid: 99999999, children: [process.pid] }));
    await expect(pool().init()).rejects.toMatchObject({ code: "worker_busy" });
    await writeFile(join(directory, ".store-pool-owner.json"), JSON.stringify({ pid: 99999999, children: [] }));
    const replacement = pool({ workers: 1 }); await replacement.init();
    expect(replacement.diagnostics()[0].ready).toBe(true);
  });

  it("closes even during initialization and leaves no worker or ownership file", async () => {
    const store = pool({ workers: 2 });
    const started = store.init().catch(error => error);
    await store.close(); await started;
    expect(store.diagnostics().every(slot => !slot.pid)).toBe(true);
    await expect(readFile(join(directory, ".store-pool-owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.read("one")).rejects.toMatchObject({ code: "worker_unavailable" });
  });

  it("lets only one simultaneous starter replace a stale lease", async () => {
    await writeFile(join(directory, ".store-pool-owner.json"), JSON.stringify({ pid: 99999999, children: [] }));
    const contenders = [pool({ workers: 1 }), pool({ workers: 1 })];
    const starts = await Promise.allSettled(contenders.map(store => store.init()));
    expect(starts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failure = starts.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason.code).toBe("worker_busy");
    const winner = contenders[starts.findIndex(result => result.status === "fulfilled")];
    const lease = JSON.parse(await readFile(join(directory, ".store-pool-owner.json"), "utf8"));
    expect(lease.children).toEqual([winner.diagnostics()[0].pid]);
    expect(await create(winner, "one")).toMatchObject({ revision: 1 });
  });

  it("keeps explicit reads and index requests behind the same worker crash circuit", async () => {
    const store = pool({ workers: 1, workerSource: interceptCalls("if (message.type === 'call' && message.method === 'read') process.exit(29)") });
    await create(store, "one");
    const seenPids = new Set([store.diagnostics()[0].pid]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const recovered = nextChange(store, event => event.summary.id === "one");
      await expect(store.read("one")).rejects.toMatchObject({ code: "worker_unavailable" });
      await recovered; seenPids.add(store.diagnostics()[0].pid);
    }
    await expect(store.read("one")).rejects.toMatchObject({ code: "worker_unavailable" });
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(store.read("one")).rejects.toMatchObject({ code: "worker_unavailable" });
      await expect(store.list()).rejects.toMatchObject({ code: "worker_unavailable" });
    }
    expect(seenPids.size).toBe(4);
    expect(store.diagnostics()[0].pid).toBeUndefined();
  });
});
