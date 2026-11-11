import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { useBoardRpc } from "./transport";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { Board } from "../shared/contracts";
import { copyBoardRpc, type CopyBoardInput } from "../shared/board-copy";
import {
  createReleaseRpc, listReleasesRpc, previewReleaseRpc, downloadReleaseRpc,
  githubAccountsRpc, githubRepositoriesRpc, publishPagesRpc,
  refreshPagesRpc, listPagesJobsRpc, shareUpdateRpc, type ReleaseManifest, type PagesJob,
  PublicApiOriginsSchema,
  type PagesPrepareInput, type GitHubAccount, type GitHubRepository,
} from "../shared/release-contracts";
import { Action, Copy, Notice, errorMessage, localId, useColors } from "./ui";
import { canPreviewRelease, copyText, downloadReleaseZip, ReleasePreview } from "./release-web";
import { createPagesOutbox, pagesGitHubHost, samePagesRequest, samePagesTarget } from "./pages-outbox";
import { browserDraftStorage } from "./draft-storage-web";
import { inheritedSettingsText, mintShareKey, refusedJob, reusableShareKey, shareChanged, shareKeyOf, shareStateNames, type LiveShare } from "./share-status";
import type { ShareStatusController } from "./use-share-status";

const statusNames: Record<PagesJob["status"], string> = {
  prepared: "准备发布文件", "pr-open": "PR 已创建，等待自动合并", merged: "已合并，等待部署", deploying: "部署并核对网页中",
  live: "已核实上线", failed: "发布失败", unknown: "结果待核对",
};
const publicationRequest = (value: PagesPrepareInput): PagesPrepareInput => ({
  eventId: value.eventId, releaseId: value.releaseId, artifactHash: value.artifactHash,
  ...(value.githubHost ? { githubHost: value.githubHost } : {}),
  account: value.account, repository: value.repository, createRepository: value.createRepository,
  ...(value.shareKey ? { shareKey: value.shareKey } : {}),
});
// Refusals a retry cannot change; series-busy may pass once the other update merges.
const finalRefusal = (value: PagesJob) => refusedJob(value) && value.refusal?.code !== "series-busy";
/** One share link being updated from this panel: built by share-update, or regenerated once from recovered settings. */
type ShareTarget = { share: LiveShare; shareKey: string; releaseId?: string; upToDate?: boolean; recovered?: ReleaseManifest };
const VISITOR_NOTICE = "访客本地保存的状态会从新版本重新开始；部分访客可能几分钟后才看到新版（缓存）。";
const automaticallyPublishing = (value: PagesJob) => value.autoPublish === true &&
  !["live", "failed"].includes(value.status) && Boolean(value.autoPublishUntil && Date.parse(value.autoPublishUntil) > Date.now());
const jobStatusName = (value: PagesJob) => value.status === "pr-open" && !automaticallyPublishing(value) ? "PR 已创建，等待继续发布" : statusNames[value.status];

export function ReleasePanel({ board, hostId, onOpenBoard, intent = "publish", shares }: { board: Board; hostId: string; onOpenBoard?(id: string): void; intent?: "publish" | "update"; shares?: ShareStatusController }) {
  const c = useColors();
  const copyBoard = useBoardRpc(copyBoardRpc), create = useBoardRpc(createReleaseRpc), list = useBoardRpc(listReleasesRpc);
  const preview = useBoardRpc(previewReleaseRpc), download = useBoardRpc(downloadReleaseRpc);
  const accounts = useBoardRpc(githubAccountsRpc), repositories = useBoardRpc(githubRepositoriesRpc);
  const publish = useBoardRpc(publishPagesRpc), refresh = useBoardRpc(refreshPagesRpc), listJobs = useBoardRpc(listPagesJobsRpc);
  const shareUpdate = useBoardRpc(shareUpdateRpc);
  const [title, setTitle] = useState(`${board.title} · 发布版`);
  const [publicData, setPublicData] = useState("{}");
  const [network, setNetwork] = useState<"offline" | "cdn">("offline");
  const [apiOriginsText, setApiOriginsText] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [releases, setReleases] = useState<ReleaseManifest[]>([]);
  const [selected, setSelected] = useState<ReleaseManifest>();
  const [html, setHtml] = useState<string>();
  const [reviewed, setReviewed] = useState<string>();
  const [accountList, setAccountList] = useState<GitHubAccount[]>([]), [account, setAccount] = useState("");
  const [githubHostFilter, setGitHubHostFilter] = useState("");
  const [githubHost, setGitHubHost] = useState("github.com");
  const [repoList, setRepoList] = useState<GitHubRepository[]>([]), [repository, setRepository] = useState("");
  const [createRepository, setCreateRepository] = useState<"public" | "private">();
  const [jobs, setJobs] = useState<PagesJob[]>([]), [job, setJob] = useState<PagesJob>();
  const outbox = useMemo(() => createPagesOutbox(hostId, board.id), [hostId, board.id]);
  const [pendingPages, setPendingPages] = useState<PagesPrepareInput[]>([]);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string>();
  const mounted = useRef(true), flight = useRef(false);
  const currentJob = useRef(job); currentJob.current = job;
  const selectedReleaseId = useRef<string | undefined>(undefined), selectionGeneration = useRef(0);
  const copyRequest = useRef<CopyBoardInput | undefined>(undefined);
  const pageRequest = useRef<PagesPrepareInput | undefined>(undefined);
  const [target, setTarget] = useState<ShareTarget>();
  const targetRef = useRef(target); targetRef.current = target;
  const sessionKeys = useRef(new Map<string, string>()), autoUpdate = useRef(false);
  const [copied, setCopied] = useState<string>(), copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  // Updating needs a visible preview and a durable retry record (absent on native/Hermes).
  const desktop = useMemo(() => canPreviewRelease() && browserDraftStorage() !== null, []);
  const shareList = shares?.shares ?? [];
  const field = { color: c.foreground, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 8, fontSize: 13 };
  useEffect(() => {
    mounted.current = true;
    void list({ boardId: board.id }).then(value => { if (mounted.current) setReleases(values => [...values.filter(item => !value.some(saved => saved.releaseId === item.releaseId)), ...value]); }).catch(error => { if (mounted.current) setFailure(errorMessage(error)); });
    return () => { mounted.current = false; };
  }, [board.id, list]);
  useEffect(() => {
    let pending: PagesPrepareInput[];
    try { pending = outbox.list(); setPendingPages(pending); }
    catch (error) { setFailure(errorMessage(error)); return; }
    // Drop retry records the server refused for good; they would only resurface as stale requests.
    let active = true;
    void (async () => {
      for (const releaseId of new Set(pending.map(item => item.releaseId))) {
        const history = await listJobs({ releaseId }).catch(() => [] as PagesJob[]);
        if (!active) return;
        for (const request of pending) if (history.some(item => finalRefusal(item) && samePagesRequest(item, request))) outbox.remove(request.eventId);
      }
      if (active) setPendingPages(outbox.list());
    })();
    return () => { active = false; };
  }, [outbox, listJobs]);
  useEffect(() => {
    if (!job || !automaticallyPublishing(job)) return;
    let active = true, attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (!active || currentJob.current?.jobId !== job.jobId) return;
      if (flight.current) { timer = setTimeout(() => { void check(); }, 5_000); return; }
      try {
        const updated = await refresh({ jobId: job.jobId });
        if (!active || currentJob.current?.jobId !== job.jobId) return;
        setJob(updated); setJobs(values => [updated, ...values.filter(item => item.jobId !== updated.jobId)]);
        if (automaticallyPublishing(updated) && ++attempts < 360) timer = setTimeout(() => { void check(); }, 5_000);
      } catch (error) {
        if (!active || currentJob.current?.jobId !== job.jobId) return;
        setFailure(`暂时无法读取发布进度：${errorMessage(error)}。后台会继续，连接恢复后自动核对。`);
        if (automaticallyPublishing(job) && ++attempts < 360) timer = setTimeout(() => { void check(); }, 5_000);
      }
    };
    timer = setTimeout(() => { void check(); }, 5_000);
    return () => { active = false; clearTimeout(timer); };
  }, [job?.jobId, job?.status, job?.autoPublishUntil, refresh]);
  const run = async (operation: () => Promise<void>) => {
    if (flight.current) return;
    flight.current = true; setBusy(true); setFailure(undefined);
    try { await operation(); } catch (error) { if (mounted.current) setFailure(errorMessage(error)); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  };
  const showRelease = async (release: ReleaseManifest) => {
    const generation = ++selectionGeneration.current;
    selectedReleaseId.current = release.releaseId; currentJob.current = undefined;
    setSelected(undefined); setHtml(undefined); setJob(undefined); setJobs([]); setReviewed(undefined);
    const result = await preview({ releaseId: release.releaseId });
    if (!mounted.current || generation !== selectionGeneration.current) return;
    setSelected(result.manifest); setHtml(result.html); setReviewed(undefined); setJob(undefined);
    const history = await listJobs({ releaseId: release.releaseId });
    if (!mounted.current || generation !== selectionGeneration.current) return;
    setJobs(history);
    const latest = history.find(item => automaticallyPublishing(item)) ?? history.find(item => item.status === "live") ?? history[0];
    currentJob.current = latest; setJob(latest);
    if (latest) { setGitHubHost(pagesGitHubHost(latest)); setAccount(latest.account); setRepository(latest.repository); setCreateRepository(latest.createRepository); }
    for (const request of outbox.list()) if (history.some(item => (item.autoPublish || finalRefusal(item)) && samePagesRequest(item, request))) outbox.remove(request.eventId);
    setPendingPages(outbox.list());
  };
  const rememberJob = (value: PagesJob) => {
    if (!mounted.current || value.releaseId !== selectedReleaseId.current) return;
    currentJob.current = value;
    setJob(value); setJobs(values => [value, ...values.filter(item => item.jobId !== value.jobId)]);
  };
  const openUrl = (url: string) => { void openExternalUrl(url).catch(error => setFailure(errorMessage(error))); };
  const sendPagesRequest = async (request: PagesPrepareInput) => {
    const frozen = outbox.save(request);
    setPendingPages(outbox.list());
    rememberJob(await publish(frozen));
    outbox.remove(frozen.eventId);
    if (mounted.current) setPendingPages(outbox.list());
    shares?.refresh();
  };
  /** Joins this Board's series on the same host+repository, else mints a key once per target. */
  const shareKeyFor = (destination: { githubHost: string; repository: string }, pending: PagesPrepareInput[]) => {
    const id = JSON.stringify([destination.githubHost, destination.repository.toLowerCase()]);
    const key = reusableShareKey(destination, { shares: shares?.status?.shares, requests: pending, jobs }) ?? sessionKeys.current.get(id) ?? mintShareKey();
    sessionKeys.current.set(id, key); return key;
  };
  const requestPages = () => run(async () => {
    if (!selected || reviewed !== selected.artifactHash) return;
    const destination = { releaseId: selected.releaseId, artifactHash: selected.artifactHash, githubHost, account, repository: repository.trim(), createRepository };
    const previous = pageRequest.current;
    const pending = outbox.list(), seriesKey = reusableShareKey(destination, { shares: shares?.status?.shares, requests: pending, jobs });
    // A recorded request for this destination keeps its exact event (a live one always); an unfinished one without
    // a share key only while no series exists there, else the new request joins the series.
    const sameTarget = (item: PagesPrepareInput) => samePagesTarget(item, { ...destination, shareKey: item.shareKey });
    const matchesTarget = (item: PagesPrepareInput) => (!!item.shareKey || !seriesKey) && sameTarget(item);
    if (!previous || !matchesTarget(previous)) {
      const known = jobs.find(item => item.status === "live" && sameTarget(item)) ?? pending.find(matchesTarget) ?? jobs.find(matchesTarget);
      pageRequest.current = known ? publicationRequest(known) : { ...destination, eventId: localId("pages"), shareKey: shareKeyFor(destination, pending) };
    }
    await sendPagesRequest(pageRequest.current!);
  });
  const aimAtShare = (share: LiveShare) => {
    setGitHubHost(share.githubHost); setAccount(share.account); setRepository(share.repository); setCreateRepository(undefined); pageRequest.current = undefined;
  };
  /** Builds the update locally with the share's stored settings and shows its preview; never publishes. */
  const startUpdate = (share: LiveShare) => run(async () => {
    const next: ShareTarget = { share, shareKey: shareKeyOf(share) };
    targetRef.current = next; setTarget(next);
    const result = await shareUpdate({ boardId: board.id, seriesId: share.seriesId, expectedSource: { documentVersion: board.canvas.documentVersion, patchCount: board.canvas.patches.length } });
    if (!mounted.current || targetRef.current !== next) return;
    if ("upToDate" in result) { const done = { ...next, upToDate: true }; targetRef.current = done; setTarget(done); return; }
    const built = { ...next, releaseId: result.manifest.releaseId, shareKey: result.request.shareKey ?? next.shareKey };
    targetRef.current = built; setTarget(built);
    setReleases(values => [result.manifest, ...values.filter(item => item.releaseId !== result.manifest.releaseId)]);
    await showRelease(result.manifest);
    if (mounted.current && targetRef.current === built) aimAtShare(share);
  });
  /** A share without stored settings: fill in what its manifest still records, and say what is missing. */
  const recoverSettings = (share: LiveShare) => run(async () => {
    const saved = await preview({ releaseId: share.releaseId });
    if (!mounted.current) return;
    const manifest = saved.manifest;
    setTitle(manifest.title); setNetwork(manifest.network); setApiOriginsText((manifest.apiOrigins ?? []).join("\n")); copyRequest.current = undefined;
    const next: ShareTarget = { share, shareKey: shareKeyOf(share), recovered: manifest };
    targetRef.current = next; setTarget(next);
  });
  const confirmShare = () => run(async () => {
    const current = targetRef.current;
    if (!selected || !current?.releaseId || current.releaseId !== selected.releaseId) return;
    setReviewed(selected.artifactHash);
    const { share } = current;
    const destination = { releaseId: selected.releaseId, artifactHash: selected.artifactHash, githubHost: share.githubHost, account: share.account, repository: share.repository, shareKey: current.shareKey };
    const known = outbox.list().find(item => samePagesTarget(item, destination)) ?? jobs.find(item => samePagesTarget(item, destination));
    const request = known ? publicationRequest(known) : { ...destination, eventId: localId("pages") };
    aimAtShare(share); pageRequest.current = request;
    await sendPagesRequest(request);
  });
  useEffect(() => {
    if (intent !== "update" || autoUpdate.current || !desktop) return;
    const share = shareList.find(item => item.live === "changed");
    if (!share) return;
    autoUpdate.current = true; void startUpdate(share);
  }, [intent, desktop, shareList]);
  const copyLink = (url: string) => {
    void copyText(url).then(() => {
      if (!mounted.current) return;
      setCopied(url); clearTimeout(copiedTimer.current); copiedTimer.current = setTimeout(() => { if (mounted.current) setCopied(undefined); }, 2_000);
    }, error => { if (mounted.current) setFailure(errorMessage(error)); });
  };
  const shareSection = shareList.length ? <View testID="board-share-status" style={{ gap: 10 }}>
    <Copy>分享页</Copy>
    {shareList.map(share => {
      const stale = shareChanged(share, board.canvas) || share.live === "failed", active = target?.share.seriesId === share.seriesId;
      return <View key={share.seriesId} style={{ gap: 6, padding: 10, borderWidth: 1, borderRadius: 8, borderColor: active ? c.accent : c.border }}>
        <Copy>{shareStateNames[share.live]}</Copy>
        <Copy small muted>{pagesGitHubHost(share)} · {share.repository}{share.link ? `\n${share.link}${share.verified ? "" : "（内容待核验）"}` : "\n分享链接尚未部署"}</Copy>
        <Copy small muted>沿用设置：{inheritedSettingsText(share)}</Copy>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {share.link ? <Action label="打开分享页" onPress={() => openUrl(share.link!)} /> : null}
          {share.link ? <Action label="复制链接" onPress={() => copyLink(share.link!)} /> : null}
          {desktop && stale && share.live !== "updating" && share.settingsAvailable ? <Action label="更新此分享页" primary={!active} disabled={busy} onPress={() => { void startUpdate(share); }} /> : null}
          {desktop && stale && share.live !== "updating" && !share.settingsAvailable ? <Action label="沿用上次分享页的设置" disabled={busy} onPress={() => { void recoverSettings(share); }} /> : null}
        </View>
        {share.link && copied === share.link ? <Copy small muted>已复制链接</Copy> : null}
        {active && target?.upToDate ? <Notice text="分享页已是当前内容，无需更新。" /> : null}
        {active && target?.recovered ? <Copy small muted>已沿用上次分享页的设置：名称「{target.recovered.title}」 · {target.recovered.network === "cdn" ? "允许 CDN 库" : "仅内置资源"} · {target.recovered.apiOrigins?.length ? `后端来源：${target.recovered.apiOrigins.join("、")}` : "不连接后端"}。主题和公开数据没有保存，请在下方重新选择，再点「生成固定版本并预览」。</Copy> : null}
      </View>;
    })}
    {!desktop ? <Notice text="请在桌面版更新分享页：此客户端无法预览新版本或保留发布重试记录。" /> : null}
  </View> : null;
  const editor = <>
    {intent === "update" ? null : <Copy>把当前内容固定成一个可独立打开的网站。之后继续修改 Board，不会改变已导出或已上线的版本。</Copy>}
    <View style={{ gap: 8 }}>
      <Copy>发布名称</Copy>
      <TextInput accessibilityLabel="发布名称" value={title} onChangeText={value => { setTitle(value); copyRequest.current = undefined; }} editable={!busy} style={field} />
      <Action label="复制为发布 Board" disabled={busy || !title.trim()} onPress={() => { void run(async () => {
        copyRequest.current ??= { boardId: board.id, canvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, eventId: localId("copy"), title: title.trim() };
        const copied = await copyBoard(copyRequest.current);
        if (mounted.current) onOpenBoard?.(copied.id);
      }); }} />
      <Copy small muted>需要另做一版时先复制，再在副本里改字、拖动或请 agent 修改。副本不带讨论和草稿。</Copy>
    </View>
    <View style={{ gap: 8 }}>
      <Copy>公开数据 JSON</Copy>
      <Copy small muted>默认不带 Board 数据。页面需要图表或筛选数据时，可载入当前数据后删去不公开的字段。</Copy>
      <Action label="载入当前画布数据" disabled={busy} onPress={() => setPublicData(JSON.stringify(board.canvas.data, null, 2))} />
      <TextInput testID="board-release-data" accessibilityLabel="公开数据 JSON" multiline value={publicData} onChangeText={setPublicData} editable={!busy} style={{ ...field, minHeight: 100, maxHeight: 220 }} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action label="仅内置资源" active={network === "offline"} disabled={busy} onPress={() => setNetwork("offline")} />
        <Action label="允许 CDN 库" active={network === "cdn"} disabled={busy} onPress={() => setNetwork("cdn")} />
        <Action label="浅色" active={theme === "light"} disabled={busy} onPress={() => setTheme("light")} />
        <Action label="深色" active={theme === "dark"} disabled={busy} onPress={() => setTheme("dark")} />
      </View>
      <Copy>后端 API 来源（可选，每行一个）</Copy>
      <TextInput accessibilityLabel="后端 API 来源" placeholder="https://api.example.internal" multiline autoCapitalize="none" value={apiOriginsText} onChangeText={setApiOriginsText} editable={!busy} style={{ ...field, minHeight: 60, maxHeight: 140 }} />
      <Copy small muted>留空则不连接应用后端。填写后，发布页可向这些地址读写数据；这里不填写路径、密码或收件箱令牌。后端需允许发布网站的来源，预览不会调用后端。</Copy>
      <Action label={busy ? "处理中…" : "生成固定版本并预览"} primary disabled={busy || !title.trim()} onPress={() => { void run(async () => {
        const parsed: unknown = JSON.parse(publicData);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("公开数据须为 JSON 对象。");
        const apiOrigins = PublicApiOriginsSchema.parse(apiOriginsText.split(/\r?\n/).map(value => value.trim()).filter(Boolean));
        const result = await create({ boardId: board.id, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, title: title.trim(), publicData: parsed as Board["canvas"]["data"], apiOrigins, network, theme });
        if (!mounted.current) return;
        setReleases(values => [result, ...values.filter(item => item.releaseId !== result.releaseId)]);
        // Recovered settings: this generation becomes the reviewed update for that share link.
        const recovering = targetRef.current?.recovered ? { ...targetRef.current, releaseId: result.releaseId } : undefined;
        if (recovering) { targetRef.current = recovering; setTarget(recovering); }
        await showRelease(result);
        if (recovering && mounted.current && targetRef.current === recovering) aimAtShare(recovering.share);
      }); }} />
    </View>
  </>;
  const failureNotice = failure ? <Notice error text={failure} /> : null;
  const pendingSection = pendingPages.length ? <View style={{ gap: 6 }}><Copy>待核对的发布请求</Copy><Copy small muted>上次关闭或断线前的版本和目标已保留。已受理的发布会在后台继续；没有受理回执时可重试同一次请求。放弃只删除本机的重试记录。</Copy>{pendingPages.map(request => <View key={request.eventId} style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}><Action label={`恢复发布 · ${pagesGitHubHost(request)} · ${request.repository}`} disabled={busy} onPress={() => { void run(async () => {
    const saved = await preview({ releaseId: request.releaseId });
    if (saved.manifest.artifactHash !== request.artifactHash) throw new Error("发布版本与原请求不一致。");
    await showRelease(saved.manifest);
    pageRequest.current = request; setGitHubHost(pagesGitHubHost(request)); setAccount(request.account); setRepository(request.repository); setCreateRepository(request.createRepository);
  }); }} /><Action label={`放弃 · ${pagesGitHubHost(request)} · ${request.repository}`} disabled={busy} onPress={() => {
    try { outbox.remove(request.eventId); setPendingPages(outbox.list()); if (pageRequest.current?.eventId === request.eventId) pageRequest.current = undefined; }
    catch (error) { setFailure(errorMessage(error)); }
  }} /></View>)}</View> : null;
  const releasesSection = releases.length ? <View style={{ gap: 6 }}><Copy>本机发布版本</Copy><ScrollView style={{ maxHeight: 160 }} contentContainerStyle={{ gap: 4 }}>{releases.map(release => <Action key={release.releaseId} label={`${release.title} · ${release.artifactHash.slice(0, 10)}`} active={release.releaseId === selected?.releaseId} disabled={busy} onPress={() => { void run(() => showRelease(release)); }} />)}</ScrollView></View> : null;
  const confirming = selected && target?.releaseId === selected.releaseId ? target : undefined;
  const confirmedJob = confirming && selected ? jobs.find(item => item.releaseId === selected.releaseId && item.shareKey === confirming.shareKey && (item.status === "live" || automaticallyPublishing(item))) : undefined;
  // The server refused this exact request for good; resending it would only be refused again.
  const refusedConfirm = confirming && selected && !confirmedJob ? jobs.find(item => item.releaseId === selected.releaseId && item.shareKey === confirming.shareKey && finalRefusal(item)) : undefined;
  const selectedSection = selected ? <View style={{ gap: 12 }}>
      <Copy>{selected.title} · 固定版本 {selected.artifactHash.slice(0, 12)}</Copy>
      {selected.apiOrigins?.length ? <Copy small muted>已固定的后端来源：{selected.apiOrigins.join("、")}</Copy> : null}
      {html ? <ReleasePreview html={html} /> : null}
      {confirming ? <View style={{ gap: 8, padding: 10, borderWidth: 1, borderRadius: 8, borderColor: c.accent }}>
        <Copy>确认后更新这个分享链接：{confirming.share.link ?? `${pagesGitHubHost(confirming.share)} · ${confirming.share.repository}`}</Copy>
        {confirming.share.archivesOnline ? confirming.share.adoptable ? <Copy small muted>链接保持不变；之前的版本另存在这个链接下的 v/ 目录，仍可打开。</Copy> : null
          : <Copy small muted>链接保持不变；之前的版本不会留在网上，可在「本机发布版本」中预览或下载 ZIP。</Copy>}
        <Copy small muted>{confirming.recovered ? `本次使用面板中的设置：名称「${selected.title}」 · ${selected.network === "cdn" ? "允许 CDN 库" : "仅内置资源"} · ${selected.apiOrigins?.length ? `后端来源：${selected.apiOrigins.join("、")}` : "不连接后端"}` : `沿用设置：${inheritedSettingsText(confirming.share)}`}</Copy>
        <Copy small muted>{VISITOR_NOTICE}</Copy>
        {refusedConfirm ? <Notice error text={refusedConfirm.refusal!.message} /> : null}
        <Action testID="board-share-confirm" label={confirmedJob ? "已提交更新" : "确认并更新分享页"} primary disabled={busy || !html || !!confirmedJob || !!refusedConfirm} onPress={() => { void confirmShare(); }} />
      </View> : null}
      {selected.warnings.map((warning, index) => <Notice key={index} text={warning} />)}
      <Copy small muted>文件：{selected.files.map(file => file.path).join("、")}{selected.dependencies.length ? `\n外部依赖：${selected.dependencies.join("、")}` : "\n无需外部依赖。"}</Copy>
      <Action label="下载 ZIP" disabled={busy} onPress={() => { void run(async () => { const bundle = await download({ releaseId: selected.releaseId }); downloadReleaseZip(bundle.zipBase64, bundle.fileName); }); }} />
      <Copy small muted>自有服务器：解压后把目录交给 Nginx、Caddy 或现有静态站点服务。网站无需运行 Paseo。</Copy>
      <Action label={reviewed === selected.artifactHash ? "已确认此版本可发布" : "确认预览和数据，可发布此版本"} active={reviewed === selected.artifactHash} disabled={busy} onPress={() => setReviewed(selected.artifactHash)} />
      <View style={{ gap: 8, borderTopWidth: 1, borderColor: c.border, paddingTop: 14 }}>
        <Copy>GitHub Pages</Copy><Copy small muted>点击发布后自动创建 PR、合并、部署并核对网页。关闭面板后仍会继续。已有站点会使用独立目录，保留原来的页面。</Copy><Copy small muted>支持 github.com 和公司内部 GitHub。网站访问权限由所选 GitHub 的 Pages 设置决定；私有仓库不代表网站也私有。</Copy>
        <TextInput accessibilityLabel="GitHub 主机（可选）" placeholder="留空读取已登录主机，或填写公司 GitHub 域名" placeholderTextColor={c.foregroundMuted} value={githubHostFilter} onChangeText={value => { setGitHubHostFilter(value); setAccountList([]); setAccount(""); setRepoList([]); setRepository(""); setCreateRepository(undefined); pageRequest.current = undefined; }} editable={!busy} autoCapitalize="none" style={field} />
        <Action label="读取 GitHub 账号" disabled={busy} onPress={() => { void run(async () => { const filter = githubHostFilter.trim(); setAccountList(await accounts(filter ? { githubHost: filter } : {})); }); }} />
        {accountList.map(item => <Action key={`${item.host}/${item.login}`} label={`${item.login} · ${item.host}`} active={account === item.login && githubHost === item.host} disabled={busy} onPress={() => { setGitHubHost(item.host); setAccount(item.login); setRepoList([]); setRepository(""); setCreateRepository(undefined); pageRequest.current = undefined; void run(async () => setRepoList(await repositories({ account: item.login, githubHost: item.host }))); }} />)}
        {account ? <Copy small muted>发布账号：{account} · {githubHost}</Copy> : null}
        <TextInput accessibilityLabel="GitHub 仓库 owner/repo" placeholder="owner/repository" placeholderTextColor={c.foregroundMuted} value={repository} onChangeText={value => { setRepository(value); pageRequest.current = undefined; }} editable={!busy} style={field} />
        {repoList.length ? <ScrollView style={{ maxHeight: 180 }} contentContainerStyle={{ gap: 4 }}>{repoList.map(item => <Action key={item.name} label={`${item.name}${item.private ? " · 私有仓库" : ""}`} active={repository === item.name} disabled={busy} onPress={() => { setRepository(item.name); setCreateRepository(undefined); pageRequest.current = undefined; }} />)}</ScrollView> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Action label="现有仓库" active={!createRepository} disabled={busy} onPress={() => { setCreateRepository(undefined); pageRequest.current = undefined; }} />
          <Action label="新建公开仓库" active={createRepository === "public"} disabled={busy} onPress={() => { setCreateRepository("public"); pageRequest.current = undefined; }} />
          <Action label="新建私有仓库" active={createRepository === "private"} disabled={busy} onPress={() => { setCreateRepository("private"); pageRequest.current = undefined; }} />
        </View>
        <Action label={createRepository ? "创建仓库并一键发布" : "一键发布"} disabled={busy || !account || !repository.trim() || reviewed !== selected.artifactHash || jobs.some(item => item.releaseId === selected.releaseId && pagesGitHubHost(item) === githubHost && item.account === account && item.repository === repository.trim() && automaticallyPublishing(item))} primary onPress={() => { void requestPages(); }} />
        {jobs.map(item => <Action key={item.jobId} label={`${pagesGitHubHost(item)} · ${item.repository} · ${jobStatusName(item)}`} active={item.jobId === job?.jobId} disabled={busy} onPress={() => { currentJob.current = item; setJob(item); setGitHubHost(pagesGitHubHost(item)); setAccount(item.account); setRepository(item.repository); setCreateRepository(item.createRepository); pageRequest.current = undefined; }} />)}
        {job ? <View testID="board-pages-job" style={{ gap: 8 }}>
          <Copy>{pagesGitHubHost(job)} · {job.repository} · {jobStatusName(job)}</Copy>
          {job.sitePath ? <Copy small muted>发布目录：{job.sitePath}</Copy> : null}
          {job.shareKey && (job.shareUrl ?? job.shareDeployedUrl) ? <Copy small muted>分享链接：{job.shareUrl ?? job.shareDeployedUrl}</Copy> : null}
          {automaticallyPublishing(job) ? <Copy small muted>发布已交给后台，正在自动完成后续步骤。</Copy> : null}
          {job.refusal?.code === "up-to-date" ? <Copy small muted>分享页上已经是这个版本，没有新建 PR。</Copy> : null}
          {job.error ? <Notice error text={job.error} /> : null}
          {job.prUrl ? <Action label="查看 PR" onPress={() => openUrl(job.prUrl!)} /> : null}
          {job.status !== "live" && !automaticallyPublishing(job) && !finalRefusal(job) ? <Action label="一键继续发布" disabled={busy || reviewed !== job.artifactHash} onPress={() => { void run(() => sendPagesRequest(publicationRequest(job))); }} /> : null}
          <Action label="核对部署状态" disabled={busy} onPress={() => { void run(async () => rememberJob(await refresh({ jobId: job.jobId }))); }} />
          {job.shareKey ? <>
            {/* Series jobs: the share link is what people received; the archive keeps this exact version. */}
            {job.shareUrl ? <Action label="打开已发布网页" onPress={() => openUrl(job.shareUrl!)} /> : job.shareDeployedUrl ? <Action label="打开网页（内容待核验）" onPress={() => openUrl(job.shareDeployedUrl!)} /> : null}
            {(job.url ?? job.deployedUrl) && (job.url ?? job.deployedUrl) !== (job.shareUrl ?? job.shareDeployedUrl) ? <Action label="打开此版本" onPress={() => openUrl((job.url ?? job.deployedUrl)!)} /> : null}
          </> : <>
            {job.status !== "live" && job.deployedUrl ? <Action label="打开网页（内容待核验）" onPress={() => openUrl(job.deployedUrl!)} /> : null}
            {job.status === "live" && job.url ? <Action label="打开已发布网页" onPress={() => openUrl(job.url!)} /> : null}
          </>}
        </View> : null}
      </View>
    </View> : null;
  return <View testID="board-release-panel" style={{ gap: 18 }}>
    {intent === "update" ? <>{shareSection}{failureNotice}{selectedSection}{pendingSection}{editor}{releasesSection}</>
      : <>{shareSection}{editor}{failureNotice}{pendingSection}{releasesSection}{selectedSection}</>}
  </View>;
}
