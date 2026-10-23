import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FallbackController, FALLBACK_MODEL, FALLBACK_THINKING } from "./controller";
import type { AgentSnapshot, DaemonAdapter, UsageReports } from "./daemon";
import { StateStore } from "./store";

const START = Date.parse("2026-10-22T17:00:00Z");
const main = { model: "gpt-6-astra", thinkingOptionId: "max" };
const failure = { kind: "failed" as const, error: { message: "Rate limit exceeded; try again in 10 minutes" } };
const quota = (usedPct: number, resetAt = START + 30 * 60_000): UsageReports => ({
  requestId: "usage", reports: [{ id: "codex:account", sourceId: "codex", sourceLabel: "Codex", account: {},
    fetchedAt: new Date(START).toISOString(), report: { status: "available", windows: [
      { id: "weekly", label: "Weekly", usedPct, resetsAt: new Date(resetAt).toISOString() },
    ] } }],
});

let dir: string;
let clock: number;
let current: AgentSnapshot | null;
let store: StateStore;
let controller: FallbackController;
let controllers: FallbackController[];
let adapter: ReturnType<typeof fakeAdapter>;

function fakeAdapter() {
  return {
    getAgent: vi.fn(async () => current ? structuredClone(current) : null),
    applySettings: vi.fn<DaemonAdapter["applySettings"]>(async (_id, settings) => {
      if (current) current = { ...current, ...settings };
    }),
    send: vi.fn<DaemonAdapter["send"]>(async () => {}),
    usage: vi.fn<DaemonAdapter["usage"]>(async () => quota(10)),
    timeline: vi.fn<DaemonAdapter["timeline"]>(),
    models: vi.fn<DaemonAdapter["models"]>(async () => ({
      provider: "codex", requestId: "models", fetchedAt: new Date(START).toISOString(), error: null,
      models: [{ provider: "codex", id: FALLBACK_MODEL, label: "GPT-6.1 Sol", thinkingOptions: [
        { id: FALLBACK_THINKING, label: "Ultra" },
      ] }],
    })),
    close: vi.fn<DaemonAdapter["close"]>(async () => {}),
  } satisfies DaemonAdapter;
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), "rate-fallback-controller-"));
  clock = START;
  current = { id: "one", provider: "codex", ...main, status: "error", archivedAt: null,
    activeTurn: null, pendingPermissions: [], lastError: "Rate limit exceeded", cwd: "/repo" };
  adapter = fakeAdapter();
  store = new StateStore(join(dir, "state.json"));
  await store.load();
  controller = new FallbackController(adapter, store, () => clock);
  controllers = [controller];
});
afterEach(async () => {
  await Promise.all(controllers.map((instance) => instance.close()));
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("automatic fallback", () => {
  it("leaves fork-owned backups to the cross-provider controller after a manual model change", async () => {
    current = { ...current!, labels: { "paseo-rate-fallback-owner": "claude-source" } };
    await controller.endedTurn("one", "t1", failure);
    expect(adapter.applySettings).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
    expect(store.state.agents).toEqual({});
  });

  it("persists the main settings before switching and resumes once", async () => {
    adapter.applySettings.mockImplementationOnce(async (_id, settings) => {
      const durable = new StateStore(store.path);
      await durable.load();
      expect(durable.state.agents.one?.main).toEqual(main);
      expect(durable.state.agents.one?.phase).toBe("switching");
      current = { ...current!, ...settings };
    });
    await controller.endedTurn("one", "t1", failure);
    expect(adapter.applySettings).toHaveBeenCalledWith("one", { model: FALLBACK_MODEL, thinkingOptionId: FALLBACK_THINKING });
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(store.state.agents.one).toMatchObject({ main, phase: "fallback", pendingResume: false, resetAt: START + 10 * 60_000 });
  });

  it("records a fresh main-model quota reset immediately when the failure has no reset time", async () => {
    const mainResetAt = START + 45 * 60_000;
    const usage: UsageReports = {
      requestId: "initial-usage",
      reports: [{
        id: "codex:account", sourceId: "codex", sourceLabel: "Codex", account: {},
        fetchedAt: new Date(START).toISOString(),
        report: { status: "available", windows: [
          { id: "five_hour", label: "5-hour", usedPct: 10 },
          { id: "limit:gpt-6-astra:weekly", label: "GPT-6 Astra · Weekly", usedPct: 100,
            resetsAt: new Date(mainResetAt).toISOString() },
          { id: "limit:gpt-6.1-sol:weekly", label: "GPT-6.1 Sol · Weekly", usedPct: 100,
            resetsAt: new Date(START + 90 * 60_000).toISOString() },
        ] },
      }],
    };
    adapter.usage.mockImplementationOnce(async () => {
      expect(adapter.send).toHaveBeenCalledTimes(1);
      expect(store.state.agents.one?.pendingResume).toBe(false);
      return usage;
    });

    await controller.endedTurn("one", "t1", { kind: "failed", error: { message: "Rate limit exceeded" } });

    expect(adapter.usage).toHaveBeenCalledExactlyOnceWith("one");
    expect(store.state.agents.one).toMatchObject({ phase: "fallback", resetAt: mainResetAt });
    const durable = new StateStore(store.path);
    await durable.load();
    expect(durable.state.agents.one?.resetAt).toBe(mainResetAt);
    clock += 5 * 60_000 + 5_001;
    await controller.tick();
    expect(adapter.usage).toHaveBeenCalledTimes(1);
    expect(adapter.applySettings).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent repeated events including turns without IDs", async () => {
    await Promise.all([
      controller.endedTurn("one", null, failure), controller.endedTurn("one", null, failure),
    ]);
    expect(adapter.applySettings).toHaveBeenCalledTimes(1);
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it.each(["completed", "canceled"] as const)("does not start fallback for a %s turn", async (kind) => {
    await controller.endedTurn("one", "t1", { kind, error: failure.error });
    expect(adapter.applySettings).not.toHaveBeenCalled();
    expect(store.state.agents).toEqual({});
  });

  it("ignores unrelated failures and agents already on the fallback", async () => {
    await controller.endedTurn("one", "t1", { kind: "failed", error: { message: "Network disconnected" } });
    current = { ...current!, model: FALLBACK_MODEL };
    controller.started("one");
    await controller.endedTurn("one", "t2", failure);
    expect(adapter.applySettings).not.toHaveBeenCalled();
  });
});

describe("restoration", () => {
  it("keeps fallback until the reset plus grace, then restores the original reasoning", async () => {
    await controller.endedTurn("one", "t1", failure);
    adapter.usage.mockClear();
    clock = START + 10 * 60_000;
    await controller.tick();
    expect(adapter.usage).not.toHaveBeenCalled();
    expect(adapter.applySettings).toHaveBeenCalledTimes(1);
    clock += 5_001;
    await controller.tick();
    expect(adapter.usage).toHaveBeenCalledWith("one");
    expect(adapter.applySettings).toHaveBeenLastCalledWith("one", main);
    expect(current).toMatchObject(main);
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(store.state.agents).toEqual({});
  });

  it.each(["running", "initializing", "active-turn", "permission"])("waits while the agent is %s", async (condition) => {
    await controller.endedTurn("one", "t1", failure);
    adapter.usage.mockClear();
    clock += 11 * 60_000;
    const idle = structuredClone(current!);
    if (condition === "running" || condition === "initializing") current!.status = condition;
    if (condition === "active-turn") current!.activeTurn = { turnId: "working", startedAt: new Date(clock).toISOString() };
    if (condition === "permission") current!.pendingPermissions = [{} as AgentSnapshot["pendingPermissions"][number]];
    await controller.tick();
    expect(adapter.applySettings).toHaveBeenCalledTimes(1);
    expect(adapter.usage).not.toHaveBeenCalled();
    current = idle;
    await controller.tick();
    expect(adapter.applySettings).toHaveBeenLastCalledWith("one", main);
  });

  it("keeps fallback if fresh usage still shows the main quota exhausted", async () => {
    await controller.endedTurn("one", "t1", failure);
    clock += 11 * 60_000;
    adapter.usage.mockResolvedValue(quota(100));
    await controller.tick();
    expect(adapter.applySettings).toHaveBeenCalledTimes(1);
    expect(store.state.agents.one?.resetAt).toBe(START + 30 * 60_000);
    clock = START + 30 * 60_000 + 5_001;
    adapter.usage.mockResolvedValue(quota(20));
    await controller.tick();
    expect(adapter.applySettings).toHaveBeenLastCalledWith("one", main);
    expect(store.state.agents).toEqual({});
  });

  it("relinquishes ownership after a manual model or reasoning change", async () => {
    await controller.endedTurn("one", "t1", failure);
    current!.thinkingOptionId = "high";
    clock += 11 * 60_000;
    await controller.tick();
    expect(adapter.applySettings).toHaveBeenCalledTimes(1);
    expect(current!.thinkingOptionId).toBe("high");
    expect(store.state.agents).toEqual({});
  });

  it("stops retrying when the fallback is also limited, then continues on the recovered main model", async () => {
    await controller.endedTurn("one", "t1", failure);
    controller.started("one");
    await controller.endedTurn("one", "t2", failure);
    expect(store.state.agents.one).toMatchObject({ phase: "blocked", pendingResume: true });
    expect(adapter.send).toHaveBeenCalledTimes(1);
    await controller.tick();
    expect(adapter.send).toHaveBeenCalledTimes(1);
    clock += 11 * 60_000;
    await controller.tick();
    expect(adapter.send).toHaveBeenCalledTimes(2);
    expect(adapter.applySettings).toHaveBeenLastCalledWith("one", main);
    expect(store.state.agents).toEqual({});
  });

  it("does not resume a user canceled turn when restoring the main model", async () => {
    await controller.endedTurn("one", "t1", failure);
    controller.started("one");
    await controller.endedTurn("one", "t2", { kind: "canceled" });
    clock += 11 * 60_000;
    await controller.tick();
    expect(adapter.applySettings).toHaveBeenLastCalledWith("one", main);
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(store.state.agents).toEqual({});
  });

  it("restores tracked agents when disabled and stops accepting new fallback events", async () => {
    await controller.endedTurn("one", "t1", failure);
    await controller.configure(false);
    expect(adapter.applySettings).toHaveBeenLastCalledWith("one", main);
    expect(store.state.agents).toEqual({});
    controller.started("one");
    await controller.endedTurn("one", "t2", failure);
    expect(adapter.applySettings).toHaveBeenCalledTimes(2);
  });

  it("loads persisted ownership after restart and restores without replaying accepted continuation", async () => {
    await controller.endedTurn("one", "t1", failure);
    await controller.close();
    const reloaded = new StateStore(store.path);
    await reloaded.load();
    const restarted = new FallbackController(adapter, reloaded, () => clock);
    controllers.push(restarted);
    await restarted.tick();
    expect(adapter.send).toHaveBeenCalledTimes(1);
    clock += 11 * 60_000;
    await restarted.tick();
    expect(adapter.applySettings).toHaveBeenLastCalledWith("one", main);
    expect(reloaded.state.agents).toEqual({});
  });
});

describe("failure recovery", () => {
  it("does not mutate the provider on retry while original settings cannot be persisted", async () => {
    const save = vi.spyOn(store, "save").mockRejectedValue(new Error("disk unavailable"));
    await expect(controller.endedTurn("one", "t1", failure)).rejects.toThrow("disk unavailable");
    expect(adapter.applySettings).not.toHaveBeenCalled();
    clock += 60_001;
    await expect(controller.tick()).rejects.toThrow("disk unavailable");
    expect(adapter.applySettings).not.toHaveBeenCalled();
    expect(current).toMatchObject(main);
    save.mockRestore();
    clock += 60_001;
    await controller.tick();
    expect(adapter.applySettings).toHaveBeenCalledTimes(1);
    expect(store.state.agents.one?.main).toEqual(main);
  });

  it("retries failed model discovery after original settings have been persisted", async () => {
    adapter.models.mockRejectedValueOnce(new Error("catalog temporarily offline"));
    await controller.endedTurn("one", "t1", failure);
    expect(store.state.agents.one?.main).toEqual(main);
    expect(adapter.applySettings).not.toHaveBeenCalled();
    clock += 60_001;
    await controller.tick();
    expect(adapter.applySettings).toHaveBeenCalledTimes(1);
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it("retries a failed settings request after the retry delay", async () => {
    adapter.applySettings.mockRejectedValueOnce(new Error("provider temporarily offline"));
    await controller.endedTurn("one", "t1", failure);
    expect(store.state.agents.one).toMatchObject({ main, phase: "switching", pendingResume: true });
    await controller.tick();
    expect(adapter.applySettings).toHaveBeenCalledTimes(1);
    clock += 60_001;
    await controller.tick();
    expect(adapter.applySettings).toHaveBeenCalledTimes(2);
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it("delays a failed continuation and reuses its idempotency key", async () => {
    adapter.send.mockRejectedValueOnce(new Error("response lost"));
    await controller.endedTurn("one", "t1", failure);
    const messageId = adapter.send.mock.calls[0]![2];
    expect(store.state.agents.one?.pendingResume).toBe(true);
    await controller.tick();
    expect(adapter.send).toHaveBeenCalledTimes(1);
    clock += 60_001;
    await controller.tick();
    expect(adapter.send).toHaveBeenCalledTimes(2);
    expect(adapter.send.mock.calls[1]![2]).toBe(messageId);
    expect(store.state.agents.one?.pendingResume).toBe(false);
  });

  it("finishes a partially applied fallback request without forgetting the original settings", async () => {
    adapter.applySettings.mockImplementationOnce(async (_id, settings) => {
      current!.model = settings.model;
      throw new Error("reasoning update failed after model changed");
    });
    await controller.endedTurn("one", "t1", failure);
    expect(current).toMatchObject({ model: FALLBACK_MODEL, thinkingOptionId: main.thinkingOptionId });
    clock += 60_001;
    await controller.tick();
    expect(current).toMatchObject({ model: FALLBACK_MODEL, thinkingOptionId: FALLBACK_THINKING });
    expect(store.state.agents.one?.main).toEqual(main);
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it("finishes a partially applied restore request before relinquishing ownership", async () => {
    await controller.endedTurn("one", "t1", failure);
    adapter.applySettings.mockImplementationOnce(async (_id, settings) => {
      current!.model = settings.model;
      throw new Error("reasoning restore failed after model changed");
    });
    clock += 11 * 60_000;
    await controller.tick();
    expect(current).toMatchObject({ model: main.model, thinkingOptionId: FALLBACK_THINKING });
    expect(store.state.agents.one?.phase).toBe("restoring");
    clock += 60_001;
    await controller.tick();
    expect(current).toMatchObject(main);
    expect(store.state.agents).toEqual({});
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it("retains a pending resume if the agent starts running immediately after settings change", async () => {
    adapter.applySettings.mockImplementationOnce(async (_id, settings) => {
      current = { ...current!, ...settings, status: "running" };
    });
    await controller.endedTurn("one", "t1", failure);
    expect(adapter.send).not.toHaveBeenCalled();
    expect(store.state.agents.one?.pendingResume).toBe(true);
    current!.status = "idle";
    await controller.tick();
    expect(adapter.send).toHaveBeenCalledTimes(1);
  });

  it("retains a blocked task's pending resume if the agent becomes busy during restoration", async () => {
    await controller.endedTurn("one", "t1", failure);
    controller.started("one");
    await controller.endedTurn("one", "t2", failure);
    adapter.applySettings.mockImplementationOnce(async (_id, settings) => {
      current = { ...current!, ...settings, status: "running" };
    });
    clock += 11 * 60_000;
    await controller.tick();
    expect(current).toMatchObject(main);
    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(store.state.agents.one).toMatchObject({ phase: "restoring", pendingResume: true });
    current!.status = "idle";
    await controller.tick();
    expect(adapter.send).toHaveBeenCalledTimes(2);
    expect(store.state.agents).toEqual({});
  });
});
