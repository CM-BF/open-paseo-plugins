import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import type { Board } from "../shared/contracts";
import { copyBoardRpc, type CopyBoardInput } from "../shared/board-copy";
import {
  createReleaseRpc, listReleasesRpc, previewReleaseRpc, downloadReleaseRpc,
  githubAccountsRpc, githubRepositoriesRpc, preparePagesRpc, mergePagesRpc,
  refreshPagesRpc, listPagesJobsRpc, type ReleaseManifest, type PagesJob,
  type PagesPrepareInput, type GitHubAccount, type GitHubRepository,
} from "../shared/release-contracts";
import { Action, Copy, Notice, errorMessage, localId, useColors } from "./ui";
import { downloadReleaseZip, ReleasePreview } from "./release-web";
import { createPagesOutbox } from "./pages-outbox";

const statusNames: Record<PagesJob["status"], string> = {
  prepared: "准备发布", "pr-open": "PR 已创建", merged: "已合并", deploying: "部署中",
  live: "已核实上线", failed: "发布失败", unknown: "结果待核对",
};

export function ReleasePanel({ board, hostId, onOpenBoard }: { board: Board; hostId: string; onOpenBoard?(id: string): void }) {
  const c = useColors();
  const copyBoard = useRpc(copyBoardRpc), create = useRpc(createReleaseRpc), list = useRpc(listReleasesRpc);
  const preview = useRpc(previewReleaseRpc), download = useRpc(downloadReleaseRpc);
  const accounts = useRpc(githubAccountsRpc), repositories = useRpc(githubRepositoriesRpc);
  const prepare = useRpc(preparePagesRpc), merge = useRpc(mergePagesRpc), refresh = useRpc(refreshPagesRpc), listJobs = useRpc(listPagesJobsRpc);
  const [title, setTitle] = useState(`${board.title} · 发布版`);
  const [publicData, setPublicData] = useState("{}");
  const [network, setNetwork] = useState<"offline" | "cdn">("offline");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [releases, setReleases] = useState<ReleaseManifest[]>([]);
  const [selected, setSelected] = useState<ReleaseManifest>();
  const [html, setHtml] = useState<string>();
  const [reviewed, setReviewed] = useState<string>();
  const [accountList, setAccountList] = useState<GitHubAccount[]>([]), [account, setAccount] = useState("");
  const [repoList, setRepoList] = useState<GitHubRepository[]>([]), [repository, setRepository] = useState("");
  const [createRepository, setCreateRepository] = useState<"public" | "private">();
  const [jobs, setJobs] = useState<PagesJob[]>([]), [job, setJob] = useState<PagesJob>();
  const outbox = useMemo(() => createPagesOutbox(hostId, board.id), [hostId, board.id]);
  const [pendingPages, setPendingPages] = useState<PagesPrepareInput[]>([]);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string>();
  const mounted = useRef(true), flight = useRef(false);
  const currentJob = useRef(job); currentJob.current = job;
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
    if (!job || !["merged", "deploying"].includes(job.status)) return;
    let active = true, attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (!active || currentJob.current?.jobId !== job.jobId) return;
      if (flight.current) { timer = setTimeout(() => { void check(); }, 5_000); return; }
      try {
        const updated = await refresh({ jobId: job.jobId });
        if (!active || currentJob.current?.jobId !== job.jobId) return;
        setJob(updated); setJobs(values => [updated, ...values.filter(item => item.jobId !== updated.jobId)]);
        if (["merged", "deploying"].includes(updated.status) && ++attempts < 60) timer = setTimeout(() => { void check(); }, 5_000);
      } catch (error) { if (active) setFailure(`暂时无法核对部署：${errorMessage(error)}，可以稍后继续核对。`); }
    };
    timer = setTimeout(() => { void check(); }, 5_000);
    return () => { active = false; clearTimeout(timer); };
  }, [job?.jobId, job?.status, refresh]);
  const run = async (operation: () => Promise<void>) => {
    if (flight.current) return;
    flight.current = true; setBusy(true); setFailure(undefined);
    try { await operation(); } catch (error) { if (mounted.current) setFailure(errorMessage(error)); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  };
  const showRelease = async (release: ReleaseManifest) => {
    const result = await preview({ releaseId: release.releaseId });
    if (!mounted.current) return;
    setSelected(result.manifest); setHtml(result.html); setReviewed(undefined); setJob(undefined);
    const history = await listJobs({ releaseId: release.releaseId });
    if (mounted.current) setJobs(history);
  };
  const rememberJob = (value: PagesJob) => {
    if (!mounted.current) return;
    setJob(value); setJobs(values => [value, ...values.filter(item => item.jobId !== value.jobId)]);
  };
  const openUrl = (url: string) => { void openExternalUrl(url).catch(error => setFailure(errorMessage(error))); };
  const sendPagesRequest = async (request: PagesPrepareInput) => {
    const frozen = outbox.save(request);
    setPendingPages(outbox.list());
    rememberJob(await prepare(frozen));
    outbox.remove(frozen.eventId);
    if (mounted.current) setPendingPages(outbox.list());
  };
  const requestPages = () => run(async () => {
    if (!selected || reviewed !== selected.artifactHash) return;
    const target = { releaseId: selected.releaseId, artifactHash: selected.artifactHash, account, repository: repository.trim(), createRepository };
    const previous = pageRequest.current;
    const known = [...outbox.list(), ...jobs].find(item => item.releaseId === target.releaseId && item.account === target.account && item.repository === target.repository && item.createRepository === target.createRepository);
    if (!previous || JSON.stringify({ ...previous, eventId: undefined }) !== JSON.stringify(target)) pageRequest.current = { ...target, eventId: known?.eventId ?? localId("pages") };
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
    {pendingPages.length ? <View style={{ gap: 6 }}><Copy>待核对的发布请求</Copy><Copy small muted>上次关闭或断线前的版本和目标已保留。恢复后先核对预览，再继续同一次发布。</Copy>{pendingPages.map(request => <Action key={request.eventId} label={`恢复发布 · ${request.repository}`} disabled={busy} onPress={() => { void run(async () => {
      const saved = await preview({ releaseId: request.releaseId });
      if (saved.manifest.artifactHash !== request.artifactHash) throw new Error("发布版本与原请求不一致。");
      await showRelease(saved.manifest);
      pageRequest.current = request; setAccount(request.account); setRepository(request.repository); setCreateRepository(request.createRepository);
    }); }} />)}</View> : null}
    {releases.length ? <View style={{ gap: 6 }}><Copy>本机发布版本</Copy><ScrollView style={{ maxHeight: 160 }} contentContainerStyle={{ gap: 4 }}>{releases.map(release => <Action key={release.releaseId} label={`${release.title} · ${release.artifactHash.slice(0, 10)}`} active={release.releaseId === selected?.releaseId} disabled={busy} onPress={() => { void run(() => showRelease(release)); }} />)}</ScrollView></View> : null}
    {selected ? <View style={{ gap: 12 }}>
      <Copy>{selected.title} · 固定版本 {selected.artifactHash.slice(0, 12)}</Copy>
      {html ? <ReleasePreview html={html} /> : null}
      {selected.warnings.map((warning, index) => <Notice key={index} text={warning} />)}
      <Copy small muted>文件：{selected.files.map(file => file.path).join("、")}{selected.dependencies.length ? `\n外部依赖：${selected.dependencies.join("、")}` : "\n无需外部依赖。"}</Copy>
      <Action label="下载 ZIP" disabled={busy} onPress={() => { void run(async () => { const bundle = await download({ releaseId: selected.releaseId }); downloadReleaseZip(bundle.zipBase64, bundle.fileName); }); }} />
      <Copy small muted>自有服务器：解压后把目录交给 Nginx、Caddy 或现有静态站点服务。网站无需运行 Paseo。</Copy>
      <Action label={reviewed === selected.artifactHash ? "已确认此版本可公开" : "确认预览和数据，可发布此版本"} active={reviewed === selected.artifactHash} disabled={busy} onPress={() => setReviewed(selected.artifactHash)} />
      <View style={{ gap: 8, borderTopWidth: 1, borderColor: c.border, paddingTop: 14 }}>
        <Copy>GitHub Pages</Copy><Copy small muted>Pages 网站通常公开，即使源码仓库为私有。选择具体账号和仓库后才会上传。</Copy>
        <Action label="读取 GitHub 账号" disabled={busy} onPress={() => { void run(async () => { setAccountList(await accounts({})); }); }} />
        {accountList.map(item => <Action key={item.login} label={item.login} active={account === item.login} disabled={busy} onPress={() => { setAccount(item.login); setRepoList([]); pageRequest.current = undefined; void run(async () => setRepoList(await repositories({ account: item.login }))); }} />)}
        <TextInput accessibilityLabel="GitHub 仓库 owner/repo" placeholder="owner/repository" placeholderTextColor={c.foregroundMuted} value={repository} onChangeText={value => { setRepository(value); pageRequest.current = undefined; }} editable={!busy} style={field} />
        {repoList.length ? <ScrollView style={{ maxHeight: 180 }} contentContainerStyle={{ gap: 4 }}>{repoList.map(item => <Action key={item.name} label={`${item.name}${item.private ? " · 私有仓库" : ""}`} active={repository === item.name} disabled={busy} onPress={() => { setRepository(item.name); setCreateRepository(undefined); pageRequest.current = undefined; }} />)}</ScrollView> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Action label="现有仓库" active={!createRepository} disabled={busy} onPress={() => { setCreateRepository(undefined); pageRequest.current = undefined; }} />
          <Action label="新建公开仓库" active={createRepository === "public"} disabled={busy} onPress={() => { setCreateRepository("public"); pageRequest.current = undefined; }} />
          <Action label="新建私有仓库" active={createRepository === "private"} disabled={busy} onPress={() => { setCreateRepository("private"); pageRequest.current = undefined; }} />
        </View>
        <Action label={createRepository ? "创建仓库和发布 PR" : "创建发布 PR"} disabled={busy || !account || !repository.trim() || reviewed !== selected.artifactHash} primary onPress={() => { void requestPages(); }} />
        {jobs.map(item => <Action key={item.jobId} label={`${item.repository} · ${statusNames[item.status]}`} active={item.jobId === job?.jobId} disabled={busy} onPress={() => setJob(item)} />)}
        {job ? <View testID="board-pages-job" style={{ gap: 8 }}>
          <Copy>{job.repository} · {statusNames[job.status]}</Copy>
          {job.error ? <Notice error text={job.error} /> : null}
          {job.prUrl ? <Action label="查看 PR" onPress={() => openUrl(job.prUrl!)} /> : null}
          {["prepared", "failed", "unknown"].includes(job.status) ? <Action label="继续同一次发布准备" disabled={busy || reviewed !== job.artifactHash} onPress={() => { void run(() => sendPagesRequest({ eventId: job.eventId, releaseId: job.releaseId, artifactHash: job.artifactHash, account: job.account, repository: job.repository, createRepository: job.createRepository })); }} /> : null}
          {job.status === "pr-open" && job.headSha ? <Action label="合并此 PR 并发布" disabled={busy || reviewed !== job.artifactHash} onPress={() => { void run(async () => rememberJob(await merge({ jobId: job.jobId, expectedHead: job.headSha! }))); }} /> : null}
          <Action label="核对部署状态" disabled={busy} onPress={() => { void run(async () => rememberJob(await refresh({ jobId: job.jobId }))); }} />
          {job.status === "live" && job.url ? <Action label="打开已发布网页" onPress={() => openUrl(job.url!)} /> : null}
        </View> : null}
      </View>
    </View> : null}
  </View>;
}
