import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { InboxComment, InboxListInput, InboxMutationResult, InboxPage, InboxPolicyInput, InboxScope, InboxStatus, InboxTriageInput } from "../shared/inbox";
import { Action, Copy, errorMessage, localId, Notice, useColors } from "./ui";

export interface InboxPanelProps {
  scope: InboxScope;
  onList(input: InboxListInput): Promise<InboxPage>;
  onPolicy(input: InboxPolicyInput): Promise<InboxMutationResult>;
  onTriage(input: InboxTriageInput): Promise<InboxMutationResult>;
}
const statuses: Record<InboxStatus, string> = { new: "未处理", reviewing: "处理中", resolved: "已处理", dismissed: "不处理" };

/** Human-only inbox UI. It renders external text as text and exposes no send/publish/application action. */
export function InboxPanel({ scope, onList, onPolicy, onTriage }: InboxPanelProps) {
  const c = useColors();
  const [page, setPage] = useState<InboxPage>();
  const [comments, setComments] = useState<InboxComment[]>([]);
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [selectedRevision, setSelectedRevision] = useState<number>();
  const [note, setNote] = useState("");
  const [labels, setLabels] = useState("");
  const flight = useRef(false), generation = useRef(0);
  const callbacks = useRef({ onList, onPolicy, onTriage }); callbacks.current = { onList, onPolicy, onTriage };
  const field = { color: c.foreground, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 6, padding: 8, fontSize: 13 };
  const load = async (cursor?: string) => {
    const current = generation.current;
    const result = await callbacks.current.onList({ ...scope, ...(cursor ? { cursor } : {}), limit: 30 });
    if (current !== generation.current) return;
    setPage(result); setComments(previous => cursor ? [...new Map([...previous, ...result.comments].map(comment => [comment.id, comment])).values()] : result.comments);
  };
  const run = async (action: (current: number) => Promise<void>) => {
    if (flight.current) return;
    const current = generation.current;
    flight.current = true; setBusy(true); setFailure(undefined);
    try { await action(current); }
    catch (error) { if (current === generation.current) setFailure(errorMessage(error)); }
    finally { if (current === generation.current) { flight.current = false; setBusy(false); } }
  };
  useEffect(() => {
    generation.current++; flight.current = false; setPage(undefined); setComments([]); setSelected(undefined); setFailure(undefined);
    void run(() => load());
    return () => { generation.current++; flight.current = false; };
  }, [scope.boardId, scope.expectedCreatedAt]);

  const policy = (read: boolean, triage: boolean) => {
    if (!page || !page.permissions.configure) return;
    void run(async current => {
      await callbacks.current.onPolicy({ ...scope, eventId: localId("inbox-policy"), expectedRevision: page.revision, policy: { read, triage } });
      if (current !== generation.current) return;
      await load();
    });
  };
  const triage = (comment: InboxComment, status: InboxStatus) => {
    if (!page || !page.permissions.triage || selected !== comment.id || selectedRevision === undefined) return;
    void run(async current => {
      await callbacks.current.onTriage({ ...scope, eventId: localId("inbox-triage"), expectedRevision: page.revision, commentId: comment.id, expectedCommentRevision: selectedRevision, status, note, labels: labels.split(/[,，]/).map(value => value.trim()).filter(Boolean) });
      if (current !== generation.current) return;
      setSelected(undefined); await load();
    });
  };

  return <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} testID="board-inbox-panel">
    <Copy>评论收件箱</Copy>
    <Copy muted small>外部评论单独保存在这里。允许读取或内部处理不会自动唤醒 agent，也不会授权修改应用或公开回复。</Copy>
    {failure ? <Notice text={failure} error /> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Action label={busy ? "读取中…" : "刷新收件箱"} disabled={busy} onPress={() => void run(() => load())} testID="board-inbox-refresh" />
      {page?.permissions.configure ? <>
        <Action label={`Agent 读取：${page.policy.read ? "已允许" : "未允许"}`} active={page.policy.read} disabled={busy} onPress={() => policy(!page.policy.read, false)} testID="board-inbox-policy-read" />
        <Action label={`Agent 内部处理：${page.policy.triage ? "已允许" : "未允许"}`} active={page.policy.triage} disabled={busy || !page.policy.read} onPress={() => policy(true, !page.policy.triage)} testID="board-inbox-policy-triage" />
      </> : null}
    </View>
    {page ? <Copy muted small>{page.total} 条评论 · {page.sources.filter(source => source.enabled).length} 个已启用来源 · 内部备注和处理状态不会发给访客</Copy> : null}
    {page && !comments.length ? <Notice text="还没有导入评论。配置后端来源后，由你主动同步。" /> : null}
    {comments.map(comment => <View key={comment.id} testID={`board-inbox-comment-${comment.id}`} style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 12, gap: 8, backgroundColor: c.surface0 }}>
      <Copy small>{statuses[comment.status]} · {comment.authorName ?? "访客"} · {new Date(comment.createdAt).toLocaleString()}</Copy>
      <Copy>{comment.text}</Copy>
      {comment.anchor?.label || comment.anchor?.selector ? <Copy muted small>位置：{comment.anchor.label ?? comment.anchor.selector}</Copy> : null}
      {comment.pageUrl ? <Copy muted small>{comment.pageUrl}</Copy> : null}
      <Copy muted small>来源：{page?.sources.find(source => source.sourceId === comment.sourceId)?.label ?? comment.sourceId} · 外部输入</Copy>
      {comment.labels.length ? <Copy small>标签：{comment.labels.join("、")}</Copy> : null}
      {comment.note ? <Copy small>内部备注：{comment.note}</Copy> : null}
      {page?.permissions.triage && selected !== comment.id ? <Action label="内部处理" disabled={busy} onPress={() => { setSelected(comment.id); setSelectedRevision(comment.revision); setNote(comment.note); setLabels(comment.labels.join(", ")); }} /> : null}
      {selected === comment.id ? <View style={{ gap: 8 }}>
        <TextInput value={labels} onChangeText={setLabels} editable={!busy} placeholder="标签，用逗号分隔" placeholderTextColor={c.foregroundMuted} style={field} accessibilityLabel="内部标签" />
        <TextInput value={note} onChangeText={setNote} editable={!busy} multiline maxLength={4_000} placeholder="仅内部可见的备注" placeholderTextColor={c.foregroundMuted} style={field} accessibilityLabel="内部备注" />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(Object.keys(statuses) as InboxStatus[]).map(status => <Action key={status} label={statuses[status]} active={comment.status === status} disabled={busy} onPress={() => triage(comment, status)} />)}
          <Action label="取消" disabled={busy} onPress={() => setSelected(undefined)} />
        </View>
      </View> : null}
    </View>)}
    {page?.nextCursor ? <Action label="加载更多评论" disabled={busy} onPress={() => void run(() => load(page.nextCursor!))} testID="board-inbox-next" /> : null}
  </ScrollView>;
}
