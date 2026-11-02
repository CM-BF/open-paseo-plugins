import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, link, unlink, lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { DOMParser } from "linkedom";
import type { Board, CanvasBase } from "../shared/contracts";
import { ReleaseCreateSchema, ReleaseIdSchema, ReleaseManifestSchema, type ReleaseCreateInput, type ReleaseManifest } from "../shared/release-contracts";
import { STATIC_VIEWER_RUNTIME, STATIC_VIEWER_SHELL, STATIC_VIEWER_VERSION } from "../shared/static-viewer";
import { DEFAULT_DARK_COLORS, DEFAULT_LIGHT_COLORS, frameThemeFromColors } from "../shared/frame-theme";
import stylesheet from "../shared/assets/visualize.css.txt";
import icons from "../shared/assets/runtime-icons.txt";
import tooltips from "../shared/assets/runtime-tooltips.txt";
import license from "./assets/publication-license.txt";
import { describeAuthoring } from "./authored-source";
import { assertJson, canonicalJson, ensureDirectory } from "./store-format";

const MAX_RELEASE_BYTES = 8 * 1024 * 1024;
const CDNS = ["https://unpkg.com", "https://cdn.jsdelivr.net", "https://esm.sh", "https://cdnjs.cloudflare.com"];
const NOTICE = "Paseo Board public viewer\nCopyright 2026 Shurui Gui\n\nThe default stylesheet and optional icon/tooltip helpers are derived from OpenAI Codex rust-v0.146.0, Copyright 2025 OpenAI, under Apache-2.0; see LICENSE-APACHE-2.0.\nOptional helpers load lucide (ISC) and Floating UI (MIT) from unpkg.com. Those third-party packages are not included in this archive.\nAuthored page content retains its original authors' rights.\n";
export type StaticRelease = {
  manifest: ReleaseManifest;
  files: Record<string, string>;
  provenance: { boardId: string; boardRevision: number; canvasBase: CanvasBase };
};
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const scriptJson = (value: unknown) => canonicalJson(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fileInventory = (files: Record<string, string>) => Object.keys(files).sort().map(path => ({ path, sha256: sha256(files[path]), bytes: Buffer.byteLength(files[path]) }));

function dependenciesFor(html: string): { dependencies: string[]; resources: string[] } {
  const document = new DOMParser().parseFromString(`<html><head></head><body>${html}</body></html>`, "text/html");
  const resources = new Set<string>();
  for (const node of document.querySelectorAll("[src],[href],[poster],[srcset]")) {
    if (node.localName === "a" || node.localName === "base") continue;
    for (const attribute of ["src", "href", "poster"]) { const value = node.getAttribute(attribute)?.trim(); if (value) resources.add(value); }
    const srcset = node.getAttribute("srcset");
    if (srcset) {
      // A data URL may contain commas; checking it as one value is sufficient.
      if (srcset.startsWith("data:")) resources.add(srcset);
      else for (const entry of srcset.split(",")) resources.add(entry.trim().split(/\s+/)[0]);
    }
  }
  for (const match of html.matchAll(/(?:url\(\s*["']?|@import\s+["'])([^\s"')<>]+)/gi)) resources.add(match[1]);
  // Script-computed URLs cannot all be enumerated. CSP is the enforcement boundary.
  const dependencies = new Set([...resources].filter(url => /^(?:https?:)?\/\//i.test(url)));
  for (const match of html.matchAll(/https?:\/\/[^\s"'`<>\\)]+/g)) dependencies.add(match[0]);
  return { resources: [...resources].sort(), dependencies: [...dependencies].sort() };
}

/** Builds only final authored content + the caller's explicit public data; never serializes Board. */
export function buildRelease(input: ReleaseCreateInput & { board: Board }): StaticRelease {
  const options = ReleaseCreateSchema.parse(input), { board } = input;
  if (options.boardId !== board.id) throw new Error("Release source Board does not match the requested Board");
  if (options.expectedCanvasBase.revision !== board.canvas.revision || options.expectedCanvasBase.documentVersion !== board.canvas.documentVersion) throw new Error("Canvas changed; review the current Board before preparing a new release");
  assertJson(options.publicData, "Public release data");
  const authored = describeAuthoring(board.canvas);
  if (!authored.replay.complete || authored.materializedAuthoredHtml === null) throw new Error(`Cannot export current authored source: ${authored.replay.failedPatch?.reason ?? authored.note}`);
  let html = authored.materializedAuthoredHtml;
  const helpers = `${/data-tooltip|dataset\.tooltip|floatingui/i.test(html) ? tooltips : ""}${/lucide/i.test(html) ? icons : ""}`;
  const resources = dependenciesFor(html + helpers);
  const missing = resources.resources.filter(url => !url.startsWith("#") && !url.startsWith("data:") && !/^https:\/\//.test(url));
  if (missing.length) throw new Error(`Release contains unpackaged local/unsupported resources: ${missing.slice(0, 5).join(", ")}. Embed them as data URLs or use an approved CDN.`);
  const unapproved = resources.resources.filter(url => /^https:\/\//.test(url) && !CDNS.includes(new URL(url).origin));
  if (unapproved.length) throw new Error(`Release resources are outside the supported CDN policy: ${unapproved.slice(0, 5).join(", ")}`);
  if (options.network === "offline" && resources.dependencies.some(url => CDNS.some(origin => url.startsWith(origin + "/")))) throw new Error("This page uses external CDN dependencies. Choose CDN mode or embed those resources before offline export.");
  if (options.network === "offline" && resources.resources.some(url => /^https:/.test(url))) throw new Error("Offline export cannot include remote resources");
  const theme = frameThemeFromColors(options.theme === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS);
  const tokens = Object.entries(theme.tokens).map(([key, value]) => `--${key}:${value}`).join(";");
  const network = options.network === "cdn" ? CDNS.join(" ") : "";
  const csp = ["default-src 'none'", `script-src 'unsafe-inline' 'unsafe-eval' blob: ${network}`, `style-src 'unsafe-inline' ${network}`, `font-src data: ${network}`, `img-src data: blob: ${network}`, "media-src data: blob:", `connect-src ${network || "'none'"}`, "worker-src blob:", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "object-src 'none'"].join("; ");
  // srcdoc does not require network-frame permission. Excluding 'self' also
  // prevents authored location changes from issuing same-site HTTP requests.
  const outerCsp = csp.replace("frame-src 'none'", "frame-src blob:");
  const title = options.title ?? board.title;
  const metadata = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>@layer paseo-board-defaults {${stylesheet}\n}</style>`;
  let prefix = `<!doctype html><html lang="en" data-surface="page" data-palette="custom" data-theme="${theme.scheme}" style="${escapeHtml(tokens)}"><head>${metadata}</head><body>`;
  const parsed = new DOMParser().parseFromString(html, "text/html"), authoredRoot = parsed.querySelector("html");
  if (authoredRoot) {
    type Element = NonNullable<ReturnType<typeof parsed.querySelector>>;
    const attributes = (element: Element | null) => element ? (Array.from(element.attributes) as Array<{ name: string; value: string }>).map(({ name, value }) => [name, value] as const) : [];
    const serialize = (entries: Iterable<readonly [string, string]>) => [...entries].map(([name, value]) => ` ${escapeHtml(name)}="${escapeHtml(value)}"`).join("");
    const rootAttributes = new Map<string, string>([["lang", "en"], ["data-surface", "page"], ["data-palette", "custom"], ["data-theme", theme.scheme], ["style", tokens]]);
    for (const [name, value] of attributes(authoredRoot)) rootAttributes.set(name, name === "style" ? `${tokens};${value}` : value);
    const head = parsed.querySelector("head"), body = parsed.querySelector("body");
    // Bootstrap precedes author head scripts; a second <html> must not discard author root attributes.
    prefix = `<!doctype html><html${serialize(rootAttributes)}><head${serialize(attributes(head))}>${metadata}`;
    html = `${head?.innerHTML ?? ""}</head><body${serialize(attributes(body))}>${body?.innerHTML ?? authoredRoot.innerHTML.replace(head?.outerHTML ?? "\u0000", "")}`;
  }
  const suffix = `${helpers}</body></html>`;
  const warnings = ["发布页从最终源码重新打开；不会带出当前浏览器临时生成的内容、运行进度或历史脚本执行状态。", "只带出这里选定的网页和公共数据；上传前请检查其中是否还有不想公开的内容。", "动态生成的资源地址不一定能完整列出；超出所选联网范围的请求会被浏览器阻止。"];
  if (/\b(?:board\s*\.\s*ask|sendFollowUpMessage)\s*\(/.test(html)) warnings.push("网页里有请求 agent 的按钮或代码；发布版不会联系 agent，该请求会立即取消。");
  if (resources.dependencies.length) warnings.push("源码含外部地址；CDN 资源需要联网，其他地址可能是普通链接或会被阻止的请求。");
  const content = { viewerVersion: STATIC_VIEWER_VERSION, title, network: options.network, data: options.publicData, html, prefix, suffix, runtime: STATIC_VIEWER_RUNTIME, shell: STATIC_VIEWER_SHELL, notice: NOTICE, license };
  // The opaque digest scopes the private provenance to one source, without exposing its ID.
  const releaseId = `release-${sha256(canonicalJson({ content, source: { boardId: board.id, canvasBase: authored.canvasBase } }))}`;
  const config = { releaseId, data: options.publicData, html, prefix, suffix, runtime: STATIC_VIEWER_RUNTIME };
  const index = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(outerCsp)}"><title>${escapeHtml(title)}</title><style>html,body{margin:0;height:100%;background:${theme.tokens["host-sheet"]}}iframe{width:100%;height:100%;border:0;display:block}aside{position:fixed;left:8px;bottom:8px;max-width:calc(100% - 32px);font:13px/1.4 system-ui;padding:8px 12px;color:#fff;background:#252525;border-radius:6px}aside[hidden]{display:none}</style></head><body><iframe title="${escapeHtml(title)}" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer"></iframe><aside role="status" hidden></aside><script>(${STATIC_VIEWER_SHELL})(${scriptJson(config)});</script></body></html>`;
  const files: Record<string, string> = { "index.html": index, "NOTICE": NOTICE, "LICENSE-APACHE-2.0": license };
  const inventory = fileInventory(files), artifactHash = sha256(canonicalJson(inventory));
  const manifest = ReleaseManifestSchema.parse({ formatVersion: 1, releaseId, artifactHash, title, viewerVersion: STATIC_VIEWER_VERSION, network: options.network, dependencies: resources.dependencies, warnings, files: inventory });
  files["release.json"] = canonicalJson(manifest) + "\n";
  if (Object.values(files).reduce((sum, value) => sum + Buffer.byteLength(value), 0) > MAX_RELEASE_BYTES) throw new Error("Public release exceeds the 8 MiB export limit");
  return { manifest, files, provenance: { boardId: board.id, boardRevision: board.revision, canvasBase: authored.canvasBase } };
}

export function validateRelease(release: StaticRelease): StaticRelease {
  const manifest = ReleaseManifestSchema.parse(release.manifest);
  if (!release.files || Object.values(release.files).some(value => typeof value !== "string")) throw new Error("Invalid release files");
  const { ["release.json"]: publicManifest, ...files } = release.files;
  const inventory = fileInventory(files);
  if (canonicalJson(inventory) !== canonicalJson(manifest.files) || sha256(canonicalJson(inventory)) !== manifest.artifactHash || publicManifest !== canonicalJson(manifest) + "\n") throw new Error("Stored release does not match its frozen artifact hash");
  if (Object.keys(files).some(path => !["index.html", "NOTICE", "LICENSE-APACHE-2.0", ".nojekyll"].includes(path))) throw new Error("Unexpected public release file");
  return release;
}

/** Immutable artifact storage; source identities remain outside exported files. */
export interface ReleaseComputation {
  buildRelease(input: ReleaseCreateInput & { board: Board }): Promise<StaticRelease>;
  releaseZip(releaseId: string, files: Record<string, string>): Promise<string>;
}
export class ReleaseRepository {
  constructor(readonly root: string, private readonly computation?: ReleaseComputation) {}
  async create(input: ReleaseCreateInput & { board: Board }): Promise<StaticRelease> {
    const release = this.computation ? await this.computation.buildRelease(input) : buildRelease(input);
    await ensureDirectory(this.root);
    const file = join(this.root, `${release.manifest.releaseId}.json`), temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(release)); await handle.sync(); } finally { await handle.close(); }
      try { await link(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const directory = await open(this.root, "r"); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    return this.read(release.manifest.releaseId);
  }
  async read(id: string): Promise<StaticRelease> {
    ReleaseIdSchema.parse(id);
    const file = join(this.root, `${id}.json`), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RELEASE_BYTES * 3) throw new Error("Invalid release storage file");
    const release = validateRelease(JSON.parse(await readFile(file, "utf8")));
    if (release.manifest.releaseId !== id) throw new Error("Stored release identity changed");
    return release;
  }
  async list(boardId?: string): Promise<StaticRelease[]> {
    let names: string[];
    try { names = await readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const releases: StaticRelease[] = [];
    for (const name of names.sort()) if (/^release-[a-f0-9]{64}\.json$/.test(name)) { const release = await this.read(name.slice(0, -5)); if (!boardId || release.provenance.boardId === boardId) releases.push(release); }
    return releases;
  }
  async preview(id: string) { const { manifest, files } = await this.read(id); return { manifest, html: files["index.html"] }; }
  private zip(id: string, files: Record<string, string>): Promise<string> {
    return this.computation ? this.computation.releaseZip(id, files) : Promise.resolve(releaseZip(files).toString("base64"));
  }
  async download(id: string) { const { manifest, files } = await this.read(id); return { manifest, fileName: `${id}.zip`, zipBase64: await this.zip(id, files) }; }
  async export(id: string, options: { directory?: string; zipPath?: string }) {
    const release = await this.read(id);
    if (!options.directory && !options.zipPath) throw new Error("Choose an export directory or ZIP path");
    if (options.directory) {
      // Never overwrite an existing directory or its unrelated files.
      await mkdir(resolve(options.directory), { recursive: false, mode: 0o700 });
      for (const [name, value] of Object.entries(release.files)) await writeFile(join(options.directory, name), value, { flag: "wx", mode: 0o644 });
    }
    if (options.zipPath) await writeFile(resolve(options.zipPath), Buffer.from(await this.zip(id, release.files), "base64"), { flag: "wx", mode: 0o600 });
    return release.manifest;
  }
}

/** ZIP store mode, fixed DOS epoch, sorted paths: stable bytes without a build-time dependency. */
export function releaseZip(files: Record<string, string>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const path of Object.keys(files).sort()) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(path)) throw new Error("Invalid ZIP file name");
    const name = Buffer.from(path), data = Buffer.from(files[path]); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, data); central.push(directory, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function serveRelease(release: StaticRelease, port = 0) {
  validateRelease(release);
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0], name = path === "/" ? "index.html" : path.slice(1);
    if (!["GET", "HEAD"].includes(request.method ?? "") || !Object.hasOwn(release.files, name)) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(request.method === "HEAD" ? undefined : release.files[name]);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Preview server did not bind");
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
