import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { STATIC_VIEWER_LIVE_VERSION, STATIC_VIEWER_RUNTIME, STATIC_VIEWER_SHELL, STATIC_VIEWER_VERSION, staticViewerRuntime, staticViewerShell } from "../shared/static-viewer";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const CHANNEL = "c" + "a".repeat(32), ORIGIN = "https://live.example.com";

describe("viewer byte identity", () => {
  it("keeps the non-live runtime and shell exactly as published before live pages", () => {
    expect(sha256(STATIC_VIEWER_RUNTIME)).toBe("0e40ba8103fc23aec1ac8f653e8aca1990ad075e45b619b7d3b68c40fd94f4eb");
    expect(sha256(STATIC_VIEWER_SHELL)).toBe("b68f2146790fbc3ca27d8ae8bd11f3663d4616d702a797520972e003005fb059");
    expect(staticViewerRuntime()).toBe(STATIC_VIEWER_RUNTIME); expect(staticViewerShell()).toBe(STATIC_VIEWER_SHELL);
    expect(STATIC_VIEWER_VERSION).toBe(2); expect(STATIC_VIEWER_LIVE_VERSION).toBe(3);
  });
  it("keeps live-only code out of the non-live viewer", () => {
    for (const text of [STATIC_VIEWER_RUNTIME, STATIC_VIEWER_SHELL]) for (const marker of ["live-ready", "_board/live", "data-live", "paseo-board-live:"]) expect(text).not.toContain(marker);
    expect(staticViewerRuntime(true)).toContain("live-ready"); expect(staticViewerShell(true)).toContain("_board/live");
  });
});

type Timer = { at: number; run: () => unknown };
function doc(seq: number, values: Record<string, unknown>, at = "2026-11-10T00:00:00.000Z") { return { v: `abcd1234.${seq}`, seq, at, values }; }
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(body === null ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const ok = (document: unknown, f = "1", p = 5) => reply(200, document, { "Board-Live": `f=${f}, p=${p}` });
const unchanged = (f = "1", p = 5) => reply(204, null, { "Board-Live": `f=${f}, p=${p}` });

/** Runs the real shell text with a fake DOM and a manual clock; the network is one scripted fetch. */
function shellHarness(options: { origin?: string; hidden?: boolean; stored?: unknown; random?: number } = {}) {
  let now = 0, id = 0, hidden = options.hidden ?? false;
  const timers = new Map<number, Timer>(), storage = new Map<string, string>(), calls: Array<{ url: string; init: RequestInit }> = [], posts: Array<Record<string, unknown>> = [];
  if (options.stored !== undefined) storage.set(`paseo-board-live:${CHANNEL}`, JSON.stringify(options.stored));
  let script: (url: string) => Response | Promise<Response> = () => unchanged();
  const frame = { contentWindow: { postMessage: (message: Record<string, unknown>) => posts.push(message) }, srcdoc: "" };
  const notice = { textContent: "", hidden: true }, box = { textContent: "", hidden: true };
  const events = new Map<string, Array<(event: unknown) => void>>(), messages: Array<(event: unknown) => void> = [];
  const context = {
    document: { querySelector: (selector: string) => selector === "iframe" ? frame : selector === "[data-live]" ? box : notice, get hidden() { return hidden; }, addEventListener: (type: string, fn: (event: unknown) => void) => events.set(type, [...events.get(type) ?? [], fn]) },
    window: { addEventListener: (_: string, fn: (event: unknown) => void) => messages.push(fn), open: () => undefined },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    location: { origin: options.origin ?? "https://pages.example.com", href: "https://pages.example.com/", pathname: "/" },
    navigator: {}, crypto: webcrypto, TextDecoder, TextEncoder, AbortController, URL,
    Math: Object.create(Math, { random: { value: () => options.random ?? 0.5 } }),
    performance: { now: () => now }, console,
    setTimeout: (run: () => unknown, ms: number) => { timers.set(++id, { at: now + ms, run }); return id; },
    clearTimeout: (timer: number) => timers.delete(timer),
    fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); const signal = init.signal as AbortSignal; return await new Promise<Response>((resolve, reject) => { signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))); void Promise.resolve(script(url)).then(resolve, reject); }); },
  };
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = Math.max(now, next[1].at); timers.delete(next[0]); void next[1].run(); await flush();
    }
    now = end; await flush();
  };
  const initial = () => JSON.parse(/\)\((\{.*\})\);<\\?\/script>/s.exec(frame.srcdoc)![1].replace(/\\u003c/g, "<"));
  return {
    context, calls, posts, box, frame, storage, flush, advance, initial,
    respond: (next: typeof script) => { script = next; },
    setHidden: (value: boolean) => { hidden = value; for (const fn of events.get("visibilitychange") ?? []) fn({}); },
    frameReady: () => { for (const fn of messages) fn({ source: frame.contentWindow, data: { type: "live-ready", channel: "paseo-board-release-v1", releaseId: `release-${"f".repeat(64)}`, sessionId: initial().sessionId } }); },
    start: async () => {
      const shell = runInNewContext(`(${staticViewerShell(true)})`, context) as (config: unknown) => void;
      shell({ releaseId: `release-${"f".repeat(64)}`, data: { frozen: 1 }, apiOrigins: [ORIGIN], html: "", prefix: "", suffix: "", runtime: "function(){}", live: { origin: ORIGIN, channelId: CHANNEL, paths: ["/a", "/b"] } });
      await flush();
    },
  };
}

describe("live viewer shell", () => {
  it("polls without author headers, sends the held version and applies a 200 before booting", async () => {
    const h = shellHarness(); h.respond(() => ok(doc(1, { "/a": 1, "/outside": 9 })));
    await h.start();
    expect(h.calls[0].url).toBe(`${ORIGIN}/_board/live/${CHANNEL}`);
    const { signal: _, ...init } = h.calls[0].init;
    expect(init).toEqual({ mode: "cors", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(h.initial().live.doc.values).toEqual({ "/a": 1 });
    expect(h.storage.has(`paseo-board-live:${CHANNEL}`)).toBe(true);
    h.respond(() => unchanged());
    await h.advance(5000);
    expect(h.calls[1].url).toBe(`${ORIGIN}/_board/live/${CHANNEL}?v=abcd1234.1`);
    expect(h.box.hidden).toBe(true);
  });
  it("boots with the local copy after 1 second when the first poll is slow, then delivers the result", async () => {
    let resolveFirst: (response: Response) => void = () => undefined;
    const h = shellHarness({ stored: doc(1, { "/a": "cached" }) }); h.respond(() => new Promise<Response>(resolve => { resolveFirst = resolve; }));
    await h.start();
    expect(h.frame.srcdoc).toBe("");
    await h.advance(1000);
    expect(h.initial().live.doc.values).toEqual({ "/a": "cached" });
    expect(h.posts).toEqual([]);
    h.frameReady();
    resolveFirst(ok(doc(2, { "/a": "fresh" })));
    await h.flush();
    expect(h.posts.at(-1)).toMatchObject({ type: "live", state: "live", doc: { values: { "/a": "fresh" }, seq: 2 } });
  });
  it("accepts a document only for a new deployment prefix or a higher seq", async () => {
    const h = shellHarness({ stored: doc(5, { "/a": "kept" }) }); h.respond(() => ok(doc(3, { "/a": "older" })));
    await h.start(); h.frameReady();
    expect(h.initial().live.doc.values).toEqual({ "/a": "kept" });
    h.respond(() => ok({ v: "ffff0000.1", seq: 1, at: "2026-11-11T00:00:00.000Z", values: { "/a": "new deployment" } }));
    await h.advance(5000);
    expect(h.posts.at(-1)).toMatchObject({ doc: { seq: 1, values: { "/a": "new deployment" } } });
  });
  it("uses the advertised poll period with jitter and clamps it to 2-300 s", async () => {
    const first = shellHarness({ random: 0 }); first.respond(() => unchanged("1", 60));
    await first.start(); await first.advance(47_999); expect(first.calls).toHaveLength(1); await first.advance(1); expect(first.calls).toHaveLength(2);
    const fast = shellHarness({ random: 1 }); fast.respond(() => unchanged("1", 1));
    await fast.start(); await fast.advance(2_399); expect(fast.calls).toHaveLength(1); await fast.advance(2); expect(fast.calls).toHaveLength(2);
  });
  it("shows no banner for f=g, and the stale banner immediately for f=0", async () => {
    const h = shellHarness({ stored: doc(1, { "/a": 1 }) }); h.respond(() => unchanged("g"));
    await h.start(); expect(h.box.hidden).toBe(true);
    h.respond(() => unchanged("0")); await h.advance(5000);
    expect(h.box.hidden).toBe(false); expect(h.box.textContent).toContain("发布者暂时没有推送更新");
    h.respond(() => unchanged("1")); await h.advance(5000);
    expect(h.box.hidden).toBe(true);
  });
  it("backs off 5, 10, 20, 40, 60 s and reports the network banner only after max(30 s, 3 x interval)", async () => {
    const h = shellHarness(); h.respond(() => { throw new TypeError("refused"); });
    await h.start();
    expect(h.calls).toHaveLength(1);
    await h.advance(5000); expect(h.calls).toHaveLength(2);
    await h.advance(10_000); expect(h.calls).toHaveLength(3); expect(h.box.hidden).toBe(true);
    await h.advance(14_999); expect(h.box.hidden).toBe(true);
    await h.advance(1); expect(h.box.hidden).toBe(false); expect(h.box.textContent).toBe("连接不上数据源，显示的是发布时的内容，正在重试。");
    await h.advance(5_000); expect(h.calls).toHaveLength(4);
    await h.advance(40_000); expect(h.calls).toHaveLength(5);
    await h.advance(60_000); expect(h.calls).toHaveLength(6);
    await h.advance(60_000); expect(h.calls).toHaveLength(7);
    h.respond(() => ok(doc(1, { "/a": 1 }))); await h.advance(60_000);
    expect(h.box.hidden).toBe(true);
  });
  it("waits three intervals before the network banner when the advertised period is long", async () => {
    const h = shellHarness(); h.respond(() => unchanged("1", 60));
    await h.start(); h.respond(() => { throw new TypeError("down"); });
    await h.advance(60_000); await h.advance(119_999); expect(h.box.hidden).toBe(true);
    await h.advance(1); expect(h.box.hidden).toBe(false);
  });
  it("names the time of the last good document in the network banner", async () => {
    const h = shellHarness({ stored: doc(1, { "/a": 1 }) }); h.respond(() => { throw new TypeError("down"); });
    await h.start(); await h.advance(30_000);
    expect(h.box.textContent).toMatch(/^连接不上数据源，显示的是 .+ 的数据，正在重试。$/);
  });
  it("honours Retry-After on 429/503, clamped to 2-300 s, and backs off without one", async () => {
    const h = shellHarness(); h.respond(() => reply(429, { error: "busy" }, { "Retry-After": "7" }));
    await h.start(); await h.advance(6_999); expect(h.calls).toHaveLength(1); await h.advance(1); expect(h.calls).toHaveLength(2);
    h.respond(() => reply(503, "", { "Retry-After": "1" }));
    await h.advance(7_000); expect(h.calls).toHaveLength(3); await h.advance(1_999); expect(h.calls).toHaveLength(3); await h.advance(1); expect(h.calls).toHaveLength(4);
    h.respond(() => reply(429, { error: "busy" }, { "Retry-After": "100000" }));
    await h.advance(2_000); expect(h.calls).toHaveLength(5); await h.advance(299_999); expect(h.calls).toHaveLength(5); await h.advance(1); expect(h.calls).toHaveLength(6);
    const plain = shellHarness(); plain.respond(() => reply(503, ""));
    await plain.start(); await plain.advance(4_999); expect(plain.calls).toHaveLength(1); await plain.advance(1); expect(plain.calls).toHaveLength(2);
    await plain.advance(10_000); expect(plain.calls).toHaveLength(3);
  });
  it("does not poll before Retry-After when the tab returns", async () => {
    const h = shellHarness(); h.respond(() => reply(429, { error: "busy" }, { "Retry-After": "60" }));
    await h.start(); h.setHidden(true); await h.advance(1000); h.setHidden(false); await h.flush();
    expect(h.calls).toHaveLength(1);
    await h.advance(59_000); expect(h.calls).toHaveLength(2);
  });
  it("shows the unavailable banner on 404 and repolls at 30 s", async () => {
    const h = shellHarness({ stored: doc(1, { "/a": 1 }) }); h.respond(() => reply(404, { error: "unknown" }));
    await h.start();
    expect(h.box.textContent).toMatch(/^实时数据暂不可用，显示的是 .+ 的数据。$/);
    expect(h.initial().live.doc.values).toEqual({ "/a": 1 });
    await h.advance(29_999); expect(h.calls).toHaveLength(1); await h.advance(1); expect(h.calls).toHaveLength(2);
    const frozen = shellHarness(); frozen.respond(() => reply(404, { error: "unknown" }));
    await frozen.start(); expect(frozen.box.textContent).toBe("实时数据暂不可用，显示的是发布时的内容。");
  });
  it("drops the overlay on 410, removes the local copy, repolls at 300 s and resumes when re-enabled", async () => {
    const h = shellHarness(); h.respond(() => ok(doc(1, { "/a": 1 })));
    await h.start(); h.frameReady();
    expect(h.storage.has(`paseo-board-live:${CHANNEL}`)).toBe(true);
    h.respond(() => reply(410, { error: "cleared" })); await h.advance(5000);
    expect(h.box.textContent).toBe("发布者已停止公开这些数据，显示的是发布时的内容。");
    expect(h.posts.at(-1)).toMatchObject({ type: "live", state: "revoked", asOf: null, cleared: true });
    expect(h.storage.has(`paseo-board-live:${CHANNEL}`)).toBe(false);
    expect(h.calls.at(-1)!.url).toContain("?v=abcd1234.1");
    await h.advance(299_999); expect(h.calls).toHaveLength(2);
    h.respond(() => ok(doc(9, { "/a": "again" })));
    await h.advance(1);
    expect(h.calls).toHaveLength(3); expect(h.calls.at(-1)!.url).toBe(`${ORIGIN}/_board/live/${CHANNEL}`);
    expect(h.box.hidden).toBe(true); expect(h.posts.at(-1)).toMatchObject({ doc: { seq: 9 } });
  });
  it("does not poll while hidden and checks once on return", async () => {
    const h = shellHarness(); h.respond(() => unchanged());
    await h.start(); h.setHidden(true); await h.advance(60_000);
    expect(h.calls).toHaveLength(1);
    h.setHidden(false); await h.flush();
    expect(h.calls).toHaveLength(2);
  });
  it("boots immediately without polling when opened in a hidden tab", async () => {
    const h = shellHarness({ hidden: true, stored: doc(1, { "/a": "cached" }) }); await h.start();
    expect(h.calls).toHaveLength(0); expect(h.initial().live.doc.values).toEqual({ "/a": "cached" });
    h.setHidden(false); await h.flush(); expect(h.calls).toHaveLength(1);
  });
  it("never polls from an opaque preview origin", async () => {
    const h = shellHarness({ origin: "null" }); await h.start(); h.setHidden(false); await h.advance(60_000);
    expect(h.calls).toHaveLength(0); expect(h.box.textContent).toBe("预览不连接实时数据，显示发布时的内容。");
    expect(h.initial().live).toMatchObject({ state: "preview", doc: null });
  });
  it("treats an oversized or malformed document as a failed poll", async () => {
    const big = shellHarness(); big.respond(() => ok("x".repeat(131_073)));
    await big.start(); expect(big.initial().live.doc).toBeNull(); expect(big.storage.size).toBe(0);
    const bad = shellHarness(); bad.respond(() => ok({ v: "not-a-version", seq: 1, at: "x", values: {} }));
    await bad.start(); expect(bad.initial().live.doc).toBeNull(); await bad.advance(4999); expect(bad.calls).toHaveLength(1); await bad.advance(1); expect(bad.calls).toHaveLength(2);
  });
  it("aborts a request after 8 s and keeps one poll in flight", async () => {
    const h = shellHarness(); h.respond(() => new Promise<Response>(() => undefined));
    await h.start(); expect(h.calls).toHaveLength(1);
    h.setHidden(false); await h.flush(); expect(h.calls).toHaveLength(1);
    await h.advance(8000); expect((h.calls[0].init.signal as AbortSignal).aborted).toBe(true);
    await h.advance(5000); expect(h.calls).toHaveLength(2);
  });
  it("ignores a corrupt local copy", async () => {
    const h = shellHarness(); h.storage.set(`paseo-board-live:${CHANNEL}`, "{not json"); h.respond(() => { throw new TypeError("down"); });
    await h.start(); await h.advance(1000); expect(h.initial().live.doc).toBeNull();
  });
});

/** Runs the real runtime text in a VM; "parent" messages are delivered directly. */
function runtimeHarness(live: { paths: string[]; state?: string; asOf?: string | null; doc?: unknown }, data: Record<string, unknown>) {
  const parent = { postMessage: (message: Record<string, unknown>) => sent.push(message) }, sent: Array<Record<string, unknown>> = [];
  const messages: Array<(event: unknown) => void> = [], events: Array<{ type: string; detail: unknown }> = [], frames = new Map<number, () => void>();
  let frameId = 0;
  const window: Record<string, unknown> = {
    addEventListener: (type: string, fn: (event: unknown) => void) => { if (type === "message") messages.push(fn); },
    dispatchEvent: (event: { type: string; detail: unknown }) => events.push(event),
  };
  const noop = () => undefined;
  const context = {
    window, parent, console, structuredClone,
    document: { addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], readyState: "complete", documentElement: {} },
    MutationObserver: class { observe() { return undefined; } disconnect() { return undefined; } },
    CustomEvent: class { constructor(readonly type: string, init: { detail: unknown }) { this.detail = init.detail; } detail: unknown; },
    requestAnimationFrame: (fn: () => void) => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout, clearTimeout,
  };
  const initial = { releaseId: "release-x", sessionId: "session", data, state: {}, siteUrl: "https://x/", live: { state: "live", asOf: null, doc: null, ...live } };
  runInNewContext(`(${staticViewerRuntime(true)})(${JSON.stringify(initial)})`, context);
  const board = window.board as { getData(): Record<string, any>; onData(fn: (value: unknown) => void): () => void; watch(path: string, fn: (value: unknown, meta: unknown) => void, options?: unknown): () => void; getContext(): Record<string, any> };
  const receive = (message: Record<string, unknown>) => { for (const fn of messages) fn({ source: parent, data: { channel: "paseo-board-release-v1", releaseId: "release-x", sessionId: "session", type: "live", state: "live", asOf: null, ...message } }); };
  return { board, receive, sent, events, runFrames: () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } } };
}

describe("live viewer runtime", () => {
  it("overlays the boot document before authored code and reports the page-level state", () => {
    const h = runtimeHarness({ paths: ["/live/a"], state: "publisher-silent", asOf: "2026-11-10T00:00:00.000Z", doc: doc(4, { "/live/a": 7 }) }, { frozen: true, live: { a: 1 } });
    expect(h.board.getData()).toEqual({ frozen: true, live: { a: 7 } });
    expect(h.board.getContext()).toMatchObject({ canvasRevision: 5, boardRevision: 1, live: { state: "publisher-silent", asOf: "2026-11-10T00:00:00.000Z" } });
    expect(h.sent).toEqual([{ type: "live-ready", channel: "paseo-board-release-v1", releaseId: "release-x", sessionId: "session" }]);
  });
  it("sets values, creates object parents, deletes absent paths and skips non-object parents", () => {
    const h = runtimeHarness({ paths: ["/a", "/obj/b", "/deep/er/c", "/text/x", "/list/0"] }, { a: "frozen", obj: { b: 1, c: 2 }, text: "not an object", list: [10] });
    h.receive({ doc: doc(1, { "/deep/er/c": 3, "/text/x": 9, "/list/0": 11 }) });
    expect(h.board.getData()).toEqual({ obj: { c: 2 }, deep: { er: { c: 3 } }, text: "not an object", list: [10] });
  });
  it("ignores a path that is not in the release and never touches Object.prototype", () => {
    const h = runtimeHarness({ paths: ["/a"] }, {});
    h.receive({ doc: doc(1, { "/a": 1, "/b": 2, "/__proto__/polluted": true }) });
    expect(h.board.getData()).toEqual({ a: 1 }); expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("fires watch, onData and board:data only on a real change, with the update's revision", () => {
    const h = runtimeHarness({ paths: ["/a", "/obj"] }, { a: 1, obj: { x: 1, y: 2 } }), watched: unknown[][] = [], data: unknown[] = [];
    h.board.watch("/a", (value, meta) => watched.push([value, meta]));
    h.board.onData(value => data.push(value));
    expect(watched).toEqual([[1, { path: "/a", exists: true, boardRevision: 1, canvasRevision: 1 }]]);
    h.receive({ doc: doc(2, { "/a": 1, "/obj": { y: 2, x: 1 } }) });
    expect(watched).toHaveLength(1); expect(data).toEqual([]); expect(h.events).toEqual([]);
    expect(h.board.getContext().canvasRevision).toBe(3);
    h.receive({ doc: doc(3, { "/a": 2, "/obj": { x: 1, y: 2 } }) });
    expect(watched.at(-1)).toEqual([2, { path: "/a", exists: true, boardRevision: 1, canvasRevision: 4 }]);
    expect(data).toEqual([{ a: 2, obj: { x: 1, y: 2 } }]); expect(h.events).toHaveLength(1); expect(h.events[0].type).toBe("board:data");
  });
  it("updates every watch cache before any callback, and frame watches coalesce", () => {
    const h = runtimeHarness({ paths: ["/a", "/b"] }, { a: 1, b: 1 }), seen: unknown[] = [];
    h.board.watch("/a", () => { h.board.watch("/b", value => seen.push(["late b", value])); });
    h.board.watch("/b", value => seen.push(["b", value]));
    h.receive({ doc: doc(2, { "/a": 2, "/b": 2 }) });
    expect(seen).toContainEqual(["late b", 2]);
    const frame: unknown[] = [];
    h.board.watch("/a", value => frame.push(value), { schedule: "frame" });
    h.receive({ doc: doc(3, { "/a": 3, "/b": 2 }) }); h.receive({ doc: doc(4, { "/a": 4, "/b": 2 }) });
    expect(frame).toEqual([2]);
    h.runFrames(); expect(frame).toEqual([2, 4]);
  });
  it("restores frozen data on clear, resets the revision and fires only for changed paths", () => {
    const h = runtimeHarness({ paths: ["/a"], doc: doc(5, { "/a": "live" }) }, { a: "frozen" }), watched: unknown[] = [];
    h.board.watch("/a", value => watched.push(value));
    h.receive({ cleared: true, state: "revoked" });
    expect(h.board.getData()).toEqual({ a: "frozen" }); expect(watched).toEqual(["live", "frozen"]);
    expect(h.board.getContext()).toMatchObject({ canvasRevision: 1, live: { state: "revoked", asOf: null } });
  });
  it("stops delivering after unsubscribe and only accepts messages from the parent", () => {
    const h = runtimeHarness({ paths: ["/a"] }, { a: 1 }), seen: unknown[] = [];
    h.board.watch("/a", value => seen.push(value))();
    h.receive({ doc: doc(2, { "/a": 2 }) });
    expect(seen).toEqual([1]); expect(h.board.getData()).toEqual({ a: 2 });
  });
});
