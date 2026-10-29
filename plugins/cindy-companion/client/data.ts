import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { Linking } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { bootstrapRpc, invokeRpc, type BootstrapData } from "../shared/contracts";
import type { GroupSummary } from '../shared/groups';

export const companionsKey = (hostId: string) => ["cindy-companion", hostId] as const;
export function useGroups(hostId: string) {
  const invoke = useRpc(invokeRpc);
  return useQuery({ queryKey: [...companionsKey(hostId), 'groups'], queryFn: async () => {
    const result = await invoke({ op: 'groups.list', args: {} });
    if (!result.ok) throw new Error(result.message);
    return (result.value as { groups: GroupSummary[] }).groups;
  }, staleTime: 5_000, refetchInterval: query => query.state.data?.some(group => group.round && ['queued', 'running', 'stopping', 'permission'].includes(group.round.status)) ? 2_000 : false });
}
export function useCompanions(hostId: string, botId?: string) {
  const bootstrap = useRpc(bootstrapRpc);
  return useQuery({
    queryKey: [...companionsKey(hostId), "bootstrap", botId ?? "default"],
    queryFn: async () => {
      const result = await bootstrap({ botId });
      if (!result.ok) throw new Error(result.message);
      return result.value as BootstrapData;
    },
    staleTime: 10_000,
  });
}

export function useSettingsInvoke(hostId: string) {
  const invoke = useRpc(invokeRpc);
  const queries = useQueryClient();
  return useCallback(async (op: string, args: Record<string, unknown>) => {
    if (op === "paseo.openExternal") {
      const url = args.url;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url) || /[\u0000-\u001f]/.test(url)) {
        return { ok: false as const, code: "INVALID_LINK", message: "Only HTTP and HTTPS links can be opened." };
      }
      await Linking.openURL(url);
      return { ok: true as const, value: null };
    }
    const result = await invoke({ op, args });
    if (result.ok && /(?:update|create|avatar|ensure|lifecycle|invite|groups\.(?:send|stop|continue|delete|setMembers))/i.test(op)) {
      void queries.invalidateQueries({ queryKey: companionsKey(hostId) });
    }
    return result;
  }, [invoke, queries, hostId]);
}
