import { createContext, useCallback, useContext, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import { boardTransportUnavailable, getBoardTransports, observeBoardTransports, type BoardInstallation, type BoardServices } from "./transport-registry";
export { createBoardInstallation, getBoardServices, getBoardTransports, observeBoardTransports, type BoardServices } from "./transport-registry";

const BoardServicesContext = createContext<BoardServices | undefined>(undefined);
export function BoardServicesProvider({ services, children }: { services: BoardServices; children: ReactNode }) {
  return <BoardServicesContext.Provider key={`${services.hostId}:${services.generation}`} value={services}>{children}</BoardServicesContext.Provider>;
}
export function useBoardTransports(): readonly BoardServices[] {
  return useSyncExternalStore(observeBoardTransports, getBoardTransports, getBoardTransports);
}
export function useBoardServices(hostId?: string): BoardServices | undefined {
  const services = useContext(BoardServicesContext);
  if (services && hostId && hostId !== services.hostId) throw new Error("Board service host does not match its view");
  return services;
}
/** Production surfaces always install a provider. The SDK fallback preserves
 * standalone single-host integrations; it never chooses another host. */
export function useBoardRpc<Input extends ZodType, Output extends ZodType>(contract: PluginRpcContract<Input, Output>, hostId?: string) {
  const local = useRpc(contract);
  const services = useBoardServices(hostId);
  return useCallback((input: ZodInput<Input>): Promise<ZodOutput<Output>> => {
    if (services) return services.rpc(contract, input);
    // Once real installations are registered, a missing provider is an
    // integration error, never permission to borrow the carrier host's RPC.
    if (getBoardTransports().length) return Promise.reject(new Error("Board operations require their target host services"));
    return local(input);
  }, [contract, services, local]);
}
export function useBoardPaseo(hostId?: string) {
  const local = usePaseo();
  const services = useBoardServices(hostId);
  if (services && !services.isCurrent()) throw boardTransportUnavailable(services.hostId);
  return services?.paseo ?? local;
}
export function BoardInstallationProvider({ installation, host, children }: {
  installation: BoardInstallation; host: { id: string; label: string }; children: ReactNode;
}) {
  useBoardTransports();
  useEffect(() => { installation.bind(host); }, [installation, host.id, host.label]);
  const services = installation.current();
  return services?.hostId === host.id && services.isCurrent()
    ? <BoardServicesProvider services={services}>{children}</BoardServicesProvider> : null;
}
