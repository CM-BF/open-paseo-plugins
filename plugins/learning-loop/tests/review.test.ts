import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateRow } from "../shared/contracts";
import { DEFAULT_PREFERENCES, type Preferences } from "../shared/settings";
import type { Exec } from "../server/kit/complete";
import { statePaths, type StatePaths } from "../server/paths";
import { ReviewEngine, type ReviewAgent, type RunContext } from "../server/review/engine";
import type { TimelineEntryLike } from "../server/sessions/transcript";

let root: string;
let paths: StatePaths;
let entries: TimelineEntryLike[];
let rows: Array<{ agentId: string; id: string; row: UpdateRow }>;
let runs: Map<string, RunContext>;
let calls: string[][];
let inputs: string[];
let prefs: Preferences;
let clock: Date;

const agent: ReviewAgent = { id: "a1", title: null, provider: "claude", cwd: "/repo", parentAgentId: null };

function push(at: string, ...items: AgentTimelineItem[]) {
  for (const item of items) {
    const seq = entries.length;
    entries.push({ item, timestamp: at, seqStart: seq, seqEnd: seq });
  }
}
const user = (text: string): AgentTimelineItem => ({ type: "user_message", text });
const tool = (): AgentTimelineItem => ({ type: "tool_call", callId: "c", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "ls" } });

/** A fake `claude -p`: records the call and "writes" one skill through the run context. */
const exec: Exec = async (argv, options) => {
  inputs.push(options.stdin);
  calls.push([...argv]);
  for (const run of runs.values()) run.changes.push("Skill demo: Created demo.");
  return { code: 0, stdout: JSON.stringify({ type: "result", result: "Saved one skill.", total_cost_usd: 0.01, modelUsage: { "claude-haiku-4-5": {} } }) };
};

function engine(customExec: Exec = exec): ReviewEngine {
  return new ReviewEngine({
    paths,
    settings: () => prefs,
    paseo: { config: { get: async () => ({ config: {} }) } },
    tail: async () => ({ epoch: "e1", entries }),
    appendRow: async (agentId, id, row) => {
      rows.push({ agentId, id, row });
    },
    project: async () => null,
    runs,
    title: async () => "Fixture agent",
    currentState: async () => '{"memory":[{"entry":"Uses fixture makefile","revision":"r-current"}]}',
    exec: customExec,
    now: () => clock,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ll-review-"));
  paths = statePaths(root);
  entries = [];
  rows = [];
  runs = new Map();
  calls = [];
  inputs = [];
  clock = new Date("2026-10-22T10:00:00Z");
  prefs = { ...DEFAULT_PREFERENCES, review: { ...DEFAULT_PREFERENCES.review, userTurns: 2, toolCalls: 5, cooldownMinutes: 10 } };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ReviewEngine", () => {
  it("does not review history from before the plugin started", async () => {
    push("2026-10-22T09:00:00Z", user("old"), user("old"), tool(), tool(), tool(), tool(), tool(), tool());
    const e = engine();
    await e.onTurnEnded(agent);
    await vi.waitFor(() => expect(calls.length).toBe(0));
    expect(rows).toEqual([]);
  });

  it("reviews after the threshold, writes a chat row, and resets the counts", async () => {
    const e = engine();
    push("2026-10-22T10:01:00Z", user("deploy it"), tool(), tool());
    await e.onTurnEnded(agent);
    expect(calls.length).toBe(0);
    push("2026-10-22T10:02:00Z", user("no, use make ship"), tool());
    await e.onTurnEnded(agent);
    await vi.waitFor(() => expect(rows.length).toBe(1));
    expect(rows[0]!.row).toMatchObject({ status: "updated", actions: ["Skill demo: Created demo."], costUsd: 0.01 });
    const argv = calls[0]!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toContain("mcp__learning__skill_manage");
    const [run] = await e.history(5);
    expect(run).toMatchObject({ agentTitle: "Fixture agent", status: "updated", trigger: "threshold" });

    // Counts were reset: one more turn does not trigger again, and the cooldown holds.
    push("2026-10-22T10:03:00Z", user("thanks"), tool(), tool(), tool(), tool(), tool());
    clock = new Date("2026-10-22T10:05:00Z");
    await e.onTurnEnded(agent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.length).toBe(1);
  });

  it("skips child agents unless configured, and runs a manual review with a running row first", async () => {
    const e = engine();
    push("2026-10-22T10:01:00Z", user("a"), user("b"), user("c"));
    await e.onTurnEnded({ ...agent, parentAgentId: "parent" });
    expect(calls.length).toBe(0);

    expect(e.runNow(agent).ok).toBe(true);
    await vi.waitFor(() => expect(rows.length).toBe(2));
    expect(rows[0]!.row.status).toBe("running");
    expect(rows[1]!.id).toBe(rows[0]!.id);
    expect(rows[1]!.row.status).toBe("updated");
  });

  it("records a failed run when the route is not Claude-family", async () => {
    prefs = { ...prefs, review: { ...prefs.review, provider: "codex" } };
    const e = engine();
    push("2026-10-22T10:01:00Z", user("a"));
    e.runNow(agent);
    await vi.waitFor(() => expect(rows.at(-1)?.row.status).toBe("failed"));
    expect(rows.at(-1)!.row.note).toMatch(/route unavailable/);
    expect(calls.length).toBe(0);
  });
});


describe("review evidence and budget limits", () => {
  it("includes current scoped memory/revisions and accepts Nothing to save, without repeating a manual digest", async () => {
    const noop: Exec = async (argv, options) => { calls.push([...argv]); inputs.push(options.stdin); return { code: 0, stdout: JSON.stringify({ type: "result", result: "Nothing to save.", total_cost_usd: 0.01 }) }; };
    const e = engine(noop);
    push("2026-10-22T10:01:00Z", user("An ordinary answer, no durable lesson."));
    expect(e.runNow(agent).ok).toBe(true);
    await vi.waitFor(() => expect(e.queuedCount()).toBe(0));
    expect(inputs[0]).toContain("Uses fixture makefile");
    expect(inputs[0]).toContain("r-current");
    expect(inputs[0]).not.toContain("missed learning opportunity");
    expect(rows.at(-1)?.row.status).toBe("nothing");
    expect(e.runNow(agent).ok).toBe(true);
    await vi.waitFor(() => expect(e.queuedCount()).toBe(0));
    expect(calls).toHaveLength(1);
    expect(rows.at(-1)?.row.note).toContain("No new conversation");
  });

  it("shares the host budget with curator and keeps the exact per-run cap", async () => {
    prefs = { ...prefs, review: { ...prefs.review, maxBudgetUsd: .2, dailyBudgetUsd: .2 } };
    const e = engine();
    await e.consolidate();
    expect(calls).toHaveLength(1);
    const argv = calls[0]!;
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("0.2");
    const again = await e.consolidate();
    expect(again.status).toBe("failed");
    expect(again.note).toContain("daily review budget reached");
    expect(calls).toHaveLength(1);
    expect(e.queuedCount()).toBe(0);
  });
});

it("rechecks curator limits when a queued run begins", async () => {
  let release: (() => void) | undefined;
  let entered = false;
  const delayed: Exec = async () => {
    entered = true;
    await new Promise<void>(resolve => { release = resolve; });
    return { code: 0, stdout: JSON.stringify({ type: "result", result: "Nothing to save.", total_cost_usd: .01 }) };
  };
  const e = engine(delayed);
  const first = e.consolidate();
  await vi.waitFor(() => expect(entered).toBe(true));
  const queued = e.consolidate();
  prefs = { ...prefs, review: { ...prefs.review, dailyBudgetUsd: 0 } };
  release!();
  await first;
  expect((await queued).note).toContain("daily review budget reached");
  expect(e.queuedCount()).toBe(0);
});
