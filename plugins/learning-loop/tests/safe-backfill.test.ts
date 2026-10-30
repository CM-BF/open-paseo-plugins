import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIndex, type SessionMeta } from "../server/sessions/index";
import { SessionSync, type SyncSource, type TimelinePage } from "../server/sessions/sync";

type FetchOptions = Parameters<SyncSource["fetch"]>[1];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const meta = (agentId: string, title = agentId): SessionMeta => ({
  agentId, title, provider: "codex", cwd: "/fixture", archived: false,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
});

/** A pure stored-history source: pausing I/O exposes scheduling and cancellation races. */
class StoredHistories implements SyncSource {
  agents: SessionMeta[] = [];
  histories = new Map<string, string[]>();
  epochs = new Map<string, string>();
  calls: Array<{ agentId: string; options: FetchOptions }> = [];
  beforeFetch?: (agentId: string, options: FetchOptions) => Promise<void>;
  beforeList?: () => Promise<void>;
  failure: string | null = null;

  set(agentId: string, messages: string[], epoch = "native-v1:one") {
    this.histories.set(agentId, messages);
    this.epochs.set(agentId, epoch);
  }

  async listAgents() {
    await this.beforeList?.();
    return this.agents;
  }

  async fetch(agentId: string, options: FetchOptions): Promise<TimelinePage> {
    this.calls.push({ agentId, options });
    await this.beforeFetch?.(agentId, options);
    const epoch = this.epochs.get(agentId) ?? "native-v1:one";
    const messages = this.histories.get(agentId) ?? [];
    const stale = Boolean(options.cursor && options.cursor.epoch !== epoch);
    const all = messages.map((text, seq) => ({
      item: { type: "user_message" as const, text },
      timestamp: "2026-10-01T00:00:00Z", seqStart: seq, seqEnd: seq,
    }));
    const entries = options.direction === "tail" || stale
      ? all.slice(-options.limit)
      : all.filter((entry) => entry.seqEnd > (options.cursor?.seq ?? -1)).slice(0, options.limit);
    const last = entries.at(-1);
    return {
      epoch, reset: stale, staleCursor: stale, gap: false,
      window: { minSeq: 0, maxSeq: messages.length - 1, nextSeq: messages.length },
      endCursor: last ? { epoch, seq: last.seqEnd } : null,
      hasNewer: Boolean(last && last.seqEnd < messages.length - 1),
      entries, error: this.failure,
    };
  }
}

let index: SessionIndex;
let syncs: SessionSync[];

function createSync(source: SyncSource, enabled: () => boolean = () => true) {
  const sync = new SessionSync(index, source, enabled);
  syncs.push(sync);
  return sync;
}

beforeEach(() => {
  index = new SessionIndex(":memory:");
  syncs = [];
});

afterEach(async () => {
  await Promise.all(syncs.map((sync) => sync.stop()));
  index.close();
  vi.restoreAllMocks();
});

describe("stored-history backfill safety", () => {
  it("serializes reads across agents, including a lifecycle request during backfill", async () => {
    const source = new StoredHistories();
    source.set("a", ["history A"]);
    source.set("b", ["history B"]);
    source.agents = [meta("a")];
    const entered = deferred();
    const release = deferred();
    source.beforeFetch = async (id, options) => {
      if (id === "a" && options.direction === "tail") {
        entered.resolve();
        await release.promise;
      }
    };
    const sync = createSync(source);
    const backfill = sync.backfill();
    await entered.promise;
    const lifecycle = sync.sync(meta("b"));
    try {
      await turn();
      expect(source.calls.map((call) => call.agentId)).toEqual(["a"]);
    } finally {
      release.resolve();
      await Promise.all([backfill, lifecycle]);
    }
    expect(source.calls.map((call) => call.agentId)).toEqual(["a", "a", "b", "b"]);
    expect(index.stats()).toEqual({ sessions: 2, messages: 2 });
  });

  it("coalesces repeated requests for one agent into one run and one follow-up", async () => {
    const source = new StoredHistories();
    source.set("a", ["history"]);
    const entered = deferred();
    const release = deferred();
    source.beforeFetch = async (_id, options) => {
      if (options.direction === "tail") {
        entered.resolve();
        await release.promise;
      }
    };
    const sync = createSync(source);
    const first = sync.sync(meta("a", "initial title"));
    await entered.promise;
    const next = sync.sync(meta("a", "new title"));
    const last = sync.sync(meta("a", "latest title"));
    try {
      expect(next).toBe(first);
      expect(last).toBe(first);
      expect(source.calls).toHaveLength(1);
    } finally {
      release.resolve();
      await first;
    }
    await vi.waitFor(() => expect(source.calls).toHaveLength(3));
    await vi.waitFor(() => expect(index.session("a")?.title).toBe("latest title"));
    expect(index.stats()).toEqual({ sessions: 1, messages: 1 });
  });

  it.each(["stop", "clear", "disable"] as const)(
    "%s during the initial read does not start another read or commit its contents",
    async (action) => {
      const source = new StoredHistories();
      source.set("a", ["must not be indexed"]);
      const entered = deferred();
      const release = deferred();
      source.beforeFetch = async (_id, options) => {
        if (options.direction === "tail") {
          entered.resolve();
          await release.promise;
        }
      };
      let enabled = true;
      const sync = createSync(source, () => enabled);
      const work = sync.sync(meta("a"));
      await entered.promise;
      let stopping: Promise<void> | undefined;
      if (action === "stop") stopping = sync.stop();
      else if (action === "clear") sync.clear();
      else enabled = false;
      release.resolve();
      expect(await work).toBe(0);
      await stopping;
      expect(source.calls).toHaveLength(1);
      expect(index.stats()).toEqual({ sessions: 0, messages: 0 });
    },
  );

  it.each(["stop", "clear", "disable"] as const)(
    "%s while an epoch reset is in flight does not retry the new epoch",
    async (action) => {
      const source = new StoredHistories();
      source.set("a", ["old history"], "daemon-old");
      let enabled = true;
      const sync = createSync(source, () => enabled);
      await sync.sync(meta("a"));
      source.set("a", ["replacement history"], "native-v1:replacement");
      const entered = deferred();
      const release = deferred();
      source.calls = [];
      source.beforeFetch = async () => { entered.resolve(); await release.promise; };
      const work = sync.sync(meta("a"));
      await entered.promise;
      let stopping: Promise<void> | undefined;
      if (action === "stop") stopping = sync.stop();
      else if (action === "clear") sync.clear();
      else enabled = false;
      release.resolve();
      expect(await work).toBe(0);
      await stopping;
      expect(source.calls).toHaveLength(1);
      expect(index.window("a", null, 10).map((row) => row.text)).toEqual(action === "clear" ? [] : ["old history"]);
    },
  );

  it("does not run queued agents after stop", async () => {
    const source = new StoredHistories();
    source.set("a", ["A"]);
    source.set("b", ["B"]);
    const entered = deferred();
    const release = deferred();
    source.beforeFetch = async (id) => {
      if (id === "a") { entered.resolve(); await release.promise; }
    };
    const sync = createSync(source);
    const first = sync.sync(meta("a"));
    await entered.promise;
    const queued = sync.sync(meta("b"));
    const stopping = sync.stop();
    release.resolve();
    await Promise.all([first, queued, stopping]);
    expect(source.calls.map((call) => call.agentId)).toEqual(["a"]);
    expect(index.stats()).toEqual({ sessions: 0, messages: 0 });
  });

  it("retains a fresh same-agent request made after clear while the canceled read settles", async () => {
    const source = new StoredHistories();
    source.set("a", ["freshly requested history"]);
    const entered = deferred();
    const release = deferred();
    let initial = true;
    source.beforeFetch = async () => {
      if (initial) {
        initial = false;
        entered.resolve();
        await release.promise;
      }
    };
    const sync = createSync(source);
    const canceled = sync.sync(meta("a", "canceled request"));
    await entered.promise;
    sync.clear();
    const fresh = sync.sync(meta("a", "fresh request"));
    release.resolve();
    await Promise.all([canceled, fresh]);
    await vi.waitFor(() => {
      expect(index.session("a")?.title).toBe("fresh request");
      expect(index.window("a", null, 10).map((row) => row.text)).toEqual(["freshly requested history"]);
    });
  });

  it("aborts the current backfill read, not only the next agent", async () => {
    const source = new StoredHistories();
    source.set("a", ["A"]);
    source.set("b", ["B"]);
    source.agents = [meta("a"), meta("b")];
    const entered = deferred();
    const release = deferred();
    source.beforeFetch = async (_id, options) => {
      if (options.direction === "tail") { entered.resolve(); await release.promise; }
    };
    const abort = new AbortController();
    const sync = createSync(source);
    const work = sync.backfill(abort.signal);
    await entered.promise;
    abort.abort();
    release.resolve();
    expect(await work).toBe(0);
    expect(source.calls).toHaveLength(1);
    expect(index.stats()).toEqual({ sessions: 0, messages: 0 });
    expect(sync.backfilling).toBe(false);
  });

  it.each(["stop", "clear", "disable", "abort"] as const)(
    "%s during agent enumeration prevents the first history read",
    async (action) => {
      const source = new StoredHistories();
      source.set("a", ["A"]);
      source.agents = [meta("a")];
      const entered = deferred();
      const release = deferred();
      source.beforeList = async () => { entered.resolve(); await release.promise; };
      let enabled = true;
      const abort = new AbortController();
      const sync = createSync(source, () => enabled);
      const work = sync.backfill(abort.signal);
      await entered.promise;
      if (action === "stop") await sync.stop();
      else if (action === "clear") sync.clear();
      else if (action === "disable") enabled = false;
      else abort.abort();
      release.resolve();
      expect(await work).toBe(0);
      expect(source.calls).toHaveLength(0);
      expect(index.stats()).toEqual({ sessions: 0, messages: 0 });
    },
  );

  it("does not enumerate agents when already aborted or stopped", async () => {
    const source = new StoredHistories();
    const enumerate = vi.spyOn(source, "listAgents");
    const sync = createSync(source);
    const abort = new AbortController();
    abort.abort();
    expect(await sync.backfill(abort.signal)).toBe(0);
    await sync.stop();
    expect(await sync.backfill()).toBe(0);
    expect(enumerate).not.toHaveBeenCalled();
  });

  it("keeps indexed history when its replacement cannot be read", async () => {
    const source = new StoredHistories();
    source.set("a", ["durable old history"], "daemon-old");
    const sync = createSync(source);
    await sync.sync(meta("a"));
    const state = index.syncState("a");
    source.set("a", ["untrusted partial replacement"], "native-v1:new");
    source.failure = "Native history file is unreadable";
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sync.sync(meta("a"))).toBe(0);
    expect(index.window("a", null, 10).map((row) => row.text)).toEqual(["durable old history"]);
    expect(index.syncState("a")).toEqual(state);
  });

  it("releases a source snapshot after success, failure, and cancellation", async () => {
    const source = new StoredHistories();
    source.set("a", ["history"]);
    const releaseSnapshot = vi.fn();
    const sync = createSync({
      listAgents: () => source.listAgents(),
      fetch: (id, options) => source.fetch(id, options),
      release: releaseSnapshot,
    });
    await sync.sync(meta("a"));
    expect(releaseSnapshot.mock.calls).toEqual([["a"]]);

    vi.spyOn(console, "error").mockImplementation(() => {});
    source.failure = "unreadable snapshot";
    await sync.sync(meta("a"));
    expect(releaseSnapshot.mock.calls).toEqual([["a"], ["a"]]);

    source.failure = null;
    const entered = deferred();
    const finishRead = deferred();
    source.beforeFetch = async () => { entered.resolve(); await finishRead.promise; };
    const work = sync.sync(meta("a"));
    await entered.promise;
    const stopped = sync.stop();
    finishRead.resolve();
    await Promise.all([work, stopped]);
    expect(releaseSnapshot.mock.calls).toEqual([["a"], ["a"], ["a"]]);
  });

  it("indexes multiple pages and migrates an old daemon epoch without duplicate messages", async () => {
    const source = new StoredHistories();
    const sync = createSync(source);
    source.set("a", ["old entry to replace"], "daemon-old");
    await sync.sync(meta("a"));
    const messages = Array.from({ length: 251 }, (_, i) => `native message ${i}`);
    source.set("a", messages, "native-v1:new");
    source.calls = [];
    expect(await sync.sync(meta("a"))).toBe(251);
    expect(index.window("a", null, 300).map((row) => row.text)).toEqual(messages);
    expect(index.syncState("a")).toEqual({ epoch: "native-v1:new", lastSeq: 250 });
    expect(source.calls).toHaveLength(4); // stale cursor plus three pages
    expect(await sync.sync(meta("a"))).toBe(0);
    expect(index.stats()).toEqual({ sessions: 1, messages: 251 });
  });
});
