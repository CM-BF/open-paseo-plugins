import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore, type FallbackEntry } from "./store";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "rate-fallback-store-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function entry(): FallbackEntry {
  return { agentId: "one", main: { model: "gpt-6-astra", thinkingOptionId: "max" },
    phase: "switching", resetAt: null, nextCheckAt: 1_000, lastError: null,
    pendingResume: true, messageId: "stable-resume-id" };
}

describe("durable fallback state", () => {
  it("initializes missing state and durably reloads original settings plus continuation identity", async () => {
    const file = join(dir, "nested", "state.json");
    const store = new StateStore(file);
    await store.load();
    expect(store.state).toEqual({ version: 1, enabled: true, agents: {} });
    store.state.enabled = false;
    store.state.agents.one = entry();
    await store.save();
    const restarted = new StateStore(file);
    await restarted.load();
    expect(restarted.state).toEqual(store.state);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it.each([
    "not JSON",
    JSON.stringify({ version: 99, enabled: true, agents: {} }),
    JSON.stringify({ version: 1, enabled: true, agents: { one: { ...entry(), main: {} } } }),
    JSON.stringify({ version: 1, enabled: true, agents: { one: { ...entry(), phase: "unknown" } } }),
    JSON.stringify({ version: 1, enabled: true, agents: { one: { ...entry(), agentId: "another-agent" } } }),
  ])("rejects invalid persisted state instead of replacing saved ownership", async (content) => {
    const file = join(dir, "state.json");
    await writeFile(file, content);
    await expect(new StateStore(file).load()).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(content);
  });

  it("serializes concurrent save snapshots so the newest state wins", async () => {
    const file = join(dir, "state.json");
    const store = new StateStore(file);
    store.state.agents.one = entry();
    const first = store.save();
    store.state.agents.one.phase = "fallback";
    const second = store.save();
    store.state.agents.one.pendingResume = false;
    const third = store.save();
    await Promise.all([first, second, third]);
    const restarted = new StateStore(file);
    await restarted.load();
    expect(restarted.state.agents.one).toMatchObject({ phase: "fallback", pendingResume: false, main: entry().main });
  });

  it("permits a later save after a filesystem failure has been corrected", async () => {
    const parent = join(dir, "blocked");
    await writeFile(parent, "not a directory");
    const store = new StateStore(join(parent, "state.json"));
    store.state.agents.one = entry();
    await expect(store.save()).rejects.toThrow();
    await rm(parent);
    await store.save();
    const restarted = new StateStore(store.path);
    await restarted.load();
    expect(restarted.state.agents.one).toEqual(entry());
  });
});
