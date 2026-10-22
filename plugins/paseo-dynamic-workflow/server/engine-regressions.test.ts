import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentOutcome } from "./agent-runner";
import { MAX_ITEMS } from "./engine";
import { runPaths, type StatePaths } from "./paths";
import { ResumeCache } from "./run-store";
import { cleanup, FakeRunner, meta, ok, runScript, tempState, type RunOptions } from "./test-harness";

const states: StatePaths[] = [];
afterEach(async () => {
  for (const state of states.splice(0)) await cleanup(state);
});

async function run(body: string, runner = new FakeRunner((task) => ok(task.prompt)), options: RunOptions = {}) {
  const state = options.state ?? await tempState();
  if (!states.includes(state)) states.push(state);
  return runScript(meta() + body, runner, { ...options, state });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runtime regression contracts", () => {
  it("does not start queued agents after the output budget is spent", async () => {
    const runner = new FakeRunner(async (task, progress) => {
      await wait(20);
      progress.usage({ inputTokens: 0, outputTokens: 600, costUsd: 0 });
      return ok(task.prompt);
    });
    const { result, record } = await run("return parallel(['a', 'b', 'c'].map(x => () => agent(x)))", runner, { concurrency: 1, budgetTotal: 500 });
    expect(result).toEqual(["a", null, null]);
    expect(runner.tasks.map((task) => task.prompt)).toEqual(["a"]);
    expect(record.calls.slice(1).every((call) => call.status === "failed" && call.error?.includes("token budget"))).toBe(true);
  });

  it("drops null pipeline items and null stage results before later stages", async () => {
    const runner = new FakeRunner((task) => task.prompt === "bad" ? { ok: false, error: "failed", skipped: false, worktree: null } : ok(task.prompt));
    const { result } = await run("return pipeline([null, 'bad', 'good'], x => agent(x), x => agent('next:' + x))", runner);
    expect(result).toEqual([null, null, "next:good"]);
    expect(runner.tasks.map((task) => task.prompt)).toEqual(["bad", "good", "next:good"]);
  });

  it("rejects configuration/schema failures while combinators drop their items", async () => {
    const runner = new FakeRunner(task => task.prompt === "bad"
      ? { ok: false, throws: true, error: "invalid configuration", skipped: false, worktree: null }
      : ok(task.prompt));
    const bare = await run("await agent('bad'); return 'unreachable'", runner);
    expect(bare.record.status).toBe("failed");
    expect(bare.record.error).toContain("invalid configuration");
    const combined = await run("return [await parallel([() => agent('bad')]), await pipeline(['bad'], x => agent(x), x => agent('later'))]", runner);
    expect(combined.result).toEqual([[null], [null]]);
    expect(runner.tasks.every(task => task.prompt === "bad")).toBe(true);
  });

  it("allows local API names and applies strict mode to the body", async () => {
    const { result } = await run("const args = 'local'; let log = []; class workflow {}\nlet error; try { accidentalGlobal = 1 } catch (e) { error = e.name }\nreturn { args, log, cls: typeof workflow, error }");
    expect(result).toEqual({ args: "local", log: [], cls: "function", error: "ReferenceError" });
  });

  it("preserves same-key invocation order and worktree metadata through resume", async () => {
    const worktree = { path: "/tmp/worktree-test", branch: "sw/fix", workspaceId: "ws-worktree", changed: true };
    const runner = new FakeRunner(async (task) => {
      if (task.callId === "a1") await wait(30);
      return { ok: true, value: task.callId, worktree };
    });
    const script = "return parallel([() => agent('same', { isolation: 'worktree' }), () => agent('same', { isolation: 'worktree' })])";
    const first = await run(script, runner);
    const cache = await ResumeCache.load(runPaths(first.state, first.record.runId));
    const secondRunner = new FakeRunner(() => { throw new Error("must use cache"); });
    const second = await run(script, secondRunner, { state: first.state, cache });
    expect(first.result).toEqual(["a1", "a2"]);
    expect(second.result).toEqual(first.result);
    expect(second.record.calls.map((call) => call.worktree)).toEqual([worktree, worktree]);
    expect(secondRunner.tasks).toHaveLength(0);
  });

  it("rejects nesting through globalThis and gives child args their own global", async () => {
    const nested = {
      child: meta("child") + "return { args: globalThis.args, kind: typeof setTimeout, nested: await globalThis.workflow('child').catch(e => e.message) }",
    };
    const { result } = await run("return workflow('child', { n: 2 })", undefined, { args: { n: 1 }, nested });
    expect(result).toEqual({ args: { n: 2 }, kind: "function", nested: expect.stringMatching(/one level/) });
  });

  it.each([
    "Object.getPrototypeOf(new Date(0)).constructor.now()",
    "new Intl.DateTimeFormat().format()",
    "new Intl.DateTimeFormat().formatToParts(undefined)",
  ])("blocks nondeterminism through %s", async (expression) => {
    const { record } = await run("return " + expression);
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/unavailable.*resume/);
  });

  it("keeps explicit Date and Intl arguments usable", async () => {
    const { result } = await run("return [new Date(0).toISOString(), typeof new Intl.DateTimeFormat('en').format(0)]");
    expect(result).toEqual(["1970-01-01T00:00:00.000Z", "string"]);
  });

  it("provides numeric timers, supports clearTimeout and contains callback errors", async () => {
    const { result, record } = await run("let fired = false; const timer = setTimeout(() => { fired = true }, 1); clearTimeout(String(timer));\nsetTimeout(() => { throw new Error('callback boom') }, 1);\nawait new Promise(r => setTimeout(r, '20')); return { fired, type: typeof timer }");
    expect(result).toEqual({ fired: false, type: "number" });
    expect(record.logs.some((line) => line.message.includes("callback boom"))).toBe(true);
  });

  it("stops a script waiting on a long timer promptly", async () => {
    const started = Date.now();
    const { record } = await run("await new Promise(r => setTimeout(r, 60_000)); return 'late'", undefined, {
      onEngine: (engine) => setTimeout(() => void engine.stop("timer test"), 40),
    });
    expect(record.status).toBe("stopped");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("lets a queued skip resolve before the occupied slot frees", async () => {
    let releaseFirst: ((value: AgentOutcome) => void) | undefined;
    let skipped = false;
    const runner = new FakeRunner((task) => {
      if (task.prompt === "first") return new Promise<AgentOutcome>((resolve) => { releaseFirst = resolve; });
      releaseFirst?.(ok("first"));
      return ok(task.prompt);
    });
    const { result, record } = await run("const first = agent('first'); await agent('queued'); log('skip returned'); return [await first, await agent('last')]", runner, {
      concurrency: 1,
      onChange: (engine) => {
        const queued = engine.record.calls.find((call) => call.label === "queued" && call.status === "queued");
        if (queued && !skipped) {
          skipped = true;
          queueMicrotask(() => engine.skip(queued.callId));
        }
        if (engine.record.logs.some((line) => line.message === "skip returned")) releaseFirst?.(ok("first"));
      },
    });
    expect(result).toEqual(["first", "last"]);
    expect(record.calls[1]?.status).toBe("skipped");
    expect(runner.tasks.map((task) => task.prompt)).toEqual(["first", "last"]);
  });

  it("ends log and phase floods with the watchdog and keeps the journal bounded", async () => {
    for (const body of ["while (true) log('x'.repeat(100_000))", "while (true) phase('flood')"]) {
      const { record, engine } = await run(body, undefined, { watchdog: { heartbeatMs: 40, stuckMs: 250 } });
      expect(record.status).toBe("failed");
      expect(record.error).toMatch(/synchronous loop/);
      const journal = await readFile(engine.files.paths.journal, "utf8");
      expect(journal.length).toBeLessThan(250_000);
      const finalized = await readFile(engine.files.paths.run, "utf8");
      await wait(30);
      expect(await readFile(engine.files.paths.journal, "utf8")).toBe(journal);
      expect(await readFile(engine.files.paths.run, "utf8")).toBe(finalized);
    }
  });

  it("summarizes dropped events and bounds journal log lines before writing", async () => {
    const { record, engine } = await run("for (let i = 0; i < 500; i++) log('x'.repeat(100_000)); return 1");
    expect(record.logs).toHaveLength(101);
    expect(record.logs[100]?.message).toContain("Suppressed 400");
    const entries = (await readFile(engine.files.paths.journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.type === "log").every(entry => entry.message.length <= 2000)).toBe(true);
  });

  it("counts final partial usage during child cleanup without reviving its status", async () => {
    const runner = new FakeRunner((task, progress) => new Promise(resolve => {
      task.signal.addEventListener("abort", () => setTimeout(() => {
        progress.status("running");
        progress.usage({ inputTokens: 5, outputTokens: 7, costUsd: 1 });
        resolve(ok("too late"));
      }, 30), { once: true });
    }));
    const { record } = await run("await agent('slow')", runner, {
      onChange: engine => { if (engine.record.calls[0]?.status === "running") queueMicrotask(() => void engine.stop("late progress")); },
    });
    expect(record.status).toBe("stopped");
    expect(record.calls[0]?.status).toBe("skipped");
    expect(record.usage.outputTokens).toBe(7);
    expect(record.calls[0]?.usage.outputTokens).toBe(7);
  });

  it("freezes usage when child cleanup exceeds the deadline and the run finishes", async () => {
    let reportLateUsage: (() => void) | undefined;
    const runner = new FakeRunner((_task, progress) => {
      reportLateUsage = () => progress.usage({ inputTokens: 5, outputTokens: 7, costUsd: 1 });
      return new Promise(() => undefined);
    });
    const { record } = await run("await agent('slow')", runner, {
      onChange: engine => { if (engine.record.calls[0]?.status === "running") queueMicrotask(() => void engine.stop("late usage")); },
    });
    expect(record.status).toBe("stopped");
    reportLateUsage?.();
    expect(record.usage.outputTokens).toBe(0);
    expect(record.calls[0]?.usage.outputTokens).toBe(0);
  });

  it("caps forgot-await request floods before they can swamp the host", async () => {
    const runner = new FakeRunner(() => new Promise(() => undefined));
    const { record } = await run("while (true) agent('loop')", runner, { watchdog: { heartbeatMs: 40, stuckMs: 250 }, maxAgents: 2 });
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/request limit|synchronous loop/);
    expect(record.calls.length).toBeLessThanOrEqual(2);
  });

  it("waits for the async finish callback before finished resolves", async () => {
    let callbackDone = false;
    await run("return 1", undefined, { onFinished: async () => { await wait(20); callbackDone = true; } });
    expect(callbackDone).toBe(true);
  });

  it("supports Claude's 4096-item combinator limit without starting agents", async () => {
    const { result } = await run("return (await pipeline(Array.from({length: 4096}, (_, i) => i), x => x)).length");
    expect(MAX_ITEMS).toBe(4096);
    expect(result).toBe(4096);
  });
});
