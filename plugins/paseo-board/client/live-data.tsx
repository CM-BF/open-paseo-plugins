import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { Board } from "../shared/contracts";
import { LIVE_LIMITS, LiveTokenSchema, liveGetRpc, liveSetRpc, type LiveGetOutput, type LiveMark, type LiveSetInput } from "../shared/live-data";
import { PublicApiOriginSchema } from "../shared/release-contracts";
import { LIVE_RUNTIME_OUTDATED, addLiveMark, liveFields, liveIsArray, liveIsLoopback, liveMarksKey, liveMarksNarrowed, liveMayGrowKeys, liveNeedsSubtree, liveStateNames, liveWithheldText, overlappingLiveMark, removeLiveMark, setLiveMarkSubtree, sharePageOrigins } from "./live-status";
import { useBoardRpc } from "./transport";
import type { LiveStatusController } from "./use-live-status";
import type { ShareStatusController } from "./use-share-status";
import { Action, Copy, Notice, errorMessage, localId, timeLabel, useColors } from "./ui";

type Current = Pick<LiveGetOutput, "channel" | "status">;
type Review = { key: string; value: LiveGetOutput };
type Upsert = Extract<LiveSetInput, { action: "upsert" }>;
const CONSENT_TEXT = "以上内容会公开给任何能打开分享页或访问此后端的人。确认后，agent 或画布对这些路径的修改会在几秒内自动公开，不再逐次询问，直到你暂停或停止。讨论、决策、笔记和未勾选的数据不会发送。公开内容可能留在访客浏览器和缓存中，停止后无法收回已被读取的副本。";
const REVIEW_DEBOUNCE_MS = 300, PREVIEW_REFRESH_MS = 1_000, TRANSIENT_POLL_MS = 2_000, RETRY_POLL_MS = 5_000, IDLE_POLL_MS = 10_000;
const byteText = (bytes: number) => `${bytes.toLocaleString()} 字节`;
const LOCAL_STOP_LABEL = "仅本机停止（后端副本未清除）";

function Check({ label, text, detail, checked, disabled, onPress, testID, indent = 0 }: { label: string; text: string; detail?: string; checked: boolean; disabled?: boolean; onPress(): void; testID?: string; indent?: number }) {
  const c = useColors();
  return <Pressable testID={testID} accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 6, marginLeft: indent * 14, borderRadius: 6, backgroundColor: pressed ? c.surface2 : "transparent", opacity: disabled ? 0.5 : 1 })}>
    <View style={{ width: 16, height: 16, marginTop: 1, borderRadius: 4, borderWidth: 1, borderColor: checked ? c.accent : c.border, backgroundColor: checked ? c.accent : c.surface1, alignItems: "center", justifyContent: "center" }}>{checked ? <Text style={{ color: c.accentForeground, fontSize: 11, lineHeight: 14 }}>✓</Text> : null}</View>
    <View style={{ flex: 1, minWidth: 0 }}><Text style={{ color: c.foreground, fontSize: 13, lineHeight: 18 }}>{text}</Text>{detail ? <Text style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{detail}</Text> : null}</View>
  </Pressable>;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  const c = useColors();
  return <View style={{ gap: 8, paddingTop: 14, borderTopWidth: 1, borderColor: c.border }}><Copy>{title}</Copy>{children}</View>;
}

/** Mounted only in the trusted Board modal. The write token lives in this component's state until it is sent. */
export function LiveDataPanel({ board, hostId, live, shares }: { board: Board; hostId: string; live: LiveStatusController; shares?: ShareStatusController }) {
  const c = useColors();
  const read = useBoardRpc(liveGetRpc, hostId), write = useBoardRpc(liveSetRpc, hostId);
  const scope = useMemo(() => ({ boardId: board.id, expectedCreatedAt: board.createdAt }), [board.id, board.createdAt]);
  const [current, setCurrent] = useState<Current>();
  const [loaded, setLoaded] = useState(false);
  const [origin, setOrigin] = useState(""), [probe, setProbe] = useState<string>(), [probeRun, setProbeRun] = useState(0);
  const [token, setToken] = useState("");
  const [marks, setMarks] = useState<LiveMark[]>([]);
  const [pointer, setPointer] = useState("");
  const [review, setReview] = useState<Review>();
  const [acknowledged, setAcknowledged] = useState<string>();
  const [narrowed, setNarrowed] = useState(false);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string>();
  const mounted = useRef(true), flight = useRef(false), reviewGeneration = useRef(0), writeEpoch = useRef(0);
  const pending = useRef<{ key: string; input: Upsert } | undefined>(undefined);
  const field = { color: c.foreground, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 8, fontSize: 13 };

  const channel = current?.channel ?? null, status = current?.status;
  const pageOrigins = useMemo(() => sharePageOrigins((shares?.shares ?? []).map(share => share.link)), [shares?.shares]);
  const pageOriginsKey = pageOrigins.join("\n");
  const marksKey = liveMarksKey(marks), reviewKey = JSON.stringify([marksKey, probe ?? "", probeRun]);
  const reviewed = review?.key === reviewKey ? review.value : undefined;
  const preview = reviewed?.preview ?? null, backend = reviewed?.backend ?? null;
  const digest = reviewed?.consentDigest ?? null;

  /** A read that started before a later write must not repaint the older channel state. */
  const adopt = (value: LiveGetOutput, epoch: number) => { if (epoch === writeEpoch.current) setCurrent(value); };
  useEffect(() => {
    mounted.current = true;
    void read(scope).then(value => {
      if (!mounted.current) return;
      setCurrent(value);
      if (value.channel) { setOrigin(value.channel.origin); setProbe(value.channel.origin); setMarks(value.channel.marks); }
      setLoaded(true);
    }, error => { if (mounted.current) { setFailure(errorMessage(error)); setLoaded(true); } });
    return () => { mounted.current = false; };
  }, [read, scope]);
  // A review pairs the exact marks with the backend it was probed against; the consent digest comes from it.
  useEffect(() => {
    if (!loaded || (!marks.length && !probe)) { reviewGeneration.current++; setReview(undefined); return; }
    const generation = ++reviewGeneration.current, key = reviewKey, epoch = writeEpoch.current;
    const timer = setTimeout(() => {
      void read({ ...scope, ...(marks.length ? { marks } : {}), ...(probe ? { probeOrigin: probe, pageOrigins } : {}) }).then(value => {
        if (!mounted.current || generation !== reviewGeneration.current) return;
        adopt(value, epoch); setReview({ key, value });
      }, error => { if (mounted.current && generation === reviewGeneration.current) { setReview(undefined); setFailure(errorMessage(error)); } });
    }, REVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [loaded, reviewKey, pageOriginsKey, read, scope]);
  // Values change without touching consent: refresh only the shown preview, and never re-probe per canvas write.
  const revision = board.canvas.revision, firstRevision = useRef(revision);
  useEffect(() => {
    if (revision === firstRevision.current || !marks.length || !reviewed) return;
    const key = reviewKey;
    const timer = setTimeout(() => {
      void read({ ...scope, marks }).then(value => {
        if (mounted.current) setReview(previous => previous?.key === key ? { key, value: { ...previous.value, preview: value.preview } } : previous);
      }, () => {});
    }, PREVIEW_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [revision]);
  const state = status?.state;
  // Status stays current while the panel is open; a state in motion is checked more often.
  useEffect(() => {
    if (!channel) return;
    let active = true;
    const epoch = writeEpoch.current;
    const timer = setTimeout(() => { void read(scope).then(value => { if (active && mounted.current) { adopt(value, epoch); live.refresh(); } }, () => {}); }, state === "retrying" ? RETRY_POLL_MS : state === "pending" || state === "syncing" || state === "revoking" ? TRANSIENT_POLL_MS : IDLE_POLL_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [state, current, read, scope]);

  const run = async (operation: () => Promise<void>) => {
    if (flight.current) return;
    flight.current = true; setBusy(true); setFailure(undefined);
    try { await operation(); }
    catch (error) {
      if (mounted.current) {
        setFailure(errorMessage(error));
        const epoch = writeEpoch.current;
        void read(scope).then(value => { if (mounted.current) adopt(value, epoch); }, () => {});
      }
    }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  };
  const checkBackend = () => {
    const parsed = PublicApiOriginSchema.safeParse(origin.trim());
    if (!parsed.success) { setFailure(parsed.error.issues[0]?.message ?? "后端来源无效"); return; }
    setFailure(undefined); setProbe(parsed.data); setProbeRun(value => value + 1);
  };
  const addPath = (path: string) => {
    const next = addLiveMark(marks, path);
    if (typeof next === "string") { setFailure(next); return false; }
    setFailure(undefined); setMarks(next); return true;
  };

  const canvasData = board.canvas.data;
  const tree = useMemo(() => liveFields(canvasData), [canvasData]);
  const locked = !!channel && channel.state !== "revoked";
  const sameTarget = !!channel && probe === channel.origin && (!backend || backend.deploymentId === channel.deploymentId);
  const deploymentMoved = !!channel && probe === channel.origin && !!backend && backend.deploymentId !== channel.deploymentId && channel.state !== "revoked";
  const deploymentMoveAllowed = status?.lastError?.code === "deployment_changed";
  const tokenNeeded = !channel || channel.state === "revoked" || !sameTarget;
  const tokenValue = token.trim(), tokenTyped = tokenValue.length > 0;
  const tokenValid = !tokenTyped || LiveTokenSchema.safeParse(tokenValue).success;
  const deploymentId = backend?.deploymentId ?? (sameTarget ? channel?.deploymentId : undefined);
  const backendUsable = backend ? backend.live === 1 : sameTarget;
  const subtreeMissing = marks.some(mark => liveNeedsSubtree(canvasData, mark));
  const settled = !!channel && (channel.state === "ready" || channel.state === "pending" || channel.state === "paused") && liveMarksKey(channel.marks) === marksKey && !tokenTyped && !deploymentMoved;
  const ready = origin.trim() === probe && !!digest && !!deploymentId && !!preview && !preview.overLimit && marks.length > 0 && !subtreeMissing && backendUsable && tokenValid && (tokenTyped || !tokenNeeded) && channel?.state !== "revoking" && (!deploymentMoved || deploymentMoveAllowed);
  const ticked = !!digest && acknowledged === digest;
  // Consent covers one exact set: any change withdraws it, even a change back to a set ticked before.
  useEffect(() => { if (acknowledged && acknowledged !== digest) setAcknowledged(undefined); }, [acknowledged, digest]);

  const confirm = () => run(async () => {
    if (!ready || !ticked || !digest || !deploymentId || !probe) return;
    const expectedEventId = channel?.eventId ?? null;
    const key = JSON.stringify([probe, deploymentId, tokenValue, marksKey, digest, expectedEventId]);
    // A retry after a lost response repeats the exact request, so the server can replay its result.
    const input: Upsert = pending.current?.key === key ? pending.current.input : { ...scope, action: "upsert", eventId: localId("live"), expectedEventId, origin: probe, deploymentId, ...(tokenTyped ? { token: tokenValue } : {}), marks, consentDigest: digest, acknowledgedPublic: true };
    pending.current = { key, input };
    writeEpoch.current++;
    const result = await write(input);
    pending.current = undefined;
    if (!mounted.current) return;
    setCurrent(result); setToken(""); setAcknowledged(undefined); setNarrowed(!!channel && liveMarksNarrowed(channel.marks, marks));
    live.refresh();
  });
  const act = (action: "pause" | "revoke" | "stop-local") => run(async () => {
    if (!channel) return;
    writeEpoch.current++;
    const result = await write({ ...scope, action, eventId: localId("live"), expectedEventId: channel.eventId });
    if (mounted.current) { setCurrent(result); setNarrowed(false); live.refresh(); }
  });
  const resume = () => run(async () => {
    if (!channel) return;
    // Read fresh: the panel's digest may describe edited marks rather than the saved channel.
    const fresh = await read(scope);
    if (!fresh.consentDigest) throw new Error("暂时无法确认公开设置，请稍后再试。");
    writeEpoch.current++;
    const result = await write({ ...scope, action: "resume", eventId: localId("live"), expectedEventId: channel.eventId, consentDigest: fresh.consentDigest });
    if (mounted.current) { setCurrent(result); live.refresh(); }
  });

  const showEnvHelp = !channel || channel.state === "revoked" || backend?.live === 0;
  return <ScrollView testID="board-live-panel" contentContainerStyle={{ padding: 16, gap: 14 }} style={{ maxHeight: 760 }}>
    <Copy>把这张 Board 上你勾选的数据实时公开到分享页。页面的外观和代码保持不变，只有这些字段的值会更新。</Copy>
    {failure ? <Notice error text={failure} /> : null}
    <Section title="1. 后端">
      <TextInput testID="board-live-origin" accessibilityLabel="实时数据后端来源" value={origin} onChangeText={setOrigin} editable={!busy && !locked} autoCapitalize="none" autoCorrect={false} placeholder="https://api.example.internal" placeholderTextColor={c.foregroundMuted} style={field} />
      {locked ? <Copy small muted>要换后端，请先停止公开并清除旧后端的副本。</Copy> : null}
      <Action testID="board-live-probe" label="检查后端" disabled={busy || !origin.trim()} onPress={checkBackend} />
      {probe && liveIsLoopback(probe) ? <Copy small muted>仅本机可见，仅用于测试。</Copy> : null}
      {reviewed && probe && !backend ? <Notice text="连不上这个后端，或它不是 Board 应用后端。" /> : null}
      {backend ? <Copy small muted>应用 ID：{backend.id}{"\n"}部署 ID：{backend.deploymentId}</Copy> : null}
      {backend?.live === LIVE_RUNTIME_OUTDATED ? <Notice error text="这个后端的运行时版本过旧，请运行 paseo-board-app update-runtime --dir <应用目录>，再走一次部署。" /> : null}
      {showEnvHelp ? <Copy small muted>在服务器 .env 设置 BOARD_LIVE_WRITE_TOKEN（至少 32 位随机字符），只在这里填写一次；不要让 agent 代填。</Copy> : null}
      {backend?.live === 0 ? <Notice error text="这个后端还没有启用实时数据。设置令牌并重启后端后，再检查一次。" /> : null}
      {deploymentMoved ? <Notice error text={deploymentMoveAllowed ? "后端部署已变更，旧副本已不在这个后端。确认后会连接新的部署。" : "后端的部署 ID 与此前不同。请先停止公开并清除旧后端的副本。"} /> : null}
      <TextInput testID="board-live-token" accessibilityLabel="写入令牌" value={token} onChangeText={setToken} editable={!busy} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder={tokenNeeded ? "BOARD_LIVE_WRITE_TOKEN" : "留空则继续使用已保存的令牌"} placeholderTextColor={c.foregroundMuted} style={field} />
      {tokenTyped && !tokenValid ? <Copy small muted>令牌需为 32–512 位可见 ASCII 字符。</Copy> : null}
    </Section>
    <Section title="2. 公开字段">
      <Copy small muted>只有勾选的路径会发送。根路径不能公开；对象和含对象的数组需要单独勾选「包含以后新增的字段」。</Copy>
      <View testID="board-live-fields" style={{ gap: 2 }}>
        {tree.fields.map(item => {
          const marked = marks.some(mark => mark.path === item.path), overlap = overlappingLiveMark(marks, item.path);
          return <Check key={item.path} testID={`board-live-field-${item.path}`} label={item.path} text={item.key} detail={overlap ? `${item.summary} · 已被 ${overlap} 覆盖` : item.summary} checked={marked} disabled={busy || (!!overlap && !marked)} indent={item.depth} onPress={() => { if (marked) { setFailure(undefined); setMarks(removeLiveMark(marks, item.path)); } else addPath(item.path); }} />;
        })}
        {!tree.fields.length ? <Copy small muted>这张 Board 还没有数据。可以在下面手动填写路径，这个路径有了数据后才会公开。</Copy> : null}
      </View>
      {tree.truncated ? <Copy small muted>字段较多，这里只显示前面的部分；其余路径可手动填写。</Copy> : null}
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <View style={{ flex: 1, minWidth: 0 }}><TextInput accessibilityLabel="手动添加路径" value={pointer} onChangeText={setPointer} editable={!busy} autoCapitalize="none" autoCorrect={false} placeholder="/live/score" placeholderTextColor={c.foregroundMuted} style={field} /></View>
        <Action label="添加路径" disabled={busy || !pointer.trim()} onPress={() => { if (addPath(pointer.trim())) setPointer(""); }} />
      </View>
      {marks.map(mark => <View key={mark.path} style={{ gap: 4, padding: 8, borderWidth: 1, borderRadius: 6, borderColor: c.border }}>
        <Copy small>{mark.path}</Copy>
        {liveMayGrowKeys(canvasData, mark) ? <Check testID={`board-live-subtree-${mark.path}`} label={`${mark.path} 包含以后新增的字段`} text="包含以后新增的字段" detail="对象和含对象的数组必须勾选才会公开" checked={mark.subtree} disabled={busy} onPress={() => setMarks(setLiveMarkSubtree(marks, mark.path, !mark.subtree))} /> : null}
        {liveIsArray(canvasData, mark.path) ? <Copy small muted>数组会不断增长，建议只公开有上限的摘要。</Copy> : null}
        <Action label={`移除 ${mark.path}`} disabled={busy} onPress={() => setMarks(removeLiveMark(marks, mark.path))} />
      </View>)}
      {marks.length ? <Copy small muted>{marks.length} / {LIVE_LIMITS.paths} 个路径</Copy> : null}
    </Section>
    {marks.length ? <Section title="3. 预览">
      <View testID="board-live-preview" style={{ gap: 6 }}>
        {preview ? <>
          {preview.values ? <ScrollView style={{ maxHeight: 220, backgroundColor: c.surface1, borderRadius: 6 }} contentContainerStyle={{ padding: 8 }}><Copy small>{JSON.stringify(preview.values, null, 2)}</Copy></ScrollView> : null}
          <Copy small muted>公开文档 {byteText(preview.bytes)}（上限 {byteText(LIVE_LIMITS.documentBytes)}）{Object.entries(preview.pathBytes).map(([path, bytes]) => `\n${path}：${byteText(bytes)}`).join("")}</Copy>
          {preview.overLimit ? <Notice error text="公开文档超过上限，确认前请减少路径或数据量。" /> : null}
          {preview.withheld.map(item => <Copy key={item.path} small muted>暂不公开 · {liveWithheldText(item)}</Copy>)}
          <Copy small muted>路径名本身也会公开。</Copy>
        </> : <Copy small muted>正在生成预览…</Copy>}
      </View>
    </Section> : null}
    {settled ? <Copy small muted>公开字段已确认。修改字段或更换令牌后需要重新确认。</Copy> : <Section title="4. 确认">
      {subtreeMissing ? <Notice text="有对象或含对象的数组还没有勾选「包含以后新增的字段」。" /> : null}
      <Check testID="board-live-ack" label="确认公开范围" text={CONSENT_TEXT} checked={ticked} disabled={busy || !digest} onPress={() => setAcknowledged(ticked ? undefined : digest ?? undefined)} />
      <Action testID="board-live-confirm" label="确认公开这些数据" primary disabled={busy || !ready || !ticked} onPress={() => { void confirm(); }} />
      {!digest ? <Copy small muted>先检查后端并选择字段，才能确认公开。</Copy> : null}
    </Section>}
    {channel && status ? <Section title="5. 状态">
      <View testID="board-live-status" style={{ gap: 4 }}>
        <Copy>{liveStateNames[status.state]}</Copy>
        <Copy small muted>{channel.origin}</Copy>
        <Copy small muted>{status.pushedAt ? `最后推送 #${status.seq} · ${timeLabel(status.pushedAt)} · 大小 ${byteText(status.pushedBytes ?? 0)} · 对应 canvas 版本 r${status.pushedCanvasRevision ?? 0}` : "还没有成功推送过"}</Copy>
        <Copy small muted>连续失败 {status.attempts} 次{status.nextAttemptAt ? ` · 下次重试 ${timeLabel(status.nextAttemptAt)}` : ""}</Copy>
        {status.lastError ? <Notice error text={`最后错误：${status.lastError.message}`} /> : null}
        {status.withheld.map(item => <Copy key={item.path} small muted>未公开 · {liveWithheldText(item)}</Copy>)}
        {reviewed?.originProblems.map(problem => <Notice key={problem} error text={`访客浏览器可能被后端拒绝：${problem}`} />)}
        {narrowed && (status.state === "retrying" || status.state === "blocked") ? <Notice text="已在本机停止，后端仍保留旧内容，连接恢复后覆盖" /> : null}
      </View>
    </Section> : null}
    {channel && channel.state !== "revoked" ? <Section title="6. 操作">
      {channel.state === "paused" ? <Action testID="board-live-resume" label="恢复推送" disabled={busy} onPress={() => { void resume(); }} /> : null}
      {channel.state === "ready" || channel.state === "pending" ? <><Action testID="board-live-pause" label="暂停推送" disabled={busy} onPress={() => { void act("pause"); }} /><Copy small muted>后端保留上次内容，访客会看到数据已暂停更新。</Copy></> : null}
      <Action testID="board-live-revoke" label="停止公开并清除后端副本" disabled={busy || channel.state === "revoking"} onPress={() => { void act("revoke"); }} />
      <Copy small muted>分享页回到发布时的内容；要恢复需要重新确认。</Copy>
      {channel.state === "revoking" ? <Copy>正在清除后端副本，尚未完成。</Copy> : null}
      {channel.state === "revoking" && status?.lastError ? <>
        <Action testID="board-live-stop-local" label={LOCAL_STOP_LABEL} disabled={busy} onPress={() => { void act("stop-local"); }} />
        <Copy small muted>后端无法完成清除时使用：本机删除令牌并结束重试，后端副本可能仍可被读取。</Copy>
      </> : null}
    </Section> : null}
  </ScrollView>;
}
