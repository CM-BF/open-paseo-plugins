import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { readBoardRpc, type Board } from "../shared/contracts";

export function useBoard(hostId: string, boardId: string) {
  const read = useRpc(readBoardRpc);
  const cache = useQueryClient();
  const key = ["paseo-board", hostId, boardId] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      const previous = cache.getQueryData<Board | null>(key);
      const result = await read({ boardId, sinceRevision: previous?.revision });
      // A mutation may have advanced the cache while this read was in flight.
      const latest = cache.getQueryData<Board | null>(key);
      if (result.unchanged) return latest ?? previous ?? null;
      return latest && result.board && latest.revision > result.board.revision ? latest : result.board;
    },
    refetchInterval: 1500,
    retry: 1,
  });
  const accept = useCallback((next: Board) => {
    cache.setQueryData<Board | null>(["paseo-board", hostId, boardId], previous => !previous || previous.revision <= next.revision ? next : previous);
  }, [cache, hostId, boardId]);
  return { ...query, accept };
}
