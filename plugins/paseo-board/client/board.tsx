import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Markdown, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { interactBoardRpc, recordDecisionRpc, saveStateRpc, type Anchor, type Board, type Decision, type Interaction, type JsonData } from "../shared/contracts";
import type { AskRequest, AskResult, ComposeRequest, SelectionMode } from "../shared/frame-contract";
import { frameThemeFromColors } from "../shared/frame-theme";
import { CanvasFrame, canRenderFrames } from "./web";
import { Action, ColorContext, Copy, Notice, errorMessage, localId, timeLabel, useColors } from "./ui";
import { useBoard } from "./data";
import { createStateWriter } from "./state-writer";

interface Props extends PluginSurfaceProps { boardId: string; onBack(): void }
type Compose = { kind: Interaction["kind"]; text: string; intentId?: string; anchor?: Anchor; sourceInteractionId?: string; resolve?: (result: AskResult) => void };
const statusNames: Record<Interaction["status"], string> = { saved: "已保存", sending: "发送中", delivered: "已送达", processing: "处理中", answered: "已有回复", applied: "已落实", rejected: "未采用", failed: "失败" };
const kindNames: Record<Interaction["kind"], string> = { question: "提问", change: "修改这里", fork: "独立讨论", return: "带回主线", reply: "继续讨论" };

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
  const stateWriter = useRef<ReturnType<typeof createStateWriter> | null>(null);
  const frameTheme = useMemo(() => frameThemeFromColors(theme.colors), [theme.colors]);
  const onAnchor = useCallback((next: Anchor) => { setAnchor(next); setSelectionMode("off"); }, []);
  const onAsk = useCallback((request: AskRequest): Promise<AskResult> => new Promise(resolve => {
    // A generated document cannot send a message. It can request this host-owned preview.
    if (composeRef.current || pending.current) { resolve({ status: "cancelled", outcome: "Another question is open" }); return; }
    const next = { kind: request.kind ?? "question", text: request.prompt, anchor: request.anchor, resolve };
    composeRef.current = next; setCompose(next);
  }), []);
  const onCompose = useCallback((request: ComposeRequest) => {
    if (composeRef.current || pending.current) return;
    const next: Compose = { kind: request.kind, text: "", anchor: request.anchor };
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
  useEffect(() => () => {
    if (!pending.current) composeRef.current?.resolve?.({ status: "cancelled" });
  }, []);
  const cancelCompose = () => {
    if (pending.current) return;
    composeRef.current?.resolve?.({ status: "cancelled" }); setCompose(null); composeRef.current = null;
  };
  const openCompose = (kind: Compose["kind"], source?: Interaction) => {
    if (pending.current || composeRef.current) return;
    setDrawer(null);
    const draft: Compose = { kind, text: kind === "return" ? "请考虑这段讨论的结论，并把适用的修改落实到主线。说明采纳了哪些内容，以及未采纳的理由。" : "", anchor: source?.anchor ?? anchor ?? (board ? { kind: "board", boardRevision: board.revision, canvasRevision: board.canvas.revision } : undefined), sourceInteractionId: source?.id };
    composeRef.current = draft; setCompose(draft);
  };
  const submit = async () => {
    const draft = composeRef.current;
    if (!draft?.text.trim() || pending.current) return;
    pending.current = true; setSending(true); setMessage(null);
    try {
      draft.intentId ??= localId("intent");
      const result = await send({ boardId, intentId: draft.intentId, kind: draft.kind, text: draft.text.trim(), anchor: draft.anchor, sourceInteractionId: draft.sourceInteractionId });
      draft.resolve?.({ status: "submitted", outcome: statusNames[result.status] });
      setCompose(null); composeRef.current = null;
      setAnchor(undefined); setSelectionClearToken(value => value + 1); setDrawer("threads"); void query.refetch();
    } catch (error) { setMessage(errorMessage(error)); }
    finally { pending.current = false; setSending(false); }
  };
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
        <Action label="提问" icon="MessageCircle" onPress={() => openCompose("question")} />
        <Action label="修改这里" icon="Pencil" onPress={() => openCompose("change")} />
        <Action label="开 fork" icon="GitBranch" onPress={() => openCompose("fork")} />
      </View>
    </View>
    {query.error ? <Notice error text="连接暂时中断。当前是上次收到的内容，尚未确认最新状态。" /> : null}
    {frameError ? <Notice error text={frameError} /> : null}
    {message ? <Notice error text={message} /> : null}
    {anchor ? <View style={{ padding: 8, gap: 8, flexDirection: "row", alignItems: "center", backgroundColor: c.surface1 }}><Text numberOfLines={1} style={{ color: c.foregroundMuted, flex: 1, fontSize: 12 }}>已引用 r{anchor.boardRevision} · {selectedText}</Text><Action label="清除引用" onPress={() => { setAnchor(undefined); setSelectionClearToken(value => value + 1); }} /></View> : null}
    {selectionMode !== "off" ? <Notice text={selectionMode === "text" ? "拖选画布内的文字，引用后即可提问。Esc 返回交互。" : selectionMode === "region" ? "拖出一个区域，可包含图片、图表或空白。Esc 返回交互。" : "点击需要添加或修改内容的位置。Esc 返回交互。"} /> : null}
    <View style={{ flex: 1, minHeight: 180 }} onLayout={event => setHeight(Math.max(180, event.nativeEvent.layout.height))}>
      {canRenderFrames ? <CanvasFrame boardId={board.id} title={board.title} canvas={board.canvas} boardRevision={board.revision} userState={board.userState} theme={frameTheme} height={height} selectionMode={selectionMode} selectionClearToken={selectionClearToken} onAnchor={onAnchor} onAsk={onAsk} onCompose={onCompose} onState={onState} onError={error => setFrameError(`${error.message}${error.patchId ? `（${error.patchId}）` : ""}`)} onSelectionEnd={() => setSelectionMode("off")} onSelectionClear={() => { setAnchor(undefined); setSelectionMode("off"); }} onOpenLink={url => { void openExternalUrl(url).catch(e => setMessage(errorMessage(e))); }} /> : <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}><Notice text="手机兼容视图。完整的自由画布、动画和页面交互在桌面版使用；这里可以查看摘要、决策并与 agent 交流。" /><Markdown>{typeof board.canvas.data.summary === "string" ? board.canvas.data.summary : "Agent 尚未提供文字摘要。你可以直接提问，回复会出现在讨论里。"}</Markdown></ScrollView>}
    </View>
    <View style={{ paddingHorizontal: 12, paddingVertical: 5, borderTopWidth: 1, borderColor: c.border, flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
      {canRenderFrames ? <Copy small muted>Option / Alt + 拖动框选 · 右键提问或修改 · Esc 取消</Copy> : null}
      <Copy small muted>{query.error ? "离线快照" : "持续更新"} · r{board.revision} · {timeLabel(board.updatedAt)}</Copy>
    </View>
    <Modal title={drawer === "decisions" ? "Agent 做过的默认决策" : drawer === "threads" ? "围绕画布的讨论" : "发生了什么变化"} open={drawer !== null} onOpenChange={open => { if (!open) setDrawer(null); }}><Modal.Content>
      {drawer === "decisions" ? <DecisionList board={board} onUpdate={updateDecision} onQuestion={decision => { setDrawer(null); const draft: Compose = { kind: "question", text: `关于这个 agent 决策：${decision.choice}\n\n`, anchor: { kind: "element", boardRevision: board.revision, canvasRevision: board.canvas.revision, text: decision.choice, selector: decision.related[0] } }; composeRef.current = draft; setCompose(draft); }} /> : null}
      {drawer === "threads" ? <View style={{ gap: 20 }}>
        {!board.interactions.length ? <Copy muted>指着画布提问、提出修改，或开一个独立讨论。交流会保留当时的引用和版本。</Copy> : null}
        {[...board.interactions].reverse().map(interaction => <View key={interaction.id} style={{ borderBottomWidth: 1, borderColor: c.border, paddingBottom: 18, gap: 10 }}>
          <Copy small muted>{kindNames[interaction.kind]} · {statusNames[interaction.status]} · {timeLabel(interaction.createdAt)}</Copy>
          <AnchorPreview anchor={interaction.anchor} />
          <Copy>{interaction.text}</Copy>
          {interaction.response ? <Markdown>{interaction.response}</Markdown> : null}
          {interaction.error ? <Notice error text={interaction.error} /> : null}
          {interaction.resultReferences.length ? <Copy small muted>落实依据：{interaction.resultReferences.join(" · ")}</Copy> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {["fork", "reply"].includes(interaction.kind) && interaction.agentId ? <><Action label="继续讨论" onPress={() => openCompose("reply", interaction)} />{interaction.response ? <Action label="带回主线" onPress={() => openCompose("return", interaction)} /> : null}</> : null}
            {interaction.agentId && navigation ? <Action label="打开会话" onPress={() => { setDrawer(null); navigation.openAgent({ agentId: interaction.agentId! }); }} /> : null}
          </View>
        </View>)}
      </View> : null}
      {drawer === "history" ? <View style={{ gap: 14 }}>{[...board.events].reverse().slice(0, 100).map(event => <View key={event.id} style={{ gap: 3 }}><Copy>{event.summary}</Copy><Copy muted small>r{event.revision} · {event.source} · {timeLabel(event.at)}</Copy></View>)}{!board.events.length ? <Copy muted>还没有变化。</Copy> : null}</View> : null}
    </Modal.Content></Modal>
    <Modal title={compose ? kindNames[compose.kind] : "提问"} open={compose !== null} onOpenChange={open => { if (!open) cancelCompose(); }}><Modal.Content>
      {compose ? <View style={{ gap: 14 }}>
        <AnchorPreview anchor={compose.anchor} />
        {compose.anchor && compose.anchor.canvasRevision !== board.canvas.revision ? <Notice text="画布已更新。会保留你引用的旧版本，agent 会判断它是否仍然适用。" /> : null}
        {compose.kind === "fork" ? <Copy muted>开启独立讨论，带上引用、画面快照和相关决策。讨论不会自动改写主线。</Copy> : compose.kind === "return" ? <Copy muted>把结论作为要求发给主线 agent。只有 agent 提供落实依据后，才显示“已落实”。</Copy> : null}
        <TextInput autoFocus accessibilityLabel="发给 agent 的消息" value={compose.text} editable={!sending} multiline maxLength={24000} onChangeText={text => { const previous = composeRef.current; if (previous) { const next = { ...previous, text, intentId: undefined }; composeRef.current = next; setCompose(next); } }} placeholder="想了解什么？或希望这里发生什么变化？" placeholderTextColor={c.foregroundMuted} style={{ color: c.foreground, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 130, textAlignVertical: "top" }} />
        {!board.ownerAgentId ? <Notice error text="这块 Board 尚未关联负责的 agent。请让 agent 接管后再发送。" /> : null}
        {message ? <Notice error text={message} /> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}><Action label="取消" disabled={sending} onPress={cancelCompose} /><Action label={sending ? "发送中…" : compose.kind === "fork" ? "开启讨论" : "发送"} disabled={sending || !compose.text.trim() || !board.ownerAgentId} primary onPress={() => { void submit(); }} /></View>
      </View> : null}
    </Modal.Content></Modal>
  </View>;
}

function AnchorPreview({ anchor }: { anchor?: Anchor }) {
  if (!anchor) return null;
  return <View style={{ gap: 6 }}><Copy muted small>引用 r{anchor.boardRevision} · {anchor.text || (anchor.kind === "point" ? "指定位置" : anchor.kind === "region" ? "框选区域" : "画布")}{anchor.rect ? ` · (${Math.round(anchor.rect.x)}, ${Math.round(anchor.rect.y)})` : ""}</Copy>{anchor.image ? <Image source={{ uri: `data:${anchor.image.mimeType};base64,${anchor.image.data}` }} resizeMode="contain" style={{ width: "100%", height: 150 }} accessibilityLabel="提问时的画面快照" /> : null}</View>;
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
