import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForkStore, type ForkEntry } from "./fork-store";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "rate-fork-store-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function entry(): ForkEntry {
  return { mainAgentId: "source", mainProvider: "claude", mainModel: "claude-opus-4-6", mainThinking: "max",
    workspaceId: "workspace", cwd: "/repo", operationId: "operation", fallbackAgentId: "backup", phase: "fallback",
    resetAt: 1_800_000_000_000, nextCheckAt: 1_800_000_000_000, lastError: null,
    fallbackSent: true, returnSent: false, fallbackMessageId: "fork-message", returnMessageId: "return-message" };
}

describe("durable fork journal", () => {
  it("loads missing state and persists original signature, receipts, and private permissions", async () => {
    const file = join(directory, "private", "forks.json");
    const store = new ForkStore(file); store.loadSync();
    expect(store.state).toEqual({ version: 1, agents: {} });
    store.state.agents.source = entry(); await store.save();
    const reloaded = new ForkStore(file); reloaded.loadSync();
    expect(reloaded.state).toEqual(store.state);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "private"))).mode & 0o777).toBe(0o700);
  });

  it.each([
    "not json",
    JSON.stringify({ version: 2, agents: {} }),
    JSON.stringify({ version: 1, agents: { source: { ...entry(), phase: "invalid" } } }),
    JSON.stringify({ version: 1, agents: { source: { ...entry(), mainAgentId: "other" } } }),
    JSON.stringify({ version: 1, agents: { source: { ...entry(), operationId: null } } }),
  ])("rejects corrupt state without overwriting its recovery evidence", async (content) => {
    const file = join(directory, "forks.json"); await writeFile(file, content);
    expect(() => new ForkStore(file).loadSync()).toThrow();
    expect(await readFile(file, "utf8")).toBe(content);
  });

  it("serializes snapshots so later writes cannot be overwritten by earlier phases", async () => {
    const file = join(directory, "forks.json"); const store = new ForkStore(file);
    store.state.agents.source = { ...entry(), phase: "forking", fallbackAgentId: null, fallbackSent: false };
    const initial = store.save();
    store.state.agents.source = entry(); const handedOff = store.save();
    store.state.agents.source.phase = "returning";
    store.state.agents.source.returnSent = true; const returned = store.save();
    await Promise.all([initial, handedOff, returned]);
    const reloaded = new ForkStore(file); reloaded.loadSync();
    expect(reloaded.state.agents.source).toMatchObject({ phase: "returning", returnSent: true, fallbackAgentId: "backup" });
  });

  it("can save again after a filesystem failure while preserving the pending ownership", async () => {
    const blocked = join(directory, "blocked"); await writeFile(blocked, "file");
    const store = new ForkStore(join(blocked, "forks.json")); store.state.agents.source = entry();
    await expect(store.save()).rejects.toThrow();
    await rm(blocked); await store.save();
    const reloaded = new ForkStore(store.path); reloaded.loadSync();
    expect(reloaded.state.agents.source).toEqual(entry());
  });

  it.each([
    { source: { ...entry(), fallbackAgentId: "source" } },
    { source: { ...entry(), fallbackAgentId: null } },
    { source: entry(), other: { ...entry(), mainAgentId: "other", operationId: "second-operation" } },
    { source: entry(), other: { ...entry(), mainAgentId: "other", fallbackAgentId: "second-backup" } },
    { source: { ...entry(), fallbackAgentId: "other" },
      other: { ...entry(), mainAgentId: "other", fallbackAgentId: "second-backup", operationId: "second-operation" } },
  ])("rejects ambiguous or impossible backup ownership", async (agents) => {
    const file = join(directory, "forks.json");
    await writeFile(file, JSON.stringify({ version: 1, agents }));
    expect(() => new ForkStore(file).loadSync()).toThrow();
  });
});
