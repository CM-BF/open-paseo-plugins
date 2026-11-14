import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  COMMENTS_PUBLIC_NEEDS_INBOX, CommentsProbeResultSchema, ShareUpdateSchema, VisitorCommentsReleaseSchema, commentsProbeRefusal, commentsPublicReleaseWarning, commentsUnregisterWarning,
  type CommentsProbeResult, type ReleaseManifest, type ShareStatus, type ShareUpdateResult,
} from "../shared/release-contracts";
import type { InboxConnection } from "../shared/inbox-connection";
import { probeComments } from "./comments-probe";
import { registerPublicationRpc, type PagesGateway } from "./publication-rpc";
import { ReleaseRepository, buildRelease } from "./static-release";
import { BoardStore } from "./store";
import { STATIC_VIEWER_PUBLIC_COMMENTS_VERSION, staticViewerRuntime, staticViewerShell } from "../shared/static-viewer";
import { PUBLIC_COMMENTS_RUNTIME, PUBLIC_COMMENTS_SHELL, RAIL_LAYOUT_JS } from "../shared/public-threads";
import { runInNewContext } from "node:vm";
import { COMMENTS_SHELL } from "../shared/visitor-comments";
// @ts-expect-error JavaScript test helper shared with the browser checks.
import { createFakeCommentsBackend, appKeyFor } from "../scripts/comments-fake-backend.mjs";

type Fake = { apiBase: string; origin: string; deploymentId: string; setHealth(patch: Record<string, unknown>): void; requests: Array<{ method: string; path: string }>; failNext(method: string, suffix: string, kind: unknown): void; close(): Promise<void> };
const fakes: Fake[] = [], directories: string[] = [];
afterEach(async () => { await Promise.all(fakes.splice(0).map(item => item.close())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const fake = async (options: Record<string, unknown> = {}): Promise<Fake> => { const value = await createFakeCommentsBackend(options) as Fake; fakes.push(value); return value; };

describe("public comment settings (public-threads §5.1)", () => {
  it("accepts visibility public only, and an absent visibility keeps the private block byte-identical", () => {
    const block = { apiBase: "https://api.example.com", appKey: "0123456789abcdef" };
    expect(VisitorCommentsReleaseSchema.parse({ ...block, visibility: "public" })).toEqual({ ...block, visibility: "public" });
    for (const visibility of ["private", true, "PUBLIC", null]) expect(VisitorCommentsReleaseSchema.safeParse({ ...block, visibility }).success).toBe(false);
    expect(Object.keys(VisitorCommentsReleaseSchema.parse(block))).toEqual(["apiBase", "appKey"]);
    expect(ShareUpdateSchema.parse({ boardId: "b", seriesId: "s", expectedSource: { documentVersion: 1, patchCount: 0 }, comments: { ...block, visibility: "public" } }).comments).toEqual({ ...block, visibility: "public" });
  });
  it("maps health publicThreads and refuses 公开 without it, with the exact texts", async () => {
    const backend = await fake({ owner: "o" });
    for (const [value, expected] of [[1, "available"], [0, "off"], [undefined, "unsupported"], ["yes", "unknown"]] as const) {
      backend.setHealth({ publicThreads: value });
      expect((await probeComments({ apiBase: backend.apiBase })).publicThreads).toBe(expected);
    }
    const base: CommentsProbeResult = CommentsProbeResultSchema.parse({ reachable: true, httpStatus: 200, appId: "a", appKey: "0123456789abcdef", deploymentId: "d", comments: "threads", publicThreads: "available", clientIp: "socket", originProblems: [], error: null });
    expect(commentsProbeRefusal(base, undefined, "public")).toBeNull();
    expect(commentsProbeRefusal({ ...base, publicThreads: "off" }, undefined)).toBeNull();
    expect(commentsProbeRefusal({ ...base, publicThreads: "off" }, undefined, "public")).toBe("评论后端检查没有通过：后端关闭了公开评论：把 board-app.json 里的 comments.publicThreads 删掉或设为 true，然后重新部署。请先点「检查后端」。");
    expect(commentsProbeRefusal({ ...base, publicThreads: "unsupported" }, undefined, "public")).toBe("评论后端检查没有通过：后端版本过旧，不支持公开评论：在应用目录运行 paseo-board-app update-runtime，然后重新部署。请先点「检查后端」。");
  });
});

describe("public releases build viewer 5 (public-threads §5.1.2)", () => {
  it("splices the public blocks, says so in the warning, and leaves private releases on viewer 4", async () => {
    const root = await mkdtemp(join(tmpdir(), "board-public-release-")); directories.push(root);
    const board = await new BoardStore(join(root, "boards")).create({ id: "pub", title: "Public", ownerAgentId: "owner", html: "<p id='result'>首先，第二步的意思</p>", data: {} });
    const options = { board, boardId: board.id, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, publicData: {} };
    const comments = { apiBase: "https://api.example.internal", appKey: "0123456789abcdef" };
    const privateRelease = buildRelease({ ...options, comments }), publicRelease = buildRelease({ ...options, comments: { ...comments, visibility: "public" } });
    expect(privateRelease.manifest.viewerVersion).toBe(4); expect(publicRelease.manifest.viewerVersion).toBe(STATIC_VIEWER_PUBLIC_COMMENTS_VERSION);
    expect(publicRelease.manifest.releaseId).not.toBe(privateRelease.manifest.releaseId);
    expect(publicRelease.manifest.warnings).toContain(commentsPublicReleaseWarning(comments.apiBase));
    expect(commentsPublicReleaseWarning("https://x.example")).toBe("此版本允许访客框选文字评论，并公开显示：任何打开页面的人都能看到所有访客的评论和回复。评论发送到 https://x.example，页面打开时会从这里读取公开评论。访客浏览器会保存一个匿名编号，用来标出自己的评论。");
    const index = publicRelease.files["index.html"];
    expect(index).toContain("connect-src https://api.example.internal;"); expect(index).not.toContain("allow-same-origin");
    expect(index).toContain("_board/comments/public"); expect(index).not.toContain("我的评论 ");
    for (const live of [false, true]) {
      expect(staticViewerRuntime(live, "public")).toBe(staticViewerRuntime(live).replace(/\n\}$/, PUBLIC_COMMENTS_RUNTIME + "\n}"));
      expect(staticViewerShell(live, "public")).toBe(staticViewerShell(live).replace(/\n\}$/, PUBLIC_COMMENTS_SHELL + "\n}"));
      expect(staticViewerRuntime(live, "private")).toBe(staticViewerRuntime(live, true));
      for (const text of [staticViewerRuntime(live, "public"), staticViewerShell(live, "public")]) { expect(() => new Function(`return (${text})`)).not.toThrow(); expect(text).not.toMatch(/<\/script/i); expect(text).not.toContain("<!--"); }
    }
    expect(PUBLIC_COMMENTS_SHELL).not.toContain("我的评论 "); expect(COMMENTS_SHELL).not.toContain("_board/comments/public");
    for (const block of [PUBLIC_COMMENTS_RUNTIME, PUBLIC_COMMENTS_SHELL]) expect(block.trim()).toMatch(/^;\(\(\)=>\{[\s\S]*\}\)\(\);$/);
    expect(PUBLIC_COMMENTS_RUNTIME).not.toContain("localStorage"); expect(PUBLIC_COMMENTS_RUNTIME).not.toContain("paseo-board-visitor");
  });
});

async function publication(sources: InboxConnection[]) {
  const root = await mkdtemp(join(tmpdir(), "board-public-rpc-")); directories.push(root);
  const store = new BoardStore(join(root, "boards"));
  await store.create({ id: "work", title: "Work", ownerAgentId: "owner", html: "<p id='result'>首先，第二步的意思</p>", data: {} });
  const releases = new ReleaseRepository(join(root, "releases")), handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const pages = { accounts: vi.fn(async () => []), repositories: vi.fn(async () => []), prepare: vi.fn(), publish: vi.fn(), merge: vi.fn(), refresh: vi.fn(), list: vi.fn(async () => []), read: vi.fn() } as unknown as PagesGateway;
  const register = vi.fn(async (_board: unknown, _deploymentId: string, _releaseId: string, _on: boolean) => undefined);
  registerPublicationRpc({ handle(contract: { name: string }, handler: (input: unknown) => Promise<unknown>) { handlers.set(contract.name, handler); } } as PluginServerContext,
    { ready: async () => {}, requireBoard: async id => { const board = await store.read(id); if (!board) throw new Error("Missing"); return board; }, releases, pages, publicReleases: { sources: async () => sources, register } });
  const invoke = (name: string, input: unknown) => handlers.get(name)!(input);
  const create = (extra: Record<string, unknown> = {}) => invoke("board.release.create", { boardId: "work", expectedCanvasBase: { revision: 1, documentVersion: 1 }, publicData: {}, ...extra }) as Promise<ReleaseManifest>;
  return { releases, pages, invoke, create, register, sources };
}
const source = (deploymentId: string, extra: Partial<InboxConnection> = {}): InboxConnection => ({ sourceId: "src", deploymentId, label: "后端", endpoint: "https://inbox-address.example/_board/comments", enabled: true, state: "ready", eventId: "e", ...extra });

describe("public releases need the backend's inbox source and are registered on it (§5.1.4, §12 A2, A10)", () => {
  it("refuses without public threads or without a ready, enabled source of the same deployment; registers on success", async () => {
    const backend = await fake({ owner: "owner-a" }), appKey = appKeyFor("owner-a");
    const comments = { apiBase: backend.apiBase, appKey, visibility: "public" as const };
    const none = await publication([]);
    await expect(none.create({ comments })).rejects.toThrow(COMMENTS_PUBLIC_NEEDS_INBOX);
    for (const sources of [[source("other-deployment")], [source(backend.deploymentId, { enabled: false })], [source(backend.deploymentId, { state: "pending" })]]) {
      const f = await publication(sources);
      await expect(f.create({ comments })).rejects.toThrow(COMMENTS_PUBLIC_NEEDS_INBOX);
      expect(f.register).not.toHaveBeenCalled();
    }
    // The inbox may use another address of the same backend: identity, not URL, decides.
    const f = await publication([source(backend.deploymentId)]);
    const manifest = await f.create({ comments });
    expect(manifest.viewerVersion).toBe(5); expect(manifest.comments).toEqual(comments);
    expect(f.register).toHaveBeenCalledWith(expect.objectContaining({ id: "work" }), backend.deploymentId, manifest.releaseId, true, []);
    backend.setHealth({ publicThreads: 0 });
    await expect(f.create({ comments, title: "off" })).rejects.toThrow("后端关闭了公开评论");
    backend.setHealth({ publicThreads: undefined });
    await expect(f.create({ comments, title: "old" })).rejects.toThrow("后端版本过旧，不支持公开评论");
    // Private releases are unaffected: no inbox source needed, nothing registered.
    backend.setHealth({ publicThreads: 1 });
    const calls = f.register.mock.calls.length;
    expect((await (await publication([])).create({ comments: { apiBase: backend.apiBase, appKey } })).viewerVersion).toBe(4);
    expect(f.register.mock.calls.length).toBe(calls);
  });
  it("share updates: private → public registers; inherited public needs the source still; public → private unregisters the series' public releases", async () => {
    const backend = await fake({ owner: "owner-a" }), appKey = appKeyFor("owner-a");
    const privateBlock = { apiBase: backend.apiBase, appKey }, publicBlock = { ...privateBlock, visibility: "public" as const };
    const sources = [source(backend.deploymentId)];
    const f = await publication(sources);
    const original = await f.create({ title: "Shared", comments: privateBlock }), key = "s" + "b".repeat(20);
    const job = (releaseId: string, artifactHash: string, id: string, at: string) => ({ eventId: id, releaseId, artifactHash, account: "fixture", repository: "fixture/site", jobId: id, branch: "b", status: "live", mergedSha: "c".repeat(40), shareKey: key, createdAt: at });
    const jobs = [job(original.releaseId, original.artifactHash, "j1", "2026-11-13T00:00:00.000Z")];
    vi.mocked(f.pages.list).mockImplementation(async () => jobs as never);
    const seriesId = ((await f.invoke("board.release.share-status", { boardId: "work" })) as ShareStatus).shares[0].seriesId;
    const update = (comments?: unknown) => f.invoke("board.release.share-update", { boardId: "work", seriesId, expectedSource: { documentVersion: 1, patchCount: 0 }, ...(comments === undefined ? {} : { comments }) }) as Promise<ShareUpdateResult>;
    const toPublic = await update(publicBlock); if (!("manifest" in toPublic)) throw new Error("Expected a rebuild");
    expect(toPublic.manifest.viewerVersion).toBe(5);
    expect(f.register).toHaveBeenLastCalledWith(expect.anything(), backend.deploymentId, toPublic.manifest.releaseId, true, []);
    jobs.push(job(toPublic.manifest.releaseId, toPublic.manifest.artifactHash, "j2", "2026-11-13T01:00:00.000Z"));
    const status = (await f.invoke("board.release.share-status", { boardId: "work" })) as ShareStatus;
    expect(status.shares[0].settings?.comments).toEqual(publicBlock); expect(status.shares[0]).not.toHaveProperty("publicReleases");
    // The inbox source was removed since: an update that inherits 公开 is refused.
    sources.splice(0);
    await expect(update()).rejects.toThrow(COMMENTS_PUBLIC_NEEDS_INBOX);
    sources.push(source(backend.deploymentId));
    const toPrivate = await update(privateBlock); if (!("manifest" in toPrivate)) throw new Error("Expected a rebuild");
    expect(toPrivate.manifest.viewerVersion).toBe(4);
    expect(f.register).toHaveBeenLastCalledWith(expect.anything(), backend.deploymentId, toPublic.manifest.releaseId, false, []);
  });
});

describe("turning a public share off or private never depends on its backend (review fix)", () => {
  it("unregistering is best effort and closes the share's page; the result says what is left; the next update tries again", async () => {
    const backend = await fake({ owner: "owner-a" }), appKey = appKeyFor("owner-a");
    const privateBlock = { apiBase: backend.apiBase, appKey }, publicBlock = { ...privateBlock, visibility: "public" as const };
    const f = await publication([source(backend.deploymentId)]);
    const original = await f.create({ title: "Shared", comments: publicBlock }), key = "s" + "c".repeat(20), link = `https://fixture.github.io/site/${key}/`;
    const jobs = [{ eventId: "j1", releaseId: original.releaseId, artifactHash: original.artifactHash, account: "fixture", repository: "fixture/site", jobId: "j1", branch: "b", status: "live", mergedSha: "c".repeat(40), shareKey: key, shareUrl: link, createdAt: "2026-11-13T00:00:00.000Z" }];
    vi.mocked(f.pages.list).mockImplementation(async () => jobs as never);
    const seriesId = ((await f.invoke("board.release.share-status", { boardId: "work" })) as ShareStatus).shares[0].seriesId;
    const update = (comments?: unknown) => f.invoke("board.release.share-update", { boardId: "work", seriesId, expectedSource: { documentVersion: 1, patchCount: 0 }, ...(comments === undefined ? {} : { comments }) }) as Promise<ShareUpdateResult>;
    // The backend cannot be reached: 关闭 still builds, and says that old pages may still read and post.
    backend.failNext("GET", "/_board/health", "drop");
    const off = await update(false); if (!("manifest" in off)) throw new Error(`Expected a rebuild: ${JSON.stringify(off)}`);
    expect(off.manifest.viewerVersion).toBe(2); expect(off.manifest.comments).toBeUndefined();
    expect(off.commentsWarning).toBe(commentsUnregisterWarning(`连接不上 ${backend.apiBase}`));
    expect(off.commentsWarning).toContain("再更新一次这个分享页就会自动补上取消");
    // The inbox source is gone: 仅自己可见 still builds, with the reason.
    f.register.mockRejectedValueOnce(new Error(COMMENTS_PUBLIC_NEEDS_INBOX));
    const toPrivate = await update(privateBlock); if (!("manifest" in toPrivate)) throw new Error("Expected a rebuild");
    expect(toPrivate.manifest.viewerVersion).toBe(4); expect(toPrivate.commentsWarning).toContain("公开评论需要先把这个后端连接到本 Board 的评论收件箱");
    // Once it works, the release is withdrawn with the share's page, which closes that page on the backend.
    const done = await update(privateBlock);
    expect(done.commentsWarning).toBeUndefined();
    expect(f.register).toHaveBeenLastCalledWith(expect.objectContaining({ id: "work" }), backend.deploymentId, original.releaseId, false, [link]);
    // Back to 公开 through an update: the new release reopens the page.
    const reopened = await update(publicBlock);
    expect(f.register).toHaveBeenLastCalledWith(expect.anything(), backend.deploymentId, "manifest" in reopened ? reopened.manifest.releaseId : original.releaseId, true, [link]);
  });
});

describe("rail layout (public-threads §5.6.4, §12 A6)", () => {
  type Item = { y: number; h: number };
  const layout = runInNewContext(RAIL_LAYOUT_JS, { Math, Array }) as (items: Item[], active: number, o: { gap: number; lift: number; floor: number; viewTop: number; viewBottom: number; limit: number }) => number[];
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  it("never overlaps, keeps passage order, puts the active card at its passage inside the view and lifts the pile to fit the page end", () => {
    for (let run = 0; run < 500; run++) {
      const n = Math.floor(random() * 12), viewTop = Math.floor(random() * 3000), railHeight = 400 + Math.floor(random() * 600);
      const items = Array.from({ length: n }, () => ({ y: Math.floor(random() * 4000), h: 40 + Math.floor(random() * 220) })).sort((a, b) => a.y - b.y);
      const o = { gap: 8, lift: 4, floor: 8, viewTop, viewBottom: viewTop + railHeight, limit: 4200 + railHeight };
      const active = n && random() < 0.6 ? Math.floor(random() * n) : -1;
      const top = layout(items, active, o);
      expect(layout(items, active, o)).toEqual(top);
      for (let i = 1; i < n; i++) expect(top[i - 1] + items[i - 1].h + o.gap, JSON.stringify({ run, i })).toBeLessThanOrEqual(top[i] + 1e-9);
      if (active >= 0) {
        const h = items[active].h; let expected = Math.max(o.floor, items[active].y - o.lift);
        if (h <= o.viewBottom - o.viewTop - o.floor - o.gap) expected = Math.max(Math.min(expected, o.viewBottom - h - o.gap), o.viewTop + o.floor);
        expect(top[active]).toBe(expected);
        if (h <= o.viewBottom - o.viewTop - o.floor - o.gap) { expect(top[active]).toBeGreaterThanOrEqual(o.viewTop + o.floor); expect(top[active] + h).toBeLessThanOrEqual(o.viewBottom - o.gap); }
      } else if (n) {
        const total = items.reduce((sum, item) => sum + item.h + o.gap, 0) - o.gap;
        const natural: number[] = []; items.forEach((item, i) => { natural.push(i ? Math.max(item.y - o.lift, natural[i - 1] + items[i - 1].h + o.gap) : Math.max(o.floor, item.y - o.lift)); });
        expect(top[0]).toBeGreaterThanOrEqual(o.floor);
        for (let i = 0; i < n; i++) expect(top[i], "a card never sits below its natural place").toBeLessThanOrEqual(natural[i]);
        if (natural[n - 1] + items[n - 1].h <= o.limit) expect(top, "a pile that ends in time is not lifted").toEqual(natural);
        else if (total + o.floor <= o.limit) expect(top[n - 1] + items[n - 1].h, "a pile that fits is lifted to end in time").toBe(o.limit);
        else expect(top, "a pile that cannot fit keeps its first cards at their passages; the rail scrolls for the rest").toEqual(natural);
      }
    }
  });
  it("review cases: with more cards than the page can hold the first card stays at its passage (60 threads; a one-screen page)", () => {
    // 60 threads, two per paragraph, 80 px cards: the pile is taller than the page, so it is not pinned or reflowed.
    const many = Array.from({ length: 60 }, (_, i) => ({ y: 340 + Math.floor(i / 2) * 110, h: 80 }));
    const o = { gap: 8, lift: 4, floor: 8, viewTop: 0, viewBottom: 900, limit: 3600 + 900 - 8 };
    const tops = layout(many, -1, o);
    expect(tops[0]).toBe(336); expect(tops[1]).toBe(424);
    for (let i = 1; i < 60; i++) expect(tops[i]).toBe(tops[i - 1] + 88);
    // One screen (no page scroll), 13 threads on 3 lines: the first card sits at its passage, the rest run on below.
    const short = Array.from({ length: 13 }, (_, i) => ({ y: [130, 170, 210][i % 3], h: 70 })).sort((a, b) => a.y - b.y);
    const shortTops = layout(short, -1, { gap: 8, lift: 4, floor: 8, viewTop: 0, viewBottom: 900, limit: 892 });
    expect(shortTops[0]).toBe(126);
    // When the cards fit once lifted, they end exactly at the limit and the first one never goes above the floor.
    const fits = layout(Array.from({ length: 8 }, () => ({ y: 600, h: 90 })), -1, { gap: 8, lift: 4, floor: 8, viewTop: 0, viewBottom: 900, limit: 892 });
    expect(fits[7] + 90).toBe(892); expect(fits[0]).toBeGreaterThanOrEqual(8);
  });
  it("leaves a lone card at its passage and stacks a crowded line downwards", () => {
    const o = { gap: 8, lift: 4, floor: 8, viewTop: 0, viewBottom: 800, limit: 3000 };
    expect(layout([{ y: 300, h: 60 }], -1, o)).toEqual([296]);
    expect(layout([{ y: 300, h: 60 }, { y: 300, h: 60 }, { y: 300, h: 60 }], -1, o)).toEqual([296, 364, 432]);
    expect(layout([{ y: 300, h: 60 }, { y: 300, h: 60 }, { y: 300, h: 60 }], 2, o)).toEqual([160, 228, 296]);
    expect(layout([{ y: 2990, h: 60 }], -1, o)).toEqual([2940]);
    expect(layout([{ y: 790, h: 300 }], 0, o)).toEqual([492]);
  });
});
