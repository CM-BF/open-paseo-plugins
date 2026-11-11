import { useCallback, useEffect, useRef, useState } from "react";
import type { Board } from "../shared/contracts";
import { liveGetRpc, type LiveGetOutput } from "../shared/live-data";
import { useBoardRpc } from "./transport";

export type LiveStatusController = { data?: LiveGetOutput; refresh(): void };
const REFRESH_MS = 60_000;
/** Advisory channel state for the toolbar and release panel. Failures stay silent and keep the last reading. */
export function useLiveStatus(board: Board | null | undefined, enabled: boolean): LiveStatusController {
  const read = useBoardRpc(liveGetRpc);
  const [data, setData] = useState<LiveGetOutput>();
  const generation = useRef(0);
  const boardId = enabled ? board?.id : undefined, expectedCreatedAt = board?.createdAt;
  const refresh = useCallback(() => {
    if (!boardId || !expectedCreatedAt) return;
    const current = ++generation.current;
    void read({ boardId, expectedCreatedAt }).then(value => { if (current === generation.current) setData(value); }, () => {});
  }, [boardId, expectedCreatedAt, read]);
  useEffect(() => {
    setData(undefined); refresh();
    return () => { generation.current++; };
  }, [refresh]);
  const channelExists = !!data?.channel;
  useEffect(() => {
    if (!channelExists) return;
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [channelExists, refresh]);
  return { data, refresh };
}
