import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { Board } from "../shared/contracts";
import {
  createReleaseRpc, listReleasesRpc, previewReleaseRpc, downloadReleaseRpc,
  githubAccountsRpc, githubRepositoriesRpc, preparePagesRpc, publishPagesRpc, mergePagesRpc,
  refreshPagesRpc, listPagesJobsRpc, shareStatusRpc, shareUpdateRpc, isLoopbackOrigin, type PagesJob, type PagesPrepareInput,
  type GitHubAccount, type GitHubRepository, type LiveDrift, type LiveRelease, type ReleaseMeta, type ReleaseSettings, type Share, type ShareStatus, type ShareUpdateResult,
} from "../shared/release-contracts";
import type { LiveReleaseChannel } from "./live-data";
import { sha256, type ReleaseRepository, type StaticRelease } from "./static-release";
import { canonicalJson } from "./store-format";

export interface PagesGateway {
  accounts(githubHost?: string): Promise<GitHubAccount[]>;
  repositories(account: string, githubHost?: string): Promise<GitHubRepository[]>;
  prepare(input: PagesPrepareInput): Promise<PagesJob>;
  publish(input: PagesPrepareInput): Promise<PagesJob>;
  merge(input: { jobId: string; expectedHead: string }): Promise<PagesJob>;
  refresh(jobId: string): Promise<PagesJob>;
  list(releaseId?: string, options?: { skipInvalid?: boolean }): Promise<PagesJob[]>;
  read(jobId: string): Promise<PagesJob>;
}

/** The Board's live channel as release building sees it; absent when the plugin has no publisher. */
export interface LiveReleaseSource { releaseChannel(board: Board): Promise<LiveReleaseChannel | null> }
const LOOPBACK_LIVE_REFUSAL = "本机测试用的实时数据不能发布到公开站点；请先连接访客能访问的后端";
const NO_LIVE_CHANNEL = "这张 Board 还没有可用的实时公开连接；请先在「实时公开数据」里确认后端和公开字段";
const isLoopbackHost = (host: string) => host === "localhost" || host === "127.0.0.1";
const refuseLoopbackLive = (live: LiveRelease | undefined, githubHost: string | undefined) => {
  if (live && isLoopbackOrigin(live.origin) && !isLoopbackHost(githubHost ?? "github.com")) throw new Error(LOOPBACK_LIVE_REFUSAL);
};
/** Only a channel the human has confirmed and that holds a public copy can back a release. */
const releaseBlock = (channel: LiveReleaseChannel | null): LiveRelease => {
  if (!channel || (channel.channelState !== "ready" && channel.channelState !== "paused")) throw new Error(NO_LIVE_CHANNEL);
  return { origin: channel.origin, channelId: channel.channelId, paths: channel.paths };
};
const withLiveOrigin = (apiOrigins: readonly string[], origin: string) => {
  if (apiOrigins.includes(origin)) return [...apiOrigins];
  if (apiOrigins.length >= 8) throw new Error("连接的后端来源已达 8 个上限，无法再加入实时数据后端");
  return [...apiOrigins, origin];
};
const liveDrift = (stored: LiveRelease | undefined, channel: LiveReleaseChannel | null): LiveDrift | undefined => {
  const had = new Set(stored?.paths ?? []), now = new Set(channel?.paths ?? []);
  const addedPaths = [...now].filter(path => !had.has(path)), removedPaths = [...had].filter(path => !now.has(path));
  const originChanged = !!stored && !!channel && stored.origin !== channel.origin;
  if (!addedPaths.length && !removedPaths.length && !originChanged) return undefined;
  return { addedPaths, removedPaths, originChanged, channelState: channel?.state ?? "none" };
};

type Owned = { job: PagesJob; release: StaticRelease; meta?: ReleaseMeta };
type Series = { githubHost: string; repository: string; key: string; keyed: boolean; members: Owned[] };
// Server-only: the directory key, and whether the published job actually reached the share link.
type ShareView = Share & { key: string; onLink: boolean };
const hostOf = (job: PagesJob) => job.githubHost ?? "github.com";
const isLegacyMode = (job: PagesJob) => job.publicationMode === "legacy-subdirectory" || job.publicationMode === "legacy-branch";
const isMerged = (job: PagesJob) => !!job.mergedSha || ["merged", "deploying", "live"].includes(job.status);
// Refused requests never touched the share link, so they are not attempts on it.
const isAttempt = (job: PagesJob) => job.refusal?.code !== "series-busy" && job.refusal?.code !== "newer-on-share";
const isInFlight = (job: PagesJob, now: number) => !isMerged(job) && job.status !== "failed" && !!job.autoPublish && !!job.autoPublishUntil && Date.parse(job.autoPublishUntil) > now;
const createdTime = (job: PagesJob) => { const time = job.createdAt ? Date.parse(job.createdAt) : NaN; return Number.isFinite(time) ? time : -Infinity; };
// Missing createdAt (oldest journals) sorts first; NaN from -Infinity ties falls through to jobId.
const byCreated = (a: Owned, b: Owned) => createdTime(a.job) - createdTime(b.job) || (a.job.jobId < b.job.jobId ? -1 : a.job.jobId > b.job.jobId ? 1 : 0);
export const shareSeriesId = (githubHost: string, repository: string, key: string) => `share-${sha256(canonicalJson({ githubHost, repository, key })).slice(0, 40)}`;

/** Share links of one Board, derived from the Pages journal joined with private release provenance. */
async function boardShares(board: Board, releases: ReleaseRepository, pages: PagesGateway): Promise<{ current: ShareStatus["current"]; shares: ShareView[]; foreignKeys: Set<string> }> {
  const now = Date.now(), loaded = new Map<string, Promise<{ release: StaticRelease; meta?: ReleaseMeta } | undefined>>();
  const load = (id: string) => {
    let entry = loaded.get(id);
    if (!entry) {
      entry = (async () => {
        try {
          const release = await releases.read(id), meta = await releases.meta(id);
          return { release, meta: meta?.source.boardId === release.provenance.boardId ? meta : undefined };
        } catch { return undefined; }
      })();
      loaded.set(id, entry);
    }
    return entry;
  };
  const owned: Owned[] = [], foreignKeys = new Set<string>();
  for (const job of await pages.list(undefined, { skipInvalid: true })) {
    const entry = await load(job.releaseId); if (!entry) continue;
    const { release, meta } = entry, createdAt = meta?.source.boardCreatedAt ?? release.provenance.boardCreatedAt;
    if (release.provenance.boardId === board.id && (createdAt === undefined || createdAt === board.createdAt)) owned.push({ job, release, meta });
    else if (job.shareKey) foreignKeys.add(shareSeriesId(hostOf(job), job.repository, job.shareKey));
  }
  owned.sort(byCreated);
  const series = new Map<string, Series>(), preFeature = new Map<string, Owned[]>();
  for (const item of owned) {
    const githubHost = hostOf(item.job), { repository, shareKey } = item.job;
    if (!shareKey) { const target = canonicalJson([githubHost, repository]); preFeature.set(target, [...preFeature.get(target) ?? [], item]); continue; }
    const id = shareSeriesId(githubHost, repository, shareKey);
    const entry = series.get(id) ?? { githubHost, repository, key: shareKey, keyed: true, members: [] };
    entry.members.push(item); series.set(id, entry);
  }
  // Pre-feature publications on one host+repo form one adoptable series keyed by the latest published release.
  for (const members of preFeature.values()) {
    const { githubHost, repository } = { githubHost: hostOf(members[0].job), repository: members[0].job.repository };
    const keyed = [...series.values()].filter(entry => entry.githubHost === githubHost && entry.repository === repository);
    let adopted = false;
    for (const entry of keyed) {
      const workflowSeries = entry.members.some(item => isMerged(item.job) && item.job.publicationMode === "workflow");
      const matched = members.filter(item => entry.key === item.job.releaseId.slice(8) || entry.members.some(own => own.job.adoptedFrom === item.job.jobId) ||
        workflowSeries && !isLegacyMode(item.job));
      if (matched.length) { entry.members.push(...matched); entry.members.sort(byCreated); adopted = true; break; }
    }
    if (adopted) continue;
    const representative = members.findLast(item => isMerged(item.job)) ?? members[members.length - 1], key = representative.job.releaseId.slice(8);
    series.set(shareSeriesId(githubHost, repository, key), { githubHost, repository, key, keyed: false, members });
  }
  const current = { canvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, documentVersion: board.canvas.documentVersion, patchCount: board.canvas.patches.length };
  const shares: Array<ShareView & { activity: Owned }> = [];
  for (const [seriesId, entry] of series) {
    const { members } = entry, latest = members.findLast(item => isAttempt(item.job)) ?? members[members.length - 1];
    const published = members.findLast(item => isMerged(item.job)) ?? latest, { job, release, meta } = published;
    const inFlight = members.findLast(item => isInFlight(item.job, now));
    const adoptable = !job.shareKey;
    const patchCount = release.provenance.patchCount ?? meta?.source.patchCount, canvasBase = release.provenance.canvasBase;
    const source = { canvasBase, documentVersion: canvasBase.documentVersion, ...(patchCount === undefined ? {} : { patchCount }) };
    // Authored source only (D1): data-only writes move revision but never documentVersion/patchCount.
    const changed = patchCount === undefined
      ? canvasBase.revision !== current.canvasBase.revision || canvasBase.documentVersion !== current.documentVersion
      : canvasBase.documentVersion !== current.documentVersion || patchCount !== current.patchCount;
    const state: Share["state"] = inFlight ? "updating"
      : !isMerged(job) || latest !== published && !isMerged(latest.job) ? "failed"
      : changed ? (meta && patchCount !== undefined ? "changed" : "legacy")
      : job.status !== "live" ? "merged-unverified" : "up-to-date";
    // Every job of a series shares one stable link; keep the last known one until this job's refresh computes it.
    const known = members.findLast(item => item.job.shareUrl || item.job.shareDeployedUrl)?.job;
    const link = job.shareUrl ?? job.shareDeployedUrl ?? known?.shareUrl ?? known?.shareDeployedUrl ?? (adoptable ? job.url ?? job.deployedUrl : undefined);
    shares.push({
      seriesId, key: entry.key, onLink: isMerged(job), archivesOnline: isLegacyMode(job), githubHost: entry.githubHost, account: job.account, repository: entry.repository,
      ...(entry.keyed ? { shareKey: entry.key } : {}), adoptable, ...(link ? { link } : {}),
      verified: !!job.shareUrl || adoptable && job.status === "live" && !!job.url, state,
      releaseId: release.manifest.releaseId, title: release.manifest.title, publishedJobId: job.jobId, settingsAvailable: !!meta,
      source, ...(inFlight ? { inFlightJobId: inFlight.job.jobId } : {}), activity: latest,
      ...(meta ? { settings: { network: meta.settings.network, theme: meta.settings.theme, apiOrigins: meta.settings.apiOrigins, publicDataBytes: Buffer.byteLength(canonicalJson(meta.settings.publicData)), ...(meta.settings.live ? { live: { origin: meta.settings.live.origin, paths: meta.settings.live.paths } } : {}) } } : {}),
    });
  }
  shares.sort((a, b) => byCreated(b.activity, a.activity));
  return { current, shares: shares.map(({ activity: _, ...share }) => share), foreignKeys };
}

/** Rebuilds a share's settings on the Board's current channel, dropping an old origin that was only there for live. */
function adoptCurrentLive(stored: Omit<ReleaseSettings, "title">, live: LiveRelease): Omit<ReleaseSettings, "title"> {
  const previous = stored.live?.origin;
  const carried = stored.apiOrigins.filter(origin => !(stored.liveOriginAdded && origin === previous && origin !== live.origin));
  const added = !carried.includes(live.origin) || !!stored.liveOriginAdded && previous === live.origin;
  const { liveOriginAdded: _, ...rest } = stored;
  return { ...rest, apiOrigins: withLiveOrigin(carried, live.origin), live, ...(added ? { liveOriginAdded: true } : {}) };
}

/** Host-user RPCs only: these operations are not exposed by the agent Board bridge. */
export function registerPublicationRpc(server: PluginServerContext, options: {
  ready(): Promise<void>; requireBoard(id: string): Promise<Board>;
  releases: ReleaseRepository; pages: PagesGateway; live?: LiveReleaseSource;
}): void {
  const { releases, pages } = options;
  /** Resolved on the server: a client can only ask for the Board's own channel, never name one. */
  const currentLive = async (board: Board) => releaseBlock(await options.live?.releaseChannel(board) ?? null);
  const release = async (id: string) => {
    await options.ready();
    return releases.read(id);
  };
  server.handle(createReleaseRpc, async ({ liveData, ...input }) => {
    await options.ready();
    const board = await options.requireBoard(input.boardId);
    if (!liveData) return (await releases.create({ ...input, board })).manifest;
    const live = await currentLive(board), apiOrigins = input.apiOrigins ?? [];
    return (await releases.create({ ...input, board, live, apiOrigins: withLiveOrigin(apiOrigins, live.origin), ...(apiOrigins.includes(live.origin) ? {} : { liveOriginAdded: true }) })).manifest;
  });
  server.handle(listReleasesRpc, async input => {
    await options.ready(); await options.requireBoard(input.boardId);
    return (await releases.list(input.boardId)).map(item => item.manifest);
  });
  server.handle(previewReleaseRpc, async input => { await release(input.releaseId); return releases.preview(input.releaseId); });
  server.handle(downloadReleaseRpc, async input => { await release(input.releaseId); return releases.download(input.releaseId); });
  server.handle(githubAccountsRpc, async input => { await options.ready(); return pages.accounts(input.githubHost); });
  server.handle(githubRepositoriesRpc, async input => { await options.ready(); return pages.repositories(input.account, input.githubHost); });
  // A loopback data source would resolve to each visitor's own machine on a public page.
  server.handle(preparePagesRpc, async input => { refuseLoopbackLive((await release(input.releaseId)).manifest.live, input.githubHost); return pages.prepare(input); });
  server.handle(publishPagesRpc, async input => { refuseLoopbackLive((await release(input.releaseId)).manifest.live, input.githubHost); return pages.publish(input); });
  server.handle(mergePagesRpc, async input => {
    await options.ready(); const job = await pages.read(input.jobId); await release(job.releaseId);
    return pages.merge(input);
  });
  server.handle(refreshPagesRpc, async input => {
    await options.ready(); const job = await pages.read(input.jobId); await release(job.releaseId);
    return pages.refresh(input.jobId);
  });
  server.handle(shareStatusRpc, async input => {
    await options.ready();
    const { current, shares } = await boardShares(await options.requireBoard(input.boardId), releases, pages);
    return { current, shares: shares.map(({ key: _, onLink: __, ...share }) => share) };
  });
  // Builds the update locally with the share's stored settings; publishing stays a separate reviewed request.
  server.handle(shareUpdateRpc, async (input): Promise<ShareUpdateResult> => {
    await options.ready();
    const board = await options.requireBoard(input.boardId), { current, shares, foreignKeys } = await boardShares(board, releases, pages);
    const share = shares.find(item => item.seriesId === input.seriesId);
    if (!share || foreignKeys.has(share.seriesId)) throw new Error("This share link does not belong to this Board");
    const meta = await releases.meta(share.releaseId);
    if (!meta || meta.source.boardId !== board.id || meta.source.boardCreatedAt !== board.createdAt) throw new Error("这个分享页没有保存发布设置，无法一键更新；请用「沿用上次分享页的设置」重新生成一次");
    if (input.expectedSource.documentVersion !== current.documentVersion || input.expectedSource.patchCount !== current.patchCount) throw new Error("Canvas changed; review the current Board before updating the share link");
    const { title, ...stored } = meta.settings;
    const channel = options.live ? await options.live.releaseChannel(board) : null;
    const settings = input.liveMode === "current" ? adoptCurrentLive(stored, releaseBlock(channel)) : stored;
    refuseLoopbackLive(settings.live, share.githubHost);
    // Reported on both results, so the panel can offer adoption even when the page is otherwise up to date.
    const drift = options.live ? liveDrift(settings.live, channel) : undefined;
    // Current revision: data-only writes since the review must not block the update.
    const release = await releases.create({ ...settings, title: title || undefined, board, boardId: board.id, expectedCanvasBase: current.canvasBase });
    // Up to date only when that release is on the link; a never-merged attempt is retried with the same request.
    if (share.onLink && release.manifest.releaseId === share.releaseId) return { upToDate: true, ...(drift ? { liveDrift: drift } : {}) };
    return { manifest: release.manifest, request: {
      releaseId: release.manifest.releaseId, artifactHash: release.manifest.artifactHash, githubHost: share.githubHost,
      account: share.account, repository: share.repository, shareKey: share.shareKey ?? share.key,
    }, ...(drift ? { liveDrift: drift } : {}) };
  });
  server.handle(listPagesJobsRpc, async input => {
    await options.ready(); if (input.releaseId) await release(input.releaseId);
    return pages.list(input.releaseId);
  });
}
