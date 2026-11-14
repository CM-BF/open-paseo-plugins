import { useCallback, useEffect, useRef, useState } from "react";
import type { Board } from "../shared/contracts";
import { inboxAutoStatusRpc, type InboxAutoStatus } from "../shared/inbox";
import { useBoardRpc } from "./transport";

const REFRESH_MS = 60_000;
/** Toolbar attention for the comment inbox (served from the coordinator's memory). Failures stay silent. */
export function useInboxAutoStatus(board: Board | null | undefined, enabled: boolean): { data?: InboxAutoStatus; refresh(): void } {
  const read = useBoardRpc(inboxAutoStatusRpc);
  const [data, setData] = useState<InboxAutoStatus>();
  const generation = useRef(0);
  const boardId = enabled ? board?.id : undefined, expectedCreatedAt = board?.createdAt;
  const refresh = useCallback(() => {
    if (!boardId || !expectedCreatedAt) return;
    // Only while the Board screen is in the foreground.
    if ((globalThis as unknown as { document?: { hidden?: boolean } }).document?.hidden) return;
    const current = ++generation.current;
    void read({ boardId, expectedCreatedAt }).then(value => { if (current === generation.current) setData(value); }, () => {});
  }, [boardId, expectedCreatedAt, read]);
  useEffect(() => {
    setData(undefined); refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => { generation.current++; clearInterval(timer); };
  }, [refresh]);
  return { data, refresh };
}
