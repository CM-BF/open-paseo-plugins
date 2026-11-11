import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
// @ts-expect-error standalone runtime
import { initializeApp } from "../backend/scaffold.mjs";
// @ts-expect-error standalone runtime
import { loadApp } from "../backend/files.mjs";
// @ts-expect-error standalone runtime
import { startApp } from "../backend/server.mjs";
import type { BoardChange } from "../shared/contracts";
import { LiveGetOutputSchema, LiveSetInputSchema, type LiveMark } from "../shared/live-data";
import { createReleaseRpc, LiveDriftSchema, LiveReleaseSchema, ReleaseCreateSchema, ReleaseManifestSchema, ReleaseMetaSchema, ReleaseSettingsSchema, ShareUpdateResultSchema, ShareUpdateSchema, shareStatusRpc } from "../shared/release-contracts";
import { BoardBridge } from "./bridge";
import { liveConsentDigest, LiveDataPublisher, type LiveClock, type LiveStore } from "./live-data";
import { projectLive } from "./live-projection";
import { ServiceJournal } from "./journal";
import { toolDefinitions } from "./runtime";
import { BoardService } from "./service";
import { BoardStore } from "./store";
import { BoardStorePool } from "./store-pool";

const secret = "live-write-token-0123456789abcdef0123456789";
const origin = "https://api.example.test", deploymentId = "deployment-1", boardId = "board", createdAt = "2026-11-10T00:00:00.000Z";
const baseMarks: LiveMark[] = [{ path: "/live/value", subtree: false }];

class ManualClock implements LiveClock {
  time = 1_800_000_000_000;
  private next = 0;
  private timers = new Map<number, { at: number; run: () => void }>();
  now = () => this.time;
  setTimer = (run: () => void, delayMs: number) => { this.timers.set(++this.next, { at: this.time + delayMs, run }); return this.next; };
  clearTimer = (timer: unknown) => { this.timers.delete(timer as number); };
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]); this.time = Math.max(this.time, due[1].at); due[1].run();
    }
    this.time = end;
  }
}

interface Sent { url: string; method: string; body: any; authorization?: string; redirect?: string; }
type Reply = Response | Promise<Response>;

function harness(root: string) {
  const clock = new ManualClock();
  const requests: Sent[] = [];
  const state = { data: { live: { value: 1 }, PRIVATE_DATA: "PRIVATE_DATA" } as Record<string, any>, canvasRevision: 1, createdAt, failProjection: false };
  const listeners = new Set<(change: BoardChange) => void>();
  let respond: (request: Sent, signal: AbortSignal | null | undefined) => Reply = () => new Response(JSON.stringify({ deploymentId, version: "x" }), { status: 200 });
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const request: Sent = { url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, authorization: (init?.headers as Record<string, string>)?.Authorization, redirect: init?.redirect };
    requests.push(request);
    return respond(request, init?.signal as AbortSignal | undefined);
  }) as unknown as typeof fetch;
  const store: LiveStore = {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    projectPublic: async (_id, expected, marks) => {
      if (state.failProjection) throw Object.assign(new Error("worker gone"), { code: "worker_unavailable" });
      return { createdAt: state.createdAt, canvasRevision: state.canvasRevision, ...(state.createdAt === expected ? projectLive(state.data, marks) : { bytes: 0, overLimit: false, withheld: [], pathBytes: {} }) };
    },
  };
  const emit = (canvasRevision = state.canvasRevision) => { for (const listener of listeners) listener({ cursor: { epoch: "e", sequence: 1 }, summary: { id: boardId, createdAt: state.createdAt } as BoardChange["summary"], canvasRevision, reason: "content" }); };
  const logs: string[] = [];
  const build = () => new LiveDataPublisher(root, store, { fetcher, clock, random: () => 0, log: message => logs.push(message) });
  const context = { clock, requests, state, emit, fetcher, logs, build, publisher: build(), setRespond: (next: typeof respond) => { respond = next; } };
  return context;
}
type Harness = ReturnType<typeof harness>;

const hang = (_request: Sent, signal: AbortSignal | null | undefined) => new Promise<Response>((_, reject) => { signal!.addEventListener("abort", () => reject(new Error("aborted"))); });
const ok = (body: unknown = { deploymentId, version: "x" }) => new Response(JSON.stringify(body), { status: 200 });
const failure = (status: number, body: unknown = { error: "x" }, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const scope = { boardId, expectedCreatedAt: createdAt };
const puts = (h: Harness) => h.requests.filter(request => request.method === "PUT");
const pushes = (h: Harness) => puts(h).filter(request => request.body.value !== undefined);
const heartbeats = (h: Harness) => puts(h).filter(request => request.body.value === undefined);

describe("live data publisher", () => {
  let root: string, h: Harness;
  let eventNumber = 0, lastEvent: string | null = null;
  const step = async (ms: number, target = h) => { target.clock.advance(ms); await target.publisher.idle(); };
  const event = () => { const eventId = `event-${++eventNumber}`; const expectedEventId = lastEvent; lastEvent = eventId; return { eventId, expectedEventId }; };
  const upsert = (overrides: Record<string, unknown> = {}, marks: LiveMark[] = baseMarks, target = h) => target.publisher.set({ ...scope, action: "upsert", ...event(), origin, deploymentId, token: secret, marks, consentDigest: liveConsentDigest(origin, deploymentId, marks), acknowledgedPublic: true, ...overrides });
  const act = (action: string, extra: Record<string, unknown> = {}) => h.publisher.set({ ...scope, action, ...event(), ...extra });
  const status = async () => (await h.publisher.get(scope)).status;
  const write = (value: unknown, target = h) => { target.state.data = { ...target.state.data, live: { value } }; target.state.canvasRevision++; target.emit(); };
  const journalPath = async (directory = join(root, "live-data")) => join(directory, (await readdir(directory)).find(name => name.endsWith(".journal.json"))!);
  const channelFile = async (directory = join(root, "live-data")) => join(directory, (await readdir(directory)).find(name => name.endsWith(".json") && !name.endsWith(".journal.json"))!);
  const journal = async () => JSON.parse(await readFile(await journalPath(), "utf8"));

  /** Connects and acknowledges the first push, leaving a ready channel at seq 1. */
  const connect = async (marks: LiveMark[] = baseMarks) => {
    await h.publisher.start(); await upsert({}, marks); await step(0);
    expect((await status()).state).toBe("live");
  };

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "board-live-data-")); h = harness(root); lastEvent = null; eventNumber = 0; });
  afterEach(async () => { await h.publisher.close(); await rm(root, { recursive: true, force: true }); });

  it("mirrors only marked data with the token in the header alone", async () => {
    await h.publisher.start();
    const created = await upsert();
    expect(created.status.state).toBe("pending");
    await step(0);
    expect(h.requests).toHaveLength(1);
    const [request] = h.requests;
    expect(request.url).toMatch(/^https:\/\/api\.example\.test\/_board\/live\/c[a-f0-9]{32}$/);
    expect(request).toMatchObject({ method: "PUT", authorization: `Bearer ${secret}`, redirect: "error", body: { deploymentId, seq: 1, value: { "/live/value": 1 } } });
    expect(request.body.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(request.body)).not.toContain("PRIVATE_DATA"); expect(JSON.stringify(request.body)).not.toContain(secret);
    expect(await status()).toMatchObject({ state: "live", seq: 1, attempts: 0, pushedBytes: 17, pushedCanvasRevision: 1 });
    expect((await h.publisher.get(scope)).channel).toMatchObject({ state: "ready", marks: baseMarks, origin, deploymentId });
  });

  it("debounces writes, coalesces to the latest value and honours max-wait", async () => {
    await connect();
    await step(2000); // clears the push floor from the first push
    const before = pushes(h).length;
    write(2); await step(499); write(3);
    await step(499);
    expect(pushes(h)).toHaveLength(before);
    await step(1);
    expect(pushes(h)).toHaveLength(before + 1); expect(pushes(h).at(-1)!.body.value).toEqual({ "/live/value": 3 });
    await step(3000);
    const held = pushes(h).length;
    for (let index = 0; index < 8; index++) { write(10 + index); await step(300); expect(pushes(h).length).toBeLessThanOrEqual(held + 1); }
    await step(300); write(99); await step(600);
    expect(pushes(h).length).toBeGreaterThan(held);
    expect(pushes(h).at(-1)!.body.value["/live/value"]).toBeGreaterThanOrEqual(10);
  });

  it("ignores unrelated writes, restart notices and data that projects the same", async () => {
    await connect();
    await step(2000);
    const count = h.requests.length, inode = (await stat(await journalPath())).ino;
    h.emit(); // worker restart notice: same canvas revision
    await step(5000);
    h.state.canvasRevision++; h.state.data = { ...h.state.data, PRIVATE_DATA: "changed" }; h.emit();
    await step(5000);
    expect(h.requests).toHaveLength(count);
    // S6: an unrelated write costs no journal rewrite, because withheld did not change.
    expect((await stat(await journalPath())).ino).toBe(inode);
  });

  it("keeps one request in flight per channel, then pushes the latest value", async () => {
    await connect();
    await step(2000);
    let release!: () => void;
    h.setRespond(() => new Promise<Response>(resolve => { release = () => resolve(ok()); }));
    write(2); await h.clock.advance(500);
    await vi.waitFor(() => expect(pushes(h)).toHaveLength(2));
    write(3); h.clock.advance(5000);
    await vi.waitFor(() => expect(h.requests.length).toBe(2));
    h.setRespond(() => ok());
    release();
    await h.publisher.idle();
    await step(2000); await step(2000);
    expect(pushes(h)).toHaveLength(3);
    expect(pushes(h)[2].body).toMatchObject({ seq: 3, value: { "/live/value": 3 } });
    expect(new Set(pushes(h).map(request => request.body.seq)).size).toBe(3);
  });

  it("aborts an in-flight push when the human narrows, and pushes only the narrower set", async () => {
    const wide: LiveMark[] = [{ path: "/live/value", subtree: false }, { path: "/live/other", subtree: false }];
    h.state.data = { live: { value: 1, other: "OLD_WIDE" } };
    await connect(wide);
    await step(2000);
    let aborted = false;
    h.setRespond((_request, signal) => new Promise<Response>((_, reject) => { signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }); }));
    h.state.data = { live: { value: 2, other: "NEW_WIDE" } }; h.state.canvasRevision++; h.emit();
    h.clock.advance(500);
    await vi.waitFor(() => expect(pushes(h)).toHaveLength(2));
    h.setRespond(() => ok());
    await upsert({}, baseMarks);
    expect(aborted).toBe(true);
    await step(0);
    const last = pushes(h).at(-1)!;
    expect(pushes(h)).toHaveLength(3);
    expect(last.body.value).toEqual({ "/live/value": 2 }); expect(JSON.stringify(last.body)).not.toContain("WIDE");
    expect(last.body.seq).toBe(3);
  });

  it("replays the same version after a crash between the write-ahead and the acknowledgement", async () => {
    await connect();
    await step(2000);
    h.setRespond(hang); // the process dies with this request open
    write(2); h.clock.advance(500);
    await vi.waitFor(() => expect(pushes(h)).toHaveLength(2));
    const crashed = pushes(h)[1].body;
    expect((await journal()).sending).toMatchObject({ seq: crashed.seq, digest: crashed.digest });
    await h.publisher.close();
    h.setRespond(() => ok());
    h.publisher = h.build();
    await h.publisher.start();
    await step(0);
    expect(pushes(h)).toHaveLength(3);
    expect(pushes(h)[2].body).toEqual({ ...crashed });
    expect(await journal()).toMatchObject({ seq: crashed.seq, acked: { seq: crashed.seq, digest: crashed.digest } });
    expect((await journal()).sending).toBeUndefined();
  });

  it("issues a new version when the value changed across the crash", async () => {
    await connect();
    await step(2000);
    h.setRespond(hang);
    write(2); h.clock.advance(500);
    await vi.waitFor(() => expect(pushes(h)).toHaveLength(2));
    await h.publisher.close();
    h.setRespond(() => ok());
    write(3);
    h.publisher = h.build();
    await h.publisher.start();
    await step(0);
    expect(pushes(h)[2].body).toMatchObject({ seq: 3, value: { "/live/value": 3 } });
  });

  it("re-issues a value over an unacknowledged newer one: A, B lost ack, back to A", async () => {
    await connect();
    await step(2000);
    const digestA = pushes(h)[0].body.digest;
    h.setRespond(() => Promise.reject(new Error("response lost")));
    write("B"); await step(500);
    expect(pushes(h)[1].body).toMatchObject({ seq: 2 });
    expect(await status()).toMatchObject({ state: "retrying", lastError: { code: "network_error" } });
    h.setRespond(() => ok());
    write(1); // back to the acknowledged value A
    await step(1000);
    expect(pushes(h)).toHaveLength(3);
    expect(pushes(h)[2].body).toMatchObject({ seq: 3, digest: digestA, value: { "/live/value": 1 } });
    expect(await journal()).toMatchObject({ seq: 3, acked: { seq: 3, digest: digestA } });
  });

  it("backs off on failures and honours Retry-After", async () => {
    await connect();
    await step(2000);
    h.setRespond(() => failure(503, { error: "down" }));
    write(2); await step(500);
    expect(await status()).toMatchObject({ state: "retrying", attempts: 1, lastError: { code: "server_error" } });
    const after500 = pushes(h).length;
    await step(999); expect(pushes(h)).toHaveLength(after500);
    await step(1); expect(pushes(h)).toHaveLength(after500 + 1);
    await step(1999); expect(pushes(h)).toHaveLength(after500 + 1);
    await step(1); expect(pushes(h)).toHaveLength(after500 + 2);
    h.setRespond(() => failure(429, { error: "slow" }, { "retry-after": "120" }));
    await step(5000);
    const limited = pushes(h).length;
    expect((await status()).nextAttemptAt).toBe(new Date(h.clock.time + 120_000).toISOString());
    await step(119_999); expect(pushes(h)).toHaveLength(limited);
    h.setRespond(() => ok());
    await step(1);
    expect(pushes(h)).toHaveLength(limited + 1);
    expect(await status()).toMatchObject({ state: "live", attempts: 0 });
    expect((await status())).not.toHaveProperty("lastError");
  });

  it("retries while the worker cannot project, including outcome_unknown after a worker death", async () => {
    await connect();
    await step(2000);
    h.state.failProjection = true;
    write(2); await step(500);
    expect(await journal()).toMatchObject({ attempts: 1, lastError: { code: "board_unavailable" } });
    h.state.failProjection = false;
    await step(1000);
    expect(pushes(h).at(-1)!.body).toMatchObject({ seq: 2, value: { "/live/value": 2 } });
    expect(await status()).toMatchObject({ state: "live", attempts: 0 });
  });

  it.each([
    [401, { error: "x" }, "token_rejected"],
    [404, { error: "x" }, "backend_disabled_or_missing"],
    [409, { error: "deployment_mismatch" }, "deployment_changed"],
    [409, { error: "stale_seq", currentSeq: 50 }, "foreign_writer"],
    [409, { error: "digest_conflict", currentSeq: 2 }, "foreign_writer"],
    [410, { error: "cleared", currentSeq: 9 }, "backend_cleared"],
    [413, { error: "x" }, "document_rejected"],
    [507, { error: "x" }, "backend_channel_limit"],
    [400, { error: "x" }, "backend_rejected"],
  ])("blocks on HTTP %i %j as %s and never overwrites afterwards", async (statusCode, body, code) => {
    await connect();
    await step(2000);
    const before = h.requests.length;
    h.setRespond(() => failure(statusCode, body));
    write(2); await step(500);
    expect(h.requests).toHaveLength(before + 1);
    expect(await status()).toMatchObject({ state: "blocked", lastError: { code } });
    expect((await h.publisher.get(scope)).channel?.state).toBe("blocked");
    write(3); await step(30_000); await step(30_000);
    expect(h.requests).toHaveLength(before + 1);
    expect(h.logs.join("\n")).not.toContain(secret);
  });

  it("stops heartbeats while over the limit and recovers when the document fits", async () => {
    await connect();
    await step(30_000);
    const beats = heartbeats(h).length;
    expect(beats).toBeGreaterThan(0);
    h.state.data = { ...h.state.data, live: { value: "x".repeat(70_000) } }; h.state.canvasRevision++; h.emit();
    await step(500);
    expect(await status()).toMatchObject({ state: "too-large" });
    const puts0 = puts(h).length;
    await step(30_000); await step(30_000);
    expect(heartbeats(h).length).toBe(beats); expect(puts(h)).toHaveLength(puts0);
    write(5); await step(500);
    expect(await status()).toMatchObject({ state: "live" });
    expect(pushes(h).at(-1)!.body.value).toEqual({ "/live/value": 5 });
    await step(30_000);
    expect(heartbeats(h).length).toBeGreaterThan(beats);
  });

  it("heartbeats the acknowledged version, repushes on need_value, and ignores a stale heartbeat answer", async () => {
    await connect();
    const first = pushes(h)[0].body;
    await step(30_000);
    expect(heartbeats(h).at(-1)!.body).toEqual({ deploymentId, seq: 1, digest: first.digest });
    let answered = false;
    h.setRespond(request => { if (request.body.value === undefined && !answered) { answered = true; return failure(409, { error: "need_value" }); } return ok(); });
    await step(30_000);
    await step(0);
    expect(pushes(h).at(-1)!.body).toEqual({ ...first, seq: 1 });
    expect(await status()).toMatchObject({ state: "live", seq: 1 });
    // A heartbeat that lost to a newer version must not block a healthy channel.
    const file = await journalPath(), raw = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...raw, seq: 9 }));
    h.setRespond(() => failure(409, { error: "stale_seq", currentSeq: 9 }));
    await step(30_000);
    expect(await status()).toMatchObject({ state: "live" });
    expect((await h.publisher.get(scope)).channel?.state).toBe("ready");
  });

  it("serializes heartbeats with pushes as the one in-flight request", async () => {
    await connect();
    await step(2000);
    let flying = 0, peak = 0, release!: () => void;
    h.setRespond(() => { flying++; peak = Math.max(peak, flying); return new Promise<Response>(resolve => { release = () => { flying--; resolve(ok()); }; }); });
    write(2); h.clock.advance(500);
    await vi.waitFor(() => expect(flying).toBe(1));
    // The heartbeat fires mid-push; it must queue behind the push, not overlap it.
    h.clock.advance(30_000);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(flying).toBe(1); expect(h.requests.filter(request => request.method === "PUT")).toHaveLength(2);
    release();
    await vi.waitFor(() => expect(heartbeats(h).length).toBe(1)); // runs only once the push settled
    release();
    await h.publisher.idle();
    expect(flying).toBe(0); expect(peak).toBe(1);
  });

  it("stops pushes and heartbeats when paused, and resumes only from paused", async () => {
    await connect();
    await step(2000);
    await expect(act("resume", { consentDigest: "f".repeat(64) })).rejects.toThrow("只能从暂停状态恢复");
    lastEvent = "event-1";
    await act("pause");
    expect((await status()).state).toBe("paused");
    const count = h.requests.length;
    write(2); await step(30_000); await step(30_000);
    expect(h.requests).toHaveLength(count);
    const consentDigest = liveConsentDigest(origin, deploymentId, baseMarks);
    await act("resume", { consentDigest });
    await step(0);
    expect(pushes(h).at(-1)!.body).toMatchObject({ seq: 2, value: { "/live/value": 2 } });
    expect((await status()).state).toBe("live");
  });

  it("stays paused across a token-only or marks-only upsert until the owner resumes", async () => {
    const wide: LiveMark[] = [{ path: "/live/value", subtree: false }, { path: "/live/other", subtree: false }];
    h.state.data = { live: { value: 1, other: "OLD" } };
    await connect(wide);
    await step(2000);
    await act("pause");
    const count = h.requests.length;
    h.state.data = { live: { value: 2, other: "NEW" } }; h.state.canvasRevision++; h.emit();
    expect((await upsert({ token: `${secret}-rotated` }, wide)).status.state).toBe("paused");
    await step(0); await step(30_000);
    expect(h.requests).toHaveLength(count);
    const narrowed = await upsert({}, baseMarks);
    expect(narrowed.channel).toMatchObject({ state: "paused", marks: baseMarks });
    await step(0); await step(30_000);
    expect(h.requests).toHaveLength(count);
    await act("resume", { consentDigest: liveConsentDigest(origin, deploymentId, baseMarks) });
    await step(0);
    expect(pushes(h).at(-1)!.body).toMatchObject({ seq: 2, value: { "/live/value": 2 } });
    expect((await status()).state).toBe("live");
  });

  it("forgets the retry details when paused but keeps the unacknowledged version", async () => {
    await connect();
    await step(2000);
    h.setRespond(() => failure(503));
    write(2); await step(500);
    expect(await status()).toMatchObject({ state: "retrying", attempts: 1, lastError: { code: "server_error" } });
    const { sending } = await journal();
    await act("pause");
    const paused = await status();
    expect(paused).toMatchObject({ state: "paused", attempts: 0 });
    expect(paused.nextAttemptAt).toBeUndefined(); expect(paused.lastError).toBeUndefined();
    expect((await journal()).sending).toEqual(sending);
  });

  it("waits out the push floor when a change arrives during a slow push", async () => {
    await connect();
    await step(2000);
    let finish!: (response: Response) => void;
    h.setRespond(() => new Promise<Response>(resolve => { finish = resolve; }));
    write(2); h.clock.advance(500);
    await vi.waitFor(() => expect(pushes(h)).toHaveLength(2));
    write(3); h.clock.advance(600);
    h.setRespond(() => ok());
    finish(ok());
    await h.publisher.idle();
    expect(pushes(h)).toHaveLength(2);
    await step(999);
    expect(pushes(h)).toHaveLength(2);
    await step(1);
    expect(pushes(h)).toHaveLength(3); expect(pushes(h)[2].body.value).toEqual({ "/live/value": 3 });
  });

  it("honours Retry-After when a change arrives during a push that is rate limited", async () => {
    await connect();
    await step(2000);
    let finish!: (response: Response) => void;
    h.setRespond(() => new Promise<Response>(resolve => { finish = resolve; }));
    write(2); h.clock.advance(500);
    await vi.waitFor(() => expect(pushes(h)).toHaveLength(2));
    write(3); h.clock.advance(600);
    h.setRespond(() => ok());
    finish(failure(429, { error: "rate_limited" }, { "Retry-After": "120" }));
    await h.publisher.idle();
    expect(pushes(h)).toHaveLength(2);
    expect(await status()).toMatchObject({ state: "retrying", attempts: 1 });
    await step(119_000);
    expect(pushes(h)).toHaveLength(2);
    await step(1_000);
    expect(pushes(h)).toHaveLength(3);
  });

  it("keeps attesting while unrelated writes arrive faster than the debounce", async () => {
    await connect();
    await step(2000);
    const before = heartbeats(h).length;
    for (let index = 0; index < 400; index++) { h.state.canvasRevision++; h.state.data = { ...h.state.data, PRIVATE_DATA: `changed-${index}` }; h.emit(); await step(200); }
    expect(heartbeats(h).length - before).toBeGreaterThanOrEqual(2);
    expect(heartbeats(h).at(-1)!.body).toEqual({ deploymentId, seq: 1, digest: pushes(h)[0].body.digest });
    expect(pushes(h)).toHaveLength(1);
    expect(JSON.stringify(h.requests.map(request => request.body))).not.toContain("changed-");
  });

  it("lists a channel left behind by a Board replacement and can still clear it", async () => {
    await connect();
    await step(2000);
    const replaced = "2027-01-01T00:00:00.000Z";
    h.state.createdAt = replaced; h.state.canvasRevision = 1; h.emit();
    await step(500);
    const listed = (await h.publisher.get({ boardId, expectedCreatedAt: replaced })).orphans!;
    expect(listed).toMatchObject([{ expectedCreatedAt: createdAt, channel: { state: "blocked", origin }, status: { state: "blocked", lastError: { code: "board_replaced" } } }]);
    expect(JSON.stringify(listed)).not.toContain(secret);
    const expectedEventId = listed[0].channel.eventId;
    await expect(h.publisher.set({ ...scope, action: "pause", eventId: "orphan-pause", expectedEventId })).rejects.toMatchObject({ code: "board_identity_changed" });
    expect((await h.publisher.set({ ...scope, action: "revoke", eventId: "orphan-clear", expectedEventId })).channel.state).toBe("revoking");
    h.setRespond(() => ok({ deploymentId, seq: 2, cleared: true }));
    await step(0);
    expect(h.requests.filter(request => request.method === "DELETE")).toHaveLength(1);
    expect(await readFile(await channelFile(), "utf8")).not.toContain(secret);
    expect((await h.publisher.get({ boardId, expectedCreatedAt: replaced })).orphans).toBeUndefined();
  });

  it("wipes the token of a channel left behind by a Board replacement without reaching the backend", async () => {
    await connect();
    await step(2000);
    const replaced = "2027-01-01T00:00:00.000Z";
    h.state.createdAt = replaced; h.state.canvasRevision = 1; h.emit();
    await step(500);
    const count = h.requests.length, [orphan] = (await h.publisher.get({ boardId, expectedCreatedAt: replaced })).orphans!;
    expect((await h.publisher.set({ ...scope, action: "stop-local", eventId: "orphan-stop", expectedEventId: orphan.channel.eventId })).status.lastError?.code).toBe("backend_copy_not_cleared");
    await step(0);
    expect(h.requests).toHaveLength(count);
    expect(await readFile(await channelFile(), "utf8")).not.toContain(secret);
  });

  it("names the panel section an owner can act in, in Chinese", async () => {
    await connect();
    await step(2000);
    h.setRespond(() => failure(401));
    write(2); await step(500);
    expect((await status()).lastError?.message).toContain("「1. 后端」");
    lastEvent = "stale";
    await expect(act("revoke")).rejects.toThrow("公开设置已变化");
  });

  it("revokes with a tombstone above every issued version, retries it, wipes the token and re-enables", async () => {
    await connect();
    await step(2000);
    h.setRespond(() => failure(503));
    await act("revoke");
    expect((await status()).state).toBe("revoking");
    await step(0);
    const deletes = () => h.requests.filter(request => request.method === "DELETE");
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].url).toMatch(/\?seq=2$/);
    expect(deletes()[0].authorization).toBe(`Bearer ${secret}`);
    h.setRespond(() => ok({ deploymentId, seq: 2, cleared: true }));
    await step(1000);
    expect(deletes()).toHaveLength(2);
    expect((await status()).state).toBe("revoked");
    expect(await readFile(await channelFile(), "utf8")).not.toContain(secret);
    await step(30_000); await step(30_000);
    expect(deletes()).toHaveLength(2);
    await expect(upsert({ token: undefined })).rejects.toThrow("请填写写入令牌");
    lastEvent = "event-2"; // the refused upsert did not advance the channel event
    h.requests.length = 0;
    await upsert();
    await step(0);
    expect(pushes(h)).toHaveLength(1);
    expect(pushes(h)[0].body).toMatchObject({ seq: 3, value: { "/live/value": 1 } });
    expect((await status()).state).toBe("live");
    expect((await h.publisher.get(scope)).channel?.channelId).toMatch(/^c[a-f0-9]{32}$/);
  });

  it("adopts a tombstone above our issued versions on a clearing DELETE, and resumes a revoke after restart", async () => {
    await connect();
    await step(2000);
    h.setRespond(() => failure(503));
    await act("revoke");
    await step(0);
    await h.publisher.close();
    h.setRespond(() => ok({ deploymentId, seq: 40, cleared: true }));
    h.publisher = h.build();
    await h.publisher.start();
    await step(0);
    expect((await status()).state).toBe("revoked");
    expect((await journal()).seq).toBe(40);
    await upsert();
    await step(0);
    expect(pushes(h).at(-1)!.body.seq).toBe(41);
  });

  it("offers a local-only stop that wipes the token and ends retries honestly", async () => {
    await connect();
    h.setRespond(() => failure(401));
    await act("revoke"); await step(0);
    expect(await status()).toMatchObject({ state: "revoking", lastError: { code: "clear_failed" } });
    await act("stop-local");
    expect(await status()).toMatchObject({ state: "revoked", lastError: { code: "backend_copy_not_cleared" } });
    expect(await readFile(await channelFile(), "utf8")).not.toContain(secret);
    const count = h.requests.length;
    await step(60_000); await step(60_000);
    expect(h.requests).toHaveLength(count);
  });

  it("keeps ready for a token-only change, but never lets a pending channel take the shortcut", async () => {
    await connect();
    await step(2000);
    const count = pushes(h).length;
    expect((await upsert({ token: `${secret}-rotated` })).channel.state).toBe("ready");
    await step(0);
    expect(pushes(h)).toHaveLength(count);
    expect((await h.publisher.get(scope)).channel?.state).toBe("ready");
    await act("pause");
    const consentDigest = liveConsentDigest(origin, deploymentId, baseMarks);
    await act("resume", { consentDigest });
    expect((await h.publisher.get(scope)).channel?.state).toBe("pending");
    await step(0);
    // Value unchanged and acked, yet a pending channel must reach the backend before attesting freshness.
    expect(pushes(h)).toHaveLength(count + 1);
    expect(pushes(h).at(-1)!.authorization).toBe(`Bearer ${secret}-rotated`);
    expect((await h.publisher.get(scope)).channel?.state).toBe("ready");
  });

  it("clears the journal on target change after a deployment block, and adopts a known seq only on human consent", async () => {
    await connect();
    await step(2000);
    h.setRespond(() => failure(409, { error: "stale_seq", currentSeq: 50 }));
    write(2); await step(500);
    expect((await h.publisher.get(scope)).channel?.state).toBe("blocked");
    expect((await journal()).seq).toBe(2);
    h.setRespond(() => ok());
    await upsert();
    expect((await journal()).seq).toBe(50);
    expect((await journal()).acked).toBeUndefined();
    await step(0);
    expect(pushes(h).at(-1)!.body).toMatchObject({ seq: 51, value: { "/live/value": 2 } });
    expect((await status()).state).toBe("live");
  });

  it("allows a deployment change only after a deployment_changed block, and an origin change only after revoking", async () => {
    await connect();
    await step(2000);
    const marks = baseMarks;
    const moved = (nextOrigin: string, nextDeployment: string) => ({ origin: nextOrigin, deploymentId: nextDeployment, token: secret, consentDigest: liveConsentDigest(nextOrigin, nextDeployment, marks) });
    await expect(upsert(moved("https://other.example.test", deploymentId))).rejects.toThrow("请先停止公开并清除旧后端的副本");
    lastEvent = "event-1";
    await expect(upsert(moved(origin, "deployment-2"))).rejects.toThrow("请先停止公开并清除旧后端的副本");
    lastEvent = "event-1";
    h.setRespond(() => failure(409, { error: "deployment_mismatch" }));
    write(2); await step(500);
    expect((await status()).lastError?.code).toBe("deployment_changed");
    h.setRespond(() => ok());
    await upsert(moved(origin, "deployment-2"));
    await step(0);
    expect(pushes(h).at(-1)!.body).toMatchObject({ deploymentId: "deployment-2", seq: 3, value: { "/live/value": 2 } });
    expect((await status()).state).toBe("live");
    h.setRespond(() => ok({ deploymentId: "deployment-2", seq: 4, cleared: true }));
    await act("revoke"); await step(0);
    h.requests.length = 0; h.setRespond(() => ok());
    await upsert(moved("https://other.example.test", "deployment-3"));
    await step(0);
    expect(pushes(h)).toHaveLength(1);
    expect(pushes(h)[0]).toMatchObject({ url: expect.stringContaining("https://other.example.test/_board/live/"), body: { seq: 5 } });
  });

  it("halts on Board identity change and refuses to act on a replaced Board", async () => {
    await connect();
    await step(2000);
    const count = h.requests.length;
    h.state.createdAt = "2027-01-01T00:00:00.000Z"; h.state.canvasRevision = 1; h.emit();
    await step(500);
    expect(h.requests).toHaveLength(count);
    await expect(h.publisher.get(scope)).rejects.toMatchObject({ code: "board_identity_changed" });
    const state = JSON.parse(await readFile(await channelFile(), "utf8"));
    expect(state).toMatchObject({ state: "blocked", blocked: { code: "board_replaced", message: "Board 已被替换" } });
  });

  it("refuses a stale consent digest, a stale event and a reused event", async () => {
    await h.publisher.start();
    await expect(upsert({ consentDigest: "a".repeat(64) })).rejects.toThrow("公开设置已变化，请重新确认");
    lastEvent = null;
    await upsert();
    await expect(h.publisher.set({ ...scope, action: "pause", eventId: "x", expectedEventId: "wrong" })).rejects.toMatchObject({ code: "revision_conflict" });
    const replayEvent = lastEvent!;
    await expect(h.publisher.set({ ...scope, action: "pause", eventId: replayEvent, expectedEventId: "other" })).rejects.toThrow(/reused/);
    await step(0);
    expect((await h.publisher.get(scope)).channel?.state).toBe("ready");
  });

  it("replays an identical upsert without another change", async () => {
    await h.publisher.start();
    const input = { ...scope, action: "upsert" as const, eventId: "fixed", expectedEventId: null, origin, deploymentId, token: secret, marks: baseMarks, consentDigest: liveConsentDigest(origin, deploymentId, baseMarks), acknowledgedPublic: true as const };
    const first = await h.publisher.set(input);
    expect(await h.publisher.set(input)).toEqual(first);
  });

  it("never exposes the write token through outputs, files other than the channel file, logs or errors", async () => {
    await connect();
    const outputs: unknown[] = [await h.publisher.get({ ...scope, marks: baseMarks }), await h.publisher.publicView(boardId, createdAt)];
    h.setRespond(() => failure(401));
    write(2); await step(500);
    outputs.push(await h.publisher.get(scope));
    expect(JSON.stringify(outputs)).not.toContain(secret);
    expect(await readFile(await journalPath(), "utf8")).not.toContain(secret);
    expect(h.logs.join("\n")).not.toContain(secret);
    expect(JSON.stringify(LiveGetOutputSchema.parse(outputs[0]))).not.toContain(secret);
    const problems = await Promise.allSettled([
      h.publisher.set({ ...scope, action: "upsert", eventId: "bad", expectedEventId: null, origin, deploymentId, token: "short-secret-token", marks: baseMarks, consentDigest: "a".repeat(64), acknowledgedPublic: true }),
      h.publisher.set({ ...scope, action: "upsert", eventId: "bad2", expectedEventId: null, origin, deploymentId, token: secret, marks: baseMarks, consentDigest: "a".repeat(64), acknowledgedPublic: true }),
    ]);
    for (const problem of problems) { expect(problem.status).toBe("rejected"); expect(String((problem as PromiseRejectedResult).reason)).not.toContain("secret"); expect(String((problem as PromiseRejectedResult).reason)).not.toContain(secret); }
    const directory = await readdir(join(root, "live-data"));
    expect((await stat(await channelFile())).mode & 0o777).toBe(0o600);
    expect((await stat(await journalPath())).mode & 0o777).toBe(0o600);
    expect(directory.some(name => name.endsWith(".tmp"))).toBe(false);
  });

  it("previews values, reports withheld paths and probes the backend and page origins", async () => {
    await h.publisher.start();
    h.state.data = { live: { value: 1 }, object: { a: 1 }, PRIVATE_DATA: "PRIVATE_DATA" };
    h.setRespond(request => {
      if (request.method !== "GET") return ok();
      return new Response(JSON.stringify({ status: "ok", id: "app", deploymentId, instanceId: "i", live: 1 }), { status: 200, headers: { "access-control-allow-origin": "https://page.example.test" } });
    });
    const marks: LiveMark[] = [{ path: "/live/value", subtree: false }, { path: "/object", subtree: false }];
    const result = await h.publisher.get({ ...scope, marks, probeOrigin: origin, pageOrigins: ["https://page.example.test", "https://other.example.test"] });
    expect(result.channel).toBeNull();
    expect(result.status).toEqual({ state: "off", seq: 0, attempts: 0, withheld: [] });
    expect(result.preview).toMatchObject({ values: { "/live/value": 1 }, overLimit: false, withheld: [{ path: "/object", reason: "object-without-subtree" }] });
    expect(JSON.stringify(result.preview)).not.toContain("PRIVATE_DATA");
    expect(result.backend).toEqual({ id: "app", deploymentId, live: 1 });
    expect(result.originProblems).toEqual(["把 https://other.example.test 加入 board-app.json 的 origins，然后重新部署。"]);
    expect(result.consentDigest).toBe(liveConsentDigest(origin, deploymentId, marks));
    h.setRespond(() => failure(500));
    expect(await h.publisher.get({ ...scope, marks, probeOrigin: origin })).toMatchObject({ backend: null, consentDigest: null, originProblems: [] });
  });

  it("exposes only paths and state to agents, omits them when no channel is public, and keeps the tool surface", async () => {
    await connect();
    expect(await h.publisher.publicView(boardId, createdAt)).toEqual({ paths: ["/live/value"], state: "live" });
    expect(await h.publisher.publicView(boardId, "2027-01-01T00:00:00.000Z")).toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), "board-live-agent-"));
    try {
      const store = new BoardStore(join(dir, "data")), journal = new ServiceJournal(join(dir, "service.json"));
      await journal.init();
      const service = new BoardService(store, journal, () => undefined);
      const board = await store.create({ id: boardId, title: "T", ownerAgentId: "owner", data: { live: { value: 1 } } });
      const actor = { agentId: "owner", cwd: dir };
      expect(await service.execute("read", { boardId }, actor)).not.toHaveProperty("livePublic");
      service.useLive({ publicView: h.publisher.publicView.bind(h.publisher) });
      expect(await service.execute("read", { boardId }, actor)).not.toHaveProperty("livePublic");
      service.useLive({ publicView: async () => ({ paths: ["/live/value"], state: "live" }) });
      const full = await service.execute("read", { boardId }, actor) as Record<string, unknown>;
      const inspect = await service.execute("read", { boardId, view: "inspect" }, actor) as Record<string, unknown>;
      for (const view of [full, inspect]) expect(view.livePublic).toEqual({ paths: ["/live/value"], state: "live" });
      expect(JSON.stringify(await store.read(boardId))).not.toContain("livePublic");
      expect(board.canvas.data).toEqual({ live: { value: 1 } });
      const bridge = new BoardBridge(service);
      await journal.bind("binding", actor);
      for (const operation of ["live_get", "live_set", "live", "board.live.set"]) expect(await bridge.dispatch(JSON.stringify({ protocol: 1, client: "mcp", operation, binding: "binding", input: { boardId } }))).toMatchObject({ ok: false });
      // Publishing with a `live` field changes nothing on the Board or its schema.
      const before = (await store.read(boardId))!;
      await expect(service.execute("publish", { boardId, expectedRevision: before.revision, eventId: "e", summary: "s", live: { marks: [{ path: "/live" }] } }, actor)).resolves.toBeDefined();
      expect(toolDefinitions().map(tool => tool.name)).toEqual(["board_inbox_list", "board_inbox_read", "board_inbox_triage", "board_list", "board_sources", "board_read_source", "board_read", "board_create", "board_publish", "board_respond", "board_decision", "board_feed", "board_emit"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("describes its channel for release building without the token, and reports each stored state", async () => {
    expect(await h.publisher.releaseChannel(scope.boardId, scope.expectedCreatedAt)).toBeNull();
    await connect();
    const ready = await h.publisher.releaseChannel(scope.boardId, scope.expectedCreatedAt);
    expect(ready).toMatchObject({ origin, paths: baseMarks.map(mark => mark.path).sort(), state: "live", channelState: "ready" });
    expect(JSON.stringify(ready)).not.toContain(secret);
    await act("pause");
    expect(await h.publisher.releaseChannel(scope.boardId, scope.expectedCreatedAt)).toMatchObject({ state: "paused", channelState: "paused" });
    await act("revoke");
    expect(await h.publisher.releaseChannel(scope.boardId, scope.expectedCreatedAt)).toMatchObject({ channelState: "revoking" });
  });
  it("does not restart polling work after close", async () => {
    await connect();
    await h.publisher.close();
    const count = h.requests.length;
    write(2); h.clock.advance(60_000); await h.publisher.idle();
    expect(h.requests).toHaveLength(count);
  });
});

describe("real backend and worker", () => {
  it("publishes through the real pool to the real live routes, without private data", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "board-live-e2e-"))), appDir = join(root, "app");
    const previous = process.env.BOARD_LIVE_WRITE_TOKEN;
    let running: { port: number; deploymentId: string; close(): Promise<void> } | undefined;
    const pool = new BoardStorePool(join(root, "plugin"), { workers: 1 });
    const headers: Array<string | null> = [], bodies: string[] = [];
    try {
      await initializeApp(appDir, "live-app");
      const configPath = join(appDir, "board-app.json"), config = JSON.parse(await readFile(configPath, "utf8"));
      config.port = 0;
      await writeFile(configPath, JSON.stringify(config));
      process.env.BOARD_LIVE_WRITE_TOKEN = secret;
      running = await startApp(await loadApp(appDir));
      const liveOrigin = `http://127.0.0.1:${running!.port}`;
      const board = await pool.create({ id: "e2e", title: "E2E", ownerAgentId: "owner", data: { live: { value: "visible" }, secret: "PRIVATE_DATA_E2E" } });
      await pool.addInteraction({ boardId: "e2e", intentId: "PRIVATE_INTERACTION", kind: "question", text: "PRIVATE_INTERACTION_TEXT" }, "owner");
      await pool.recordDecision({ boardId: "e2e", expectedRevision: (await pool.read("e2e"))!.revision, eventId: "d", decision: { id: "d1", choice: "PRIVATE_DECISION", basis: "explicit", rationale: "PRIVATE_RATIONALE", evidence: [], related: [] } });
      const fetcher: typeof fetch = async (url, init) => { headers.push(new Headers(init?.headers).get("origin")); if (typeof init?.body === "string") bodies.push(init.body); return fetch(url, init); };
      const publisher = new LiveDataPublisher(join(root, "plugin"), pool, { fetcher });
      await publisher.start();
      const marks: LiveMark[] = [{ path: "/live/value", subtree: false }];
      const probe = await publisher.get({ boardId: "e2e", expectedCreatedAt: board.createdAt, marks, probeOrigin: liveOrigin });
      expect(probe.backend).toMatchObject({ id: "live-app", deploymentId: running!.deploymentId, live: 1 });
      await publisher.set({ boardId: "e2e", expectedCreatedAt: board.createdAt, action: "upsert", eventId: "connect", expectedEventId: null, origin: liveOrigin, deploymentId: running!.deploymentId, token: secret, marks, consentDigest: probe.consentDigest!, acknowledgedPublic: true });
      const channelUrl = async () => `${liveOrigin}/_board/live/${(await publisher.get({ boardId: "e2e", expectedCreatedAt: board.createdAt })).channel!.channelId}`;
      await vi.waitFor(async () => { await publisher.idle(); expect((await publisher.get({ boardId: "e2e", expectedCreatedAt: board.createdAt })).status.state).toBe("live"); }, { timeout: 4000, interval: 50 });
      const url = await channelUrl();
      expect(await (await fetch(url)).json()).toMatchObject({ seq: 1, values: { "/live/value": "visible" } });
      expect(headers.every(value => value === null)).toBe(true);
      const current = (await pool.read("e2e"))!;
      await pool.emit({ boardId: "e2e", eventId: "update", source: "feed", summary: "update", dataPatch: [{ path: "/live/value", operation: "set", expected: { exists: true, value: "visible" }, value: "updated" }] });
      expect(current.canvas.data).toMatchObject({ live: { value: "visible" } });
      await vi.waitFor(async () => { const body = await (await fetch(url)).json() as { values: Record<string, unknown> }; expect(body.values["/live/value"]).toBe("updated"); }, { timeout: 8000, interval: 100 });
      await publisher.set({ boardId: "e2e", expectedCreatedAt: board.createdAt, action: "revoke", eventId: "stop", expectedEventId: "connect" });
      await vi.waitFor(async () => { await publisher.idle(); expect((await fetch(url)).status).toBe(410); }, { timeout: 4000, interval: 50 });
      await publisher.close();
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) { expect(body).not.toContain("PRIVATE_"); expect(body).not.toContain(secret); }
    } finally {
      await pool.close();
      if (previous === undefined) delete process.env.BOARD_LIVE_WRITE_TOKEN; else process.env.BOARD_LIVE_WRITE_TOKEN = previous;
      await running?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("uses the default fetcher against a real HTTP server without an Origin header", async () => {
    const root = await mkdtemp(join(tmpdir(), "board-live-http-"));
    let server: Server | undefined;
    const seen: Array<{ origin?: string; authorization?: string }> = [];
    server = createServer((request, response) => {
      seen.push({ origin: request.headers.origin, authorization: request.headers.authorization });
      request.resume(); request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const realOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const store: LiveStore = { subscribe: () => () => undefined, projectPublic: async (_id, expected, marks) => ({ createdAt: expected, canvasRevision: 1, ...projectLive({ live: { value: 1 } }, marks) }) };
    const publisher = new LiveDataPublisher(root, store);
    try {
      await publisher.start();
      await publisher.set({ ...scope, action: "upsert", eventId: "e", expectedEventId: null, origin: realOrigin, deploymentId, token: secret, marks: baseMarks, consentDigest: liveConsentDigest(realOrigin, deploymentId, baseMarks), acknowledgedPublic: true });
      await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 2000, interval: 20 });
      expect(seen[0]).toEqual({ origin: undefined, authorization: `Bearer ${secret}` });
    } finally {
      await publisher.close(); server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); await rm(root, { recursive: true, force: true });
    }
  });
});

describe("live contracts", () => {
  const live = { origin, channelId: `c${"a".repeat(32)}`, paths: ["/a", "/b"] };
  const release = { boardId: "b", expectedCanvasBase: { revision: 1, documentVersion: 1 }, publicData: {} };

  it("requires live.origin in apiOrigins and strips a client-sent live object", () => {
    expect(ReleaseCreateSchema.safeParse({ ...release, live }).success).toBe(false);
    expect(ReleaseCreateSchema.parse({ ...release, apiOrigins: [origin], live }).live).toEqual(live);
    const rpc = createReleaseRpc.input.parse({ ...release, live, liveData: true });
    expect(rpc).not.toHaveProperty("live"); expect(rpc.liveData).toBe(true);
    expect(createReleaseRpc.input.parse(release)).not.toHaveProperty("liveData");
  });

  it("keeps older records parsing and adds live and drift optionally", () => {
    expect(LiveReleaseSchema.safeParse({ ...live, paths: ["/b", "/a"] }).success).toBe(false);
    expect(LiveReleaseSchema.safeParse({ ...live, paths: ["/a", "/a/b"] }).success).toBe(false);
    expect(LiveReleaseSchema.safeParse({ ...live, extra: 1 }).success).toBe(false);
    expect(LiveDriftSchema.parse({ addedPaths: ["/x"], removedPaths: [], originChanged: false, channelState: "none" }).channelState).toBe("none");
    const manifest = { formatVersion: 1, releaseId: `release-${"a".repeat(64)}`, artifactHash: "a".repeat(64), title: "t", viewerVersion: 2, network: "offline", dependencies: [], warnings: [], files: [] };
    expect(ReleaseManifestSchema.parse(manifest)).not.toHaveProperty("live");
    expect(ReleaseManifestSchema.parse({ ...manifest, live }).live).toEqual(live);
    const settings = { title: "t", network: "offline", theme: "light", apiOrigins: [], publicData: {} };
    expect(ReleaseSettingsSchema.parse(settings)).not.toHaveProperty("live");
    expect(ReleaseSettingsSchema.parse({ ...settings, live }).live).toEqual(live);
    expect(ReleaseMetaSchema.parse({ formatVersion: 1, releaseId: manifest.releaseId, settings, source: { boardId: "b", boardCreatedAt: "x", canvasBase: { revision: 1, documentVersion: 1 }, documentVersion: 1, patchCount: 0 }, createdAt: "x" }).settings).not.toHaveProperty("live");
    expect(ShareUpdateSchema.parse({ boardId: "b", seriesId: "s", expectedSource: { documentVersion: 1, patchCount: 0 } }).liveMode).toBe("keep");
    expect(ShareUpdateResultSchema.parse({ upToDate: true })).toEqual({ upToDate: true });
    expect(ShareUpdateResultSchema.parse({ upToDate: true, liveDrift: { addedPaths: [], removedPaths: [], originChanged: true, channelState: "live" } })).toHaveProperty("liveDrift");
    expect(shareStatusRpc.name).toBe("board.release.share-status");
  });

  it("validates every set action and requires explicit public acknowledgement", () => {
    const base = { ...scope, eventId: "e", expectedEventId: null };
    const upsert = { ...base, action: "upsert", origin, deploymentId, marks: baseMarks, consentDigest: "a".repeat(64), acknowledgedPublic: true };
    expect(LiveSetInputSchema.safeParse(upsert).success).toBe(true);
    expect(LiveSetInputSchema.safeParse({ ...upsert, token: "short" }).success).toBe(false);
    expect(LiveSetInputSchema.safeParse({ ...upsert, acknowledgedPublic: false }).success).toBe(false);
    expect(LiveSetInputSchema.safeParse({ ...upsert, origin: "http://public.example.test" }).success).toBe(false);
    expect(LiveSetInputSchema.safeParse({ ...upsert, marks: [] }).success).toBe(false);
    expect(LiveSetInputSchema.safeParse({ ...base, action: "resume" }).success).toBe(false);
    for (const action of ["pause", "revoke", "stop-local"]) expect(LiveSetInputSchema.safeParse({ ...base, action }).success).toBe(true);
    expect(LiveSetInputSchema.safeParse({ ...base, action: "adopt" }).success).toBe(false);
  });
});
