import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { BoardServicesProvider, useBoardRpc, useBoardServices, type BoardServices } from "./transport";
import { Markdown, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { interactBoardRpc, markUpdatesSeenRpc, recordDecisionRpc, saveStateRpc, selectSideAgentRpc, type Anchor, type Board, type Decision, type Interaction, type JsonData, type SideContext } from "../shared/contracts";
import type { AskRequest, AskResult, ComposeRequest, CaptureStatus, CaptureFailureReason, SelectionCapture, FrameTheme, InteractionLocation, SelectionMode, CanvasViewState } from "../shared/frame-contract";
import { interactionMarkers, interactionMarkerId, markerInteractionId, sameSelectionAnchor } from "../shared/frame-contract";
import { interactionLocationNote } from "./interaction-location";
import { frameThemeFromColors } from "../shared/frame-theme";
import { CanvasFrame, WebMessageInput, canRenderFrames, usePopoverDismiss } from "./web";
import { Action, ColorContext, Copy, Notice, errorMessage, localId, timeLabel, useColors } from "./ui";
import { useBoard } from "./data";
import { ComponentEditPanel, useComponentEditor } from "./component-editor";
import { BoardToolbar } from "./board-toolbar";
import { ReleasePanel } from "./release-panel";
import { shareSummary } from "./share-status";
import { useShareStatus } from "./use-share-status";
import { useLiveStatus } from "./use-live-status";
import { liveSummary } from "./live-status";
import { LiveDataPanel } from "./live-data";
import { BoardInbox } from "./inbox";
import { BoardConnectionStatus } from "./connection-status";
import { createStateWriter } from "./state-writer";
import { createDraftStore, type StoredDraft } from "./draft-store";
import { acceptedDraftInteraction } from "./message-draft";
import { acceptedBatchInteraction, batchContainsDraft, createBatchStore, createCommentBatch, prepareCommentBatch, queuedDrafts, reconcileBatchDrafts, restoreBatchComments, type CommentBatch } from "./batch-store";
import { readBoardView, writeBoardView, retainBoardViewStore, flushBoardViewStore, type BoardEntryScope } from "./view-store";
import { DiscussionRail } from "./discussion-rail";
import { SideAgentPicker } from "./side-agent-picker";
import { SideContextChoice, type SideContextChange } from "./side-context-choice";
import { SIDE_CONTEXT_LABELS, createSideContextStore, sideContextNotes, sideHistoryTag, sideProvenance, visibleSideContext } from "./side-context";
import { useUpdateNavigation } from "./update-navigation";
import { CompositionSourceSync, CompositionSourcesPanel, useCompositionSources } from "./composition-sources";
import { CompositionEmbeds } from "./composition-view";
import type { CompositionMount } from "./composition-mount";
import { anchorPoint, interactionRoot, interactionThread, mergeInteractions, popoverPlacement, visualQuestion, type Point } from "./interaction-layout";

export interface BoardViewProps extends PluginSurfaceProps {
  boardId: string; onBack(): void; onOpenBoard?(id: string): void;
  embedded?: { mount: CompositionMount; viewScope: string; onOpen(): void };
  /** Where this Board is shown; only the route screen takes a "/" typed with nothing focused. */
  entryScope?: BoardEntryScope;
}
type Destination = "main" | "side" | "new-side";
type Compose = { draftId?: string; draftRevision?: string; queuedAt?: number; selectionId?: string; captureStatus?: CaptureStatus | "omitted"; captureFailureReason?: CaptureFailureReason; kind: Interaction["kind"]; text: string; intentId?: string; expectedCreatedAt?: string; destination?: Destination; sideContext?: SideContext; anchor?: Anchor; sourceInteractionId?: string; resolve?: (result: AskResult) => void };
const captureFailureNames: Record<CaptureFailureReason, string> = {
  "content-changed": "截图过程中画布内容发生变化，请重新框选。",
  "too-complex": "选区内容过于复杂，请缩小选区。",
  "unsupported-layout": "选区包含暂不支持截图的页面布局。",
  "too-large": "选区或图片过大，请缩小选区。",
  timeout: "截图超时，请重新框选。",
  "generation-failed": "无法生成图片，请重新框选。",
};
const statusNames: Record<Interaction["status"], string> = { saved: "已保存", sending: "发送中", delivered: "已送达", processing: "处理中", answered: "已有回复", applied: "已落实", rejected: "未采用", failed: "失败" };
const kindNames: Record<Interaction["kind"], string> = { question: "消息", change: "消息", fork: "Fork", return: "转给主会话", reply: "Fork 回复" };

export function BoardView(props: BoardViewProps) {
  return <ColorContext.Provider value={props.theme.colors}><BoardContent key={JSON.stringify([props.host.id, props.boardId])} {...props} /></ColorContext.Provider>;
}
function BoardContent({ boardId, host, theme, layout, onBack, navigation, onOpenBoard, embedded, entryScope }: BoardViewProps) {
  const c = useColors();
  const services = useBoardServices(host.id);
  const sourceRef = useMemo(() => ({ hostId: host.id, boardId }), [host.id, boardId]);
  const sources = useCompositionSources(sourceRef, !embedded);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [compositionMounts, setCompositionMounts] = useState<readonly CompositionMount[]>([]);
  const composition = useMemo(() => embedded ? undefined : { hostId: host.id, onSlots: setCompositionMounts }, [host.id, Boolean(embedded)]);
  const viewInstance = embedded?.viewScope;
  const query = useBoard(host.id, boardId);
  const board = query.data;
  useEffect(() => retainBoardViewStore(), []);
  // Read once for this document. Capturing a newer position must not issue a
  // fresh restore command on every React render or query update.
  const viewSession = useMemo(() => {
    const saved = board?.canvas.documentVersion ? readBoardView(host.id, boardId, board.canvas.documentVersion, viewInstance) : undefined;
    return { saved, latest: saved?.view };
  }, [host.id, boardId, board?.canvas.documentVersion, viewInstance]);
  const [settledView, setSettledView] = useState<typeof viewSession>();
  const [reconciledView, setReconciledView] = useState<typeof viewSession>();
  useEffect(() => {
    if (board && !query.isFetching && !query.isError && (query.liveStatus === "connected" || query.liveStatus === "checking")) setReconciledView(viewSession);
  }, [viewSession, board, query.isFetching, query.isError, query.liveStatus]);
  const componentEditor = useComponentEditor(host.id, boardId, board, query.accept, query.refetch, viewInstance);
  const send = useBoardRpc(interactBoardRpc);
  const save = useBoardRpc(saveStateRpc);
  const record = useBoardRpc(recordDecisionRpc);
  const selectSide = useBoardRpc(selectSideAgentRpc);
  const markUpdatesSeen = useBoardRpc(markUpdatesSeenRpc);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("off");
  const [anchor, setAnchor] = useState<Anchor>();
  const [selectionClearToken, setSelectionClearToken] = useState(0);
  const [selectionCaptureCancelId, setSelectionCaptureCancelId] = useState<string>();
  const [drawer, setDrawer] = useState<"decisions" | "threads" | "history" | "drafts" | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseIntent, setReleaseIntent] = useState<"publish" | "update">("publish");
  const shareStatus = useShareStatus(board, !embedded);
  const releaseWasOpen = useRef(false);
  // The panel may have published: re-read share links once it closes.
  useEffect(() => { if (releaseWasOpen.current && !releaseOpen) shareStatus.refresh(); releaseWasOpen.current = releaseOpen; }, [releaseOpen, shareStatus.refresh]);
  const [inboxOpen, setInboxOpen] = useState(false);
  const liveStatus = useLiveStatus(board, !embedded);
  const [liveOpen, setLiveOpen] = useState(false);
  const liveWasOpen = useRef(false);
  useEffect(() => { if (liveWasOpen.current && !liveOpen) liveStatus.refresh(); liveWasOpen.current = liveOpen; }, [liveOpen, liveStatus.refresh]);
  const draftStore = useMemo(() => createDraftStore({ hostId: host.id, boardId }), [host.id, boardId]);
  const [draftSnapshot, setDraftSnapshot] = useState(() => draftStore.list());
  const batchStore = useMemo(() => createBatchStore({ hostId: host.id, boardId }), [host.id, boardId]);
  const [batchSnapshot, setBatchSnapshot] = useState(() => batchStore.list());
  const [batchError, setBatchError] = useState<string | null>(null);
  const acceptedBatchIds = useMemo(() => new Set(batchSnapshot.batches.filter(batch => (!batch.expectedCreatedAt || batch.expectedCreatedAt === board?.createdAt) && acceptedBatchInteraction(batch, board?.interactions ?? [])).map(batch => batch.intentId)), [batchSnapshot.batches, board?.interactions, board?.createdAt]);
  const staged = useMemo(() => queuedDrafts(draftSnapshot.drafts, batchSnapshot.batches), [draftSnapshot, batchSnapshot]);
  const availableDrafts = useMemo(() => draftSnapshot.drafts.filter(draft => !batchSnapshot.batches.some(batch => batchContainsDraft(batch, draft))), [draftSnapshot, batchSnapshot]);
  const [draftError, setDraftError] = useState<string | null>(null);
  const restorationHandled = useRef(false);
  const [compose, setCompose] = useState<Compose | null>(null);
  const composeRef = useRef(compose); composeRef.current = compose;
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const sideChoicePending = useRef(false);
  const [choosingSide, setChoosingSide] = useState(false);
  const [sideChoiceUncertain, setSideChoiceUncertain] = useState(false);
  const sideTargetBlocked = choosingSide || sideChoiceUncertain;
  const [inputFocusToken, setInputFocusToken] = useState(0);
  // The new-Side choice is a local per-Board preference. It is read when a composer or the
  // drafts drawer opens and is never changed by another window while one is open.
  const sideContexts = useMemo(() => createSideContextStore({ hostId: host.id, boardId }), [host.id, boardId]);
  const [sideContext, setSideContext] = useState<SideContext>(() => sideContexts.read());
  const sideChoiceOpen = Boolean(compose) || drawer === "drafts";
  useEffect(() => { if (sideChoiceOpen) setSideContext(sideContexts.read()); }, [sideChoiceOpen, sideContexts]);
  const [message, setMessage] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [height, setHeight] = useState(500);
  const [width, setWidth] = useState(900);
  const [stageWidth, setStageWidth] = useState(900);
  const [popoverHeight, setPopoverHeight] = useState(300);
  const [popoverPoint, setPopoverPoint] = useState<Point>({ x: 24, y: 24 });
  const popoverPointRef = useRef(popoverPoint); popoverPointRef.current = popoverPoint;
  const [selectedInteractionId, setSelectedInteractionId] = useState<string>();
  const [focusInteraction, setFocusInteraction] = useState<{ id: string; token: number }>();
  const [interactionLocation, setInteractionLocation] = useState<{ id: string; location: InteractionLocation }>();
  const [optimistic, setOptimistic] = useState<Interaction[]>([]);
  const updatesBlocked = Boolean(componentEditor.draft || compose || selectedInteractionId || drawer || releaseOpen || liveOpen || sourcesOpen || sending || selectionMode !== "off");
  const updateNavigation = useUpdateNavigation(board, updatesBlocked, async id => { if (!embedded) query.accept(await markUpdatesSeen({ boardId, updateIds: [id] })); }, embedded ? { follow: false, skipInitialUnread: true } : viewSession.saved ? {
    follow: viewSession.saved.follow, skipInitialUnread: true, restoring: settledView !== viewSession, reconciling: reconciledView !== viewSession,
  } : undefined);
  const followRef = useRef(updateNavigation.follow); followRef.current = updateNavigation.follow;
  const onViewState = useCallback((view: CanvasViewState) => {
    if (view.documentVersion !== board?.canvas.documentVersion) return;
    viewSession.latest = view;
    writeBoardView(host.id, boardId, view, followRef.current, viewInstance);
  }, [host.id, boardId, board?.canvas.documentVersion, viewSession, viewInstance]);
  // A queued report can arrive just after this visit unmounts. Its bridge
  // freezes this persistence-only callback and revokes it when a new visit starts.
  const onFinalViewState = useCallback((view: CanvasViewState) => {
    if (view.documentVersion !== board?.canvas.documentVersion) return;
    writeBoardView(host.id, boardId, view, updateNavigation.follow, viewInstance);
    flushBoardViewStore();
  }, [host.id, boardId, board?.canvas.documentVersion, updateNavigation.follow, viewInstance]);
  const onViewRestored = useCallback(() => { setSettledView(viewSession); }, [viewSession]);
  useEffect(() => {
    if (viewSession.latest) writeBoardView(host.id, boardId, viewSession.latest, updateNavigation.follow, viewInstance);
  }, [host.id, boardId, viewSession, updateNavigation.follow, viewInstance]);
  useEffect(() => {
    if (!embedded) return;
    const unread = board?.updates.filter(item => !board.seenUpdateIds.includes(item.id)).length ?? 0;
    embedded.mount.setPresentation({ title: board?.title ?? boardId, hostLabel: host.label, unread, onOpen: embedded.onOpen,
      queued: staged.length + batchSnapshot.batches.length,
      onDrafts: () => { if (!pending.current && !composeRef.current) setDrawer("drafts"); } });
    embedded.mount.setStatus(!board ? query.isPending ? "正在连接画板…" : "画板暂时无法连接" : query.error || query.liveError ? "连接中断 · 当前显示上次收到的内容" : frameError ?? "");
  }, [embedded, board, boardId, host.label, query.isPending, query.error, query.liveError, frameError, staged.length, batchSnapshot.batches.length]);
  const interactions = useMemo(() => mergeInteractions(board?.interactions ?? [], optimistic), [board?.interactions, optimistic]);
  const markers = useMemo(() => interactionMarkers(interactions), [interactions]);
  // A whole-canvas discussion (toolbar 发消息, board.ask without a reference) has no component to locate; its note stays neutral.
  const locationNote = interactionLocation && interactionLocation.id === selectedInteractionId
    ? interactionLocationNote(interactionLocation.location, markers.find(marker => marker.id === interactionLocation.id)?.anchor)
    : undefined;
  const thread = useMemo(() => interactionThread(selectedInteractionId ? markerInteractionId(selectedInteractionId, interactions) : undefined, interactions), [selectedInteractionId, interactions]);
  const popover = popoverPlacement(popoverPoint, { width, height }, popoverHeight);
  const stateWriter = useRef<ReturnType<typeof createStateWriter> | null>(null);
  const frameTheme = useMemo(() => frameThemeFromColors(theme.colors), [theme.colors]);
  useEffect(() => {
    const refresh = () => setDraftSnapshot(draftStore.list());
    const unsubscribe = draftStore.subscribe(refresh);
    refresh();
    return unsubscribe;
  }, [draftStore]);
  useEffect(() => {
    const refresh = () => setBatchSnapshot(batchStore.list());
    const unsubscribe = batchStore.subscribe(refresh); refresh(); return unsubscribe;
  }, [batchStore]);
  const persistCompose = useCallback((draft: Compose, open = true, position = popoverPointRef.current) => {
    draft.draftId ??= localId("draft");
    const input = { id: draft.draftId, open, position, queuedAt: draft.queuedAt, compose: {
      kind: draft.kind, text: draft.text, anchor: draft.anchor, sourceInteractionId: draft.sourceInteractionId,
      intentId: draft.intentId, expectedCreatedAt: draft.expectedCreatedAt, destination: draft.destination, sideContext: draft.sideContext,
      captureStatus: draft.captureStatus === "pending" ? "omitted" as const : draft.captureStatus,
      captureFailureReason: draft.captureFailureReason,
    } };
    let result = draftStore.put(input, draft.draftRevision ?? null);
    if (!result.ok && result.issue.code === "conflict") {
      // Another window owns a newer branch. Keep this user's input separately.
      draft.draftId = localId("draft"); draft.draftRevision = undefined;
      result = draftStore.put({ ...input, id: draft.draftId }, null);
    }
    if (result.ok) { draft.draftRevision = result.draft.revision; draft.anchor = result.draft.compose.anchor; setDraftError(null); }
    else setDraftError(result.issue.message);
    return result.ok;
  }, [draftStore]);
  const changeCompose = useCallback((draft: Compose, position = popoverPointRef.current) => {
    restorationHandled.current = true;
    if (!draft.intentId) draft.expectedCreatedAt ??= board?.createdAt;
    persistCompose(draft, true, position);
    composeRef.current = draft; setCompose(draft);
  }, [persistCompose, board?.createdAt]);
  const removeDraft = useCallback((draft: Compose) => {
    if (!draft.draftId || !draft.draftRevision) return true;
    const result = draftStore.remove(draft.draftId, draft.draftRevision);
    if (!result.ok) setDraftError(result.issue.message);
    return result.ok;
  }, [draftStore]);
  const restoreDraft = (saved: StoredDraft) => {
    if (pending.current || composeRef.current) return;
    // Captured batches are immutable. Editing one of their sources creates a new draft.
    const captured = batchStore.list().batches.some(batch => batchContainsDraft(batch, saved));
    const draft: Compose = { ...saved.compose, queuedAt: saved.queuedAt, ...(captured ? {} : { draftId: saved.id, draftRevision: saved.revision }) };
    setPopoverPoint(saved.position); setAnchor(draft.anchor); setDrawer(null); setMessage(null);
    setSelectedInteractionId(draft.sourceInteractionId ? interactionRoot(draft.sourceInteractionId, interactions) : undefined);
    changeCompose(draft, saved.position); setInputFocusToken(value => value + 1);
  };
  const changeDraftText = (text: string) => {
    const previous = composeRef.current;
    if (!previous || previous.text === text) return;
    if (previous.intentId) {
      // Editing after an uncertain send starts another draft. The original
      // immutable request stays available until its receipt is confirmed.
      persistCompose(previous, false);
      changeCompose({ ...previous, text, draftId: undefined, draftRevision: undefined, intentId: undefined, destination: undefined, sideContext: undefined });
    } else changeCompose({ ...previous, text });
  };
  useEffect(() => {
    const batches = batchSnapshot.batches;
    if (!board) {
      if (!query.isPending && !restorationHandled.current) {
        restorationHandled.current = true;
        const saved = draftStore.list().drafts.find(item => item.open && !batches.some(batch => batchContainsDraft(batch, item)));
        if (saved && !embedded) restoreDraft(saved);
      }
      return;
    }
    const firstRead = !restorationHandled.current;
    restorationHandled.current = true;
    // A server receipt is authoritative even if its original RPC response was lost.
    // This is a read-only reconciliation; reopening never sends an agent message.
    let latest: StoredDraft | undefined;
    for (const saved of draftStore.list().drafts) {
      if (batches.some(batch => batchContainsDraft(batch, saved))) continue;
      const receipt = !saved.compose.expectedCreatedAt || saved.compose.expectedCreatedAt === board.createdAt ? acceptedDraftInteraction(saved.compose, board.interactions) : undefined;
      if (receipt) {
        const current = composeRef.current;
        const isCurrent = current?.draftId === saved.id && current.draftRevision === saved.revision;
        if (isCurrent && pending.current) continue;
        const removed = draftStore.remove(saved.id, saved.revision);
        if (!removed.ok) setDraftError(removed.issue.message);
        if (isCurrent) {
          current.resolve?.({ status: "submitted", outcome: statusNames[receipt.status] });
          composeRef.current = null; setCompose(null); setMessage(null);
        }
        if (isCurrent || !embedded && firstRead && saved.open) { setSelectedInteractionId(interactionRoot(receipt.id, board.interactions)); setPopoverPoint(saved.position); }
      } else if (firstRead && saved.open && (!latest || saved.updatedAt > latest.updatedAt)) latest = saved;
    }
    if (latest && !embedded) restoreDraft(latest);
  }, [board, draftStore, query.isPending, sending, batchSnapshot.batches]);
  useEffect(() => {
    if (!board || pending.current) return;
    for (const batch of batchSnapshot.batches) {
      if (!acceptedBatchIds.has(batch.intentId)) continue;
      const cleanup = reconcileBatchDrafts(batch, draftStore);
      const removed = cleanup.ok ? batchStore.remove(batch) : cleanup;
      if (!removed.ok) setBatchError(removed.message);
    }
  }, [board, sending, batchStore, draftStore, batchSnapshot.batches, acceptedBatchIds]);
  const onAnchor = useCallback((next: Anchor) => { setAnchor(next); setSelectionMode("off"); }, []);
  const onAsk = useCallback((request: AskRequest): Promise<AskResult> => new Promise(resolve => {
    // A generated document cannot send a message. It can request this host-owned preview.
    if (composeRef.current || pending.current) { resolve({ status: "cancelled", outcome: "Another question is open" }); return; }
    const next: Compose = { kind: "question", text: request.prompt, anchor: request.anchor, resolve };
    setPopoverPoint(request.position ?? anchorPoint(request.anchor)); setSelectedInteractionId(undefined); setMessage(null);
    changeCompose(next, request.position ?? anchorPoint(request.anchor));
  }), [changeCompose]);
  const onCompose = useCallback((request: ComposeRequest) => {
    if (composeRef.current || pending.current) return;
    const next: Compose = { kind: "question", text: "", anchor: request.anchor, selectionId: request.selectionId, captureStatus: request.captureStatus };
    setPopoverPoint(request.position ?? anchorPoint(request.anchor)); setSelectedInteractionId(undefined); setMessage(null);
    setAnchor(request.anchor); setSelectionMode("off"); setDrawer(null);
    changeCompose(next, request.position ?? anchorPoint(request.anchor));
  }, [changeCompose]);
  const onSelectionCapture = useCallback((capture: SelectionCapture) => {
    const draft = composeRef.current;
    if (!draft || pending.current || draft.intentId || draft.captureStatus !== "pending" || draft.selectionId !== capture.selectionId || !draft.anchor || !sameSelectionAnchor(draft.anchor, capture.anchor)) return;
    const next: Compose = { ...draft, anchor: capture.anchor, captureStatus: capture.status, captureFailureReason: capture.reason };
    changeCompose(next); setAnchor(capture.anchor);
  }, [changeCompose]);
  const onState = useCallback((state: JsonData) => stateWriter.current?.schedule(state), []);
  useEffect(() => {
    const expectedCreatedAt = board?.createdAt;
    if (!expectedCreatedAt) return;
    // A delayed final save belongs to this entity, even if its ID has since
    // been reused. The store checks the captured identity atomically.
    const writer = createStateWriter(state => save({ boardId, expectedCreatedAt, state }).then(() => undefined), error => setMessage(`保存交互状态失败：${errorMessage(error)}`));
    stateWriter.current = writer;
    return () => { writer.dispose(); if (stateWriter.current === writer) stateWriter.current = null; };
  }, [save, boardId, board?.createdAt]);
  useEffect(() => { setFrameError(null); }, [board?.canvas.documentVersion]);
  useEffect(() => {
    const persisted = new Set(board?.interactions.map(item => item.id));
    setOptimistic(items => items.some(item => persisted.has(item.id)) ? items.filter(item => !persisted.has(item.id)) : items);
  }, [board?.interactions]);
  useEffect(() => () => {
    if (!pending.current) composeRef.current?.resolve?.({ status: "cancelled" });
  }, []);
  const cancelCompose = () => {
    if (pending.current) return;
    const draft = composeRef.current;
    if (draft && !persistCompose(draft, false) && canRenderFrames) return;
    if (draft?.selectionId) setSelectionCaptureCancelId(draft.selectionId);
    draft?.resolve?.({ status: "cancelled" }); setCompose(null); composeRef.current = null;
    setMessage(null);
  };
  const discardCompose = () => {
    if (pending.current || !composeRef.current) return;
    const draft = composeRef.current;
    if (!removeDraft(draft)) return;
    if (draft.selectionId) setSelectionCaptureCancelId(draft.selectionId);
    draft.resolve?.({ status: "cancelled" }); composeRef.current = null; setCompose(null);
    setMessage(null); setDraftError(null); setAnchor(undefined); setSelectionClearToken(value => value + 1);
  };
  const stageCompose = (): StoredDraft[] | undefined => {
    const current = composeRef.current;
    if (!current?.text.trim() || pending.current || current.intentId || current.sourceInteractionId) return;
    const next: Compose = { ...current, queuedAt: current.queuedAt ?? Date.now() };
    if (next.captureStatus === "pending") {
      next.captureStatus = "omitted";
      if (next.anchor?.image) next.anchor = { ...next.anchor, image: undefined };
    }
    try {
      const pendingBatches = batchStore.list();
      if (pendingBatches.issues.length) throw new Error(pendingBatches.issues[0]);
      const drafts = draftStore.list();
      if (drafts.issues.length) throw new Error(drafts.issues[0].message);
      const other = queuedDrafts(drafts.drafts, pendingBatches.batches).filter(item => item.id !== next.draftId);
      createCommentBatch([...other, { id: next.draftId ?? "preview", revision: next.draftRevision ?? "preview", compose: { ...next, captureStatus: next.captureStatus }, open: false, queuedAt: next.queuedAt, updatedAt: Date.now(), position: popoverPointRef.current }], "preview", "main");
    } catch (error) { setMessage(errorMessage(error)); return; }
    if (!persistCompose(next, false)) return;
    if (next.selectionId) setSelectionCaptureCancelId(next.selectionId);
    composeRef.current = null; setCompose(null); setAnchor(undefined); setSelectedInteractionId(undefined);
    setSelectionClearToken(value => value + 1); setMessage(null); setBatchError(null);
    try { next.resolve?.({ status: "queued", outcome: "已加入待发送列表，尚未发送给 agent" }); } catch { /* authored callbacks cannot roll back durable comments */ }
    return queuedDrafts(draftStore.list().drafts, batchStore.list().batches);
  };
  const stageMessage = () => {
    const current = composeRef.current;
    if (!current?.text.trim() || pending.current) return;
    if (current.intentId) { setMessage("这条发送的结果尚待核对；请重试原发送，不能重新加入待发送。"); return; }
    if (current.sourceInteractionId) {
      closePopover();
      if (composeRef.current) return;
      setMessage("追问草稿已保存，尚未发送；从草稿继续可保留原讨论。追问不并入待发送评论。");
      return;
    }
    stageCompose();
  };
  const openCompose = (kind: Compose["kind"], source?: Interaction, text?: string, resolve?: Compose["resolve"]) => {
    if (pending.current || composeRef.current) { resolve?.({ status: "cancelled", outcome: "另一条输入尚未关闭" }); return; }
    setDrawer(null);
    const draft: Compose = { kind: "question", text: text ?? (kind === "return" ? "请考虑这段讨论的结论，并把适用的修改落实到主线。说明采纳了哪些内容，以及未采纳的理由。" : ""), anchor: source?.anchor ?? anchor ?? (board ? { kind: "board", boardRevision: board.revision, canvasRevision: board.canvas.revision } : undefined), sourceInteractionId: source?.id, resolve };
    if (!source || !selectedInteractionId) setPopoverPoint(anchorPoint(draft.anchor));
    setSelectedInteractionId(source ? interactionRoot(source.id, interactions) : undefined); setMessage(null);
    changeCompose(draft, !source || !selectedInteractionId ? anchorPoint(draft.anchor) : popoverPointRef.current);
  };
  const retryUnconfirmed = (item: Interaction) => {
    if (pending.current || composeRef.current) return;
    if (item.comments) { setDrawer("drafts"); return; }
    const draft: Compose = { kind: item.kind, text: item.text, intentId: item.id, expectedCreatedAt: item.expectedCreatedAt, destination: item.destination, sideContext: item.sideContext, anchor: item.anchor, sourceInteractionId: item.sourceInteractionId };
    changeCompose(draft); setMessage(null);
  };
  // A Side that failed before creation has no agent to continue with: start a new send with the same words and location.
  const resendFailed = (item: Interaction) => {
    if (pending.current || composeRef.current || item.comments || !item.sideNotCreated) return;
    const draft: Compose = { kind: "question", text: item.text, anchor: item.anchor };
    setSelectedInteractionId(undefined); setPopoverPoint(anchorPoint(draft.anchor)); setMessage(null);
    changeCompose(draft, anchorPoint(draft.anchor)); setInputFocusToken(value => value + 1);
  };
  // A grouped Side that failed before creation: its comments go back to the pending queue to be sent again.
  const restoreFailedComments = (item: Interaction) => {
    if (pending.current || composeRef.current || !item.comments || !item.sideNotCreated || !board) return;
    const result = restoreBatchComments(draftStore, item, { expectedCreatedAt: board.createdAt, position: anchorPoint });
    setSelectedInteractionId(undefined); setMessage(null);
    if (result.message) setBatchError(result.message);
    setDrawer("drafts");
  };
  const submit = async (destination: Destination = "main") => {
    const draft = composeRef.current;
    if (!draft?.text.trim() || pending.current || sideChoicePending.current || !board?.ownerAgentId) return;
    if (draft.expectedCreatedAt && draft.expectedCreatedAt !== board.createdAt) { setMessage("画板已被替换；原输入已保留，请重新核对来源后评论。"); return; }
    // An uncertain send retries its immutable route and ID. Changing text starts a new intent.
    if (draft.intentId && destination !== draft.destination) return;
    draft.queuedAt = undefined;
    // The visible choice is frozen with the route; a retry keeps its original value.
    if (!draft.intentId) draft.sideContext = destination !== "main" && sideContext === "owner-history" ? "owner-history" : undefined;
    draft.destination = destination;
    pending.current = true; setSending(true); setMessage(null);
    if (!draft.intentId) draft.expectedCreatedAt ??= board.createdAt;
    draft.intentId ??= localId("intent");
    // Sending fixes this exact payload, including the explicit decision not to await pixels.
    if (draft.selectionId) setSelectionCaptureCancelId(draft.selectionId);
    if (draft.captureStatus === "pending") draft.captureStatus = "omitted";
    if (!persistCompose(draft) && canRenderFrames) {
      pending.current = false; setSending(false);
      setMessage("尚未发送：请先恢复本机草稿存储，再重试同一次发送。");
      setCompose({ ...draft });
      return;
    }
    const now = new Date().toISOString();
    const submitted = { expectedCreatedAt: draft.expectedCreatedAt, intentId: draft.intentId, kind: draft.kind, destination, text: draft.text.trim(), anchor: draft.anchor, sourceInteractionId: draft.sourceInteractionId, ...(draft.sideContext ? { sideContext: draft.sideContext } : {}) };
    const local: Interaction = { id: submitted.intentId, expectedCreatedAt: submitted.expectedCreatedAt, kind: submitted.kind, destination, text: submitted.text, anchor: submitted.anchor, sourceInteractionId: submitted.sourceInteractionId, ...(draft.sideContext ? { sideContext: draft.sideContext } : {}), status: "sending", resultReferences: [], createdAt: now, updatedAt: now };
    setOptimistic(items => [...items.filter(item => item.id !== local.id), local]);
    setSelectedInteractionId(interactionRoot(draft.sourceInteractionId ?? draft.intentId, interactions));
    try {
      const result = await send({ boardId, ...submitted });
      if (!acceptedDraftInteraction(submitted, [result])) throw new Error("返回的发送记录与这条评论不一致；原发送已保留，请稍后核对。");
      setOptimistic(items => items.map(item => item.id === result.id ? result : item));
      draft.resolve?.({ status: "submitted", outcome: statusNames[result.status] });
      removeDraft(draft);
      setCompose(null); composeRef.current = null;
      setAnchor(undefined); setSelectionClearToken(value => value + 1); void query.refetch();
    } catch (error) {
      const message = errorMessage(error); setMessage(message);
      setOptimistic(items => items.map(item => item.id === local.id ? { ...item, status: "failed", error: message } : item));
    }
    finally { pending.current = false; setSending(false); }
  };
  const submitBatch = async (destination: Destination = "main", retry?: CommentBatch, reviewed = staged.map(({ id, revision }) => ({ id, revision }))) => {
    if (pending.current || composeRef.current || sideChoicePending.current || !board?.ownerAgentId) return;
    pending.current = true; setSending(true); setBatchError(null);
    let batch: CommentBatch;
    try {
      batch = retry ?? await prepareCommentBatch({ hostId: host.id, boardId, expectedCreatedAt: board.createdAt, sideContext }, draftStore, batchStore, destination, localId("batch"), reviewed);
      if (batch.expectedCreatedAt && batch.expectedCreatedAt !== board.createdAt) throw new Error("画板已被替换；原发送记录已保留，不能发送给新画板。");
      if (acceptedBatchInteraction(batch, board.interactions)) {
        const cleaned = reconcileBatchDrafts(batch, draftStore), removed = cleaned.ok ? batchStore.remove(batch) : cleaned;
        if (!removed.ok) throw new Error(removed.message);
        pending.current = false; setSending(false); setBatchError(null); return;
      }
      const saved = retry ? batchStore.put(batch) : { ok: true } as const;
      if (!saved.ok) throw new Error(saved.message);
    } catch (error) { pending.current = false; setSending(false); setBatchError(errorMessage(error)); return; }
    const now = new Date().toISOString();
    const local: Interaction = { id: batch.intentId, kind: "change", destination: batch.destination, text: batch.text, comments: batch.comments, ...(batch.sideContext ? { sideContext: batch.sideContext } : {}), status: "sending", resultReferences: [], createdAt: now, updatedAt: now };
    setOptimistic(items => [...items.filter(item => item.id !== local.id), local]);
    try {
      const result = await send({ boardId, expectedCreatedAt: batch.expectedCreatedAt, intentId: batch.intentId, kind: "change", destination: batch.destination, text: batch.text, comments: batch.comments, ...(batch.sideContext ? { sideContext: batch.sideContext } : {}) });
      if (!acceptedBatchInteraction(batch, [result])) throw new Error("返回的发送记录与这组评论不一致；原发送已保留，请稍后核对。");
      setOptimistic(items => items.map(item => item.id === result.id ? result : item));
      const cleaned = reconcileBatchDrafts(batch, draftStore), removed = cleaned.ok ? batchStore.remove(batch) : cleaned;
      if (!removed.ok) setBatchError(removed.message);
      else { setDrawer(null); setSelectedInteractionId(interactionMarkerId(result.id, result.comments![0].id)); setPopoverPoint({ x: 24, y: 24 }); }
      void query.refetch();
    } catch (error) {
      const message = errorMessage(error); setBatchError(message);
      setOptimistic(items => items.map(item => item.id === local.id ? { ...item, status: "failed", error: message } : item));
    } finally { pending.current = false; setSending(false); }
  };
  const submitMain = async () => {
    const current = composeRef.current;
    if (!current?.text.trim() || pending.current || sideChoicePending.current || !board?.ownerAgentId) return;
    // Unknown sends keep their original ID, payload and route; a shortcut never drains new comments into a retry.
    if (current.intentId) { await submit("main"); return; }
    const drafts = draftStore.list(), outbox = batchStore.list();
    if (drafts.issues.length || outbox.issues.length) { setMessage(outbox.issues[0] ?? drafts.issues[0].message); return; }
    const other = queuedDrafts(drafts.drafts, outbox.batches).filter(item => item.id !== current.draftId);
    if (!other.length) { await submit("main"); return; }
    if (current.sourceInteractionId) { setMessage("这条追问需要保留原讨论，不能与其他位置的评论合并。请先收起追问并处理待发送评论，再发送追问。"); return; }
    // Persistence and the reviewed queue snapshot happen synchronously before the cross-window lock.
    // Do not read React's previous render of `staged` after adding this current comment.
    const reviewed = stageCompose();
    if (!reviewed) return;
    setDrawer("drafts");
    await submitBatch("main", undefined, reviewed.map(({ id, revision }) => ({ id, revision })));
  };
  const chooseSideContext: SideContextChange = (value, options = {}) => {
    if (value !== sideContext) { setSideContext(value); sideContexts.write(value); }
    // Keep Option/Alt+Enter working after a click, including a click on the already-checked option:
    // return focus to the message input. Arrow keys inside the radio group keep focus there.
    if (composeRef.current && !options.keepFocus) setInputFocusToken(next => next + 1);
  };
  const sideExists = Boolean(board?.sideAgentId || board?.pendingSideInteractionId);
  // A retry shows (and its hotkeys use) its frozen choice; a new send uses the per-Board preference.
  const composeSideContext = compose ? visibleSideContext(compose, sideContext) : sideContext;
  const sideTags = useMemo(() => new Map(interactions.flatMap(item => {
    const tag = sideHistoryTag(item);
    return tag ? [[item.id, { tag, description: sideProvenance(item) ?? tag }] as const] : [];
  })), [interactions]);
  const releaseSideChoice = () => {
    sideChoicePending.current = false; setChoosingSide(false); setSideChoiceUncertain(false);
    if (composeRef.current) setInputFocusToken(value => value + 1);
  };
  const verifySideChoice = async () => {
    setChoosingSide(true);
    try {
      const result = await query.refetch();
      if (result.isError || !result.data) throw result.error ?? new Error("Board 状态暂不可用");
      query.accept(result.data); releaseSideChoice();
      return true;
    } catch (error) {
      setSideChoiceUncertain(true); setChoosingSide(false);
      setMessage(`Side 目标待核对，暂不发送：${errorMessage(error)}`);
      return false;
    }
  };
  const chooseSideAgent = async (agentId: string) => {
    if (!board || pending.current || sideChoicePending.current || composeRef.current?.intentId) return false;
    if (agentId === board.sideAgentId && !board.pendingSideInteractionId) { setInputFocusToken(value => value + 1); return true; }
    sideChoicePending.current = true; setChoosingSide(true); setMessage(null);
    try {
      query.accept(await selectSide({ boardId, agentId, expectedRevision: board.revision, eventId: localId("side-agent") }));
      releaseSideChoice(); return true;
    } catch (error) {
      // The server may have saved the choice before its response was lost. Do not
      // unlock sends against the old displayed target until a fresh read succeeds.
      setSideChoiceUncertain(true); setMessage(errorMessage(error));
      await verifySideChoice(); return false;
    }
  };
  const openInteraction = (id: string, position?: Point, location?: InteractionLocation) => {
    if (pending.current || composeRef.current) return;
    const item = interactions.find(item => item.id === markerInteractionId(id, interactions));
    if (!item) return;
    setSelectedInteractionId(id === item.id ? interactionRoot(id, interactions) : id); setPopoverPoint(position ?? anchorPoint(item.anchor)); setDrawer(null); setMessage(null);
    setInteractionLocation(location ? { id, location } : undefined);
  };
  const locateInteraction = (id: string) => {
    if (pending.current || composeRef.current) return;
    const root = interactionRoot(markerInteractionId(id, interactions), interactions);
    const marker = markers.find(item => item.id === id) ?? markers.find(item => markerInteractionId(item.id, interactions) === root);
    if (!marker) return;
    // The rail is independent of DOM visibility. Open at a neutral canvas edge until the
    // frame supplies the current bound location (or its explicit unavailable fallback).
    openInteraction(marker.id, { x: Math.max(24, width - 24), y: 24 });
    setFocusInteraction(previous => ({ id: marker.id, token: (previous?.token ?? 0) + 1 }));
  };
  const closePopover = () => { if (!pending.current) { cancelCompose(); setSelectedInteractionId(undefined); } };
  const leaveBoard = (navigate: () => void) => {
    if (composeRef.current) cancelCompose();
    if (!composeRef.current && !pending.current) navigate();
  };
  usePopoverDismiss(!embedded && Boolean(compose || selectedInteractionId), closePopover, !embedded && Boolean(compose));
  const updateDecision = async (decision: Decision, status: "questioned" | "dismissed") => {
    if (!board) return;
    try { query.accept(await record({ boardId, expectedRevision: board.revision, eventId: localId("decision"), decision: { ...decision, status } })); }
    catch (error) { setMessage(errorMessage(error)); void query.refetch(); }
  };
  const selectedText = anchor ? anchor.text || ({ point: "指定位置", region: "框选区域", element: "页面元素", board: "整个画布", text: "选中文字" }[anchor.kind]) : "整个画布";
  if (!board && embedded) return null;
  if (!board) return <ScrollView contentContainerStyle={{ padding: 24, gap: 16, backgroundColor: c.surface0 }}>
    <Action label="所有 Boards" onPress={() => leaveBoard(onBack)} />
    <Notice text={query.isPending ? "正在打开…" : query.error ? "暂时无法连接 Board；本机草稿仍可查看和编辑，恢复连接后再发送。" : "这块 Board 不存在；本机草稿仍保留。"} error={!!query.error} />
    {query.error ? <Action label="重试连接" onPress={() => { void query.refetch(); }} /> : null}
    {compose ? <View testID="board-offline-draft" style={{ gap: 12 }}>
      <AnchorPreview anchor={compose.anchor} compact captureStatus={compose.captureStatus} />
      {canRenderFrames ? <WebMessageInput value={compose.text} disabled={false} onChange={changeDraftText} onStage={stageMessage} onSubmit={() => { setMessage("连接恢复后才能发送；草稿已保留。"); }} onClose={closePopover} placeholder="继续编辑草稿…" style={{ color: c.foreground, background: c.surface1, border: `1px solid ${c.border}`, padding: 10, minHeight: 120 }} /> : <TextInput accessibilityLabel="发给 agent 的消息" multiline value={compose.text} onChangeText={changeDraftText} />}
      {draftError || message ? <Notice error text={draftError ?? message ?? ""} /> : null}
      <View style={{ flexDirection: "row", gap: 8 }}><Action label="收起" testID="board-draft-dismiss" onPress={closePopover} /><Action label="丢弃草稿" testID="board-draft-discard" onPress={discardCompose} /></View>
    </View> : <View testID="board-offline-drafts" style={{ gap: 16 }}>
      {availableDrafts.map(saved => <View key={saved.revision} testID={`board-draft-row-${saved.id}`} style={{ gap: 6 }}>
        <Copy>{saved.compose.text || "尚未输入文字"}</Copy><Copy small muted>{saved.compose.anchor?.selector ?? "整个画布"}</Copy>
        {saved.queuedAt !== undefined ? <Copy small muted>待统一发送</Copy> : null}
        <Action label="继续编辑" onPress={() => restoreDraft(saved)} />
      </View>)}
      {batchSnapshot.batches.map(batch => <View key={batch.intentId} testID={`board-offline-batch-${batch.intentId}`} style={{ gap: 8 }}>
        <Copy>发送结果待核对 · {batch.comments.length} 条评论</Copy>
        {batch.comments.map((comment, index) => <View key={comment.id} style={{ gap: 4 }}><Copy>{index + 1}. {comment.text}</Copy><AnchorPreview anchor={comment.anchor} compact /></View>)}
        <Copy small muted>恢复连接后可核对或重试原发送；不会自动重发。</Copy>
      </View>)}
      {batchSnapshot.issues.map((issue, index) => <Notice key={`batch-${index}`} error text={issue} />)}
      {draftSnapshot.issues.map((issue, index) => <Notice key={index} error text={issue.message} />)}
    </View>}
  </ScrollView>;
  return <View testID={embedded ? undefined : "board-screen"} style={embedded ? { width: 0, height: 0, overflow: "visible" } : { flex: 1, minHeight: 0, backgroundColor: c.surface0 }}>
    {!embedded ? <BoardToolbar board={board} onAccepted={query.accept} onRefresh={query.refetch} onBack={() => leaveBoard(onBack)}
      selectionMode={selectionMode} onSelectionModeChange={setSelectionMode} canSelect={canRenderFrames}
      anchor={anchor} selectedText={selectedText} onClearReference={() => { setAnchor(undefined); setSelectionClearToken(value => value + 1); }}
      updateNavigation={updateNavigation} onOpenDrawer={setDrawer} onCompose={() => openCompose("question")}
      draftCount={availableDrafts.length + batchSnapshot.batches.length} draftIssue={draftSnapshot.issues.length > 0 || batchSnapshot.issues.length > 0 || Boolean(draftError || batchError)}
      onPublish={() => { if (composeRef.current) cancelCompose(); if (!composeRef.current && !pending.current) { setDrawer(null); setReleaseIntent("publish"); setReleaseOpen(true); } }}
      share={{ ...shareSummary(shareStatus.shares), available: shareStatus.shares.length > 0 }}
      onUpdateShare={() => { if (composeRef.current) cancelCompose(); if (!composeRef.current && !pending.current) { setDrawer(null); setReleaseIntent("update"); setReleaseOpen(true); } }}
      live={liveSummary(liveStatus.data)}
      onLiveData={() => { if (composeRef.current) cancelCompose(); if (!composeRef.current && !pending.current) { setDrawer(null); setLiveOpen(true); } }}
      onInbox={() => { if (composeRef.current) cancelCompose(); if (!composeRef.current && !pending.current) { setDrawer(null); setInboxOpen(true); } }}
      onOpenDrafts={() => { if (composeRef.current) cancelCompose(); if (!composeRef.current) setDrawer("drafts"); }}
      sourceCount={sources.data?.sources.length} onSources={sources.enabled ? () => setSourcesOpen(true) : undefined} /> : null}
    <View testID="board-stage" style={embedded ? { width: 0, height: 0 } : { flex: 1, minHeight: 180, flexDirection: "row" }} onLayout={event => setStageWidth(event.nativeEvent.layout.width)}>
    <View testID="board-canvas-container" style={embedded ? { width: 0, height: 0, overflow: "visible" } : { flex: 1, minWidth: 0, minHeight: 180, position: "relative", overflow: "hidden" }} onLayout={event => { setHeight(Math.max(180, event.nativeEvent.layout.height)); setWidth(event.nativeEvent.layout.width); }}>
      {canRenderFrames ? <CanvasFrame key={board.createdAt} composition={composition} embeddedMount={embedded?.mount} viewScope={JSON.stringify([host.id, boardId, viewInstance])} boardId={board.id} title={board.title} canvas={board.canvas} boardRevision={board.revision} userState={board.userState} theme={frameTheme} height={height} resumeView={viewSession.saved?.view} onViewState={onViewState} onFinalViewState={onFinalViewState} onViewRestored={onViewRestored} selectionMode={selectionMode} selectionClearToken={selectionClearToken} selectionCaptureCancelId={selectionCaptureCancelId} interactions={interactions} selectedInteractionId={selectedInteractionId} focusInteraction={focusInteraction} focusUpdate={updateNavigation.request} composerActive={updatesBlocked} presetKeys={!embedded && !updatesBlocked && !inboxOpen ? { fromBody: (entryScope?.surface ?? "screen") === "screen" } : undefined} onUpdatePosition={updateNavigation.onPosition} onCanvasActivity={updateNavigation.onActivity} onOpenInteraction={openInteraction} onInteractionPosition={(id, point, location) => { if (id === selectedInteractionId) { if (!composeRef.current) setPopoverPoint(point); setInteractionLocation(location ? { id, location } : undefined); } }} onAnchor={onAnchor} onAsk={onAsk} onCompose={onCompose} onSelectionCapture={onSelectionCapture} onComponentEdit={request => {
        if (composeRef.current || pending.current) return Promise.resolve({ status: "rejected", message: "交流草稿已保留，请先关闭输入框再编辑组件。" });
        return componentEditor.propose(request).then(result => { if (result.status === "applied") setSelectionMode("off"); return result; });
      }} onEditScopeChange={componentEditor.invalidate} onCanvasPointer={closePopover} onState={onState} onError={error => setFrameError(`${error.message}${error.patchId ? `（${error.patchId}）` : ""}`)} onSelectionEnd={() => setSelectionMode("off")} onSelectionClear={() => { setAnchor(undefined); setSelectionMode("off"); }} onOpenLink={url => { void openExternalUrl(url).catch(e => setMessage(errorMessage(e))); }} /> : <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}><Notice text="手机兼容视图。完整的自由画布、动画和页面交互在桌面版使用；这里可以查看摘要、决策并与 agent 交流。" /><Markdown>{typeof board.canvas.data.summary === "string" ? board.canvas.data.summary : "Agent 尚未提供文字摘要。你可以直接提问，回复会出现在讨论里。"}</Markdown></ScrollView>}
      {embedded ? <Modal title={`${board.title} · ${host.label} · 组件修改`} open={Boolean(componentEditor.draft)} onOpenChange={open => { if (!open) componentEditor.cancel(); }}><Modal.Content><BoardServicesBoundary services={services}>
        <ColorContext.Provider value={c}><ComponentEditPanel editor={componentEditor} inline /></ColorContext.Provider>
      </BoardServicesBoundary></Modal.Content></Modal> : <ComponentEditPanel editor={componentEditor} />}
      {!embedded && (query.error || query.liveError || frameError || (message && !compose && !selectedInteractionId)) ? <View style={{ position: "absolute", left: 8, right: 8, top: 8 }}><Notice error text={query.error ? "连接暂时中断。当前是上次收到的内容，尚未确认最新状态。" : query.liveError ? errorMessage(query.liveError) : frameError || message || ""} /></View> : null}
      {compose || selectedInteractionId ? <BoardComposerSurface embeddedTitle={embedded ? `${board.title} · ${host.label}` : undefined} onClose={closePopover} onHeight={setPopoverHeight} placement={popover}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 8, gap: 8, borderBottomWidth: 1, borderColor: c.border }}><Text style={{ color: c.foreground, fontWeight: "600", flex: 1 }}>{compose ? "发给 agent" : "这里的讨论"}</Text>{compose ? <Action testID="board-draft-dismiss" label="收起" disabled={sending} onPress={closePopover} /> : !canRenderFrames ? <Action label="关闭" disabled={sending} onPress={closePopover} /> : null}</View>
        <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ padding: 12, gap: 16 }} keyboardShouldPersistTaps="handled">
          {locationNote ? <View testID="board-interaction-location"><Copy small muted>{locationNote}</Copy></View> : null}
          {thread.map(item => <InteractionContent key={item.id} item={item} board={board} frameTheme={frameTheme} unconfirmed={!board.interactions.some(saved => saved.id === item.id)} onLocate={id => locateInteraction(interactionMarkerId(item.id, id))} onRetry={() => retryUnconfirmed(item)} onResend={() => resendFailed(item)} onRestoreComments={() => restoreFailedComments(item)} onFollow={(kind, text, resolve) => openCompose(kind, item, text, resolve)} onOpenAgent={() => { if (item.agentId && navigation) navigation.openAgent({ agentId: item.agentId, serverId: host.id }); }} />)}
          {compose ? <View style={{ gap: 10 }}>
            {!thread.length ? <AnchorPreview anchor={compose.anchor} compact captureStatus={compose.captureStatus} /> : null}
            {compose.captureStatus ? <View style={{ minHeight: 36 }}><Copy small muted>{compose.captureStatus === "pending" ? "截图准备中；现在发送会保留文字和位置，不附图片。" : compose.captureStatus === "failed" ? `截图失败：${captureFailureNames[compose.captureFailureReason ?? "generation-failed"]}文字和位置已保留。` : compose.captureStatus === "omitted" ? "此次发送不附图片，保留原来的文字和位置。" : "已附选区截图。"}</Copy></View> : null}
            {compose.anchor && compose.anchor.canvasRevision !== board.canvas.revision ? <Copy small muted>引用来自旧画布版本；agent 会对照原来的位置和快照。</Copy> : null}
            <SideAgentPicker interactions={board.interactions} selectedId={board.sideAgentId} pending={Boolean(board.pendingSideInteractionId)} disabled={sending || sideTargetBlocked || Boolean(compose.intentId)} onSelect={chooseSideAgent} />
            {compose.intentId && compose.destination === "main" ? null : <SideContextChoice value={composeSideContext} disabled={sending || sideTargetBlocked || Boolean(compose.intentId)} notes={sideContextNotes(composeSideContext, { frozen: Boolean(compose.intentId), sideExists })} onChange={chooseSideContext} />}
            {canRenderFrames ? <WebMessageInput value={compose.text} focusToken={inputFocusToken} disabled={sending || sideTargetBlocked} onChange={changeDraftText} onStage={stageMessage} onSubmit={destination => { void (destination === "main" ? submitMain() : submit(destination)); }} onClose={closePopover} placeholder="想了解什么？或希望这里发生什么变化？" style={{ color: c.foreground, background: c.surface1, border: `1px solid ${c.border}`, borderRadius: 8, padding: 10, minHeight: 80, fontSize: 14 }} /> : <TextInput autoFocus accessibilityLabel="发给 agent 的消息" value={compose.text} editable={!sending && !sideTargetBlocked} multiline maxLength={24000} onChangeText={changeDraftText} placeholder="想了解什么？或希望这里发生什么变化？" placeholderTextColor={c.foregroundMuted} style={{ color: c.foreground, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 80, textAlignVertical: "top" }} />}
            {draftError ? <Notice error text={`草稿未能保存在本机：${draftError} 当前输入仍保留，请先复制文字。`} /> : <Copy small muted>草稿保存在本机；收起或断线后可继续编辑。</Copy>}
            {!board.ownerAgentId ? <Notice error text="这块 Board 尚未关联负责的 agent。请让 agent 接管后再发送。" /> : null}
            {compose.intentId ? <Copy small muted>重试只沿原目标继续，不合并待发送评论；Enter 不会重新暂存。修改文字会另存新草稿，原发送仍保留待核对。</Copy> : null}
            {!compose.intentId && !compose.sourceInteractionId ? <Copy small muted>加入待发送后可继续评论其他位置，再从待发送清单一起发送。{compose.captureStatus === "pending" ? "现在加入会保留文字和位置，不附图片。" : ""}</Copy> : null}
            {/* JSX drops a bare line break after an expression, so the break between the two hint lines must be explicit. */}
            <Copy small muted>{compose.sourceInteractionId ? "Enter 保存追问草稿 · ⌘ / Ctrl + Enter 发送追问（须先处理待发送评论）" : "Enter 加入待发送 · ⌘ / Ctrl + Enter 当前评论和待发送评论一起发主会话"}{"\n"}Option / Alt + Enter 当前评论发 Side · Option / Alt + Shift + Enter 新 Side（{composeSideContext === "owner-history" ? "带主 agent 记录" : "空白"}）· Shift+Enter 换行</Copy>
          </View> : null}
        </ScrollView>
        {compose ? <View testID="board-compose-actions" style={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12, gap: 8, borderTopWidth: 1, borderColor: c.border }}>
          {/* The send row is a footer outside the scroller: a long thread, anchor preview or note can never push it out of view. */}
          {message ? <Notice error text={message} /> : null}
          {sideChoiceUncertain ? <Action label={choosingSide ? "正在核对 Side 目标…" : "核对 Side 目标"} disabled={choosingSide} onPress={() => { void verifySideChoice().then(confirmed => { if (confirmed) setMessage(null); }); }} /> : null}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", flexShrink: 1, maxWidth: "100%" }}>
              <Action testID="board-draft-discard" label="丢弃草稿" disabled={sending} onPress={discardCompose} />
              {!compose.intentId && !compose.sourceInteractionId ? <Action testID="board-comment-stage" label={compose.queuedAt !== undefined ? "保存到待发送" : "加入待发送"} disabled={sending || !compose.text.trim()} onPress={stageCompose} /> : null}
            </View>
            <View testID="board-compose-send" style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", flexShrink: 1, maxWidth: "100%" }}>
              {compose.intentId ? <Action label={sending ? "发送中…" : "重试原发送"} disabled={sending || sideTargetBlocked || !compose.text.trim() || !board.ownerAgentId} primary onPress={() => { void submit(compose.destination ?? "main"); }} /> : <>
                <Action label={board.sideAgentId || board.pendingSideInteractionId ? "Side 发送" : "新建 Side 并发送"} icon="GitBranch" disabled={sending || sideTargetBlocked || !compose.text.trim() || !board.ownerAgentId} onPress={() => { void submit("side"); }} />
                {board.sideAgentId || board.pendingSideInteractionId ? <Action testID="board-compose-new-side" label="新建 Side 并发送" disabled={sending || sideTargetBlocked || !compose.text.trim() || !board.ownerAgentId} onPress={() => { void submit("new-side"); }} /> : null}
                <Action label={staged.some(item => item.id !== compose.draftId) ? "主会话统一发送" : "主会话发送"} disabled={sending || sideTargetBlocked || !compose.text.trim() || !board.ownerAgentId} primary onPress={() => { void submitMain(); }} />
              </>}
            </View>
          </View>
        </View> : null}
      </BoardComposerSurface> : null}
    </View>
    {canRenderFrames && !embedded ? <DiscussionRail markers={markers} tags={sideTags} compact={stageWidth < 720} selectedId={selectedInteractionId} disabled={sending || Boolean(compose)} statusNames={statusNames} onOpen={locateInteraction} /> : null}
    </View>
    {!embedded ? <View style={{ paddingHorizontal: 12, paddingVertical: 5, borderTopWidth: 1, borderColor: c.border, flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}><BoardConnectionStatus status={query.error ? "disconnected" : query.liveStatus} /><Copy small muted>r{board.revision} · {timeLabel(board.updatedAt)}</Copy></View>
      {staged.length || batchSnapshot.batches.length || batchSnapshot.issues.length ? <Action testID="board-comments-open" label={staged.length ? `待发送 ${staged.length} 条` : "核对评论发送"} disabled={sending} onPress={() => { if (composeRef.current) cancelCompose(); if (!composeRef.current) setDrawer("drafts"); }} /> : null}
    </View> : null}
    {!embedded ? <>
      <CompositionSourceSync parent={sourceRef} controller={sources} />
      <CompositionEmbeds parent={sourceRef} parentCreatedAt={board.createdAt} mounts={compositionMounts} sources={sources.data} theme={theme} layout={layout} navigation={navigation} />
      <Modal title="组合来源" open={sourcesOpen} onOpenChange={setSourcesOpen}><Modal.Content><BoardServicesBoundary services={services}>
        <ColorContext.Provider value={c}>{sourcesOpen ? <CompositionSourcesPanel parent={sourceRef} controller={sources} /> : null}</ColorContext.Provider>
      </BoardServicesBoundary></Modal.Content></Modal>
    </> : null}
    <Modal title="评论收件箱" open={inboxOpen} onOpenChange={setInboxOpen}><Modal.Content><BoardServicesBoundary services={services}>
      <ColorContext.Provider value={c}>{inboxOpen ? <BoardInbox key={JSON.stringify([host.id, board.id, board.createdAt])} hostId={host.id} scope={{ boardId: board.id, expectedCreatedAt: board.createdAt }} /> : null}</ColorContext.Provider>
    </BoardServicesBoundary></Modal.Content></Modal>
    <Modal title="实时公开数据" open={liveOpen} onOpenChange={setLiveOpen}><Modal.Content><BoardServicesBoundary services={services}>
      <ColorContext.Provider value={c}>{liveOpen ? <LiveDataPanel key={JSON.stringify([host.id, board.id, board.createdAt])} board={board} hostId={host.id} live={liveStatus} shares={shareStatus} /> : null}</ColorContext.Provider>
    </BoardServicesBoundary></Modal.Content></Modal>
    <Modal title="导出与发布" open={releaseOpen} onOpenChange={setReleaseOpen}><Modal.Content><BoardServicesBoundary services={services}>
      <ColorContext.Provider value={c}>
      {releaseOpen ? <ReleasePanel board={board} hostId={host.id} intent={releaseIntent} shares={shareStatus} live={liveStatus} onOpenBoard={id => leaveBoard(() => { setReleaseOpen(false); if (onOpenBoard) onOpenBoard(id); else onBack(); })} /> : null}
      </ColorContext.Provider>
    </BoardServicesBoundary></Modal.Content></Modal>
    <Modal title={drawer === "decisions" ? "Agent 做过的默认决策" : drawer === "threads" ? "围绕画布的讨论" : drawer === "drafts" ? "待发送与本机草稿" : "发生了什么变化"} open={drawer !== null} onOpenChange={open => { if (!open) setDrawer(null); }}><Modal.Content><BoardServicesBoundary services={services}>
      <ColorContext.Provider value={c}>
      {drawer === "decisions" ? <DecisionList board={board} onUpdate={updateDecision} onQuestion={decision => { if (composeRef.current) cancelCompose(); if (composeRef.current) return; setDrawer(null); const draft: Compose = { kind: "question", text: `关于这个 agent 决策：${decision.choice}\n\n`, anchor: { kind: "element", boardRevision: board.revision, canvasRevision: board.canvas.revision, text: decision.choice, selector: decision.related[0] } }; setSelectedInteractionId(undefined); setPopoverPoint(anchorPoint(draft.anchor)); changeCompose(draft, anchorPoint(draft.anchor)); }} /> : null}
      {drawer === "drafts" ? <View testID="board-drafts" style={{ gap: 16 }}>
        <Copy small muted>只保存在当前客户端，按主机和 Board 分开。继续编辑会保留原引用；不会自动发送。</Copy>
        {batchSnapshot.issues.map((issue, index) => <Notice key={`batch-${index}`} error text={issue} />)}
        {batchError ? <Notice error text={batchError} /> : null}
        {staged.length ? <View testID="board-comment-queue" style={{ gap: 12 }}>
          <Text style={{ color: c.foreground, fontWeight: "600" }}>待发送 · {staged.length} 条评论</Text>
          <Copy small muted>这些评论会作为一组修改要求一起发送，保留各自的位置和截图。</Copy>
          {staged.map((saved, index) => <View key={saved.revision} testID={`board-queued-comment-${saved.id}`} style={{ gap: 8, paddingBottom: 12, borderBottomWidth: 1, borderColor: c.border }}>
            <Copy>{index + 1}. {saved.compose.text}</Copy><AnchorPreview anchor={saved.compose.anchor} compact captureStatus={saved.compose.captureStatus} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Action label="编辑" disabled={sending} onPress={() => restoreDraft(saved)} />
              <Action label="删除" disabled={sending} onPress={() => { const result = draftStore.remove(saved.id, saved.revision); if (!result.ok) setDraftError(result.issue.message); }} />
            </View>
          </View>)}
          <SideAgentPicker interactions={board.interactions} selectedId={board.sideAgentId} pending={Boolean(board.pendingSideInteractionId)} disabled={sending || sideTargetBlocked} onSelect={chooseSideAgent} />
          <SideContextChoice testID="board-batch-side-context" value={sideContext} disabled={sending || sideTargetBlocked} notes={sideContextNotes(sideContext, { frozen: false, sideExists })} onChange={chooseSideContext} />
          {sideChoiceUncertain ? <Action label={choosingSide ? "正在核对 Side 目标…" : "核对 Side 目标"} disabled={choosingSide} onPress={() => { void verifySideChoice(); }} /> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Action testID="board-comments-send-main" label="统一发送到主会话" primary disabled={sending || sideTargetBlocked || !board.ownerAgentId} onPress={() => { void submitBatch("main"); }} />
            <Action testID="board-comments-send-side" label={board.sideAgentId || board.pendingSideInteractionId ? "统一发送到 Side" : "新建 Side 并统一发送"} disabled={sending || sideTargetBlocked || !board.ownerAgentId} onPress={() => { void submitBatch("side"); }} />
            {board.sideAgentId || board.pendingSideInteractionId ? <Action testID="board-comments-send-new-side" label="新建 Side 并统一发送" disabled={sending || sideTargetBlocked || !board.ownerAgentId} onPress={() => { void submitBatch("new-side"); }} /> : null}
          </View>
        </View> : null}
        {batchSnapshot.batches.map(batch => <View key={batch.intentId} testID={`board-comment-batch-${batch.intentId}`} style={{ gap: 10, paddingBottom: 14, borderBottomWidth: 1, borderColor: c.border }}>
          <Copy>{acceptedBatchIds.has(batch.intentId) ? "评论已接收，正在清理本机记录" : "发送结果待核对"} · {batch.comments.length} 条 · {batch.destination === "main" ? "主会话" : batch.destination === "new-side" ? "新 Side" : "Side"}{batch.sideContext ? ` · ${SIDE_CONTEXT_LABELS[batch.sideContext]}` : ""}</Copy>
          {batch.comments.map((comment, index) => <View key={comment.id} style={{ gap: 6 }}>
            <Copy>{index + 1}. {comment.text}</Copy><AnchorPreview anchor={comment.anchor} compact />
            <Action label="另存并编辑" disabled={sending} onPress={() => { if (composeRef.current || pending.current) return; setDrawer(null); setSelectedInteractionId(undefined); const next: Compose = { kind: "question", text: comment.text, anchor: comment.anchor, queuedAt: Date.now() }; setPopoverPoint(anchorPoint(next.anchor)); changeCompose(next, anchorPoint(next.anchor)); }} />
          </View>)}
          <Copy small muted>原内容和发送目标已固定。另存编辑会建立新草稿，原发送保留待核对。</Copy>
          <Action testID={`board-comments-retry-${batch.intentId}`} label={sending ? "发送中…" : acceptedBatchIds.has(batch.intentId) ? "清理已接收记录" : "重试原发送"} disabled={sending || sideTargetBlocked || !board.ownerAgentId} onPress={() => { void submitBatch(batch.destination, batch); }} />
        </View>)}
        {draftSnapshot.issues.map((issue, index) => <Notice key={`${issue.code}-${index}`} error text={issue.message} />)}
        {draftError ? <Notice error text={draftError} /> : null}
        {!availableDrafts.length && !batchSnapshot.batches.length ? <Copy muted>没有待发送的草稿。</Copy> : null}
        {availableDrafts.filter(saved => !staged.some(item => item.revision === saved.revision)).map(saved => <View testID={`board-draft-row-${saved.id}`} key={saved.revision} style={{ borderBottomWidth: 1, borderColor: c.border, paddingBottom: 14, gap: 8 }}>
          <Text numberOfLines={2} style={{ color: c.foreground }}>{saved.compose.text || "尚未输入文字"}</Text>
          <Copy small muted>{saved.compose.anchor?.selector ?? saved.compose.anchor?.text ?? "整个画布"} · {timeLabel(new Date(saved.updatedAt).toISOString())}</Copy>
          {saved.conflicted ? <Notice text="另一窗口也修改了这份草稿；两个版本都已保留。" /> : null}
          {saved.compose.intentId ? <Copy small muted>上次发送结果待核对；继续时保留原发送编号和目标。</Copy> : null}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Action label="继续编辑" onPress={() => restoreDraft(saved)} />
            <Action label="丢弃" onPress={() => { const result = draftStore.remove(saved.id, saved.revision); if (!result.ok) setDraftError(result.issue.message); }} />
          </View>
        </View>)}
      </View> : null}
      {drawer === "threads" ? <View style={{ gap: 20 }}>
        {!board.interactions.length ? <Copy muted>指着画布提问、提出修改，或开一个独立讨论。交流会保留当时的引用和版本。</Copy> : null}
        {[...interactions].filter(item => interactionRoot(item.id, interactions) === item.id).reverse().map(interaction => <View key={interaction.id} style={{ borderBottomWidth: 1, borderColor: c.border, paddingBottom: 18, gap: 10 }}>
          <Copy small muted>{kindNames[interaction.kind]} · {statusNames[interactionThread(interaction.id, interactions).at(-1)?.status ?? interaction.status]} · {timeLabel(interaction.createdAt)}</Copy>
          {sideProvenance(interaction) ? <Copy small muted>{sideProvenance(interaction)}</Copy> : null}
          <Copy>{interaction.text}</Copy>
          <Action label="原位查看和继续交流" onPress={() => locateInteraction(interaction.id)} />
        </View>)}
      </View> : null}
      {drawer === "history" ? <View style={{ gap: 14 }}>{[...board.events].reverse().slice(0, 100).map(event => <View key={event.id} style={{ gap: 3 }}><Copy>{event.summary}</Copy><Copy muted small>r{event.revision} · {event.source} · {timeLabel(event.at)}</Copy></View>)}{!board.events.length ? <Copy muted>还没有变化。</Copy> : null}</View> : null}
      </ColorContext.Provider>
    </BoardServicesBoundary></Modal.Content></Modal>
  </View>;
}

function InteractionContent({ item, board, frameTheme, onFollow, onOpenAgent, unconfirmed, onRetry, onResend, onRestoreComments, onLocate }: {
  item: Interaction; board: Board; frameTheme: FrameTheme;
  onFollow(kind: Compose["kind"], text?: string, resolve?: Compose["resolve"]): void; onOpenAgent(): void; unconfirmed: boolean; onRetry(): void; onResend(): void; onRestoreComments(): void; onLocate(commentId: string): void;
}) {
  const c = useColors();
  const discussion = item.kind === "fork" || item.kind === "reply";
  const [showSnapshot, setShowSnapshot] = useState(false);
  const [visualState, setVisualState] = useState<JsonData>({});
  const [visualError, setVisualError] = useState<string>();
  const stale = item.anchor && item.anchor.canvasRevision !== board.canvas.revision;
  const follow = (text?: string) => onFollow(discussion ? "reply" : "question", text);
  const provenance = sideProvenance(item);
  return <View style={{ gap: 10, paddingBottom: 14, borderBottomWidth: 1, borderColor: c.border }}>
    <Copy small muted>{kindNames[item.kind]} · {statusNames[item.status]} · {timeLabel(item.createdAt)}</Copy>
    {provenance ? <View testID={`board-side-provenance-${item.id}`}><Copy small muted>{provenance}</Copy></View> : null}
    <Copy>{item.text}</Copy>
    {item.comments?.map((comment, index) => <View key={comment.id} testID={`board-sent-comment-${comment.id}`} style={{ gap: 6, paddingBottom: 8 }}>
      <Copy>{index + 1}. {comment.text}</Copy>
      {comment.anchor && comment.anchor.canvasRevision !== board.canvas.revision ? <Copy small muted>旧引用 · 画布 v{comment.anchor.canvasRevision}；保留评论时的位置和快照。</Copy> : null}
      {showSnapshot ? <AnchorPreview anchor={comment.anchor} compact /> : null}
      {comment.anchor ? <Action testID={`board-locate-comment-${comment.id}`} label={`定位第 ${index + 1} 条`} onPress={() => onLocate(comment.id)} /> : null}
    </View>)}
    {stale ? <Copy small muted>旧引用 · 画布 v{item.anchor!.canvasRevision}，当前 v{board.canvas.revision}。引用保留提问时内容；标记可跟随仍能确认的组件，请核对当前内容。</Copy> : null}
    {showSnapshot ? <AnchorPreview anchor={item.anchor} /> : null}
    {item.response ? <Markdown>{item.response}</Markdown> : null}
    {item.responseCanvas && canRenderFrames ? <View style={{ height: 260, borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: "hidden" }}>
      <CanvasFrame boardId={`${board.id}.response.${item.id}`} title="Agent 的可交互回答" canvas={item.responseCanvas} boardRevision={board.revision} userState={visualState} theme={frameTheme} height={260} selectionMode="off" onAnchor={() => undefined} onAsk={request => new Promise(resolve => onFollow(discussion ? "reply" : "question", visualQuestion(item, request), resolve))} onCompose={request => onFollow(discussion ? "reply" : "question", visualQuestion(item, request))} onState={setVisualState} onError={error => setVisualError(error.message)} onOpenLink={url => { void openExternalUrl(url).catch(error => setVisualError(errorMessage(error))); }} />
    </View> : null}
    {item.responseCanvas && !canRenderFrames ? <Copy small muted>这条回复包含可交互图解，请在桌面查看。</Copy> : null}
    {item.error || visualError ? <Notice error text={item.error || visualError || ""} /> : null}
    {item.resultReferences.length ? <Copy small muted>依据：{item.resultReferences.join(" · ")}</Copy> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {item.anchor || item.comments?.some(comment => comment.anchor) ? <Action label={showSnapshot ? "收起原始引用" : "原始引用"} onPress={() => setShowSnapshot(value => !value)} /> : null}
      {unconfirmed && item.status === "failed" ? <Action label="重试发送" onPress={onRetry} /> : null}
      {/* Only a journal-confirmed uncreated fork (sideNotCreated) can be sent again without risking a duplicate Side. */}
      {!unconfirmed && item.kind === "fork" && item.status === "failed" && !item.agentId && item.sideNotCreated ? item.comments
        ? <Action testID={`board-restore-comments-${item.id}`} label="放回待发送" onPress={onRestoreComments} />
        : <Action testID={`board-resend-${item.id}`} label="重新编辑发送" onPress={onResend} /> : null}
      {!unconfirmed && (!discussion || item.agentId) ? <Action label="继续交流" onPress={() => follow()} /> : null}
      {item.agentId ? <Action label="会话" onPress={onOpenAgent} /> : null}
    </View>
  </View>;
}

function AnchorPreview({ anchor, compact = false, captureStatus }: { anchor?: Anchor; compact?: boolean; captureStatus?: Compose["captureStatus"] }) {
  if (!anchor) return null;
  return <View style={{ gap: 6 }}><Copy muted small>引用 r{anchor.boardRevision} · {anchor.text || (anchor.kind === "point" ? "指定位置" : anchor.kind === "region" ? "框选区域" : "画布")}{anchor.rect ? ` · (${Math.round(anchor.rect.x)}, ${Math.round(anchor.rect.y)})` : ""}</Copy>{anchor.image ? <Image source={{ uri: `data:${anchor.image.mimeType};base64,${anchor.image.data}` }} resizeMode="contain" style={{ width: "100%", height: compact ? 72 : 150 }} accessibilityLabel="提问时的画面快照" /> : captureStatus ? <View style={{ height: compact ? 72 : 150, justifyContent: "center" }}><Copy small muted>{captureStatus === "pending" ? "截图准备中…" : "未附图片"}</Copy></View> : null}</View>;
}

function DecisionList({ board, onUpdate, onQuestion }: { board: Board; onUpdate(decision: Decision, status: "questioned" | "dismissed"): Promise<void>; onQuestion(decision: Decision): void }) {
  const c = useColors();
  const [showDismissed, setShowDismissed] = useState(false);
  const basisNames = { explicit: "Agent 明确记录", observed: "观察到的行为变化", inferred: "待核实的可能决策" };
  const decisions = board.decisions.filter(d => showDismissed || !["dismissed", "superseded"].includes(d.status)).sort((a, b) => Number(b.status === "questioned") - Number(a.status === "questioned") || b.updatedAt.localeCompare(a.updatedAt));
  return <View style={{ gap: 18 }}>
    <Copy muted>记录 agent 在工作途中自行作出的选择。推断与事实分开；没有说出的理由会标为“未说明”。</Copy>
    <Copy small muted>{board.extraction.lastCheckedAt ? `最近检查：${timeLabel(board.extraction.lastCheckedAt)}` : "尚未完成会话检查"}{board.extraction.note ? ` · ${board.extraction.note}` : ""}</Copy>
    {!decisions.length ? <Copy>尚无已记录的决策。这不代表 agent 没有作过默认选择。</Copy> : null}
    {decisions.map(decision => <View key={decision.id} style={{ gap: 8, paddingBottom: 16, borderBottomWidth: 1, borderColor: c.border }}>
      <Copy small muted>{basisNames[decision.basis]}{decision.status === "questioned" ? " · 已质疑" : decision.status === "dismissed" ? " · 已排除" : decision.status === "superseded" ? " · 已取代" : ""}</Copy>
      <Text selectable style={{ color: c.foreground, fontSize: 16, fontWeight: "600", lineHeight: 23 }}>{decision.choice}</Text>
      <Copy>{decision.rationale || "理由未说明"}</Copy>
      {decision.impact ? <Copy muted>影响：{decision.impact}</Copy> : null}
      {decision.evidence.map((evidence, i) => <View key={i} style={{ gap: 2 }}><Copy small muted>{evidence.kind} · {evidence.reference}</Copy>{evidence.excerpt ? <Copy small>{evidence.excerpt}</Copy> : null}</View>)}
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}><Action label="围绕这条决策提问" onPress={() => onQuestion(decision)} />{decision.status === "active" ? <Action label="标为有异议" onPress={() => { void onUpdate(decision, "questioned"); }} /> : null}{decision.basis === "inferred" ? <Action label="这不是一个决策" onPress={() => { void onUpdate(decision, "dismissed"); }} /> : null}</View>
    </View>)}
    <Action label={showDismissed ? "隐藏已排除与被取代的决策" : "查看已排除与被取代的决策"} onPress={() => setShowDismissed(value => !value)} />
  </View>;
}

/** Embedded canvases keep their actual iframe mounted inside the authored slot.
 * Only their trusted conversation UI is portalled into the host. */
function BoardComposerSurface({ embeddedTitle, onClose, onHeight, placement, children }: {
  embeddedTitle?: string; onClose(): void; onHeight(height: number): void;
  placement: ReturnType<typeof popoverPlacement>; children: ReactNode;
}) {
  const c = useColors();
  const services = useBoardServices();
  if (embeddedTitle) return <Modal title={embeddedTitle} open onOpenChange={open => { if (!open) onClose(); }}><Modal.Content><BoardServicesBoundary services={services}>
    <ColorContext.Provider value={c}><View testID="board-embedded-composer" style={{ maxHeight: 700 }}>{children}</View></ColorContext.Provider>
  </BoardServicesBoundary></Modal.Content></Modal>;
  return <View testID="board-local-popover" accessibilityLabel="原位交流" onLayout={event => onHeight(event.nativeEvent.layout.height)} style={{ position: "absolute", ...placement, borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.surface0, overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.22, shadowRadius: 16, shadowOffset: { width: 0, height: 5 }, elevation: 10 }}>{children}</View>;
}

function BoardServicesBoundary({ services, children }: { services?: BoardServices; children: ReactNode }) {
  return services ? <BoardServicesProvider services={services}>{children}</BoardServicesProvider> : <>{children}</>;
}
