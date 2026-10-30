import {
  watchDraftSchema,
  type Watch,
  type WatchDraft,
} from "../shared/contracts";

export function normalizeRepository(input: string): string {
  let value = input.trim();
  if (value.includes("://")) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(
        "Use owner/repo or an https://github.com/owner/repo URL.",
      );
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "Repository URLs must use https://github.com without credentials, query or fragment.",
      );
    }
    value = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  }
  value = value.replace(/\.git$/, "");
  const parts = value.split("/");
  if (
    parts.length !== 2 ||
    !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(parts[0]!) ||
    !/^[a-z\d._-]{1,100}$/i.test(parts[1]!) ||
    [".", ".."].includes(parts[1]!)
  ) {
    throw new Error(
      "Repository must identify one GitHub owner/repo, without a branch or subdirectory.",
    );
  }
  return parts.join("/");
}

export function normalizeRef(input: string): string {
  const ref = input.trim();
  if (!ref) return "";
  if (
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref === "@" ||
    /[\s\x00-\x1f\x7f~^:?*\[\]\\]/.test(ref) ||
    ref
      .split("/")
      .some((part) => part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error(
      "Ref must be a branch, tag or full commit SHA, without Git revision expressions.",
    );
  }
  return ref;
}

export function normalizePaths(input: string[]): string[] {
  return [
    ...new Set(
      input.map((raw) => {
        const path = raw.trim().replace(/\/+$/, "");
        if (
          !path ||
          path.startsWith("/") ||
          /[\\\x00-\x1f\x7f*?\[\]{}]/.test(path) ||
          /^[a-z]:/i.test(path) ||
          path.split("/").some((part) => !part || part === "." || part === "..")
        ) {
          throw new Error(
            "Paths must be literal repository-relative files or directories, without globs or parent traversal.",
          );
        }
        return path;
      }),
    ),
  ];
}

export function normalizeDraft(input: WatchDraft): WatchDraft {
  const draft = watchDraftSchema.parse(input);
  return {
    ...draft,
    repository: normalizeRepository(draft.repository),
    ref: normalizeRef(draft.ref),
    paths: normalizePaths(draft.paths),
  };
}

export function configurationKey(watch: Watch): string {
  return JSON.stringify(watchDraftSchema.parse(watch));
}

export function matchesPath(path: string, scope: string): boolean {
  return path === scope || path.startsWith(`${scope}/`);
}
