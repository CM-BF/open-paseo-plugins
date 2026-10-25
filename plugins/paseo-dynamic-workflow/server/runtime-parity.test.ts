import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { FakeRunner, ok, runScript, tempState } from "./test-harness";
import type { StatePaths } from "./paths";

const states: StatePaths[] = [];
afterEach(async () => { await Promise.all(states.splice(0).map((s) => rm(s.root, { recursive: true, force: true }))); });
const meta = "export const meta = { name: 'rt', description: 'runtime parity' }\n";
async function go(body: string) {
  const state = await tempState(); states.push(state);
  const runner = new FakeRunner((t) => ok("r:" + t.prompt));
  return { ...(await runScript(meta + body, runner, { state })), runner };
}

it("converts non-string prompts, labels and phase titles like the built-in, and labels by prompt", async () => {
  const { result, runner, record } = await go("phase(2)\nconsole.warn('a', { b: 1 }, 3)\nconst r = await agent(123)\nawait agent('x'.repeat(80))\nreturn r");
  expect(result).toBe("r:123");
  expect(record.phaseOrder).toContain("2");
  expect(record.logs.some((l) => l.message === '[warn] a {"b":1} 3')).toBe(true);
  expect(runner.tasks[1]!.label).toBe("x".repeat(60));
});

it("fails a run whose result is a function, and points Math.random at sampling by index", async () => {
  expect((await go("return () => 1")).record.error).toMatch(/cannot be a function/);
  const r = await go("let m; try { (0, Math)['ran' + 'dom']() } catch (e) { m = e.message } return m");
  expect(r.result).toMatch(/put the index in the agent label or prompt/);
});
