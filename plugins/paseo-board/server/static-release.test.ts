import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { BoardStore } from "./store";
import { buildRelease, ReleaseRepository, releaseZip, serveRelease, validateRelease } from "./static-release";
import type { Board } from "../shared/contracts";
import { ReleaseManifestSchema } from "../shared/release-contracts";

describe("fixed public releases", () => {
  let root: string, board: Board;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "board-release-test-")); board = await new BoardStore(join(root, "boards")).create({ id: "private-board-id", title: "Public fixture", ownerAgentId: "private-agent", html: '<main><p id="replace">DELETED_PRIVATE_TEXT</p><button onclick="this.textContent=board.getData().label">Go</button></main>', data: { secret: "PRIVATE_DATA" } }); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const options = () => ({ board, boardId: board.id, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, publicData: { label: "Public" } });

  it("exports materialized final source with explicit data and no private Board/history/state fields", () => {
    board.canvas.patches.push({ id: "private-patch", selector: "#replace", operation: "replace", html: '<p id="replace">PUBLIC_FINAL</p>' });
    board.userState = { secret: "PRIVATE_STATE" }; board.events.push({ id: "private-event", source: "private-agent", kind: "private", summary: "PRIVATE_DISCUSSION", at: "now", revision: 1 });
    const release = buildRelease(options()), publicFiles = JSON.stringify(release.files);
    for (const privateValue of ["private-board-id", "private-agent", "DELETED_PRIVATE_TEXT", "PRIVATE_DATA", "PRIVATE_STATE", "PRIVATE_DISCUSSION", "private-patch"]) expect(publicFiles).not.toContain(privateValue);
    expect(publicFiles).toContain("PUBLIC_FINAL"); expect(publicFiles).toContain("Public");
    expect(release.provenance.boardId).toBe(board.id); expect(release.files["index.html"]).toContain('sandbox="allow-scripts allow-forms"');
  });
  it("produces identical release IDs, files and ZIP bytes for equal JSON with different key order", () => {
    const first = buildRelease({ ...options(), publicData: { a: 1, b: { c: 3, d: 4 } } });
    const second = buildRelease({ ...options(), publicData: { b: { d: 4, c: 3 }, a: 1 } });
    expect(second).toEqual(first); expect(releaseZip(second.files)).toEqual(releaseZip(first.files));
  });
  it("rejects stale or wrong source snapshots and incomplete patch replay", () => {
    expect(() => buildRelease({ ...options(), expectedCanvasBase: { revision: 123, documentVersion: 1 } })).toThrow("Canvas changed");
    expect(() => buildRelease({ ...options(), boardId: "other" })).toThrow("does not match");
    board.canvas.patches.push({ id: "invalid", selector: "#absent", operation: "remove", html: "" });
    expect(() => buildRelease(options())).toThrow("Cannot export current authored source");
  });
  it("refuses managed Board embeds after authored replay rather than exporting empty child content", async () => {
    const repository = new ReleaseRepository(join(root, "releases"));
    for (const html of ['<paseo-board board-id="child"></paseo-board>', '<paseo-board host-id="other-host" board-id="child" view="preview"></paseo-board>']) {
      board.canvas.html = html;
      await expect(repository.create(options())).rejects.toThrow("独立导出源 Board");
    }
    expect(await repository.list(board.id)).toEqual([]);
    board.canvas.html = '<main id="target">Parent</main>';
    board.canvas.patches = [{ id: "embed", selector: "#target", operation: "append", html: '<paseo-board id="child-slot" board-id="child"></paseo-board>' }];
    expect(() => buildRelease(options())).toThrow("无法固定这些来源画板的内容");
    board.canvas.patches.push({ id: "remove-embed", selector: "#child-slot", operation: "remove", html: "" });
    expect(() => buildRelease(options())).not.toThrow();
  });
  it("keeps ordinary iframe and textual or invalid managed-element examples outside the embed refusal", () => {
    board.canvas.html = '<iframe srcdoc="&lt;p&gt;Ordinary frame&lt;/p&gt;"></iframe><pre>&lt;paseo-board board-id="child"&gt;&lt;/paseo-board&gt;</pre><!-- <paseo-board board-id="child"></paseo-board> --><script>const example = \'<paseo-board board-id="child"></paseo-board>\';</script><paseo-board></paseo-board><paseo-board board-id="bad/id"></paseo-board>';
    expect(() => buildRelease(options())).not.toThrow();
  });
  it("requires actual finite bounded JSON rather than silently dropping private or unsupported values", () => {
    expect(() => buildRelease({ ...options(), publicData: { bad: undefined } })).toThrow("finite JSON");
    expect(() => buildRelease({ ...options(), publicData: { bad: Infinity } })).toThrow("finite JSON");
    expect(() => buildRelease({ ...options(), publicData: { bad: "x".repeat(3_000_000) } })).toThrow();
  });
  it("escapes author HTML/data/title from the parent bootstrap and warns about disabled agent actions", () => {
    board.canvas.html = '<script>board.ask({text:"Question"})</script><p>Authored</p>';
    const release = buildRelease({ ...options(), title: '</title><script>parentSecret()</script>', publicData: { text: '</script><script>parentSecret()</script>' } });
    expect(release.files["index.html"]).not.toContain('<script>parentSecret()');
    expect(release.manifest.warnings.some(warning => warning.includes("请求 agent"))).toBe(true);
  });
  it("reports network dependencies, rejects offline CDN and unpackaged local resources", () => {
    board.canvas.html = '<script src="https://cdn.jsdelivr.net/npm/example@1/index.js"></script>';
    expect(() => buildRelease(options())).toThrow("CDN");
    const release = buildRelease({ ...options(), network: "cdn" }); expect(release.manifest.dependencies).toContain("https://cdn.jsdelivr.net/npm/example@1/index.js");
    board.canvas.html = '<img src="private.png">'; expect(() => buildRelease(options())).toThrow("unpackaged");
    board.canvas.html = '<img src="https://private.example/image">'; expect(() => buildRelease({ ...options(), network: "cdn" })).toThrow("outside");
    board.canvas.html = '<a href="https://example.com">Link</a><img src="data:image/png;base64,YQ==">'; expect(() => buildRelease(options())).not.toThrow();
  });
  it("freezes explicit API origins without granting the authored iframe network or loading privileges", () => {
    const base = buildRelease(options()), allowed = buildRelease({ ...options(), apiOrigins: ["https://api.example.internal", "http://127.0.0.1:8787"] });
    expect(allowed.manifest.apiOrigins).toEqual(["https://api.example.internal", "http://127.0.0.1:8787"]);
    expect(allowed.manifest.releaseId).not.toBe(base.manifest.releaseId);
    expect(allowed.files["index.html"]).toContain("connect-src https://api.example.internal http://127.0.0.1:8787");
    expect(allowed.files["index.html"]).toContain("connect-src 'none'");
    expect(allowed.files["index.html"]).not.toContain("allow-same-origin");
    for (const origin of ["https://api.example/a", "https://user:pass@api.example", "http://internal.example", "https://*.example", "https://api.example#hash", "null"]) {
      expect(() => buildRelease({ ...options(), apiOrigins: [origin] }), origin).toThrow();
    }
    expect(() => buildRelease({ ...options(), apiOrigins: ["https://api.example", "https://api.example"] })).toThrow();
    board.canvas.html = '<script src="https://api.example/runtime.js"></script>';
    expect(() => buildRelease({ ...options(), apiOrigins: ["https://api.example"] })).toThrow("outside");
    const { apiOrigins: _, ...oldManifest } = base.manifest;
    expect(ReleaseManifestSchema.parse(oldManifest)).toEqual(oldManifest);
  });
  it("writes immutable snapshots, exports real deterministic ZIPs and never overwrites a destination", async () => {
    const repository = new ReleaseRepository(join(root, "releases")), first = await repository.create(options());
    board.canvas.html = '<p>Later changed</p>';
    expect((await repository.read(first.manifest.releaseId)).files).toEqual(first.files);
    const second = await repository.create(options()); expect(second.manifest.releaseId).not.toBe(first.manifest.releaseId);
    expect(await repository.list(board.id)).toHaveLength(2); expect(await repository.list("other")).toHaveLength(0);
    const directory = join(root, "export"), zipPath = join(root, "export.zip"); await repository.export(first.manifest.releaseId, { directory, zipPath });
    expect(await readFile(join(directory, "release.json"), "utf8")).toBe(first.files["release.json"]);
    expect(execFileSync("unzip", ["-p", zipPath, "index.html"], { encoding: "utf8" })).toBe(first.files["index.html"]);
    expect(execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" })).toContain("No errors detected");
    await expect(repository.export(first.manifest.releaseId, { directory })).rejects.toThrow();
    await expect(repository.export(first.manifest.releaseId, { zipPath })).rejects.toThrow();
  });
  it("keeps identical content from different private Boards independently authorized", async () => {
    const repository = new ReleaseRepository(join(root, "releases"));
    const first = await repository.create(options()); board.id = "other-private-board";
    const second = await repository.create(options()); expect(first.manifest.releaseId).not.toBe(second.manifest.releaseId);
    expect((await repository.list(board.id)).map(release => release.provenance.boardId)).toEqual([board.id]);
  });
  it("detects tampered public files and manifests before preview or download", async () => {
    const repository = new ReleaseRepository(join(root, "releases")), release = await repository.create(options());
    release.files["index.html"] += "tampered"; expect(() => validateRelease(release)).toThrow("hash");
    await writeFile(join(root, "releases", release.manifest.releaseId + ".json"), JSON.stringify(release));
    await expect(repository.preview(release.manifest.releaseId)).rejects.toThrow("hash");
    await expect(repository.download("../../private")).rejects.toThrow();
  });
  it("returns deterministic private settings and extended provenance without changing public files", () => {
    board.canvas.patches.push({ id: "private-patch", selector: "#replace", operation: "replace", html: '<p id="replace">PUBLIC_FINAL</p>' });
    const first = buildRelease({ ...options(), publicData: { a: 1, b: { c: 3, d: 4 } }, theme: "dark", apiOrigins: ["https://api.example.com"] });
    const second = buildRelease({ ...options(), publicData: { b: { d: 4, c: 3 }, a: 1 }, theme: "dark", apiOrigins: ["https://api.example.com"] });
    expect(first.settings).toEqual({ title: "Public fixture", network: "offline", theme: "dark", apiOrigins: ["https://api.example.com"], publicData: { a: 1, b: { c: 3, d: 4 } } });
    expect(JSON.stringify(second.settings)).toBe(JSON.stringify(first.settings));
    expect(first.provenance).toEqual({ boardId: board.id, boardRevision: board.revision, canvasBase: { revision: 1, documentVersion: 1 }, boardCreatedAt: board.createdAt, patchCount: 1 });
    expect(JSON.stringify(first.files)).not.toContain(board.createdAt);
  });
  it("writes the settings sidecar once, also for a pre-existing release file, and keeps it out of listings", async () => {
    const releases = join(root, "releases"), repository = new ReleaseRepository(releases), built = buildRelease(options()), id = built.manifest.releaseId;
    // A release stored by older code: no settings and no extended provenance.
    const legacy = JSON.stringify({ manifest: built.manifest, files: built.files, provenance: { boardId: board.id, boardRevision: board.revision, canvasBase: built.provenance.canvasBase } });
    await mkdir(releases, { recursive: true }); await writeFile(join(releases, `${id}.json`), legacy);
    expect(await repository.meta(id)).toBeUndefined();
    const created = await repository.create(options());
    expect(created.manifest.releaseId).toBe(id); expect(await readFile(join(releases, `${id}.json`), "utf8")).toBe(legacy);
    const meta = await repository.meta(id), sidecar = await readFile(join(releases, `${id}.settings.json`), "utf8");
    expect(meta).toMatchObject({ formatVersion: 1, releaseId: id, settings: built.settings, source: { boardId: board.id, boardCreatedAt: board.createdAt, canvasBase: { revision: 1, documentVersion: 1 }, documentVersion: 1, patchCount: 0 } });
    expect(Date.parse(meta!.createdAt)).not.toBeNaN();
    await new Promise(resolve => setTimeout(resolve, 5));
    await repository.create(options());
    expect(await readFile(join(releases, `${id}.settings.json`), "utf8")).toBe(sidecar);
    const fresh = await repository.create({ ...options(), title: "Second" });
    expect(JSON.parse(await readFile(join(releases, `${fresh.manifest.releaseId}.json`), "utf8"))).not.toHaveProperty("settings");
    expect((await repository.meta(fresh.manifest.releaseId))?.settings.title).toBe("Second");
    expect((await repository.list(board.id)).map(release => release.manifest.releaseId).sort()).toEqual([id, fresh.manifest.releaseId].sort());
    expect((await readdir(releases)).filter(name => name.endsWith(".settings.json"))).toHaveLength(2);
  });
  it("treats a missing, corrupt or mismatched settings sidecar as absent", async () => {
    const releases = join(root, "releases"), repository = new ReleaseRepository(releases), release = await repository.create(options()), id = release.manifest.releaseId;
    const file = join(releases, `${id}.settings.json`), valid = JSON.parse(await readFile(file, "utf8"));
    expect(await repository.meta("../../private")).toBeUndefined();
    expect(await repository.meta("release-" + "0".repeat(64))).toBeUndefined();
    await writeFile(file, "{not json"); expect(await repository.meta(id)).toBeUndefined();
    await writeFile(file, JSON.stringify({ ...valid, releaseId: "release-" + "1".repeat(64) })); expect(await repository.meta(id)).toBeUndefined();
    await writeFile(file, JSON.stringify({ ...valid, settings: { ...valid.settings, theme: "neon" } })); expect(await repository.meta(id)).toBeUndefined();
    expect(await repository.list(board.id)).toHaveLength(1);
  });
  it("serves only frozen public files on loopback with correct content types", async () => {
    const release = buildRelease(options()), server = await serveRelease(release);
    try {
      const response = await fetch(server.url); expect(await response.text()).toBe(release.files["index.html"]); expect(response.headers.get("content-type")).toContain("text/html");
      expect((await fetch(server.url + "release.json")).status).toBe(200);
      expect((await fetch(server.url + "private.json")).status).toBe(404);
      expect((await fetch(server.url, { method: "POST" })).status).toBe(404);
    } finally { await server.close(); }
  });
  const LIVE = { origin: "https://live.example.com", channelId: `c${"a".repeat(32)}`, paths: ["/live/a", "/live/b"] };
  it("keeps a non-live release byte-identical to the pre-live build for a fixed input", async () => {
    const pinned = await new BoardStore(join(root, "pin")).create({ id: "pin-board", title: "Pin fixture", ownerAgentId: "pin-agent", html: '<main><p id="pin">Pinned text</p></main>', data: { secret: "PRIVATE" } });
    const release = buildRelease({ board: pinned, boardId: pinned.id, expectedCanvasBase: { revision: pinned.canvas.revision, documentVersion: pinned.canvas.documentVersion }, publicData: { label: "Pin" }, apiOrigins: ["https://api.example.com"] });
    expect(release.manifest.releaseId).toBe("release-d01ce6b6691a4f9371b158fbcef51a068a9abca9064e91fdb69b81af9cad6338");
    expect(release.manifest.artifactHash).toBe("73dd283fec53173f58770a745d84fef7be28b0318f0d75588ea9d4c09819f83b");
    expect(createHash("sha256").update(release.files["index.html"]).digest("hex")).toBe("0810b73f0e55ad42e8d526b1da7810cd3ea48b270d15d3447abe29f1c16799a3");
    expect(release.manifest.viewerVersion).toBe(2);
    expect(release.manifest).not.toHaveProperty("live"); expect(release.settings).not.toHaveProperty("live");
    for (const marker of ["data-live", "live-ready", "paseo-board-live:"]) expect(release.files["index.html"]).not.toContain(marker);
  });
  it("embeds a frozen live block, uses the live viewer and changes the release identity", () => {
    const base = buildRelease(options()), release = buildRelease({ ...options(), apiOrigins: [LIVE.origin], live: LIVE });
    expect(release.manifest.viewerVersion).toBe(3); expect(release.manifest.live).toEqual(LIVE);
    expect(release.manifest.releaseId).not.toBe(base.manifest.releaseId);
    expect(release.files["index.html"]).toContain("connect-src https://live.example.com");
    expect(release.files["index.html"]).toContain('<aside data-live role="status" aria-live="polite" hidden></aside>');
    expect(release.files["index.html"]).toContain("live-ready");
    expect(release.settings?.live).toEqual(LIVE);
    expect(release.manifest.warnings.some(warning => warning.includes("实时公开数据") && warning.includes("/live/a"))).toBe(true);
    expect(validateRelease(release)).toBe(release);
    const other = buildRelease({ ...options(), apiOrigins: [LIVE.origin], live: { ...LIVE, paths: ["/live/a"] } });
    expect(other.manifest.releaseId).not.toBe(release.manifest.releaseId);
  });
  it("keeps the private origin bookkeeping out of every public file", () => {
    const release = buildRelease({ ...options(), apiOrigins: [LIVE.origin], live: LIVE, liveOriginAdded: true });
    expect(release.settings?.liveOriginAdded).toBe(true);
    expect(JSON.stringify(release.files)).not.toContain("liveOriginAdded");
    expect(release.manifest).not.toHaveProperty("liveOriginAdded");
    const same = buildRelease({ ...options(), apiOrigins: [LIVE.origin], live: LIVE });
    expect(same.manifest.releaseId).toBe(release.manifest.releaseId);
  });
  it("requires the live origin in apiOrigins and refuses a path through a frozen non-object", () => {
    expect(() => buildRelease({ ...options(), apiOrigins: [], live: LIVE })).toThrow("apiOrigins");
    expect(() => buildRelease({ ...options(), publicData: { live: "text" }, apiOrigins: [LIVE.origin], live: LIVE })).toThrow("不是对象");
    expect(() => buildRelease({ ...options(), publicData: { live: [1] }, apiOrigins: [LIVE.origin], live: LIVE })).toThrow("不是对象");
    expect(() => buildRelease({ ...options(), publicData: { live: { a: "frozen" } }, apiOrigins: [LIVE.origin], live: LIVE })).not.toThrow();
    expect(() => buildRelease({ ...options(), publicData: {}, apiOrigins: [LIVE.origin], live: { ...LIVE, paths: ["/missing/deep/x"] } })).not.toThrow();
    expect(() => buildRelease({ ...options(), publicData: { a: { b: 1 } }, apiOrigins: [LIVE.origin], live: { ...LIVE, paths: ["/a/b/c"] } })).toThrow("不是对象");
  });
  it("carries the live block through the settings sidecar and parses old sidecars", async () => {
    const releases = join(root, "releases"), repository = new ReleaseRepository(releases), release = await repository.create({ ...options(), apiOrigins: [LIVE.origin], live: LIVE });
    expect((await repository.meta(release.manifest.releaseId))?.settings.live).toEqual(LIVE);
    expect((await repository.read(release.manifest.releaseId)).manifest.live).toEqual(LIVE);
    const legacy = await repository.create(options()), file = join(releases, `${legacy.manifest.releaseId}.settings.json`), stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored.settings).not.toHaveProperty("live");
    expect((await repository.meta(legacy.manifest.releaseId))?.settings).not.toHaveProperty("live");
  });
  it("executes the actual repository CLI to export a public directory and readable ZIP", async () => {
    const boardFile = join(root, "private-board.json"), dataFile = join(root, "public-data.json"), directory = join(root, "cli-public"), zip = join(root, "cli-public.zip");
    await writeFile(boardFile, JSON.stringify({ board })); await writeFile(dataFile, JSON.stringify({ label: "CLI public" }));
    const stdout = execFileSync(process.execPath, ["scripts/board-release.mjs", "export", "--board", boardFile, "--public-data", dataFile, "--out", directory, "--zip", zip], { cwd: process.cwd(), encoding: "utf8" });
    const result = JSON.parse(stdout); expect(result.status).toBe("exported");
    const html = await readFile(join(directory, "index.html"), "utf8"); expect(html).toContain("CLI public"); expect(html).not.toContain("PRIVATE_DATA"); expect(html).not.toContain(board.id);
    expect(execFileSync("unzip", ["-p", zip, "index.html"], { encoding: "utf8" })).toBe(html);
  });
});
