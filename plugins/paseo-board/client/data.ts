import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { readBoardRpc, type Board } from "../shared/contracts";
import { mergeBoardSnapshot } from "./board-cache";

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
      return result.board ? mergeBoardSnapshot(latest, result.board) : result.board;
    },
    refetchInterval: 1500,
    retry: 1,
  });
  const accept = useCallback((next: Board) => {
    cache.setQueryData<Board | null>(["paseo-board", hostId, boardId], previous => mergeBoardSnapshot(previous, next));
  }, [cache, hostId, boardId]);
  return { ...query, accept };
}
