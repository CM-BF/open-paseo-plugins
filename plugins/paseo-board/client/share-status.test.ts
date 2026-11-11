import { describe, expect, it } from "vitest";
import type { PagesJob, Share } from "../shared/release-contracts";
import { inheritedSettingsText, liveShareState, liveShares, mintShareKey, refusedJob, reusableShareKey, shareKeyOf, shareLiveDrift, shareSummary } from "./share-status";

const hex = "a".repeat(64), key = "s" + "b".repeat(20);
const share = (overrides: Partial<Share> = {}): Share => ({
  seriesId: "share-1", githubHost: "github.com", account: "fixture", repository: "fixture/site", shareKey: key, adoptable: false,
  link: `https://fixture.github.io/site/boards/${key}/`, verified: true, state: "up-to-date", releaseId: `release-${hex}`, title: "Work",
  publishedJobId: "job", settingsAvailable: true, source: { canvasBase: { revision: 3, documentVersion: 1 }, documentVersion: 1, patchCount: 2 }, ...overrides,
});
const canvas = (revision: number, documentVersion: number, patches: number) => ({ revision, documentVersion, patches: Array.from({ length: patches }, (_, index) => ({ id: `p${index}`, selector: "p", operation: "append" as const, html: "" })) });

describe("share state against the live canvas", () => {
  it("ignores data-only writes and flags authored patches or a new document", () => {
    expect(liveShareState(share(), canvas(9, 1, 2))).toBe("up-to-date");
    expect(liveShareState(share(), canvas(4, 1, 3))).toBe("changed");
    expect(liveShareState(share(), canvas(4, 2, 0))).toBe("changed");
  });
  it("treats a share without settings or patch count as legacy and falls back to revision when patchCount is unknown", () => {
    expect(liveShareState(share({ settingsAvailable: false }), canvas(4, 1, 3))).toBe("legacy");
    const old = share({ source: { canvasBase: { revision: 3, documentVersion: 1 }, documentVersion: 1 } });
    expect(liveShareState(old, canvas(3, 1, 7))).toBe("up-to-date");
    expect(liveShareState(old, canvas(4, 1, 0))).toBe("legacy");
  });
  it("keeps server-only states and clears a stale changed state once the canvas matches again", () => {
    expect(liveShareState(share({ state: "updating" }), canvas(4, 1, 3))).toBe("updating");
    expect(liveShareState(share({ state: "failed" }), canvas(4, 1, 3))).toBe("failed");
    expect(liveShareState(share({ state: "changed" }), canvas(3, 1, 2))).toBe("up-to-date");
    expect(liveShareState(share({ state: "changed", verified: false }), canvas(3, 1, 2))).toBe("merged-unverified");
  });
  it("summarizes attention for the toolbar dot and the menu detail", () => {
    expect(shareSummary([])).toEqual({ attention: false });
    expect(shareSummary(liveShares([share()], canvas(3, 1, 2)))).toEqual({ attention: false, detail: "分享页已是最新" });
    expect(shareSummary(liveShares([share(), share({ seriesId: "share-2" })], canvas(3, 1, 3)))).toEqual({ attention: true, detail: "2 个分享页有改动还没发布" });
    expect(shareSummary(liveShares([share({ state: "updating" })], canvas(3, 1, 2)))).toMatchObject({ attention: false, detail: "分享页更新中" });
    // A failed share outranks a healthy first one, and lights the dot once the Board has authored changes.
    const mixed = [share(), share({ seriesId: "share-2", state: "failed" })];
    expect(shareSummary(liveShares(mixed, canvas(3, 1, 2)))).toEqual({ attention: false, detail: "上次更新没有完成" });
    expect(shareSummary(liveShares([share({ state: "merged-unverified", verified: false }), share({ seriesId: "share-2" })], canvas(3, 1, 2)))).toEqual({ attention: false, detail: "已合并，网页内容待核验" });
    expect(shareSummary(liveShares([share({ state: "failed" })], canvas(4, 1, 3)))).toEqual({ attention: true, detail: "有改动还没发布" });
  });
});

describe("share keys and stale requests", () => {
  it("mints a client key in the server's format", () => {
    expect(mintShareKey()).toMatch(/^s[a-f0-9]{20}$/);
    expect(mintShareKey(count => new Uint8Array(count).fill(255))).toBe("s" + "f".repeat(20));
  });
  it("reuses this Board's key for the same host and repository from status, then requests, then jobs", () => {
    const request = { eventId: "e", releaseId: `release-${hex}`, artifactHash: hex, account: "fixture", repository: "fixture/site", shareKey: "s" + "c".repeat(20) };
    expect(reusableShareKey({ githubHost: "github.com", repository: "Fixture/Site" }, { shares: [share()], requests: [request] })).toBe(key);
    expect(reusableShareKey({ repository: "fixture/site" }, { shares: [share({ shareKey: undefined, adoptable: true })], requests: [request] })).toBe(request.shareKey);
    expect(reusableShareKey({ githubHost: "github.enterprise.example", repository: "fixture/site" }, { shares: [share()], requests: [request] })).toBeUndefined();
    expect(reusableShareKey({ repository: "fixture/other" }, { jobs: [{ ...request, repository: "fixture/other", jobId: "j", status: "live", branch: "b" } as PagesJob] })).toBe(request.shareKey);
    // With no key there yet, a pre-feature share on that repository is adopted so its link updates.
    expect(reusableShareKey({ repository: "fixture/site" }, { shares: [share({ shareKey: undefined, adoptable: true })] })).toBe(hex);
    expect(reusableShareKey({ repository: "fixture/other" }, { shares: [share({ shareKey: undefined, adoptable: true })] })).toBeUndefined();
  });
  it("keeps the published directory hex for an adoptable share", () => {
    expect(shareKeyOf(share({ shareKey: undefined, adoptable: true }))).toBe(hex);
    expect(shareKeyOf(share())).toBe(key);
  });
  it("treats only failed typed refusals other than up-to-date as stale", () => {
    const job = { eventId: "e", releaseId: `release-${hex}`, artifactHash: hex, account: "a", repository: "a/b", jobId: "j", branch: "b" } as const;
    expect(refusedJob({ ...job, status: "failed", refusal: { code: "newer-on-share", message: "x" } })).toBe(true);
    expect(refusedJob({ ...job, status: "failed", error: "network" })).toBe(false);
    expect(refusedJob({ ...job, status: "deploying", refusal: { code: "up-to-date", message: "x" } })).toBe(false);
  });
  it("lists inherited settings explicitly without public data contents", () => {
    expect(inheritedSettingsText(share({ settings: { network: "cdn", theme: "dark", apiOrigins: ["https://api.example.com"], publicDataBytes: 2048 } })))
      .toBe("名称「Work」 · 允许 CDN 库 · 深色 · 后端来源：https://api.example.com · 公开数据 2.0 KB");
    expect(inheritedSettingsText(share({ settingsAvailable: false }))).toContain("没有保存");
  });
});

describe("share live drift", () => {
  const settings = { network: "offline" as const, theme: "light" as const, apiOrigins: [], publicDataBytes: 2 };
  const channel = (paths: string[], origin = "https://api.example.com") => ({ origin, marks: paths.map(path => ({ path, subtree: false })) }) as never;
  it("reports added, removed and origin changes against the share's stored live block", () => {
    const stored = share({ settings: { ...settings, live: { origin: "https://api.example.com", paths: ["/a", "/b"] } } });
    expect(shareLiveDrift(stored, channel(["/a", "/b"]))).toBeUndefined();
    expect(shareLiveDrift(stored, channel(["/a", "/c"]))).toEqual({ addedPaths: ["/c"], removedPaths: ["/b"], originChanged: false });
    expect(shareLiveDrift(stored, channel(["/a", "/b"], "https://other.example.com"))).toEqual({ addedPaths: [], removedPaths: [], originChanged: true });
    expect(shareLiveDrift(stored, null)).toEqual({ addedPaths: [], removedPaths: ["/a", "/b"], originChanged: false });
  });
  it("offers a non-live share the channel's paths, and says nothing without settings or a channel", () => {
    expect(shareLiveDrift(share({ settings }), channel(["/a"]))).toEqual({ addedPaths: ["/a"], removedPaths: [], originChanged: false });
    expect(shareLiveDrift(share({ settings }), null)).toBeUndefined();
    expect(shareLiveDrift(share(), channel(["/a"]))).toBeUndefined();
  });
  it("states an inherited live block in the update summary only when present", () => {
    expect(inheritedSettingsText(share({ settings: { ...settings, live: { origin: "https://api.example.com", paths: ["/a"] } } }))).toContain("实时数据 1 个路径（https://api.example.com）");
    expect(inheritedSettingsText(share({ settings }))).not.toContain("实时数据");
  });
});
