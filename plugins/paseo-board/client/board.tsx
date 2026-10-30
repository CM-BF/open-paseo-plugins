import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Markdown, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { interactBoardRpc, recordDecisionRpc, saveStateRpc, type Anchor, type Board, type Decision, type Interaction, type JsonData } from "../shared/contracts";
import type { AskRequest, AskResult, ComposeRequest, FrameTheme, SelectionMode } from "../shared/frame-contract";
import { frameThemeFromColors } from "../shared/frame-theme";
import { CanvasFrame, WebMessageInput, canRenderFrames, usePopoverDismiss } from "./web";
import { Action, ColorContext, Copy, Notice, errorMessage, localId, timeLabel, useColors } from "./ui";
import { useBoard } from "./data";
import { createStateWriter } from "./state-writer";
import { anchorPoint, interactionRoot, interactionThread, mergeInteractions, popoverPlacement, visualQuestion, type Point } from "./interaction-layout";

interface Props extends PluginSurfaceProps { boardId: string; onBack(): void }
type Compose = { kind: Interaction["kind"]; text: string; intentId?: string; anchor?: Anchor; sourceInteractionId?: string; resolve?: (result: AskResult) => void };
const statusNames: Record<Interaction["status"], string> = { saved: "已保存", sending: "发送中", delivered: "已送达", processing: "处理中", answered: "已有回复", applied: "已落实", rejected: "未采用", failed: "失败" };
const kindNames: Record<Interaction["kind"], string> = { question: "消息", change: "消息", fork: "Fork", return: "转给主会话", reply: "Fork 回复" };

export function BoardView(props: Props) {
  return <ColorContext.Provider value={props.theme.colors}><BoardContent {...props} /></ColorContext.Provider>;
}
function BoardContent({ boardId, host, theme, onBack, navigation }: Props) {
  const c = useColors();
  const query = useBoard(host.id, boardId);
  const board = query.data;
  const send = useRpc(interactBoardRpc);
  const save = useRpc(saveStateRpc);
  const record = useRpc(recordDecisionRpc);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("off");
  const [anchor, setAnchor] = useState<Anchor>();
  const [selectionClearToken, setSelectionClearToken] = useState(0);
  const [drawer, setDrawer] = useState<"decisions" | "threads" | "history" | null>(null);
  const [compose, setCompose] = useState<Compose | null>(null);
  const composeRef = useRef(compose); composeRef.current = compose;
  const [sending, setSending] = useState(false);
  const pending = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [height, setHeight] = useState(500);
  const [width, setWidth] = useState(900);
  const [popoverHeight, setPopoverHeight] = useState(300);
  const [popoverPoint, setPopoverPoint] = useState<Point>({ x: 24, y: 24 });
  const [selectedInteractionId, setSelectedInteractionId] = useState<string>();
  const [optimistic, setOptimistic] = useState<Interaction[]>([]);
  const interactions = useMemo(() => mergeInteractions(board?.interactions ?? [], optimistic), [board?.interactions, optimistic]);
  const thread = useMemo(() => interactionThread(selectedInteractionId, interactions), [selectedInteractionId, interactions]);
  const popover = popoverPlacement(popoverPoint, { width, height }, popoverHeight);
  const stateWriter = useRef<ReturnType<typeof createStateWriter> | null>(null);
  const frameTheme = useMemo(() => frameThemeFromColors(theme.colors), [theme.colors]);
  const onAnchor = useCallback((next: Anchor) => { setAnchor(next); setSelectionMode("off"); }, []);
  const onAsk = useCallback((request: AskRequest): Promise<AskResult> => new Promise(resolve => {
    // A generated document cannot send a message. It can request this host-owned preview.
    if (composeRef.current || pending.current) { resolve({ status: "cancelled", outcome: "Another question is open" }); return; }
    const next: Compose = { kind: "question", text: request.prompt, anchor: request.anchor, resolve };
    setPopoverPoint(request.position ?? anchorPoint(request.anchor)); setSelectedInteractionId(undefined); setMessage(null);
    composeRef.current = next; setCompose(next);
  }), []);
  const onCompose = useCallback((request: ComposeRequest) => {
    if (composeRef.current || pending.current) return;
    const next: Compose = { kind: "question", text: "", anchor: request.anchor };
    setPopoverPoint(request.position ?? anchorPoint(request.anchor)); setSelectedInteractionId(undefined); setMessage(null);
    setAnchor(request.anchor); setSelectionMode("off"); setDrawer(null);
    composeRef.current = next; setCompose(next);
  }, []);
  const onState = useCallback((state: JsonData) => stateWriter.current?.schedule(state), []);
  useEffect(() => {
    const writer = createStateWriter(state => save({ boardId, state }).then(() => undefined), error => setMessage(`保存交互状态失败：${errorMessage(error)}`));
    stateWriter.current = writer;
    return () => { writer.dispose(); if (stateWriter.current === writer) stateWriter.current = null; };
  }, [save, boardId]);
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
    composeRef.current?.resolve?.({ status: "cancelled" }); setCompose(null); composeRef.current = null;
    setMessage(null);
  };
  const openCompose = (kind: Compose["kind"], source?: Interaction, text?: string, resolve?: Compose["resolve"]) => {
    if (pending.current || composeRef.current) { resolve?.({ status: "cancelled", outcome: "另一条输入尚未关闭" }); return; }
    setDrawer(null);
    const draft: Compose = { kind: kind === "change" || kind === "fork" ? "question" : kind, text: text ?? (kind === "return" ? "请考虑这段讨论的结论，并把适用的修改落实到主线。说明采纳了哪些内容，以及未采纳的理由。" : ""), anchor: source?.anchor ?? anchor ?? (board ? { kind: "board", boardRevision: board.revision, canvasRevision: board.canvas.revision } : undefined), sourceInteractionId: source?.id, resolve };
    if (!source || !selectedInteractionId) setPopoverPoint(anchorPoint(draft.anchor));
    setSelectedInteractionId(source ? interactionRoot(source.id, interactions) : undefined); setMessage(null);
    composeRef.current = draft; setCompose(draft);
  };
  const retryUnconfirmed = (item: Interaction) => {
    if (pending.current || composeRef.current) return;
    const draft: Compose = { kind: item.kind, text: item.text, intentId: item.id, anchor: item.anchor, sourceInteractionId: item.sourceInteractionId };
    composeRef.current = draft; setCompose(draft); setMessage(null);
  };
  const submit = async (fork = false) => {
    const draft = composeRef.current;
    if (!draft?.text.trim() || pending.current || !board?.ownerAgentId) return;
    const kind = fork ? "fork" : draft.kind;
    // An uncertain send retries its immutable route and ID. Changing text starts a new intent.
    if (draft.intentId && kind !== draft.kind) return;
    draft.kind = kind;
    pending.current = true; setSending(true); setMessage(null);
    draft.intentId ??= localId("intent");
    const now = new Date().toISOString();
    const local: Interaction = { id: draft.intentId, kind: draft.kind, text: draft.text.trim(), anchor: draft.anchor, sourceInteractionId: draft.sourceInteractionId, status: "sending", resultReferences: [], createdAt: now, updatedAt: now };
    setOptimistic(items => [...items.filter(item => item.id !== local.id), local]);
    setSelectedInteractionId(interactionRoot(draft.sourceInteractionId ?? draft.intentId, interactions));
    try {
      const result = await send({ boardId, intentId: draft.intentId, kind: draft.kind, text: draft.text.trim(), anchor: draft.anchor, sourceInteractionId: draft.sourceInteractionId });
      setOptimistic(items => items.map(item => item.id === result.id ? result : item));
      draft.resolve?.({ status: "submitted", outcome: statusNames[result.status] });
      setCompose(null); composeRef.current = null;
      setAnchor(undefined); setSelectionClearToken(value => value + 1); void query.refetch();
    } catch (error) {
      const message = errorMessage(error); setMessage(message);
      setOptimistic(items => items.map(item => item.id === local.id ? { ...item, status: "failed", error: message } : item));
    }
    finally { pending.current = false; setSending(false); }
  };
  const openInteraction = (id: string, position?: Point) => {
    if (pending.current || composeRef.current) return;
    const item = interactions.find(item => item.id === id);
    if (!item) return;
    setSelectedInteractionId(interactionRoot(id, interactions)); setPopoverPoint(position ?? anchorPoint(item.anchor)); setDrawer(null); setMessage(null);
  };
  const closePopover = () => { if (!pending.current) { cancelCompose(); setSelectedInteractionId(undefined); } };
  usePopoverDismiss(Boolean(compose || selectedInteractionId), closePopover);
  const updateDecision = async (decision: Decision, status: "questioned" | "dismissed") => {
    if (!board) return;
    try { query.accept(await record({ boardId, expectedRevision: board.revision, eventId: localId("decision"), decision: { ...decision, status } })); }
    catch (error) { setMessage(errorMessage(error)); void query.refetch(); }
  };
  const selectedText = anchor ? anchor.text || ({ point: "指定位置", region: "框选区域", element: "页面元素", board: "整个画布", text: "选中文字" }[anchor.kind]) : "整个画布";
  if (!board) return <View style={{ flex: 1, padding: 24, gap: 16, backgroundColor: c.surface0 }}><Action label="所有 Boards" onPress={onBack} /><Notice text={query.isPending ? "正在打开…" : query.error ? errorMessage(query.error) : "这块 Board 不存在。"} error={!!query.error} /></View>;
  return <View style={{ flex: 1, minHeight: 0, backgroundColor: c.surface0 }}>
    <View style={{ padding: 10, gap: 8, borderBottomWidth: 1, borderColor: c.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Action label="Boards" icon="PanelsTopLeft" onPress={onBack} />
        <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 16, fontWeight: "600", flex: 1, minWidth: 100 }}>{board.title}</Text>
        <Action label={`决策 ${board.decisions.filter(d => !["dismissed", "superseded"].includes(d.status)).length}`} onPress={() => setDrawer("decisions")} />
        <Action label="讨论" icon="MessagesSquare" onPress={() => setDrawer("threads")} />
        <Action label="变化" icon="History" onPress={() => setDrawer("history")} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        {canRenderFrames && ([ ["off", "交互", "MousePointer2"], ["text", "选文字", "TextSelect"], ["region", "框选", "Scan"], ["point", "指定位置", "MapPin"] ] as const).map(([mode, label, icon]) => <Action key={mode} label={label} icon={icon} active={selectionMode === mode} onPress={() => setSelectionMode(mode)} />)}
        <View style={{ flex: 1 }} />
        <Action label="发消息" icon="MessageCircle" onPress={() => openCompose("question")} />
      </View>
    </View>
    <View testID="board-reference-bar" style={{ height: 38, flexShrink: 0, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: c.surface1 }}>
      <Text numberOfLines={1} style={{ color: c.foregroundMuted, flex: 1, fontSize: 12 }}>{anchor ? `已引用 r${anchor.boardRevision} · ${selectedText}` : selectionMode === "text" ? "拖选文字，直接在旁边提问。Esc 返回交互。" : selectionMode === "region" ? "拖出一个区域，可包含图片、图表或空白。Esc 返回交互。" : selectionMode === "point" ? "点击需要添加或修改内容的位置。Esc 返回交互。" : "右键就地交流 · Option / Alt + 拖动框选"}</Text>
      {anchor ? <Action label="清除引用" onPress={() => { setAnchor(undefined); setSelectionClearToken(value => value + 1); }} /> : null}
    </View>
    <View testID="board-canvas-container" style={{ flex: 1, minHeight: 180, position: "relative", overflow: "hidden" }} onLayout={event => { setHeight(Math.max(180, event.nativeEvent.layout.height)); setWidth(event.nativeEvent.layout.width); }}>
      {canRenderFrames ? <CanvasFrame boardId={board.id} title={board.title} canvas={board.canvas} boardRevision={board.revision} userState={board.userState} theme={frameTheme} height={height} selectionMode={selectionMode} selectionClearToken={selectionClearToken} interactions={interactions} selectedInteractionId={selectedInteractionId} onOpenInteraction={openInteraction} onInteractionPosition={(id, point) => { if (id === selectedInteractionId && !composeRef.current) setPopoverPoint(point); }} onAnchor={onAnchor} onAsk={onAsk} onCompose={onCompose} onState={onState} onError={error => setFrameError(`${error.message}${error.patchId ? `（${error.patchId}）` : ""}`)} onSelectionEnd={() => setSelectionMode("off")} onSelectionClear={() => { setAnchor(undefined); setSelectionMode("off"); }} onOpenLink={url => { void openExternalUrl(url).catch(e => setMessage(errorMessage(e))); }} /> : <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}><Notice text="手机兼容视图。完整的自由画布、动画和页面交互在桌面版使用；这里可以查看摘要、决策并与 agent 交流。" /><Markdown>{typeof board.canvas.data.summary === "string" ? board.canvas.data.summary : "Agent 尚未提供文字摘要。你可以直接提问，回复会出现在讨论里。"}</Markdown></ScrollView>}
      {query.error || frameError || (message && !compose && !selectedInteractionId) ? <View style={{ position: "absolute", left: 8, right: 8, top: 8 }}><Notice error text={query.error ? "连接暂时中断。当前是上次收到的内容，尚未确认最新状态。" : frameError || message || ""} /></View> : null}
      {compose || selectedInteractionId ? <View testID="board-local-popover" accessibilityLabel="原位交流" onLayout={event => setPopoverHeight(event.nativeEvent.layout.height)} style={{ position: "absolute", ...popover, borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.surface0, overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.22, shadowRadius: 16, shadowOffset: { width: 0, height: 5 }, elevation: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 8, gap: 8, borderBottomWidth: 1, borderColor: c.border }}><Text style={{ color: c.foreground, fontWeight: "600", flex: 1 }}>{compose ? compose.kind === "reply" ? "继续这个 Fork" : "发给 agent" : "这里的讨论"}</Text>{!canRenderFrames ? <Action label="关闭" disabled={sending} onPress={closePopover} /> : null}</View>
        <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={{ padding: 12, gap: 16 }} keyboardShouldPersistTaps="handled">
          {thread.map(item => <InteractionContent key={item.id} item={item} board={board} frameTheme={frameTheme} unconfirmed={!board.interactions.some(saved => saved.id === item.id)} onRetry={() => retryUnconfirmed(item)} onFollow={(kind, text, resolve) => openCompose(kind, item, text, resolve)} onOpenAgent={() => { if (item.agentId && navigation) navigation.openAgent({ agentId: item.agentId }); }} />)}
          {compose ? <View style={{ gap: 10 }}>
            {!thread.length ? <AnchorPreview anchor={compose.anchor} compact /> : null}
            {compose.anchor && compose.anchor.canvasRevision !== board.canvas.revision ? <Copy small muted>引用来自旧画布版本；agent 会对照原来的位置和快照。</Copy> : null}
            {compose.kind === "reply" ? <Copy small muted>继续当前 Fork；需要修改时，会直接更新这块 Board。</Copy> : null}
            {canRenderFrames ? <WebMessageInput value={compose.text} disabled={sending} onChange={text => { const previous = composeRef.current; if (previous) { const next = { ...previous, text, intentId: undefined }; composeRef.current = next; setCompose(next); } }} onSubmit={fork => { void submit(fork); }} onClose={closePopover} placeholder="想了解什么？或希望这里发生什么变化？" style={{ color: c.foreground, background: c.surface1, border: `1px solid ${c.border}`, borderRadius: 8, padding: 10, minHeight: 80, fontSize: 14 }} /> : <TextInput autoFocus accessibilityLabel="发给 agent 的消息" value={compose.text} editable={!sending} multiline maxLength={24000} onChangeText={text => { const previous = composeRef.current; if (previous) { const next = { ...previous, text, intentId: undefined }; composeRef.current = next; setCompose(next); } }} placeholder="想了解什么？或希望这里发生什么变化？" placeholderTextColor={c.foregroundMuted} style={{ color: c.foreground, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 80, textAlignVertical: "top" }} />}
            {!board.ownerAgentId ? <Notice error text="这块 Board 尚未关联负责的 agent。请让 agent 接管后再发送。" /> : null}
            {message ? <Notice error text={message} /> : null}
            <Copy small muted>Enter 发给{compose.kind === "reply" || compose.kind === "fork" ? "当前 Fork" : "主会话"} · Shift+Enter 换行</Copy>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Action label="Fork 发送" icon="GitBranch" disabled={sending || !compose.text.trim() || !board.ownerAgentId || Boolean(compose.intentId && compose.kind !== "fork")} onPress={() => { void submit(true); }} />
              <Action label={sending ? "发送中…" : "发送"} disabled={sending || !compose.text.trim() || !board.ownerAgentId} primary onPress={() => { void submit(); }} />
            </View>
            <Copy small muted>⌘ / Ctrl + Enter 开 Fork · 隔开话题，也能直接改 Board</Copy>
          </View> : null}
        </ScrollView>
      </View> : null}
    </View>
    <View style={{ paddingHorizontal: 12, paddingVertical: 5, borderTopWidth: 1, borderColor: c.border, flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
      {canRenderFrames ? <Copy small muted>选中文字 / Option + 拖动 / 右键，即可输入 · Esc 取消</Copy> : null}
      <Copy small muted>{query.error ? "离线快照" : "持续更新"} · r{board.revision} · {timeLabel(board.updatedAt)}</Copy>
    </View>
    <Modal title={drawer === "decisions" ? "Agent 做过的默认决策" : drawer === "threads" ? "围绕画布的讨论" : "发生了什么变化"} open={drawer !== null} onOpenChange={open => { if (!open) setDrawer(null); }}><Modal.Content>
      {drawer === "decisions" ? <DecisionList board={board} onUpdate={updateDecision} onQuestion={decision => { setDrawer(null); const draft: Compose = { kind: "question", text: `关于这个 agent 决策：${decision.choice}\n\n`, anchor: { kind: "element", boardRevision: board.revision, canvasRevision: board.canvas.revision, text: decision.choice, selector: decision.related[0] } }; setSelectedInteractionId(undefined); setPopoverPoint(anchorPoint(draft.anchor)); composeRef.current = draft; setCompose(draft); }} /> : null}
      {drawer === "threads" ? <View style={{ gap: 20 }}>
        {!board.interactions.length ? <Copy muted>指着画布提问、提出修改，或开一个独立讨论。交流会保留当时的引用和版本。</Copy> : null}
        {[...interactions].filter(item => interactionRoot(item.id, interactions) === item.id).reverse().map(interaction => <View key={interaction.id} style={{ borderBottomWidth: 1, borderColor: c.border, paddingBottom: 18, gap: 10 }}>
          <Copy small muted>{kindNames[interaction.kind]} · {statusNames[interactionThread(interaction.id, interactions).at(-1)?.status ?? interaction.status]} · {timeLabel(interaction.createdAt)}</Copy>
          <Copy>{interaction.text}</Copy>
          <Action label="原位查看和继续交流" onPress={() => openInteraction(interaction.id)} />
        </View>)}
      </View> : null}
      {drawer === "history" ? <View style={{ gap: 14 }}>{[...board.events].reverse().slice(0, 100).map(event => <View key={event.id} style={{ gap: 3 }}><Copy>{event.summary}</Copy><Copy muted small>r{event.revision} · {event.source} · {timeLabel(event.at)}</Copy></View>)}{!board.events.length ? <Copy muted>还没有变化。</Copy> : null}</View> : null}
    </Modal.Content></Modal>
  </View>;
}

function InteractionContent({ item, board, frameTheme, onFollow, onOpenAgent, unconfirmed, onRetry }: {
  item: Interaction; board: Board; frameTheme: FrameTheme;
  onFollow(kind: Compose["kind"], text?: string, resolve?: Compose["resolve"]): void; onOpenAgent(): void; unconfirmed: boolean; onRetry(): void;
}) {
  const c = useColors();
  const discussion = item.kind === "fork" || item.kind === "reply";
  const [showSnapshot, setShowSnapshot] = useState(false);
  const [visualState, setVisualState] = useState<JsonData>({});
  const [visualError, setVisualError] = useState<string>();
  const stale = item.anchor && item.anchor.canvasRevision !== board.canvas.revision;
  const follow = (text?: string) => onFollow(discussion ? "reply" : "question", text);
  return <View style={{ gap: 10, paddingBottom: 14, borderBottomWidth: 1, borderColor: c.border }}>
    <Copy small muted>{kindNames[item.kind]} · {statusNames[item.status]} · {timeLabel(item.createdAt)}</Copy>
    <Copy>{item.text}</Copy>
    {stale ? <Copy small muted>旧位置 · 画布 v{item.anchor!.canvasRevision}，当前 v{board.canvas.revision}。此标记保留提问时的位置。</Copy> : null}
    {showSnapshot ? <AnchorPreview anchor={item.anchor} /> : null}
    {item.response ? <Markdown>{item.response}</Markdown> : null}
    {item.responseCanvas && canRenderFrames ? <View style={{ height: 260, borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: "hidden" }}>
      <CanvasFrame boardId={`${board.id}.response.${item.id}`} title="Agent 的可交互回答" canvas={item.responseCanvas} boardRevision={board.revision} userState={visualState} theme={frameTheme} height={260} selectionMode="off" onAnchor={() => undefined} onAsk={request => new Promise(resolve => onFollow(discussion ? "reply" : "question", visualQuestion(item, request), resolve))} onCompose={request => onFollow(discussion ? "reply" : "question", visualQuestion(item, request))} onState={setVisualState} onError={error => setVisualError(error.message)} onOpenLink={url => { void openExternalUrl(url).catch(error => setVisualError(errorMessage(error))); }} />
    </View> : null}
    {item.responseCanvas && !canRenderFrames ? <Copy small muted>这条回复包含可交互图解，请在桌面查看。</Copy> : null}
    {item.error || visualError ? <Notice error text={item.error || visualError || ""} /> : null}
    {item.resultReferences.length ? <Copy small muted>依据：{item.resultReferences.join(" · ")}</Copy> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {item.anchor ? <Action label={showSnapshot ? "收起原始引用" : "原始引用"} onPress={() => setShowSnapshot(value => !value)} /> : null}
      {unconfirmed && item.status === "failed" ? <Action label="重试发送" onPress={onRetry} /> : null}
      {!unconfirmed && (!discussion || item.agentId) ? <Action label="继续交流" onPress={() => follow()} /> : null}
      {item.agentId ? <Action label="会话" onPress={onOpenAgent} /> : null}
    </View>
  </View>;
}

function AnchorPreview({ anchor, compact = false }: { anchor?: Anchor; compact?: boolean }) {
  if (!anchor) return null;
  return <View style={{ gap: 6 }}><Copy muted small>引用 r{anchor.boardRevision} · {anchor.text || (anchor.kind === "point" ? "指定位置" : anchor.kind === "region" ? "框选区域" : "画布")}{anchor.rect ? ` · (${Math.round(anchor.rect.x)}, ${Math.round(anchor.rect.y)})` : ""}</Copy>{anchor.image ? <Image source={{ uri: `data:${anchor.image.mimeType};base64,${anchor.image.data}` }} resizeMode="contain" style={{ width: "100%", height: compact ? 72 : 150 }} accessibilityLabel="提问时的画面快照" /> : null}</View>;
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
