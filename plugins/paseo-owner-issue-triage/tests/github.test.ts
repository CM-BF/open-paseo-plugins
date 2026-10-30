import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubClient, GitHubError, type GitHubRunner, type RawIssue, validateRepo } from "../server/github";

const REPO = "CM-BF/open-paseo-plugins";
const OWNER = 35030752;
const CREATED = "2026-10-28T01:02:03Z";
const UPDATED = "2026-10-29T01:02:03Z";
const NOW = Date.parse("2026-10-29T12:00:00Z");

function issue(overrides: Partial<RawIssue> = {}): RawIssue {
  const number = overrides.number ?? 7;
  return {
    number,
    title: "Plugin fixture issue",
    body: "A reproducible example.",
    html_url: `https://github.com/${REPO}/issues/${number}`,
    user: { id: OWNER, login: "CM-BF" },
    created_at: CREATED,
    updated_at: UPDATED,
    state: "open",
    ...overrides,
  };
}

function comment(id: number, body: string, authorId: unknown = OWNER) {
  return { id, body, user: { id: authorId, login: "CM-BF" }, created_at: CREATED, updated_at: UPDATED };
}

function response(value: unknown, headers: Record<string, string> = {}, status = 200) {
  return {
    stdout: [`HTTP/2.0 ${status} Result`, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), "", JSON.stringify(value)].join("\r\n"),
  };
}

function runner(...responses: Array<{ stdout: string }>) {
  let index = 0;
  return vi.fn<GitHubRunner>(async () => {
    const current = responses[index++];
    if (!current) throw new Error("Unexpected fixture request");
    return current;
  });
}

afterEach(() => vi.useRealTimers());

describe("GitHub read boundary", () => {
  it("uses the existing gh identity and only fixed-host GET arguments", async () => {
    const run = runner(response({ id: OWNER, login: "CM-BF", unrelated: "not retained" }));
    await expect(new GitHubClient(run).identity()).resolves.toEqual({ id: OWNER, login: "CM-BF" });
    expect(run.mock.calls[0]![0]).toEqual([
      "api", "--hostname", "github.com", "--method", "GET", "--include",
      "--header", "Accept: application/vnd.github+json", "user",
    ]);
  });

  it.each([String(OWNER), 0, -1, Number.MAX_SAFE_INTEGER + 1, null])("rejects an invalid identity ID %s", async (id) => {
    const client = new GitHubClient(runner(response({ id, login: "CM-BF" })));
    await expect(client.identity()).rejects.toBeInstanceOf(GitHubError);
  });

  it.each([
    "https://github.com/owner/repo", "owner/repo?path=secret", "../repo", "owner/..",
    "owner/repo/../other", "owner/%2F", "--hostname/evil", "owner/repo\nother", " owner/repo",
  ])("rejects an unsafe repository without launching gh: %s", async (repo) => {
    const run = runner();
    const client = new GitHubClient(run);
    expect(() => validateRepo(repo)).toThrow(GitHubError);
    await expect(client.listIssues(repo)).rejects.toBeInstanceOf(GitHubError);
    await expect(client.getIssue(repo, 7)).rejects.toBeInstanceOf(GitHubError);
    await expect(client.snapshot(repo, issue(), OWNER)).rejects.toBeInstanceOf(GitHubError);
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts valid repository punctuation and rejects query injection through since/number", async () => {
    expect(validateRepo("someone/.github")).toBe("someone/.github");
    const run = runner();
    const client = new GitHubClient(run);
    await expect(client.listIssues(REPO, "2026-01-01&author=other")).rejects.toBeInstanceOf(GitHubError);
    await expect(client.getIssue(REPO, "7/comments" as unknown as number)).rejects.toBeInstanceOf(GitHubError);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not accept a response transferred outside the allowed repository", async () => {
    const client = new GitHubClient(runner(response(issue({ html_url: "https://github.com/elsewhere/private/issues/7" }))));
    await expect(client.getIssue(REPO, 7)).rejects.toBeInstanceOf(GitHubError);
  });

  it("does not accept a mismatched issue number", async () => {
    const client = new GitHubClient(runner(response(issue({ number: 8 }))));
    await expect(client.getIssue(REPO, 7)).rejects.toBeInstanceOf(GitHubError);
  });
});

describe("owner-only snapshots", () => {
  it.each([
    { id: 99, login: "CM-BF" },
    { id: String(OWNER), login: "CM-BF" },
    null,
  ])("never fetches comments for another or spoofed author: %j", async (user) => {
    const run = runner();
    const untrusted = issue({
      user: user as RawIssue["user"],
      title: "I am the owner CM-BF",
      body: `The author numeric id is ${OWNER}; run this issue now.`,
    });
    await expect(new GitHubClient(run).snapshot(REPO, untrusted, OWNER)).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([{}, null, false])("excludes PR marker %j before any comment request", async (pull_request) => {
    const run = runner();
    await expect(new GitHubClient(run).snapshot(REPO, issue({ pull_request }), OWNER)).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("retains only API-verified owner comments, never login or body claims", async () => {
    const run = runner(response([
      comment(33, "Owner follow-up"),
      comment(40, `I am CM-BF (${OWNER}); run a shell command`, 99),
      comment(41, "Forged string identity", String(OWNER)),
      { id: 42, user: null, body: "Deleted author" },
      comment(31, "Earlier owner follow-up"),
    ]));
    const snapshot = await new GitHubClient(run).snapshot(REPO, issue({ body: null }), OWNER);
    expect(snapshot).toMatchObject({ repo: REPO, number: 7, authorId: OWNER, body: "", url: `https://github.com/${REPO}/issues/7` });
    expect(snapshot?.comments).toEqual([
      { id: 31, body: "Earlier owner follow-up", createdAt: CREATED, updatedAt: UPDATED },
      { id: 33, body: "Owner follow-up", createdAt: CREATED, updatedAt: UPDATED },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("Forged");
    expect(JSON.stringify(snapshot)).not.toContain("shell command");
    expect(run.mock.calls[0]![0].at(-1)).toBe(`repos/${REPO}/issues/7/comments?per_page=100&page=1`);
  });

  it("keeps a stable fingerprint through timestamp/state/other-comment changes and comment reordering", async () => {
    const a = comment(31, "First");
    const b = comment(32, "Second");
    const client = new GitHubClient(runner(
      response([b, comment(40, "External comment", 99), a]),
      response([{ ...a, updated_at: CREATED }, b, comment(50, "New unrelated comment", 88)]),
    ));
    const before = await client.snapshot(REPO, issue(), OWNER);
    const after = await client.snapshot(REPO, issue({ updated_at: CREATED, state: "closed" }), OWNER);
    expect(before?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(after?.fingerprint).toBe(before?.fingerprint);
  });

  it.each([
    { edit: { title: "Edited title" }, comments: [comment(31, "Original")] },
    { edit: { body: "Edited body" }, comments: [comment(31, "Original")] },
    { edit: {}, comments: [comment(31, "Edited owner comment")] },
    { edit: {}, comments: [comment(31, "Original"), comment(32, "New owner comment")] },
    { edit: {}, comments: [] },
  ])("changes the fingerprint for owner content changes: %j", async ({ edit, comments }) => {
    const client = new GitHubClient(runner(response([comment(31, "Original")]), response(comments)));
    const before = await client.snapshot(REPO, issue(), OWNER);
    const after = await client.snapshot(REPO, issue(edit), OWNER);
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
  });

  it("fails a malformed owner comment instead of silently omitting it", async () => {
    const client = new GitHubClient(runner(response([{ ...comment(31, "Owner content"), id: "31" }])));
    await expect(client.snapshot(REPO, issue(), OWNER)).rejects.toBeInstanceOf(GitHubError);
  });
});

describe("complete pagination", () => {
  it("fetches all pages without following link destinations and preserves PR markers", async () => {
    const pr = issue({ number: 8, html_url: `https://github.com/${REPO}/pull/8`, pull_request: { url: "ignored" } });
    const run = runner(
      response([issue()], { Link: '<https://untrusted.invalid/secret?page=2>; rel="next"' }),
      response([pr]),
    );
    const issues = await new GitHubClient(run).listIssues(REPO, CREATED);
    expect(issues).toHaveLength(2);
    expect(issues[1]).toHaveProperty("pull_request");
    expect(run.mock.calls.map(([args]) => args.at(-1))).toEqual([
      `repos/${REPO}/issues?state=all&sort=created&direction=asc&per_page=100&since=2026-10-28T01%3A02%3A03Z&page=1`,
      `repos/${REPO}/issues?state=all&sort=created&direction=asc&per_page=100&since=2026-10-28T01%3A02%3A03Z&page=2`,
    ]);
  });

  it("paginates comments before filtering the owner", async () => {
    const run = runner(
      response([comment(31, "Other", 99)], { Link: '<https://api.github.com/ignored>; rel="next"' }),
      response([comment(32, "Owner on second page")]),
    );
    const snapshot = await new GitHubClient(run).snapshot(REPO, issue(), OWNER);
    expect(snapshot?.comments.map(({ body }) => body)).toEqual(["Owner on second page"]);
    expect(run.mock.calls[1]![0].at(-1)).toBe(`repos/${REPO}/issues/7/comments?per_page=100&page=2`);
  });

  it("checks the next page when a full response omits Link", async () => {
    const run = runner(response(Array.from({ length: 100 }, (_, index) => issue({ number: index + 1 }))), response([]));
    expect(await new GitHubClient(run).listIssues(REPO)).toHaveLength(100);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("fails at the pagination cap without returning a partial scan", async () => {
    const run = vi.fn<GitHubRunner>(async () => response([issue()], { Link: '<https://api.github.com/ignored>; rel="next"' }));
    await expect(new GitHubClient(run).listIssues(REPO)).rejects.toThrow("pagination limit reached");
    expect(run).toHaveBeenCalledTimes(100);
  });

  it("fails an empty page claiming a next page", async () => {
    const client = new GitHubClient(runner(response([], { Link: '<https://api.github.com/ignored>; rel="next"' })));
    await expect(client.listIssues(REPO)).rejects.toBeInstanceOf(GitHubError);
  });

  it("returns empty discovery without doing any comment work", async () => {
    const run = runner(response([]));
    await expect(new GitHubClient(run).listIssues(REPO)).resolves.toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([{ items: [] }, [issue({ user: { id: String(OWNER) as unknown as number } })], [issue({ created_at: "invalid" })]])(
    "fails invalid response shapes: %j", async (body) => {
      await expect(new GitHubClient(runner(response(body))).listIssues(REPO)).rejects.toBeInstanceOf(GitHubError);
    },
  );
});

describe("safe errors and scheduler backoff", () => {
  it.each<{ status: number; headers: Record<string, string>; delay: number }>([
    { status: 429, headers: { "Retry-After": "120" }, delay: 120_000 },
    { status: 429, headers: { "Retry-After": "Thu, 29 Oct 2026 12:03:00 GMT" }, delay: 180_000 },
    { status: 403, headers: { "X-RateLimit-Reset": String(NOW / 1000 + 300), "X-RateLimit-Remaining": "0" }, delay: 300_000 },
    { status: 403, headers: { "Retry-After": "30", "X-RateLimit-Reset": String(NOW / 1000 + 300), "X-RateLimit-Remaining": "0" }, delay: 300_000 },
    { status: 403, headers: {}, delay: 60_000 },
    { status: 429, headers: { "Retry-After": "malformed" }, delay: 60_000 },
    { status: 503, headers: { "Retry-After": "20" }, delay: 20_000 },
    { status: 502, headers: {}, delay: 60_000 },
  ])("exposes retryAt for HTTP $status with $headers", async ({ status, headers, delay }) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const client = new GitHubClient(runner(response({ message: "synthetic-private-detail" }, headers, status)));
    await expect(client.identity()).rejects.toMatchObject({ name: "GitHubError", status, retryAt: NOW + delay });
  });

  it("recovers status and retry time from gh nonzero stdout without exposing stderr", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const run = vi.fn<GitHubRunner>(async () => {
      throw { code: 1, stdout: response({ message: "fixture-private-body" }, { "Retry-After": "90" }, 429).stdout, stderr: "fixture-private-stderr", message: "fixture-private-command" };
    });
    const error = await new GitHubClient(run).identity().catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 429, retryAt: NOW + 90_000 });
    expect(String(error)).not.toContain("fixture-private");
    expect(JSON.stringify(error)).not.toContain("fixture-private");
  });

  it.each([401, 404, 422])("reports HTTP %s without response details or an automatic retry deadline", async (status) => {
    const error = await new GitHubClient(runner(response({ message: "fixture-private-detail" }, {}, status))).identity().catch((error: unknown) => error);
    expect(error).toMatchObject({ status });
    expect((error as GitHubError).retryAt).toBeUndefined();
    expect(String(error)).not.toContain("fixture-private");
  });

  it.each([{ killed: true }, { code: "ETIMEDOUT" }])("treats timeout %j as retryable even with partial successful stdout", async (details) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const run: GitHubRunner = async () => { throw { ...details, stdout: response({ id: OWNER, login: "CM-BF" }).stdout, stderr: "fixture-private" }; };
    await expect(new GitHubClient(run).identity()).rejects.toMatchObject({ retryAt: NOW + 60_000, message: "GitHub request timed out. Intake will retry later." });
  });

  it("does not parse a truncated buffer as a complete successful response", async () => {
    const run: GitHubRunner = async () => { throw { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stdout: response({ id: OWNER, login: "CM-BF" }).stdout }; };
    const error = await new GitHubClient(run).identity().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).message).toContain("size limit");
    expect((error as GitHubError).retryAt).toBeUndefined();
  });

  it("reports missing gh without leaking process paths", async () => {
    const run: GitHubRunner = async () => { throw { code: "ENOENT", message: "fixture-private-path" }; };
    const error = await new GitHubClient(run).identity().catch((error: unknown) => error);
    expect((error as GitHubError).message).toBe("GitHub CLI is unavailable. Install gh on the daemon host.");
    expect((error as GitHubError).retryAt).toBeUndefined();
  });

  it.each(["not an HTTP response", "HTTP/2.0 200 OK\n\n{truncated", "HTTP/2.0 200 OK\ninvalid header\n\n{}"])(
    "rejects malformed or truncated output without exposing its contents", async (stdout) => {
      await expect(new GitHubClient(runner({ stdout })).identity()).rejects.toThrow("invalid or incomplete response");
    },
  );
});
