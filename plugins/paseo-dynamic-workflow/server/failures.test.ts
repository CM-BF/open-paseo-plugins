import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { FakeRunner, ok, runScript, tempState } from "./test-harness";
import type { StatePaths } from "./paths";

const states: StatePaths[] = [];
afterEach(async () => { await Promise.all(states.splice(0).map((s) => rm(s.root, { recursive: true, force: true }))); });

it("records rejected parallel and pipeline slots, collapsing identical messages", async () => {
  const state = await tempState(); states.push(state);
  const script = "export const meta = { name: 'f', description: 'failures' }\n" +
    "const a = await parallel([() => agent('x'), () => { throw new Error('thunk boom') }, () => 1])\n" +
    "const b = await pipeline([1, 2, 3, 4], (v) => { if (v > 1) throw new Error('same') ; return v })\n" +
    "return { a, b }";
  const { result, record } = await runScript(script, new FakeRunner((t) => ok("r:" + t.prompt)), { state });
  expect(result).toEqual({ a: ["r:x", null, 1], b: [1, null, null, null] });
  expect(record.failures).toEqual([
    { label: "parallel[1]", message: "thunk boom", count: 1 },
    { label: "pipeline[1]", message: "same", count: 3 },
  ]);
});
