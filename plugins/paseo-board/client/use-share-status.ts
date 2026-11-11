import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Board } from "../shared/contracts";
import { shareStatusRpc, type ShareStatus } from "../shared/release-contracts";
import { useBoardRpc } from "./transport";
import { liveShares, type LiveShare } from "./share-status";

export type ShareStatusController = { status?: ShareStatus; shares: LiveShare[]; refresh(): void };
/** Advisory share-link state. Failures stay silent: it must never surface through the canvas notice. */
export function useShareStatus(board: Board | null | undefined, enabled: boolean): ShareStatusController {
  const read = useBoardRpc(shareStatusRpc);
  const [status, setStatus] = useState<ShareStatus>();
  const generation = useRef(0);
  const boardId = enabled ? board?.id : undefined, createdAt = board?.createdAt;
  const refresh = useCallback(() => {
    if (!boardId) return;
    const current = ++generation.current;
    void read({ boardId }).then(value => { if (current === generation.current) setStatus(value); }, () => {});
  }, [boardId, read]);
  useEffect(() => {
    setStatus(undefined); refresh();
    return () => { generation.current++; };
  }, [refresh, createdAt]);
  const updating = status?.shares.some(share => share.state === "updating") ?? false;
  useEffect(() => {
    if (!updating) return;
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [updating, refresh]);
  // Edits are compared locally against the fetched source; no refetch per canvas write.
  const canvas = board?.canvas;
  const shares = useMemo(() => status && canvas ? liveShares(status.shares, canvas) : [], [status, canvas?.revision, canvas?.documentVersion, canvas?.patches.length]);
  return { status, shares, refresh };
}
