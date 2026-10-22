import { afterEach, describe, expect, it } from "vitest";
import { runPaths, type StatePaths } from "./paths";
import { ResumeCache } from "./run-store";
import { cleanup, FakeRunner, meta, ok, runScript, tempState } from "./test-harness";

const states: StatePaths[] = [];
afterEach(async () => {
  for (const state of states.splice(0)) await cleanup(state);
});

async function run(script: string, runner: FakeRunner, options: Parameters<typeof runScript>[2] = {}) {
  const outcome = await runScript(script, runner, options);
  states.push(outcome.state);
  return outcome;
}

const echo = () => new FakeRunner((task) => ok(`echo:${task.prompt}`));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("RunEngine", () => {
  it("runs agent() and returns the script result", async () => {
    const runner = echo();
    const { record, result } = await run(`${meta()}const a = await agent('hello', { label: 'greet' })\nreturn { a, args }`, runner, {
      args: { n: 1 },
    });
    expect(record.status).toBe("completed");
    expect(result).toEqual({ a: "echo:hello", args: { n: 1 } });
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]).toMatchObject({ label: "greet", status: "completed", agentId: "child-a1" });
    expect(runner.tasks[0]?.parent.agentId).toBe("parent-1");
  });

  it("returns null from agent() when the agent fails, and keeps going", async () => {
    const runner = new FakeRunner((task) =>
      task.prompt === "bad" ? { ok: false, error: "boom", skipped: false, worktree: null } : ok(task.prompt),
    );
    const { record, result } = await run(`${meta()}return [await agent('good'), await agent('bad')]`, runner);
    expect(result).toEqual(["good", null]);
    expect(record.calls.map((call) => call.status)).toEqual(["completed", "failed"]);
    expect(record.logs.some((line) => line.message.includes("boom"))).toBe(true);
  });

  it("parallel() is a barrier that maps throwing thunks to null and rejects promises", async () => {
    const { result } = await run(
      `${meta()}const r = await parallel([() => agent('a'), () => { throw new Error('x') }, () => agent('c')])
let bad = null
try { await parallel([agent('p')]) } catch (e) { bad = e.message }
return { r, bad }`,
      echo(),
    );
    expect((result as { r: unknown[] }).r).toEqual(["echo:a", null, "echo:c"]);
    expect((result as { bad: string }).bad).toMatch(/expects functions, not a promise/);
  });

  it("pipeline() has no barrier between stages and passes (prev, original, index)", async () => {
    const order: string[] = [];
    const runner = new FakeRunner(async (task) => {
      if (task.prompt === "slow:1") await sleep(150);
      order.push(task.prompt);
      return ok(task.prompt);
    });
    const { result } = await run(
      `${meta()}return await pipeline([1, 2], n => agent('slow:' + n), (prev, original, index) => agent('next:' + original + ':' + index + ':' + prev))`,
      runner,
    );
    expect(result).toEqual(["next:1:0:slow:1", "next:2:1:slow:2"]);
    // Item 2 reached stage 2 before item 1 finished stage 1.
    expect(order.indexOf("next:2:1:slow:2")).toBeLessThan(order.indexOf("slow:1"));
  });

  it("pipeline() drops an item to null when a stage throws and skips its later stages", async () => {
    const runner = echo();
    const { result } = await run(
      `${meta()}return await pipeline(['a', 'b'], x => { if (x === 'b') throw new Error('no'); return x }, x => agent(x))`,
      runner,
    );
    expect(result).toEqual(["echo:a", null]);
    expect(runner.tasks.map((task) => task.prompt)).toEqual(["a"]);
  });

  it("groups agents by phase() and opts.phase", async () => {
    const { record } = await run(
      `${meta("p", "[{ title: 'Scan', detail: 'look' }, { title: 'Fix' }]")}phase('Scan')
await agent('one')
await agent('two', { phase: 'Other' })
phase('Fix')
await agent('three')
log('done')`,
      echo(),
    );
    expect(record.calls.map((call) => call.phase)).toEqual(["Scan", "Other", "Fix"]);
    expect(record.phaseOrder).toEqual(["Scan", "Fix", "Other"]);
    expect(record.logs.map((line) => line.message)).toContain("done");
  });

  it("enforces determinism at runtime, too", async () => {
    const { record } = await run(`${meta()}const D = globalThis['Da' + 'te']\nreturn D['n' + 'ow']()`, echo());
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/Date.now\(\) is unavailable/);
  });

  it("has no Node.js API", async () => {
    const { result } = await run(`${meta()}return [typeof require, typeof process, typeof setTimeout, typeof fetch]`, echo());
    expect(result).toEqual(["undefined", "undefined", "function", "undefined"]);
  });

  it("validates agent() options and schemas before starting an agent", async () => {
    const runner = echo();
    const { result } = await run(
      `${meta()}const errors = []
for (const opts of [{ effort: 'huge' }, { isolation: 'sandbox' }, { schema: { type: 'array' } }, { label: 5 }]) {
  try { await agent('x', opts) } catch (e) { errors.push(e.message) }
}
return errors`,
      runner,
    );
    expect(result).toHaveLength(4);
    expect(runner.tasks).toHaveLength(0);
  });

  it("caps concurrency", async () => {
    const runner = new FakeRunner(async (task) => {
      await sleep(30);
      return ok(task.prompt);
    });
    await run(`${meta()}return await parallel(Array.from({ length: 10 }, (_, i) => () => agent('t' + i)))`, runner, { concurrency: 3 });
    expect(runner.maxActive).toBe(3);
    expect(runner.tasks).toHaveLength(10);
  });

  it("throws once the agent cap is reached", async () => {
    const { result } = await run(
      `${meta()}const out = []
for (let i = 0; i < 4; i++) { try { out.push(await agent('t' + i)) } catch (e) { out.push('cap') } }
return out`,
      echo(),
      { maxAgents: 2 },
    );
    expect(result).toEqual(["echo:t0", "echo:t1", "cap", "cap"]);
  });

  it("stops agent() once the token budget is spent and exposes budget to the script", async () => {
    const runner = new FakeRunner((task, progress) => {
      progress.usage({ inputTokens: 10, outputTokens: 600, costUsd: 0 });
      return ok(task.prompt);
    });
    const { result, record } = await run(
      `${meta()}const seen = []
while (budget.total && budget.remaining() > 0) {
  try { await agent('more') } catch (e) { seen.push(e.message); break }
  seen.push(budget.spent())
}
return seen`,
      runner,
      { budgetTotal: 1000 },
    );
    expect(result).toEqual([600, 1200]);
    expect(record.usage.outputTokens).toBe(1200);
  });

  it("resumes from cached results by prompt and options, whatever the label", async () => {
    const cache = new ResumeCache();
    const { callKey } = await import("./run-store");
    cache.add(callKey("a", {}), "cached-a");
    const runner = echo();
    const { result, record } = await run(`${meta()}return [await agent('a', { label: 'renamed' }), await agent('b')]`, runner, { cache });
    expect(result).toEqual(["cached-a", "echo:b"]);
    expect(record.calls.map((call) => call.status)).toEqual(["cached", "completed"]);
    expect(runner.tasks.map((task) => task.prompt)).toEqual(["b"]);
  });

  it("writes a journal that a resumed run can load", async () => {
    const state = await tempState();
    states.push(state);
    const first = await runScript(`${meta()}return [await agent('x'), await agent('y')]`, echo(), { state });
    const cache = await ResumeCache.load(runPaths(state, first.record.runId));
    expect(cache.size).toBe(2);
    const runner = echo();
    const second = await runScript(`${meta()}return [await agent('x'), await agent('z')]`, runner, { state, cache });
    expect(second.result).toEqual(["echo:x", "echo:z"]);
    expect(runner.tasks.map((task) => task.prompt)).toEqual(["z"]);
  });

  it("runs a nested workflow() with its own args and phase group", async () => {
    const nested = { child: `${meta("child")}phase('Inner')\nreturn await agent('in:' + args.x)` };
    const { result, record } = await run(`${meta()}return await workflow('child', { x: 7 })`, echo(), { nested });
    expect(result).toBe("echo:in:7");
    expect(record.calls[0]?.phase).toBe("child › Inner");
  });

  it("forbids a second nesting level", async () => {
    const nested = { child: `${meta("child")}return await workflow('child')` };
    const { record } = await run(`${meta()}return await workflow('child')`, echo(), { nested });
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/one level/);
  });

  it("stop() ends the run, skips running agents and makes agent() throw", async () => {
    let engineRef: import("./engine").RunEngine | undefined;
    const runner = new FakeRunner(
      (task) =>
        new Promise((resolve) => {
          task.signal.addEventListener("abort", () => resolve({ ok: false, error: "stopped", skipped: true, worktree: null }));
          if (task.prompt === "go") setTimeout(() => void engineRef?.stop("stopped by test"), 50);
        }),
    );
    const { record } = await run(`${meta()}await parallel([() => agent('go'), () => agent('other')])\nreturn 'unreachable'`, runner, {
      onEngine: (engine) => {
        engineRef = engine;
      },
    });
    expect(record.status).toBe("stopped");
    expect(record.error).toBe("stopped by test");
    expect(record.calls.every((call) => call.status === "skipped")).toBe(true);
  });

  it("skip() makes one agent() return null", async () => {
    let engineRef: import("./engine").RunEngine | undefined;
    const runner = new FakeRunner(
      (task) =>
        new Promise((resolve) => {
          if (task.prompt === "slow") {
            task.signal.addEventListener("abort", () => resolve({ ok: false, error: "skipped by the user", skipped: true, worktree: null }));
            setTimeout(() => engineRef?.skip(task.callId), 30);
          } else resolve(ok(task.prompt));
        }),
    );
    const { result, record } = await run(`${meta()}return [await agent('slow'), await agent('fast')]`, runner, {
      onEngine: (engine) => {
        engineRef = engine;
      },
    });
    expect(result).toEqual([null, "fast"]);
    expect(record.calls[0]?.status).toBe("skipped");
  });

  it("reports script errors with the script line", async () => {
    const { record } = await run(`${meta()}const x = 1\nnull.boom\n`, echo());
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/TypeError/);
    expect(record.error).toMatch(/test\.workflow\.js:3/);
  });

  it("unwraps a promise returned without await", async () => {
    const { result } = await run(`${meta()}return agent('x')`, echo());
    expect(result).toBe("echo:x");
  });

  it("fails a script stuck in a synchronous loop and ends its worker", async () => {
    const { record } = await run(`${meta()}await agent('first')\nwhile (true) {}`, echo(), { watchdog: { heartbeatMs: 100, stuckMs: 600 } });
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/synchronous loop/);
  });
});
