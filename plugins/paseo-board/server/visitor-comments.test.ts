import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  CommentsProbeResultSchema, PublicApiBaseSchema, ShareUpdateSchema, commentsProbeRefusal, commentsProbeText, internalApiHost,
  type CommentsProbeResult, type ReleaseManifest, type ShareStatus, type ShareUpdateResult,
} from "../shared/release-contracts";
import { probeComments } from "./comments-probe";
import { registerPublicationRpc, type PagesGateway } from "./publication-rpc";
import { releaseMain } from "./release-cli";
import { ReleaseRepository } from "./static-release";
import { BoardStore } from "./store";
// @ts-expect-error JavaScript test helper shared with the browser checks.
import { createFakeCommentsBackend, loadContractFixture, normalizeCommentInput, appKeyFor } from "../scripts/comments-fake-backend.mjs";

type Fake = {
  apiBase: string; origin: string; deploymentId: string; health: Record<string, unknown>; setHealth(patch: Record<string, unknown>): void;
  requests: Array<{ method: string; path: string; headers: Record<string, string | undefined> }>; close(): Promise<void>;
};
const fakes: Fake[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map(fake => fake.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const fake = async (options: Record<string, unknown> = {}): Promise<Fake> => { const value = await createFakeCommentsBackend(options) as Fake; fakes.push(value); return value; };

describe("shared contract fixture", () => {
  it("is the byte-identical copy every branch adds", async () => {
    const raw = await readFile(join(process.cwd(), "scripts/fixtures/page-comments-contract.json"));
    expect(createHash("sha256").update(raw).digest("hex")).toBe("f22da133efa5c93bba36ad427a3d0da24e2bc5fd467736cb0f9045e13b237be6");
  });
  it("is answered exactly by the fake backend's POST normalization", () => {
    const fixture = loadContractFixture();
    for (const item of fixture.post.accepted) expect(normalizeCommentInput(item.body, { visitor: item.visitor === true }), item.name).toEqual(item.stored);
    for (const item of fixture.post.rejected) {
      if (item.code === "visitor_invalid") { expect(typeof item.visitor, item.name).toBe("string"); expect(/^[a-f0-9]{64}$/.test(item.visitor), item.name).toBe(false); continue; }
      let code: string | undefined;
      try { normalizeCommentInput(item.body, { visitor: item.visitor === true }); } catch (error) { code = (error as { code?: string }).code; }
      expect(code, item.name).toBe(item.code);
    }
  });
  it("matches every accepted and rejected case over real HTTP, including the visitor header", async () => {
    const fixture = loadContractFixture(), backend = await fake();
    let index = 0;
    const post = (body: unknown, visitor: unknown) => fetch(`${backend.apiBase}/_board/comments`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": `pc-fixture-${++index}`, ...(visitor === true ? { "X-Board-Visitor": fixture.visitorSecret } : typeof visitor === "string" ? { "X-Board-Visitor": visitor } : {}) }, body: JSON.stringify(body) });
    for (const item of fixture.post.accepted) {
      const response = await post(item.body, item.visitor), body = await response.json() as Record<string, any>;
      expect(response.status, item.name).toBe(201);
      const { externalId, createdAt, ...stored } = body.comment;
      expect(stored, item.name).toEqual(item.stored); expect(typeof externalId).toBe("string"); expect(Date.parse(createdAt)).not.toBeNaN();
    }
    for (const item of fixture.post.rejected) {
      const response = await post(item.body, item.visitor), body = await response.json() as Record<string, any>;
      expect(response.status, item.name).toBe(400); expect(body.code, item.name).toBe(item.code); expect(typeof body.error).toBe("string");
    }
  });
});

describe("visitor comment contracts", () => {
  it("accepts an API base with an optional path prefix and nothing else", () => {
    for (const value of ["https://api.example.com", "https://example.com/board-api", "https://example.com/a/b.c~d", "http://127.0.0.1:8787", "http://localhost:3000/api", "https://[2001:db8::1]"]) expect(PublicApiBaseSchema.safeParse(value).success, value).toBe(true);
    for (const value of ["https://api.example.com/", "https://example.com/api/", "http://api.example.com", "https://api.example.com?x", "https://api.example.com#x", "https://u:p@api.example.com", "https://API.example.com", "https://example.com/%20", "https://example.com/a//b", "ftp://example.com", "https://example.com/" + "a/".repeat(9) + "a"]) expect(PublicApiBaseSchema.safeParse(value).success, value).toBe(false);
  });
  it("flags loopback, private, link-local, ULA and internal-suffix hosts for a public page", () => {
    for (const value of ["http://127.0.0.1:8787", "http://localhost:3000", "http://[::1]:9000", "https://10.1.2.3", "https://172.20.0.1", "https://192.168.1.10", "https://169.254.0.9", "https://[fd12:3456::1]", "https://[fe80::1]", "https://api.corp", "https://board.example.internal", "https://x.local", "https://x.lan", "https://x.intranet", "https://x.home.arpa"]) expect(internalApiHost(value), value).not.toBeNull();
    for (const value of ["https://api.example.com", "https://172.32.0.1", "https://8.8.8.8", "https://[2001:db8::1]", "https://internal.example.com"]) expect(internalApiHost(value), value).toBeNull();
  });
  it("explains every probe outcome and refuses anything but this app's thread runtime", () => {
    const base: CommentsProbeResult = { reachable: true, httpStatus: 200, appId: "demo", appKey: "0123456789abcdef", deploymentId: "dep", comments: "threads", clientIp: "socket", originProblems: [], error: null };
    expect(commentsProbeText(base)).toBe("后端可用：应用 demo · 部署 dep");
    expect(commentsProbeText({ ...base, comments: "disabled" })).toBe("后端没有开启评论：把 board-app.json 的 comments.enabled 设为 true，然后重新部署。");
    expect(commentsProbeText({ ...base, comments: "basic" })).toBe("后端版本过旧，不支持访客评论线程：在应用目录运行 paseo-board-app update-runtime，然后重新部署。");
    expect(commentsProbeText({ ...base, reachable: false, comments: "unknown", error: "5 秒内没有响应" })).toBe("连接不上这个后端：5 秒内没有响应");
    expect(commentsProbeRefusal(base, "0123456789abcdef")).toBeNull();
    expect(commentsProbeRefusal({ ...base, comments: "disabled" }, "0123456789abcdef")).toBe("评论后端检查没有通过：后端没有开启评论：把 board-app.json 的 comments.enabled 设为 true，然后重新部署。请先点「检查后端」。");
    expect(commentsProbeRefusal(base, "fedcba9876543210")).toMatch(/^评论后端检查没有通过：这个地址现在指向另一个评论后端应用.*请先点「检查后端」。$/);
    expect(commentsProbeRefusal({ ...base, appKey: null }, undefined)).toContain("后端版本过旧");
  });
  it("lets a share update keep, turn off or replace the comments block", () => {
    const base = { boardId: "work", seriesId: "series", expectedSource: { documentVersion: 1, patchCount: 0 } };
    expect(ShareUpdateSchema.parse(base).comments).toBeUndefined();
    expect(ShareUpdateSchema.parse({ ...base, comments: false }).comments).toBe(false);
    expect(ShareUpdateSchema.parse({ ...base, comments: { apiBase: "https://api.example.com", appKey: "0123456789abcdef" } }).comments).toEqual({ apiBase: "https://api.example.com", appKey: "0123456789abcdef" });
    expect(ShareUpdateSchema.safeParse({ ...base, comments: true }).success).toBe(false);
  });
});

describe("board.comments.probe", () => {
  it("reads health without an Origin, then checks each page origin's CORS", async () => {
    const backend = await fake({ allowedOrigins: ["https://ok.example.com"], owner: "demo-owner", appId: "demo" });
    const result = await probeComments({ apiBase: backend.apiBase, pageOrigins: ["https://ok.example.com", "https://missing.example.com"] });
    expect(CommentsProbeResultSchema.parse(result)).toEqual({ reachable: true, httpStatus: 200, appId: "demo", appKey: appKeyFor("demo-owner"), deploymentId: backend.deploymentId, comments: "threads", clientIp: "socket", originProblems: ["把 https://missing.example.com 加入 board-app.json 的 origins，然后重新部署。"], error: null });
    expect(backend.requests.map(request => request.headers.origin)).toEqual([undefined, "https://ok.example.com", "https://missing.example.com"]);
  });
  it("classifies disabled, basic, unknown and unreachable backends and reports proxy mode", async () => {
    const backend = await fake({ prefix: "/board-api" });
    backend.setHealth({ comments: 0 }); expect((await probeComments({ apiBase: backend.apiBase })).comments).toBe("disabled");
    backend.setHealth({ comments: undefined, appKey: undefined }); expect(await probeComments({ apiBase: backend.apiBase })).toMatchObject({ comments: "basic", appKey: null, reachable: true });
    backend.setHealth({ comments: 7, clientIp: "proxied-unconfigured" }); expect(await probeComments({ apiBase: backend.apiBase })).toMatchObject({ comments: "unknown", clientIp: "proxied-unconfigured" });
    expect(await probeComments({ apiBase: `${backend.origin}/elsewhere` })).toMatchObject({ reachable: false, httpStatus: 404, comments: "unknown", error: "健康检查返回 HTTP 404" });
    const closed = await fake(); const apiBase = closed.apiBase; await closed.close(); fakes.splice(fakes.indexOf(closed), 1);
    const unreachable = await probeComments({ apiBase });
    expect(unreachable).toMatchObject({ reachable: false, httpStatus: null, comments: "unknown" }); expect(unreachable.error).toMatch(/^无法连接/);
    // AbortSignal.timeout(5 s) rejects fetch with a TimeoutError DOMException.
    const slow = await probeComments({ apiBase: "https://api.example.com" }, async (_url, init) => { expect(init.signal).toBeInstanceOf(AbortSignal); throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
    expect(slow.error).toBe("5 秒内没有响应");
    const redirected = await probeComments({ apiBase: "https://api.example.com" }, async () => { throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); });
    expect(redirected.error).toBe("后端返回了重定向，请填写最终地址");
    const huge = await probeComments({ apiBase: "https://api.example.com" }, async () => new Response("x".repeat(70_000), { status: 200 }));
    expect(huge).toMatchObject({ reachable: false, error: "返回的不是 paseo-board-app 后端的健康检查" });
  });
});

async function publication(fetcher?: (url: string, init: RequestInit) => Promise<Response>) {
  const root = await mkdtemp(join(tmpdir(), "board-comments-rpc-")); directories.push(root);
  const store = new BoardStore(join(root, "boards"));
  await store.create({ id: "work", title: "Work", ownerAgentId: "owner", html: "<p id='result'>首先，第二步的意思</p>", data: {} });
  const releases = new ReleaseRepository(join(root, "releases")), handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const pages: PagesGateway = {
    accounts: vi.fn(async () => []), repositories: vi.fn(async () => []), prepare: vi.fn(), publish: vi.fn(), merge: vi.fn(), refresh: vi.fn(),
    list: vi.fn(async () => []), read: vi.fn(async () => { throw new Error("Missing job"); }),
  } as unknown as PagesGateway;
  registerPublicationRpc({ handle(contract: { name: string }, handler: (input: unknown) => Promise<unknown>) { handlers.set(contract.name, handler); } } as PluginServerContext,
    { ready: async () => {}, requireBoard: async id => { const board = await store.read(id); if (!board) throw new Error("Missing"); return board; }, releases, pages, ...(fetcher ? { commentsFetcher: fetcher } : {}) });
  const invoke = (name: string, input: unknown) => handlers.get(name)!(input);
  const create = (extra: Record<string, unknown> = {}) => invoke("board.release.create", { boardId: "work", expectedCanvasBase: { revision: 1, documentVersion: 1 }, publicData: {}, ...extra }) as Promise<ReleaseManifest>;
  return { store, releases, pages, invoke, create };
}

describe("release creation with visitor comments", () => {
  it("requires a passing check of exactly the app the human checked", async () => {
    const backend = await fake({ owner: "owner-a" }), f = await publication(), appKey = appKeyFor("owner-a");
    const manifest = await f.create({ comments: { apiBase: backend.apiBase, appKey } });
    expect(manifest.comments).toEqual({ apiBase: backend.apiBase, appKey }); expect(manifest.viewerVersion).toBe(4);
    await expect(f.create({ comments: { apiBase: backend.apiBase, appKey: appKeyFor("owner-b") } })).rejects.toThrow(/^评论后端检查没有通过：这个地址现在指向另一个评论后端应用/);
    backend.setHealth({ comments: 0 });
    await expect(f.create({ comments: { apiBase: backend.apiBase, appKey } })).rejects.toThrow("评论后端检查没有通过：后端没有开启评论");
    backend.setHealth({ comments: undefined });
    await expect(f.create({ comments: { apiBase: backend.apiBase, appKey } })).rejects.toThrow("评论后端检查没有通过：后端版本过旧");
    expect((await f.releases.list()).length).toBe(1);
    // Releases without comments never contact anything.
    const before = backend.requests.length; await f.create({ title: "No comments" }); expect(backend.requests.length).toBe(before);
  });
  it("probes through the registered handler with page origins", async () => {
    const backend = await fake({ allowedOrigins: ["https://pages.example.com"] }), f = await publication();
    const result = await f.invoke("board.comments.probe", { apiBase: backend.apiBase, pageOrigins: ["https://pages.example.com"] }) as CommentsProbeResult;
    expect(result).toMatchObject({ comments: "threads", originProblems: [] });
  });
  it("share updates inherit, replace or turn off the stored comments block", async () => {
    const a = await fake({ owner: "owner-a" }), b = await fake({ owner: "owner-b" }), f = await publication();
    const commentsA = { apiBase: a.apiBase, appKey: appKeyFor("owner-a") }, commentsB = { apiBase: b.apiBase, appKey: appKeyFor("owner-b") };
    const original = await f.create({ title: "Shared", comments: commentsA }), key = "s" + "a".repeat(20);
    vi.mocked(f.pages.list).mockResolvedValue([{ eventId: "e", releaseId: original.releaseId, artifactHash: original.artifactHash, account: "fixture", repository: "fixture/site", jobId: "job", branch: "b", status: "live", mergedSha: "c".repeat(40), shareKey: key, createdAt: "2026-11-13T00:00:00.000Z" }]);
    const [share] = ((await f.invoke("board.release.share-status", { boardId: "work" })) as ShareStatus).shares;
    expect(share.settings?.comments).toEqual(commentsA);
    const update = (comments?: unknown) => f.invoke("board.release.share-update", { boardId: "work", seriesId: share.seriesId, expectedSource: { documentVersion: 1, patchCount: 0 }, ...(comments === undefined ? {} : { comments }) }) as Promise<ShareUpdateResult>;
    expect(await update()).toEqual({ upToDate: true });
    const replaced = await update(commentsB); if (!("manifest" in replaced)) throw new Error("Expected a rebuild");
    expect(replaced.manifest.comments).toEqual(commentsB); expect((await f.releases.meta(replaced.manifest.releaseId))?.settings.comments).toEqual(commentsB);
    const off = await update(false); if (!("manifest" in off)) throw new Error("Expected a rebuild");
    expect(off.manifest).not.toHaveProperty("comments"); expect(off.manifest.viewerVersion).toBe(2);
    expect((await f.releases.meta(off.manifest.releaseId))?.settings).not.toHaveProperty("comments");
    b.setHealth({ comments: 0 });
    await expect(update(commentsB)).rejects.toThrow("评论后端检查没有通过");
  });
});

describe("release CLI --comments-api", () => {
  it("fills the app key from the checked backend and refuses a backend without threads", async () => {
    const backend = await fake({ owner: "cli-owner" }), root = await mkdtemp(join(tmpdir(), "board-comments-cli-")); directories.push(root);
    const store = new BoardStore(join(root, "boards")), board = await store.create({ id: "cli", title: "CLI", ownerAgentId: "owner", html: "<p>CLI text</p>", data: {} });
    await writeFile(join(root, "board.json"), JSON.stringify({ board })); await writeFile(join(root, "data.json"), "{}");
    const output: string[] = [], write = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
    try {
      await releaseMain(["export", "--board", join(root, "board.json"), "--public-data", join(root, "data.json"), "--out", join(root, "out"), "--comments-api", backend.apiBase]);
      const result = JSON.parse(output.join(""));
      expect(result.manifest.comments).toEqual({ apiBase: backend.apiBase, appKey: appKeyFor("cli-owner") }); expect(result.manifest.viewerVersion).toBe(4);
      expect(await readFile(join(root, "out", "index.html"), "utf8")).toContain(`connect-src ${backend.origin};`);
      backend.setHealth({ comments: 0 });
      await expect(releaseMain(["export", "--board", join(root, "board.json"), "--public-data", join(root, "data.json"), "--out", join(root, "out2"), "--comments-api", backend.apiBase])).rejects.toThrow("评论后端检查没有通过");
      await expect(releaseMain(["export", "--board", join(root, "board.json"), "--public-data", join(root, "data.json"), "--out", join(root, "out3"), "--comments-api", backend.apiBase + "/"])).rejects.toThrow();
      output.length = 0; await releaseMain(["--help"]); expect(output.join("")).toContain("--comments-api <api-base>");
    } finally { write.mockRestore(); }
  });
});
