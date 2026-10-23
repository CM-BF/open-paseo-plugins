import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_MODEL, FALLBACK_THINKING } from "./controller";
import { ForkController } from "./fork-controller";
import { ForkStore } from "./fork-store";
import {
  FALLBACK_OPERATION_LABEL, FALLBACK_OWNER_LABEL, type AgentSnapshot, type ForkAttachment,
  type ForkDaemonAdapter, type TimelinePage, type UsageReports,
} from "./daemon";

const START = Date.parse("2026-10-22T17:00:00Z");
const RESET = START + 10 * 60_000;
const failure = { kind: "failed" as const, error: { message: "You've hit your session limit. Try again in 10 minutes" } };
const mainSettings = { provider: "claude", model: "claude-opus-4-6", thinkingOptionId: "max" };

function quota(usedPct = 10, resetAt = RESET): UsageReports {
  return { requestId: "quota", reports: [{ id: "claude:account", sourceId: "claude", sourceLabel: "Claude",
    account: {}, fetchedAt: new Date(START).toISOString(), report: { status: "available", windows: [
      { id: "five_hour", label: "Session", usedPct, resetsAt: new Date(resetAt).toISOString() },
    ] } }] };
}

let directory: string;
let clock: number;
let enabled: boolean;
let agents: Map<string, AgentSnapshot>;
let adapter: ReturnType<typeof fakeAdapter>;
let controller: ForkController;
let controllers: ForkController[];
let store: ForkStore;
let births: number;
let notify: ReturnType<typeof vi.fn>;

function source(): AgentSnapshot {
  return { id: "source", ...mainSettings, status: "error", workspaceId: "workspace", cwd: "/repo",
    currentModeId: "bypassPermissions", archivedAt: null, activeTurn: null, pendingPermissions: [],
    lastError: failure.error.message, title: "Original task", labels: {} };
}

function attachment(id: string): ForkAttachment {
  return { type: "text", mimeType: "text/plain", contextKind: "chat_history", title: `${id} history`, text: `Native context from ${id}` };
}

function fakeAdapter() {
  return {
    getAgent: vi.fn<ForkDaemonAdapter["getAgent"]>(async (id) => structuredClone(agents.get(id) ?? null)),
    applySettings: vi.fn<ForkDaemonAdapter["applySettings"]>(),
    send: vi.fn<ForkDaemonAdapter["send"]>(),
    usage: vi.fn<ForkDaemonAdapter["usage"]>(async () => quota()),
    timeline: vi.fn<ForkDaemonAdapter["timeline"]>(async () => ({ entries: [] } as unknown as TimelinePage)),
    models: vi.fn<ForkDaemonAdapter["models"]>(async () => ({ provider: "codex", requestId: "models", error: null,
      fetchedAt: new Date(START).toISOString(),
      models: [{ provider: "codex", id: FALLBACK_MODEL, label: "GPT-6.1 Sol", thinkingOptions: [
        { id: FALLBACK_THINKING, label: "Ultra" },
      ] }],
    })),
    forkContext: vi.fn<ForkDaemonAdapter["forkContext"]>(async (id) => ({
      requestId: `context-${id}`, agentId: id, attachment: attachment(id), itemCount: 3,
      boundaryMessageId: null, error: null,
    })),
    createFallback: vi.fn<ForkDaemonAdapter["createFallback"]>(async ({ source: main, operationId }) => {
      // The real adapter resolves this operation's labels before creating and uses a durable receipt.
      const existing = [...agents.values()].find((agent) =>
        agent.labels?.[FALLBACK_OPERATION_LABEL] === operationId && agent.labels?.[FALLBACK_OWNER_LABEL] === main.id);
      if (existing) return structuredClone(existing);
      births++;
      const backup: AgentSnapshot = { ...source(), id: `backup-${births}`, status: "idle", lastError: null,
        provider: "codex", model: FALLBACK_MODEL, thinkingOptionId: FALLBACK_THINKING,
        workspaceId: main.workspaceId, cwd: main.cwd,
        labels: { [FALLBACK_OPERATION_LABEL]: operationId, [FALLBACK_OWNER_LABEL]: main.id } };
      agents.set(backup.id, backup);
      return structuredClone(backup);
    }),
    findFallback: vi.fn<ForkDaemonAdapter["findFallback"]>(async (operationId, mainId) =>
      structuredClone([...agents.values()].find((agent) => agent.labels?.[FALLBACK_OPERATION_LABEL] === operationId &&
        agent.labels?.[FALLBACK_OWNER_LABEL] === mainId) ?? null)),
    sendWithContext: vi.fn<ForkDaemonAdapter["sendWithContext"]>(async () => {}),
    stop: vi.fn<ForkDaemonAdapter["stop"]>(async (id) => {
      const agent = agents.get(id);
      if (agent) { agent.status = "idle"; agent.activeTurn = null; agent.pendingPermissions = []; }
    }),
    providerFamily: vi.fn<ForkDaemonAdapter["providerFamily"]>(async (provider) => provider),
    close: vi.fn<ForkDaemonAdapter["close"]>(async () => {}),
  } satisfies ForkDaemonAdapter;
}

beforeEach(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  directory = await mkdtemp(join(tmpdir(), "rate-fork-controller-"));
  clock = START; enabled = true; births = 0;
  agents = new Map([["source", source()]]);
  adapter = fakeAdapter();
  store = new ForkStore(join(directory, "forks.json"));
  store.loadSync();
  notify = vi.fn(async () => {});
  controller = new ForkController(adapter, store, () => enabled, notify, () => clock);
  controllers = [controller];
});

afterEach(async () => {
  await Promise.all(controllers.map((instance) => instance.close()));
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function backup(): AgentSnapshot {
  return agents.get(store.state.agents.source!.fallbackAgentId!)!;
}

async function fork() { await controller.endedTurn("source", "rate-turn", failure); }
async function reset() { clock = RESET + 5001; await controller.tick(); }

describe("Claude fork handoff", () => {
  it("durably records ownership before creating a same-workspace backup and sends native context", async () => {
    const create = adapter.createFallback.getMockImplementation()!;
    adapter.createFallback.mockImplementation(async (input) => {
      const durable = new ForkStore(store.path); durable.loadSync();
      expect(durable.state.agents.source).toMatchObject({ mainProvider: "claude", mainModel: mainSettings.model,
        mainThinking: "max", workspaceId: "workspace", phase: "forking", operationId: input.operationId });
      return create(input);
    });
    await fork();
    expect(adapter.createFallback).toHaveBeenCalledTimes(1);
    expect(backup()).toMatchObject({ workspaceId: "workspace", cwd: "/repo", provider: "codex",
      model: FALLBACK_MODEL, thinkingOptionId: FALLBACK_THINKING });
    expect(adapter.sendWithContext).toHaveBeenCalledWith(backup().id, expect.any(String),
      store.state.agents.source!.fallbackMessageId, attachment("source"));
    expect(store.state.agents.source).toMatchObject({ phase: "fallback", fallbackSent: true });
    expect(agents.get("source")).toMatchObject(mainSettings);
    expect(adapter.applySettings).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it("recognizes only Claude's strict limit row when its turn nominally completed", async () => {
    adapter.timeline.mockResolvedValue({ entries: [{ item: { type: "assistant_message",
      text: "You've hit your session limit · resets 2pm (America/Los_Angeles)" } }] } as unknown as TimelinePage);
    await controller.endedTurn("source", "complete-rate", { kind: "completed" });
    expect(adapter.createFallback).toHaveBeenCalledTimes(1);
    expect(store.state.agents.source?.resetAt).toBe(Date.parse("2026-10-22T21:00:00Z"));
  });

  it("deduplicates concurrent end events and never forks a user prompt about rate limits", async () => {
    adapter.timeline.mockResolvedValue({ entries: [{ item: { type: "user_message", text: failure.error.message } }] } as unknown as TimelinePage);
    await controller.endedTurn("source", "ordinary", { kind: "completed" });
    expect(adapter.createFallback).not.toHaveBeenCalled();
    await controller.started("source");
    await Promise.all([controller.endedTurn("source", null, failure), controller.endedTurn("source", null, failure)]);
    expect(adapter.createFallback).toHaveBeenCalledTimes(1);
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
  });

  it("returns latest backup context after reset plus grace without changing original settings", async () => {
    await fork();
    const backupId = backup().id;
    clock = RESET; await controller.tick();
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
    await reset();
    expect(adapter.forkContext).toHaveBeenLastCalledWith(backupId);
    expect(adapter.sendWithContext).toHaveBeenLastCalledWith("source", expect.any(String),
      store.state.agents.source!.returnMessageId, attachment(backupId));
    expect(store.state.agents.source).toMatchObject({ phase: "returning", returnSent: true });
    await controller.started("source");
    await controller.endedTurn("source", "returned", { kind: "completed" });
    expect(store.state.agents).toEqual({});
    expect(agents.get("source")).toMatchObject(mainSettings);
    expect(adapter.applySettings).not.toHaveBeenCalled();
  });

  it.each(["source", "backup"])("does not transfer while %s is busy", async (which) => {
    await fork();
    const id = which === "source" ? "source" : backup().id;
    agents.get(id)!.status = "running";
    await reset();
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
    agents.get(id)!.status = "idle";
    await controller.tick();
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(2);
  });

  it("updates an exhausted main quota before returning", async () => {
    await fork();
    const extended = RESET + 45 * 60_000;
    adapter.usage.mockResolvedValue(quota(100, extended));
    await reset();
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
    expect(store.state.agents.source?.resetAt).toBe(extended);
    adapter.usage.mockResolvedValue(quota(10)); clock = extended + 5001;
    await controller.tick();
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(2);
  });

  it("reuses the same backup when Claude is rate limited again during return", async () => {
    await fork();
    const id = backup().id;
    await reset();
    await controller.started("source");
    await controller.endedTurn("source", "return-rate", failure);
    expect(adapter.createFallback).toHaveBeenCalledTimes(1);
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(3);
    expect(adapter.sendWithContext.mock.calls[2]![0]).toBe(id);
    expect(store.state.agents.source).toMatchObject({ fallbackAgentId: id, phase: "fallback", fallbackSent: true, returnSent: false });
  });

  it("reloads accepted handoffs without replaying the continuation", async () => {
    await fork(); await controller.close();
    const persisted = new ForkStore(store.path); persisted.loadSync();
    const restarted = new ForkController(adapter, persisted, () => enabled, notify, () => clock);
    controllers.push(restarted);
    await restarted.tick();
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
    clock = RESET + 5001; await restarted.tick();
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(2);
    expect(adapter.createFallback).toHaveBeenCalledTimes(1);
  });
});

describe("fork recovery and ownership", () => {
  it("cannot create or send when durable ownership cannot be written", async () => {
    const save = vi.spyOn(store, "save").mockRejectedValue(new Error("disk unavailable"));
    await expect(fork()).rejects.toThrow("disk unavailable");
    expect(adapter.createFallback).not.toHaveBeenCalled();
    expect(adapter.sendWithContext).not.toHaveBeenCalled();
    save.mockRestore(); clock += 60_001;
    await controller.tick();
    expect(adapter.createFallback).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost create response with the same durable operation after reload", async () => {
    const create = adapter.createFallback.getMockImplementation()!;
    adapter.createFallback.mockImplementationOnce(async (input) => {
      await create(input); throw new Error("create response lost");
    });
    await fork();
    const operation = store.state.agents.source!.operationId;
    expect(adapter.sendWithContext).not.toHaveBeenCalled();
    await controller.close();
    const persisted = new ForkStore(store.path); persisted.loadSync();
    const restarted = new ForkController(adapter, persisted, () => enabled, notify, () => clock);
    controllers.push(restarted);
    clock += 60_001; await restarted.tick();
    expect(births).toBe(1);
    expect(adapter.createFallback.mock.calls[1]![0].operationId).toBe(operation);
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
  });

  it("does not send without a context attachment and retries after the delay", async () => {
    adapter.forkContext.mockResolvedValueOnce({ requestId: "missing", agentId: "source", attachment: null,
      itemCount: 0, boundaryMessageId: null, error: null });
    await fork();
    expect(adapter.sendWithContext).not.toHaveBeenCalled();
    await controller.tick(); expect(adapter.forkContext).toHaveBeenCalledTimes(1);
    clock += 60_001; await controller.tick();
    expect(adapter.createFallback).toHaveBeenCalledTimes(1);
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
  });

  it("retries an unaccepted send with the original message id", async () => {
    adapter.sendWithContext.mockRejectedValueOnce(new Error("send response lost"));
    await fork();
    const messageId = adapter.sendWithContext.mock.calls[0]![2];
    await controller.tick(); expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
    clock += 60_001; await controller.tick();
    expect(adapter.sendWithContext.mock.calls[1]![2]).toBe(messageId);
    expect(store.state.agents.source?.fallbackSent).toBe(true);
  });

  it("does not replay an accepted return when its response is lost and Claude is already running", async () => {
    await fork();
    adapter.sendWithContext.mockImplementationOnce(async (id) => {
      agents.get(id)!.status = "running";
      throw new Error("accepted return response lost");
    });
    await reset();
    expect(store.state.agents.source).toMatchObject({ phase: "returning", returnSent: false });
    clock += 60_001; await controller.tick();
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(2);
    agents.get("source")!.status = "idle";
    await controller.started("source");
    await controller.endedTurn("source", "accepted-return", { kind: "completed" });
    expect(store.state.agents).toEqual({});
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(2);
  });

  it("retains the handoff if the source becomes busy while context is being built", async () => {
    const build = adapter.forkContext.getMockImplementation()!;
    adapter.forkContext.mockImplementationOnce(async (id) => {
      const context = await build(id); agents.get("source")!.status = "running"; return context;
    });
    await fork();
    expect(adapter.sendWithContext).not.toHaveBeenCalled();
    expect(store.state.agents.source?.phase).toBe("forking");
    agents.get("source")!.status = "error";
    await controller.tick();
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
  });

  it("clears ownership without sending if disabled while source context is being built", async () => {
    const build = adapter.forkContext.getMockImplementation()!;
    adapter.forkContext.mockImplementationOnce(async (id) => {
      const context = await build(id); enabled = false; return context;
    });
    await fork();
    expect(adapter.sendWithContext).not.toHaveBeenCalled();
    expect(store.state.agents).toEqual({});
    const persisted = new ForkStore(store.path); persisted.loadSync();
    expect(persisted.state.agents).toEqual({});
  });

  it("cleans a reloaded unsent backup when disabled rather than retaining a stuck forking entry", async () => {
    adapter.forkContext.mockResolvedValueOnce({ requestId: "missing", agentId: "source", attachment: null,
      itemCount: 0, boundaryMessageId: null, error: null });
    await fork();
    expect(store.state.agents.source).toMatchObject({ phase: "forking", fallbackAgentId: "backup-1", fallbackSent: false });
    await controller.close(); enabled = false;
    const persisted = new ForkStore(store.path); persisted.loadSync();
    const restarted = new ForkController(adapter, persisted, () => enabled, notify, () => clock);
    controllers.push(restarted);
    clock += 60_001; await restarted.tick();
    expect(persisted.state.agents).toEqual({});
    expect(adapter.sendWithContext).not.toHaveBeenCalled();
    expect(adapter.createFallback).toHaveBeenCalledTimes(1);
    const final = new ForkStore(store.path); final.loadSync();
    expect(final.state.agents).toEqual({});
  });

  it("synchronously invalidates a handoff if the source starts and finishes during context creation", async () => {
    const build = adapter.forkContext.getMockImplementation()!;
    const manualEvents: Promise<void>[] = [];
    adapter.forkContext.mockImplementationOnce(async (id) => {
      const context = await build(id);
      agents.get("source")!.status = "running";
      manualEvents.push(controller.started("source"));
      agents.get("source")!.status = "idle";
      manualEvents.push(controller.endedTurn("source", "manual-turn", { kind: "completed" }));
      return context;
    });
    await fork(); await Promise.all(manualEvents);
    expect(adapter.sendWithContext).not.toHaveBeenCalled();
    expect(store.state.agents).toEqual({});
    expect(agents.get("source")).toMatchObject({ ...mainSettings, status: "idle" });
  });

  it("does not dispatch fallback if the source is archived while context is being built", async () => {
    const build = adapter.forkContext.getMockImplementation()!;
    adapter.forkContext.mockImplementationOnce(async (id) => {
      const context = await build(id); agents.get("source")!.archivedAt = new Date(clock).toISOString(); return context;
    });
    await fork();
    expect(adapter.sendWithContext).not.toHaveBeenCalled();
    await controller.tick();
    expect(store.state.agents).toEqual({});
  });

  it.each(["running", "model", "archived"])("does not steer a backup that becomes %s while source context is being built", async (change) => {
    const build = adapter.forkContext.getMockImplementation()!;
    adapter.forkContext.mockImplementationOnce(async (id) => {
      const context = await build(id);
      if (change === "running") backup().status = "running";
      if (change === "model") backup().model = "user-selected-model";
      if (change === "archived") backup().archivedAt = new Date(clock).toISOString();
      return context;
    });
    await fork();
    expect(adapter.sendWithContext).not.toHaveBeenCalled();
    if (change === "running") {
      backup().status = "idle";
      await controller.tick();
      expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
    } else {
      await controller.tick(); expect(store.state.agents).toEqual({});
    }
  });

  it.each(["source", "backup"])("does not resume Claude if %s is archived during return-context creation", async (which) => {
    await fork();
    const id = which === "source" ? "source" : backup().id;
    const build = adapter.forkContext.getMockImplementation()!;
    adapter.forkContext.mockImplementationOnce(async (agentId) => {
      const context = await build(agentId); agents.get(id)!.archivedAt = new Date(clock).toISOString(); return context;
    });
    await reset();
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
    await controller.tick();
    expect(store.state.agents).toEqual({});
  });

  it("manual source activity stops an owned active backup and prevents later return", async () => {
    await fork(); const id = backup().id; agents.get(id)!.status = "running";
    await controller.started("source");
    expect(adapter.stop).toHaveBeenCalledWith(id);
    expect(store.state.agents).toEqual({});
    await reset(); expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
  });

  it("user cancellation of the backup stops the transfer chain", async () => {
    await fork(); const id = backup().id;
    await controller.endedTurn(id, "canceled-backup", { kind: "canceled" });
    expect(store.state.agents).toEqual({});
    await reset(); expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
  });

  it.each(["source", "backup"])("cleans ownership when %s is archived", async (which) => {
    await fork(); const id = which === "source" ? "source" : backup().id;
    agents.get(id)!.archivedAt = new Date(clock).toISOString();
    await controller.archived(id);
    expect(store.state.agents).toEqual({});
    await reset(); expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
  });

  it.each(["source", "backup"])("respects a manual %s model change", async (which) => {
    await fork(); const id = which === "source" ? "source" : backup().id;
    agents.get(id)!.model = "user-selected-model";
    await reset();
    expect(store.state.agents).toEqual({});
    expect(agents.get(id)!.model).toBe("user-selected-model");
    expect(adapter.sendWithContext).toHaveBeenCalledTimes(1);
    expect(adapter.applySettings).not.toHaveBeenCalled();
  });

  it("disabling prevents new forks while an accepted backup can still return after reset", async () => {
    await fork(); enabled = false; await reset();
    expect(adapter.sendWithContext).toHaveBeenLastCalledWith("source", expect.any(String), expect.any(String), attachment(backup().id));
    await controller.endedTurn("source", "returned", { kind: "completed" });
    await controller.started("source"); await controller.endedTurn("source", "next-rate", failure);
    expect(adapter.createFallback).toHaveBeenCalledTimes(1);
  });
});
