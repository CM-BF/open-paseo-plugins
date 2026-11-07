import type { PluginClientContext, PluginComposerPillContribution } from "@getpaseo/plugin/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contributeBoardPill } from "./composer-pill";

interface Agent { id: string; workspaceId?: string | null; archivedAt?: string | null }
interface Observer {
  snapshot(value: { entries: { agent: Agent }[] }): void;
  update(value: { type: string; payload: { kind: string; agent?: Agent; agentId?: string } }): void;
  error(error: unknown): void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options: { initialError?: Error } = {}) {
  let observer!: Observer;
  let initial: Agent[] = [];
  const detach = vi.fn();
  const subscription = {
    subscribe: vi.fn((next: Observer) => {
      observer = next;
      observer.snapshot({ entries: initial.map(agent => ({ agent })) });
      if (options.initialError) observer.error(options.initialError);
      return detach;
    }),
    release: vi.fn(async () => undefined),
  };
  const bootstrap = deferred<{ subscription: typeof subscription }>();
  const list = vi.fn((_options: { subscribe: object; signal: AbortSignal }) => bootstrap.promise);
  const openPanel = vi.fn();
  const registered: { contribution: PluginComposerPillContribution; remove: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }[] = [];
  const addComposerPill = vi.fn((contribution: PluginComposerPillContribution) => {
    const registration = { contribution, remove: vi.fn(), update: vi.fn() };
    registered.push(registration);
    return registration;
  });
  const client = { addComposerPill, openPanel, paseo: { agents: { list } } } as unknown as PluginClientContext;
  return {
    client, list, openPanel, addComposerPill, registered, subscription, detach, bootstrap,
    async ready(agents: Agent[] = []) {
      initial = agents;
      bootstrap.resolve({ subscription });
      await bootstrap.promise;
    },
    snapshot(agents: Agent[]) { observer.snapshot({ entries: agents.map(agent => ({ agent })) }); },
    upsert(agent: Agent) { observer.update({ type: "agent_update", payload: { kind: "upsert", agent } }); },
    remove(agentId: string) { observer.update({ type: "agent_update", payload: { kind: "remove", agentId } }); },
    unrelated() { observer.update({ type: "other_update", payload: { kind: "remove", agentId: "one" } }); },
    error(error: Error) { observer.error(error); },
    press(index: number) {
      const behavior = registered[index].contribution.button.behavior;
      if (behavior.kind !== "action") throw new Error("Board shortcut must be an action");
      return behavior.onPress();
    },
  };
}

const cleanups: (() => void)[] = [];
function start(client: PluginClientContext) {
  const stop = contributeBoardPill(client);
  cleanups.push(stop);
  return stop;
}
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); vi.restoreAllMocks(); });

describe("Board composer shortcut", () => {
  it("observes agents once and opens the existing panel only after an explicit press", async () => {
    const f = fixture();
    start(f.client);
    expect(f.list).toHaveBeenCalledExactlyOnceWith({ subscribe: {}, signal: expect.any(AbortSignal) });
    await f.ready([
      { id: "one", workspaceId: "workspace-a" },
      { id: "archived", workspaceId: "workspace-a", archivedAt: "2026-11-06T10:00:00Z" },
      { id: "unassigned", workspaceId: null },
    ]);
    expect(f.registered).toHaveLength(1);
    expect(f.registered[0].contribution).toMatchObject({
      id: "board", agentId: "one", workspaceId: "workspace-a",
      button: { label: "Board", title: "打开 Board", icon: "PanelsTopLeft", behavior: { kind: "action" } },
    });
    expect(f.openPanel).not.toHaveBeenCalled();
    f.press(0);
    expect(f.openPanel).toHaveBeenCalledExactlyOnceWith("agent-board", { agentId: "one", workspaceId: "workspace-a" });
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it("reconciles reconnect snapshots without re-registering unchanged pills", async () => {
    const f = fixture();
    start(f.client);
    await f.ready([{ id: "one", workspaceId: "a" }, { id: "two", workspaceId: "a" }]);
    f.upsert({ id: "one", workspaceId: "a" });
    f.snapshot([{ id: "one", workspaceId: "a" }, { id: "two", workspaceId: "a" }]);
    f.unrelated();
    expect(f.addComposerPill).toHaveBeenCalledTimes(2);
    for (const entry of f.registered) { expect(entry.remove).not.toHaveBeenCalled(); expect(entry.update).not.toHaveBeenCalled(); }
    f.snapshot([{ id: "two", workspaceId: "a" }, { id: "three", workspaceId: "b" }]);
    expect(f.registered[0].remove).toHaveBeenCalledOnce();
    expect(f.registered[1].remove).not.toHaveBeenCalled();
    expect(f.registered[2].contribution.agentId).toBe("three");
    f.press(0);
    expect(f.openPanel).not.toHaveBeenCalled();
    f.snapshot([{ id: "two", workspaceId: "a", archivedAt: "2026-11-06T10:00:00Z" }, { id: "three" }]);
    expect(f.registered[1].remove).toHaveBeenCalledOnce();
    expect(f.registered[2].remove).toHaveBeenCalledOnce();
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it("revokes old actions across workspace moves, archives, removes and equal-id returns", async () => {
    const f = fixture();
    start(f.client);
    await f.ready([{ id: "one", workspaceId: "before" }]);
    f.upsert({ id: "one", workspaceId: "after" });
    expect(f.registered[0].remove).toHaveBeenCalledOnce();
    f.press(0);
    expect(f.openPanel).not.toHaveBeenCalled();
    f.press(1);
    expect(f.openPanel).toHaveBeenCalledExactlyOnceWith("agent-board", { agentId: "one", workspaceId: "after" });
    f.openPanel.mockClear();
    f.upsert({ id: "one", workspaceId: "after", archivedAt: "2026-11-06T10:00:00Z" });
    f.press(1);
    f.upsert({ id: "one", workspaceId: "after", archivedAt: null });
    f.press(1);
    f.remove("one");
    f.remove("one");
    f.press(2);
    expect(f.openPanel).not.toHaveBeenCalled();
    for (const entry of f.registered) expect(entry.remove).toHaveBeenCalledOnce();
    f.upsert({ id: "one", workspaceId: "after" });
    f.press(2);
    f.press(3);
    expect(f.openPanel).toHaveBeenCalledExactlyOnceWith("agent-board", { agentId: "one", workspaceId: "after" });
  });

  it("stops observation and all retained callbacks idempotently", async () => {
    const f = fixture();
    const stop = start(f.client);
    await f.ready([{ id: "one", workspaceId: "a" }, { id: "two", workspaceId: "b" }]);
    stop(); stop();
    expect(f.list.mock.calls[0][0].signal.aborted).toBe(true);
    expect(f.detach).toHaveBeenCalledOnce();
    expect(f.subscription.release).toHaveBeenCalledOnce();
    for (const entry of f.registered) expect(entry.remove).toHaveBeenCalledOnce();
    f.snapshot([{ id: "late", workspaceId: "a" }]);
    f.upsert({ id: "later", workspaceId: "a" });
    f.remove("one");
    f.press(0); f.press(1);
    expect(f.registered).toHaveLength(2);
    expect(f.openPanel).not.toHaveBeenCalled();
  });

  it("releases a late bootstrap without attaching an observer or resurrecting a pill", async () => {
    const f = fixture();
    const stop = start(f.client);
    stop();
    await f.ready([{ id: "late", workspaceId: "a" }]);
    stop();
    expect(f.subscription.subscribe).not.toHaveBeenCalled();
    expect(f.subscription.release).toHaveBeenCalledOnce();
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.registered).toHaveLength(0);
    expect(f.openPanel).not.toHaveBeenCalled();
  });

  it("keeps equal agent and workspace IDs on two hosts bound to their own client", async () => {
    const a = fixture(), b = fixture();
    const stopA = start(a.client);
    start(b.client);
    await Promise.all([a.ready([{ id: "same", workspaceId: "same" }]), b.ready([{ id: "same", workspaceId: "same" }])]);
    a.press(0);
    expect(a.openPanel).toHaveBeenCalledOnce();
    expect(b.openPanel).not.toHaveBeenCalled();
    stopA(); a.press(0); b.press(0);
    expect(a.openPanel).toHaveBeenCalledTimes(1);
    expect(b.openPanel).toHaveBeenCalledExactlyOnceWith("agent-board", { agentId: "same", workspaceId: "same" });
    expect(b.registered[0].remove).not.toHaveBeenCalled();
    expect(b.subscription.release).not.toHaveBeenCalled();
    expect(b.list.mock.calls[0][0].signal.aborted).toBe(false);
  });

  it("revokes navigation on a terminal subscription error, including a synchronous initial error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("observation ended");
    const f = fixture({ initialError: error });
    const stop = start(f.client);
    await f.ready([{ id: "one", workspaceId: "a" }]);
    expect(log).toHaveBeenCalledWith("[paseo-board] agent observation failed", error);
    expect(f.registered[0].remove).toHaveBeenCalledOnce();
    expect(f.detach).toHaveBeenCalledOnce();
    expect(f.subscription.release).toHaveBeenCalledOnce();
    f.press(0); f.error(error); stop();
    expect(f.openPanel).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(f.subscription.release).toHaveBeenCalledOnce();
  });

  it("reports bootstrap failure without polling and ignores a rejection after disposal", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("offline");
    const active = fixture(), stopped = fixture();
    start(active.client);
    start(stopped.client)();
    active.bootstrap.reject(error); stopped.bootstrap.reject(error);
    await Promise.resolve(); await Promise.resolve();
    expect(log).toHaveBeenCalledExactlyOnceWith("[paseo-board] agent observation failed", error);
    for (const f of [active, stopped]) {
      expect(f.list).toHaveBeenCalledTimes(1);
      expect(f.list.mock.calls[0][0].signal.aborted).toBe(true);
      expect(f.registered).toHaveLength(0);
      expect(f.openPanel).not.toHaveBeenCalled();
    }
  });

  it("does not start an observation on clients without composer pills", () => {
    const f = fixture();
    const legacy = { ...f.client, addComposerPill: undefined } as unknown as PluginClientContext;
    const stop = start(legacy);
    stop(); stop();
    expect(f.list).not.toHaveBeenCalled();
  });
});
