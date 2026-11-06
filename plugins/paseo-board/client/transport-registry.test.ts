import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { readBoardRpc } from "../shared/contracts";
import { createBoardInstallation, getBoardServices, getBoardTransports, observeBoardTransports, type BoardInstallation } from "./transport-registry";

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const installations: BoardInstallation[] = [];
const install = (client: PluginClientContext) => { const installation = createBoardInstallation(client); installations.push(installation); return installation; };
function client(hostId: string, options: { directory?: Promise<unknown>; events?: boolean } = {}) {
  const listeners: { onEvent(event: unknown): void; onReconnect(): void; onError(error: Error): void }[] = [];
  const disposeEvents = vi.fn(async () => undefined);
  const rpc = vi.fn(async (_contract: unknown, input: unknown) => ({ hostId, input }));
  const openScreen = vi.fn();
  const list = vi.fn(() => options.directory ?? Promise.resolve({ self: { serverId: hostId, label: `Host ${hostId}` }, entries: [] }));
  const value = {
    rpc, openScreen, paseo: { hosts: { list }, agents: { list: vi.fn(async () => ({ entries: [] })) } },
    ...(options.events ? { subscribeEvent: vi.fn((_contract: unknown, listener: typeof listeners[number]) => {
      listeners.push(listener); return { ready: Promise.resolve(), dispose: disposeEvents };
    }) } : {}),
  };
  return { value: value as unknown as PluginClientContext, rpc, openScreen, list, listeners, disposeEvents };
}
afterEach(() => { for (const installation of installations.splice(0)) installation.dispose(); });

describe("public per-host Board transport", () => {
  it("shares capabilities across separately evaluated module copies without sharing a default host", async () => {
    const a = client("module-a"), one = install(a.value); await one.ready;
    vi.resetModules();
    const otherModule = await import("./transport-registry");
    const b = client("module-b"), two = otherModule.createBoardInstallation(b.value); installations.push(two); await two.ready;
    expect(otherModule.getBoardServices("module-a")).toBe(one.current());
    expect(getBoardServices("module-b")).toBe(two.current());
    expect(one.current()!.generation).not.toBe(two.current()!.generation);
    await getBoardServices("module-a")!.rpc(readBoardRpc, { boardId: "same-board" });
    await getBoardServices("module-b")!.rpc(readBoardRpc, { boardId: "same-board" });
    expect(a.rpc).toHaveBeenCalledExactlyOnceWith(readBoardRpc, { boardId: "same-board" });
    expect(b.rpc).toHaveBeenCalledExactlyOnceWith(readBoardRpc, { boardId: "same-board" });
    expect(getBoardServices("unknown-host")).toBeUndefined();
  });

  it("keeps each event subscription on its actual host and disposes only its owner", async () => {
    const a = client("event-a", { events: true }), b = client("event-b", { events: true });
    const one = install(a.value), two = install(b.value); await Promise.all([one.ready, two.ready]);
    const eventsA = { change: vi.fn(), reconnect: vi.fn(), error: vi.fn() }, eventsB = { change: vi.fn(), reconnect: vi.fn(), error: vi.fn() };
    one.current()!.subscribeEvents(eventsA); const removeB = two.current()!.subscribeEvents(eventsB);
    const payloadA = { source: "a" }, payloadB = { source: "b" };
    a.listeners[0].onEvent(payloadA); b.listeners[0].onEvent(payloadB);
    expect(eventsA.change).toHaveBeenCalledExactlyOnceWith(payloadA);
    expect(eventsB.change).toHaveBeenCalledExactlyOnceWith(payloadB);
    one.dispose(); a.listeners[0].onEvent(payloadA); a.listeners[0].onReconnect(); a.listeners[0].onError(new Error("late"));
    expect(eventsA.change).toHaveBeenCalledTimes(1); expect(eventsA.reconnect).not.toHaveBeenCalled(); expect(eventsA.error).not.toHaveBeenCalled();
    expect(a.disposeEvents).toHaveBeenCalledTimes(1); expect(b.disposeEvents).not.toHaveBeenCalled();
    removeB(); removeB(); expect(b.disposeEvents).toHaveBeenCalledTimes(1);
  });

  it("rejects late responses and stale callbacks after replacement without replaying a write", async () => {
    const a = client("replaced", { events: true });
    const held = deferred<{ hostId: string; input: unknown }>(); a.rpc.mockReturnValueOnce(held.promise);
    const old = install(a.value); await old.ready;
    const service = old.current()!;
    const eventListener = { change: vi.fn(), reconnect: vi.fn(), error: vi.fn() };
    service.subscribeEvents(eventListener);
    const result = service.rpc(readBoardRpc, { boardId: "same-board" });
    const b = client("replaced"), next = install(b.value); await next.ready;
    held.resolve({ hostId: "replaced", input: { boardId: "same-board" } });
    await expect(result).rejects.toMatchObject({ code: "board_transport_unavailable", outcomeUnknown: true, hostId: "replaced" });
    a.listeners[0].onEvent({ old: true }); expect(eventListener.change).not.toHaveBeenCalled();
    await expect(service.rpc(readBoardRpc, { boardId: "same-board" })).rejects.toMatchObject({ code: "board_transport_unavailable", outcomeUnknown: false });
    expect(() => service.openScreen({ screenId: "boards" })).toThrow("connection has changed");
    expect(a.rpc).toHaveBeenCalledTimes(1); expect(b.rpc).not.toHaveBeenCalled();
    old.dispose(); expect(getBoardServices("replaced")).toBe(next.current());
    expect(a.disposeEvents).toHaveBeenCalledTimes(1);
  });

  it("does not register a disposed installation when its delayed public identity arrives", async () => {
    const directory = deferred<unknown>(), a = client("delayed", { directory: directory.promise });
    const installation = install(a.value); await Promise.resolve(); installation.dispose();
    directory.resolve({ self: { serverId: "delayed", label: "Delayed" } }); await installation.ready;
    expect(getBoardServices("delayed")).toBeUndefined(); expect(installation.bind({ id: "delayed", label: "Delayed" })).toBeUndefined();
    expect(a.rpc).not.toHaveBeenCalled();
  });

  it("uses only an installation's own public surface identity when an older daemon has no host directory", async () => {
    const a = client("old"); a.list.mockRejectedValueOnce(new Error("unsupported capability"));
    const installation = install(a.value); await installation.ready;
    expect(getBoardServices("old")).toBeUndefined();
    const service = installation.bind({ id: "old", label: "Own public props" });
    expect(getBoardServices("old")).toBe(service);
    expect(service?.label).toBe("Own public props");
    const error = vi.fn(); service!.subscribeEvents({ change: vi.fn(), reconnect: vi.fn(), error });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: "plugin_events_unsupported" }));
    expect(() => installation.bind({ id: "foreign", label: "Wrong props" })).toThrow("Conflicting");
    expect(getBoardServices("old")).toBeUndefined(); expect(getBoardServices("foreign")).toBeUndefined();
  });

  it("refuses unrelated RPC contracts and uses the selected host's public screen callback", async () => {
    const a = client("navigation"), installation = install(a.value); await installation.ready;
    const service = installation.current()!;
    await expect(service.rpc({ ...readBoardRpc, name: "agents.send" }, { boardId: "same-board" })).rejects.toThrow("Only Board RPC");
    await service.rpc({ ...readBoardRpc, name: "board.composition.read" }, { boardId: "same-board" });
    service.openScreen({ screenId: "boards", params: { boardId: "same-board" } });
    expect(a.rpc).toHaveBeenCalledTimes(1);
    expect(a.openScreen).toHaveBeenCalledExactlyOnceWith({ screenId: "boards", params: { boardId: "same-board" } });
  });

  it("publishes stable snapshots and does not announce a superseded owner's cleanup as removal", async () => {
    const changed = vi.fn(), remove = observeBoardTransports(changed);
    const initial = getBoardTransports(); expect(getBoardTransports()).toBe(initial);
    const first = install(client("snapshot").value); await first.ready;
    const firstSnapshot = getBoardTransports(); expect(firstSnapshot).not.toBe(initial); expect(getBoardTransports()).toBe(firstSnapshot);
    const next = install(client("snapshot").value); await next.ready;
    expect(changed).toHaveBeenCalledTimes(2);
    first.dispose(); expect(changed).toHaveBeenCalledTimes(2);
    next.dispose(); expect(changed).toHaveBeenCalledTimes(3); remove();
  });
});
