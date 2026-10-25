import { afterEach, describe, expect, it } from "vitest";
import { runPaths } from "./paths";
import { ResumeCache } from "./run-store";
import { FakeRunner, ok, runScript, tempState } from "./test-harness";
import { readFile, rm, writeFile } from "node:fs/promises";
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
    expect(second.record.logs.some((l) => /"b2" has no reusable result/.test(l.message))).toBe(true);
  });

  it("reuses everything for an unchanged script regardless of completion order", async () => {
    const s = await state();
    const script = `${meta}return parallel([() => agent('s1:x'), () => agent('s1:y'), () => agent('s1:z')])`;
    const delays: Record<string, number> = { "s1:x": 40, "s1:y": 5, "s1:z": 20 };
    const slow = new FakeRunner(async (task) => { await new Promise((r) => setTimeout(r, delays[task.prompt] ?? 0)); return ok("r:" + task.prompt); });
    const first = await runScript(script, slow, { state: s });
    const cache = await ResumeCache.load(runPaths(s, first.record.runId));
    const runner = new FakeRunner(() => { throw new Error("must use the cache"); });
    const second = await runScript(script, runner, { state: s, cache });
    expect(second.result).toEqual(first.result);
    expect(runner.tasks).toHaveLength(0);
  });

  it("reruns a failed call and all later calls", async () => {
    const s = await state();
    const script = `${meta}return [await agent('a'), await agent('b'), await agent('c')]`;
    const first = await runScript(script, new FakeRunner((t) => t.prompt === "b" ? { ok: false, error: "quota", skipped: false, worktree: null } : ok("1:" + t.prompt)), { state: s });
    const cache = await ResumeCache.load(runPaths(s, first.record.runId));
    const runner = new FakeRunner((t) => ok("2:" + t.prompt));
    const second = await runScript(script, runner, { state: s, cache });
    expect(second.result).toEqual(["1:a", "2:b", "2:c"]);
    expect(runner.tasks.map((t) => t.prompt)).toEqual(["b", "c"]);
  });
});

describe("resume chains", () => {
  it("fills positions a stopped-early resume never reached from the run before it", async () => {
    const s = await state();
    const script = `${meta}return [await agent('a'), await agent('b'), await agent('c')]`;
    const first = await runScript(script, echo(), { state: s });
    const middle = await runScript(`${meta}const a = await agent('a'); throw new Error('early')`, echo(), { state: s, cache: await ResumeCache.load(runPaths(s, first.record.runId)) });
    expect(middle.record.status).toBe("failed");
    const runner = echo();
    const cache = await ResumeCache.load([runPaths(s, middle.record.runId), runPaths(s, first.record.runId)]);
    const last = await runScript(script, runner, { state: s, cache });
    expect(last.result).toEqual(["echo:a", "echo:b", "echo:c"]);
    expect(runner.tasks).toHaveLength(0);
  });
});


describe("resume invocation history", () => {
  it.each([
    ["reorder", ["b", "a", "c"]],
    ["delete", ["a", "c"]],
    ["duplicate", ["a", "a", "b", "c"]],
  ])("invalidates the suffix after a %s", async (_change, prompts) => {
    const s = await state();
    const first = await runScript(`${meta}return [await agent('a'), await agent('b'), await agent('c')]`, echo(), { state: s });
    const runner = echo();
    const script = `${meta}return [${prompts.map((p) => `await agent(${JSON.stringify(p)})`).join(",")}]`;
    const second = await runScript(script, runner, { state: s, cache: await ResumeCache.load(runPaths(s, first.record.runId)) });
    expect(second.record.calls.map((c) => c.status)).toEqual(prompts.map((_p, i) => i === 0 && prompts[0] === "a" ? "cached" : "completed"));
  });

  it("does not fill a changed resume suffix with an older result at the same position", async () => {
    const s = await state();
    const first = await runScript(`${meta}return [await agent('a'), await agent('b'), await agent('c')]`, echo(), { state: s });
    const middle = await runScript(`${meta}await agent('a'); await agent('changed'); throw new Error('early')`, echo(), { state: s, cache: await ResumeCache.load(runPaths(s, first.record.runId)) });
    const runner = echo();
    const last = await runScript(`${meta}return [await agent('a'), await agent('changed'), await agent('c')]`, runner, { state: s, cache: await ResumeCache.load([runPaths(s, middle.record.runId), runPaths(s, first.record.runId)]) });
    expect(last.record.calls.map((c) => c.status)).toEqual(["cached", "cached", "completed"]);
    expect(runner.tasks.map((t) => t.prompt)).toEqual(["c"]);
  });
});


it("reruns an interrupted invocation without discarding later completed results", async () => {
  const s = await state();
  const script = `${meta}return parallel([() => agent('a'), () => agent('b'), () => agent('c')])`;
  const first = await runScript(script, echo(), { state: s });
  const journal = runPaths(s, first.record.runId).journal;
  const lines = (await readFile(journal, "utf8")).trim().split("\n").filter((line) => {
    const entry = JSON.parse(line);
    return !(entry.type === "agent_completed" && entry.callId === "a2");
  });
  await writeFile(journal, lines.join("\n") + "\n");
  const runner = echo();
  const second = await runScript(script, runner, { state: s, cache: await ResumeCache.load(runPaths(s, first.record.runId)) });
  expect(second.record.calls.map((c) => c.status)).toEqual(["cached", "completed", "cached"]);
  expect(runner.tasks.map((t) => t.prompt)).toEqual(["b"]);
});

it("does not duplicate same-key slots while loading a chain of legacy journals", async () => {
  const s = await state();
  const script = `${meta}return parallel([() => agent('same'), () => agent('same')])`;
  const older = await runScript(script, new FakeRunner((t) => ok('old:' + t.callId)), { state: s });
  const newer = await runScript(script, new FakeRunner((t) => ok('new:' + t.callId)), { state: s });
  for (const result of [older, newer]) {
    const path = runPaths(s, result.record.runId).journal;
    const lines = (await readFile(path, 'utf8')).trim().split('\n').filter((line) => JSON.parse(line).type !== 'agent_started');
    await writeFile(path, lines.join('\n') + '\n');
  }
  const cache = await ResumeCache.load([runPaths(s, newer.record.runId), runPaths(s, older.record.runId)]);
  const { callKey } = await import('./run-store');
  const key = callKey('same', {});
  expect(cache.size).toBe(2);
  expect(cache.take(key)).toMatchObject({ hit: true, value: 'new:a1' });
  expect(cache.take(key)).toMatchObject({ hit: true, value: 'new:a2' });
  expect(cache.take(key)).toEqual({ hit: false });
});

it("keeps the original child agent linked on cached calls", async () => {
  const s = await state();
  const script = `${meta}return await agent('a')`;
  const first = await runScript(script, echo(), { state: s });
  const second = await runScript(script, echo(), { state: s, cache: await ResumeCache.load(runPaths(s, first.record.runId)) });
  expect(second.record.calls[0]).toMatchObject({ status: "cached", agentId: "child-a1", provider: "claude", model: "claude-test" });
});
