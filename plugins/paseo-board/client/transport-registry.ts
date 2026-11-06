import type { PluginClientContext } from "@getpaseo/plugin/client";
import { boardChangedEvent } from "../shared/contracts";
import type { BoardEventListener } from "./board-events";

/** Shared only by Board installations in this app's JavaScript realm. Nothing
 * here opens a connection, reads credentials, or uses a private Paseo client. */
export const BOARD_TRANSPORT_PROTOCOL = 1;
const registryKey = Symbol.for("paseo-board.transports.v1");
type HostIdentity = { id: string; label: string };
export interface BoardServices {
  readonly protocol: 1;
  readonly hostId: string;
  readonly label: string;
  readonly generation: number;
  readonly rpc: PluginClientContext["rpc"];
  readonly paseo: PluginClientContext["paseo"];
  openScreen(input: Parameters<PluginClientContext["openScreen"]>[0]): void;
  subscribeEvents(listener: BoardEventListener): () => void;
  isCurrent(): boolean;
}
interface Registration { services: BoardServices; revoke(): void }
interface Registry {
  protocol: 1;
  nextGeneration: number;
  entries: Map<string, Registration>;
  listeners: Set<() => void>;
  snapshot: readonly BoardServices[];
}

function registry(): Registry {
  const root = globalThis as typeof globalThis & { [registryKey]?: Registry };
  const existing = root[registryKey];
  if (existing) {
    if (existing.protocol !== BOARD_TRANSPORT_PROTOCOL || !(existing.entries instanceof Map)
      || !(existing.listeners instanceof Set) || !Array.isArray(existing.snapshot)) throw new Error("Incompatible Board transport registry");
    return existing;
  }
  return root[registryKey] = { protocol: 1, nextGeneration: 0, entries: new Map(), listeners: new Set(), snapshot: [] };
}
function changed(state: Registry): void {
  state.snapshot = Object.freeze([...state.entries.values()].map(value => value.services).sort((a, b) => a.hostId.localeCompare(b.hostId)));
  for (const listener of [...state.listeners]) listener();
}
export const getBoardTransports = (): readonly BoardServices[] => registry().snapshot;
export const getBoardServices = (hostId: string): BoardServices | undefined => registry().entries.get(hostId)?.services;
export function observeBoardTransports(listener: () => void): () => void {
  const state = registry(); state.listeners.add(listener); return () => { state.listeners.delete(listener); };
}
export function boardTransportUnavailable(hostId: string, outcomeUnknown = false): Error {
  return Object.assign(new Error(`Board host ${hostId} is unavailable or its connection has changed`), { code: "board_transport_unavailable", hostId, outcomeUnknown });
}
export function unsupportedBoardEvents(): Error {
  return Object.assign(new Error("此 Paseo 版本尚未提供 Board 事件订阅；需要配套宿主更新才能实时同步。"), { code: "plugin_events_unsupported" });
}
type EventClient = PluginClientContext & {
  subscribeEvent?: (contract: typeof boardChangedEvent, listener: {
    onEvent: BoardEventListener["change"]; onReconnect: BoardEventListener["reconnect"]; onError: BoardEventListener["error"];
  }) => { ready: Promise<void>; dispose(): Promise<void> };
};

/** Contribution identity may arrive asynchronously through hosts.list().self,
 * or through this installation's own public surface props on older daemons. */
export function createBoardInstallation(client: PluginClientContext) {
  const state = registry();
  let stopped = false;
  let identity: HostIdentity | undefined;
  let registration: Registration | undefined;
  const subscriptions = new Set<() => void>();
  const bind = (host: HostIdentity): BoardServices | undefined => {
    if (stopped) return undefined;
    if (!host.id || typeof host.id !== "string" || typeof host.label !== "string") throw new Error("Invalid public Board host identity");
    if (identity && identity.id !== host.id) { dispose(); throw new Error("Conflicting public Board host identities"); }
    if (registration) return registration.services;
    identity = { ...host };
    let active = true;
    const generation = ++state.nextGeneration;
    const isCurrent = () => !stopped && active && state.entries.get(host.id) === registration;
    const assertCurrent = (outcomeUnknown = false) => { if (!isCurrent()) throw boardTransportUnavailable(host.id, outcomeUnknown); };
    const services: BoardServices = Object.freeze({
      protocol: 1 as const, hostId: host.id, label: host.label, generation, paseo: client.paseo,
      isCurrent,
      rpc: (async (contract, input) => {
        assertCurrent();
        if (!/^board\.[a-z0-9._-]+$/.test(contract.name)) throw new Error("Only Board RPC contracts are available through this transport");
        // The public RPC performs schema validation and uses its installation's
        // authenticated connection. A completed old-generation write may have
        // happened; callers keep its immutable intent for reconciliation.
        const result = await client.rpc(contract, input);
        assertCurrent(true);
        return result;
      }) as PluginClientContext["rpc"],
      openScreen(input: Parameters<PluginClientContext["openScreen"]>[0]) { assertCurrent(); client.openScreen(input); },
      subscribeEvents(listener: BoardEventListener) {
        if (!isCurrent()) { listener.error(boardTransportUnavailable(host.id)); return () => undefined; }
        const events = client as EventClient;
        if (typeof events.subscribeEvent !== "function") { listener.error(unsupportedBoardEvents()); return () => undefined; }
        let listening = true;
        let subscription: ReturnType<NonNullable<EventClient["subscribeEvent"]>> | undefined;
        const deliver = (callback: () => void) => { if (listening && isCurrent()) callback(); };
        const cleanup = () => {
          if (!listening) return;
          listening = false; subscriptions.delete(cleanup);
          if (subscription) void subscription.dispose().catch(() => undefined);
        };
        subscriptions.add(cleanup);
        try {
          subscription = events.subscribeEvent(boardChangedEvent, {
            onEvent: event => deliver(() => listener.change(event)),
            onReconnect: () => deliver(listener.reconnect),
            onError: error => deliver(() => listener.error(error)),
          });
          void subscription.ready.catch(error => deliver(() => listener.error(error)));
          // A synchronous host callback is allowed to revoke the installation.
          if (!listening) void subscription.dispose().catch(() => undefined);
        } catch (error) { deliver(() => listener.error(error)); cleanup(); }
        return cleanup;
      },
    });
    registration = { services, revoke() { active = false; for (const remove of [...subscriptions]) remove(); } };
    state.entries.get(host.id)?.revoke();
    state.entries.set(host.id, registration); changed(state);
    return services;
  };
  const dispose = () => {
    if (stopped) return;
    stopped = true; registration?.revoke();
    if (identity && state.entries.get(identity.id) === registration) { state.entries.delete(identity.id); changed(state); }
  };
  // Unsupported older host directories deliberately leave discovery pending.
  // Opening that installation's public surface can still register its identity.
  const ready = Promise.resolve().then(async () => {
    if (stopped) return;
    try {
      const directory = await client.paseo.hosts.list();
      if (!stopped) bind({ id: directory.self.serverId, label: directory.self.label });
    } catch { /* No cross-host transport is advertised without public identity. */ }
  });
  return { bind, dispose, ready, current: () => registration?.services };
}
export type BoardInstallation = ReturnType<typeof createBoardInstallation>;
