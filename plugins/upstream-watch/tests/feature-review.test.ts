import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  featureReviewSchema,
  reviewSchema,
  watchSchema,
} from "../shared/contracts";
import { cindyDraft, cindyReview } from "../shared/cindy";
import { featureReview } from "../shared/feature-review";

function watch() {
  return watchSchema.parse({
    ...cindyDraft(),
    id: randomUUID(),
    targetPath: "/tmp/plugin",
    createdAt: "2026-10-29",
    updatedAt: "2026-10-29",
    checkedAt: "2026-10-29T08:00:00Z",
    review: {
      mode: "recommend-only",
      features: [
        {
          id: "memory",
          title: "Memory",
          upstreamPaths: ["src/memory"],
          localPaths: ["server/memory.ts"],
          adoption: "adopted",
        },
        {
          id: "voice",
          title: "Voice",
          upstreamPaths: ["src/voice"],
          adoption: "missing",
        },
      ],
    },
    observation: {
      head: "b".repeat(40),
      ref: "main",
      url: "",
      title: "",
      date: "",
      compareUrl: "",
      comparison: "ahead",
      commits: [],
      commitsTotal: 1,
      files: [
        {
          path: "src/new-memory/a.ts",
          previousPath: "src/memory/a.ts",
          status: "renamed",
        },
        { path: "src/memoryless/a.ts", status: "modified" },
        { path: "src/new-core.ts", status: "added" },
      ],
      filesTruncated: false,
      matchedPaths: [],
      hasUpdate: true,
      needsReview: false,
    },
  });
}
describe("feature evidence review", () => {
  it("matches renames by old path, keeps path boundaries and exposes new unclassified candidates", () => {
    const current = watch();
    const report = featureReviewSchema.parse(featureReview(current));
    expect(report.features[0].changedFiles).toHaveLength(1);
    expect(report.unclassifiedFiles.map((file) => file.path)).toEqual([
      "src/memoryless/a.ts",
      "src/new-core.ts",
    ]);
    expect(report.features[0].sources[0].baselineUrl).toContain(
      current.baseline,
    );
    expect(report.features[0].sources[0].headUrl).toContain(
      current.observation!.head,
    );
    expect(report.compareUrl).toContain(
      `${current.baseline}...${current.observation!.head}`,
    );
  });
  it("retains missing inventory and last scan when there is no diff", () => {
    const current = watch();
    Object.assign(current.observation!, {
      head: current.baseline,
      files: [],
      comparison: "identical",
      hasUpdate: false,
    });
    const report = featureReview(current)!;
    expect(report.complete).toBe(true);
    expect(report.checkedAt).toBe(current.checkedAt);
    expect(report.features[1]).toMatchObject({
      adoption: "missing",
      evidence: "no-path-change",
    });
    expect(report.features[1].recommendation).toContain("补齐");
  });
  it.each([
    "truncated",
    "diverged",
    "behind",
    "unknown",
    "failed",
    "unscanned",
    "incomplete",
  ])("does not turn %s evidence into no change", (kind) => {
    const current = watch();
    if (kind === "truncated") current.observation!.filesTruncated = true;
    if (kind === "incomplete") current.observation!.needsReview = true;
    if (kind === "diverged" || kind === "behind" || kind === "unknown")
      current.observation!.comparison = kind;
    if (kind === "failed") current.error = "rate limited";
    if (kind === "unscanned") delete current.observation;
    const report = featureReview(current)!;
    expect(report.complete).toBe(false);
    expect(report.features[1].evidence).toBe("unknown");
    expect(report.features[1].adoption).toBe("missing");
  });
  it("old watches remain valid without review data", () => {
    const current = watch();
    delete current.review;
    expect(watchSchema.parse(current).review).toBeUndefined();
    expect(featureReview(current)).toBeUndefined();
  });
  it("rejects duplicate IDs, traversal, absolute paths and oversized inventories", () => {
    const review = cindyDraft().review!;
    expect(
      reviewSchema.safeParse({
        ...review,
        features: [review.features[0], review.features[0]],
      }).success,
    ).toBe(false);
    for (const path of [
      "../outside",
      "/private",
      "src/../outside",
      "src/*",
      "src\\outside",
    ]) {
      const changed = { ...review.features[0], localPaths: [path] };
      expect(
        reviewSchema.safeParse({ ...review, features: [changed] }).success,
      ).toBe(false);
    }
    const tooLarge = Array.from({ length: 24 }, (_, i) => ({
      ...review.features[0],
      id: `feature-${i}`,
      notes: "x".repeat(1500),
    }));
    expect(
      reviewSchema.safeParse({ ...review, features: tooLarge }).success,
    ).toBe(false);
  });
  it("ships an independent, conservative Cindy preset with the adopted pinned SHA", () => {
    const draft = cindyDraft();
    expect(draft.baseline).toBe("118767c987f518286ae10a506a54287c3dc2a560");
    expect(draft.repository).toBe("makecindy/cindy");
    expect(draft.paths).toEqual([]);
    draft.review!.features[0].notes = "edited";
    expect(cindyReview.features[0].notes).not.toBe("edited");
    expect(draft.targetPath).toBeUndefined();
  });
});
