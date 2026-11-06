import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { boardRefKey, type BoardRef, type CompositionSourcesState } from "../shared/composition";
import { frameThemeFromColors } from "../shared/frame-theme";
import { BoardView } from "./board";
import type { CompositionMount } from "./composition-mount";
import { useBoard, useBoardList } from "./data";
import { BoardServicesProvider, useBoardTransports, type BoardServices } from "./transport";
import { CanvasFrame } from "./web";

const MAX_EMBEDS = 8;
type Surface = Pick<PluginSurfaceProps, "theme" | "layout" | "navigation">;
const mountKeys = new WeakMap<CompositionMount, number>();
let nextMountKey = 0;
function mountKey(mount: CompositionMount): number {
  let key = mountKeys.get(mount);
  if (key === undefined) { key = ++nextMountKey; mountKeys.set(mount, key); }
  return key;
}

/** Ordinary authored layout owns geometry; host controllers own source access
 * and privileged operations. No remote source or connection enters that layout. */
export function CompositionEmbeds({ parent, parentCreatedAt, mounts, sources, ...surface }: Surface & {
  parent: BoardRef; parentCreatedAt: string; mounts: readonly CompositionMount[]; sources?: CompositionSourcesState;
}) {
  const services = useBoardTransports();
  const grants = useMemo(() => new Map(sources?.boardCreatedAt === parentCreatedAt
    ? sources.sources.map(source => [boardRefKey(source.ref), source]) : []), [sources, parentCreatedAt]);
  // Replacing a real slot starts a new frame session and view channel. Its
  // durable viewScope still restores the same reading position; moving or
  // resizing the existing mount keeps its controller and live document.
  return <>{mounts.map((mount, index) => <CompositionEmbed key={mountKey(mount)} mount={mount} parent={parent}
    grants={grants} services={services} overBudget={index >= MAX_EMBEDS} {...surface} />)}</>;
}

function CompositionEmbed({ mount, parent, grants, services, overBudget, ...surface }: Surface & {
  mount: CompositionMount; parent: BoardRef; grants: Map<string, CompositionSourcesState["sources"][number]>; services: readonly BoardServices[]; overBudget: boolean;
}) {
  const slot = useSyncExternalStore(mount.subscribe, mount.getSnapshot, mount.getSnapshot);
  const ref = useMemo(() => ({ hostId: slot.hostId, boardId: slot.boardId }), [slot.hostId, slot.boardId]);
  const key = boardRefKey(ref);
  const grant = grants.get(key);
  const service = services.find(item => item.hostId === ref.hostId);
  // A same-slot target change gets a new controller and cannot reuse its grants,
  // drafts, navigation or source session. Resize/reordering retains the controller.
  const failure = key === boardRefKey(parent) ? "这张画板不能嵌入自己" : !grant ? "请先在「组合来源」中选择这张画板"
    : !grant.sourceCreatedAt ? "正在核对来源画板…"
    : slot.snapshotId ? "此固定版本缩略暂不可用，请打开原画板核对" : overBudget ? "本页同时显示的画板已达上限，请打开原画板"
    : !service ? "等待此 host 的 Board 插件连接" : undefined;
  const open = useCallback(() => { service?.openScreen({ screenId: "boards", params: { boardId: ref.boardId } }); }, [service, ref.boardId]);
  useEffect(() => {
    if (!failure) return;
    mount.setPresentation({ title: ref.boardId, hostLabel: service?.label ?? ref.hostId, unread: 0, onOpen: service ? open : undefined });
    mount.setStatus(failure);
  }, [mount, ref, service, failure, open]);
  const embedded = useMemo(() => ({ mount, viewScope: JSON.stringify([parent.hostId, parent.boardId, slot.id, grant?.sourceCreatedAt]), onOpen: open }), [mount, parent.hostId, parent.boardId, slot.id, grant?.sourceCreatedAt, open]);
  if (failure || !service || !grant?.sourceCreatedAt) return null;
  return <BoardServicesProvider key={key} services={service}>
    <AuthorizedSource mount={mount} service={service} source={ref} createdAt={grant.sourceCreatedAt} open={open}>
      {slot.view === "preview" ? <BoardPreview key={grant.sourceCreatedAt} mount={mount} service={service} refValue={ref} open={open} {...surface} /> :
        <BoardView key={grant.sourceCreatedAt} {...surface} host={{ id: service.hostId, label: service.label }} boardId={ref.boardId}
          onBack={open} onOpenBoard={boardId => service.openScreen({ screenId: "boards", params: { boardId } })} embedded={embedded} />}
    </AuthorizedSource>
  </BoardServicesProvider>;
}

/** IDs can be reused after deletion. The user grants one source incarnation;
 * a replacement must never inherit its live frame or comment capabilities. */
function AuthorizedSource({ mount, service, source, createdAt, open, children }: {
  mount: CompositionMount; service: BoardServices; source: BoardRef; createdAt: string; open(): void; children: ReactNode;
}) {
  const query = useBoard(service.hostId, source.boardId);
  const index = useBoardList(service.hostId);
  const board = query.data;
  const listed = index.data?.boards.find(item => item.id === source.boardId);
  // The current directory can retire an old cached Board before the content
  // read completes. Never let that retained first paint preserve old authority.
  const valid = board?.createdAt === createdAt && listed?.createdAt === createdAt;
  useEffect(() => {
    if (valid) return;
    mount.setPresentation({ title: source.boardId, hostLabel: service.label, unread: 0, onOpen: open });
    const replaced = board && board.createdAt !== createdAt || listed && listed.createdAt !== createdAt;
    mount.setStatus(replaced ? "来源画板已被替换，请在「组合来源」中重新选择" : query.isPending || index.isPending ? "正在连接画板…" : "来源画板暂不可用");
  }, [mount, service.label, source.boardId, createdAt, valid, board, listed, query.isPending, index.isPending, open]);
  return valid ? children : null;
}

/** A live read-only preview cold-renders the source's persistent canvas. It is
 * neither the source user's current browser pixels nor a historical snapshot. */
function BoardPreview({ mount, service, refValue, open, theme }: Surface & {
  mount: CompositionMount; service: BoardServices; refValue: BoardRef; open(): void;
}) {
  const query = useBoard(service.hostId, refValue.boardId);
  const board = query.data;
  const frameTheme = useMemo(() => frameThemeFromColors(theme.colors), [theme.colors]);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    mount.setPresentation({ title: board ? `${board.title} · r${board.revision} · 只读预览` : refValue.boardId,
      hostLabel: service.label, unread: board?.updates.filter(item => !board.seenUpdateIds.includes(item.id)).length ?? 0, onOpen: open });
    mount.setStatus(failure ?? (!board ? query.isPending ? "正在读取预览…" : "预览暂时无法连接" : query.error || query.liveError ? "连接中断 · 显示上次收到的预览" : ""));
  }, [mount, board, service.label, refValue.boardId, query.isPending, query.error, query.liveError, failure, open]);
  if (!board) return null;
  return <CanvasFrame embeddedMount={mount} boardId={board.id} title={board.title} canvas={board.canvas}
    boardRevision={board.revision} userState={{}} theme={frameTheme} height={300} selectionMode="off"
    onAnchor={() => undefined} onAsk={async () => ({ status: "cancelled", outcome: "请打开原画板后评论。" })}
    onState={() => undefined} onError={error => setFailure(error.message)} />;
}
