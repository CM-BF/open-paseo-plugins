import { execFile } from "node:child_process";
import { readFile, readdir, rename, lstat, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { IdSchema } from "../shared/contracts";
import { GitHubHostSchema, GitHubLoginSchema, LOOPBACK_LIVE_REFUSAL, PagesJobSchema, PagesPrepareSchema, loopbackLiveRefused, type GitHubAccount, type GitHubRepository, type PagesJob, type PagesPrepareInput, type ReleaseMeta } from "../shared/release-contracts";
import { canonicalJson, ensureDirectory } from "./store-format";
import { ReleaseRepository, sha256, type StaticRelease } from "./static-release";

const DIRECTORY = "paseo-board-publication";
const WORKFLOW = ".github/workflows/paseo-board-pages.yml";
const OWNER_FILE = `${DIRECTORY}/owner.json`;
const timeoutSignal = (milliseconds: number) => AbortSignal.timeout(milliseconds) as unknown as NonNullable<Parameters<typeof fetch>[1]>["signal"];
export class GitHubApiError extends Error {
  constructor(readonly status: number, message = `GitHub request failed (${status})`) { super(message); this.name = "GitHubApiError"; }
}
export interface GitHubTransport {
  accounts(githubHost?: string): Promise<GitHubAccount[]>;
  request<T>(account: string, method: string, path: string, body?: unknown, githubHost?: string): Promise<T>;
  publicFile(url: string): Promise<string>;
}

type AccountDiscovery = { accounts: GitHubAccount[] };
const validLogin = (value: unknown): value is string => GitHubLoginSchema.safeParse(value).success;
const validHost = (value: string) => GitHubHostSchema.safeParse(value).success;

/** Project only successful identities; gh JSON can exit zero for failed or timed-out accounts. */
function parseAccountDiscovery(value: unknown): AccountDiscovery {
  if (!value || typeof value !== "object" || !("hosts" in value) || !value.hosts || typeof value.hosts !== "object" || Array.isArray(value.hosts)) throw new Error("Unsupported GitHub CLI status format");
  const accounts: GitHubAccount[] = [];
  for (const [host, entries] of Object.entries(value.hosts)) {
    if (!validHost(host) || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || entry.state !== "success" || (entry.host !== undefined && entry.host !== host) || entry.error) continue;
      if (validLogin(entry.login)) accounts.push({ login: entry.login, host: host.toLowerCase(), active: entry.active === true });
    }
  }
  return { accounts };
}

/** Older gh versions have no --json on auth status. Never return the raw credential summary. */
function parseTextAccountDiscovery(status: string): AccountDiscovery {
  const accounts: GitHubAccount[] = [], activeSpecified = new Set<GitHubAccount>();
  let current: GitHubAccount | undefined;
  for (const line of status.split("\n")) {
    const match = /Logged in to ([a-zA-Z0-9.-]+) (?:account|as) (\S+)(?:\s|$)/.exec(line);
    if (match && validHost(match[1])) {
      current = undefined;
      if (validLogin(match[2])) { current = { login: match[2], host: match[1].toLowerCase(), active: false }; accounts.push(current); }
    } else if (/Failed to log in|Timeout trying to log in/.test(line) || validHost(line.trim())) current = undefined;
    else if (current) {
      const active = /Active account:\s*(true|false)/.exec(line);
      if (active) { current.active = active[1] === "true"; activeSpecified.add(current); }
    }
  }
  if (accounts.length === 1 && !activeSpecified.has(accounts[0])) accounts[0].active = true;
  return { accounts };
}
export function parseGitHubAccounts(status: string): GitHubAccount[] {
  return parseTextAccountDiscovery(status).accounts;
}
function noGitHubAccount(githubHost?: string): Error {
  const target = githubHost ?? "<公司 GitHub 主机名或 github.com>";
  return new Error(`未找到可用的 ${githubHost ?? "GitHub"} 登录账号。请在运行此 Board 的主机上执行 gh auth login --hostname ${target}，然后重新读取账号。公司内部 GitHub 无需登录 github.com。`);
}
export function githubApiBase(githubHost = "github.com"): string {
  const host = GitHubHostSchema.parse(githubHost);
  if (host === "github.com") return "https://api.github.com";
  if (host.endsWith(".ghe.com")) return `https://api.${host}`;
  return `https://${host}/api/v3`;
}
const isEnterpriseServer = (host = "github.com") => host !== "github.com" && !host.endsWith(".ghe.com");
function pagesUrl(value: string): URL {
  if (/[\x00-\x20\x7f]/.test(value)) throw new Error("GitHub returned an unsafe Pages URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || !validHost(url.hostname) || /^[0-9.]+$/.test(url.hostname) || url.hostname === "localhost" || url.username || url.password || url.port || url.search || url.hash) throw new Error("GitHub returned an unsafe Pages URL");
  return url;
}
class GitHubCliExecutionError extends Error {}

/** Never switches the global gh account; credentials are used only inside this process. */
export class GhCliTransport implements GitHubTransport {
  private command(args: string[], statusOutput = false, timeout = 15_000): Promise<string> {
    const env = { ...process.env, GH_PROMPT_DISABLED: "1" };
    // An inherited GH_HOST also creates a synthetic account in recent gh versions.
    // Discovery must see configured hosts; token retrieval pins host and user explicitly.
    for (const key of ["GH_HOST", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete (env as Record<string, string | undefined>)[key];
    return new Promise((resolve, reject) => execFile("gh", args, { env, timeout, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      const message = "GitHub CLI authentication is unavailable. Sign in on this Board host using gh auth login --hostname <selected GitHub host>.";
      // Do not retry a missing/killed process as an older output format, or parse partial output.
      if (error && (typeof error.code !== "number" || error.killed || error.signal)) reject(new GitHubCliExecutionError(message));
      else if (error && !statusOutput) reject(new Error(message));
      else resolve(stdout + (statusOutput ? stderr : ""));
    }));
  }
  async accounts(githubHost?: string): Promise<GitHubAccount[]> {
    const host = githubHost === undefined ? undefined : GitHubHostSchema.parse(githubHost);
    const scope = host ? ["--hostname", host] : [];
    let discovery: AccountDiscovery;
    try {
      discovery = parseAccountDiscovery(JSON.parse(await this.command(["auth", "status", ...scope, "--json", "hosts"])));
    } catch (error) {
      if (error instanceof GitHubCliExecutionError) throw error;
      discovery = parseTextAccountDiscovery(await this.command(["auth", "status", ...scope], true));
    }
    const accounts = discovery.accounts.filter(account => !host || account.host === host);
    if (!accounts.length) throw noGitHubAccount(host);
    return accounts;
  }
  async request<T>(account: string, method: string, path: string, body?: unknown, githubHost = "github.com"): Promise<T> {
    const host = GitHubHostSchema.parse(githubHost);
    if (!validLogin(account) || !path.startsWith("/") || path.startsWith("//") || /[\\\x00-\x20\x7f]/.test(path)) throw new Error("Invalid GitHub request scope");
    const pathname = path.split("?")[0];
    if (pathname.split("/").some(part => { const decoded = decodeURIComponent(part); return decoded.split("/").some(segment => segment === "." || segment === "..") || /[\\\x00-\x1f\x7f]/.test(decoded); })) throw new Error("Invalid GitHub request scope");
    const base = githubApiBase(host), url = new URL(`${base}${path}`);
    if (url.hash || url.origin !== new URL(base).origin || !url.pathname.startsWith(new URL(base).pathname.replace(/\/$/, "") + "/")) throw new Error("Invalid GitHub request scope");
    const token = (await this.command(["auth", "token", "--hostname", host, "--user", account])).trim();
    if (!token) throw new Error("The selected GitHub account has no usable credential");
    const response = await fetch(url.href, { method, redirect: "error", signal: timeoutSignal(20_000), headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "paseo-board-publication" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new GitHubApiError(response.status);
    if (response.status === 204) return undefined as T;
    const text = await boundedResponse(response, 12 * 1024 * 1024);
    return JSON.parse(text) as T;
  }
  async publicFile(url: string): Promise<string> {
    // The manager obtains this URL from the selected authenticated GitHub API.
    // Never forward a GitHub token or follow a private Pages login redirect.
    const parsed = new URL(url); const scope = new URL(parsed); scope.search = ""; pagesUrl(scope.href);
    const response = await fetch(url, { redirect: "error", signal: timeoutSignal(15_000), headers: { "Cache-Control": "no-cache" } });
    if (!response.ok) throw new GitHubApiError(response.status, `Published URL returned ${response.status}`);
    return boundedResponse(response, 8 * 1024 * 1024);
  }
}

async function boundedResponse(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > limit) throw new Error("Response is too large");
  const reader = response.body?.getReader(); if (!reader) return "";
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > limit) { await reader.cancel(); throw new Error("Response is too large"); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

export function pagesWorkflow(baseBranch: string): string {
  return `# Managed by Paseo Board. Public files only; authored scripts are never executed in CI.
name: Paseo Board Pages
on:
  push:
    branches: [${JSON.stringify(baseBranch)}]
    paths: ['${DIRECTORY}/**', '${WORKFLOW}']
  pull_request:
    paths: ['${DIRECTORY}/**', '${WORKFLOW}']
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: paseo-board-pages
  cancel-in-progress: false
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - name: Verify frozen public files
        shell: bash
        run: |
          node <<'NODE'
          const fs = require('node:fs'), crypto = require('node:crypto');
          const canonical = value => JSON.stringify(value && typeof value === 'object' ? (Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))]))) : value);
          const hash = value => crypto.createHash('sha256').update(value).digest('hex');
          const root = '${DIRECTORY}/site/', manifest = JSON.parse(fs.readFileSync(root + 'release.json', 'utf8'));
          const expected = [...manifest.files.map(file => file.path), 'release.json'].sort();
          if (JSON.stringify(fs.readdirSync(root).sort()) !== JSON.stringify(expected)) throw Error('Unexpected public files');
          for (const file of manifest.files) {
            if (!/^[a-zA-Z0-9_.-]+$/.test(file.path)) throw Error('Unsafe path');
            const stat = fs.lstatSync(root + file.path); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unsafe file');
            const content = fs.readFileSync(root + file.path);
            if (content.length !== file.bytes || hash(content) !== file.sha256) throw Error('Artifact mismatch');
          }
          if (hash(canonical(manifest.files)) !== manifest.artifactHash) throw Error('Manifest mismatch');
          NODE
  deploy:
    if: github.event_name != 'pull_request'
    needs: verify
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v4
        with:
          path: '${DIRECTORY}/site'
      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@v4
`;
}

type RepositoryInfo = { full_name: string; default_branch: string; permissions?: { push?: boolean; admin?: boolean }; private: boolean; html_url: string };
type PullRequest = { number: number; html_url: string; state: string; merged?: boolean; merged_at?: string | null; merge_commit_sha?: string | null; mergeable?: boolean | null; head: { sha: string; ref: string }; base: { ref: string } };
type Content = { content?: string; encoding?: string; type?: string };
type PagesInfo = { html_url: string; build_type?: string; cname?: string | null; source?: { branch: string; path: string } };
const isLegacyJob = (job: PagesJob) => job.publicationMode === "legacy-subdirectory" || job.publicationMode === "legacy-branch";
const isLegacyPages = (pages: PagesInfo) => pages.build_type === "legacy" || pages.build_type === undefined && !!pages.source;
type GitTree = { sha: string; truncated?: boolean; tree: Array<{ path: string; mode: string; type: string; sha: string }> };
const pagesConfigurationHash = (pages: PagesInfo) => sha256(canonicalJson({ url: pages.html_url, buildType: pages.build_type ?? (pages.source ? "legacy" : "workflow"), cname: pages.cname ?? null, ...(isLegacyPages(pages) ? { source: pages.source ?? null } : {}) }));
const gitBlobHash = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
class PublicationValidationError extends Error {}
type RefusalCode = NonNullable<PagesJob["refusal"]>["code"];
/** Typed, non-retryable refusal; recorded on the job so the client can drop its stale request. */
class PublicationRefusal extends PublicationValidationError {
  constructor(readonly code: RefusalCode, message: string) { super(message); }
}
const failureStatus = (error: unknown) => error instanceof PublicationValidationError || error instanceof GitHubApiError && error.status < 500 && error.status !== 429 ? "failed" as const : "unknown" as const;
const safeError = (error: unknown) => error instanceof Error ? error.message.slice(0, 800) : "Publication operation failed";
function withFailure(job: PagesJob, error: unknown): PagesJob {
  job.status = failureStatus(error); job.error = safeError(error);
  if (error instanceof PublicationRefusal) job.refusal = { code: error.code, message: error.message };
  else if (job.refusal?.code !== "up-to-date") delete job.refusal;
  return job;
}
const pending = new Map<string, Promise<unknown>>();

// Share series: jobs with a shareKey on one host+repository whose releases belong to one Board.
const hostOf = (job: PagesJob) => job.githubHost ?? "github.com";
const sameTarget = (a: PagesJob, b: PagesJob) => hostOf(a) === hostOf(b) && a.repository.toLowerCase() === b.repository.toLowerCase();
const seriesLock = (job: { githubHost?: string; repository: string }) => `series:${job.githubHost ?? "github.com"}:${job.repository.toLowerCase()}`;
const createdTime = (job: PagesJob) => { const time = job.createdAt ? Date.parse(job.createdAt) : NaN; return Number.isFinite(time) ? time : undefined; };
// Series order: missing createdAt is oldest; ties fall back to jobId.
const createdAfter = (a: PagesJob, b: PagesJob) => { const x = createdTime(a) ?? -Infinity, y = createdTime(b) ?? -Infinity; return x !== y ? x > y : a.jobId > b.jobId; };
// A no-op job found its release already on the share link; it counts as published.
const onShare = (job: PagesJob) => !!job.mergedSha || job.refusal?.code === "up-to-date";
const reachedHead = (job: PagesJob) => !!(job.headSha || job.mergedSha);
const blobIdentity = (text: string) => `100644:blob:${gitBlobHash(text)}`;
const entriesUnder = (tree: Map<string, string>, directory: string, skip?: string) => new Map([...tree]
  .filter(([path]) => path.startsWith(directory + "/")).map(([path, identity]) => [path.slice(directory.length + 1), identity] as const)
  .filter(([path]) => !skip || !path.startsWith(skip)));
const identicalFiles = (entries: Map<string, string>, files: Record<string, string>) =>
  entries.size === Object.keys(files).length && Object.entries(files).every(([name, text]) => entries.get(name) === blobIdentity(text));
type Owner = { release: StaticRelease; meta?: ReleaseMeta; boardId: string; boardCreatedAt?: string };
type OwnerCache = (releaseId: string) => Promise<Owner | undefined>;
const sameBoard = (a: Owner, b: Owner) => a.boardId === b.boardId && (a.boardCreatedAt === undefined || b.boardCreatedAt === undefined || a.boardCreatedAt === b.boardCreatedAt);
const sourceOf = ({ release, meta }: Owner) => ({ documentVersion: release.provenance.canvasBase.documentVersion, patchCount: release.provenance.patchCount ?? meta?.source.patchCount, revision: release.provenance.canvasBase.revision });
/** documentVersion, then patchCount, then canvas revision (also when patchCount is unknown). */
function newerSource(a: Owner, b: Owner): boolean {
  const x = sourceOf(a), y = sourceOf(b);
  if (x.documentVersion !== y.documentVersion) return x.documentVersion > y.documentVersion;
  if (x.patchCount !== undefined && y.patchCount !== undefined && x.patchCount !== y.patchCount) return x.patchCount > y.patchCount;
  return x.revision > y.revision;
}
const NEWER_ON_SHARE = "分享页上已有更新的版本，此请求不会覆盖。";
const SSO_NOTICE = "部署已完成，但尚未核验此版本的页面内容；站点可能仍在更新、需要公司网络或登录。不会向 Pages 站点发送 GitHub 凭据。";

/** Local durable journal. Every mutation binds one artifact + selected account/repository. */
export class GitHubPagesManager {
  private timer?: ReturnType<typeof setTimeout>;
  private runner?: Promise<void>;
  private stopped = false;
  private wakeRequested = false;
  constructor(readonly root: string, readonly releases: ReleaseRepository, readonly transport: GitHubTransport = new GhCliTransport()) {}
  /** Only explicitly authorized jobs resume. The journal, not an open UI, owns the work. */
  start(): void {
    if (this.stopped) return;
    if (this.runner) { this.wakeRequested = true; return; }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      let active = false;
      this.runner = this.advanceAutomatic().then(async () => {
        active = (await this.list()).some(job => job.autoPublish && !["live", "failed"].includes(job.status));
      }).catch(() => {}).finally(() => {
        this.runner = undefined;
        if (!this.stopped) {
          if (this.wakeRequested) { this.wakeRequested = false; this.start(); }
          else if (active) this.schedule();
        }
      });
    }, 0);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, 5_000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
  async close(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; await this.runner; }
  async publish(input: PagesPrepareInput): Promise<PagesJob> {
    const options = PagesPrepareSchema.parse(input), jobId = `pages-${sha256(options.eventId).slice(0, 40)}`;
    const release = await this.releases.read(options.releaseId);
    if (release.manifest.artifactHash !== options.artifactHash) throw new PublicationValidationError("Publication artifact hash changed");
    if (loopbackLiveRefused(release.manifest.live, options.githubHost)) throw new Error(LOOPBACK_LIVE_REFUSAL);
    // Lock order everywhere: series, then job. The busy check and the authorization are one step.
    const authorize = () => this.exclusive(jobId, async () => {
      const previous = await this.loadRequest(options);
      if (previous.shareKey && !onShare(previous) && await this.seriesBusy(previous)) {
        const message = "这个分享页还有一次更新在进行中；完成后再更新。";
        return this.save({ ...previous, status: "failed", autoPublish: false, error: message, refusal: { code: "series-busy", message } });
      }
      const next: PagesJob = { ...previous, status: previous.status === "failed" ? "unknown" : previous.status, autoPublish: true, autoPublishUntil: new Date(Date.now() + 30 * 60_000).toISOString() };
      if (previous.status === "failed" && previous.refusal?.code !== "up-to-date") delete next.refusal;
      return this.save(next);
    });
    const job = options.shareKey ? await this.exclusive(seriesLock(options), authorize) : await authorize();
    this.start(); return job;
  }
  /** One bounded pass, also usable by the CLI and deterministic recovery tests. */
  async advanceAutomatic(): Promise<void> {
    // Oldest request first (missing createdAt last), so a newer share update never runs ahead of an older one.
    const order = (job: PagesJob) => createdTime(job) ?? Infinity;
    const jobs = (await this.list()).sort((a, b) => order(a) - order(b) || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
    for (const saved of jobs) {
      if (this.stopped || !saved.autoPublish || ["live", "failed"].includes(saved.status)) continue;
      if (!saved.autoPublishUntil || Date.parse(saved.autoPublishUntil) <= Date.now()) {
        await this.exclusive(saved.jobId, async () => {
          const current = await this.read(saved.jobId);
          // A deployed but login-protected page keeps its sign-in verification notice.
          const unverified = current.status === "deploying" && !!current.deployedUrl;
          if (current.autoPublishUntil === saved.autoPublishUntil && !["live", "failed"].includes(current.status)) await this.save({ ...current, autoPublish: false, ...(unverified ? {} : { error: "发布等待超过 30 分钟；点击继续发布可使用同一次请求恢复。" }) });
        });
        continue;
      }
      try {
        let job = await this.prepare(PagesPrepareSchema.parse(saved));
        if (this.stopped || job.status === "failed") continue;
        if (job.status === "pr-open" && job.headSha) job = await this.merge({ jobId: job.jobId, expectedHead: job.headSha });
        if (!this.stopped && ["merged", "deploying"].includes(job.status)) await this.refresh(job.jobId);
      } catch (error) {
        await this.exclusive(saved.jobId, async () => { const current = await this.read(saved.jobId); await this.save(withFailure(current, error)); });
      }
    }
  }
  private async loadRequest(options: PagesPrepareInput): Promise<PagesJob> {
    const jobId = `pages-${sha256(options.eventId).slice(0, 40)}`;
    try {
      const job = await this.read(jobId);
      if (canonicalJson({ ...PagesPrepareSchema.parse(job), githubHost: job.githubHost ?? "github.com" }) !== canonicalJson({ ...options, githubHost: options.githubHost ?? "github.com" })) throw new PublicationValidationError("This publication event already belongs to a different artifact or repository");
      return job;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.save({ ...options, jobId, branch: `paseo-board/${options.releaseId.slice(8, 24)}-${jobId.slice(-12)}`, status: "prepared", createdAt: new Date().toISOString() });
    }
  }
  accounts(githubHost?: string) { return this.transport.accounts(githubHost); }
  private request<T>(job: PagesJob, method: string, path: string, body?: unknown): Promise<T> { return this.transport.request<T>(job.account, method, path, body, job.githubHost ?? "github.com"); }
  async repositories(account: string, githubHost = "github.com"): Promise<GitHubRepository[]> {
    GitHubHostSchema.parse(githubHost);
    if (!validLogin(account)) throw new PublicationValidationError("Invalid GitHub account");
    const result: GitHubRepository[] = [];
    for (let page = 1; page <= 5; page++) {
      const repositories = await this.transport.request<RepositoryInfo[]>(account, "GET", `/user/repos?per_page=100&page=${page}&sort=updated`, undefined, githubHost);
      result.push(...repositories.filter(repo => repo.permissions?.push).map(repo => ({ name: repo.full_name, private: repo.private, url: repo.html_url })));
      if (repositories.length < 100) break;
    }
    return result;
  }
  private exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const key = `${resolve(this.root)}:${id}`, previous = pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action); pending.set(key, next);
    void next.finally(() => { if (pending.get(key) === next) pending.delete(key); }).catch(() => {});
    return next;
  }
  async read(id: string): Promise<PagesJob> {
    IdSchema.parse(id); const file = join(this.root, `${id}.json`), stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) throw new PublicationValidationError("Invalid Pages job file");
    const job = PagesJobSchema.parse(JSON.parse(await readFile(file, "utf8"))); if (job.jobId !== id) throw new PublicationValidationError("Pages job identity changed"); return job;
  }
  /** skipInvalid: status views omit unreadable journal files instead of failing. */
  async list(releaseId?: string, options: { skipInvalid?: boolean } = {}): Promise<PagesJob[]> {
    let names: string[]; try { names = await readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const jobs: PagesJob[] = [];
    for (const name of names.sort()) if (/^pages-[a-f0-9]{40}\.json$/.test(name)) {
      let job: PagesJob;
      try { job = await this.read(name.slice(0, -5)); } catch (error) { if (options.skipInvalid) continue; throw error; }
      if (!releaseId || job.releaseId === releaseId) jobs.push(job);
    }
    return jobs;
  }
  private async save(job: PagesJob): Promise<PagesJob> {
    const parsed = PagesJobSchema.parse(job);
    if (parsed.status === "failed" && parsed.autoPublish) parsed.autoPublish = false;
    await ensureDirectory(this.root);
    const file = join(this.root, `${parsed.jobId}.json`), temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(parsed)); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, file);
      const directory = await open(this.root, "r"); try { await directory.sync(); } finally { await directory.close(); }
      return parsed;
    } finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  private async optional<T>(job: PagesJob, path: string): Promise<T | undefined> { try { return await this.request<T>(job, "GET", path); } catch (error) { if (error instanceof GitHubApiError && error.status === 404) return undefined; throw error; } }
  private prefix(job: PagesJob) { return `/repos/${job.repository}`; }
  private async content(job: PagesJob, path: string, ref: string): Promise<string | undefined> {
    const content = await this.optional<Content>(job, `${this.prefix(job)}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (!content) return undefined;
    if (content.type !== "file" || content.encoding !== "base64" || typeof content.content !== "string") throw new PublicationValidationError("Repository publication path is not a regular file");
    return Buffer.from(content.content, "base64").toString("utf8");
  }
  /** Version directory: legacy jobs boards/<releaseHex>; legacy series jobs the archive boards/<key>/v/<releaseHex>. */
  private siteDirectory(job: PagesJob): string {
    if (!isLegacyJob(job)) return `${DIRECTORY}/site`;
    const hex = job.releaseId.slice(8), expected = job.shareKey ? `boards/${job.shareKey}/v/${hex}` : `boards/${hex}`;
    if (!job.sitePath || !job.sourcePath || job.sitePath !== expected || job.shareKey && job.sharePath !== `boards/${job.shareKey}`) throw new PublicationValidationError("The frozen publication directory is invalid");
    return `${job.sourcePath === "/docs" ? "docs/" : ""}${job.sitePath}`;
  }
  /** Stable share directory; workflow mode shares the Pages root. */
  private shareDirectory(job: PagesJob): string {
    if (!isLegacyJob(job)) return `${DIRECTORY}/site`;
    this.siteDirectory(job);
    return `${job.sourcePath === "/docs" ? "docs/" : ""}${job.sharePath}`;
  }
  private async publicFiles(job: PagesJob): Promise<Record<string, string>> {
    const release = await this.releases.read(job.releaseId);
    if (release.manifest.artifactHash !== job.artifactHash) throw new PublicationValidationError("Publication artifact hash changed");
    const place = (directory: string, source: Record<string, string>) => Object.fromEntries(Object.entries(source).map(([name, content]) => [`${directory}/${name}`, content]));
    const files = place(this.siteDirectory(job), release.files);
    if (isLegacyJob(job)) {
      if (job.shareKey) {
        Object.assign(files, place(this.shareDirectory(job), release.files));
        // Adoption keeps the originally shared release R0 viewable under the share's version archive.
        if (job.adoptedFrom) Object.assign(files, place(`${this.shareDirectory(job)}/v/${job.shareKey}`, (await this.releases.read(`release-${job.shareKey}`)).files));
      }
      return { ...files, ...(job.publicationMode === "legacy-branch" ? { "docs/.nojekyll": "" } : {}) };
    }
    const workflow = pagesWorkflow(job.baseBranch!);
    return { ...files, [WORKFLOW]: workflow, [OWNER_FILE]: canonicalJson({ publisher: "paseo-board", formatVersion: 1, repository: job.repository, workflowHash: sha256(workflow) }) + "\n" };
  }
  private ownerCache(): OwnerCache {
    const cache = new Map<string, Promise<Owner | undefined>>();
    return id => {
      let entry = cache.get(id);
      if (!entry) {
        entry = (async () => {
          try {
            const release = await this.releases.read(id), stored = await this.releases.meta(id);
            const meta = stored?.source.boardId === release.provenance.boardId ? stored : undefined;
            return { release, meta, boardId: release.provenance.boardId, boardCreatedAt: meta?.source.boardCreatedAt ?? release.provenance.boardCreatedAt };
          } catch { return undefined; }
        })();
        cache.set(id, entry);
      }
      return entry;
    };
  }
  /** Jobs of the requesting Board on this host+repository (including `job` itself), and whether another Board uses its key. */
  private async boardJobs(job: PagesJob, owners: OwnerCache): Promise<{ self: Owner; owned: PagesJob[]; foreign: boolean }> {
    const self = await owners(job.releaseId);
    if (!self) throw new PublicationValidationError("The publication release is unreadable");
    const owned: PagesJob[] = []; let foreign = false;
    for (const other of await this.list(undefined, { skipInvalid: true })) {
      if (other.jobId === job.jobId || !sameTarget(other, job)) continue;
      const owner = await owners(other.releaseId);
      if (owner && sameBoard(owner, self)) owned.push(other);
      else if (other.shareKey && other.shareKey === job.shareKey) foreign = true;
    }
    return { self, owned: [...owned, job], foreign };
  }
  /** Same Board is checked by the caller. Workflow mode: one root per repository, any key. */
  private isSeriesMember(job: PagesJob, other: PagesJob): boolean {
    return other.jobId !== job.jobId && !!other.shareKey && (other.shareKey === job.shareKey || job.publicationMode === "workflow" && other.publicationMode === "workflow");
  }
  private async seriesBusy(job: PagesJob): Promise<boolean> {
    const { owned } = await this.boardJobs(job, this.ownerCache()), now = Date.now();
    // A request not prepared yet has no mode; it shares the root with this Board's workflow-mode keyed jobs.
    const sharesRoot = (a: PagesJob, b: PagesJob) => a.publicationMode === "workflow" && (b.publicationMode ?? "workflow") === "workflow";
    const member = (other: PagesJob) => other.jobId !== job.jobId && !!other.shareKey && (other.shareKey === job.shareKey || sharesRoot(other, job) || sharesRoot(job, other));
    // Only before merge: deploying or login-protected (unverified) merged jobs never block.
    return owned.some(other => member(other) && !onShare(other) && other.status !== "failed" && !!other.autoPublish && !!other.autoPublishUntil && Date.parse(other.autoPublishUntil) > now);
  }
  /** Workflow mode: once any keyed job wrote the Pages root, requests without a key follow the series root rules too. */
  private async rootIsShared(job: PagesJob): Promise<boolean> {
    return (await this.list(undefined, { skipInvalid: true })).some(other => other.jobId !== job.jobId && sameTarget(other, job) && !!other.shareKey && other.publicationMode === "workflow" && reachedHead(other));
  }
  /** Mode family stays fixed per series; a legacy series adopts a pre-feature boards/<key> publication. Returns its jobId. */
  private async seriesMode(job: PagesJob, legacy: boolean, owners: OwnerCache): Promise<string | undefined> {
    const { owned, foreign } = await this.boardJobs(job, owners);
    if (foreign) throw new PublicationRefusal("share-foreign", "这个分享链接已属于另一张 Board，未覆盖。");
    const prior = owned.filter(other => other.jobId !== job.jobId && other.publicationMode && reachedHead(other) &&
      (other.shareKey === job.shareKey || !other.shareKey && isLegacyJob(other) && other.sitePath === `boards/${job.shareKey}`));
    if (prior.some(other => isLegacyJob(other) !== legacy)) throw new PublicationValidationError("这个分享页的 Pages 发布方式已改变（分支目录 / 工作流），不会切换；请选择其他仓库。");
    return legacy ? prior.filter(other => !other.shareKey).sort((a, b) => createdAfter(a, b) ? 1 : -1).at(-1)?.jobId : undefined;
  }
  /**
   * Series write rules at `ref`: the stable directory is vacant or holds a release of this Board (forward-only),
   * version archives are vacant or byte-identical. Returns the tree at `ref`.
   */
  private async assertSeries(job: PagesJob, ref: string, owners: OwnerCache = this.ownerCache()): Promise<Map<string, string>> {
    let context = await this.boardJobs(job, owners);
    if (context.foreign) throw new PublicationRefusal("share-foreign", "这个分享链接已属于另一张 Board，未覆盖。");
    const assertNoNewerJob = () => {
      if (context.owned.some(other => this.isSeriesMember(job, other) && createdAfter(other, job) && reachedHead(other))) throw new PublicationRefusal("newer-on-share", NEWER_ON_SHARE);
    };
    assertNoNewerJob();
    const legacy = isLegacyJob(job), stable = this.shareDirectory(job), tree = await this.tree(job, ref);
    const archives: Array<[string, Record<string, string>]> = [];
    if (legacy) {
      archives.push([this.siteDirectory(job), context.self.release.files]);
      if (job.adoptedFrom) {
        const original = await owners(`release-${job.shareKey}`);
        if (!original) throw new PublicationValidationError("The adopted share release is unreadable");
        archives.push([`${stable}/v/${job.shareKey}`, original.release.files]);
      }
    }
    for (const directory of [stable, ...archives.map(([directory]) => directory)]) {
      const parts = directory.split("/");
      for (let index = 1; index <= parts.length; index++) if (tree.has(parts.slice(0, index).join("/"))) throw new PublicationValidationError("The publication directory already contains unrelated files or a non-directory parent");
    }
    // Only the direct-child release files are the share; its v/ archive subtree is checked per version.
    const current = entriesUnder(tree, stable, legacy ? "v/" : undefined);
    if (current.size) {
      const holder = async () => {
        for (const other of context.owned) if (reachedHead(other)) { const owner = await owners(other.releaseId); if (owner && identicalFiles(current, owner.release.files)) return owner; }
        return undefined;
      };
      let found = await holder();
      if (!found) {
        // Pick up merges whose response was lost before refusing.
        const unmerged = context.owned.filter(other => this.isSeriesMember(job, other) && other.prNumber && !other.mergedSha);
        for (const other of unmerged) await this.refresh(other.jobId).catch(() => undefined);
        if (unmerged.length) { context = await this.boardJobs(job, owners); assertNoNewerJob(); found = await holder(); }
      }
      if (!found) throw new PublicationRefusal("share-foreign", legacy ? "分享页目录已被其他内容改动，未覆盖。" : "此仓库首页属于另一张 Board，请选择其他仓库。");
      if (found.release.manifest.releaseId !== context.self.release.manifest.releaseId && newerSource(found, context.self)) throw new PublicationRefusal("newer-on-share", NEWER_ON_SHARE);
      const names = (files: Record<string, string>) => JSON.stringify(Object.keys(files).sort());
      if (names(found.release.files) !== names(context.self.release.files)) throw new PublicationRefusal("share-files-mismatch", "分享页目录的文件与新版本不一致，未覆盖。");
    }
    for (const [directory, files] of archives) {
      const existing = entriesUnder(tree, directory);
      if (existing.size && !identicalFiles(existing, files)) throw new PublicationRefusal("share-foreign", "版本目录已有其他内容，未覆盖。");
    }
    return tree;
  }
  /** True unless a later job of this Board's series is already on the share link. */
  private async latestOnShare(job: PagesJob): Promise<boolean> {
    const later = (await this.list(undefined, { skipInvalid: true })).filter(other => sameTarget(other, job) && this.isSeriesMember(job, other) && onShare(other) && createdAfter(other, job));
    if (!later.length) return true;
    const owners = this.ownerCache(), self = await owners(job.releaseId);
    for (const other of later) { const owner = await owners(other.releaseId); if (owner && self && sameBoard(owner, self)) return false; }
    return true;
  }
  private async assertLegacySource(job: PagesJob): Promise<PagesInfo> {
    const pages = await this.request<PagesInfo>(job, "GET", `${this.prefix(job)}/pages`);
    if (!isLegacyPages(pages) || pages.source?.branch !== job.baseBranch || pages.source?.path !== job.sourcePath || pagesConfigurationHash(pages) !== job.pagesConfigurationHash) throw new PublicationValidationError("Pages configuration changed; the existing site's publishing source will not be replaced");
    return pages;
  }
  private async assertNewLegacySite(job: PagesJob, ref: string): Promise<void> {
    const pages = await this.optional<PagesInfo>(job, `${this.prefix(job)}/pages`);
    if (pages) {
      if (!job.pagesConfigured) throw new PublicationValidationError("仓库已出现 Pages 站点；请先核对归属，不能自动替换设置。");
      await this.assertLegacySource(job);
    }
    await this.assertNoCompetingPagesWorkflow(job, ref);
    // Enabling /docs must not expose any pre-existing repository files.
    if (await this.optional(job, `${this.prefix(job)}/contents/docs?ref=${encodeURIComponent(ref)}`)) throw new PublicationValidationError("The new Pages source /docs contains existing files; choose a dedicated repository or configure its Pages source explicitly");
  }
  private async assertVacantSite(job: PagesJob, ref: string): Promise<void> {
    const directory = this.siteDirectory(job);
    // A parent file/symlink must never be replaced by a directory during tree creation.
    const parts = directory.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const path = parts.slice(0, index).join("/");
      const existing = await this.optional<unknown>(job, `${this.prefix(job)}/contents/${path}?ref=${encodeURIComponent(ref)}`);
      if (existing && (index === parts.length || !Array.isArray(existing))) throw new PublicationValidationError("The publication directory already contains unrelated files or a non-directory parent");
    }
  }
  private async tree(job: PagesJob, ref: string): Promise<Map<string, string>> {
    const result = await this.request<GitTree>(job, "GET", `${this.prefix(job)}/git/trees/${ref}?recursive=1`);
    if (result.truncated || !Array.isArray(result.tree) || result.tree.length > 100_000) throw new PublicationValidationError("The repository tree is too large to verify the complete publication diff");
    return new Map(result.tree.filter(file => file.type !== "tree").map(file => [file.path, `${file.mode}:${file.type}:${file.sha}`]));
  }
  private async assertPublicDiff(job: PagesJob, currentBase: string): Promise<void> {
    if (!job.baseSha || !job.headSha || !job.treeSha) throw new PublicationValidationError("The publication commit is incomplete");
    const commit = await this.request<{ tree: { sha: string }; parents: Array<{ sha: string }> }>(job, "GET", `${this.prefix(job)}/git/commits/${job.headSha}`);
    if (commit.tree.sha !== job.treeSha || commit.parents.length !== 1 || commit.parents[0].sha !== job.baseSha) throw new PublicationValidationError("The frozen publication commit ancestry or tree changed");
    const [base, head, current, files] = await Promise.all([this.tree(job, job.baseSha), this.tree(job, job.headSha), this.tree(job, currentBase), this.publicFiles(job)]);
    const expected = new Map(base);
    for (const [path, text] of Object.entries(files)) {
      if (current.get(path) !== base.get(path)) throw new PublicationValidationError("A publication path changed on the target branch; it will not be overwritten");
      expected.set(path, `100644:blob:${gitBlobHash(text)}`);
    }
    if (expected.size !== head.size || [...expected].some(([path, identity]) => head.get(path) !== identity)) throw new PublicationValidationError("The PR diff contains changed or extra files outside the frozen public artifact");
  }
  private async assertOwnership(job: PagesJob, ref: string, allowOwnedSetup = false): Promise<void> {
    const [owner, workflow, pages] = await Promise.all([this.content(job, OWNER_FILE, ref), this.content(job, WORKFLOW, ref), this.optional<PagesInfo>(job, `${this.prefix(job)}/pages`)]);
    if (owner) {
      const marker = JSON.parse(owner) as { publisher?: string; repository?: string; workflowHash?: string };
      if (marker.publisher !== "paseo-board" || marker.repository !== job.repository || !workflow || sha256(workflow) !== marker.workflowHash || marker.workflowHash !== sha256(pagesWorkflow(job.baseBranch!))) throw new PublicationValidationError("The repository's publication files changed outside this workflow; review them before publishing");
      if (pages && pages.build_type && pages.build_type !== "workflow") throw new PublicationValidationError("This repository now uses a different Pages publishing source");
    } else {
      if (workflow || pages && !allowOwnedSetup) throw new PublicationValidationError("This repository already has a Pages site or conflicting workflow; choose a dedicated repository");
      const directory = await this.optional<unknown>(job, `${this.prefix(job)}/contents/${DIRECTORY}?ref=${encodeURIComponent(ref)}`);
      if (directory) throw new PublicationValidationError("The reserved publication directory already contains unrelated files");
    }
    await this.assertNoCompetingPagesWorkflow(job, ref, WORKFLOW);
  }
  private async assertNoCompetingPagesWorkflow(job: PagesJob, ref: string, ownedPath?: string): Promise<void> {
    const workflows = await this.optional<Array<{ path: string; type: string }>>(job, `${this.prefix(job)}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`);
    if (workflows) {
      if (!Array.isArray(workflows) || workflows.length > 50) throw new PublicationValidationError("Repository workflows need manual review before enabling Pages");
      for (const file of workflows) if (file.type === "file" && file.path !== ownedPath) { const text = await this.content(job, file.path, ref); if (text && /deploy-pages|github-pages|gh-pages/i.test(text)) throw new PublicationValidationError("Another Pages workflow already exists in this repository"); }
    }
  }
  async prepare(input: PagesPrepareInput): Promise<PagesJob> {
    const options = PagesPrepareSchema.parse(input), jobId = `pages-${sha256(options.eventId).slice(0, 40)}`;
    // Before the job exists: this request can never succeed, so it leaves nothing to resume.
    if (loopbackLiveRefused((await this.releases.read(options.releaseId)).manifest.live, options.githubHost)) throw new Error(LOOPBACK_LIVE_REFUSAL);
    const run = () => this.exclusive(jobId, async () => {
      let job = await this.loadRequest(options);
      const release = await this.releases.read(job.releaseId);
      if (release.manifest.artifactHash !== job.artifactHash) throw new PublicationValidationError("Publication artifact hash changed");
      if (job.prNumber) return this.refreshInternal(job);
      // Already on the share link without a PR; every pass re-verifies it until live (transient errors retry).
      if (job.refusal?.code === "up-to-date") return this.refreshInternal(job);
      const owners = this.ownerCache();
      try {
        const api = this.prefix(job);
        let repo = await this.optional<RepositoryInfo>(job, api);
        if (!repo) {
          if (!job.createRepository) throw new PublicationValidationError("The selected repository does not exist or this account cannot access it");
          const [owner, name] = job.repository.split("/");
          repo = await this.request<RepositoryInfo>(job, "POST", owner.toLowerCase() === job.account.toLowerCase() ? "/user/repos" : `/orgs/${owner}/repos`, { name, private: job.createRepository === "private", auto_init: true, description: "Static interactive Board releases" });
        }
        if (repo.full_name.toLowerCase() !== job.repository.toLowerCase() || !repo.permissions?.push) throw new PublicationValidationError("The selected account cannot write to this repository");
        if (job.createRepository && repo.private !== (job.createRepository === "private")) throw new PublicationValidationError("The existing repository visibility differs from the requested new repository");
        if (!job.publicationMode) {
          const pages = await this.optional<PagesInfo>(job, `${api}/pages`);
          // Legacy series: archive boards/<key>/v/<releaseHex> plus the stable boards/<key>.
          const sitePath = job.shareKey ? `boards/${job.shareKey}/v/${job.releaseId.slice(8)}` : `boards/${job.releaseId.slice(8)}`;
          let mode: Partial<PagesJob>;
          if (!job.headSha && pages && isLegacyPages(pages) && pages.source?.branch && ["/", "/docs"].includes(pages.source.path)) {
            mode = { publicationMode: "legacy-subdirectory", baseBranch: pages.source.branch, sourcePath: pages.source.path as "/" | "/docs", sitePath, pagesConfigurationHash: pagesConfigurationHash(pages) };
          } else if (isEnterpriseServer(job.githubHost)) {
            if (pages) throw new PublicationValidationError("此内部 GitHub 仓库已有其他 Pages 发布方式；不会替换现有设置。请选择已有分支发布站点或专用仓库。");
            mode = { publicationMode: "legacy-branch", baseBranch: repo.default_branch, sourcePath: "/docs", sitePath };
          } else mode = { publicationMode: "workflow" };
          if (job.shareKey) {
            const legacy = mode.publicationMode !== "workflow", adoptedFrom = await this.seriesMode(job, legacy, owners);
            if (legacy) mode.sharePath = `boards/${job.shareKey}`;
            if (adoptedFrom) mode.adoptedFrom = adoptedFrom;
          }
          job = await this.save({ ...job, ...mode });
        }
        if (!job.baseBranch) { job.baseBranch = repo.default_branch; job = await this.save(job); }
        const baseBranch = job.baseBranch!;
        const base = await this.request<{ object: { sha: string } }>(job, "GET", `${api}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
        let tree: Map<string, string> | undefined;
        if (job.publicationMode === "legacy-subdirectory") { await this.assertLegacySource(job); if (job.shareKey) tree = await this.assertSeries(job, base.object.sha, owners); else await this.assertVacantSite(job, base.object.sha); }
        else if (job.publicationMode === "legacy-branch") { await this.assertNewLegacySite(job, base.object.sha); if (job.shareKey) tree = await this.assertSeries(job, base.object.sha, owners); }
        else { await this.assertOwnership(job, base.object.sha); if (job.shareKey || await this.rootIsShared(job)) tree = await this.assertSeries(job, base.object.sha, owners); }
        if (tree && !job.treeSha) {
          // No-op: the share link and archive already hold exactly this release; never open an empty PR.
          const reference = job.baseSha && job.baseSha !== base.object.sha ? await this.tree(job, job.baseSha) : tree;
          if (Object.entries(await this.publicFiles(job)).every(([path, text]) => reference.get(path) === blobIdentity(text))) {
            const message = "分享页已是这个版本；没有创建新的 PR。";
            job.refusal = { code: "up-to-date", message }; job.status = "deploying"; delete job.error;
            return this.save(job);
          }
        }
        if (!job.baseSha) { job.baseSha = base.object.sha; job = await this.save(job); }
        const publicFiles = await this.publicFiles(job);
        if (!job.treeSha) {
          const baseCommit = await this.request<{ tree: { sha: string } }>(job, "GET", `${api}/git/commits/${job.baseSha}`);
          const tree = await this.request<{ sha: string }>(job, "POST", `${api}/git/trees`, { base_tree: baseCommit.tree.sha, tree: Object.entries(publicFiles).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })) });
          job.treeSha = tree.sha; job = await this.save(job);
        }
        if (!job.headSha) {
          const commit = await this.request<{ sha: string }>(job, "POST", `${api}/git/commits`, { message: `Publish Board ${job.releaseId}`, tree: job.treeSha, parents: [job.baseSha] });
          job.headSha = commit.sha; job = await this.save(job);
        }
        const refPath = `${api}/git/ref/heads/${encodeURIComponent(job.branch)}`;
        let branch = await this.optional<{ object: { sha: string } }>(job, refPath);
        if (!branch) {
          try { await this.request(job, "POST", `${api}/git/refs`, { ref: `refs/heads/${job.branch}`, sha: job.headSha }); }
          catch (error) { branch = await this.optional(job, refPath); if (!branch) throw error; }
          branch ??= await this.optional(job, refPath);
        }
        if (branch?.object.sha !== job.headSha) throw new PublicationValidationError("The publication branch changed; it will not be overwritten");
        const existing = await this.findPullRequest(job);
        const pr = existing ?? await this.request<PullRequest>(job, "POST", `${api}/pulls`, { title: `Publish Board: ${release.manifest.title}`, head: job.branch, base: job.baseBranch, body: `Publishes the reviewed static artifact \`${job.artifactHash}\`.\n\nRelease: \`${job.releaseId}\`. Only the frozen public files are included; no Board discussions, author state or host credentials. Merge deploys this version through GitHub Pages.` });
        if (pr.head.sha !== job.headSha || pr.base.ref !== job.baseBranch) throw new PublicationValidationError("Existing PR does not match the frozen publication head");
        job.prNumber = pr.number; job.prUrl = pr.html_url; job.status = "pr-open"; delete job.error; delete job.refusal;
        if (existing && pr.state !== "open") return this.refreshInternal(job);
        return this.save(job);
      } catch (error) { return this.save(withFailure(job, error)); }
    });
    // Every request takes the host+repository lock: a keyless workflow request may write a series root.
    return this.exclusive(seriesLock(options), run);
  }
  private async findPullRequest(job: PagesJob): Promise<PullRequest | undefined> {
    const prs = await this.request<PullRequest[]>(job, "GET", `${this.prefix(job)}/pulls?state=all&head=${encodeURIComponent(job.repository.split("/")[0] + ":" + job.branch)}&per_page=100`);
    if (prs.length > 1) throw new PublicationValidationError("Multiple pull requests use this publication branch; review them manually");
    return prs[0];
  }
  private async legacyChecks(job: PagesJob): Promise<string | undefined> {
    const api = this.prefix(job);
    const [checks, statuses] = await Promise.all([
      this.request<{ total_count: number; check_runs: Array<{ status: string; conclusion: string | null }> }>(job, "GET", `${api}/commits/${job.headSha}/check-runs?per_page=100&filter=latest`),
      this.request<{ total_count: number; state: string }>(job, "GET", `${api}/commits/${job.headSha}/status`),
    ]);
    if (checks.total_count > 100) throw new PublicationValidationError("Too many PR checks to verify automatically");
    if (checks.check_runs.some(check => check.status === "completed" && !["success", "neutral", "skipped"].includes(check.conclusion ?? "")) || statuses.total_count > 0 && ["failure", "error"].includes(statuses.state)) throw new PublicationValidationError("此固定提交的仓库检查未通过；发布已停止。修复检查后可继续同一次发布。");
    // GitHub reports pending when there are zero legacy status contexts; that is not a pending check.
    if (checks.check_runs.some(check => check.status !== "completed") || statuses.total_count > 0 && statuses.state !== "success") return "正在等待此固定提交的仓库检查通过。";
    return undefined;
  }
  async merge(input: { jobId: string; expectedHead: string }): Promise<PagesJob> {
    // The host+repository is immutable request data, so reading it before the locks is safe.
    let saved: PagesJob | undefined;
    try { saved = await this.read(input.jobId); } catch { /* the locked read reports it */ }
    const run = () => this.exclusive(input.jobId, async () => {
      let job = await this.read(input.jobId);
      if (!job.prNumber || !job.headSha || job.headSha !== input.expectedHead) throw new PublicationValidationError("Confirm the exact prepared publication commit before merging");
      try {
        const api = this.prefix(job), pr = await this.request<PullRequest>(job, "GET", `${api}/pulls/${job.prNumber}`);
        if (pr.head.sha !== input.expectedHead || pr.base.ref !== job.baseBranch) throw new PublicationValidationError("The PR head or base changed; this publication will not merge it");
        if (pr.merged || pr.merged_at) return this.refreshInternal(job);
        if (pr.state !== "open") throw new PublicationValidationError("The publication PR is closed without being merged");
        if (pr.mergeable === false) throw new PublicationValidationError("The publication PR has merge conflicts; the target branch will not be overwritten");
        if (pr.mergeable === null) { job.error = "GitHub 正在检查合并条件。"; job.status = "pr-open"; return this.save(job); }
        if (isLegacyJob(job)) {
          const pendingCheck = await this.legacyChecks(job);
          if (pendingCheck) { job.status = "pr-open"; job.error = pendingCheck; return this.save(job); }
        } else {
          const checks = await this.request<{ workflow_runs: Array<{ id: number; path: string; head_sha: string; status: string; conclusion: string | null }> }>(job, "GET", `${api}/actions/runs?head_sha=${job.headSha}&event=pull_request&per_page=100`);
          const check = checks.workflow_runs.filter(run => run.path === WORKFLOW && run.head_sha === job.headSha).sort((a, b) => b.id - a.id)[0];
          if (!check || check.status !== "completed" || check.conclusion !== "success") {
            job.status = check?.status === "completed" ? "failed" : "pr-open"; job.error = check?.status === "completed" ? `此固定提交的发布检查未通过（${check.conclusion ?? "unknown"}）；修复或重新运行检查后再合并。` : "此固定提交的发布检查尚未完成；检查成功后再合并。";
            return this.save(job);
          }
        }
        const base = await this.request<{ object: { sha: string } }>(job, "GET", `${api}/git/ref/heads/${encodeURIComponent(job.baseBranch!)}`);
        if (job.publicationMode === "legacy-subdirectory") {
          await this.assertLegacySource(job);
          if (job.shareKey) await this.assertSeries(job, base.object.sha); else await this.assertVacantSite(job, base.object.sha);
          await this.assertPublicDiff(job, base.object.sha);
        } else if (job.publicationMode === "legacy-branch") {
          await this.assertNewLegacySite(job, base.object.sha);
          if (job.shareKey) await this.assertSeries(job, base.object.sha);
          await this.assertPublicDiff(job, base.object.sha);
        } else {
          await this.assertOwnership(job, base.object.sha, job.pagesConfigured === true);
          await this.assertOwnership(job, job.headSha);
          if (job.shareKey || await this.rootIsShared(job)) await this.assertSeries(job, base.object.sha);
          await this.assertPublicDiff(job, base.object.sha);
          let pages = await this.optional<PagesInfo>(job, `${api}/pages`);
          if (pages && job.pagesConfigured && job.pagesConfigurationHash !== pagesConfigurationHash(pages)) throw new PublicationValidationError("Pages configuration changed after confirmation; review the current site before continuing");
          if (!pages) {
            job.pagesConfigurationRequested = true; job = await this.save(job);
            pages = await this.request<PagesInfo>(job, "POST", `${api}/pages`, { build_type: "workflow" });
          }
          if (pages.build_type && pages.build_type !== "workflow") throw new PublicationValidationError("Repository Pages uses another publishing source");
          job.pagesConfigured = true; job.pagesConfigurationHash = pagesConfigurationHash(pages); job = await this.save(job);
        }
        const merged = await this.request<{ merged: boolean; sha: string }>(job, "PUT", `${api}/pulls/${job.prNumber}/merge`, { sha: input.expectedHead, merge_method: "squash" });
        if (!merged.merged) throw new PublicationValidationError("GitHub did not merge this PR; required checks or repository protection may still be pending");
        job.mergedSha = merged.sha; job.status = "merged"; delete job.error; return this.save(job);
      } catch (error) {
        if (!(error instanceof GitHubApiError && [405, 409].includes(error.status))) return this.save(withFailure(job, error));
        job.status = "pr-open"; job.error = "仓库保护或 GitHub 合并条件仍未满足，正在等待；不会绕过保护。";
        return this.save(job);
      }
    });
    return saved ? this.exclusive(seriesLock(saved), run) : run();
  }
  private async configureNewLegacySite(job: PagesJob): Promise<PagesJob> {
    if (job.pagesConfigured) { await this.assertLegacySource(job); return job; }
    const api = this.prefix(job), existing = await this.optional<PagesInfo>(job, `${api}/pages`);
    if (existing) throw new PublicationValidationError("Pages 配置归属尚未确认；不会接管现有站点，请核对上一次请求的结果。");
    const ref = await this.request<{ object: { sha: string } }>(job, "GET", `${api}/git/ref/heads/${encodeURIComponent(job.baseBranch!)}`);
    if (ref.object.sha !== job.mergedSha) throw new PublicationValidationError("Pages source branch changed after merge; review it before exposing a new site");
    const tree = await this.tree(job, job.mergedSha!), files = await this.publicFiles(job);
    const exposed = [...tree].filter(([path]) => path === "docs" || path.startsWith("docs/"));
    if (exposed.length !== Object.keys(files).length || exposed.some(([path, identity]) => !Object.hasOwn(files, path) || identity !== `100644:blob:${gitBlobHash(files[path])}`)) throw new PublicationValidationError("New Pages source includes files outside the frozen public artifact");
    job.pagesConfigurationRequested = true; job = await this.save(job);
    const pages = await this.request<PagesInfo>(job, "POST", `${api}/pages`, { build_type: "legacy", source: { branch: job.baseBranch, path: "/docs" } });
    if (!isLegacyPages(pages) || pages.source?.branch !== job.baseBranch || pages.source?.path !== "/docs") throw new PublicationValidationError("GitHub did not configure the selected branch Pages source");
    job.pagesConfigured = true; job.pagesConfigurationHash = pagesConfigurationHash(pages);
    return this.save(job);
  }
  refresh(jobId: string): Promise<PagesJob> { return this.exclusive(jobId, async () => this.refreshInternal(await this.read(jobId))); }
  private async refreshInternal(job: PagesJob): Promise<PagesJob> {
    // Share fields survive transient errors; the version fields are re-derived on every refresh.
    const previous = { status: job.status, url: job.url, verifiedAt: job.verifiedAt };
    delete job.deployedUrl; delete job.url; delete job.verifiedAt;
    try {
      if (job.publicationMode === "legacy-subdirectory" || job.publicationMode === "legacy-branch" && job.pagesConfigured) await this.assertLegacySource(job);
      if (job.refusal?.code === "up-to-date" && !job.prNumber) { job.status = "deploying"; return await this.verifyDeployment(job, previous); }
      const api = this.prefix(job), pr = job.prNumber ? await this.request<PullRequest>(job, "GET", `${api}/pulls/${job.prNumber}`) : await this.findPullRequest(job);
      if (!pr) { job.status = "prepared"; job.error = "尚未找到发布 PR；可用同一次发布请求重试。"; return this.save(job); }
      if (!job.headSha || pr.head.sha !== job.headSha || pr.base.ref !== job.baseBranch) throw new PublicationValidationError("The PR head or base differs from the frozen publication commit");
      job.prNumber = pr.number; job.prUrl = pr.html_url;
      if (!(pr.merged || pr.merged_at)) {
        if (job.pagesConfigurationRequested && !job.pagesConfigured && await this.optional<PagesInfo>(job, `${api}/pages`)) {
          job.status = "unknown"; job.error = "首次 Pages 配置的返回结果不明，当前仓库已出现站点；请先核对站点归属，不能直接重试合并。";
          return this.save(job);
        }
        job.status = pr.state === "open" ? "pr-open" : "failed";
        if (pr.state !== "open") job.error = "The publication PR is closed without a merge"; else delete job.error;
        return this.save(job);
      }
      if (!pr.merge_commit_sha) throw new PublicationValidationError("GitHub has not reported the merged commit yet");
      job.mergedSha = pr.merge_commit_sha; job.status = "deploying";
      delete job.url; delete job.verifiedAt; delete job.deployedUrl;
      if (job.publicationMode === "legacy-branch") job = await this.configureNewLegacySite(job);
      if (isLegacyJob(job)) {
        const builds = await this.request<Array<{ url: string; commit: string; status: string; error?: { message?: string | null } }>>(job, "GET", `${api}/pages/builds?per_page=100`);
        const build = builds.find(item => item.commit === job.mergedSha);
        if (build) job.deploymentId = build.url;
        if (!build || ["queued", "building"].includes(build.status)) { delete job.error; return this.save(job); }
        if (build.status !== "built") { job.status = "failed"; job.error = `GitHub Pages build failed: ${build.error?.message ?? build.status}`; return this.save(job); }
      } else {
        const runs = await this.request<{ workflow_runs: Array<{ id: number; head_sha: string; head_branch: string; event: string; status: string; conclusion: string | null }> }>(job, "GET", `${api}/actions/workflows/paseo-board-pages.yml/runs?head_sha=${job.mergedSha}&per_page=100`);
        const run = runs.workflow_runs.filter(run => run.head_sha === job.mergedSha && run.head_branch === job.baseBranch && ["push", "workflow_dispatch"].includes(run.event)).sort((a, b) => b.id - a.id)[0];
        if (run) job.deploymentId = String(run.id);
        if (!run || run.status !== "completed") { delete job.error; return this.save(job); }
        if (run.conclusion !== "success") { job.status = "failed"; job.error = `GitHub Pages workflow finished: ${run.conclusion ?? "unknown"}`; return this.save(job); }
      }
      return await this.verifyDeployment(job, previous);
    } catch (error) { return this.save(withFailure(job, error)); }
  }
  /**
   * url/deployedUrl name this version (the archive for legacy series jobs); shareDeployedUrl/shareUrl the stable link.
   * The stable link is verified only by the latest job on it; older series jobs are never demoted.
   */
  private async verifyDeployment(job: PagesJob, previous: Pick<PagesJob, "status" | "url" | "verifiedAt">): Promise<PagesJob> {
    const pages = await this.request<PagesInfo>(job, "GET", `${this.prefix(job)}/pages`);
    if (job.pagesConfigurationHash && pagesConfigurationHash(pages) !== job.pagesConfigurationHash) throw new PublicationValidationError("Pages configuration changed before verification");
    const root = pagesUrl(pages.html_url.endsWith("/") ? pages.html_url : pages.html_url + "/"), legacy = isLegacyJob(job);
    // An adopted pre-feature directory became a share link; its original release lives on under v/<hex>.
    const adopted = legacy && !job.shareKey && (await this.list(undefined, { skipInvalid: true })).some(other => other.adoptedFrom === job.jobId && sameTarget(other, job) && onShare(other));
    const url = legacy ? new URL(`${job.sitePath}/${adopted ? `v/${job.releaseId.slice(8)}/` : ""}`, root) : root;
    job.deployedUrl = url.href;
    const share = !job.shareKey ? undefined : legacy ? new URL(`${job.sharePath}/`, root) : root;
    if (share) job.shareDeployedUrl = share.href;
    const latest = !share || await this.latestOnShare(job);
    if (share && !legacy && !latest) {
      // The root now serves a newer release of this series; this version stays as last verified.
      if (previous.status === "live" && previous.url) { job.status = "live"; job.url = previous.url; if (previous.verifiedAt) job.verifiedAt = previous.verifiedAt; delete job.error; }
      else job.error = "分享页已更新为更新的版本；此版本可在本地预览。";
      return this.save(job);
    }
    const release = await this.releases.read(job.releaseId), suffix = `?paseo_release=${job.artifactHash}`;
    const verify = async (base: URL) => (await Promise.all(Object.entries(release.files).map(async ([path, expected]) => {
      try { return await this.transport.publicFile(new URL(path + suffix, base).href) === expected; }
      catch { return false; /* Deployment is known; inaccessible/SSO pages are not byte-verified. */ }
    }))).every(Boolean);
    const version = await verify(url), shared = !share || !latest ? true : legacy ? await verify(share) : version;
    if (share && latest) { if (shared) job.shareUrl = share.href; else delete job.shareUrl; }
    if (!version || !shared) { job.error = SSO_NOTICE; return this.save(job); }
    job.status = "live"; job.url = url.href; job.verifiedAt = new Date().toISOString(); delete job.error;
    const saved = await this.save(job);
    if (saved.adoptedFrom) await this.moveAdopted(saved);
    return saved;
  }
  /**
   * Once the adoption is live, the adopted pre-feature directory serves the series; re-verify that job at its
   * v/<hex> archive so its card never opens the newer share content. Lock order: this job, then the adopted one
   * (the adopted job's refresh never takes another job's lock).
   */
  private async moveAdopted(job: PagesJob): Promise<void> {
    try {
      const adopted = await this.read(job.adoptedFrom!), current = adopted.url ?? adopted.deployedUrl;
      if (adopted.prNumber && adopted.mergedSha && current && !current.endsWith(`/v/${adopted.releaseId.slice(8)}/`)) await this.refresh(adopted.jobId);
    } catch { /* the adopted job's own refresh reports its state */ }
  }
}
