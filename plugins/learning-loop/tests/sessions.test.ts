import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryTerms, SessionIndex, type SessionMeta } from "../server/sessions/index";
import { SessionSync, type SyncSource, type TimelinePage } from "../server/sessions/sync";
import { toolSummary } from "../server/sessions/transcript";

let dir: string;
let index: SessionIndex;

const meta = (agentId: string, title: string, createdAt = "2026-10-01T00:00:00Z"): SessionMeta => ({
  agentId,
  title,
  provider: "claude",
  cwd: "/repo",
  createdAt,
  updatedAt: createdAt,
  archived: false,
});

/** A fake daemon timeline: rows with seq = position, one epoch that tests can bump. */
class FakeTimelines implements SyncSource {
  rows = new Map<string, AgentTimelineItem[]>();
  epochs = new Map<string, string>();
  agents: SessionMeta[] = [];
  calls = 0;

  push(agentId: string, ...items: AgentTimelineItem[]) {
    this.rows.set(agentId, [...(this.rows.get(agentId) ?? []), ...items]);
    if (!this.epochs.has(agentId)) this.epochs.set(agentId, "e1");
  }

  async listAgents() {
    return this.agents;
  }

  async fetch(agentId: string, options: { direction: "tail" | "after"; cursor?: { epoch: string; seq: number }; limit: number }): Promise<TimelinePage> {
    this.calls += 1;
    const rows = this.rows.get(agentId) ?? [];
    const epoch = this.epochs.get(agentId) ?? "e1";
    const stale = options.cursor !== undefined && options.cursor.epoch !== epoch;
    const all = rows.map((item, seq) => ({ item, timestamp: `2026-10-01T00:00:${String(seq).padStart(2, "0")}Z`, seqStart: seq, seqEnd: seq }));
    let entries = all;
    if (options.direction === "after" && !stale) entries = all.filter((e) => e.seqEnd > options.cursor!.seq).slice(0, options.limit);
    else entries = all.slice(-options.limit);
    const last = entries.at(-1);
    return {
      epoch,
      reset: stale,
      staleCursor: stale,
      gap: false,
      window: { minSeq: 0, maxSeq: rows.length - 1, nextSeq: rows.length },
      endCursor: last ? { epoch, seq: last.seqEnd } : null,
      hasNewer: last ? last.seqEnd < rows.length - 1 : false,
      entries,
      error: null,
    };
  }
}

const user = (text: string): AgentTimelineItem => ({ type: "user_message", text });
const assistant = (text: string): AgentTimelineItem => ({ type: "assistant_message", text });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ll-sessions-"));
  index = new SessionIndex(join(dir, "sessions.db"));
});

afterEach(async () => {
  index.close();
  await rm(dir, { recursive: true, force: true });
});

describe("queryTerms", () => {
  it("keeps quoted phrases and drops AND", () => {
    expect(queryTerms('deploy AND "blue green" staging')).toEqual(["deploy", "blue green", "staging"]);
  });
});

describe("toolSummary", () => {
  it("summarizes a shell call without its output", () => {
    expect(toolSummary("Bash", { type: "shell", command: "npm test", output: "lots of output", exitCode: 1 }, "failed")).toBe("$ npm test (exit 1) (failed)");
  });
});

describe("SessionSync + SessionIndex", () => {
  it("indexes incrementally and finds the session by keyword and by Chinese phrase", async () => {
    const source = new FakeTimelines();
    const sync = new SessionSync(index, source);
    source.push("a1", user("How do we deploy the staging server?"), assistant("Use make deploy-staging; SSH port is 2222."));
    expect(await sync.sync(meta("a1", "Staging deploy"))).toBe(2);
    source.push("a1", user("把记忆功能移植到 Paseo 插件里"), assistant("好的，先做学习闭环。"));
    expect(await sync.sync(meta("a1", "Staging deploy"))).toBe(2);

    const hits = index.search("staging port", { limit: 5 });
    expect(hits.map((h) => [h.session.agentId, h.anchor.role])).toEqual([["a1", "assistant"]]);
    expect(index.search("学习闭环", { limit: 5 })[0]!.anchor.text).toContain("学习闭环");
    // Two-character CJK terms fall back to LIKE.
    expect(index.search("记忆", { limit: 5 }).length).toBe(1);
    expect(index.session("a1")!.messageCount).toBe(4);
  });

  it("re-indexes from the start when the daemon's timeline epoch changes", async () => {
    const source = new FakeTimelines();
    const sync = new SessionSync(index, source);
    source.push("a1", user("first version"));
    await sync.sync(meta("a1", "t"));
    source.rows.set("a1", [user("rebuilt history"), assistant("after reset")]);
    source.epochs.set("a1", "e2");
    await sync.sync(meta("a1", "t"));
    expect(index.window("a1", null, 10).map((m) => m.text)).toEqual(["rebuilt history", "after reset"]);
  });

  it("falls back to OR when no session has every term, and ranks newest first on request", async () => {
    const source = new FakeTimelines();
    const sync = new SessionSync(index, source);
    source.push("old", user("postgres migration plan"));
    source.push("new", user("postgres vacuum tuning"));
    await sync.sync(meta("old", "old", "2026-09-01T00:00:00Z"));
    await sync.sync(meta("new", "new", "2026-10-10T00:00:00Z"));
    expect(index.search("migration vacuum", { limit: 5 }).length).toBe(2);
    const newest = index.search("postgres", { limit: 5, sort: "newest" });
    expect(newest.map((h) => h.session.agentId)).toEqual(["new", "old"]);
    expect(index.search("postgres", { limit: 5, excludeAgentIds: ["new"] }).map((h) => h.session.agentId)).toEqual(["old"]);
  });

  it("returns a window around an anchor and the recent sessions", async () => {
    const source = new FakeTimelines();
    const sync = new SessionSync(index, source);
    for (let i = 0; i < 10; i += 1) source.push("a1", user(`message ${i}`));
    await sync.sync(meta("a1", "t"));
    expect(index.window("a1", 5, 4).map((m) => m.seq)).toEqual([3, 4, 5, 6]);
    expect(index.recent(5).map((s) => s.agentId)).toEqual(["a1"]);
  });

  it("backfills every listed agent", async () => {
    const source = new FakeTimelines();
    source.push("a1", user("alpha"));
    source.push("a2", user("beta"));
    source.agents = [meta("a1", "one"), meta("a2", "two")];
    const sync = new SessionSync(index, source);
    expect(await sync.backfill()).toBe(2);
    expect(index.stats()).toEqual({ sessions: 2, messages: 2 });
  });
});

describe("without FTS5", () => {
  it("still finds messages through LIKE", async () => {
    const plain = new SessionIndex(join(dir, "plain.db"), { fts: false });
    try {
      const source = new FakeTimelines();
      source.push("a1", user("rotate the staging certificates"), assistant("证书已轮换"));
      await new SessionSync(plain, source).sync(meta("a1", "certs"));
      expect(plain.fts).toBe(false);
      expect(plain.search("staging certificates", { limit: 5 }).length).toBe(1);
      expect(plain.search("证书", { limit: 5 })[0]!.anchor.role).toBe("assistant");
    } finally {
      plain.close();
    }
  });
});
