import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { Board } from "../shared/contracts";
import { copyBoardRpc, type CopyBoardInput } from "../shared/board-copy";
import {
  createReleaseRpc, listReleasesRpc, previewReleaseRpc, downloadReleaseRpc,
  githubAccountsRpc, githubRepositoriesRpc, publishPagesRpc,
  refreshPagesRpc, listPagesJobsRpc, type ReleaseManifest, type PagesJob,
  type PagesPrepareInput, type GitHubAccount, type GitHubRepository,
} from "../shared/release-contracts";
import { Action, Copy, Notice, errorMessage, localId, useColors } from "./ui";
import { downloadReleaseZip, ReleasePreview } from "./release-web";
import { createPagesOutbox, pagesGitHubHost, samePagesRequest, samePagesTarget } from "./pages-outbox";

const statusNames: Record<PagesJob["status"], string> = {
  prepared: "准备发布文件", "pr-open": "PR 已创建，等待自动合并", merged: "已合并，等待部署", deploying: "部署并核对网页中",
  live: "已核实上线", failed: "发布失败", unknown: "结果待核对",
};
const publicationRequest = (value: PagesPrepareInput): PagesPrepareInput => ({
  eventId: value.eventId, releaseId: value.releaseId, artifactHash: value.artifactHash,
  ...(value.githubHost ? { githubHost: value.githubHost } : {}),
  account: value.account, repository: value.repository, createRepository: value.createRepository,
});
const automaticallyPublishing = (value: PagesJob) => value.autoPublish === true &&
  !["live", "failed"].includes(value.status) && Boolean(value.autoPublishUntil && Date.parse(value.autoPublishUntil) > Date.now());
const jobStatusName = (value: PagesJob) => value.status === "pr-open" && !automaticallyPublishing(value) ? "PR 已创建，等待继续发布" : statusNames[value.status];

export function ReleasePanel({ board, hostId, onOpenBoard }: { board: Board; hostId: string; onOpenBoard?(id: string): void }) {
  const c = useColors();
  const copyBoard = useRpc(copyBoardRpc), create = useRpc(createReleaseRpc), list = useRpc(listReleasesRpc);
  const preview = useRpc(previewReleaseRpc), download = useRpc(downloadReleaseRpc);
  const accounts = useRpc(githubAccountsRpc), repositories = useRpc(githubRepositoriesRpc);
  const publish = useRpc(publishPagesRpc), refresh = useRpc(refreshPagesRpc), listJobs = useRpc(listPagesJobsRpc);
  const [title, setTitle] = useState(`${board.title} · 发布版`);
  const [publicData, setPublicData] = useState("{}");
  const [network, setNetwork] = useState<"offline" | "cdn">("offline");
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
  const field = { color: c.foreground, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 6, padding: 8, fontSize: 13 };
  useEffect(() => {
    mounted.current = true;
    void list({ boardId: board.id }).then(value => { if (mounted.current) setReleases(value); }).catch(error => { if (mounted.current) setFailure(errorMessage(error)); });
    return () => { mounted.current = false; };
  }, [board.id, list]);
  useEffect(() => {
    try { setPendingPages(outbox.list()); }
    catch (error) { setFailure(errorMessage(error)); }
  }, [outbox]);
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
    for (const request of outbox.list()) if (history.some(item => item.autoPublish && samePagesRequest(item, request))) outbox.remove(request.eventId);
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
  };
  const requestPages = () => run(async () => {
    if (!selected || reviewed !== selected.artifactHash) return;
    const target = { releaseId: selected.releaseId, artifactHash: selected.artifactHash, githubHost, account, repository: repository.trim(), createRepository };
    const previous = pageRequest.current;
    const matchesTarget = (item: PagesPrepareInput) => samePagesTarget(item, target);
    const known = jobs.find(item => item.status === "live" && matchesTarget(item)) ?? outbox.list().find(matchesTarget) ?? jobs.find(matchesTarget);
    if (!previous || !samePagesTarget(previous, target)) pageRequest.current = known
      ? publicationRequest(known) : { ...target, eventId: localId("pages") };
    await sendPagesRequest(pageRequest.current!);
  });
  return <View testID="board-release-panel" style={{ gap: 18 }}>
    <Copy>把当前内容固定成一个可独立打开的网站。之后继续修改 Board，不会改变已导出或已上线的版本。</Copy>
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
        <Action label="离线网页" active={network === "offline"} disabled={busy} onPress={() => setNetwork("offline")} />
        <Action label="允许 CDN 库" active={network === "cdn"} disabled={busy} onPress={() => setNetwork("cdn")} />
        <Action label="浅色" active={theme === "light"} disabled={busy} onPress={() => setTheme("light")} />
        <Action label="深色" active={theme === "dark"} disabled={busy} onPress={() => setTheme("dark")} />
      </View>
      <Action label={busy ? "处理中…" : "生成固定版本并预览"} primary disabled={busy || !title.trim()} onPress={() => { void run(async () => {
        const parsed: unknown = JSON.parse(publicData);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("公开数据须为 JSON 对象。");
        const result = await create({ boardId: board.id, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, title: title.trim(), publicData: parsed as Board["canvas"]["data"], network, theme });
        if (!mounted.current) return;
        setReleases(values => [result, ...values.filter(item => item.releaseId !== result.releaseId)]);
        await showRelease(result);
      }); }} />
    </View>
    {failure ? <Notice error text={failure} /> : null}
    {pendingPages.length ? <View style={{ gap: 6 }}><Copy>待核对的发布请求</Copy><Copy small muted>上次关闭或断线前的版本和目标已保留。已受理的发布会在后台继续；没有受理回执时可重试同一次请求。</Copy>{pendingPages.map(request => <Action key={request.eventId} label={`恢复发布 · ${pagesGitHubHost(request)} · ${request.repository}`} disabled={busy} onPress={() => { void run(async () => {
      const saved = await preview({ releaseId: request.releaseId });
      if (saved.manifest.artifactHash !== request.artifactHash) throw new Error("发布版本与原请求不一致。");
      await showRelease(saved.manifest);
      pageRequest.current = request; setGitHubHost(pagesGitHubHost(request)); setAccount(request.account); setRepository(request.repository); setCreateRepository(request.createRepository);
    }); }} />)}</View> : null}
    {releases.length ? <View style={{ gap: 6 }}><Copy>本机发布版本</Copy><ScrollView style={{ maxHeight: 160 }} contentContainerStyle={{ gap: 4 }}>{releases.map(release => <Action key={release.releaseId} label={`${release.title} · ${release.artifactHash.slice(0, 10)}`} active={release.releaseId === selected?.releaseId} disabled={busy} onPress={() => { void run(() => showRelease(release)); }} />)}</ScrollView></View> : null}
    {selected ? <View style={{ gap: 12 }}>
      <Copy>{selected.title} · 固定版本 {selected.artifactHash.slice(0, 12)}</Copy>
      {html ? <ReleasePreview html={html} /> : null}
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
          {automaticallyPublishing(job) ? <Copy small muted>发布已交给后台，正在自动完成后续步骤。</Copy> : null}
          {job.error ? <Notice error text={job.error} /> : null}
          {job.prUrl ? <Action label="查看 PR" onPress={() => openUrl(job.prUrl!)} /> : null}
          {job.status !== "live" && !automaticallyPublishing(job) ? <Action label="一键继续发布" disabled={busy || reviewed !== job.artifactHash} onPress={() => { void run(() => sendPagesRequest(publicationRequest(job))); }} /> : null}
          <Action label="核对部署状态" disabled={busy} onPress={() => { void run(async () => rememberJob(await refresh({ jobId: job.jobId }))); }} />
          {job.status !== "live" && job.deployedUrl ? <Action label="打开网页（内容待核验）" onPress={() => openUrl(job.deployedUrl!)} /> : null}
          {job.status === "live" && job.url ? <Action label="打开已发布网页" onPress={() => openUrl(job.url!)} /> : null}
        </View> : null}
      </View>
    </View> : null}
  </View>;
}
