import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { PLUGIN_ID } from "../shared/ids";
import { badgeRpc, overviewRpc } from "../shared/rpc";

export const overviewKey = [PLUGIN_ID, "overview"] as const;
export const badgeKey = [PLUGIN_ID, "badge"] as const;

export function useOverview() {
  const read = useRpc(overviewRpc);
  return useQuery({
    queryKey: overviewKey,
    queryFn: () => read({}),
    // Faster while a check-in runs, so its result shows up without a manual refresh.
    refetchInterval: (query) => (query.state.data?.busy ? 3000 : 15_000),
  });
}

export function useBadge() {
  const read = useRpc(badgeRpc);
  return useQuery({ queryKey: badgeKey, queryFn: () => read({}), refetchInterval: (query) => (query.state.data?.busy ? 5000 : 30_000) });
}

/** A mutation that refreshes everything Aide shows once it settles. */
export function useAction<Input, Output>(run: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: [PLUGIN_ID] });
    },
  });
}

/** The current time, refreshed every 30 seconds for relative labels. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
