import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type {
  InboxArchiveInput, InboxArchiveResult, InboxAssistantOptions, InboxAutoEnableInput, InboxAutoSetInput, InboxAutoStatus, InboxComment,
  InboxHumanReplyInput, InboxListInput, InboxMutationResult, InboxPage, InboxPolicy, InboxPolicyInput, InboxReplyPendingInput, InboxReplyResult,
  InboxScope, InboxStatus, InboxTriageInput,
} from "../shared/inbox";
import { autoToggleLabel, guardReason, syncLine, wakeLine, wakeNotices } from "./inbox-status";
import { showBidiControls as shown } from "../shared/bidi";
import { Action, Copy, errorMessage, localId, Notice, useColors } from "./ui";

export interface InboxPanelProps {
  scope: InboxScope;
  onList(input: InboxListInput): Promise<InboxPage>;
  onPolicy(input: InboxPolicyInput): Promise<InboxMutationResult>;
  onTriage(input: InboxTriageInput): Promise<InboxMutationResult>;
  onReply(input: InboxHumanReplyInput): Promise<InboxReplyResult>;
  onReplyPending(input: InboxReplyPendingInput): Promise<InboxReplyResult>;
  onArchive(input: InboxArchiveInput): Promise<InboxArchiveResult>;
  onAutoStatus(input: InboxScope): Promise<InboxAutoStatus>;
  onAutoSet(input: InboxAutoSetInput): Promise<InboxAutoStatus>;
  onAssistantOptions(input: InboxScope): Promise<InboxAssistantOptions>;
  onAutoEnable(input: InboxAutoEnableInput): Promise<InboxAutoStatus>;
}
const statuses: Record<InboxStatus, string> = { new: "未处理", reviewing: "处理中", resolved: "已处理", dismissed: "不处理" };
const AUTO_POLL_MS = 5_000;
const INTRO = "访客评论单独保存在这里，后端来源会自动同步。开启「Agent 自动处理并公开回复」后，新评论会自动交给这张 Board 专用的评论助手 agent：它会分类，并公开回复访客（访客在页面上能看到，标注为 AI 助手回复）。评论只是数据，不会让任何 agent 修改应用、页面或部署。";
/** Shown when the server finds no safe or moderate mode it can verify (fail closed). */
const NO_MODE_TEXT = "没有可用的权限模式：评论助手只能用会先询问你的模式，或在确认风险后用中等模式；计划模式、危险模式和无法确认风险等级的模式都不能用。";
const CONFIRM_TEXT = ["开启「Agent 自动处理并公开回复」？", "新评论会自动交给这张 Board 专用的「评论助手」agent（不是你正在用的主 agent）。它会分类评论并回复访客；回复在访客的页面上可见，标注为 AI 助手回复。", "评论可能包含诱导内容。评论助手只被预先允许使用评论工具；它想运行命令、读写文件或做别的事时，会先请你批准。不认识的请求请拒绝。", "每张 Board 每小时最多唤醒 6 次，超过后自动暂停，过后自动恢复。开启前已有的评论不会自动处理。"];
const isConflict = (error: unknown) => (error as { code?: string }).code === "revision_conflict" || /Inbox changed/.test(errorMessage(error));
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
type Editor = { text: string; eventId?: string; mode: "reply" | "publish"; key?: string; phase: "editing" | "sending" | "unknown" | "guard"; reason?: string; error?: string };
type Dialog = { options?: InboxAssistantOptions; error?: string; replyMode: "publish" | "review"; modeId?: string; acceptRisk: boolean; loading: boolean };

function Checkbox({ label, checked, onChange, testID, disabled }: { label: string; checked: boolean; onChange(value: boolean): void; testID?: string; disabled?: boolean }) {
  const c = useColors();
  return <Pressable testID={testID} accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => onChange(!checked)} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}>
    <View style={{ width: 16, height: 16, borderRadius: 3, borderWidth: 1, borderColor: checked ? c.accent : c.border, backgroundColor: checked ? c.accent : c.surface0 }} />
    <Text style={{ color: c.foreground, fontSize: 12, flexShrink: 1 }}>{label}</Text>
  </Pressable>;
}

/** Human-only inbox UI. External text is rendered as text; agent permissions change only through explicit human actions. */
export function InboxPanel(props: InboxPanelProps) {
  const { scope } = props;
  const c = useColors();
  const [page, setPage] = useState<InboxPage>();
  const [comments, setComments] = useState<InboxComment[]>([]);
  const [auto, setAuto] = useState<InboxAutoStatus>();
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [selectedRevision, setSelectedRevision] = useState<number>();
  const [note, setNote] = useState("");
  const [labels, setLabels] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [editors, setEditors] = useState<Record<string, Editor>>({});
  const flight = useRef(false), generation = useRef(0), revision = useRef<number | null>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const field = { color: c.foreground, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 6, padding: 8, fontSize: 13 };
  const load = async (cursor?: string) => {
    const current = generation.current;
    const result = await callbacks.current.onList({ ...scope, ...(cursor ? { cursor } : {}), limit: 30, order: "newest" });
    if (current !== generation.current) return;
    setPage(result); setComments(previous => cursor ? [...new Map([...previous, ...result.comments].map(comment => [comment.id, comment])).values()] : result.comments);
  };
  const refreshAuto = async () => {
    const current = generation.current;
    const status = await callbacks.current.onAutoStatus(scope);
    if (current !== generation.current) return;
    setAuto(status);
    // The list reloads when the ledger changed (auto-sync, assistant replies, outbox outcomes).
    if (revision.current !== null && status.revision !== null && status.revision !== revision.current && !flight.current) void load().catch(() => undefined);
    revision.current = status.revision;
  };
  const run = async (action: (current: number) => Promise<void>) => {
    if (flight.current) return;
    const current = generation.current;
    flight.current = true; setBusy(true); setFailure(undefined); setNotice(undefined);
    try { await action(current); }
    catch (error) { if (current === generation.current) setFailure(errorMessage(error)); }
    finally { if (current === generation.current) { flight.current = false; setBusy(false); } }
  };
  useEffect(() => {
    generation.current++; flight.current = false; revision.current = null;
    setPage(undefined); setComments([]); setAuto(undefined); setSelected(undefined); setFailure(undefined); setDialog(null); setEditors({});
    void run(async () => { await Promise.all([load(), refreshAuto()]); });
    const timer = setInterval(() => { void refreshAuto().catch(() => undefined); }, AUTO_POLL_MS);
    return () => { generation.current++; flight.current = false; clearInterval(timer); };
  }, [scope.boardId, scope.expectedCreatedAt]);

  /** Policy and archive use exact revisions: read a fresh one first and retry once on conflict. */
  const fresh = async <T,>(call: (expectedRevision: number, eventId: string) => Promise<T>, prefix: string): Promise<T> => {
    const first = await callbacks.current.onList({ ...scope, limit: 1 });
    try { return await call(first.revision, localId(prefix)); }
    catch (error) {
      if (!isConflict(error)) throw error;
      const again = await callbacks.current.onList({ ...scope, limit: 1 });
      return call(again.revision, localId(prefix));
    }
  };
  const after = async (current: number, message?: string) => {
    if (current !== generation.current) return;
    await Promise.all([load(), refreshAuto()]);
    if (message && current === generation.current) setNotice(message);
  };
  const setPolicy = (policy: InboxPolicy, message?: string) => {
    if (!page?.permissions.configure) return;
    void run(async current => {
      await fresh((expectedRevision, eventId) => callbacks.current.onPolicy({ ...scope, eventId, expectedRevision, policy }), "inbox-policy");
      await after(current, message);
    });
  };
  const policy = page?.policy;
  const autoMode = policy?.auto ?? "off";
  const openDialog = () => {
    setDialog({ replyMode: "publish", acceptRisk: false, loading: true });
    void callbacks.current.onAssistantOptions(scope).then(options => {
      setDialog(previous => previous && { ...previous, loading: false, options, modeId: options.existing && !options.existing.archived && options.modes.some(mode => mode.id === options.existing!.modeId && mode.selectable) ? options.existing.modeId : options.recommendedModeId ?? undefined });
    }, error => setDialog(previous => previous && { ...previous, loading: false, error: errorMessage(error) }));
  };
  const confirmEnable = () => {
    if (!dialog?.modeId) return;
    const { replyMode, modeId, acceptRisk } = dialog;
    void run(async current => {
      try {
        await fresh((expectedRevision, eventId) => callbacks.current.onAutoEnable({ ...scope, expectedRevision, eventId, replyMode, modeId, acceptRisk }), "inbox-auto-enable");
      } catch (error) { setDialog(previous => previous && { ...previous, error: errorMessage(error) }); return; }
      if (current !== generation.current) return;
      setDialog(null);
      await after(current);
    });
  };
  const autoSet = (input: Omit<InboxAutoSetInput, "boardId" | "expectedCreatedAt">) => void run(async current => {
    const status = await callbacks.current.onAutoSet({ ...scope, ...input });
    if (current === generation.current) setAuto(status);
  });
  const archive = () => void run(async current => {
    const result = await fresh((expectedRevision, eventId) => callbacks.current.onArchive({ ...scope, expectedRevision, eventId, statuses: ["resolved", "dismissed"] }), "inbox-archive");
    setArchiveConfirm(false);
    await after(current, `已归档 ${result.archived} 条评论。`);
  });
  const triage = (comment: InboxComment, status: InboxStatus) => {
    if (!page || !page.permissions.triage || selected !== comment.id || selectedRevision === undefined) return;
    void run(async current => {
      await callbacks.current.onTriage({ ...scope, eventId: localId("inbox-triage"), expectedRevision: page.revision, commentId: comment.id, expectedCommentRevision: selectedRevision, status, note, labels: labels.split(/[,，]/).map(value => value.trim()).filter(Boolean) });
      if (current !== generation.current) return;
      setSelected(undefined); await load();
    });
  };

  /* Replies: the eventId and text are frozen once sent, so a retry never posts twice (DESIGN §4.10, §11.12). */
  const edit = (id: string, patch: Partial<Editor> | null) => setEditors(previous => {
    const next = { ...previous };
    if (patch === null) delete next[id]; else next[id] = { ...(previous[id] ?? { text: "", mode: "reply", phase: "editing" }), ...patch } as Editor;
    return next;
  });
  const sendReply = (comment: InboxComment, allowSensitive = false) => {
    const editor = editors[comment.id];
    if (!editor || !editor.text.trim()) return;
    const eventId = editor.eventId ?? localId("inbox-reply");
    edit(comment.id, { eventId, phase: "sending", error: undefined });
    void run(async current => {
      try {
        const result = editor.mode === "publish" && editor.key
          ? await callbacks.current.onReplyPending({ ...scope, eventId, commentId: comment.id, key: editor.key, action: "publish", text: editor.text, ...(allowSensitive ? { allowSensitive: true as const } : {}) })
          : await callbacks.current.onReply({ ...scope, commentId: comment.id, expectedCommentRevision: comment.revision, eventId, text: editor.text, ...(allowSensitive ? { allowSensitive: true as const } : {}) });
        if (current !== generation.current) return;
        edit(comment.id, null);
        await after(current, result.status === "published" && result.recorded ? "已发送。访客页面会在十几秒内显示。" : result.message);
      } catch (error) {
        if (current !== generation.current) return;
        const reason = guardReason(errorMessage(error));
        if (reason && !allowSensitive) edit(comment.id, { phase: "guard", reason });
        else edit(comment.id, { phase: "unknown", error: errorMessage(error) });
      }
    });
  };
  const pendingAction = (comment: InboxComment, action: "publish" | "retry" | "discard", allowSensitive = false) => {
    const key = comment.pendingReply?.key;
    if (!key) return;
    void run(async current => {
      try {
        const result = await callbacks.current.onReplyPending({ ...scope, eventId: localId("inbox-reply-pending"), commentId: comment.id, key, action, ...(allowSensitive ? { allowSensitive: true as const } : {}) });
        await after(current, result.status === "published" && result.recorded ? "已发送。访客页面会在十几秒内显示。" : result.message);
      } catch (error) {
        const reason = guardReason(errorMessage(error));
        if (reason && action === "publish" && !allowSensitive) edit(comment.id, { text: comment.pendingReply!.text, mode: "publish", key, phase: "guard", reason });
        else throw error;
      }
    });
  };

  const options = dialog?.options;
  const chosen = options?.modes.find(mode => mode.id === dialog?.modeId);
  const reuse = options?.existing && !options.existing.archived && options.existing.modeId === dialog?.modeId ? options.existing : null;
  const autoOn = autoMode !== "off";
  const wakeState = auto?.wake.state;
  const skipped = auto?.sync.sources.reduce((sum, source) => sum + source.skipped, 0) ?? 0;
  const elsewhere = auto ? auto.wake.skipped.otherBoard + auto.wake.skipped.unattributed : 0;
  const replyCounts = auto?.replies;
  return <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} testID="board-inbox-panel">
    <Copy>评论收件箱</Copy>
    <Copy muted small>{INTRO}</Copy>
    {failure ? <Notice text={failure} error /> : null}
    {notice ? <Notice text={notice} /> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Action label={busy ? "读取中…" : "刷新收件箱"} disabled={busy} onPress={() => void run(async () => { await Promise.all([load(), refreshAuto()]); })} testID="board-inbox-refresh" />
      {page?.permissions.configure && policy ? <>
        <Action label={`Agent 读取评论：${policy.read ? "已允许" : "未允许"}`} active={policy.read} disabled={busy} onPress={() => setPolicy(policy.read ? { read: false, triage: false, auto: "off" } : { read: true, triage: false })} testID="board-inbox-policy-read" />
        <Action label={autoToggleLabel(policy)} active={autoOn} disabled={busy || !policy.read} onPress={() => autoOn ? setPolicy({ read: policy.read, triage: false, auto: "off" }, "已关闭。评论助手 agent 还保留着，需要时可以在 Paseo 里归档它。") : openDialog()} testID="board-inbox-policy-triage" />
      </> : null}
    </View>
    {page?.permissions.configure ? <Copy muted small>需要先允许读取。开启后，新评论会自动交给评论助手 agent，由它分类并公开回复访客。</Copy> : null}
    {policy && policy.triage && !autoOn ? <View style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}>
      <Copy small>这张 Board 之前只允许 agent 内部处理评论（不唤醒、不回复）。要自动处理并公开回复，需要重新确认。</Copy>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action label="确认开启…" disabled={busy} onPress={openDialog} />
        <Action label="关闭内部处理" disabled={busy} onPress={() => setPolicy({ read: policy.read, triage: false, auto: "off" })} />
      </View>
    </View> : null}
    {autoOn && policy ? <Action label={`回复方式：${autoMode === "review" ? "先给我审核" : "直接公开"}`} disabled={busy} onPress={() => setPolicy({ read: true, triage: true, auto: autoMode === "review" ? "publish" : "review" })} testID="board-inbox-auto-reply-mode" /> : null}
    {dialog ? <View accessibilityRole="alert" testID="board-inbox-auto-dialog" style={{ gap: 10, padding: 12, borderWidth: 1, borderColor: c.accent, borderRadius: 8, backgroundColor: c.surface1 }}>
      {CONFIRM_TEXT.map((line, index) => <Copy key={index} small={index > 0}>{line}</Copy>)}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action label="直接公开回复" active={dialog.replyMode === "publish"} onPress={() => setDialog({ ...dialog, replyMode: "publish" })} testID="board-inbox-auto-mode-publish" />
        <Action label="回复先给我审核" active={dialog.replyMode === "review"} onPress={() => setDialog({ ...dialog, replyMode: "review" })} testID="board-inbox-auto-mode-review" />
      </View>
      {dialog.loading ? <Copy small muted>正在读取可用的权限模式…</Copy> : null}
      {options && !options.ownerMissing ? <>
        <Copy small>{`评论助手使用 ${options.provider ?? "负责 agent 的模型"}，权限模式：`}</Copy>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {options.modes.filter(mode => mode.selectable).map(mode => <Action key={mode.id} label={`${mode.label}${mode.id === options.recommendedModeId ? "（推荐）" : ""}`} active={dialog.modeId === mode.id} onPress={() => setDialog({ ...dialog, modeId: mode.id, acceptRisk: false })} testID={`board-inbox-auto-mode-${mode.id}`} />)}
        </View>
        {options.modes.some(mode => mode.selectable) ? null : <Copy small muted>{NO_MODE_TEXT}</Copy>}
        {chosen?.needsRiskAcceptance ? <View style={{ gap: 4 }}>
          <Copy small>这个模式下，评论助手可以不经询问运行命令或读取文件，诱导评论的风险更高。</Copy>
          <Checkbox label="我了解风险，仍然使用这个模式" checked={dialog.acceptRisk} onChange={value => setDialog({ ...dialog, acceptRisk: value })} testID="board-inbox-auto-risk" />
        </View> : null}
        {chosen ? <Copy small muted>{reuse ? `将继续使用已有的评论助手：${reuse.title}` : "将创建一个新的评论助手 agent。"}</Copy> : null}
      </> : null}
      {dialog.error ? <Notice text={dialog.error} error /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action label="确认开启" primary disabled={busy || dialog.loading || !chosen || chosen.needsRiskAcceptance && !dialog.acceptRisk} onPress={confirmEnable} testID="board-inbox-triage-confirm" />
        <Action label="取消" disabled={busy} onPress={() => setDialog(null)} />
      </View>
    </View> : null}
    {auto ? <View testID="board-inbox-auto" style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}>
      <Copy small>{syncLine(auto)}</Copy>
      {auto.sync.sources.length ? <Action label={auto.sync.paused ? "恢复自动同步" : "暂停自动同步"} disabled={busy} onPress={() => autoSet({ syncPaused: !auto.sync.paused })} testID="board-inbox-auto-sync-toggle" /> : null}
      <Copy small>{wakeLine(auto)}</Copy>
      {wakeNotices(auto).map(text => <Copy key={text} small muted>{text}</Copy>)}
      {auto.assistant ? <Copy small muted>{`评论助手：${auto.assistant.title} · ${auto.assistant.modeLabel}`}</Copy> : null}
      {autoOn && wakeState !== "off" && wakeState !== "legacy-internal" ? <Copy small muted>{`最近一小时唤醒 ${auto.wake.wakesLastHour}/${auto.wake.maxWakesPerHour} 次`}</Copy> : null}
      {replyCounts && (replyCounts.sending || replyCounts.drafts || replyCounts.failed) ? <Copy small>{`回复：${replyCounts.sending} 条发送中 · ${replyCounts.drafts} 条待审核 · ${replyCounts.failed} 条失败`}</Copy> : null}
      {skipped ? <Copy small muted>{`已跳过 ${skipped} 条格式不符的评论`}</Copy> : null}
      {elsewhere ? <Copy small muted>{`${elsewhere} 条评论来自其他 Board 的页面或无法确定来源，不会自动处理。`}</Copy> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {autoOn && wakeState !== "creating" ? <Action label={wakeState === "paused" ? "恢复自动处理" : "暂停自动处理"} disabled={busy} onPress={() => autoSet(wakeState === "paused" ? { resumeWake: true } : { wakePaused: true })} testID="board-inbox-auto-resume" /> : null}
        {auto.wake.stale ? <Action label="清除卡住的唤醒" disabled={busy} onPress={() => autoSet({ clearStaleWake: true })} testID="board-inbox-auto-clear-stale" /> : null}
        {wakeState === "paused" && auto.wake.pausedReason === "agent" ? <Action label="重新创建评论助手" disabled={busy} onPress={openDialog} /> : null}
        {page?.archivable ? <Action label={`归档已处理的评论（${page.archivable}）`} disabled={busy} onPress={() => setArchiveConfirm(true)} testID="board-inbox-archive" /> : null}
      </View>
      {archiveConfirm && page?.archivable ? <View style={{ gap: 8 }}>
        <Copy small>{`把 ${page.archivable} 条已解决或已忽略的评论移出收件箱？它们会保存在这台电脑的归档文件里，不再显示。`}</Copy>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><Action label="归档" disabled={busy} onPress={archive} /><Action label="取消" disabled={busy} onPress={() => setArchiveConfirm(false)} /></View>
      </View> : null}
    </View> : null}
    {page ? <Copy muted small>{page.total} 条评论 · {page.sources.filter(source => source.enabled).length} 个已启用来源 · 内部备注和处理状态不会发给访客</Copy> : null}
    {page && !comments.length ? <Notice text="还没有评论。连接后端来源后会自动同步。" /> : null}
    {comments.map(comment => {
      const editor = editors[comment.id];
      const pending = comment.pendingReply;
      return <View key={comment.id} testID={`board-inbox-comment-${comment.id}`} style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 12, gap: 8, backgroundColor: c.surface0 }}>
        <Copy small>{statuses[comment.status]} · {comment.authorName ? shown(comment.authorName) : "访客"} · {new Date(comment.createdAt).toLocaleString()}{comment.visitorTag ? ` · 访客 ${comment.visitorTag}` : ""}</Copy>
        <Copy>{shown(comment.text)}</Copy>
        {comment.anchor?.quote ? <Copy muted small>引用：「{shown(clip(comment.anchor.quote, 200))}」</Copy> : null}
        {comment.anchor?.label || comment.anchor?.selector ? <Copy muted small>位置：{shown(comment.anchor.label ?? comment.anchor.selector ?? "")}</Copy> : null}
        {comment.pageUrl ? <Copy muted small>{comment.pageUrl}</Copy> : null}
        <Copy muted small>来源：{page?.sources.find(source => source.sourceId === comment.sourceId)?.label ?? comment.sourceId} · 外部输入</Copy>
        {comment.labels.length ? <Copy small>标签：{shown(comment.labels.join("、"))}</Copy> : null}
        {comment.note ? <Copy small>内部备注：{shown(comment.note)}</Copy> : null}
        {(comment.replies ?? []).map(reply => <View key={reply.id} style={{ gap: 4, paddingLeft: 10, borderLeftWidth: 2, borderColor: c.accent }}>
          <Copy muted small>{`${reply.authorKind === "agent" ? "AI 助手回复" : "作者回复"} · ${new Date(reply.createdAt).toLocaleString()}`}</Copy>
          <Copy>{shown(reply.text)}</Copy>
        </View>)}
        {pending?.state === "sending" ? <Copy small muted>回复发送中…</Copy> : null}
        {pending?.state === "draft" ? <View style={{ gap: 6, paddingLeft: 10, borderLeftWidth: 2, borderColor: c.border }}>
          <Copy small muted>AI 草稿（待你审核）</Copy>
          <Copy>{shown(pending.text)}</Copy>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Action label="发布" disabled={busy} onPress={() => pendingAction(comment, "publish")} />
            <Action label="修改后发布" disabled={busy} onPress={() => edit(comment.id, { text: pending.text, mode: "publish", key: pending.key, phase: "editing", eventId: undefined })} />
            <Action label="丢弃" disabled={busy} onPress={() => pendingAction(comment, "discard")} />
          </View>
        </View> : null}
        {pending?.state === "failed" ? <View style={{ gap: 6 }}>
          <Copy small>{`回复没能送达：${pending.failedReason ?? "原因未知"}`}</Copy>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Action label="重试" disabled={busy} onPress={() => pendingAction(comment, "retry")} />
            <Action label="丢弃" disabled={busy} onPress={() => pendingAction(comment, "discard")} />
          </View>
        </View> : null}
        {!comment.visitorTag ? <Copy small muted>这位访客看不到回复（不是从页面评论功能发出的）。</Copy> : null}
        {editor ? <View style={{ gap: 8 }}>
          <TextInput value={editor.text} onChangeText={text => edit(comment.id, { text, phase: "editing", eventId: undefined })} editable={!busy && editor.phase === "editing"} multiline maxLength={2_000} placeholder="公开回复，访客可见，最多 2000 字" placeholderTextColor={c.foregroundMuted} style={field} accessibilityLabel="公开回复" />
          {editor.phase === "guard" ? <>
            <Copy small>{`回复看起来包含私密信息（${editor.reason}）。仍然发送？`}</Copy>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Action label="仍然发送" disabled={busy} onPress={() => editor.mode === "publish" && !editor.eventId && editor.text === pending?.text ? pendingAction(comment, "publish", true) : sendReply(comment, true)} />
              <Action label="修改" disabled={busy} onPress={() => edit(comment.id, { phase: "editing", eventId: undefined, reason: undefined })} />
            </View>
          </> : editor.phase === "unknown" ? <>
            <Copy small>送达结果未知，回复原文已保留。点「重试」会用同一编号，不会重复发送。</Copy>
            {editor.error ? <Copy small muted>{editor.error}</Copy> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Action label="重试" disabled={busy} onPress={() => sendReply(comment)} />
              <Action label="取消" disabled={busy} onPress={() => edit(comment.id, null)} />
            </View>
          </> : <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Action label={editor.phase === "sending" ? "发送中…" : "发送回复"} primary disabled={busy || !editor.text.trim()} onPress={() => sendReply(comment)} />
            <Action label="取消" disabled={busy} onPress={() => edit(comment.id, null)} />
          </View>}
        </View> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {comment.visitorTag && !editor && page?.permissions.reply && !(pending && pending.state !== "failed") ? <Action label="回复访客" disabled={busy} onPress={() => edit(comment.id, { text: "", mode: "reply", phase: "editing" })} testID={`board-inbox-reply-${comment.id}`} /> : null}
          {page?.permissions.triage && selected !== comment.id ? <Action label="内部处理" disabled={busy} onPress={() => { setSelected(comment.id); setSelectedRevision(comment.revision); setNote(comment.note); setLabels(comment.labels.join(", ")); }} /> : null}
        </View>
        {selected === comment.id ? <View style={{ gap: 8 }}>
          <TextInput value={labels} onChangeText={setLabels} editable={!busy} placeholder="标签，用逗号分隔" placeholderTextColor={c.foregroundMuted} style={field} accessibilityLabel="内部标签" />
          <TextInput value={note} onChangeText={setNote} editable={!busy} multiline maxLength={4_000} placeholder="仅内部可见的备注" placeholderTextColor={c.foregroundMuted} style={field} accessibilityLabel="内部备注" />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {(Object.keys(statuses) as InboxStatus[]).map(status => <Action key={status} label={statuses[status]} active={comment.status === status} disabled={busy} onPress={() => triage(comment, status)} />)}
            <Action label="取消" disabled={busy} onPress={() => setSelected(undefined)} />
          </View>
        </View> : null}
      </View>;
    })}
    {page?.nextCursor ? <Action label="加载更多评论" disabled={busy} onPress={() => void run(() => load(page.nextCursor!))} testID="board-inbox-next" /> : null}
  </ScrollView>;
}
