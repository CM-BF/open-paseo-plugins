import type { Feature, Watch } from "./contracts";

export const adoptionLabels: Record<Feature["adoption"], string> = {
  adopted: "已移植",
  partial: "部分移植",
  missing: "待移植",
  "out-of-scope": "暂不纳入",
};
export function taskIntent(watch: Pick<Watch, "review">): "adapt" | "review" {
  return watch.review ? "review" : "adapt";
}
const matches = (path: string, prefixes: string[]) =>
  prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
export function sourceUrl(
  repository: string,
  sha: string,
  path: string,
): string {
  return `https://github.com/${repository}/tree/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A reproducible evidence index, not a claim that file changes reveal semantics. */
export function featureReview(watch: Watch) {
  if (!watch.review) return undefined;
  const observation = watch.observation;
  const complete = Boolean(
    observation &&
      !watch.error &&
      !observation.needsReview &&
      !observation.filesTruncated &&
      (observation.comparison === "ahead" ||
        observation.comparison === "identical"),
  );
  const features = watch.review.features.map((feature) => {
    const changedFiles = (observation?.files || []).filter(
      (file) =>
        matches(file.path, feature.upstreamPaths) ||
        (file.previousPath &&
          matches(file.previousPath, feature.upstreamPaths)),
    );
    let recommendation: string;
    if (feature.adoption === "out-of-scope") {
      recommendation = "保留范围外决定；有相关变化时重新评估收益和宿主成本。";
    } else if (
      feature.adoption === "missing" ||
      feature.adoption === "partial"
    ) {
      recommendation = "核对固定版本源码与本地实现，提出补齐此功能的具体建议。";
    } else {
      recommendation = changedFiles.length
        ? "复核这些变化是否需要同步到已有实现。"
        : "保留已移植声明，按源码和验证记录复核一致性。";
    }
    return {
      ...feature,
      changedFiles,
      evidence: changedFiles.length
        ? ("changed" as const)
        : complete
          ? ("no-path-change" as const)
          : ("unknown" as const),
      recommendation,
      sources: feature.upstreamPaths.map((path) => ({
        path,
        baselineUrl: watch.baseline
          ? sourceUrl(watch.repository, watch.baseline, path)
          : undefined,
        headUrl: observation
          ? sourceUrl(watch.repository, observation.head, path)
          : undefined,
      })),
    };
  });
  return {
    watchId: watch.id,
    baseline: watch.baseline,
    head: observation?.head,
    checkedAt: watch.checkedAt,
    error: watch.error,
    complete,
    compareUrl:
      watch.baseline && observation
        ? `https://github.com/${watch.repository}/compare/${watch.baseline}...${observation.head}`
        : undefined,
    features,
    unclassifiedFiles: (observation?.files || []).filter(
      (file) =>
        !features.some((feature) => feature.changedFiles.includes(file)),
    ),
  };
}
