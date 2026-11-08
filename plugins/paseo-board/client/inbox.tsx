import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { inboxListRpc, inboxPolicyRpc, inboxTriageRpc, type InboxScope } from "../shared/inbox";
import { inboxConnectRpc, inboxConnectionsRpc, inboxSyncRpc, inboxReconcileRpc, type InboxConnectInput, type InboxConnection } from "../shared/inbox-connection";
import { useBoardRpc } from "./transport";
import { InboxPanel } from "./inbox-panel";
import { Action, Copy, Notice, errorMessage, localId, useColors } from "./ui";

/** Mounted only in a trusted Board modal, never in authored canvas HTML. */
export function BoardInbox({ scope, hostId }: { scope: InboxScope; hostId: string }) {
  const [tab, setTab] = useState<"comments" | "sources">("comments");
  const list = useBoardRpc(inboxListRpc, hostId), policy = useBoardRpc(inboxPolicyRpc, hostId), triage = useBoardRpc(inboxTriageRpc, hostId);
  return <View style={{ minHeight: 300, maxHeight: 760 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", padding: 12, gap: 8 }}>
      <Action label="评论与权限" active={tab === "comments"} onPress={() => setTab("comments")} />
      <Action label="后端来源" active={tab === "sources"} onPress={() => setTab("sources")} />
    </View>
    {tab === "comments" ? <InboxPanel key={JSON.stringify(scope)} scope={scope} onList={list} onPolicy={policy} onTriage={triage} /> : <InboxSources scope={scope} hostId={hostId} />}
  </View>;
}

function InboxSources({ scope, hostId }: { scope: InboxScope; hostId: string }) {
  const c = useColors(), list = useBoardRpc(inboxListRpc, hostId), connections = useBoardRpc(inboxConnectionsRpc, hostId);
  const connect = useBoardRpc(inboxConnectRpc, hostId), sync = useBoardRpc(inboxSyncRpc, hostId), reconcile = useBoardRpc(inboxReconcileRpc, hostId);
  const [sources, setSources] = useState<InboxConnection[]>([]), [error, setError] = useState<string>(), [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false), [editing, setEditing] = useState<InboxConnection>();
  const [sourceId, setSourceId] = useState(""), [deploymentId, setDeploymentId] = useState(""), [label, setLabel] = useState(""), [endpoint, setEndpoint] = useState(""), [token, setToken] = useState("");
  const pending = useRef<InboxConnectInput | undefined>(undefined), flight = useRef(false), alive = useRef(true);
  const field = { color: c.foreground, backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 6, padding: 8, fontSize: 13 };
  const refresh = async () => { const result = await connections(scope); if (alive.current) setSources(result); };
  const run = async (action: () => Promise<void>) => {
    if (flight.current) return; flight.current = true; setBusy(true); setError(undefined); setNotice(undefined);
    try { await action(); } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
    finally { if (alive.current) { flight.current = false; setBusy(false); } }
  };
  useEffect(() => { alive.current = true; void run(refresh); return () => { alive.current = false; }; }, []);
  const reset = () => { pending.current = undefined; setEditing(undefined); setSourceId(""); setDeploymentId(""); setLabel(""); setEndpoint(""); setToken(""); };
  const edit = (source: InboxConnection) => { pending.current = undefined; setEditing(source); setSourceId(source.sourceId); setDeploymentId(source.deploymentId); setLabel(source.label); setEndpoint(source.endpoint); setToken(""); };
  const save = (enabled = true) => void run(async () => {
    const input = pending.current ?? { ...scope, expectedRevision: (await list({ ...scope, limit: 1 })).revision, eventId: localId("inbox-connect"), expectedConnectionEventId: editing?.eventId ?? null, sourceId: sourceId.trim(), deploymentId: deploymentId.trim(), label: label.trim(), endpoint: endpoint.trim(), enabled, ...(token ? { token } : {}) };
    if (!alive.current) return;
    pending.current = input;
    await connect(input);
    if (!alive.current) return;
    reset(); setNotice("来源配置已保存。点击同步读取评论；这不会通知或唤醒 agent。"); await refresh();
  });
  const update = (source: InboxConnection, action: "sync" | "disable" | "reconcile") => void run(async () => {
    if (action === "reconcile") { await reconcile({ ...scope, sourceId: source.sourceId, eventId: source.eventId }); }
    else {
      const state = await list({ ...scope, limit: 1 });
      if (!alive.current) return;
      if (action === "sync") {
        const result = await sync({ ...scope, sourceId: source.sourceId, expectedRevision: state.revision, eventId: localId("inbox-sync") });
        if (alive.current) setNotice(`已导入 ${result.imported ?? 0} 条，重复 ${result.duplicates ?? 0} 条。可继续同步下一页。`);
      } else {
        const { sourceId, deploymentId, label, endpoint } = source;
        await connect({ ...scope, sourceId, deploymentId, label, endpoint, enabled: !source.enabled, expectedConnectionEventId: source.eventId, expectedRevision: state.revision, eventId: localId("inbox-connect") });
      }
    }
    if (alive.current) await refresh();
  });
  return <ScrollView testID="board-inbox-sources" contentContainerStyle={{ padding: 16, gap: 12 }}>
    <Copy>连接应用的评论导出接口</Copy>
    <Copy small muted>从当前 Paseo host 通过 HTTPS 读取。SSH 用于部署和维护；此处不填写 SSH 密钥。导出令牌只存于该 host，不会提供给 agent 或放入网页。</Copy>
    {error ? <Notice error text={error} /> : null}{notice ? <Notice text={notice} /> : null}
    <Action label="刷新来源状态" disabled={busy} onPress={() => void run(refresh)} />
    {sources.map(source => <View key={source.sourceId} style={{ padding: 12, gap: 6, borderWidth: 1, borderRadius: 8, borderColor: c.border }}>
      <Copy>{source.label} · {source.state === "pending" ? "配置待核对" : source.enabled ? "已启用" : "已停用"}</Copy>
      <Copy small muted>{source.endpoint}</Copy>
      <Copy small muted>来源 {source.sourceId} · 部署 {source.deploymentId}</Copy>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {source.state === "pending" ? <Action label="核对上次配置" disabled={busy} onPress={() => update(source, "reconcile")} /> : <>
          <Action label="同步一页评论" disabled={busy || !source.enabled} onPress={() => update(source, "sync")} />
          <Action label={source.enabled ? "停用来源" : "启用来源"} disabled={busy} onPress={() => update(source, "disable")} />
          <Action label="编辑连接" disabled={busy} onPress={() => edit(source)} />
        </>}
      </View>
    </View>)}
    <Copy>{editing ? "编辑来源（留空令牌沿用现有令牌）" : "添加来源"}</Copy>
    <TextInput accessibilityLabel="来源 ID" value={sourceId} onChangeText={setSourceId} editable={!busy && !editing && !pending.current} placeholder="来源 ID，例如 team-app" placeholderTextColor={c.foregroundMuted} style={field} />
    <TextInput accessibilityLabel="部署 ID" value={deploymentId} onChangeText={setDeploymentId} editable={!busy && !editing && !pending.current} placeholder="后端的 deploymentId" placeholderTextColor={c.foregroundMuted} style={field} />
    <TextInput accessibilityLabel="来源名称" value={label} onChangeText={setLabel} editable={!busy && !pending.current} placeholder="来源名称" placeholderTextColor={c.foregroundMuted} style={field} />
    <TextInput accessibilityLabel="评论导出接口" value={endpoint} onChangeText={setEndpoint} editable={!busy && !pending.current} autoCapitalize="none" placeholder="https://app.example.com/_board/comments" placeholderTextColor={c.foregroundMuted} style={field} />
    <TextInput accessibilityLabel="评论导出令牌" value={token} onChangeText={setToken} editable={!busy && !pending.current} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="BOARD_INBOX_EXPORT_TOKEN" placeholderTextColor={c.foregroundMuted} style={field} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Action label={pending.current ? "重试原配置" : "保存来源"} disabled={busy || !sourceId.trim() || !deploymentId.trim() || !endpoint.trim() || !label.trim()} onPress={() => save(editing?.enabled ?? true)} />
      <Action label="清空表单" disabled={busy} onPress={reset} />
    </View>
    <Copy small muted>本地开发可使用 localhost / 127.0.0.1 的 HTTP 接口。同步按来源保存游标，不覆盖应用数据，也不公开回复。</Copy>
  </ScrollView>;
}
