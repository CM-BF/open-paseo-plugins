import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReleaseManifest, PagesJob, ShareStatus, ShareUpdateResult } from "../shared/release-contracts";
import { GitHubHostSchema, GitHubRepositoryNameSchema, PagesPrepareSchema } from "../shared/release-contracts";
import { BoardStore } from "./store";
import { ReleaseRepository } from "./static-release";
import { registerPublicationRpc, type PagesGateway } from "./publication-rpc";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
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
    { ready, requireBoard, releases, pages });
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
