import { execFile } from "node:child_process";
import { request } from "node:https";
import {
  observationSchema,
  type Observation,
  type Watch,
} from "../shared/contracts";
import { matchesPath, normalizeRef, normalizeRepository } from "./validation";

const MAX_BODY = 4 * 1024 * 1024;
const TIMEOUT = 10_000;
export interface GitHubResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type GitHubTransport = (
  path: string,
  signal?: AbortSignal,
) => Promise<GitHubResponse>;
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly retryAt?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}
interface Commit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    committer?: { date?: string };
    author?: { date?: string };
  };
}
interface Compare {
  status?: string;
  html_url?: string;
  total_commits?: number;
  ahead_by?: number;
  commits?: Commit[];
  files?: { filename: string; status: string; previous_filename?: string }[];
}

function ghRequest(
  path: string,
  signal?: AbortSignal,
): Promise<GitHubResponse | undefined> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--include",
        path,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
      ],
      {
        timeout: TIMEOUT,
        maxBuffer: MAX_BODY,
        signal,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout) => {
        if (signal?.aborted) {
          reject(new GitHubError("GitHub request canceled."));
          return;
        }
        const separator = stdout.search(/\r?\n\r?\n/);
        const status = /^HTTP\/\S+\s+(\d+)/.exec(stdout);
        if (separator >= 0 && status) {
          const header = stdout.slice(0, separator);
          const headers: Record<string, string> = {};
          for (const line of header.split(/\r?\n/).slice(1)) {
            const colon = line.indexOf(":");
            if (colon > 0)
              headers[line.slice(0, colon).toLowerCase()] = line
                .slice(colon + 1)
                .trim();
          }
          const body = stdout.slice(separator).replace(/^\r?\n\r?\n/, "");
          resolve({ status: Number(status[1]), headers, body });
        } else if (
          error &&
          ((error as NodeJS.ErrnoException).code === "ENOENT" ||
            (error as { code?: unknown }).code === 4)
        ) {
          resolve(undefined);
        } else if (error) {
          // No stderr is propagated: gh may include account or credential-helper details.
          reject(
            new GitHubError(
              "GitHub CLI request failed or exceeded its timeout/response limit.",
            ),
          );
        } else
          reject(
            new GitHubError("GitHub CLI returned an invalid HTTP response."),
          );
      },
    );
  });
}

async function anonymousRequest(
  path: string,
  signal?: AbortSignal,
): Promise<GitHubResponse> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, TIMEOUT);
  try {
    return await new Promise<GitHubResponse>((resolve, reject) => {
      // Fixed hostname, GET only, and no redirect following or inherited auth headers.
      const req = request(
        {
          hostname: "api.github.com",
          path,
          method: "GET",
          signal: controller.signal,
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Paseo-Upstream-Watch",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY) {
              reject(new GitHubError("GitHub response exceeded 4 MiB."));
              response.destroy();
              req.destroy();
            } else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: Object.fromEntries(
                Object.entries(response.headers).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? value.join(", ") : (value ?? ""),
                ]),
              ),
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    throw new GitHubError(
      signal?.aborted
        ? "GitHub request canceled."
        : "Anonymous GitHub request failed or timed out.",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export class GitHubClient {
  private mode: "gh" | "anonymous" = "gh";
  private readonly transport: GitHubTransport;
  private readonly now: () => number;
  constructor(
    options: { transport?: GitHubTransport; now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.transport =
      options.transport ??
      (async (path, signal) => {
        const result = await ghRequest(path, signal);
        if (result && result.status !== 401) {
          this.mode = "gh";
          return result;
        }
        this.mode = "anonymous";
        return anonymousRequest(path, signal);
      });
  }
  get authentication(): "gh" | "anonymous" {
    return this.mode;
  }

  private async json<T>(path: string, signal?: AbortSignal): Promise<T> {
    if (
      !path.startsWith("/repos/") ||
      path.includes("\n") ||
      path.includes("\r")
    )
      throw new GitHubError("Invalid GitHub API path.");
    const response = await this.transport(path, signal);
    if (Buffer.byteLength(response.body) > MAX_BODY)
      throw new GitHubError("GitHub response exceeded 4 MiB.");
    if (response.status < 200 || response.status >= 300) {
      const headers = Object.fromEntries(
        Object.entries(response.headers).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );
      let retryAt: string | undefined;
      const retry = headers["retry-after"];
      if (retry && /^\d+$/.test(retry))
        retryAt = new Date(this.now() + Number(retry) * 1000).toISOString();
      else if (retry && Number.isFinite(Date.parse(retry)))
        retryAt = new Date(retry).toISOString();
      else if (
        headers["x-ratelimit-remaining"] === "0" &&
        /^\d+$/.test(headers["x-ratelimit-reset"] ?? "")
      ) {
        retryAt = new Date(
          Number(headers["x-ratelimit-reset"]) * 1000,
        ).toISOString();
      }
      const message =
        response.status === 404
          ? "GitHub repository, ref or comparison was not found (or access is unavailable)."
          : response.status === 403 || response.status === 429
            ? "GitHub request was denied or rate limited."
            : `GitHub returned HTTP ${response.status}.`;
      throw new GitHubError(message, retryAt, response.status);
    }
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new GitHubError("GitHub returned invalid JSON.");
    }
  }

  async observe(watch: Watch, signal?: AbortSignal): Promise<Observation> {
    const repository = normalizeRepository(watch.repository);
    const root = `/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
    let ref = normalizeRef(watch.ref);
    if (!ref) {
      const repo = await this.json<{ default_branch?: string }>(root, signal);
      if (!repo.default_branch)
        throw new GitHubError("GitHub did not report a default branch.");
      ref = normalizeRef(repo.default_branch);
    }
    const head = await this.json<Commit>(
      `${root}/commits/${encodeURIComponent(ref)}`,
      signal,
    );
    if (!head.commit || !head.sha)
      throw new GitHubError("GitHub returned an incomplete commit.");
    const initial: Observation = {
      head: head.sha,
      ref,
      url: head.html_url,
      title: head.commit.message.split("\n")[0] ?? "",
      date: head.commit.committer?.date ?? head.commit.author?.date ?? "",
      compareUrl: head.html_url,
      comparison: "identical",
      commits: [],
      commitsTotal: 0,
      files: [],
      filesTruncated: false,
      matchedPaths: [],
      hasUpdate: false,
      needsReview: false,
    };
    if (
      !watch.baseline ||
      watch.baseline.toLowerCase() === head.sha.toLowerCase()
    )
      return observationSchema.parse(initial);
    const comparison = await this.json<Compare>(
      `${root}/compare/${watch.baseline}...${head.sha}?per_page=100`,
      signal,
    );
    const status = ["ahead", "identical", "behind", "diverged"].includes(
      comparison.status ?? "",
    )
      ? (comparison.status as Observation["comparison"])
      : "unknown";
    const commits = comparison.commits ?? [];
    const files = comparison.files ?? [];
    const total =
      comparison.total_commits ?? comparison.ahead_by ?? commits.length;
    const incomplete =
      !Array.isArray(comparison.commits) ||
      !Array.isArray(comparison.files) ||
      !Number.isInteger(total) ||
      total < 0 ||
      total > commits.length;
    const truncated = files.length >= 300;
    const matchedPaths = watch.paths.length
      ? watch.paths.filter((path) =>
          files.some(
            (file) =>
              matchesPath(file.filename, path) ||
              Boolean(
                file.previous_filename &&
                  matchesPath(file.previous_filename, path),
              ),
          ),
        )
      : [];
    const needsReview =
      status === "behind" ||
      status === "diverged" ||
      status === "unknown" ||
      (status !== "identical" && (truncated || incomplete));
    const hasUpdate =
      status === "identical"
        ? false
        : needsReview ||
          (status === "ahead" &&
            (!watch.paths.length || matchedPaths.length > 0));
    return observationSchema.parse({
      ...initial,
      compareUrl:
        comparison.html_url ??
        `https://github.com/${repository}/compare/${watch.baseline}...${head.sha}`,
      comparison: status,
      commits: commits
        .slice(0, 100)
        .map((commit) => ({
          sha: commit.sha,
          title: commit.commit.message.split("\n")[0] ?? "",
          url: commit.html_url,
        })),
      commitsTotal: total,
      files: files.map((file) => ({
        path: file.filename,
        status: file.status,
        ...(file.previous_filename
          ? { previousPath: file.previous_filename }
          : {}),
      })),
      filesTruncated: truncated,
      matchedPaths,
      hasUpdate,
      needsReview,
    });
  }
}
