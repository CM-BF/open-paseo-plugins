import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/ui";
import type { Board } from "../shared/contracts";
import { inboxConnectionsRpc, type InboxConnection } from "../shared/inbox-connection";
import {
  PublicApiBaseSchema, commentsProbeRefusal, commentsProbeRpc, commentsProbeText, internalApiHost, isLoopbackOrigin,
  type CommentsProbeResult, type Share, type VisitorCommentsRelease,
} from "../shared/release-contracts";
import { useBoardRpc } from "./transport";
import { Action, Copy, Notice, errorMessage, useColors } from "./ui";

const EXPORT_SUFFIX = "/_board/comments";
export const COMMENTS_TEXT = {
  toggle: "访客可以框选评论",
  off: "开启后，访客可以在发布页上选中文字，右键或点「评论」留言，并看到你的回复。评论保存在你部署的后端里。",
  help: "评论发送到这个后端（需要 comments.enabled），并由本 Board 的「评论收件箱」自动同步。地址由你部署和决定；要在 board-app.json 的 origins 里加入发布网站的地址。",
  loopback: "这是本机地址：只有在运行这个后端的电脑上打开页面才能评论。",
  notConnected: "这个后端还没有连接到本 Board 的评论收件箱，评论不会自动同步。请到「更多 → 评论收件箱 → 后端来源」连接（如果收件箱用的是同一后端的另一个地址，可以忽略）。",
  noShares: "首次发布后，再检查一次网站地址是否已加入 origins。",
  proxy: "后端在代理后面，但没有信任代理传来的访客地址：所有访客会共享同一个频率限制。把代理的地址加入 board-app.json 的 comments.trustedProxies，然后重新部署。",
  internalOk: "我确认把这个地址写进公开网页",
  appChanged: "换成了另一个评论后端应用：访客将看不到之前的评论和回复。",
  update: "用面板中的评论设置更新",
} as const;
export const internalHostText = (host: string) => `这个评论后端看起来是内部地址（${host}）。它会写进公开网页的代码里，任何人都能看到；公司网络以外的访客也无法发送评论。`;
export const sharedOriginText = (pageOrigin: string) => `同一网站地址（${pageOrigin}）下的其他页面能读取访客浏览器里的匿名评论编号。GitHub 的 github.io 地址由同一用户或组织的所有仓库共享；企业版 Pages 可能由所有人共享。`;
/** The first ready, enabled inbox source of this Board that is a paseo-board-app export endpoint. */
export const prefillApiBase = (sources: readonly InboxConnection[]) => {
  const source = sources.find(item => item.state === "ready" && item.enabled && item.endpoint.endsWith(EXPORT_SUFFIX));
  return source ? source.endpoint.slice(0, -EXPORT_SUFFIX.length) : "";
};
const originOf = (link: string | undefined) => { try { return link ? new URL(link).origin : undefined; } catch { return undefined; } };

function Check({ label, checked, disabled, onPress, testID }: { label: string; checked: boolean; disabled?: boolean; onPress(): void; testID?: string }) {
  const c = useColors();
  return <Pressable testID={testID} accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, padding: 6, borderRadius: 6, backgroundColor: pressed ? c.surface2 : "transparent", opacity: disabled ? 0.5 : 1 })}>
    <View style={{ width: 16, height: 16, borderRadius: 4, borderWidth: 1, borderColor: checked ? c.accent : c.border, backgroundColor: checked ? c.accent : c.surface1, alignItems: "center", justifyContent: "center" }}>{checked ? <Text style={{ color: c.accentForeground, fontSize: 11, lineHeight: 14 }}>✓</Text> : null}</View>
    <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 18 }}>{label}</Text>
  </Pressable>;
}

/**
 * The publishing panel's visitor-comments setting (DESIGN §4.11, §11.9). The human chooses the backend
 * address; the host checks it and reads its app key. Nothing here can make the backend reachable.
 */
export function useReleaseComments(board: Board, context: { shares: readonly Share[]; githubHost: string; account: string }) {
  const c = useColors();
  const probeRpc = useBoardRpc(commentsProbeRpc), connections = useBoardRpc(inboxConnectionsRpc);
  const [on, setOn] = useState(false), [apiBase, setApiBase] = useState("");
  const [sources, setSources] = useState<InboxConnection[]>([]);
  const [probe, setProbe] = useState<{ apiBase: string; pageOrigins: string[]; result: CommentsProbeResult }>();
  const [probing, setProbing] = useState(false), [failure, setFailure] = useState<string>(), [internalOk, setInternalOk] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    void connections({ boardId: board.id, expectedCreatedAt: board.createdAt }).then(value => { if (mounted.current) setSources(value); }, () => undefined);
  }, [board.id, board.createdAt, connections]);
  const base = apiBase.trim(), parsed = PublicApiBaseSchema.safeParse(base), valid = parsed.success;
  const pageOrigins = useMemo(() => [...new Set(context.shares.map(share => originOf(share.link)).filter((value): value is string => !!value))].slice(0, 8), [context.shares]);
  const targetHosts = new Set([...context.shares.map(share => share.githubHost), ...(context.account ? [context.githubHost] : [])]);
  const publicTarget = targetHosts.size === 0 || targetHosts.has("github.com");
  const internal = valid ? internalApiHost(base) : null, needsConfirm = !!internal && publicTarget;
  const sitesText = pageOrigins.length ? pageOrigins.join("、") : context.account && context.githubHost === "github.com" ? `https://${context.account.toLowerCase()}.github.io` : "发布网站";
  const current = probe && probe.apiBase === base ? probe.result : undefined;
  const runProbe = async (value: string) => {
    setProbing(true); setFailure(undefined);
    try {
      const result = await probeRpc({ apiBase: value, pageOrigins });
      if (mounted.current) setProbe({ apiBase: value, pageOrigins, result });
      return result;
    } catch (error) { if (mounted.current) setFailure(errorMessage(error)); throw error; }
    finally { if (mounted.current) setProbing(false); }
  };
  /** The block a new release carries; throws the refusal the human has to resolve first. */
  const resolve = async (): Promise<VisitorCommentsRelease | undefined> => {
    if (!on) return undefined;
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "评论后端地址无效");
    if (needsConfirm && !internalOk) throw new Error(`请先勾选「${COMMENTS_TEXT.internalOk}」。`);
    const result = current ?? await runProbe(base), refusal = commentsProbeRefusal(result, undefined);
    if (refusal || !result.appKey) throw new Error(refusal ?? "评论后端检查没有通过");
    return { apiBase: base, appKey: result.appKey };
  };
  const panelSetting = on ? base : null;
  /** The panel's setting differs from what this share link was built with (on/off, or address). */
  const differs = (share: Share) => !!share.settings && (on ? valid : true) && panelSetting !== (share.settings.comments?.apiBase ?? null);
  /** A different backend app means visitors lose their earlier threads; the same app at a new address keeps them. */
  const appChanged = (share: Share) => on && !!current?.appKey && !!share.settings?.comments && share.settings.comments.appKey !== current.appKey;
  const field = { color: c.foreground, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 8, fontSize: 13 };
  const view = (busy: boolean) => <View testID="board-release-comments" style={{ gap: 6 }}>
    <Action testID="board-release-comments-toggle" label={COMMENTS_TEXT.toggle} active={on} disabled={busy} onPress={() => {
      if (!on && !apiBase.trim()) setApiBase(prefillApiBase(sources));
      setOn(value => !value);
    }} />
    {!on ? <Copy small muted>{COMMENTS_TEXT.off}</Copy> : <>
      <TextInput testID="board-release-comments-origin" accessibilityLabel="评论后端地址" placeholder="https://api.example.internal" placeholderTextColor={c.foregroundMuted} autoCapitalize="none" value={apiBase} onChangeText={value => { setApiBase(value); setInternalOk(false); }} editable={!busy} style={field} />
      <Copy small muted>{COMMENTS_TEXT.help}</Copy>
      {base && !valid ? <Notice error text={parsed.error?.issues[0]?.message ?? "评论后端地址无效"} /> : null}
      {valid && isLoopbackOrigin(new URL(base).origin) ? <Copy small muted>{COMMENTS_TEXT.loopback}</Copy> : null}
      {valid && !sources.some(source => source.endpoint === base + EXPORT_SUFFIX) ? <Copy small muted>{COMMENTS_TEXT.notConnected}</Copy> : null}
      <Copy small muted>{sharedOriginText(sitesText)}</Copy>
      {needsConfirm ? <View testID="board-release-comments-internal" style={{ gap: 4 }}>
        <Notice text={internalHostText(internal!)} />
        <Check testID="board-release-comments-internal-ok" label={COMMENTS_TEXT.internalOk} checked={internalOk} disabled={busy} onPress={() => setInternalOk(value => !value)} />
      </View> : null}
      <Action testID="board-release-comments-check" label={probing ? "检查中…" : "检查后端"} disabled={busy || probing || !valid} onPress={() => { void runProbe(base).catch(() => undefined); }} />
      {failure ? <Notice error text={failure} /> : null}
      {current ? <View testID="board-release-comments-probe" style={{ gap: 4 }}>
        <Copy small>{commentsProbeText(current)}</Copy>
        {current.originProblems.map(problem => <Copy key={problem} small muted>{problem}</Copy>)}
        {current.reachable && !probe!.pageOrigins.length ? <Copy small muted>{COMMENTS_TEXT.noShares}</Copy> : null}
        {current.clientIp === "proxied-unconfigured" ? <Copy small muted>{COMMENTS_TEXT.proxy}</Copy> : null}
      </View> : null}
    </>}
  </View>;
  /** The block for a share update from the panel's setting: the checked backend, or false to turn comments off. */
  const forShare = async (): Promise<VisitorCommentsRelease | false> => (await resolve()) ?? false;
  /** Recovered settings of an old share: show what its manifest recorded. */
  const restore = (value: VisitorCommentsRelease | undefined) => { setOn(!!value); setApiBase(value?.apiBase ?? ""); setInternalOk(false); };
  return { on, apiBase: base, view, resolve, forShare, differs, appChanged, restore };
}
export type ReleaseComments = ReturnType<typeof useReleaseComments>;
