import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LATEST_PRODUCER_SOURCE } from "./producer-latest-source";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { ServiceJournal } from "./journal";
import { BoardBridge } from "./bridge";
import { runtimePaths, writeRuntime } from "./runtime";

type Result = { status: string; ack?: unknown; result?: unknown; pending?: boolean; error?: unknown };
type Feed = { mode?: string; set: (value: unknown, policy?: unknown) => Promise<unknown>; retry: (expected?: unknown) => Promise<unknown>; close: () => Promise<unknown>; status: () => Promise<unknown>; append?: () => Promise<unknown> };
type Writer = {
  offer: (value: unknown, policy?: unknown) => Promise<Result>;
  flush: () => Promise<unknown>; drain: () => Promise<unknown>; retry: () => Promise<Result>;
  close: () => Promise<Result>; dispose: () => Promise<Result>;
  status: () => { state: string; active: boolean; staged: boolean; volatile: boolean; pending?: { action: string; value?: unknown; policy?: unknown }; error?: unknown };
};
const createLatestWriter = new Function(LATEST_PRODUCER_SOURCE.replace("export function createLatestWriter", "function createLatestWriter") + "\nreturn createLatestWriter;")() as (feed: Feed, options?: unknown) => Writer;
function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const requests: Array<{ value: unknown; policy: unknown } & ReturnType<typeof deferred>> = [];
  const feed = {
    mode: "latest", set: vi.fn((value: unknown, policy?: unknown) => {
      const request = { value, policy, ...deferred() }; requests.push(request); return request.promise;
    }), retry: vi.fn<(expected?: unknown) => Promise<unknown>>(), close: vi.fn(async () => ({ closed: true })),
    status: vi.fn(async (): Promise<unknown> => ({ local: { pending: feed.close.mock.calls.length ? { action: "close", generation: 1 } : requests.length ? { action: "set", generation: 1, seq: requests.length, value: requests.at(-1)!.value, ...requests.at(-1)!.policy as object } : undefined } })),
  };
  return { feed, requests, writer: createLatestWriter(feed) };
}
const turn = () => vi.advanceTimersByTimeAsync(0);

describe("optional latest-state writer (evaluated installed source)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst with explicit superseded dispositions and the original final ACK", async () => {
    const { writer, requests, feed } = fixture();
    const first = writer.offer({ progress: 0 });
    for (let progress = 1; progress < 1000; progress++) writer.offer({ progress });
    const final = writer.offer({ progress: 1000 });
    expect(writer.status()).toMatchObject({ state: "scheduled", staged: true, volatile: true });
    expect(await first).toEqual({ status: "superseded" });
    expect(feed.set).not.toHaveBeenCalled();
    const flushed = writer.flush(); await turn();
    expect(requests.map(x => x.value)).toEqual([{ progress: 1000 }]);
    const ack = { generation: 1, seq: 1, revision: 12 }; requests[0].resolve(ack);
    expect((await final).ack).toBe(ack); expect(await flushed).toBe(ack);
    expect(writer.status()).toEqual({ state: "idle", active: false, staged: false, volatile: false });
  });

  it("keeps one immutable request in flight and only the latest staged value, then permits raw feed use while idle", async () => {
    const { writer, requests, feed } = fixture();
    const first = writer.offer(1); const drain = writer.drain(); await turn();
    const second = writer.offer(2), third = writer.offer(3);
    expect(await second).toEqual({ status: "superseded" });
    expect(requests.map(x => x.value)).toEqual([1]);
    expect(writer.flush()).toBe(drain);
    requests[0].resolve({ seq: 1 }); await turn();
    expect(await first).toEqual({ status: "committed", ack: { seq: 1 } });
    expect(requests.map(x => x.value)).toEqual([1, 3]);
    requests[1].resolve({ seq: 2 }); await drain;
    expect(await third).toEqual({ status: "committed", ack: { seq: 2 } });
    const raw = feed.set(4, { attention: "milestone" }); requests[2].resolve({ seq: 3 });
    expect(await raw).toEqual({ seq: 3 });
  });

  it("copies and freezes both values and policy before a caller can mutate them", async () => {
    const { writer, requests } = fixture();
    const value = { nested: [1, { label: "original" }] }, policy = { focusSelectors: ["#original"] };
    const offered = writer.offer(value, policy);
    value.nested[1] = { label: "changed" }; policy.focusSelectors[0] = "#changed";
    await turn();
    expect(requests[0].value).toEqual({ nested: [1, { label: "original" }] });
    expect(requests[0].policy).toEqual({ attention: "quiet", focusSelectors: ["#original"] });
    expect(Object.isFrozen(requests[0].value)).toBe(true);
    expect(Object.isFrozen((requests[0].value as typeof value).nested[1])).toBe(true);
    expect(Object.isFrozen((requests[0].policy as typeof policy).focusSelectors)).toBe(true);
    requests[0].resolve({ seq: 1 }); await offered;
  });

  it("bounds delay and finite JSON, rejects accessors without evaluating them, and leaves existing staged work intact", async () => {
    const { writer, feed, requests } = fixture();
    for (const delayMs of [NaN, Infinity, -1, 60001, "1"]) expect(() => createLatestWriter(feed, { delayMs })).toThrow(/delayMs/);
    expect(() => createLatestWriter(feed, { queue: true })).toThrow(/Only delayMs/);
    const valid = writer.offer({ arbitrary: { records: [1, 2], task: false } });
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const getter = vi.fn(() => "never"); const accessor = Object.defineProperty({}, "value", { get: getter, enumerable: true });
    for (const value of [undefined, NaN, Infinity, 1n, new Date(), () => 1, Symbol(), cyclic, accessor, new Array(2), new Array(1_000_000_000), "x".repeat(256001)]) expect(() => writer.offer(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const exact = "x".repeat(255998); const boundary = writer.offer(exact);
    expect(await valid).toEqual({ status: "superseded" });
    expect(() => writer.offer(exact + "x")).toThrow(/256000/);
    const flush = writer.flush(); await turn(); requests[0].resolve({ seq: 1 }); await flush;
    expect((await boundary).status).toBe("committed");
  });

  it("rejects record feeds and milestone policies without excluding arbitrary JSON or the raw append method", async () => {
    const { feed } = fixture();
    expect(() => createLatestWriter({ ...feed, mode: "records" })).toThrow(/record feeds/);
    const writer = createLatestWriter({ ...feed, append: async () => undefined });
    for (const policy of [{ attention: "milestone" }, { attention: "record" }, { records: [] }, { action: "append" }, { focusSelectors: [""] }, { focusSelectors: ["x".repeat(1001)] }, { focusSelectors: Array(13).fill("#x") }]) expect(() => writer.offer(1, policy)).toThrow();
    expect(feed.set).not.toHaveBeenCalled();
    const value = writer.offer({ action: "append", records: [1] });
    await writer.dispose(); expect(await value).toEqual({ status: "cancelled" });
  });

  it("preserves unknown failures and blocks overtaking until exact retry succeeds", async () => {
    const { writer, feed, requests } = fixture();
    const unknown = Object.assign(new Error("receipt lost"), { code: "outcome_unknown", confirmed: false });
    const first = writer.offer({ progress: 1 }); const flush = writer.flush(); await turn();
    const stale = writer.offer({ progress: 2 }); requests[0].reject(unknown);
    await expect(first).rejects.toBe(unknown); await expect(flush).rejects.toBe(unknown);
    const latest = writer.offer({ progress: 3 }); expect(await stale).toEqual({ status: "superseded" });
    expect(writer.status()).toMatchObject({ state: "blocked", staged: true, volatile: true, pending: { action: "set", value: { progress: 1 } }, error: unknown });
    await expect(writer.flush()).rejects.toBe(unknown); await turn(); expect(feed.set).toHaveBeenCalledTimes(1);
    const retry = deferred(); feed.retry.mockReturnValueOnce(retry.promise);
    const retrying = writer.retry(); expect(writer.retry()).toBe(retrying); await turn();
    expect(feed.retry).toHaveBeenCalledTimes(1); expect(feed.set).toHaveBeenCalledTimes(1);
    expect(feed.retry).toHaveBeenLastCalledWith({ action: "set", generation: 1, seq: 1, value: { progress: 1 }, attention: "quiet" });
    expect(Object.isFrozen(feed.retry.mock.calls[0][0])).toBe(true);
    retry.reject(unknown); await expect(retrying).rejects.toBe(unknown);
    const originalAck = { seq: 1, revision: 42 }; feed.retry.mockResolvedValueOnce(originalAck);
    expect(await writer.retry()).toEqual({ status: "committed", ack: originalAck });
    const drained = writer.flush(); await turn();
    expect(requests.map(x => x.value)).toEqual([{ progress: 1 }, { progress: 3 }]);
    requests[1].resolve({ seq: 2 }); await drained; expect((await latest).status).toBe("committed");
  });

  it("never substitutes an older ACK or a different pending operation for a pre-journal failure", async () => {
    for (const pending of [undefined, { action: "set", value: "another value", generation: 1, seq: 7 }, { action: "close", generation: 1 }]) {
      const { writer, feed, requests } = fixture();
      const failure = Object.assign(new Error("local write never journalled"), { code: "EACCES" });
      const first = writer.offer("expected"); const flush = writer.flush(); await turn(); requests[0].reject(failure);
      await expect(flush).rejects.toBe(failure); await expect(first).rejects.toBe(failure);
      const staged = writer.offer("later");
      feed.status.mockResolvedValueOnce({ local: { pending, lastAck: { seq: 6 } } }); feed.retry.mockResolvedValue({ seq: 6 });
      await expect(writer.retry()).rejects.toHaveProperty("code", "retry_mismatch");
      expect(feed.retry).not.toHaveBeenCalled(); expect(feed.set).toHaveBeenCalledTimes(1);
      expect(writer.status()).toMatchObject({ state: "blocked", pending: { value: "expected" }, staged: true });
      await writer.dispose(); expect(await staged).toEqual({ status: "cancelled" });
    }
  });

  it("keeps later work blocked when the guarded retry detects a request change after status", async () => {
    const { writer, feed, requests } = fixture(); writer.offer("original");
    const flush = writer.flush(); await turn(); requests[0].reject(new Error("unknown")); await expect(flush).rejects.toThrow("unknown");
    const later = writer.offer("later"), mismatch = Object.assign(new Error("Pending request changed"), { code: "retry_mismatch" });
    feed.retry.mockImplementationOnce(async expected => { expect(expected).toMatchObject({ value: "original", seq: 1 }); throw mismatch; });
    await expect(writer.retry()).rejects.toBe(mismatch); await expect(writer.flush()).rejects.toBe(mismatch);
    expect(feed.set).toHaveBeenCalledTimes(1); await writer.dispose(); expect(await later).toEqual({ status: "cancelled" });
  });

  it("can guard a retry at the maximum value byte and depth limits", async () => {
    let nested: unknown = 1; for (let i = 0; i < 64; i++) nested = [nested];
    for (const value of ["x".repeat(255998), nested]) {
      const { writer, feed, requests } = fixture(); writer.offer(value);
      const flush = writer.flush(); await turn(); requests[0].reject(new Error("unknown")); await expect(flush).rejects.toThrow("unknown");
      feed.retry.mockResolvedValueOnce({ seq: 1 });
      expect(await writer.retry()).toEqual({ status: "committed", ack: { seq: 1 } });
      expect(feed.retry.mock.calls[0][0]).toMatchObject({ value });
    }
  });

  it("exposes detached errors through status and flush without unhandled promise rejections", async () => {
    vi.useRealTimers();
    const failure = Object.assign(new Error("manual edit"), { code: "data_conflict", confirmed: true });
    const unhandled = vi.fn(); process.on("unhandledRejection", unhandled);
    try {
      const feed = { set: vi.fn(async () => { throw failure; }), retry: vi.fn(), close: vi.fn(), status: vi.fn() };
      const writer = createLatestWriter(feed); writer.offer("progress"); writer.flush();
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled(); expect(writer.status()).toMatchObject({ state: "blocked", error: failure, pending: { value: "progress" } });
      await expect(writer.flush()).rejects.toBe(failure);
      const staged = writer.offer("later"); const result = await writer.dispose();
      expect(result).toEqual({ status: "disposed", pending: true, error: failure });
      expect(await staged).toEqual({ status: "cancelled" });
      expect(feed.retry).not.toHaveBeenCalled(); expect(feed.close).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it("honors delay and lets flush bypass it without duplicating submissions", async () => {
    const { feed, requests } = fixture(); const writer = createLatestWriter(feed, { delayMs: 60000 });
    const offer = writer.offer(1); await vi.advanceTimersByTimeAsync(59999); expect(feed.set).not.toHaveBeenCalled();
    const flush = writer.flush(); await turn(); expect(feed.set).toHaveBeenCalledTimes(1);
    requests[0].resolve({ seq: 1 }); await flush; await offer;
    await vi.advanceTimersByTimeAsync(60000); expect(feed.set).toHaveBeenCalledTimes(1);
  });

  it("disposes staged work immediately but waits for the actual in-flight result before raw recovery is safe", async () => {
    const { writer, requests, feed } = fixture(); const first = writer.offer(1);
    const flush = writer.flush(); await turn(); const staged = writer.offer(2);
    const disposed = writer.dispose(); expect(writer.dispose()).toBe(disposed);
    expect(await staged).toEqual({ status: "cancelled" }); await expect(flush).rejects.toHaveProperty("code", "writer_disposed");
    let finished = false; void disposed.then(() => { finished = true; }); await turn(); expect(finished).toBe(false);
    expect(writer.status()).toMatchObject({ state: "disposed", active: true, pending: { value: 1 } });
    requests[0].resolve({ seq: 1 }); expect(await first).toEqual({ status: "committed", ack: { seq: 1 } });
    expect(await disposed).toEqual({ status: "disposed", pending: false });
    expect(feed.close).not.toHaveBeenCalled(); expect(feed.retry).not.toHaveBeenCalled(); expect(feed.set).toHaveBeenCalledTimes(1);
    expect(() => writer.offer(3)).toThrow(); await expect(writer.retry()).rejects.toHaveProperty("code", "writer_disposed");
  });

  it("drains before closing, shares close calls, and preserves exact unknown close recovery", async () => {
    const { writer, feed, requests } = fixture();
    const unknown = new Error("unknown close"); feed.close.mockRejectedValueOnce(unknown);
    const offer = writer.offer(1); const close = writer.close(); expect(writer.close()).toBe(close);
    expect(() => writer.offer(2)).toThrow(/no longer accepts/); await turn(); expect(feed.close).not.toHaveBeenCalled();
    requests[0].resolve({ seq: 1 }); await offer;
    await expect(close).rejects.toBe(unknown);
    expect(writer.status()).toMatchObject({ state: "blocked", pending: { action: "close" }, error: unknown });
    feed.retry.mockResolvedValueOnce({ closed: true });
    expect(await writer.retry()).toEqual({ status: "closed", result: { closed: true } });
    expect(await writer.close()).toEqual({ status: "closed", result: { closed: true } });
    expect(feed.close).toHaveBeenCalledTimes(1); expect(feed.retry).toHaveBeenCalledTimes(1);
  });

  it("allows explicit retry then close after a drain failure, without hiding the rejected close", async () => {
    const { writer, requests, feed } = fixture(); const failure = new Error("uncertain write");
    const offer = writer.offer(1), close = writer.close(); await turn(); requests[0].reject(failure);
    await expect(offer).rejects.toBe(failure); await expect(close).rejects.toBe(failure);
    feed.retry.mockResolvedValueOnce({ seq: 1 }); await writer.retry();
    expect(await writer.close()).toEqual({ status: "closed", result: { closed: true } });
    expect(feed.close).toHaveBeenCalledTimes(1);
  });

  it("never starts close after disposal and waits for an already-started raw close exactly once", async () => {
    const before = fixture(); const cancelledClose = before.writer.close();
    expect(await before.writer.dispose()).toEqual({ status: "disposed", pending: false });
    await expect(cancelledClose).rejects.toHaveProperty("code", "writer_disposed"); expect(before.feed.close).not.toHaveBeenCalled();
    const after = fixture(); const response = deferred<{ closed: boolean }>(); after.feed.close.mockReturnValueOnce(response.promise);
    const close = after.writer.close(); await turn(); const disposed = after.writer.dispose();
    expect(after.feed.close).toHaveBeenCalledTimes(1); expect(after.writer.close()).toBe(close);
    let finished = false; void disposed.then(() => { finished = true; }); await turn(); expect(finished).toBe(false);
    response.resolve({ closed: true }); expect(await close).toEqual({ status: "closed", result: { closed: true } });
    expect(await disposed).toEqual({ status: "disposed", pending: false }); expect(after.feed.close).toHaveBeenCalledTimes(1);
  });
});

const exec = promisify(execFile);
describe("latest writer with the actual generated producer module and Unix transport", () => {
  let dir: string, store: BoardStore, service: BoardService, bridge: BoardBridge;
  beforeEach(async () => {
    dir = await mkdtemp("/tmp/pl-");
    store = new BoardStore(join(dir, "data")); await store.create({ id: "board", title: "Latest fixture", ownerAgentId: "owner" });
    const journal = new ServiceJournal(join(dir, "service.json")); await journal.init(); await journal.bind("fixture-token", { agentId: "owner", cwd: dir });
    service = new BoardService(store, journal, () => undefined); bridge = new BoardBridge(service);
    await writeRuntime(runtimePaths(dir));
    expect(await readFile(runtimePaths(dir).feedSdk, "utf8")).toContain("export function createLatestWriter");
    await bridge.start(runtimePaths(dir).socket);
  });
  afterEach(async () => { await bridge.close(); await service.dispose(); await rm(dir, { recursive: true, force: true }); });
  async function run(body: string) {
    const script = join(dir, "run.mjs");
    await writeFile(script, `import { createFeed, createLatestWriter } from ${JSON.stringify(runtimePaths(dir).feedSdk)};\nimport {readFile} from 'node:fs/promises';\nconst config=${JSON.stringify({ boardId: "board", sourceId: "worker", path: "/live/progress", stateFile: join(dir, "producer.json") })};\n${body}`);
    const result = await exec(process.execPath, [script], { env: { ...process.env, PASEO_BOARD_HOME: dir, PASEO_BOARD_BINDING: "fixture-token" }, timeout: 5000 });
    return JSON.parse(result.stdout);
  }

  it("imports in Node without dependencies, coalesces quiet progress, allows an explicit raw milestone, and closes durably", async () => {
    const result = await run(`const feed=await createFeed(config); const writer=createLatestWriter(feed);
      const first=writer.offer({score:0}); for(let i=1;i<100;i++) writer.offer({score:i});
      const final=writer.offer({score:100}); const ack=await writer.flush();
      let milestone; try{writer.offer({score:101},{attention:'milestone'});}catch(e){milestone=e.code;}
      const raw=await feed.set({score:101},{attention:'milestone'}); const closed=await writer.close();
      console.log(JSON.stringify({first:await first,final:await final,ack,raw,milestone,closed,state:writer.status()}));`);
    expect(result.first).toEqual({ status: "superseded" });
    expect(result.final).toMatchObject({ status: "committed", ack: { generation: 1, seq: 1 } });
    expect(result.ack).toEqual(result.final.ack); expect(result.raw).toMatchObject({ generation: 1, seq: 2 });
    expect(result.milestone).toBe("mode_conflict"); expect(result.closed.status).toBe("closed"); expect(result.state.state).toBe("closed");
    const board = (await store.read("board"))!; expect(board.canvas.data).toEqual({ live: { progress: { score: 101 } } });
    expect(board.updates).toHaveLength(1); expect(board.feeds![0].closed).toBe(true);
    const persisted = JSON.parse(await readFile(join(dir, "producer.json"), "utf8")); expect(persisted.pending).toBeUndefined(); expect(persisted.closed).toBe(true);
  });

  it("does not overtake a committed-but-unacknowledged value and retries the exact durable request", async () => {
    const dispatch = bridge.dispatch.bind(bridge); const requests: Array<{ value: unknown; seq: number }> = [];
    bridge.dispatch = async line => {
      const input = JSON.parse(line).input, result = await dispatch(line);
      if (input.action === "set") { requests.push({ value: input.value, seq: input.seq }); if (requests.length <= 3) return { ok: false, error: { code: "EIO", message: "Receipt unavailable after commit" } }; }
      return result;
    };
    const result = await run(`const feed=await createFeed(config); const writer=createLatestWriter(feed);
      const original={score:1}; const first=writer.offer(original); const flushing=writer.flush(); original.score=99;
      const replaced=writer.offer({score:2}), latest=writer.offer({score:3});
      let failure;try{await flushing;}catch(e){failure=e.code;} const status=writer.status();
      const journal=JSON.parse(await readFile(config.stateFile,'utf8')); const recovered=await writer.retry();
      const final=await writer.flush(); console.log(JSON.stringify({failure,status,journal,recovered,final,replaced:await replaced,latest:await latest}));`);
    expect(result.failure).toBe("outcome_unknown"); expect(result.status).toMatchObject({ state: "blocked", pending: { value: { score: 1 } }, staged: true });
    expect(result.journal).toMatchObject({ seq: 0, pending: { value: { score: 1 }, seq: 1 }, lastError: { confirmed: false } });
    expect(result.recovered).toMatchObject({ status: "committed", ack: { seq: 1 } }); expect(result.final.seq).toBe(2);
    expect(result.replaced).toEqual({ status: "superseded" }); expect(result.latest).toMatchObject({ status: "committed", ack: { seq: 2 } });
    expect(requests).toEqual([{ value: { score: 1 }, seq: 1 }, { value: { score: 1 }, seq: 1 }, { value: { score: 1 }, seq: 1 }, { value: { score: 1 }, seq: 1 }, { value: { score: 3 }, seq: 2 }]);
    expect((await store.read("board"))!.canvas.data).toEqual({ live: { progress: { score: 3 } } });
  });

  it("keeps confirmed conflicts visible until explicit disposal and raw reopening", async () => {
    const dispatch = bridge.dispatch.bind(bridge); const actions: string[] = [];
    bridge.dispatch = async line => {
      const input = JSON.parse(line).input; actions.push(input.action);
      if (input.action === "set" && input.value === "conflict") {
        const board = (await store.read("board"))!;
        await store.publish({ boardId: "board", expectedRevision: board.revision, eventId: "manual", dataPatch: [{ path: "/live/progress", operation: "set", expected: { exists: true, value: "first" }, value: "manual" }] });
      }
      return dispatch(line);
    };
    const result = await run(`const feed=await createFeed(config); await feed.set('first'); const writer=createLatestWriter(feed);
      writer.offer('conflict'); let failure;try{await writer.flush();}catch(e){failure={code:e.code,confirmed:e.confirmed};}
      const later=writer.offer('never-sent'); const disposed=await writer.dispose();
      await feed.reopen({discardRejected:true}); const next=createLatestWriter(feed);next.offer('recovered');
      console.log(JSON.stringify({failure,disposed,later:await later,ack:await next.flush()}));`);
    expect(result.failure).toEqual({ code: "data_conflict", confirmed: true }); expect(result.disposed).toMatchObject({ status: "disposed", pending: true });
    expect(result.later).toEqual({ status: "cancelled" }); expect(result.ack).toMatchObject({ generation: 2, seq: 1 });
    expect(actions).toEqual(["open", "set", "set", "status", "open", "set"]);
    expect((await store.read("board"))!.canvas.data).toEqual({ live: { progress: "recovered" } });
  });
});
