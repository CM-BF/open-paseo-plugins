import { execFile } from "node:child_process";
import { readFile, readdir, rename, lstat, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { IdSchema } from "../shared/contracts";
import { PagesJobSchema, PagesPrepareSchema, type GitHubAccount, type GitHubRepository, type PagesJob, type PagesPrepareInput } from "../shared/release-contracts";
import { canonicalJson, ensureDirectory } from "./store-format";
import { ReleaseRepository, sha256 } from "./static-release";

const DIRECTORY = "paseo-board-publication";
const WORKFLOW = ".github/workflows/paseo-board-pages.yml";
const OWNER_FILE = `${DIRECTORY}/owner.json`;
const timeoutSignal = (milliseconds: number) => AbortSignal.timeout(milliseconds) as unknown as NonNullable<Parameters<typeof fetch>[1]>["signal"];
export class GitHubApiError extends Error {
  constructor(readonly status: number, message = `GitHub request failed (${status})`) { super(message); this.name = "GitHubApiError"; }
}
export interface GitHubTransport {
  accounts(): Promise<GitHubAccount[]>;
  request<T>(account: string, method: string, path: string, body?: unknown): Promise<T>;
  publicFile(url: string): Promise<string>;
}

/** Older gh versions have no --json on auth status. Never return the raw credential summary. */
export function parseGitHubAccounts(status: string): GitHubAccount[] {
  const accounts: GitHubAccount[] = [];
  for (const line of status.split("\n")) {
    const match = /Logged in to github\.com (?:account|as) ([a-zA-Z0-9-]+)(?:\s|$)/.exec(line);
    if (match) accounts.push({ login: match[1], host: "github.com", active: false });
    else if (accounts.length && /Active account:\s*true/.test(line)) accounts[accounts.length - 1].active = true;
  }
  if (accounts.length === 1 && !/Active account:/.test(status)) accounts[0].active = true;
  return accounts;
}

/** Never switches the global gh account; credentials are used only inside this process. */
export class GhCliTransport implements GitHubTransport {
  private command(args: string[], statusOutput = false): Promise<string> {
    const env = { ...process.env, GH_PROMPT_DISABLED: "1", GH_HOST: "github.com" };
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete (env as Record<string, string | undefined>)[key];
    return new Promise((resolve, reject) => execFile("gh", args, { env, timeout: 15_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => error && !statusOutput ? reject(new Error("GitHub CLI authentication is unavailable. Sign in to the selected account using gh auth login.")) : resolve(stdout + (statusOutput ? stderr : ""))));
  }
  async accounts(): Promise<GitHubAccount[]> {
    try {
      const result = JSON.parse(await this.command(["auth", "status", "--hostname", "github.com", "--json", "hosts"])) as { hosts?: Record<string, Array<{ login?: string; active?: boolean; state?: string }>> };
      return (result.hosts?.["github.com"] ?? []).filter(entry => entry.state !== "error" && /^[a-zA-Z0-9-]+$/.test(entry.login ?? "")).map(entry => ({ login: entry.login!, host: "github.com", active: entry.active === true }));
    } catch {
      const accounts = parseGitHubAccounts(await this.command(["auth", "status", "--hostname", "github.com"], true));
      if (!accounts.length) throw new Error("未找到可用的 GitHub 登录账号，请先运行 gh auth login。");
      return accounts;
    }
  }
  async request<T>(account: string, method: string, path: string, body?: unknown): Promise<T> {
    if (!/^[a-zA-Z0-9-]+$/.test(account) || !path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid GitHub request scope");
    const token = (await this.command(["auth", "token", "--hostname", "github.com", "--user", account])).trim();
    const response = await fetch(`https://api.github.com${path}`, { method, redirect: "error", signal: timeoutSignal(20_000), headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "paseo-board-publication" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new GitHubApiError(response.status);
    if (response.status === 204) return undefined as T;
    const text = await boundedResponse(response, 12 * 1024 * 1024);
    return JSON.parse(text) as T;
  }
  async publicFile(url: string): Promise<string> {
    const parsed = new URL(url);
    // Only the standard Pages domain is verified automatically. Custom domains remain pending.
    if (parsed.protocol !== "https:" || !/^[a-zA-Z0-9-]+\.github\.io$/.test(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error("Only standard https://<owner>.github.io Pages URLs can be verified automatically");
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
type PullRequest = { number: number; html_url: string; state: string; merged?: boolean; merged_at?: string | null; merge_commit_sha?: string | null; head: { sha: string; ref: string }; base: { ref: string } };
type Content = { content?: string; encoding?: string; type?: string };
type PagesInfo = { html_url: string; build_type?: string; cname?: string | null };
const pagesConfigurationHash = (pages: PagesInfo) => sha256(canonicalJson({ url: pages.html_url, buildType: pages.build_type ?? "workflow", cname: pages.cname ?? null }));
const safeError = (error: unknown) => error instanceof Error ? error.message.slice(0, 800) : "Publication operation failed";
const pending = new Map<string, Promise<unknown>>();

/** Local durable journal. Every mutation binds one artifact + selected account/repository. */
export class GitHubPagesManager {
  constructor(readonly root: string, readonly releases: ReleaseRepository, readonly transport: GitHubTransport = new GhCliTransport()) {}
  accounts() { return this.transport.accounts(); }
  async repositories(account: string): Promise<GitHubRepository[]> {
    if (!/^[a-zA-Z0-9-]+$/.test(account)) throw new Error("Invalid GitHub account");
    const result: GitHubRepository[] = [];
    for (let page = 1; page <= 5; page++) {
      const repositories = await this.transport.request<RepositoryInfo[]>(account, "GET", `/user/repos?per_page=100&page=${page}&sort=updated`);
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
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) throw new Error("Invalid Pages job file");
    const job = PagesJobSchema.parse(JSON.parse(await readFile(file, "utf8"))); if (job.jobId !== id) throw new Error("Pages job identity changed"); return job;
  }
  async list(releaseId?: string): Promise<PagesJob[]> {
    let names: string[]; try { names = await readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const jobs: PagesJob[] = [];
    for (const name of names.sort()) if (/^pages-[a-f0-9]{40}\.json$/.test(name)) { const job = await this.read(name.slice(0, -5)); if (!releaseId || job.releaseId === releaseId) jobs.push(job); }
    return jobs;
  }
  private async save(job: PagesJob): Promise<PagesJob> {
    const parsed = PagesJobSchema.parse(job); await ensureDirectory(this.root);
    const file = join(this.root, `${parsed.jobId}.json`), temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(parsed)); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, file);
      const directory = await open(this.root, "r"); try { await directory.sync(); } finally { await directory.close(); }
      return parsed;
    } finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  private async optional<T>(job: PagesJob, path: string): Promise<T | undefined> { try { return await this.transport.request<T>(job.account, "GET", path); } catch (error) { if (error instanceof GitHubApiError && error.status === 404) return undefined; throw error; } }
  private prefix(job: PagesJob) { return `/repos/${job.repository}`; }
  private async content(job: PagesJob, path: string, ref: string): Promise<string | undefined> {
    const content = await this.optional<Content>(job, `${this.prefix(job)}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (!content) return undefined;
    if (content.type !== "file" || content.encoding !== "base64" || typeof content.content !== "string") throw new Error("Repository publication path is not a regular file");
    return Buffer.from(content.content, "base64").toString("utf8");
  }
  private async assertOwnership(job: PagesJob, ref: string, allowOwnedSetup = false): Promise<void> {
    const [owner, workflow, pages] = await Promise.all([this.content(job, OWNER_FILE, ref), this.content(job, WORKFLOW, ref), this.optional<PagesInfo>(job, `${this.prefix(job)}/pages`)]);
    if (owner) {
      const marker = JSON.parse(owner) as { publisher?: string; repository?: string; workflowHash?: string };
      if (marker.publisher !== "paseo-board" || marker.repository !== job.repository || !workflow || sha256(workflow) !== marker.workflowHash || marker.workflowHash !== sha256(pagesWorkflow(job.baseBranch!))) throw new Error("The repository's publication files changed outside this workflow; review them before publishing");
      if (pages && pages.build_type && pages.build_type !== "workflow") throw new Error("This repository now uses a different Pages publishing source");
    } else {
      if (workflow || pages && !allowOwnedSetup) throw new Error("This repository already has a Pages site or conflicting workflow; choose a dedicated repository");
      const directory = await this.optional<unknown>(job, `${this.prefix(job)}/contents/${DIRECTORY}?ref=${encodeURIComponent(ref)}`);
      if (directory) throw new Error("The reserved publication directory already contains unrelated files");
    }
    const workflows = await this.optional<Array<{ path: string; type: string }>>(job, `${this.prefix(job)}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`);
    if (workflows) {
      if (!Array.isArray(workflows) || workflows.length > 50) throw new Error("Repository workflows need manual review before enabling Pages");
      for (const file of workflows) if (file.type === "file" && file.path !== WORKFLOW) { const text = await this.content(job, file.path, ref); if (text && /deploy-pages|github-pages|gh-pages/i.test(text)) throw new Error("Another Pages workflow already exists in this repository"); }
    }
  }
  async prepare(input: PagesPrepareInput): Promise<PagesJob> {
    const options = PagesPrepareSchema.parse(input), jobId = `pages-${sha256(options.eventId).slice(0, 40)}`;
    return this.exclusive(jobId, async () => {
      let job: PagesJob;
      try {
        job = await this.read(jobId);
        if (canonicalJson(PagesPrepareSchema.parse(job)) !== canonicalJson(options)) throw new Error("This publication event already belongs to a different artifact or repository");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        job = await this.save({ ...options, jobId, branch: `paseo-board/${options.releaseId.slice(8, 24)}-${jobId.slice(-12)}`, status: "prepared", createdAt: new Date().toISOString() });
      }
      const release = await this.releases.read(job.releaseId);
      if (release.manifest.artifactHash !== job.artifactHash) throw new Error("Publication artifact hash changed");
      if (job.prNumber) return this.refreshInternal(job);
      try {
        const api = this.prefix(job);
        let repo = await this.optional<RepositoryInfo>(job, api);
        if (!repo) {
          if (!job.createRepository) throw new Error("The selected repository does not exist or this account cannot access it");
          const [owner, name] = job.repository.split("/");
          repo = await this.transport.request<RepositoryInfo>(job.account, "POST", owner.toLowerCase() === job.account.toLowerCase() ? "/user/repos" : `/orgs/${owner}/repos`, { name, private: job.createRepository === "private", auto_init: true, description: "Static interactive Board releases" });
        }
        if (repo.full_name.toLowerCase() !== job.repository.toLowerCase() || !repo.permissions?.push) throw new Error("The selected account cannot write to this repository");
        if (job.createRepository && repo.private !== (job.createRepository === "private")) throw new Error("The existing repository visibility differs from the requested new repository");
        if (!job.baseBranch) { job.baseBranch = repo.default_branch; job = await this.save(job); }
        const baseBranch = job.baseBranch!;
        const base = await this.transport.request<{ object: { sha: string } }>(job.account, "GET", `${api}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
        await this.assertOwnership(job, base.object.sha);
        if (!job.baseSha) { job.baseSha = base.object.sha; job = await this.save(job); }
        const workflow = pagesWorkflow(baseBranch), publicFiles = { ...Object.fromEntries(Object.entries(release.files).map(([name, content]) => [`${DIRECTORY}/site/${name}`, content])), [WORKFLOW]: workflow, [OWNER_FILE]: canonicalJson({ publisher: "paseo-board", formatVersion: 1, repository: job.repository, workflowHash: sha256(workflow) }) + "\n" };
        if (!job.treeSha) {
          const baseCommit = await this.transport.request<{ tree: { sha: string } }>(job.account, "GET", `${api}/git/commits/${job.baseSha}`);
          const tree = await this.transport.request<{ sha: string }>(job.account, "POST", `${api}/git/trees`, { base_tree: baseCommit.tree.sha, tree: Object.entries(publicFiles).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })) });
          job.treeSha = tree.sha; job = await this.save(job);
        }
        if (!job.headSha) {
          const commit = await this.transport.request<{ sha: string }>(job.account, "POST", `${api}/git/commits`, { message: `Publish Board ${job.releaseId}`, tree: job.treeSha, parents: [job.baseSha] });
          job.headSha = commit.sha; job = await this.save(job);
        }
        const refPath = `${api}/git/ref/heads/${encodeURIComponent(job.branch)}`;
        let branch = await this.optional<{ object: { sha: string } }>(job, refPath);
        if (!branch) {
          try { await this.transport.request(job.account, "POST", `${api}/git/refs`, { ref: `refs/heads/${job.branch}`, sha: job.headSha }); }
          catch (error) { branch = await this.optional(job, refPath); if (!branch) throw error; }
          branch ??= await this.optional(job, refPath);
        }
        if (branch?.object.sha !== job.headSha) throw new Error("The publication branch changed; it will not be overwritten");
        const existing = await this.findPullRequest(job);
        const pr = existing ?? await this.transport.request<PullRequest>(job.account, "POST", `${api}/pulls`, { title: `Publish Board: ${release.manifest.title}`, head: job.branch, base: job.baseBranch, body: `Publishes the reviewed static artifact \`${job.artifactHash}\`.\n\nRelease: \`${job.releaseId}\`. Only the frozen public files are included; no Board discussions, author state or host credentials. Merge deploys this version through GitHub Pages.` });
        if (pr.head.sha !== job.headSha || pr.base.ref !== job.baseBranch) throw new Error("Existing PR does not match the frozen publication head");
        job.prNumber = pr.number; job.prUrl = pr.html_url; job.status = "pr-open"; delete job.error;
        if (existing && pr.state !== "open") return this.refreshInternal(job);
        return this.save(job);
      } catch (error) { job.status = error instanceof GitHubApiError && error.status < 500 ? "failed" : "unknown"; job.error = safeError(error); return this.save(job); }
    });
  }
  private async findPullRequest(job: PagesJob): Promise<PullRequest | undefined> {
    const prs = await this.transport.request<PullRequest[]>(job.account, "GET", `${this.prefix(job)}/pulls?state=all&head=${encodeURIComponent(job.repository.split("/")[0] + ":" + job.branch)}&per_page=100`);
    if (prs.length > 1) throw new Error("Multiple pull requests use this publication branch; review them manually");
    return prs[0];
  }
  async merge(input: { jobId: string; expectedHead: string }): Promise<PagesJob> {
    return this.exclusive(input.jobId, async () => {
      let job = await this.read(input.jobId);
      if (!job.prNumber || !job.headSha || job.headSha !== input.expectedHead) throw new Error("Confirm the exact prepared publication commit before merging");
      try {
        const api = this.prefix(job), pr = await this.transport.request<PullRequest>(job.account, "GET", `${api}/pulls/${job.prNumber}`);
        if (pr.head.sha !== input.expectedHead || pr.base.ref !== job.baseBranch) throw new Error("The PR head or base changed; this publication will not merge it");
        if (pr.merged || pr.merged_at) return this.refreshInternal(job);
        if (pr.state !== "open") throw new Error("The publication PR is closed without being merged");
        const checks = await this.transport.request<{ workflow_runs: Array<{ id: number; path: string; head_sha: string; status: string; conclusion: string | null }> }>(job.account, "GET", `${api}/actions/runs?head_sha=${job.headSha}&event=pull_request&per_page=100`);
        const check = checks.workflow_runs.filter(run => run.path === WORKFLOW && run.head_sha === job.headSha).sort((a, b) => b.id - a.id)[0];
        if (!check || check.status !== "completed" || check.conclusion !== "success") {
          job.status = "pr-open"; job.error = check?.status === "completed" ? `此固定提交的发布检查未通过（${check.conclusion ?? "unknown"}）；修复或重新运行检查后再合并。` : "此固定提交的发布检查尚未完成；检查成功后再合并。";
          return this.save(job);
        }
        const base = await this.transport.request<{ object: { sha: string } }>(job.account, "GET", `${api}/git/ref/heads/${encodeURIComponent(job.baseBranch!)}`);
        await this.assertOwnership(job, base.object.sha, job.pagesConfigured === true);
        await this.assertOwnership(job, job.headSha);
        let pages = await this.optional<PagesInfo>(job, `${api}/pages`);
        if (pages && job.pagesConfigured && job.pagesConfigurationHash !== pagesConfigurationHash(pages)) throw new Error("Pages configuration changed after confirmation; review the current site before continuing");
        if (!pages) {
          job.pagesConfigurationRequested = true; job = await this.save(job);
          pages = await this.transport.request<PagesInfo>(job.account, "POST", `${api}/pages`, { build_type: "workflow" });
        }
        if (pages.build_type && pages.build_type !== "workflow") throw new Error("Repository Pages uses another publishing source");
        job.pagesConfigured = true; job.pagesConfigurationHash = pagesConfigurationHash(pages); job = await this.save(job);
        const merged = await this.transport.request<{ merged: boolean; sha: string }>(job.account, "PUT", `${api}/pulls/${job.prNumber}/merge`, { sha: input.expectedHead, merge_method: "squash" });
        if (!merged.merged) throw new Error("GitHub did not merge this PR; required checks or repository protection may still be pending");
        job.mergedSha = merged.sha; job.status = "merged"; delete job.error; return this.save(job);
      } catch (error) { job.status = error instanceof GitHubApiError && error.status < 500 ? "failed" : "unknown"; job.error = safeError(error); return this.save(job); }
    });
  }
  refresh(jobId: string): Promise<PagesJob> { return this.exclusive(jobId, async () => this.refreshInternal(await this.read(jobId))); }
  private async refreshInternal(job: PagesJob): Promise<PagesJob> {
    try {
      const api = this.prefix(job), pr = job.prNumber ? await this.transport.request<PullRequest>(job.account, "GET", `${api}/pulls/${job.prNumber}`) : await this.findPullRequest(job);
      if (!pr) { job.status = "prepared"; job.error = "尚未找到发布 PR；可用同一次发布请求重试。"; return this.save(job); }
      if (!job.headSha || pr.head.sha !== job.headSha || pr.base.ref !== job.baseBranch) throw new Error("The PR head or base differs from the frozen publication commit");
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
      if (!pr.merge_commit_sha) throw new Error("GitHub has not reported the merged commit yet");
      job.mergedSha = pr.merge_commit_sha; job.status = "deploying";
      const runs = await this.transport.request<{ workflow_runs: Array<{ id: number; head_sha: string; head_branch: string; event: string; status: string; conclusion: string | null }> }>(job.account, "GET", `${api}/actions/workflows/paseo-board-pages.yml/runs?head_sha=${job.mergedSha}&per_page=100`);
      const run = runs.workflow_runs.filter(run => run.head_sha === job.mergedSha && run.head_branch === job.baseBranch && ["push", "workflow_dispatch"].includes(run.event)).sort((a, b) => b.id - a.id)[0];
      if (run) job.deploymentId = String(run.id);
      if (!run || run.status !== "completed") { delete job.error; return this.save(job); }
      if (run.conclusion !== "success") { job.status = "failed"; job.error = `GitHub Pages workflow finished: ${run.conclusion ?? "unknown"}`; return this.save(job); }
      const pages = await this.transport.request<PagesInfo>(job.account, "GET", `${api}/pages`);
      if (pages.cname) { job.error = "自定义域名需要额外验证；当前尚未确认线上版本。"; return this.save(job); }
      const url = new URL(pages.html_url.endsWith("/") ? pages.html_url : pages.html_url + "/");
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== `${job.repository.split("/")[0].toLowerCase()}.github.io` || url.username || url.password || url.port) throw new Error("GitHub returned an unexpected Pages URL");
      const release = await this.releases.read(job.releaseId), suffix = `?paseo_release=${job.artifactHash}`;
      const results = await Promise.all(Object.entries(release.files).map(async ([path, expected]) => ({ path, expected, actual: await this.transport.publicFile(new URL(path + suffix, url).href) })));
      if (results.some(file => file.actual !== file.expected)) { job.error = "站点暂未展示此发布版本；继续刷新可核对部署结果。"; return this.save(job); }
      job.status = "live"; job.url = url.href; job.verifiedAt = new Date().toISOString(); delete job.error; return this.save(job);
    } catch (error) { job.status = "unknown"; job.error = safeError(error); return this.save(job); }
  }
}
