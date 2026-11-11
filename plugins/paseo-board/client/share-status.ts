import type { Board } from "../shared/contracts";
import type { LiveChannel } from "../shared/live-data";
import type { PagesJob, PagesPrepareInput, Share } from "../shared/release-contracts";
import { pagesGitHubHost } from "./pages-outbox";

export type ShareState = Share["state"];
export type LiveShare = Share & { live: ShareState; changed: boolean };
type Canvas = Pick<Board["canvas"], "revision" | "documentVersion" | "patches">;

export const shareStateNames: Record<ShareState, string> = {
  "up-to-date": "分享页已是最新", changed: "有改动还没发布", legacy: "有改动还没发布 · 需沿用上次设置重新生成一次",
  updating: "分享页更新中", "merged-unverified": "已合并，网页内容待核验", failed: "上次更新没有完成",
};

/** D1: authored source only. Data-only writes move the revision, never documentVersion or patches. */
export function shareChanged(share: Share, canvas: Canvas): boolean {
  const { source } = share;
  return source.patchCount === undefined
    ? source.canvasBase.revision !== canvas.revision || source.documentVersion !== canvas.documentVersion
    : source.documentVersion !== canvas.documentVersion || source.patchCount !== canvas.patches.length;
}
/** Recomputes change states against the live canvas without a refetch; server-only states are kept. */
export function liveShareState(share: Share, canvas: Canvas): ShareState {
  if (share.state === "updating" || share.state === "failed") return share.state;
  if (shareChanged(share, canvas)) return share.settingsAvailable && share.source.patchCount !== undefined ? "changed" : "legacy";
  if (share.state === "changed" || share.state === "legacy") return share.verified ? "up-to-date" : "merged-unverified";
  return share.state;
}
export const liveShares = (shares: readonly Share[], canvas: Canvas): LiveShare[] => shares.map(share => ({ ...share, live: liveShareState(share, canvas), changed: shareChanged(share, canvas) }));
/** A failed last update still needs one once the Board has authored changes. */
export const shareNeedsUpdate = (share: LiveShare) => share.live === "changed" || share.live === "legacy" || share.live === "failed" && share.changed;
/** One line for the More menu; attention drives the toolbar dot. Problems outrank healthy shares. */
export function shareSummary(shares: readonly LiveShare[]): { attention: boolean; detail?: string } {
  const stale = shares.filter(shareNeedsUpdate).length;
  if (stale) return { attention: true, detail: stale > 1 ? `${stale} 个分享页有改动还没发布` : shareStateNames.changed };
  if (!shares.length) return { attention: false };
  const worst = (["updating", "failed", "merged-unverified"] as const).find(state => shares.some(share => share.live === state));
  return { attention: false, detail: shareStateNames[worst ?? (shares.every(share => share.live === "up-to-date") ? "up-to-date" : shares[0].live)] };
}
/** The pre-feature directory key an adoptable share keeps (its published release hex). */
export const shareKeyOf = (share: Share) => share.shareKey ?? share.releaseId.slice(8);

const sameTarget = (item: { githubHost?: string; repository: string }, target: { githubHost?: string; repository: string }) =>
  pagesGitHubHost(item) === pagesGitHubHost(target) && item.repository.toLowerCase() === target.repository.toLowerCase();
/**
 * A new publication joins this Board's existing series on the same host+repository when one is known;
 * otherwise it adopts a pre-feature share there (its directory hex), so the link already sent updates.
 */
export function reusableShareKey(target: { githubHost?: string; repository: string }, known: { shares?: readonly Share[]; requests?: readonly PagesPrepareInput[]; jobs?: readonly PagesJob[] }): string | undefined {
  const adoptable = known.shares?.find(share => share.adoptable && sameTarget(share, target));
  return known.shares?.find(share => share.shareKey && sameTarget(share, target))?.shareKey
    ?? known.requests?.find(item => item.shareKey && sameTarget(item, target))?.shareKey
    ?? known.jobs?.find(item => item.shareKey && sameTarget(item, target))?.shareKey
    ?? (adoptable ? shareKeyOf(adoptable) : undefined);
}
export function mintShareKey(random: (bytes: number) => Uint8Array = randomBytes): string {
  return "s" + Array.from(random(10), byte => byte.toString(16).padStart(2, "0")).join("");
}
function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count), crypto = (globalThis as { crypto?: { getRandomValues?(array: Uint8Array): Uint8Array } }).crypto;
  if (crypto?.getRandomValues) return crypto.getRandomValues(bytes);
  for (let index = 0; index < count; index++) bytes[index] = Math.floor(Math.random() * 256);
  return bytes;
}
/** A typed, non-retryable server refusal: its local retry record is stale. up-to-date is a success. */
export const refusedJob = (job: PagesJob) => job.status === "failed" && !!job.refusal && job.refusal.code !== "up-to-date";

const byteLabel = (bytes: number) => bytes < 1024 ? `${bytes} 字节` : `${(bytes / 1024).toFixed(1)} KB`;
/** Settings an update inherits, stated explicitly (API authority is never implied). */
export function inheritedSettingsText(share: Share): string {
  if (!share.settings) return `名称「${share.title}」 · 没有保存其余设置`;
  const { network, theme, apiOrigins, publicDataBytes, live } = share.settings;
  return [`名称「${share.title}」`, network === "cdn" ? "允许 CDN 库" : "仅内置资源", theme === "dark" ? "深色" : "浅色",
    apiOrigins.length ? `后端来源：${apiOrigins.join("、")}` : "不连接后端", `公开数据 ${byteLabel(publicDataBytes)}`,
    ...(live ? [`实时数据 ${live.paths.length} 个路径（${live.origin}）`] : [])].join(" · ");
}
export type ShareLiveDrift = { addedPaths: string[]; removedPaths: string[]; originChanged: boolean };
/** How the Board's current channel differs from what the share was built with; the server reports the same on update. */
export function shareLiveDrift(share: Share, channel: LiveChannel | null | undefined): ShareLiveDrift | undefined {
  if (!share.settings) return undefined;
  // A stopped channel has nothing to offer a share that never had live data.
  if (!share.settings.live && channel?.state === "revoked") return undefined;
  const stored = share.settings.live, had = new Set(stored?.paths ?? []), now = new Set(channel?.marks.map(mark => mark.path) ?? []);
  const addedPaths = [...now].filter(path => !had.has(path)), removedPaths = [...had].filter(path => !now.has(path));
  const originChanged = !!stored && !!channel && stored.origin !== channel.origin;
  return addedPaths.length || removedPaths.length || originChanged ? { addedPaths, removedPaths, originChanged } : undefined;
}
