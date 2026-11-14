import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { InboxHumanReplyInput, InboxPublicState, InboxReadResult, InboxReplyResult, InboxScope } from "../shared/inbox";
import type {
  InboxPublicMessage, InboxPublicPageInput, InboxPublicResult, InboxPublicSourceView, InboxPublicStateInput, InboxPublicThread, InboxPublicThreads, InboxPublicVisitorInput,
} from "../shared/inbox-public";
import { showBidiControls as shown } from "../shared/bidi";
import { Action, Copy, errorMessage, localId, Notice, useColors } from "./ui";

/*
 * 公开讨论: the public comment threads of every page, as the backend serves them, with the owner's controls
 * (public-threads DESIGN §5.5.2 as amended by §12 A3, A9, A15). Human-only UI; all visitor text renders as Text.
 */
export interface InboxThreadsProps {
  scope: InboxScope;
  onThreads(input: InboxScope): Promise<InboxPublicThreads>;
  onPublicState(input: InboxPublicStateInput): Promise<InboxPublicResult>;
  onPublicPage(input: InboxPublicPageInput): Promise<InboxPublicResult>;
  onPublicVisitor(input: InboxPublicVisitorInput): Promise<InboxPublicResult>;
  onRead(input: InboxScope & { commentId: string }): Promise<InboxReadResult>;
  onReply(input: InboxHumanReplyInput): Promise<InboxReplyResult>;
}
export const THREADS_TEXT = {
  notice: "公开讨论里的评论和回复，所有打开页面的人都能看到。你可以在页面上隐藏不当内容，或把讨论标为已解决。",
  empty: "还没有公开讨论。发布时把「评论可见范围」设为「公开」后，访客的评论会显示在这里。",
  shown: "页面上：公开显示", resolved: "页面上：已解决（访客在「全部」里能看到）",
  hiddenThread: "页面上：已隐藏（访客看不到这个讨论）", hiddenReply: "页面上：已隐藏（访客看不到这条回复）", withdrawn: "页面上：访客已撤回",
  syncing: " · 正在同步到后端…", hide: "在页面上隐藏", show: "在页面上显示", resolve: "标为已解决", reopen: "重新打开",
  hideVisitor: "隐藏这位访客的全部公开评论", showVisitor: "重新显示这位访客的公开评论",
  pause: "暂停新的公开评论", resume: "恢复公开评论", paused: "已暂停新的公开评论：访客现在不能在这个页面发表新的公开评论或回复。",
  replyThread: "回复这个讨论", replyOne: "回复这条", placeholder: "公开回复，所有访客都能看到，最多 2000 字",
  notImported: "这条评论还没有同步到收件箱，暂时不能回复。",
} as const;
const POLL_MS = 10_000;
const labelOf = (message: Pick<InboxPublicMessage, "name" | "tag">) => {
  const tag = message.tag ? `访客·${message.tag.slice(0, 6)}` : "访客";
  return message.name ? `${shown(message.name)}（${tag}）` : tag;
};
const time = (value: string) => { const at = Date.parse(value); return Number.isNaN(at) ? "" : new Date(at).toLocaleString(); };
const stateLine = (state: InboxPublicState | undefined, root: boolean, resolved: boolean) => {
  if (!state) return "";
  const base = state.withdrawn ? THREADS_TEXT.withdrawn : state.hidden ? (root ? THREADS_TEXT.hiddenThread : THREADS_TEXT.hiddenReply) : resolved ? THREADS_TEXT.resolved : THREADS_TEXT.shown;
  return base + (state.pending && Object.keys(state.pending).length && !state.error ? THREADS_TEXT.syncing : "");
};
type Ask = { kind: "hide"; source: string; thread: InboxPublicThread } | { kind: "visitor"; source: string; page: string; tag: string; hidden: boolean; count: number };
type Editor = { commentId: string; text: string; eventId?: string; phase: "editing" | "sending" };

export function InboxThreads(props: InboxThreadsProps) {
  const { scope } = props;
  const c = useColors();
  const [data, setData] = useState<InboxPublicThreads>();
  const [failure, setFailure] = useState<string>(), [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false), [ask, setAsk] = useState<Ask | null>(null), [editor, setEditor] = useState<Editor | null>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const alive = useRef(true), flight = useRef(false);
  const load = async () => { const value = await callbacks.current.onThreads(scope); if (alive.current) setData(value); };
  const run = async (action: () => Promise<string | void>) => {
    if (flight.current) return;
    flight.current = true; setBusy(true); setFailure(undefined); setNotice(undefined);
    try { const message = await action(); await load(); if (message && alive.current) setNotice(message); }
    catch (error) { if (alive.current) setFailure(errorMessage(error)); }
    finally { flight.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true; void run(async () => undefined);
    const timer = setInterval(() => { if (!flight.current) void load().catch(() => undefined); }, POLL_MS);
    return () => { alive.current = false; clearInterval(timer); };
  }, [scope.boardId, scope.expectedCreatedAt]);

  const setState = (source: string, message: InboxPublicMessage, change: { hidden?: boolean; resolved?: boolean; retry?: true }, parentId?: string) => run(async () => {
    const result = await callbacks.current.onPublicState({ ...scope, eventId: localId("inbox-public"), sourceId: source, externalId: message.id, ...change,
      known: { hidden: message.state?.hidden ?? false, resolved: message.state?.resolved ?? false, ...(message.state?.withdrawn ? { withdrawn: true as const } : {}), ...(parentId ? { parentId } : {}), ...(message.tag ? { publicTag: message.tag } : {}) } });
    return result.message;
  });
  const setPage = (source: string, page: string, paused: boolean) => run(async () => (await callbacks.current.onPublicPage({ ...scope, eventId: localId("inbox-page"), sourceId: source, page, paused })).message);
  const setVisitor = (source: string, page: string, tag: string, hidden: boolean) => run(async () => {
    const result = await callbacks.current.onPublicVisitor({ ...scope, eventId: localId("inbox-visitor"), sourceId: source, page, tag, hidden });
    return result.status === "applied" && result.changed !== undefined ? `${result.message}（${result.changed} 条）` : result.message;
  });
  const sendReply = () => run(async () => {
    if (!editor) return;
    const eventId = editor.eventId ?? localId("inbox-public-reply");
    setEditor({ ...editor, eventId, phase: "sending" });
    const read = await callbacks.current.onRead({ ...scope, commentId: editor.commentId });
    const result = await callbacks.current.onReply({ ...scope, commentId: editor.commentId, expectedCommentRevision: read.comment.revision, eventId, text: editor.text, resolve: false });
    if (alive.current) setEditor(null);
    return result.message;
  });

  const field = { color: c.foreground, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 6, padding: 8, fontSize: 13 };
  const row = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 };
  const replyEditor = (commentId: string) => editor?.commentId === commentId ? <View style={{ gap: 8 }}>
    <TextInput value={editor.text} onChangeText={text => setEditor({ ...editor, text, eventId: undefined })} editable={!busy && editor.phase === "editing"} multiline maxLength={2_000} placeholder={THREADS_TEXT.placeholder} placeholderTextColor={c.foregroundMuted} style={field} accessibilityLabel="公开回复" />
    <View style={row}>
      <Action label={editor.phase === "sending" ? "发送中…" : "发送回复"} primary disabled={busy || !editor.text.trim()} onPress={() => void sendReply()} testID={`board-inbox-thread-send-${commentId}`} />
      <Action label="取消" disabled={busy} onPress={() => setEditor(null)} />
    </View>
  </View> : null;
  const stateView = (source: string, message: InboxPublicMessage, root: boolean, resolved: boolean, thread: InboxPublicThread) => {
    const state = message.state;
    if (!state) return null;
    return <View style={{ gap: 6 }}>
      <View testID={`board-inbox-public-${message.id}`}><Copy small muted>{stateLine(state, root, resolved)}</Copy></View>
      {state.error ? <View style={{ gap: 6 }}>
        <Copy small>{`页面状态没能同步：${state.error}`}</Copy>
        <Action label="重试" disabled={busy} onPress={() => void setState(source, message, { retry: true }, root ? undefined : thread.id)} testID={`board-inbox-public-retry-${message.id}`} />
      </View> : null}
      <View style={row}>
        {state.withdrawn ? null : state.hidden
          ? <Action label={THREADS_TEXT.show} disabled={busy} onPress={() => void setState(source, message, { hidden: false }, root ? undefined : thread.id)} testID={`board-inbox-hide-${message.id}`} />
          : <Action label={THREADS_TEXT.hide} disabled={busy} onPress={() => root && thread.replies.some(item => item.by === "visitor") ? setAsk({ kind: "hide", source, thread }) : void setState(source, message, { hidden: true }, root ? undefined : thread.id)} testID={`board-inbox-hide-${message.id}`} />}
        {root ? <Action label={resolved ? THREADS_TEXT.reopen : THREADS_TEXT.resolve} disabled={busy} onPress={() => void setState(source, message, { resolved: !resolved })} testID={`board-inbox-resolve-${message.id}`} /> : null}
        {message.tag ? <Action label={THREADS_TEXT.hideVisitor} disabled={busy} onPress={() => setAsk({ kind: "visitor", source, page: thread.page, tag: message.tag!, hidden: true, count: [thread, ...thread.replies].filter(item => item.tag === message.tag).length })} testID={`board-inbox-hide-visitor-${message.id}`} /> : null}
        {message.commentId && !state.withdrawn && editor?.commentId !== message.commentId ? <Action label={root ? THREADS_TEXT.replyThread : THREADS_TEXT.replyOne} disabled={busy} onPress={() => setEditor({ commentId: message.commentId!, text: "", phase: "editing" })} testID={`board-inbox-thread-reply-${message.id}`} /> : null}
      </View>
      {message.commentId ? replyEditor(message.commentId) : null}
    </View>;
  };
  const threadView = (source: InboxPublicSourceView, thread: InboxPublicThread) => {
    const visitorReplies = thread.replies.filter(item => item.by === "visitor").length;
    return <View key={thread.id} testID={`board-inbox-thread-${thread.id}`} style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 12, gap: 8, backgroundColor: c.surface0 }}>
      <Copy small>{`${labelOf(thread)} · ${time(thread.createdAt)} · 公开讨论${visitorReplies ? ` · ${visitorReplies} 条访客回复` : ""}`}</Copy>
      {thread.anchor?.quote ? <Copy muted small>引用：「{shown(thread.anchor.quote.length > 200 ? `${thread.anchor.quote.slice(0, 200)}…` : thread.anchor.quote)}」</Copy> : null}
      <Copy>{shown(thread.text)}</Copy>
      {stateView(source.sourceId, thread, true, thread.resolved, thread)}
      {thread.omitted ? <Copy small muted>{`还有 ${thread.omitted} 条较早的回复没有显示`}</Copy> : null}
      {thread.replies.map(message => {
        const target = message.replyTo ? thread.replies.find(item => item.id === message.replyTo) : undefined;
        if (message.by !== "visitor") return <View key={message.id} style={{ gap: 4, paddingLeft: 10, borderLeftWidth: 2, borderColor: c.accent }}>
          <Copy muted small>{`${message.by === "agent" ? "AI 助手回复" : "作者回复"}${target ? `（回复 ${labelOf(target)}）` : ""} · ${time(message.createdAt)}`}</Copy>
          <Copy>{shown(message.text)}</Copy>
        </View>;
        return <View key={message.id} testID={`board-inbox-visitor-reply-${message.id}`} style={{ gap: 4, marginLeft: 10, padding: 10, borderWidth: 1, borderRadius: 8, borderColor: c.border }}>
          <Copy small>{`访客回复 · ${labelOf(message)} · ${time(message.createdAt)}`}</Copy>
          <Copy>{shown(message.text)}</Copy>
          {stateView(source.sourceId, message, false, false, thread)}
        </View>;
      })}
    </View>;
  };
  const sources = data?.sources ?? [];
  const any = sources.some(source => source.threads.length);
  return <ScrollView testID="board-inbox-threads" contentContainerStyle={{ padding: 16, gap: 12 }}>
    <Copy>公开讨论</Copy>
    {any ? <View testID="board-inbox-public-notice"><Notice text={THREADS_TEXT.notice} /></View> : null}
    {failure ? <Notice error text={failure} /> : null}{notice ? <Notice text={notice} /> : null}
    <Action label="刷新" disabled={busy} onPress={() => void run(async () => undefined)} testID="board-inbox-threads-refresh" />
    {ask ? <View testID="board-inbox-threads-confirm" style={{ gap: 8, padding: 10, borderWidth: 1, borderRadius: 8, borderColor: c.accent }}>
      <Copy small>{ask.kind === "hide" ? `整个讨论（含 ${ask.thread.replies.filter(item => item.by === "visitor").length} 条回复）都会从页面上隐藏。` : `这位访客在这个页面上的全部公开评论（这里能看到的有 ${ask.count} 条）都会从页面上隐藏。`}</Copy>
      <View style={row}>
        <Action label="隐藏" primary disabled={busy} onPress={() => { const current = ask; setAsk(null); if (current.kind === "hide") void setState(current.source, current.thread, { hidden: true }); else void setVisitor(current.source, current.page, current.tag, current.hidden); }} testID="board-inbox-threads-confirm-hide" />
        <Action label="取消" disabled={busy} onPress={() => setAsk(null)} />
      </View>
    </View> : null}
    {data && !sources.length ? <Copy small muted>还没有连接后端来源。</Copy> : null}
    {data && sources.length && !any ? <Copy small muted>{THREADS_TEXT.empty}</Copy> : null}
    {sources.map(source => {
      const pages = [...new Set([...source.pages.map(page => page.page), ...source.threads.map(thread => thread.page)])];
      return <View key={source.sourceId} style={{ gap: 10 }}>
        <Copy small muted>{`来源：${source.label}`}</Copy>
        {source.error ? <Notice error={source.state === "error"} text={source.error} /> : null}
        {source.truncated ? <Copy small muted>{`只显示最近的 ${source.threads.length} 个讨论（共 ${source.total} 个）。`}</Copy> : null}
        {pages.map((page, index) => {
          const info = source.pages.find(item => item.page === page), threads = source.threads.filter(thread => thread.page === page);
          if (!threads.length && !info?.paused) return null;
          return <View key={page} style={{ gap: 8 }}>
            <Copy small>{`页面：${page}`}</Copy>
            {info?.paused ? <Copy small muted>{THREADS_TEXT.paused}{info.pending ? THREADS_TEXT.syncing : ""}</Copy> : null}
            {info?.error ? <Copy small>{`页面设置没能同步：${info.error}`}</Copy> : null}
            <View style={row}><Action label={info?.paused ? THREADS_TEXT.resume : THREADS_TEXT.pause} disabled={busy} onPress={() => void setPage(source.sourceId, page, !info?.paused)} testID={`board-inbox-pause-${index}`} /></View>
            {threads.map(thread => threadView(source, thread))}
          </View>;
        })}
      </View>;
    })}
  </ScrollView>;
}
