import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { ReleaseRepository, sha256, type StaticRelease } from "./static-release";
import { GitHubApiError, GitHubPagesManager, pagesWorkflow, parseGitHubAccounts, type GitHubTransport } from "./github-pages";
import type { PagesPrepareInput } from "../shared/release-contracts";

type Pr = { number: number; html_url: string; state: string; merged: boolean; merge_commit_sha: string | null; head: { sha: string; ref: string }; base: { ref: string } };
class FakeGitHub implements GitHubTransport {
  calls: Array<{ account: string; method: string; path: string; body?: unknown; githubHost?: string }> = [];
  base = "a".repeat(40); exists = true; private = false;
  branches = new Map([["main", this.base]]); trees = new Map<string, Record<string, string>>([["base-tree", { "README.md": "Unrelated repository file" }]]);
  commits = new Map([[this.base, "base-tree"]]); parents = new Map<string, string[]>([[this.base, []]]); prs: Pr[] = [];
  pages: { html_url: string; build_type: string; cname?: string; source?: {branch: string; path: string} } | undefined;
  runs: Array<{ id: number; head_sha: string; status: string; conclusion: string | null }> = [];
  builds: Array<{ url: string; commit: string; status: string }> = [];
  legacyChecks: Array<{ status: string; conclusion: string | null }> = []; legacyStatus = { total_count: 0, state: "pending" };
  checkStatus = "completed"; checkConclusion: string | null = "success";
  lost = new Set<string>(); failBefore = new Set<string>(); publication: Record<string, string> = {}; publicRequests: string[] = [];
  /** Full URL pathname -> bytes served by Pages; when set, publicFile is path-aware. */
  served?: Map<string, string>;
  async accounts() { return [{ login: "writer", host: "github.com" as const, active: true }]; }
  failAfter(path: string) { this.lost.add(path); }
  after(path: string) { if (this.lost.delete(path)) throw new GitHubApiError(503); }
  files(ref: string) { return this.trees.get(this.commits.get(this.branches.get(ref) ?? ref) ?? "") ?? {}; }
  async request<T>(account: string, method: string, path: string, body?: unknown, githubHost?: string): Promise<T> {
    this.calls.push({ account, method, path, body, githubHost }); const url = new URL(path, "https://api.github.com"), p = url.pathname;
    const payload = body as Record<string, unknown>;
    const output = (value: unknown) => structuredClone(value) as T;
    if (p === "/user/repos" && method === "GET") return output([{ full_name: "writer/site", private: this.private, html_url: "https://github.com/writer/site", permissions: { push: true } }, { full_name: "reader/readonly", private: false, html_url: "https://github.com/reader/readonly", permissions: { push: false } }]);
    if (p === "/user/repos" && method === "POST") { this.exists = true; this.private = payload.private === true; this.after(p); return output({ full_name: "writer/site", private: this.private, default_branch: "main", permissions: { push: true } }); }
    if (p === "/repos/writer/site") { if (!this.exists) throw new GitHubApiError(404); return output({ full_name: "writer/site", private: this.private, default_branch: "main", permissions: { push: true } }); }
    const part = p.replace("/repos/writer/site", "");
    if (method !== "GET" && this.failBefore.delete(part)) throw new GitHubApiError(503);
    if (part.startsWith("/contents/")) {
      const key = decodeURIComponent(part.slice(10)), files = this.files(url.searchParams.get("ref") ?? "main");
      if (Object.hasOwn(files, key)) return output({ type: "file", encoding: "base64", content: Buffer.from(files[key]).toString("base64") });
      // Directory listings hold direct children only, with dir entries for nested directories.
      const children = new Map<string, string>();
      for (const name of Object.keys(files)) if (name.startsWith(key + "/")) { const rest = name.slice(key.length + 1); children.set(rest.split("/")[0], rest.includes("/") ? "dir" : "file"); }
      if (children.size) return output([...children].map(([name, type]) => ({ name, path: `${key}/${name}`, type, ...(type === "file" ? { sha: blob(files[`${key}/${name}`]) } : {}) })));
      throw new GitHubApiError(404);
    }
    if (part.startsWith("/git/ref/heads/")) { const sha = this.branches.get(decodeURIComponent(part.slice(15))); if (!sha) throw new GitHubApiError(404); return output({ object: { sha } }); }
    if (part === "/git/refs") { const ref = String(payload.ref).slice(11); if (this.branches.has(ref)) throw new GitHubApiError(422); this.branches.set(ref, String(payload.sha)); this.after(part); return output({ object: { sha: payload.sha } }); }
    if (part.startsWith("/git/commits/") && method === "GET") { const tree = this.commits.get(part.slice(13)); if (!tree) throw new GitHubApiError(404); return output({ tree: { sha: tree }, parents: (this.parents.get(part.slice(13)) ?? []).map(sha => ({sha})) }); }
    if (part.startsWith("/git/trees/")) {
      const ref = part.slice(11), files = this.trees.get(ref) ?? this.files(ref);
      return output({ sha: ref, truncated: false, tree: Object.entries(files).map(([path, text]) => ({ path, mode: "100644", type: "blob", sha: blob(text) })) });
    }
    if (part === "/git/trees") {
      const files = { ...(this.trees.get(String(payload.base_tree)) ?? {}) };
      for (const entry of payload.tree as Array<{ path: string; content: string }>) files[entry.path] = entry.content;
      const sha = sha256(JSON.stringify(files)).slice(0, 40); this.trees.set(sha, files); return output({ sha });
    }
    if (part === "/git/commits") { const sha = sha256(JSON.stringify(payload)).slice(0, 40); this.commits.set(sha, String(payload.tree)); this.parents.set(sha, payload.parents as string[]); this.after(part); return output({ sha }); }
    if (part === "/pulls" && method === "GET") return output(this.prs.filter(pr => "writer:" + pr.head.ref === url.searchParams.get("head")));
    if (part === "/pulls" && method === "POST") {
      const pr: Pr = { number: this.prs.length + 1, html_url: "https://github.com/writer/site/pull/1", state: "open", merged: false, merge_commit_sha: null, head: { sha: this.branches.get(String(payload.head))!, ref: String(payload.head) }, base: { ref: String(payload.base) } };
      this.prs.push(pr); this.after(part); return output(pr);
    }
    if (/^\/pulls\/\d+$/.test(part)) return output(this.prs[Number(part.split("/")[2]) - 1]);
    if (/^\/pulls\/\d+\/merge$/.test(part)) {
      const pr = this.prs[Number(part.split("/")[2]) - 1]; if (pr.head.sha !== payload.sha) throw new GitHubApiError(409);
      pr.state = "closed"; pr.merged = true; pr.merge_commit_sha = sha256(pr.head.sha + "merged").slice(0, 40); this.commits.set(pr.merge_commit_sha, this.commits.get(pr.head.sha)!); this.branches.set(pr.base.ref, pr.merge_commit_sha); this.after(part);
      return output({ merged: true, sha: pr.merge_commit_sha });
    }
    if (part === "/pages/builds") return output(this.builds);
    if (/^\/commits\/.+\/check-runs$/.test(part)) return output({total_count: this.legacyChecks.length, check_runs: this.legacyChecks});
    if (/^\/commits\/.+\/status$/.test(part)) return output(this.legacyStatus);
    if (part === "/pages") {
      if (method === "POST") { this.pages = { html_url: githubHost && githubHost !== "github.com" ? `https://pages.${githubHost}/writer/site/` : "https://writer.github.io/site/", build_type: String(payload.build_type), ...(payload.source ? {source:payload.source as {branch:string;path:string}} : {}) }; this.after(part); }
      if (!this.pages) throw new GitHubApiError(404); return output(this.pages);
    }
    if (part === "/actions/workflows/paseo-board-pages.yml/runs") return output({ workflow_runs: this.runs.filter(run => run.head_sha === url.searchParams.get("head_sha")).map(run => ({ event: "push", head_branch: "main", ...run })) });
    if (part === "/actions/runs") {
      // The workflow's pull_request path filter: no run when the PR changes nothing it watches.
      const head = url.searchParams.get("head_sha")!, parent = this.parents.get(head)?.[0], after = this.files(head), before = parent ? this.files(parent) : {};
      const watched = (name: string) => name.startsWith("paseo-board-publication/") || name === ".github/workflows/paseo-board-pages.yml";
      const changed = !parent || [...new Set([...Object.keys(after), ...Object.keys(before)])].some(name => watched(name) && after[name] !== before[name]);
      return output({ workflow_runs: changed ? [{ id: 10, path: ".github/workflows/paseo-board-pages.yml", head_sha: head, status: this.checkStatus, conclusion: this.checkConclusion }] : [] });
    }
    throw new Error(`Unhandled fake GitHub request: ${method} ${path}`);
  }
  async publicFile(url: string) {
    this.publicRequests.push(url);
    if (this.served) { const text = this.served.get(new URL(url).pathname); if (text === undefined) throw new GitHubApiError(404); return text; }
    const file = new URL(url).pathname.split("/").at(-1)!; if (!Object.hasOwn(this.publication, file)) throw new GitHubApiError(404); return this.publication[file];
  }
  /** Deploys the Pages source as it is now: every merged commit built, served by full path. */
  deploy() {
    const merged = this.prs.filter(pr => pr.merged).map(pr => pr.merge_commit_sha!);
    this.builds = merged.map((commit, index) => ({ url: `https://api.github.com/build/${index}`, commit, status: "built" }));
    this.runs = merged.map((head_sha, index) => ({ id: index + 1, head_sha, status: "completed", conclusion: "success" }));
    const pages = this.pages!, prefix = new URL(pages.html_url.endsWith("/") ? pages.html_url : pages.html_url + "/").pathname;
    this.served = new Map();
    for (const [path, text] of Object.entries(this.files(pages.source?.branch ?? "main"))) {
      const relative = pages.build_type === "workflow" ? path.startsWith("paseo-board-publication/site/") ? path.slice(29) : undefined
        : pages.source?.path === "/docs" ? path.startsWith("docs/") ? path.slice(5) : undefined : path;
      if (relative !== undefined) this.served.set(prefix + relative, text);
    }
  }
}
const blob = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

describe("resumable GitHub Pages publication", () => {
  let root: string, releases: ReleaseRepository, release: StaticRelease, github: FakeGitHub, manager: GitHubPagesManager, input: PagesPrepareInput;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "board-pages-test-")); releases = new ReleaseRepository(join(root, "releases"));
    const board = await new BoardStore(join(root, "boards")).create({ id: "PRIVATE_BOARD", title: "Public page", html: '<button onclick="this.textContent=42">Interactive</button>', data: { secret: "PRIVATE_SECRET" } });
    release = await releases.create({ board, boardId: board.id, expectedCanvasBase: { revision: 1, documentVersion: 1 }, publicData: {} });
    github = new FakeGitHub(); manager = new GitHubPagesManager(join(root, "jobs"), releases, github);
    input = { eventId: "publish-fixture", releaseId: release.manifest.releaseId, artifactHash: release.manifest.artifactHash, account: "writer", repository: "writer/site" };
  });
  afterEach(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });

  it("lists selected identities and writable repositories without switching accounts", async () => {
    expect(await manager.accounts()).toEqual([{ login: "writer", host: "github.com", active: true }]);
    expect(await manager.repositories("writer")).toEqual([{ name: "writer/site", private: false, url: "https://github.com/writer/site" }]);
    expect(github.calls.every(call => call.account === "writer")).toBe(true);
  });
  it("supports installed older gh auth status without exposing credential details", () => {
    const accounts = parseGitHubAccounts("github.com\n ✓ Logged in to github.com account writer (keyring)\n - Active account: true\n - Token: NEVER_RETURN_ME\n ✓ Logged in to github.com account colleague (keyring)\n - Active account: false\n");
    expect(accounts).toEqual([{ login: "writer", host: "github.com", active: true }, { login: "colleague", host: "github.com", active: false }]); expect(JSON.stringify(accounts)).not.toContain("NEVER_RETURN_ME");
    expect(parseGitHubAccounts("Logged in to github.com as legacy (keyring)\n")).toEqual([{ login: "legacy", host: "github.com", active: true }]);
  });
  it("prepares one reviewable PR of only frozen public files and preserves unrelated repository files", async () => {
    const job = await manager.prepare(input); expect(job.status, job.error).toBe("pr-open"); expect(job.headSha).toHaveLength(40);
    const files = github.files(job.headSha!); expect(files["README.md"]).toBe("Unrelated repository file");
    expect(JSON.stringify(github.calls.filter(call => call.method === "POST"))).not.toContain("PRIVATE_BOARD"); expect(JSON.stringify(files)).not.toContain("PRIVATE_SECRET");
    expect(files["paseo-board-publication/site/index.html"]).toBe(release.files["index.html"]);
    expect(github.pages).toBeUndefined(); expect(github.prs[0].merged).toBe(false);
    expect((await manager.prepare(input)).prNumber).toBe(job.prNumber); expect(github.prs).toHaveLength(1);
    expect(await manager.list(input.releaseId)).toHaveLength(1);
  });
  it("resumes a lost PR response and never duplicates the branch/PR", async () => {
    github.failAfter("/pulls"); const unknown = await manager.prepare(input); expect(unknown.status).toBe("unknown"); expect(github.prs).toHaveLength(1);
    const restarted = new GitHubPagesManager(join(root, "jobs"), releases, github);
    expect((await restarted.refresh(unknown.jobId)).status).toBe("pr-open"); expect(github.prs).toHaveLength(1);
    expect((await restarted.prepare(input)).status).toBe("pr-open"); expect(github.calls.filter(call => call.method === "POST" && call.path.endsWith("/pulls"))).toHaveLength(1);
  });
  it("recovers a lost branch creation and refuses a reused event with changed payload", async () => {
    github.failAfter("/git/refs"); const job = await manager.prepare(input); expect(job.status, job.error).toBe("pr-open");
    await expect(manager.prepare({ ...input, repository: "writer/other" })).rejects.toThrow("different artifact");
    await expect(manager.prepare({ ...input, artifactHash: "f".repeat(64) })).rejects.toThrow("different artifact");
  });
  it("serializes concurrent same-event prepares into one PR", async () => {
    const second = new GitHubPagesManager(join(root, "jobs"), releases, github);
    const [a, b] = await Promise.all([manager.prepare(input), second.prepare(input)]);
    expect(a.status).toBe("pr-open"); expect(b.prNumber).toBe(a.prNumber); expect(github.prs).toHaveLength(1);
  });
  it("requires explicit repository creation and recovers a lost creation response", async () => {
    github.exists = false; expect((await manager.prepare(input)).error).toContain("does not exist"); expect(github.calls.some(call => call.method === "POST" && call.path === "/user/repos")).toBe(false);
    const create = { ...input, eventId: "create", createRepository: "public" as const }; github.failAfter("/user/repos");
    expect((await manager.prepare(create)).status).toBe("unknown"); expect((await manager.prepare(create)).status).toBe("pr-open");
    expect(github.calls.filter(call => call.method === "POST" && call.path === "/user/repos")).toHaveLength(1);
  });
  it("refuses an unrelated existing Pages site and reserved directory", async () => {
    github.pages = { html_url: "https://writer.github.io/site/", build_type: "legacy" };
    expect((await manager.prepare(input)).error).toContain("already has a Pages"); expect(github.prs).toHaveLength(0);
    github.pages = undefined; github.trees.get("base-tree")!["paseo-board-publication/unrelated.txt"] = "Keep";
    expect((await manager.prepare({ ...input, eventId: "directory" })).error).toContain("unrelated");
  });
  it("does not merge a changed PR head or a caller's stale confirmation", async () => {
    const job = await manager.prepare(input);
    await expect(manager.merge({ jobId: job.jobId, expectedHead: "b".repeat(40) })).rejects.toThrow("exact prepared");
    github.prs[0].head.sha = "c".repeat(40);
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).error).toContain("head or base changed");
    expect(github.calls.some(call => call.method === "PUT")).toBe(false); expect(github.pages).toBeUndefined();
  });
  it("does not take over a Pages site introduced between PR preparation and merge", async () => {
    const job = await manager.prepare(input); github.pages = { html_url: "https://writer.github.io/site/", build_type: "workflow" };
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).error).toContain("already has a Pages");
    expect(github.calls.some(call => call.method === "PUT")).toBe(false);
  });
  it("does not infer ownership from an uncertain Pages setup response", async () => {
    const job = await manager.prepare(input); github.failAfter("/pages");
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).status).toBe("unknown");
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).error).toContain("already has a Pages");
    expect((await manager.refresh(job.jobId)).error).toContain("请先核对站点归属");
    expect(github.calls.some(call => call.method === "PUT")).toBe(false);
  });
  it("does not adopt a different actor's site after an unexecuted Pages request", async () => {
    const job = await manager.prepare(input); github.failBefore.add("/pages");
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).status).toBe("unknown"); expect(github.pages).toBeUndefined();
    github.pages = { html_url: "https://writer.github.io/site/", build_type: "workflow" };
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).error).toContain("already has a Pages");
    expect(github.calls.some(call => call.method === "PUT")).toBe(false);
  });
  it("does not continue a confirmed setup after the remote URL or custom domain changed", async () => {
    const job = await manager.prepare(input); github.failBefore.add("/pulls/1/merge");
    const uncertain = await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! }); expect(uncertain.pagesConfigured).toBe(true); expect(uncertain.status).toBe("unknown");
    github.pages!.cname = "changed.example";
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).error).toContain("configuration changed"); expect(github.prs[0].merged).toBe(false);
    expect(github.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  });
  it("recovers a lost merge response using the same frozen commit", async () => {
    const job = await manager.prepare(input);
    github.failAfter("/pulls/1/merge"); expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).status).toBe("unknown");
    const resumed = await manager.refresh(job.jobId); expect(resumed.status).toBe("deploying"); expect(resumed.mergedSha).toBe(github.prs[0].merge_commit_sha);
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).status).toBe("deploying");
    expect(github.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  });
  it("waits for exact-head successful PR verification even without branch protection", async () => {
    const job = await manager.prepare(input);
    github.checkStatus = "in_progress"; github.checkConclusion = null;
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).error).toContain("尚未完成");
    github.checkStatus = "completed"; github.checkConclusion = "failure";
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).error).toContain("未通过");
    expect(github.pages).toBeUndefined(); expect(github.calls.some(call => call.method === "PUT")).toBe(false);
  });
  it("rejects a modified workflow even if its ownership file claims the matching new hash", async () => {
    const job = await manager.prepare(input), files = github.files(job.headSha!);
    files[".github/workflows/paseo-board-pages.yml"] += "# externally modified\n";
    const owner = JSON.parse(files["paseo-board-publication/owner.json"]); owner.workflowHash = sha256(files[".github/workflows/paseo-board-pages.yml"]); files["paseo-board-publication/owner.json"] = JSON.stringify(owner);
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).error).toContain("changed outside");
    expect(github.calls.some(call => call.method === "PUT")).toBe(false);
  });
  it("reports failed/pending deployments and marks live only after exact public bytes are verified", async () => {
    const job = await manager.prepare(input), merged = await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! }); expect(merged.status, merged.error).toBe("merged");
    expect((await manager.refresh(job.jobId)).status).toBe("deploying");
    github.runs = [{ id: 1, head_sha: merged.mergedSha!, status: "completed", conclusion: "failure" }]; expect((await manager.refresh(job.jobId)).status).toBe("failed");
    github.runs[0].conclusion = "success"; github.publication = { ...release.files, "index.html": "Old version" };
    expect((await manager.refresh(job.jobId)).status).toBe("deploying");
    github.publication = release.files; const live = await manager.refresh(job.jobId); expect(live.status, live.error).toBe("live"); expect(live.url).toBe("https://writer.github.io/site/"); expect(live.verifiedAt).toBeTruthy();
    github.publication = { ...release.files, "NOTICE": "Changed attribution" }; expect((await manager.refresh(job.jobId)).status).not.toBe("live");
    github.publication = { ...release.files, "index.html": "Changed again" }; expect((await manager.refresh(job.jobId)).status).not.toBe("live");
  });
  it("refuses untrusted or changed Pages configurations before fetching bytes", async () => {
    const job = await manager.prepare(input), merged = await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! }); github.runs = [{ id: 1, head_sha: merged.mergedSha!, status: "completed", conclusion: "success" }];
    github.pages = { html_url: "http://127.0.0.1:6767/", build_type: "workflow" };
    expect((await manager.refresh(job.jobId)).status).toBe("failed"); expect(github.publicRequests).toHaveLength(0);
    github.pages = { html_url: "https://custom.example", build_type: "workflow", cname: "custom.example" };
    expect((await manager.refresh(job.jobId)).status).toBe("failed"); expect(github.publicRequests).toHaveLength(0);
  });
  it("qualifies repository discovery and every mutation with the selected Enterprise host", async () => {
    input.githubHost = "github.enterprise.example";
    await manager.repositories("writer", input.githubHost);
    const job = await manager.prepare(input); expect(job.status, job.error).toBe("pr-open"); expect(job.publicationMode).toBe("legacy-branch");
    const files = github.files(job.headSha!);
    expect(files[`docs/boards/${release.manifest.releaseId.slice(8)}/index.html`]).toBe(release.files["index.html"]);
    expect(files["docs/.nojekyll"]).toBe(""); expect(files["README.md"]).toBe("Unrelated repository file");
    expect(Object.keys(files).some(name => name.startsWith(".github/"))).toBe(false);
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).status).toBe("merged");
    expect(github.pages).toBeUndefined(); // /docs must exist on the source before configuration.
    const pending = await manager.refresh(job.jobId); expect(pending.status, pending.error).toBe("deploying");
    expect(github.pages).toMatchObject({build_type:"legacy",source:{branch:"main",path:"/docs"}});
    github.builds = [{url:"https://github.enterprise.example/api/v3/builds/1",commit:github.prs[0].merge_commit_sha!,status:"built"}]; github.publication = release.files;
    const live = await manager.refresh(job.jobId); expect(live.status,live.error).toBe("live");
    expect(live.url).toBe(`https://pages.github.enterprise.example/writer/site/boards/${release.manifest.releaseId.slice(8)}/`);
    expect(github.calls.every(call => call.githubHost === input.githubHost)).toBe(true);
    expect(github.calls.some(call => call.path.includes("/actions/"))).toBe(false);
  });
  it("retains workflow behavior for old journal records without publicationMode", async () => {
    const job = await manager.prepare(input); delete job.publicationMode;
    await writeFile(join(root,"jobs",`${job.jobId}.json`),JSON.stringify(job));
    const restarted = new GitHubPagesManager(join(root,"jobs"),releases,github);
    expect((await restarted.prepare(input)).status).toBe("pr-open");
    const merged = await restarted.merge({jobId:job.jobId,expectedHead:job.headSha!}); expect(merged.status,merged.error).toBe("merged");
    github.runs = [{id:1,head_sha:merged.mergedSha!,status:"completed",conclusion:"success"}]; github.publication=release.files;
    const live = await restarted.refresh(job.jobId); expect(live.status,live.error).toBe("live"); expect(live.url).toBe("https://writer.github.io/site/");
    expect(github.calls.some(call=>call.path.includes("/pages/builds"))).toBe(false);
  });
  it("rejects reusing an event for another GitHub host before any remote call", async () => {
    const job = await manager.prepare(input), count = github.calls.length;
    await expect(manager.prepare({...input,githubHost:"github.enterprise.example"})).rejects.toThrow("different artifact");
    expect(github.calls).toHaveLength(count);
    expect((await manager.prepare({...input,githubHost:"github.com"})).jobId).toBe(job.jobId);
  });
  it("preserves old unqualified journals as github.com through restart and merge", async () => {
    const job = await manager.prepare(input); expect(job.githubHost).toBeUndefined();
    const restarted = new GitHubPagesManager(join(root,"jobs"),releases,github);
    expect((await restarted.prepare({...input,githubHost:"github.com"})).jobId).toBe(job.jobId);
    expect((await restarted.merge({jobId:job.jobId,expectedHead:job.headSha!})).status).toBe("merged");
    expect(github.calls.every(call=>call.githubHost === "github.com")).toBe(true);
  });
  it("refuses to expose existing /docs files when enabling a new Enterprise Pages site", async () => {
    input.githubHost = "github.enterprise.example"; github.trees.get("base-tree")!["docs/internal.md"] = "Private documentation";
    const job = await manager.prepare(input); expect(job.status).toBe("failed"); expect(job.error).toContain("existing files");
    expect(github.calls.some(call=>call.method !== "GET")).toBe(false);
  });
  it("does not add a branch site beside an existing competing Pages deployment workflow", async () => {
    input.githubHost = "github.enterprise.example"; github.trees.get("base-tree")![".github/workflows/custom.yml"] = "uses: actions/deploy-pages@v3";
    const job = await manager.prepare(input); expect(job.status).toBe("failed"); expect(job.error).toContain("Another Pages workflow"); expect(github.calls.some(call=>call.method!=="GET")).toBe(false);
  });
  it("rechecks new source contents after review and refuses branch advancement after merge", async () => {
    input.githubHost = "github.enterprise.example"; const job = await manager.prepare(input);
    github.files("main")["docs/new-private.md"] = "New private file";
    expect((await manager.merge({jobId:job.jobId,expectedHead:job.headSha!})).status).toBe("failed"); expect(github.pages).toBeUndefined();
    delete github.files("main")["docs/new-private.md"];
    const merged = await manager.merge({jobId:job.jobId,expectedHead:job.headSha!}); expect(merged.status,merged.error).toBe("merged");
    github.branches.set("main","b".repeat(40));
    const stopped = await manager.refresh(job.jobId); expect(stopped.status).toBe("failed"); expect(stopped.error).toContain("changed after merge"); expect(github.pages).toBeUndefined();
  });
  it("does not infer ownership after losing the new Enterprise Pages configuration response", async () => {
    input.githubHost = "github.enterprise.example"; const job = await manager.prepare(input);
    await manager.merge({jobId:job.jobId,expectedHead:job.headSha!}); github.failAfter("/pages");
    expect((await manager.refresh(job.jobId)).status).toBe("unknown"); expect(github.pages).toBeTruthy();
    const resumed = await manager.refresh(job.jobId); expect(resumed.status).toBe("failed"); expect(resumed.error).toContain("归属尚未确认");
    expect(github.calls.filter(call=>call.path.endsWith("/pages")&&call.method==="POST")).toHaveLength(1);
  });
  it("does not replace an Enterprise repository's pre-existing workflow publishing source", async () => {
    input.githubHost = "github.enterprise.example"; github.pages = {html_url:"https://pages.github.enterprise.example/writer/site",build_type:"workflow"};
    const job = await manager.prepare(input); expect(job.status).toBe("failed"); expect(job.error).toContain("不会替换"); expect(github.calls.some(call=>call.method!=="GET")).toBe(false);
  });
  it("supports an existing Enterprise custom-domain site and leaves its source unchanged", async () => {
    input.githubHost = "github.enterprise.example"; github.pages = {html_url:"https://boards.internal.example/project/",build_type:"legacy",cname:"boards.internal.example",source:{branch:"main",path:"/"}};
    const before = structuredClone(github.pages), job = await manager.prepare(input), merged = await manager.merge({jobId:job.jobId,expectedHead:job.headSha!});
    github.builds = [{url:"https://github.enterprise.example/api/v3/builds/1",commit:merged.mergedSha!,status:"built"}]; github.publication = release.files;
    const live = await manager.refresh(job.jobId); expect(live.status,live.error).toBe("live"); expect(live.url).toContain("https://boards.internal.example/project/boards/"); expect(github.pages).toEqual(before);
    expect(github.calls.filter(call=>call.path.endsWith("/pages")&&call.method!=="GET")).toHaveLength(0);
  });
  it("keeps an SSO/private Pages deployment unverified instead of sending tokens or claiming live", async () => {
    input.githubHost = "github.enterprise.example"; const job = await manager.prepare(input), merged = await manager.merge({jobId:job.jobId,expectedHead:job.headSha!});
    github.builds = [{url:"https://github.enterprise.example/api/v3/builds/1",commit:merged.mergedSha!,status:"built"}];
    vi.spyOn(github,"publicFile").mockRejectedValue(new GitHubApiError(401));
    const pending = await manager.refresh(job.jobId); expect(pending.status,pending.error).toBe("deploying"); expect(pending.error).toContain("需要公司网络或登录"); expect(pending.url).toBeUndefined(); expect(pending.verifiedAt).toBeUndefined(); expect(pending.deployedUrl).toBe(`https://pages.github.enterprise.example/writer/site/boards/${release.manifest.releaseId.slice(8)}/`);
    github.pages!.source!.branch = "changed"; const changed = await manager.refresh(job.jobId);
    expect(changed.status).toBe("failed"); expect(changed.deployedUrl).toBeUndefined(); expect(changed.url).toBeUndefined();
  });
  it("generates a Pages workflow with read-only PR validation and no authored-code build step", () => {
    const workflow = pagesWorkflow("main"); expect(workflow).toContain("if: github.event_name != 'pull_request'"); expect(workflow).toContain("pages: write"); expect(workflow).toContain("id-token: write"); expect(workflow).toContain("${{ steps.deployment.outputs.page_url }}"); expect(workflow).not.toContain("npm install"); expect(workflow).toContain("Artifact mismatch");
  });
  function legacy(sourcePath: "/" | "/docs" = "/", branch = "main") {
    github.pages = { html_url: "https://writer.github.io/site/", build_type: "legacy", source: { branch, path: sourcePath } };
    github.branches.set(branch, github.base);
    Object.assign(github.trees.get("base-tree")!, { "index.html": "Existing home", "pages/keystone-snow-week/index.html": "Existing trip", ".nojekyll": "" });
  }
  it("publishes an existing legacy site into a release directory without replacing its homepage, other pages or configuration", async () => {
    legacy(); const before = structuredClone(github.files("main")), config = structuredClone(github.pages);
    const job = await manager.prepare(input); expect(job.status, job.error).toBe("pr-open"); expect(job.publicationMode).toBe("legacy-subdirectory");
    expect(job.sitePath).toBe(`boards/${release.manifest.releaseId.slice(8)}`);
    const files = github.files(job.headSha!); for (const [path, text] of Object.entries(before)) expect(files[path]).toBe(text);
    expect(Object.keys(files).filter(path => !Object.hasOwn(before, path)).sort()).toEqual(Object.keys(release.files).map(path => `${job.sitePath}/${path}`).sort());
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).status).toBe("merged");
    expect(github.pages).toEqual(config); expect(github.calls.filter(call => call.path.endsWith("/pages") && call.method !== "GET")).toHaveLength(0);
    expect(github.calls.some(call => call.path.includes("/actions/"))).toBe(false);
  });
  it("uses the actual non-default source branch and /docs directory without introducing global .nojekyll changes", async () => {
    legacy("/docs", "site"); delete github.trees.get("base-tree")![".nojekyll"];
    const job = await manager.prepare(input); expect(job.baseBranch).toBe("site"); expect(job.sourcePath).toBe("/docs");
    expect(github.files(job.headSha!)[`docs/${job.sitePath}/index.html`]).toBe(release.files["index.html"]);
    expect(github.files(job.headSha!)[".nojekyll"]).toBeUndefined(); expect(github.files(job.headSha!)["docs/.nojekyll"]).toBeUndefined();
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).status).toBe("merged");
    expect(github.branches.get("main")).toBe(github.base);
  });
  it("refuses an occupied release directory, a symlink-like parent, and source configuration changes before merge", async () => {
    legacy(); github.trees.get("base-tree")!.boards = "Not a directory";
    expect((await manager.prepare(input)).error).toContain("non-directory parent"); expect(github.prs).toHaveLength(0);
    delete github.trees.get("base-tree")!.boards;
    github.trees.get("base-tree")![`boards/${release.manifest.releaseId.slice(8)}/private.txt`] = "Unrelated";
    expect((await manager.prepare(input)).error).toContain("unrelated files"); expect(github.prs).toHaveLength(0);
    delete github.trees.get("base-tree")![`boards/${release.manifest.releaseId.slice(8)}/private.txt`];
    const job = await manager.prepare(input); github.pages!.source!.path = "/docs";
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).status).toBe("failed"); expect(github.prs[0].merged).toBe(false);
  });
  it("verifies the complete frozen PR tree and refuses extra changes or altered public content before merge", async () => {
    legacy(); const job = await manager.prepare(input), files = github.files(job.headSha!);
    files["index.html"] = "Unexpected takeover";
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).error).toContain("PR diff");
    files["index.html"] = "Existing home"; files[`${job.sitePath}/index.html`] = "Changed public artifact";
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).error).toContain("PR diff"); expect(github.prs[0].merged).toBe(false);
  });
  it("waits for actual pending legacy checks, stops on failures, and never treats an empty pending status as a check", async () => {
    legacy(); const job = await manager.prepare(input);
    github.legacyChecks = [{ status: "in_progress", conclusion: null }];
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).status).toBe("pr-open"); expect(github.prs[0].merged).toBe(false);
    github.legacyChecks = [{ status: "completed", conclusion: "failure" }];
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).status).toBe("failed"); expect(github.prs[0].merged).toBe(false);
    github.legacyChecks = [];
    expect((await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! })).status).toBe("merged");
  });
  it("verifies the matching legacy build and every file at the exact hosted subdirectory, tolerating CDN propagation", async () => {
    legacy(); const job = await manager.prepare(input), merged = await manager.merge({ jobId: job.jobId, expectedHead: job.headSha! });
    github.builds = [{ url: "https://api.github.com/build/1", commit: "0".repeat(40), status: "built" }];
    expect((await manager.refresh(job.jobId)).status).toBe("deploying"); expect(github.publicRequests).toHaveLength(0);
    github.builds[0].commit = merged.mergedSha!;
    expect((await manager.refresh(job.jobId)).status).toBe("deploying");
    github.publication = release.files; const live = await manager.refresh(job.jobId);
    expect(live.status, live.error).toBe("live"); expect(live.url).toBe(`https://writer.github.io/site/${job.sitePath}/`);
    expect(github.publicRequests.every(url => new URL(url).pathname.startsWith(`/site/${job.sitePath}/`))).toBe(true);
    github.pages!.source!.branch = "elsewhere"; expect((await manager.refresh(job.jobId)).status).toBe("failed");
  });
  it("durably authorizes one-click publication, resumes after manager loss, and leaves prepare-only jobs inert", async () => {
    legacy(); const manual = await manager.prepare({ ...input, eventId: "manual" });
    const queued = await manager.publish(input); expect(queued.autoPublish).toBe(true); expect(queued.prNumber).toBeUndefined(); await manager.close();
    manager = new GitHubPagesManager(join(root, "jobs"), releases, github);
    await manager.advanceAutomatic(); const merged = await manager.read(queued.jobId);
    expect(merged.status, merged.error).toBe("deploying"); expect(github.prs.find(pr => pr.number === manual.prNumber)!.merged).toBe(false);
    github.builds = [{ url: "https://api.github.com/build/1", commit: merged.mergedSha!, status: "built" }]; github.publication = release.files;
    await manager.advanceAutomatic(); expect((await manager.read(queued.jobId)).status).toBe("live");
    expect(github.calls.filter(call => call.method === "PUT")).toHaveLength(1);
    await manager.advanceAutomatic(); expect(github.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  });
  it("stops an expired automatic window without mutating GitHub and requires the original explicit request to resume", async () => {
    legacy(); const job = await manager.publish(input); await manager.close();
    await writeFile(join(root, "jobs", `${job.jobId}.json`), JSON.stringify({ ...job, autoPublishUntil: "2000-01-01T00:00:00.000Z" }));
    manager = new GitHubPagesManager(join(root, "jobs"), releases, github);
    await manager.advanceAutomatic(); const expired = await manager.read(job.jobId); expect(expired.autoPublish).toBe(false); expect(github.calls).toHaveLength(0);
    await expect(manager.publish({ ...input, repository: "writer/other" })).rejects.toThrow("different artifact");
    const resumed = await manager.publish(input); expect(resumed.jobId).toBe(job.jobId); expect(resumed.autoPublish).toBe(true);
  });
  it("stops idle disk polling and restarts its durable runner only after an explicitly authorized request", async () => {
    vi.useFakeTimers();
    try {
      const list = vi.spyOn(manager, "list").mockResolvedValue([]); manager.start(); await vi.runOnlyPendingTimersAsync();
      const idleReads = list.mock.calls.length; expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000); expect(list).toHaveBeenCalledTimes(idleReads);
      await manager.close(); list.mockRestore();
      legacy(); manager = new GitHubPagesManager(join(root, "jobs"), releases, github);
      const queued = await manager.publish(input); await manager.close();
      manager = new GitHubPagesManager(join(root, "jobs"), releases, github);
      let entered!: () => void, release!: () => void;
      const atTreeWrite = new Promise<void>(resolve => { entered = resolve; });
      const holdTreeWrite = new Promise<void>(resolve => { release = resolve; });
      const request = github.request.bind(github);
      github.request = async <T>(account: string, method: string, path: string, body?: unknown): Promise<T> => {
        if (method === "POST" && path.endsWith("/git/trees")) { entered(); await holdTreeWrite; }
        return request<T>(account, method, path, body);
      };
      manager.start(); await vi.runOnlyPendingTimersAsync(); await atTreeWrite;
      const closing = manager.close(); release(); await closing; github.request = request;
      const resumed = await manager.read(queued.jobId); expect(resumed.status, resumed.error).toBe("pr-open");
      expect(github.prs).toHaveLength(1); expect(github.prs[0].merged).toBe(false);
      // Shutdown completed the pending prepare, then stopped before the merge mutation.
      manager = new GitHubPagesManager(join(root, "jobs"), releases, github);
      await manager.advanceAutomatic(); expect((await manager.read(queued.jobId)).status).toBe("deploying");
    } finally { vi.useRealTimers(); }
  });
});

describe("share series: one stable link per Board, versions archived", () => {
  const key = "s" + "1".repeat(20), host = "github.enterprise.example";
  let root: string, releases: ReleaseRepository, store: BoardStore, github: FakeGitHub, manager: GitHubPagesManager;
  const open = () => { const next = new GitHubPagesManager(join(root, "jobs"), releases, github); vi.spyOn(next, "start").mockImplementation(() => {}); return next; };
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-10T00:00:00.000Z") });
    root = await mkdtemp(join(tmpdir(), "board-share-series-")); releases = new ReleaseRepository(join(root, "releases"));
    store = new BoardStore(join(root, "boards"));
    await store.create({ id: "SHARED_BOARD", title: "Shared", html: "<p>Shared page</p>", data: { secret: "PRIVATE_SECRET" } });
    github = new FakeGitHub(); manager = open();
  });
  afterEach(async () => { await manager.close(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }); });
  const tick = () => vi.setSystemTime(Date.now() + 60_000);
  /** A release of the Board's current source; `text` first appends an authored patch. */
  async function version(text?: string, boardId = "SHARED_BOARD"): Promise<StaticRelease> {
    let board = (await store.read(boardId))!;
    if (text) board = await store.publish({ boardId, expectedRevision: board.revision, eventId: "patch-" + text, canvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, patch: { id: text, selector: "p", operation: "append", html: `<b>${text}</b>` } });
    return releases.create({ board, boardId, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, publicData: {} });
  }
  const request = (release: StaticRelease, eventId: string, extra: Partial<PagesPrepareInput> = {}): PagesPrepareInput =>
    ({ eventId, releaseId: release.manifest.releaseId, artifactHash: release.manifest.artifactHash, account: "writer", repository: "writer/site", shareKey: key, ...extra });
  /** One click: authorize, then one automatic pass (prepare, merge, first refresh). */
  async function publish(input: PagesPrepareInput) { tick(); const job = await manager.publish(input); await manager.advanceAutomatic(); return manager.read(job.jobId); }
  async function deployed(jobId: string) { github.deploy(); await manager.advanceAutomatic(); return manager.read(jobId); }
  function legacy(sourcePath: "/" | "/docs" = "/", branch = "main") {
    github.pages = { html_url: "https://writer.github.io/site/", build_type: "legacy", source: { branch, path: sourcePath } };
    github.branches.set(branch, github.base);
    Object.assign(github.trees.get("base-tree")!, { "index.html": "Existing home", "pages/trip/index.html": "Existing trip" });
  }
  const hex = (release: StaticRelease) => release.manifest.releaseId.slice(8);
  const filesAt = (directory: string, ref = "main") => Object.fromEntries(Object.entries(github.files(ref)).filter(([path]) => path.startsWith(directory + "/") && !path.slice(directory.length + 1).includes("/")).map(([path, text]) => [path.slice(directory.length + 1), text]));

  it.each([
    ["existing branch site at /", "/", ""],
    ["existing branch site at /docs", "/docs", "docs/"],
    ["new Enterprise branch site", "ghes", "docs/"],
  ] as const)("publishes a new series to a stable directory plus a version archive (%s)", async (_, source, prefix) => {
    if (source !== "ghes") legacy(source, source === "/docs" ? "site" : "main");
    const extra = source === "ghes" ? { githubHost: host } : {}, branch = source === "/docs" ? "site" : "main";
    const release = await version(), job = await publish(request(release, "first", extra));
    expect(job.status, job.error).toBe("deploying"); expect(job.publicationMode).toBe(source === "ghes" ? "legacy-branch" : "legacy-subdirectory");
    expect(job).toMatchObject({ sharePath: `boards/${key}`, sitePath: `boards/${key}/v/${hex(release)}` });
    expect(filesAt(`${prefix}boards/${key}`, branch)).toEqual(release.files);
    expect(filesAt(`${prefix}boards/${key}/v/${hex(release)}`, branch)).toEqual(release.files);
    if (source === "ghes") expect(github.files("main")["docs/.nojekyll"]).toBe(""); else expect(github.files(branch)["index.html"]).toBe("Existing home");
    const live = await deployed(job.jobId), site = source === "ghes" ? `https://pages.${host}/writer/site/` : "https://writer.github.io/site/";
    expect(live.status, live.error).toBe("live");
    expect(live).toMatchObject({ url: `${site}boards/${key}/v/${hex(release)}/`, deployedUrl: `${site}boards/${key}/v/${hex(release)}/`, shareUrl: `${site}boards/${key}/`, shareDeployedUrl: `${site}boards/${key}/` });
    expect(JSON.stringify(github.files(branch))).not.toContain("PRIVATE_SECRET");
  });

  it("updates the same share link and keeps every version archived and verified", async () => {
    legacy(); const first = await version(), one = await deployed((await publish(request(first, "first"))).jobId);
    const second = await version("two"), two = await deployed((await publish(request(second, "second"))).jobId);
    expect(two.status, two.error).toBe("live"); expect(two.shareUrl).toBe(one.shareUrl);
    expect(two.url).toBe(`https://writer.github.io/site/boards/${key}/v/${hex(second)}/`);
    expect(filesAt(`boards/${key}`)).toEqual(second.files);
    expect(filesAt(`boards/${key}/v/${hex(first)}`)).toEqual(first.files); expect(filesAt(`boards/${key}/v/${hex(second)}`)).toEqual(second.files);
    expect(github.served!.get(`/site/boards/${key}/index.html`)).toBe(second.files["index.html"]);
    // The older version is never demoted because the share link moved on.
    const older = await manager.refresh(one.jobId); expect(older.status, older.error).toBe("live"); expect(older.url).toBe(one.url); expect(older.shareUrl).toBe(one.shareUrl);
    expect(github.prs).toHaveLength(2); expect(github.files("main")["index.html"]).toBe("Existing home");
  });

  it("adopts a pre-feature directory as the share link and archives the original release in the same PR", async () => {
    legacy(); const original = await version();
    const before = await deployed((await publish(request(original, "pre-feature", { shareKey: undefined }))).jobId);
    expect(before.url).toBe(`https://writer.github.io/site/boards/${hex(original)}/`); expect(before.sharePath).toBeUndefined();
    const next = await version("two"), adoptedKey = hex(original);
    const job = await publish(request(next, "adopt", { shareKey: adoptedKey }));
    expect(job.status, job.error).toBe("deploying"); expect(job.adoptedFrom).toBe(before.jobId); expect(job.sharePath).toBe(`boards/${adoptedKey}`);
    const pr = github.prs.at(-1)!, head = github.files(pr.head.sha), parent = github.files(github.parents.get(pr.head.sha)![0]);
    const added = Object.keys(head).filter(path => !Object.hasOwn(parent, path)).sort();
    expect(added).toEqual([...Object.keys(next.files).map(name => `boards/${adoptedKey}/v/${hex(next)}/${name}`), ...Object.keys(original.files).map(name => `boards/${adoptedKey}/v/${adoptedKey}/${name}`)].sort());
    expect(Object.keys(head).filter(path => Object.hasOwn(parent, path) && head[path] !== parent[path]).every(path => path.startsWith(`boards/${adoptedKey}/`) && !path.includes("/v/"))).toBe(true);
    expect(filesAt(`boards/${adoptedKey}`)).toEqual(next.files); expect(filesAt(`boards/${adoptedKey}/v/${adoptedKey}`)).toEqual(original.files);
    const live = await deployed(job.jobId); expect(live.status, live.error).toBe("live");
    expect(live.shareUrl).toBe(before.url); expect(live.url).toBe(`${before.url}v/${hex(next)}/`);
    // Going live moved the adopted job to its original release's archive without a manual refresh.
    const moved = await manager.read(before.jobId); expect(moved.status, moved.error).toBe("live"); expect(moved.url).toBe(`${before.url}v/${adoptedKey}/`);
    const old = await manager.refresh(before.jobId); expect(old.status, old.error).toBe("live"); expect(old.url).toBe(`${before.url}v/${adoptedKey}/`);
  });

  it("never lets an older failed or expired request overwrite a newer share", async () => {
    legacy(); const first = await version();
    github.exists = false; const failed = await publish(request(first, "failed-first")); github.exists = true;
    expect(failed.status).toBe("failed"); expect(failed.baseSha).toBeUndefined();
    const expired = await manager.publish(request(first, "expired-first")); await manager.close(); manager = open();
    await writeFile(join(root, "jobs", `${expired.jobId}.json`), JSON.stringify({ ...expired, autoPublishUntil: "2000-01-01T00:00:00.000Z" }));
    await manager.advanceAutomatic(); expect((await manager.read(expired.jobId)).autoPublish).toBe(false);
    const second = await version("two"), newer = await deployed((await publish(request(second, "second"))).jobId);
    expect(newer.status, newer.error).toBe("live");
    for (const input of [request(first, "failed-first"), request(first, "expired-first")]) {
      const resumed = await publish(input);
      expect(resumed.status).toBe("failed"); expect(resumed.refusal).toEqual({ code: "newer-on-share", message: expect.stringContaining("已有更新的版本") });
    }
    expect(filesAt(`boards/${key}`)).toEqual(second.files); expect(github.prs).toHaveLength(1);
  });

  it("refuses a stale outbox request created after a newer version went live", async () => {
    legacy(); const first = await version(), second = await version("two");
    expect((await deployed((await publish(request(second, "second"))).jobId)).status).toBe("live");
    // The older request reaches the server only now, so it is the newest job by createdAt.
    const stale = await publish(request(first, "lost-response"));
    expect(stale.refusal?.code).toBe("newer-on-share"); expect(stale.status).toBe("failed"); expect(stale.autoPublish).toBe(false);
    expect(filesAt(`boards/${key}`)).toEqual(second.files); expect(github.prs).toHaveLength(1);
  });

  it("refuses a share directory or archive holding foreign content, and a key of another Board", async () => {
    legacy(); const release = await version(), base = github.trees.get("base-tree")!;
    base[`boards/${key}/index.html`] = "Someone else's page";
    const foreign = await publish(request(release, "foreign"));
    expect(foreign.refusal).toEqual({ code: "share-foreign", message: "分享页目录已被其他内容改动，未覆盖。" }); expect(github.prs).toHaveLength(0);
    delete base[`boards/${key}/index.html`]; base[`boards/${key}/v/${hex(release)}/index.html`] = "Occupied archive";
    expect((await publish(request(release, "archive"))).refusal?.message).toContain("版本目录");
    delete base[`boards/${key}/v/${hex(release)}/index.html`];
    expect((await deployed((await publish(request(release, "own"))).jobId)).status).toBe("live");
    await store.create({ id: "OTHER_BOARD", title: "Other", html: "<p>Other</p>", data: {} });
    const other = await publish(request(await version(undefined, "OTHER_BOARD"), "other-board"));
    expect(other.refusal?.code).toBe("share-foreign"); expect(github.prs).toHaveLength(1); expect(filesAt(`boards/${key}`)).toEqual(release.files);
  });

  it("blocks a second update only while another is before merge; login-protected deployments never block", async () => {
    const enterprise = { githubHost: host };
    const sso = vi.spyOn(github, "publicFile").mockRejectedValue(new GitHubApiError(401));
    const first = await publish(request(await version(), "first", enterprise)); github.deploy(); await manager.advanceAutomatic();
    const deploying = await manager.read(first.jobId);
    expect(deploying.status).toBe("deploying"); expect(deploying.autoPublish).toBe(true); expect(deploying.error).toContain("需要公司网络或登录");
    expect(deploying.shareDeployedUrl).toBe(`https://pages.${host}/writer/site/boards/${key}/`);
    github.legacyChecks = [{ status: "in_progress", conclusion: null }];
    const second = await publish(request(await version("two"), "second", enterprise));
    expect(second.status, second.error).toBe("pr-open"); expect(second.refusal).toBeUndefined();
    const third = await publish(request(await version("three"), "third", enterprise));
    expect(third).toMatchObject({ status: "failed", autoPublish: false, refusal: { code: "series-busy" } }); expect(github.prs).toHaveLength(2);
    // Window expiry keeps the sign-in verification notice of the deployed version.
    await writeFile(join(root, "jobs", `${first.jobId}.json`), JSON.stringify({ ...(await manager.read(first.jobId)), autoPublishUntil: "2000-01-01T00:00:00.000Z" }));
    await manager.advanceAutomatic(); const expired = await manager.read(first.jobId);
    expect(expired.autoPublish).toBe(false); expect(expired.error).toContain("需要公司网络或登录"); expect(expired.shareDeployedUrl).toBe(deploying.shareDeployedUrl);
    sso.mockRestore();
  });

  it("updates after a lost merge response without refusing the share's own bytes", async () => {
    legacy(); const first = await publish({ ...request(await version(), "first") }); expect(first.status).toBe("deploying");
    const lostFirst = await version("lost");
    github.failAfter("/pulls/2/merge"); const lost = await publish(request(lostFirst, "lost"));
    expect(lost.status).toBe("unknown"); expect(lost.mergedSha).toBeUndefined(); expect(github.prs[1].merged).toBe(true);
    await writeFile(join(root, "jobs", `${lost.jobId}.json`), JSON.stringify({ ...lost, autoPublishUntil: "2000-01-01T00:00:00.000Z" }));
    await manager.advanceAutomatic();
    const third = await version("three"), next = await deployed((await publish(request(third, "next"))).jobId);
    expect(next.status, next.error).toBe("live"); expect(filesAt(`boards/${key}`)).toEqual(third.files);
    expect(filesAt(`boards/${key}/v/${hex(lostFirst)}`)).toEqual(lostFirst.files);
    // Resuming the lost request only picks up its merge; it never rolls the share back.
    const resumed = await publish(request(lostFirst, "lost")); expect(resumed.mergedSha).toBe(github.prs[1].merge_commit_sha);
    expect(filesAt(`boards/${key}`)).toEqual(third.files); expect(github.calls.filter(call => call.method === "PUT")).toHaveLength(3);
  });

  it("finishes an unchanged update without a branch or PR", async () => {
    legacy(); const release = await version(), first = await deployed((await publish(request(release, "first"))).jobId);
    const calls = github.calls.length, again = await publish(request(release, "again"));
    expect(again.refusal?.code).toBe("up-to-date"); expect(again.prNumber).toBeUndefined(); expect(again.branch).toBeTruthy();
    expect(github.prs).toHaveLength(1); expect(github.calls.slice(calls).some(call => call.method !== "GET")).toBe(false);
    expect(again.status, again.error).toBe("live"); expect(again.shareUrl).toBe(first.shareUrl); expect(again.url).toBe(first.url);
  });

  it("owns the workflow-mode root per Board and keeps the v1 workflow text", async () => {
    const first = await version(), one = await publish(request(first, "first"));
    expect(one.publicationMode).toBe("workflow"); expect(one.sharePath).toBeUndefined(); expect(one.sitePath).toBeUndefined();
    expect(github.files("main")[".github/workflows/paseo-board-pages.yml"]).toBe(pagesWorkflow("main"));
    const live = await deployed(one.jobId); expect(live.status, live.error).toBe("live");
    expect(live).toMatchObject({ url: "https://writer.github.io/site/", shareUrl: "https://writer.github.io/site/" });
    const second = await version("two"), two = await deployed((await publish(request(second, "second"))).jobId);
    expect(two.status, two.error).toBe("live"); expect(filesAt("paseo-board-publication/site")).toEqual(second.files);
    expect(github.files("main")[".github/workflows/paseo-board-pages.yml"]).toBe(pagesWorkflow("main"));
    const older = await manager.refresh(one.jobId); expect(older.status).toBe("live"); expect(older.url).toBe(live.url);
    // Another Board cannot take over this Board's root as a series...
    await store.create({ id: "OTHER_BOARD", title: "Other", html: "<p>Other</p>", data: {} });
    const otherRelease = await version(undefined, "OTHER_BOARD");
    const other = await publish(request(otherRelease, "other", { shareKey: "s" + "2".repeat(20) }));
    expect(other.refusal).toEqual({ code: "share-foreign", message: "此仓库首页属于另一张 Board，请选择其他仓库。" }); expect(github.prs).toHaveLength(2);
    // ...nor with a request without a share key once a series owns the root.
    const old = await publish(request(otherRelease, "old", { shareKey: undefined }));
    expect(old.refusal).toEqual({ code: "share-foreign", message: "此仓库首页属于另一张 Board，请选择其他仓库。" }); expect(github.prs).toHaveLength(2);
    expect(filesAt("paseo-board-publication/site")).toEqual(second.files);
  });

  it("never lets a keyless workflow request of the same Board roll the series root back", async () => {
    const first = await version();
    github.exists = false; const failed = await publish(request(first, "pre-feature-failed", { shareKey: undefined })); github.exists = true;
    expect(failed.status).toBe("failed"); expect(failed.baseSha).toBeUndefined();
    expect((await deployed((await publish(request(first, "first"))).jobId)).status).toBe("live");
    const second = await version("two"), two = await deployed((await publish(request(second, "second"))).jobId);
    expect(two.status, two.error).toBe("live");
    // A failed pre-feature job resumed, and a pre-feature outbox request reaching the server only now.
    for (const input of [request(first, "pre-feature-failed", { shareKey: undefined }), request(first, "pre-feature-outbox", { shareKey: undefined })]) {
      const resumed = await publish(input);
      expect(resumed.status).toBe("failed"); expect(resumed.refusal).toEqual({ code: "newer-on-share", message: expect.stringContaining("已有更新的版本") });
    }
    expect(filesAt("paseo-board-publication/site")).toEqual(second.files); expect(github.prs).toHaveLength(2);
    expect(await manager.refresh(two.jobId)).toMatchObject({ status: "live", shareUrl: two.shareUrl });
  });

  it("counts a new keyed request on a workflow root as busy while another update is before merge", async () => {
    github.checkStatus = "in_progress";
    const one = await publish(request(await version(), "a")); expect(one).toMatchObject({ status: "pr-open", publicationMode: "workflow" });
    const two = await publish(request(await version("two"), "b", { shareKey: "s" + "9".repeat(20) }));
    expect(two).toMatchObject({ status: "failed", autoPublish: false, refusal: { code: "series-busy" } }); expect(github.prs).toHaveLength(1);
  });

  it("re-verifies an unchanged update after a transient GitHub error", async () => {
    legacy(); const release = await version(); await deployed((await publish(request(release, "first"))).jobId);
    tick(); const job = await manager.publish(request(release, "again"));
    expect((await manager.prepare(request(release, "again"))).refusal?.code).toBe("up-to-date");
    const original = github.request.bind(github); let outage = true;
    vi.spyOn(github, "request").mockImplementation((account, method, path, body, githubHost) =>
      outage && method === "GET" && path.endsWith("/pages") ? Promise.reject(new GitHubApiError(503)) : original(account, method, path, body, githubHost));
    await manager.advanceAutomatic(); expect(await manager.read(job.jobId)).toMatchObject({ status: "unknown", autoPublish: true, refusal: { code: "up-to-date" } });
    outage = false; await manager.advanceAutomatic();
    const live = await manager.read(job.jobId); expect(live.status, live.error).toBe("live"); expect(github.prs).toHaveLength(1);
  });

  it("keeps old journals and non-series requests on the per-release layout beside a series", async () => {
    legacy(); const release = await version();
    expect((await deployed((await publish(request(release, "series"))).jobId)).status).toBe("live");
    const second = await version("two"), plain = await publish(request(second, "plain", { shareKey: undefined }));
    expect(plain.sitePath).toBe(`boards/${hex(second)}`); expect(plain.sharePath).toBeUndefined(); expect(plain.adoptedFrom).toBeUndefined();
    expect(filesAt(`boards/${hex(second)}`)).toEqual(second.files); expect(filesAt(`boards/${key}`)).toEqual(release.files);
    const live = await deployed(plain.jobId); expect(live.url).toBe(`https://writer.github.io/site/boards/${hex(second)}/`); expect(live.shareUrl).toBeUndefined();
    const { shareKey: _, sharePath: __, ...oldShape } = plain;
    await writeFile(join(root, "jobs", `${plain.jobId}.json`), JSON.stringify(oldShape));
    expect(await open().read(plain.jobId)).toEqual(oldShape);
  });
});
