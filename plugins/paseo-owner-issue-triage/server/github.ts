import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RETRY_MS = 60_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: { id: number; login?: string } | null;
  created_at: string;
  updated_at: string;
  state: "open" | "closed";
  pull_request?: unknown;
}

export interface TrustedComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrustedIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  authorId: number;
  createdAt: string;
  updatedAt: string;
  state: "open" | "closed";
  comments: TrustedComment[];
  fingerprint: string;
}

/** A test seam for gh execution. Rejections may carry stdout, but stderr is never exposed. */
export type GitHubRunner = (args: readonly string[]) => Promise<{ stdout: string }>;

export class GitHubError extends Error {
  readonly retryAt?: number;
  readonly status?: number;

  constructor(message: string, options: { retryAt?: number; status?: number } = {}) {
    super(message);
    this.name = "GitHubError";
    this.retryAt = options.retryAt;
    this.status = options.status;
  }
}

export function validateRepo(repo: string): string {
  if (typeof repo !== "string" || !REPOSITORY_PATTERN.test(repo) || [".", ".."].includes(repo.split("/")[1]!)) {
    throw new GitHubError("Invalid repository. Use owner/repository.");
  }
  return repo;
}

const runGh: GitHubRunner = (args) => new Promise((resolve, reject) => {
  execFile("gh", [...args], {
    encoding: "utf8",
    timeout: REQUEST_TIMEOUT_MS,
    maxBuffer: MAX_RESPONSE_BYTES,
    windowsHide: true,
    shell: false,
  }, (error, stdout) => {
    if (error) {
      // Keep only the fields used to classify failures. Never retain stderr or command text.
      reject({ code: error.code, killed: error.killed, stdout });
    } else {
      resolve({ stdout });
    }
  });
});

interface Response {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function invalidResponse(): GitHubError {
  return new GitHubError("GitHub returned an invalid or incomplete response.");
}

function parseResponse(stdout: string): Response {
  const boundary = /\r?\n\r?\n/.exec(stdout);
  if (!boundary) throw invalidResponse();
  const lines = stdout.slice(0, boundary.index).split(/\r?\n/);
  const status = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s|$)/.exec(lines[0] ?? "");
  if (!status) throw invalidResponse();
  const headers: Record<string, string> = Object.create(null);
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw invalidResponse();
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { status: Number(status[1]), headers, body: stdout.slice(boundary.index + boundary[0].length) };
}

function retryTime(headers: Record<string, string>, now: number): number {
  const retryAfter = headers["retry-after"];
  const times: number[] = [];
  if (retryAfter !== undefined) {
    const time = /^\d+(?:\.\d+)?$/.test(retryAfter)
      ? now + Number(retryAfter) * 1000
      : Date.parse(retryAfter);
    if (Number.isFinite(time)) times.push(time);
  }
  const reset = headers["x-ratelimit-reset"];
  if (reset && /^\d+$/.test(reset) && (!headers["x-ratelimit-remaining"] || headers["x-ratelimit-remaining"] === "0")) {
    const time = Number(reset) * 1000;
    if (Number.isFinite(time)) times.push(time);
  }
  return times.length ? Math.max(now + 1000, ...times) : now + DEFAULT_RETRY_MS;
}

function responseError(response: Response): GitHubError {
  const { status, headers } = response;
  if (status === 403 || status === 429) {
    return new GitHubError("GitHub denied or rate-limited the request. Intake will retry later.", {
      status, retryAt: retryTime(headers, Date.now()),
    });
  }
  if (status >= 500) {
    return new GitHubError("GitHub is temporarily unavailable. Intake will retry later.", {
      status, retryAt: retryTime(headers, Date.now()),
    });
  }
  if (status === 401) return new GitHubError("GitHub authentication failed. Check the existing gh login.", { status });
  if (status === 404) return new GitHubError("GitHub repository or issue is unavailable to the current account.", { status });
  return new GitHubError("GitHub rejected the read request.", { status });
}

function executionError(error: unknown): GitHubError {
  const details = isRecord(error) ? error : {};
  if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || details.code === "ERR_BUFFER_TOO_LARGE") {
    return new GitHubError("GitHub response exceeded the size limit. Narrow the intake window.");
  }
  if (details.killed === true || details.code === "ETIMEDOUT" || details.code === "ABORT_ERR") {
    return new GitHubError("GitHub request timed out. Intake will retry later.", { retryAt: Date.now() + DEFAULT_RETRY_MS });
  }
  if (typeof details.stdout === "string") {
    try {
      const response = parseResponse(details.stdout);
      if (response.status < 200 || response.status >= 300) return responseError(response);
    } catch {
      // A failed process can leave a partial response. Never treat it as a complete snapshot.
    }
  }
  if (details.code === "ENOENT") return new GitHubError("GitHub CLI is unavailable. Install gh on the daemon host.");
  return new GitHubError("GitHub CLI request failed. Check gh authentication and connectivity.", { retryAt: Date.now() + DEFAULT_RETRY_MS });
}

function parseIssue(value: unknown, repo: string): RawIssue {
  if (!isRecord(value) || !isId(value.number) || typeof value.title !== "string"
    || (value.body !== null && typeof value.body !== "string")
    || typeof value.html_url !== "string" || !isTimestamp(value.created_at) || !isTimestamp(value.updated_at)
    || (value.state !== "open" && value.state !== "closed")) throw invalidResponse();

  let user: RawIssue["user"] = null;
  if (value.user !== null) {
    if (!isRecord(value.user) || !isId(value.user.id)) throw invalidResponse();
    user = { id: value.user.id };
    if (typeof value.user.login === "string") user.login = value.user.login;
  }
  const isPullRequest = Object.hasOwn(value, "pull_request");
  const expectedUrl = `https://github.com/${repo}/${isPullRequest ? "pull" : "issues"}/${value.number}`;
  if (value.html_url.toLowerCase() !== expectedUrl.toLowerCase()) throw invalidResponse();

  const issue: RawIssue = {
    number: value.number,
    title: value.title,
    body: value.body,
    html_url: expectedUrl,
    user,
    created_at: value.created_at,
    updated_at: value.updated_at,
    state: value.state,
  };
  if (isPullRequest) issue.pull_request = true;
  return issue;
}

function parseOwnerComment(value: unknown, ownerId: number): TrustedComment | null {
  // Do not even read another author's body. Login names and body claims never grant authority.
  if (!isRecord(value) || !isRecord(value.user) || value.user.id !== ownerId) return null;
  if (!isId(value.id) || (value.body !== null && typeof value.body !== "string")
    || !isTimestamp(value.created_at) || !isTimestamp(value.updated_at)) throw invalidResponse();
  return { id: value.id, body: value.body ?? "", createdAt: value.created_at, updatedAt: value.updated_at };
}

export class GitHubClient {
  constructor(private readonly runner: GitHubRunner = runGh) {}

  private async request(path: string): Promise<{ value: unknown; headers: Record<string, string> }> {
    // All paths are constructed by methods below. No absolute, API-supplied, or user-body URL is followed.
    let stdout: string;
    try {
      ({ stdout } = await this.runner([
        "api", "--hostname", "github.com", "--method", "GET", "--include",
        "--header", "Accept: application/vnd.github+json", path,
      ]));
    } catch (error) {
      throw executionError(error);
    }
    const response = parseResponse(stdout);
    if (response.status < 200 || response.status >= 300) throw responseError(response);
    try {
      return { value: JSON.parse(response.body), headers: response.headers };
    } catch {
      throw invalidResponse();
    }
  }

  private async pages(path: (page: number) => string): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { value, headers } = await this.request(path(page));
      if (!Array.isArray(value) || value.length > PAGE_SIZE) throw invalidResponse();
      result.push(...value);
      const link = headers.link;
      const hasNext = link
        ? /\brel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|next)(?=\s*(?:;|,|$))/i.test(link)
        : value.length === PAGE_SIZE;
      if (!hasNext) return result;
      if (value.length === 0) throw invalidResponse();
    }
    throw new GitHubError("GitHub pagination limit reached. Narrow the intake window; no partial scan was accepted.");
  }

  async identity(): Promise<{ id: number; login: string }> {
    const { value } = await this.request("user");
    if (!isRecord(value) || !isId(value.id) || typeof value.login !== "string" || !value.login) throw invalidResponse();
    return { id: value.id, login: value.login };
  }

  async listIssues(repo: string, since?: string): Promise<RawIssue[]> {
    validateRepo(repo);
    if (since !== undefined && !isTimestamp(since)) throw new GitHubError("Invalid issue scan timestamp.");
    const query = `state=all&sort=created&direction=asc&per_page=${PAGE_SIZE}`
      + (since ? `&since=${encodeURIComponent(since)}` : "");
    const values = await this.pages((page) => `repos/${repo}/issues?${query}&page=${page}`);
    const issues = new Map<number, RawIssue>();
    for (const value of values) {
      const issue = parseIssue(value, repo);
      issues.set(issue.number, issue);
    }
    return [...issues.values()];
  }

  async getIssue(repo: string, number: number): Promise<RawIssue> {
    validateRepo(repo);
    if (!isId(number)) throw new GitHubError("Invalid issue number.");
    const { value } = await this.request(`repos/${repo}/issues/${number}`);
    const issue = parseIssue(value, repo);
    if (issue.number !== number) throw invalidResponse();
    return issue;
  }

  async snapshot(repo: string, issue: RawIssue, ownerId: number): Promise<TrustedIssue | null> {
    validateRepo(repo);
    if (!isId(ownerId)) throw new GitHubError("Invalid owner identity.");
    if (!isRecord(issue) || Object.hasOwn(issue, "pull_request")
      || !isRecord(issue.user) || issue.user.id !== ownerId) return null;
    const validated = parseIssue(issue, repo);
    const values = await this.pages((page) => `repos/${repo}/issues/${validated.number}/comments?per_page=${PAGE_SIZE}&page=${page}`);
    const byId = new Map<number, TrustedComment>();
    for (const value of values) {
      const comment = parseOwnerComment(value, ownerId);
      if (comment) byId.set(comment.id, comment);
    }
    const comments = [...byId.values()].sort((a, b) => a.id - b.id);
    const body = validated.body ?? "";
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ title: validated.title, body, comments: comments.map(({ id, body: text }) => ({ id, body: text })) }))
      .digest("hex");
    return {
      repo,
      number: validated.number,
      title: validated.title,
      body,
      url: validated.html_url,
      authorId: ownerId,
      createdAt: validated.created_at,
      updatedAt: validated.updated_at,
      state: validated.state,
      comments,
      fingerprint,
    };
  }
}
