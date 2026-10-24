import { afterEach, describe, expect, it } from "vitest";
import { runPaths } from "./paths";
import { ResumeCache } from "./run-store";
import { FakeRunner, ok, runScript, tempState } from "./test-harness";
import { rm } from "node:fs/promises";
import type { StatePaths } from "./paths";

const meta = "export const meta = { name: 'p', description: 'resume prefix' }\n";
const states: StatePaths[] = [];
afterEach(async () => { await Promise.all(states.splice(0).map((s) => rm(s.root, { recursive: true, force: true }))); });
async function state() { const s = await tempState(); states.push(s); return s; }
const echo = () => new FakeRunner((task) => ok("echo:" + task.prompt));

describe("resume reuses the longest unchanged prefix", () => {
  it("reruns an unchanged call that comes after an edited one", async () => {
    const s = await state();
    const first = await runScript(`${meta}return [await agent('a'), await agent('b'), await agent('c')]`, echo(), { state: s });
    const cache = await ResumeCache.load(runPaths(s, first.record.runId));
    const runner = echo();
    const second = await runScript(`${meta}return [await agent('a'), await agent('b2'), await agent('c')]`, runner, { state: s, cache });
    expect(second.result).toEqual(["echo:a", "echo:b2", "echo:c"]);
    expect(runner.tasks.map((t) => t.prompt)).toEqual(["b2", "c"]);
    expect(second.record.calls.map((c) => c.status)).toEqual(["cached", "completed", "completed"]);
    expect(second.record.logs.some((l) => /"b2" is new or edited/.test(l.message))).toBe(true);
  });

  it("reuses everything for an unchanged script regardless of completion order", async () => {
    const s = await state();
    const script = `${meta}return pipeline(['x', 'y', 'z'], v => agent('s1:' + v), (r, v) => agent('s2:' + v))`;
    const delays: Record<string, number> = { "s1:x": 40, "s1:y": 5, "s1:z": 20 };
    const slow = new FakeRunner(async (task) => { await new Promise((r) => setTimeout(r, delays[task.prompt] ?? 0)); return ok("r:" + task.prompt); });
    const first = await runScript(script, slow, { state: s });
    const cache = await ResumeCache.load(runPaths(s, first.record.runId));
    const runner = new FakeRunner(() => { throw new Error("must use the cache"); });
    const second = await runScript(script, runner, { state: s, cache });
    expect(second.result).toEqual(first.result);
    expect(runner.tasks).toHaveLength(0);
  });

  it("reruns a failed call without ending reuse for the calls after it", async () => {
    const s = await state();
    const script = `${meta}return [await agent('a'), await agent('b'), await agent('c')]`;
    const first = await runScript(script, new FakeRunner((t) => t.prompt === "b" ? { ok: false, error: "quota", skipped: false, worktree: null } : ok("1:" + t.prompt)), { state: s });
    const cache = await ResumeCache.load(runPaths(s, first.record.runId));
    const runner = new FakeRunner((t) => ok("2:" + t.prompt));
    const second = await runScript(script, runner, { state: s, cache });
    expect(second.result).toEqual(["1:a", "2:b", "1:c"]);
    expect(runner.tasks.map((t) => t.prompt)).toEqual(["b"]);
  });
});
