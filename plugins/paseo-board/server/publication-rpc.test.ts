import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest, PagesJob, ShareStatus, ShareUpdateResult } from "../shared/release-contracts";
import { GitHubHostSchema, GitHubRepositoryNameSchema, PagesPrepareSchema, createReleaseRpc } from "../shared/release-contracts";
import { BoardStore } from "./store";
import { ReleaseRepository } from "./static-release";
import { registerPublicationRpc, type LiveReleaseSource, type PagesGateway } from "./publication-rpc";
import type { LiveReleaseChannel } from "./live-data";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(options: { live?: LiveReleaseSource } = {}) {
  const root = await mkdtemp(join(tmpdir(), "board-publication-rpc-")); directories.push(root);
  const store = new BoardStore(join(root, "boards"));
  const board = await store.create({ id: "work", title: "Work", ownerAgentId: "owner", html: "<p>Published text</p>", data: { secret: "PRIVATE_DATA" } });
  const releases = new ReleaseRepository(join(root, "releases"));
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const pages: PagesGateway = {
    accounts: vi.fn(async () => []), repositories: vi.fn(async () => []),
    prepare: vi.fn(async input => ({ ...input, jobId: "job", branch: "publication", status: "pr-open" })),
    publish: vi.fn(async input => ({ ...input, jobId: "job", branch: "publication", status: "prepared", autoPublish: true })),
    merge: vi.fn(async () => { throw new Error("Unexpected merge"); }),
    refresh: vi.fn(async () => { throw new Error("Unexpected refresh"); }),
    list: vi.fn(async () => []), read: vi.fn(async () => { throw new Error("Missing job"); }),
  };
  let sourceAvailable = true;
  const requireBoard = vi.fn(async (id: string) => {
    const current = sourceAvailable ? await store.read(id) : null;
    if (!current) throw new Error("Missing source Board"); return current;
  });
  const ready = vi.fn(async () => {});
  registerPublicationRpc({ handle(contract: { name: string }, handler: (input: unknown) => Promise<unknown>) { handlers.set(contract.name, handler); } } as PluginServerContext,
    { ready, requireBoard, releases, pages, ...(options.live ? { live: options.live } : {}) });
  const invoke = (name: string, input: unknown) => {
    const handler = handlers.get(name); if (!handler) throw new Error("Missing RPC " + name); return handler(input);
  };
  const create = () => invoke("board.release.create", { boardId: board.id, expectedCanvasBase: { revision: 1, documentVersion: 1 }, publicData: { label: "Public" } }) as Promise<ReleaseManifest>;
  return { board, store, pages, releases, invoke, create, ready, requireBoard, removeSource: () => { sourceAvailable = false; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

it("reads the current Board and refuses stale export through the registered host handler", async () => {
  const f = await fixture();
  await f.store.publish({ boardId: "work", expectedRevision: 1, canvasBase: { revision: 1, documentVersion: 1 }, eventId: "edit", replaceDocument: true, html: "<p>New work</p>" });
  await expect(f.create()).rejects.toThrow("Canvas changed");
  expect(await f.releases.list()).toEqual([]); expect(f.pages.prepare).not.toHaveBeenCalled();
});

it("keeps a frozen export usable after its working source becomes unavailable", async () => {
  const f = await fixture(), manifest = await f.create(); f.removeSource();
  const preview = await f.invoke("board.release.preview", { releaseId: manifest.releaseId });
  expect(JSON.stringify(preview)).toContain("Published text"); expect(JSON.stringify(preview)).not.toContain("PRIVATE_DATA");
  const download = await f.invoke("board.release.download", { releaseId: manifest.releaseId }) as { zipBase64: string };
  expect(Buffer.from(download.zipBase64, "base64").subarray(0, 2).toString()).toBe("PK");
  const request = { eventId: "publish", releaseId: manifest.releaseId, artifactHash: manifest.artifactHash, account: "fixture", repository: "fixture/site" };
  const job = await f.invoke("board.pages.prepare", request) as PagesJob;
  expect(job.eventId).toBe(request.eventId); expect(f.pages.prepare).toHaveBeenCalledExactlyOnceWith(request);
  const automatic = await f.invoke("board.pages.publish", request) as PagesJob;
  expect(automatic.autoPublish).toBe(true); expect(f.pages.publish).toHaveBeenCalledExactlyOnceWith(request);
  expect(f.requireBoard).toHaveBeenCalledTimes(1);
});

it("rejects missing release evidence before any GitHub operation, including recovered jobs", async () => {
  const f = await fixture(), manifest = await f.create();
  const missing = "release-" + "0".repeat(64);
  const request = { eventId: "publish", releaseId: missing, artifactHash: manifest.artifactHash, account: "fixture", repository: "fixture/site" };
  await expect(f.invoke("board.pages.prepare", request)).rejects.toThrow();
  await expect(f.invoke("board.pages.publish", request)).rejects.toThrow();
  vi.mocked(f.pages.read).mockResolvedValue({ ...request, jobId: "job", branch: "publication", status: "pr-open" });
  await expect(f.invoke("board.pages.merge", { jobId: "job", expectedHead: "a".repeat(40) })).rejects.toThrow();
  await expect(f.invoke("board.pages.refresh", { jobId: "job" })).rejects.toThrow();
  expect(f.pages.prepare).not.toHaveBeenCalled(); expect(f.pages.publish).not.toHaveBeenCalled(); expect(f.pages.merge).not.toHaveBeenCalled(); expect(f.pages.refresh).not.toHaveBeenCalled();
});

it("routes Enterprise account discovery, repositories and immutable publication to the selected GitHub host", async () => {
  const f = await fixture(), manifest = await f.create(), githubHost = "github.enterprise.example";
  await f.invoke("board.pages.accounts", { githubHost });
  await f.invoke("board.pages.repositories", { account: "employee_org", githubHost });
  expect(f.pages.accounts).toHaveBeenCalledExactlyOnceWith(githubHost);
  expect(f.pages.repositories).toHaveBeenCalledExactlyOnceWith("employee_org", githubHost);
  const request = PagesPrepareSchema.parse({ eventId: "enterprise-publish", releaseId: manifest.releaseId,
    artifactHash: manifest.artifactHash, account: "employee_org", githubHost, repository: "team/internal-site" });
  const prepared = await f.invoke("board.pages.prepare", request) as PagesJob;
  const published = await f.invoke("board.pages.publish", request) as PagesJob;
  expect(prepared.githubHost).toBe(githubHost); expect(published.githubHost).toBe(githubHost);
  expect(f.pages.prepare).toHaveBeenCalledExactlyOnceWith(request);
  expect(f.pages.publish).toHaveBeenCalledExactlyOnceWith(request);
});

it("normalizes hostname case while rejecting URL, port and credential injection at the RPC contract", () => {
  expect(GitHubHostSchema.parse("GitHub.Enterprise.Example")).toBe("github.enterprise.example");
  for (const host of ["", " github.com", "https://github.com", "github.com:443", "user@github.com", "github.com/path", "github.com?x=1", "github.com#x", "github.com\\evil", "github.com\n", ".github.com", "github..com", "-github.com"]) {
    expect(GitHubHostSchema.safeParse(host).success, host).toBe(false);
  }
  for (const repository of ["../..", "team/..", "./site", "team/../site", "team/%2e%2e", "team/site\n", "team/site?path=evil"]) {
    expect(GitHubRepositoryNameSchema.safeParse(repository).success, repository).toBe(false);
  }
});

describe("share status and one-click share update", () => {
  const key = "s" + "a".repeat(20), merged = "b".repeat(40);
  const job = (manifest: ReleaseManifest, overrides: Partial<PagesJob> = {}): PagesJob => ({
    eventId: "event-" + (overrides.jobId ?? "job"), releaseId: manifest.releaseId, artifactHash: manifest.artifactHash, account: "fixture", repository: "fixture/site",
    jobId: "job", branch: "publication", status: "live", mergedSha: merged, createdAt: "2026-11-10T00:00:00.000Z", ...overrides,
  });
  const status = (f: Fixture, boardId = "work") => f.invoke("board.release.share-status", { boardId }) as Promise<ShareStatus>;
  const current = async (f: Fixture, id = "work") => { const board = (await f.store.read(id))!; return { board, canvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion } }; };
  const patch = async (f: Fixture, id: string) => {
    const { board, canvasBase } = await current(f);
    await f.store.publish({ boardId: "work", expectedRevision: board.revision, eventId: "patch-" + id, canvasBase, patch: { id, selector: "p", operation: "append", html: `<b>${id}</b>` } });
  };
  const dataOnly = async (f: Fixture, value: number) => {
    const { canvasBase } = await current(f);
    await f.store.emit({ boardId: "work", eventId: "data-" + value, source: "feed", summary: "live data", canvasBase, data: { live: value } });
  };
  const sidecar = (f: Fixture, releaseId: string) => join(f.releases.root, `${releaseId}.settings.json`);
  const releaseFile = (f: Fixture, releaseId: string) => join(f.releases.root, `${releaseId}.json`);
  const series = async (f: Fixture, overrides: Partial<PagesJob> = {}) => {
    const manifest = await f.create(), published = job(manifest, { shareKey: key, sharePath: `boards/${key}`, shareUrl: `https://fixture.github.io/site/boards/${key}/`, ...overrides });
    vi.mocked(f.pages.list).mockResolvedValue([published]);
    return { manifest, published };
  };
  const update = (f: Fixture, seriesId: string, expectedSource: { documentVersion: number; patchCount: number }, boardId = "work") =>
    f.invoke("board.release.share-update", { boardId, seriesId, expectedSource }) as Promise<ShareUpdateResult>;
  const noPagesWrites = (f: Fixture) => { for (const method of [f.pages.prepare, f.pages.publish, f.pages.merge, f.pages.refresh]) expect(method).not.toHaveBeenCalled(); };

  it("reports a series share as up to date, ignores data-only writes and flags authored changes", async () => {
    const f = await fixture(), { manifest } = await series(f);
    const initial = await status(f);
    expect(initial.current).toEqual({ canvasBase: { revision: 1, documentVersion: 1 }, documentVersion: 1, patchCount: 0 });
    expect(initial.shares).toEqual([expect.objectContaining({ shareKey: key, adoptable: false, link: `https://fixture.github.io/site/boards/${key}/`, verified: true, state: "up-to-date",
      releaseId: manifest.releaseId, title: "Work", publishedJobId: "job", settingsAvailable: true, githubHost: "github.com", account: "fixture", repository: "fixture/site",
      source: { canvasBase: { revision: 1, documentVersion: 1 }, documentVersion: 1, patchCount: 0 },
      settings: { network: "offline", theme: "light", apiOrigins: [], publicDataBytes: Buffer.byteLength('{"label":"Public"}') } })]);
    expect(JSON.stringify(initial)).not.toContain("PRIVATE_DATA");
    expect(JSON.stringify(initial)).not.toContain('"label"');
    await dataOnly(f, 1);
    const data = await status(f);
    expect(data.current.canvasBase.revision).toBe(2); expect(data.shares[0].state).toBe("up-to-date");
    await patch(f, "authored");
    expect((await status(f)).shares[0]).toMatchObject({ state: "changed", source: { patchCount: 0 } });
    noPagesWrites(f);
  });

  it("reports updating, failed and merged-unverified series states", async () => {
    const f = await fixture(), { manifest, published } = await series(f);
    const later = { createdAt: "2026-11-10T01:00:00.000Z", shareKey: key, mergedSha: undefined };
    vi.mocked(f.pages.list).mockResolvedValue([published, job(manifest, { ...later, jobId: "next", status: "pr-open", autoPublish: true, autoPublishUntil: new Date(Date.now() + 60_000).toISOString() })]);
    expect((await status(f)).shares).toEqual([expect.objectContaining({ state: "updating", inFlightJobId: "next", publishedJobId: "job" })]);
    vi.mocked(f.pages.list).mockResolvedValue([published, job(manifest, { ...later, jobId: "next", status: "failed" })]);
    expect((await status(f)).shares[0]).toMatchObject({ state: "failed", publishedJobId: "job" });
    vi.mocked(f.pages.list).mockResolvedValue([job(manifest, { shareKey: key, status: "deploying", shareDeployedUrl: "https://fixture.github.io/site/boards/x/" })]);
    expect((await status(f)).shares[0]).toMatchObject({ state: "merged-unverified", verified: false, link: "https://fixture.github.io/site/boards/x/" });
    vi.mocked(f.pages.list).mockResolvedValue([job(manifest, { shareKey: key, status: "failed", mergedSha: undefined })]);
    expect((await status(f)).shares[0]).toMatchObject({ state: "failed" });
  });

  it("ignores refused requests and keeps the series link while a merged update is not yet refreshed", async () => {
    const f = await fixture(), { manifest, published } = await series(f);
    const refused = (jobId: string, code: "series-busy" | "newer-on-share") => job(manifest, { jobId, shareKey: key, status: "failed", mergedSha: undefined, createdAt: "2026-11-10T02:00:00.000Z", refusal: { code, message: "refused" } });
    vi.mocked(f.pages.list).mockResolvedValue([published, refused("busy", "series-busy"), refused("stale", "newer-on-share")]);
    expect((await status(f)).shares[0]).toMatchObject({ state: "up-to-date", publishedJobId: "job" });
    const foreign = job(manifest, { jobId: "foreign-dir", shareKey: key, status: "failed", mergedSha: undefined, createdAt: "2026-11-10T03:00:00.000Z", refusal: { code: "share-foreign", message: "changed" } });
    vi.mocked(f.pages.list).mockResolvedValue([published, foreign]);
    expect((await status(f)).shares[0].state).toBe("failed");
    const merged = job(manifest, { jobId: "merged", shareKey: key, status: "merged", createdAt: "2026-11-10T04:00:00.000Z" });
    vi.mocked(f.pages.list).mockResolvedValue([published, merged]);
    expect((await status(f)).shares[0]).toMatchObject({ publishedJobId: "merged", link: published.shareUrl, verified: false, state: "merged-unverified" });
  });

  it("offers pre-feature publications as adoptable legacy shares and flags them once the source moves", async () => {
    const f = await fixture(), manifest = await f.create(), hex = manifest.releaseId.slice(8);
    // A release built before this feature: no sidecar and no extended provenance.
    await rm(sidecar(f, manifest.releaseId));
    const stored = JSON.parse(await readFile(releaseFile(f, manifest.releaseId), "utf8"));
    delete stored.provenance.patchCount; delete stored.provenance.boardCreatedAt;
    await writeFile(releaseFile(f, manifest.releaseId), JSON.stringify(stored));
    const legacy = job(manifest, { publicationMode: "legacy-subdirectory", sourcePath: "/", sitePath: `boards/${hex}`, url: `https://fixture.github.io/site/boards/${hex}/` });
    vi.mocked(f.pages.list).mockResolvedValue([job(manifest, { jobId: "older", createdAt: "2026-11-09T00:00:00.000Z", status: "failed", mergedSha: undefined }), legacy]);
    const [share] = (await status(f)).shares;
    expect(share).toMatchObject({ adoptable: true, link: legacy.url, verified: true, settingsAvailable: false, state: "up-to-date", publishedJobId: "job", source: { documentVersion: 1 } });
    expect(share.shareKey).toBeUndefined(); expect(share.source.patchCount).toBeUndefined();
    expect((await status(f)).shares).toHaveLength(1);
    await dataOnly(f, 1);
    expect((await status(f)).shares[0].state).toBe("legacy");
    await expect(update(f, share.seriesId, { documentVersion: 1, patchCount: 0 })).rejects.toThrow("没有保存发布设置");
    noPagesWrites(f);
  });

  it("marks a release without a settings sidecar as legacy when its authored source changed", async () => {
    const f = await fixture(), { manifest } = await series(f);
    await rm(sidecar(f, manifest.releaseId));
    await dataOnly(f, 1);
    expect((await status(f)).shares[0]).toMatchObject({ state: "up-to-date", settingsAvailable: false });
    expect((await status(f)).shares[0].settings).toBeUndefined();
    await patch(f, "authored");
    const [share] = (await status(f)).shares;
    expect(share.state).toBe("legacy");
    await expect(update(f, share.seriesId, { documentVersion: 1, patchCount: 1 })).rejects.toThrow("没有保存发布设置");
    noPagesWrites(f);
  });

  it("excludes other Boards, Boards recreated under the same id and unreadable releases", async () => {
    const f = await fixture(), { published } = await series(f);
    const other = await f.store.create({ id: "other", title: "Other", ownerAgentId: "owner", html: "<p>Other</p>", data: {} });
    const otherManifest = await f.invoke("board.release.create", { boardId: other.id, expectedCanvasBase: { revision: 1, documentVersion: 1 }, publicData: {} }) as ReleaseManifest;
    const missing = { ...published, jobId: "missing", releaseId: "release-" + "0".repeat(64) };
    vi.mocked(f.pages.list).mockResolvedValue([published, job(otherManifest, { jobId: "other-job", repository: "fixture/other", shareKey: "s" + "c".repeat(20) }), missing]);
    expect((await status(f)).shares.map(share => share.publishedJobId)).toEqual(["job"]);
    expect((await status(f, "other")).shares.map(share => share.publishedJobId)).toEqual(["other-job"]);
    // Same Board id, different creation: the old release belongs to a deleted Board.
    for (const file of [releaseFile(f, published.releaseId), sidecar(f, published.releaseId)]) {
      const stored = JSON.parse(await readFile(file, "utf8"));
      if (stored.provenance) stored.provenance.boardCreatedAt = "2020-01-01T00:00:00.000Z"; else stored.source.boardCreatedAt = "2020-01-01T00:00:00.000Z";
      await writeFile(file, JSON.stringify(stored));
    }
    expect((await status(f)).shares).toEqual([]);
  });

  it("rebuilds with the share's stored settings at the current revision without publishing", async () => {
    const f = await fixture(), settings = { title: "Shared page", theme: "dark", network: "offline", apiOrigins: ["https://api.example.com"], publicData: { label: "Public" } } as const;
    const original = await f.invoke("board.release.create", { boardId: "work", expectedCanvasBase: { revision: 1, documentVersion: 1 }, ...settings }) as ReleaseManifest;
    vi.mocked(f.pages.list).mockResolvedValue([job(original, { shareKey: key, githubHost: "github.enterprise.example" })]);
    await patch(f, "authored"); await dataOnly(f, 7);
    const [share] = (await status(f)).shares;
    expect(share.state).toBe("changed");
    const result = await update(f, share.seriesId, { documentVersion: 1, patchCount: 1 });
    if (!("manifest" in result)) throw new Error("Expected a new release");
    expect(result.manifest).toMatchObject({ title: "Shared page", apiOrigins: ["https://api.example.com"], network: "offline" });
    expect(result.request).toEqual({ releaseId: result.manifest.releaseId, artifactHash: result.manifest.artifactHash, githubHost: "github.enterprise.example", account: "fixture", repository: "fixture/site", shareKey: key });
    const before = (await f.releases.meta(original.releaseId))!, after = (await f.releases.meta(result.manifest.releaseId))!;
    expect(after.settings).toEqual(before.settings); expect(after.settings.theme).toBe("dark");
    const { board } = await current(f);
    expect(after.source).toMatchObject({ canvasBase: { revision: board.canvas.revision, documentVersion: 1 }, patchCount: 1 });
    const preview = await f.releases.preview(result.manifest.releaseId);
    expect(preview.html).toContain("authored"); expect(preview.html).not.toContain("PRIVATE_DATA"); expect(preview.html).not.toContain('"live"');
    noPagesWrites(f);
  });

  it("refuses when the reviewed authored source moved, and reports an unchanged share as up to date", async () => {
    const f = await fixture(), { manifest } = await series(f), seriesId = (await status(f)).shares[0].seriesId;
    expect(await update(f, seriesId, { documentVersion: 1, patchCount: 0 })).toEqual({ upToDate: true });
    await patch(f, "authored");
    const count = (await f.releases.list()).length;
    await expect(update(f, seriesId, { documentVersion: 1, patchCount: 0 })).rejects.toThrow("Canvas changed");
    await expect(update(f, seriesId, { documentVersion: 2, patchCount: 1 })).rejects.toThrow("Canvas changed");
    expect((await f.releases.list()).length).toBe(count);
    expect((await f.releases.list()).map(release => release.manifest.releaseId)).toEqual([manifest.releaseId]);
    noPagesWrites(f);
  });

  it("retries a never-merged share instead of calling it up to date", async () => {
    const f = await fixture(), { manifest } = await series(f, { status: "failed", mergedSha: undefined, shareUrl: undefined });
    const [share] = (await status(f)).shares;
    expect(share).toMatchObject({ state: "failed", releaseId: manifest.releaseId }); expect(share.link).toBeUndefined();
    const result = await update(f, share.seriesId, { documentVersion: 1, patchCount: 0 });
    expect(result).toEqual({ manifest: expect.objectContaining({ releaseId: manifest.releaseId }), request: expect.objectContaining({ releaseId: manifest.releaseId, shareKey: key }) });
    noPagesWrites(f);
  });

  it("says whether older versions stay online: branch directories archive them, the workflow root does not", async () => {
    const f = await fixture(), manifest = await f.create(), hex = manifest.releaseId.slice(8);
    vi.mocked(f.pages.list).mockResolvedValue([
      job(manifest, { jobId: "branch", publicationMode: "legacy-subdirectory", sourcePath: "/", sitePath: `boards/${hex}`, url: `https://fixture.github.io/site/boards/${hex}/` }),
      job(manifest, { jobId: "root", repository: "fixture/root", publicationMode: "workflow", url: "https://fixture.github.io/root/" }),
    ]);
    const shares = (await status(f)).shares;
    expect(Object.fromEntries(shares.map(share => [share.publishedJobId, [share.adoptable, share.archivesOnline]]))).toEqual({ branch: [true, true], root: [true, false] });
    expect(JSON.stringify(shares)).not.toContain("onLink");
  });

  it("returns the adopted directory key for a pre-feature series with stored settings", async () => {
    const f = await fixture(), manifest = await f.create(), hex = manifest.releaseId.slice(8);
    vi.mocked(f.pages.list).mockResolvedValue([job(manifest, { publicationMode: "legacy-subdirectory", sourcePath: "/", sitePath: `boards/${hex}`, url: `https://fixture.github.io/site/boards/${hex}/` })]);
    const [share] = (await status(f)).shares;
    expect(share).toMatchObject({ adoptable: true, settingsAvailable: true, state: "up-to-date" });
    await patch(f, "authored");
    const result = await update(f, share.seriesId, { documentVersion: 1, patchCount: 1 });
    expect(result).toMatchObject({ request: { shareKey: hex, githubHost: "github.com", repository: "fixture/site" } });
    noPagesWrites(f);
  });

  describe("live data on releases and share updates", () => {
    const channelId = `c${"a".repeat(32)}`, origin = "https://live.example.com", paths = ["/live/a", "/live/b"];
    const channelFor = (overrides: Partial<LiveReleaseChannel> = {}): LiveReleaseChannel => ({ origin, channelId, paths, state: "live", channelState: "ready", ...overrides });
    const liveFixture = async (initial: LiveReleaseChannel | null) => {
      let channel = initial;
      const f = await fixture({ live: { releaseChannel: async () => channel } });
      return { f, setChannel: (next: LiveReleaseChannel | null) => { channel = next; } };
    };
    const base = { boardId: "work", expectedCanvasBase: { revision: 1, documentVersion: 1 }, publicData: { label: "Public" } };
    const createLive = (f: Fixture, extra: Record<string, unknown> = {}) => f.invoke("board.release.create", { ...base, liveData: true, ...extra }) as Promise<ReleaseManifest>;
    const liveUpdate = (f: Fixture, seriesId: string, liveMode: "keep" | "current") => f.invoke("board.release.share-update", { boardId: "work", seriesId, expectedSource: { documentVersion: 1, patchCount: 0 }, liveMode }) as Promise<ShareUpdateResult>;
    const liveSeries = async (f: Fixture, extra: Record<string, unknown> = {}) => {
      const manifest = await createLive(f, extra);
      vi.mocked(f.pages.list).mockResolvedValue([job(manifest, { shareKey: key, sharePath: `boards/${key}`, shareUrl: `https://fixture.github.io/site/boards/${key}/` })]);
      return { manifest, seriesId: (await status(f)).shares[0].seriesId };
    };

    it("resolves the live block on the server from a client boolean", async () => {
      const { f } = await liveFixture(channelFor()), manifest = await createLive(f);
      expect(manifest).toMatchObject({ viewerVersion: 3, live: { origin, channelId, paths }, apiOrigins: [origin] });
      const meta = (await f.releases.meta(manifest.releaseId))!;
      expect(meta.settings).toMatchObject({ live: { origin, channelId, paths }, liveOriginAdded: true, apiOrigins: [origin] });
      expect(JSON.stringify(await f.releases.read(manifest.releaseId))).not.toContain("liveOriginAdded");
    });
    it("does not duplicate an origin the human already listed, and records that it was theirs", async () => {
      const { f } = await liveFixture(channelFor()), manifest = await createLive(f, { apiOrigins: [origin, "https://api.example.com"] });
      expect(manifest.apiOrigins).toEqual([origin, "https://api.example.com"]);
      expect((await f.releases.meta(manifest.releaseId))!.settings).not.toHaveProperty("liveOriginAdded");
    });
    it("cannot be pointed at another channel: a client-sent live object never reaches the handler", async () => {
      const parsed = createReleaseRpc.input.parse({ ...base, live: { origin: "https://evil.example.com", channelId: `c${"b".repeat(32)}`, paths: ["/x"] }, liveData: false });
      expect(parsed).not.toHaveProperty("live");
      const { f } = await liveFixture(channelFor()), manifest = await f.invoke("board.release.create", parsed) as ReleaseManifest;
      expect(manifest.viewerVersion).toBe(2); expect(manifest).not.toHaveProperty("live");
    });
    it("builds the unchanged non-live release when the flag is off, without asking for a channel", async () => {
      const releaseChannel = vi.fn(async () => channelFor()), f = await fixture({ live: { releaseChannel } }), manifest = await f.invoke("board.release.create", base) as ReleaseManifest;
      expect(manifest).not.toHaveProperty("live"); expect(manifest.viewerVersion).toBe(2); expect(releaseChannel).not.toHaveBeenCalled();
    });
    it("refuses a live release without a confirmed channel holding a public copy", async () => {
      const { f, setChannel } = await liveFixture(null);
      await expect(createLive(f)).rejects.toThrow("实时公开连接");
      for (const channelState of ["pending", "blocked", "revoking", "revoked"] as const) { setChannel(channelFor({ channelState })); await expect(createLive(f)).rejects.toThrow("实时公开连接"); }
      setChannel(channelFor({ channelState: "paused", state: "paused" }));
      expect((await createLive(f)).live?.channelId).toBe(channelId);
      expect(f.pages.prepare).not.toHaveBeenCalled();
    });
    it("refuses a live release that would exceed the origin limit", async () => {
      const { f } = await liveFixture(channelFor()), apiOrigins = Array.from({ length: 8 }, (_, index) => `https://api${index}.example.com`);
      await expect(createLive(f, { apiOrigins })).rejects.toThrow("8 个上限");
      expect((await createLive(f, { apiOrigins: apiOrigins.slice(0, 7) })).apiOrigins).toHaveLength(8);
    });

    it("keeps the stored live block by default, even after revoke, and reports the drift", async () => {
      const { f, setChannel } = await liveFixture(channelFor()), { manifest, seriesId } = await liveSeries(f);
      setChannel(channelFor({ channelState: "revoked", state: "revoked", paths: ["/live/a", "/live/c"] }));
      const result = await liveUpdate(f, seriesId, "keep");
      expect(result).toEqual({ upToDate: true, liveDrift: { addedPaths: ["/live/c"], removedPaths: ["/live/b"], originChanged: false, channelState: "revoked" } });
      await patch(f, "authored");
      const rebuilt = await f.invoke("board.release.share-update", { boardId: "work", seriesId, expectedSource: { documentVersion: 1, patchCount: 1 } }) as ShareUpdateResult;
      if (!("manifest" in rebuilt)) throw new Error("Expected a new release");
      expect(rebuilt.manifest.live).toEqual(manifest.live);
      expect(rebuilt.liveDrift?.channelState).toBe("revoked");
      noPagesWrites(f);
    });
    it("omits the drift when the share matches the channel", async () => {
      const { f } = await liveFixture(channelFor()), { seriesId } = await liveSeries(f);
      expect(await liveUpdate(f, seriesId, "keep")).toEqual({ upToDate: true });
      expect((await status(f)).shares[0].settings?.live).toEqual({ origin, paths });
      noPagesWrites(f);
    });
    it("adopts the current channel on request, on an otherwise unchanged page, with no remaining drift", async () => {
      const { f, setChannel } = await liveFixture(channelFor()), { manifest, seriesId } = await liveSeries(f);
      setChannel(channelFor({ paths: ["/live/a", "/live/z"] }));
      const result = await liveUpdate(f, seriesId, "current");
      if (!("manifest" in result)) throw new Error("Expected a new release");
      expect(result.manifest.releaseId).not.toBe(manifest.releaseId);
      expect(result.manifest.live?.paths).toEqual(["/live/a", "/live/z"]);
      expect(result.liveDrift).toBeUndefined();
      expect(result.request).toMatchObject({ shareKey: key, repository: "fixture/site" });
      noPagesWrites(f);
    });
    it("gives a non-live share live data through one current update, and reports it as drift first", async () => {
      const { f } = await liveFixture(channelFor()), manifest = await f.create();
      vi.mocked(f.pages.list).mockResolvedValue([job(manifest, { shareKey: key, shareUrl: `https://fixture.github.io/site/boards/${key}/` })]);
      const seriesId = (await status(f)).shares[0].seriesId;
      expect(await liveUpdate(f, seriesId, "keep")).toEqual({ upToDate: true, liveDrift: { addedPaths: paths, removedPaths: [], originChanged: false, channelState: "live" } });
      const adopted = await liveUpdate(f, seriesId, "current");
      if (!("manifest" in adopted)) throw new Error("Expected a new release");
      expect(adopted.manifest).toMatchObject({ viewerVersion: 3, apiOrigins: [origin], live: { origin, channelId, paths } });
    });
    it("refuses current when the channel cannot back a release", async () => {
      const { f, setChannel } = await liveFixture(channelFor()), { seriesId } = await liveSeries(f);
      const count = (await f.releases.list()).length;
      setChannel(null); await expect(liveUpdate(f, seriesId, "current")).rejects.toThrow("实时公开连接");
      setChannel(channelFor({ channelState: "revoked", state: "revoked" })); await expect(liveUpdate(f, seriesId, "current")).rejects.toThrow("实时公开连接");
      expect((await f.releases.list()).length).toBe(count);
      noPagesWrites(f);
    });
    it("reports a removed channel as drift with state none", async () => {
      const { f, setChannel } = await liveFixture(channelFor()), { seriesId } = await liveSeries(f);
      setChannel(null);
      expect(await liveUpdate(f, seriesId, "keep")).toEqual({ upToDate: true, liveDrift: { addedPaths: [], removedPaths: paths, originChanged: false, channelState: "none" } });
    });
    it("reports an origin change, drops an old origin only live used, and keeps one the human listed", async () => {
      const moved = "https://new-live.example.com";
      const { f, setChannel } = await liveFixture(channelFor()), { seriesId } = await liveSeries(f);
      setChannel(channelFor({ origin: moved }));
      expect(await liveUpdate(f, seriesId, "keep")).toEqual({ upToDate: true, liveDrift: { addedPaths: [], removedPaths: [], originChanged: true, channelState: "live" } });
      const adopted = await liveUpdate(f, seriesId, "current");
      if (!("manifest" in adopted)) throw new Error("Expected a new release");
      expect(adopted.manifest.apiOrigins).toEqual([moved]); expect(adopted.manifest.live?.origin).toBe(moved);
      expect((await f.releases.meta(adopted.manifest.releaseId))!.settings.liveOriginAdded).toBe(true);

      const second = await liveFixture(channelFor()), listed = await liveSeries(second.f, { apiOrigins: [origin, "https://api.example.com"] });
      second.setChannel(channelFor({ origin: moved }));
      const kept = await liveUpdate(second.f, listed.seriesId, "current");
      if (!("manifest" in kept)) throw new Error("Expected a new release");
      expect(kept.manifest.apiOrigins).toEqual([origin, "https://api.example.com", moved]);
    });
    it("keeps a live origin that stayed the same when adopting new paths", async () => {
      const { f, setChannel } = await liveFixture(channelFor()), { seriesId } = await liveSeries(f);
      setChannel(channelFor({ paths: ["/live/q"] }));
      const adopted = await liveUpdate(f, seriesId, "current");
      if (!("manifest" in adopted)) throw new Error("Expected a new release");
      expect(adopted.manifest.apiOrigins).toEqual([origin]);
      expect((await f.releases.meta(adopted.manifest.releaseId))!.settings.liveOriginAdded).toBe(true);
    });
    it("refuses to publish a loopback live release to a public Pages host, including through share updates", async () => {
      const loopback = "http://127.0.0.1:8787";
      const { f, setChannel } = await liveFixture(channelFor({ origin: loopback })), manifest = await createLive(f);
      const request = { eventId: "publish", releaseId: manifest.releaseId, artifactHash: manifest.artifactHash, account: "fixture", repository: "fixture/site" };
      for (const name of ["board.pages.prepare", "board.pages.publish"]) await expect(f.invoke(name, request)).rejects.toThrow("本机测试用的实时数据不能发布到公开站点");
      await expect(f.invoke("board.pages.publish", { ...request, githubHost: "github.enterprise.example" })).rejects.toThrow("本机测试用");
      noPagesWrites(f);
      await f.invoke("board.pages.publish", { ...request, githubHost: "localhost" });
      expect(f.pages.publish).toHaveBeenCalledTimes(1);

      vi.mocked(f.pages.list).mockResolvedValue([job(manifest, { shareKey: key, shareUrl: `https://fixture.github.io/site/boards/${key}/` })]);
      const seriesId = (await status(f)).shares[0].seriesId;
      await expect(liveUpdate(f, seriesId, "keep")).rejects.toThrow("本机测试用");
      setChannel(channelFor({ origin: "https://live.example.com" }));
      const adopted = await liveUpdate(f, seriesId, "current");
      if (!("manifest" in adopted)) throw new Error("Expected a new release");
      expect(adopted.manifest.live?.origin).toBe("https://live.example.com");
      expect(adopted.manifest.apiOrigins).toEqual(["https://live.example.com"]);
    });
    it("still publishes a non-live or HTTPS live release normally", async () => {
      const { f } = await liveFixture(channelFor()), manifest = await createLive(f);
      await f.invoke("board.pages.publish", { eventId: "publish", releaseId: manifest.releaseId, artifactHash: manifest.artifactHash, account: "fixture", repository: "fixture/site" });
      expect(f.pages.publish).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects a share series of another Board", async () => {
    const f = await fixture(), { published } = await series(f), seriesId = (await status(f)).shares[0].seriesId;
    await f.store.create({ id: "other", title: "Other", ownerAgentId: "owner", html: "<p>Other</p>", data: {} });
    await expect(update(f, seriesId, { documentVersion: 1, patchCount: 0 }, "other")).rejects.toThrow("does not belong");
    await expect(update(f, "share-unknown", { documentVersion: 1, patchCount: 0 })).rejects.toThrow("does not belong");
    // A second Board reusing the same key on the same repository makes the series ambiguous.
    const otherManifest = await f.invoke("board.release.create", { boardId: "other", expectedCanvasBase: { revision: 1, documentVersion: 1 }, publicData: {} }) as ReleaseManifest;
    vi.mocked(f.pages.list).mockResolvedValue([published, job(otherManifest, { jobId: "foreign", shareKey: key })]);
    await expect(update(f, seriesId, { documentVersion: 1, patchCount: 0 })).rejects.toThrow("does not belong");
    noPagesWrites(f);
  });
});
