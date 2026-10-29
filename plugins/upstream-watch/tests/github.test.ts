import { describe, expect, it } from "vitest";
import {
  GitHubClient,
  GitHubError,
  type GitHubTransport,
} from "../server/github";
import { normalizeDraft } from "../server/validation";
import { type Watch } from "../shared/contracts";

const BASE = "a".repeat(40),
  HEAD = "b".repeat(40);
const commit = {
  sha: HEAD,
  html_url: `https://github.com/example/tools/commit/${HEAD}`,
  commit: {
    message: "New behavior\nDetails",
    committer: { date: "2026-10-24T12:00:00Z" },
  },
};
function watch(extra: Partial<Watch> = {}): Watch {
  return {
    id: "f1b93f56-1d78-4c35-ac60-2b6e72bc754a",
    name: "Tool",
    pluginId: "tool",
    targetPath: "/tmp/tool",
    repository: "example/tools",
    ref: "main",
    paths: [],
    relationship: "reference",
    notes: "",
    baseline: BASE,
    enabled: true,
    provider: "",
    createdAt: "2026-10-24T00:00:00Z",
    updatedAt: "2026-10-24T00:00:00Z",
    ...extra,
  };
}
function client(compare: unknown, paths: string[] = []): GitHubClient {
  const transport: GitHubTransport = async (path) => {
    paths.push(path);
    const data = path.includes("/compare/")
      ? compare
      : path.includes("/commits/")
        ? commit
        : { default_branch: "main" };
    return { status: 200, headers: {}, body: JSON.stringify(data) };
  };
  return new GitHubClient({ transport });
}
function comparison(
  files: {
    filename: string;
    status: string;
    previous_filename?: string;
  }[] = [],
  extra = {},
) {
  return {
    status: "ahead",
    total_commits: 1,
    commits: [commit],
    files,
    ...extra,
  };
}

describe("GitHub observations", () => {
  it("resolves default branch and does not compare an unbaselined watch", async () => {
    const calls: string[] = [];
    const result = await client({}, calls).observe(
      watch({ ref: "", baseline: undefined }),
    );
    expect(calls).toEqual([
      "/repos/example/tools",
      "/repos/example/tools/commits/main",
    ]);
    expect(result).toMatchObject({
      head: HEAD,
      ref: "main",
      hasUpdate: false,
      comparison: "identical",
    });
  });
  it("uses fixed SHA compare and escapes branch names as one URL segment", async () => {
    const calls: string[] = [];
    const result = await client(comparison(), calls).observe(
      watch({ ref: "release/stable" }),
    );
    expect(calls[0]).toBe("/repos/example/tools/commits/release%2Fstable");
    expect(calls[1]).toBe(
      `/repos/example/tools/compare/${BASE}...${HEAD}?per_page=100`,
    );
    expect(result.hasUpdate).toBe(true);
  });
  it("matches exact files and directory prefixes, including the old name of a rename", async () => {
    const github = client(
      comparison([
        {
          filename: "new/file.ts",
          previous_filename: "old/file.ts",
          status: "renamed",
        },
        { filename: "src-two/a", status: "modified" },
      ]),
    );
    expect(
      (await github.observe(watch({ paths: ["old", "src"] }))).matchedPaths,
    ).toEqual(["old"]);
    expect((await github.observe(watch({ paths: ["src"] }))).hasUpdate).toBe(
      false,
    );
  });
  it.each(["behind", "diverged", "unexpected"])(
    "requires review for %s history",
    async (status) => {
      const result = await client(comparison([], { status })).observe(
        watch({ paths: ["unrelated"] }),
      );
      expect(result).toMatchObject({
        comparison: status === "unexpected" ? "unknown" : status,
        needsReview: true,
        hasUpdate: true,
      });
    },
  );
  it("does not flag identical commits", async () => {
    const result = await client(comparison()).observe(
      watch({ baseline: HEAD }),
    );
    expect(result).toMatchObject({
      comparison: "identical",
      hasUpdate: false,
      needsReview: false,
    });
  });
  it("treats 300 files or incomplete comparison as potentially relevant", async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({
      filename: `unrelated/${i}`,
      status: "modified",
    }));
    expect(
      await client(comparison(files)).observe(watch({ paths: ["src"] })),
    ).toMatchObject({
      filesTruncated: true,
      needsReview: true,
      hasUpdate: true,
    });
    expect(
      await client(comparison([], { total_commits: 200 })).observe(
        watch({ paths: ["src"] }),
      ),
    ).toMatchObject({ needsReview: true, hasUpdate: true });
    expect(await client({ status: "ahead" }).observe(watch())).toMatchObject({
      needsReview: true,
      hasUpdate: true,
    });
  });
  it("reports rate-limit retry time and keeps untrusted response bodies out of errors", async () => {
    const github = new GitHubClient({
      now: () => 0,
      transport: async () => ({
        status: 429,
        headers: { "Retry-After": "120" },
        body: "secret",
      }),
    });
    await expect(github.observe(watch())).rejects.toMatchObject({
      retryAt: "1970-01-01T00:02:00.000Z",
      status: 429,
    });
    await expect(github.observe(watch())).rejects.not.toThrow("secret");
  });
  it("rejects oversized and malformed API responses", async () => {
    const large = new GitHubClient({
      transport: async () => ({
        status: 200,
        headers: {},
        body: "x".repeat(4 * 1024 * 1024 + 1),
      }),
    });
    await expect(large.observe(watch())).rejects.toBeInstanceOf(GitHubError);
    const broken = new GitHubClient({
      transport: async () => ({ status: 200, headers: {}, body: "no json" }),
    });
    await expect(broken.observe(watch())).rejects.toThrow("invalid JSON");
  });
});

describe("watch input boundaries", () => {
  it("normalizes HTTPS repository URLs and deduplicates literal scopes", () => {
    expect(
      normalizeDraft({
        ...watch(),
        repository: "https://github.com/example/tools.git/",
        paths: ["src/", "src"],
      }),
    ).toMatchObject({ repository: "example/tools", paths: ["src"] });
  });
  it.each([
    "https://evil.test/a/b",
    "https://user:pass@github.com/a/b",
    "https://github.com/a/b?x=1",
    "https://github.com/a/b/tree/main",
    "git@github.com:a/b",
    "a/../b",
  ])("rejects repository %s", (repository) => {
    expect(() => normalizeDraft({ ...watch(), repository })).toThrow();
  });
  it.each([
    "HEAD~2",
    "main^",
    "-main",
    "main..other",
    "main@{1}",
    "a b",
    "a//b",
  ])("rejects revision expression %s", (ref) => {
    expect(() => normalizeDraft({ ...watch(), ref })).toThrow();
  });
  it.each([
    "../src",
    "/src",
    "src/../x",
    "src/**",
    "src/*.ts",
    "C:/src",
    "src\\x",
    "src//x",
  ])("rejects unsafe scope %s", (path) => {
    expect(() => normalizeDraft({ ...watch(), paths: [path] })).toThrow();
  });
});
