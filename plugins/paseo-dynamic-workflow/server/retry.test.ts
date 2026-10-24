import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import type { RunEngine } from "./engine";
import { FakeRunner, ok, runScript, tempState } from "./test-harness";
import type { StatePaths } from "./paths";

const states: StatePaths[] = [];
afterEach(async () => { await Promise.all(states.splice(0).map((s) => rm(s.root, { recursive: true, force: true }))); });
const meta = "export const meta = { name: 'r', description: 'retry' }\n";

it("restarts a stalled child and gives up after three attempts", async () => {
  const state = await tempState(); states.push(state);
  const seen: string[] = [];
  const runner = new FakeRunner((task) => {
    seen.push(task.callId);
    if (task.prompt === "flaky" && task.callId === "a1") return { ok: false, error: "stalled: no activity from the agent for 10 minutes", skipped: false, stalled: true, worktree: null };
    if (task.prompt === "dead") return { ok: false, error: "stalled: no activity from the agent for 10 minutes", skipped: false, stalled: true, worktree: null };
    return ok("done:" + task.prompt);
  });
  const { result, record } = await runScript(`${meta}return [await agent('flaky'), await agent('dead')]`, runner, { state });
  expect(result).toEqual(["done:flaky", null]);
  expect(seen).toEqual(["a1", "a1r2", "a2", "a2r2", "a2r3"]);
  expect(record.calls[0]).toMatchObject({ status: "completed", attempt: 2 });
  expect(record.calls[1]).toMatchObject({ status: "failed", attempt: 3, error: expect.stringMatching(/gave up after 3 attempts/) });
});

it("lets the user restart a running agent while the script keeps waiting", async () => {
  const state = await tempState(); states.push(state);
  let engine: RunEngine | null = null;
  const runner = new FakeRunner((task) => new Promise((resolve) => {
    if (task.callId === "a1") {
      task.signal.addEventListener("abort", () => resolve({ ok: false, error: String(task.signal.reason), skipped: true, worktree: null }), { once: true });
      setTimeout(() => engine?.restart("a1"), 20);
      return;
    }
    resolve(ok("second:" + task.callId));
  }));
  const { result, record } = await runScript(`${meta}return await agent('work')`, runner, { state, onEngine: (e) => { engine = e; } });
  expect(result).toBe("second:a1r2");
  expect(record.calls[0]).toMatchObject({ status: "completed", attempt: 2 });
  expect(record.logs.some((l) => /restarted by the user/.test(l.message))).toBe(true);
});
