import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { CanvasBaseSchema, IdSchema, JsonDataSchema } from "./contracts";

export const ReleaseIdSchema = z.string().regex(/^release-[a-f0-9]{64}$/);
export const PublicApiOriginSchema = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    const validHost = /^\[[a-f0-9:]+\]$/i.test(url.hostname) || url.hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
    return validHost && url.origin === value && !url.username && !url.password &&
      (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}, "API 地址应为 HTTPS 来源（例如 https://api.example.com），本机测试可用 HTTP loopback；不含路径或凭据");
export const PublicApiOriginsSchema = z.array(PublicApiOriginSchema).max(8).refine(values => new Set(values).size === values.length, "API 来源不能重复");
export const LIVE_LIMITS = { paths: 32, documentBytes: 60_000 } as const;
export const LiveChannelIdSchema = z.string().regex(/^c[a-f0-9]{32}$/);
const unsafeLiveSegments = new Set(["__proto__", "prototype", "constructor"]);
/** Decoded segments of a JSON Pointer; the caller has already validated the pointer. */
export const livePathSegments = (path: string) => path.slice(1).split("/").map(part => part.replace(/~[01]/g, escape => escape === "~0" ? "~" : "/"));
/** Non-root JSON Pointer under the same rules as conditional data patches. */
export const LivePathSchema = z.string().max(500).refine(path => {
  if (!path.startsWith("/") || /~(?:[^01]|$)/.test(path)) return false;
  const parts = livePathSegments(path);
  return parts.length <= 64 && !parts.some(part => unsafeLiveSegments.has(part));
}, "公开路径应为非根 JSON Pointer，不能含危险键，最多 500 字符、64 层");
/** One path may never contain another: otherwise a narrowing could silently keep the wider one. */
export const livePathsDisjoint = (paths: readonly string[]) => {
  if (paths.length > LIVE_LIMITS.paths) return false;
  const decoded = paths.map(livePathSegments);
  return decoded.every((parts, index) => decoded.every((other, at) =>
    at <= index || !parts.slice(0, Math.min(parts.length, other.length)).every((part, position) => part === other[position])));
};
export const LiveStateSchema = z.enum(["off", "pending", "syncing", "live", "retrying", "paused", "too-large", "blocked", "revoking", "revoked"]);
export const LiveReleaseSchema = z.object({
  origin: PublicApiOriginSchema, channelId: LiveChannelIdSchema,
  paths: z.array(LivePathSchema).min(1).max(LIVE_LIMITS.paths).refine(paths => livePathsDisjoint(paths) && paths.every((path, index) => index === 0 || paths[index - 1] < path), "实时路径必须排序、唯一且互不包含"),
}).strict();
export const LiveDriftSchema = z.object({
  addedPaths: z.array(z.string()), removedPaths: z.array(z.string()), originChanged: z.boolean(),
  channelState: z.union([LiveStateSchema, z.literal("none")]),
}).strict();
export const ReleaseManifestSchema = z.object({
  formatVersion: z.literal(1), releaseId: ReleaseIdSchema, artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string(), viewerVersion: z.number().int(), network: z.enum(["offline", "cdn"]),
  apiOrigins: PublicApiOriginsSchema.optional(),
  live: LiveReleaseSchema.optional(),
  dependencies: z.array(z.string()), warnings: z.array(z.string()),
  files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number().int().nonnegative() })),
});
// Zod refuses .omit() on a refined object, so the RPC shape derives from this unrefined base.
export const ReleaseCreateBaseSchema = z.object({
  boardId: IdSchema, expectedCanvasBase: CanvasBaseSchema, publicData: JsonDataSchema,
  title: z.string().min(1).max(200).optional(), network: z.enum(["offline", "cdn"]).default("offline"),
  theme: z.enum(["light", "dark"]).default("light"),
  apiOrigins: PublicApiOriginsSchema.default([]),
  live: LiveReleaseSchema.optional(),
});
/** The client asks for live data by flag only; the server resolves channel, origin and paths. */
export const ReleaseCreateRpcSchema = ReleaseCreateBaseSchema.omit({ live: true }).extend({ liveData: z.boolean().optional() });
export const ReleaseCreateSchema = ReleaseCreateBaseSchema.superRefine((value, context) => {
  if (value.live && !value.apiOrigins.includes(value.live.origin)) context.addIssue({ code: "custom", path: ["live", "origin"], message: "实时数据来源必须包含在 apiOrigins 中" });
});
/** Private: the exact inputs that produced one release; reused by one-click share updates. */
export const ReleaseSettingsSchema = z.object({
  title: z.string(), network: z.enum(["offline", "cdn"]), theme: z.enum(["light", "dark"]),
  apiOrigins: PublicApiOriginsSchema, publicData: JsonDataSchema,
  live: LiveReleaseSchema.optional(),
});
export const ReleaseSourceSchema = z.object({
  boardId: IdSchema, boardCreatedAt: z.string(), canvasBase: CanvasBaseSchema,
  documentVersion: z.number().int().nonnegative(), patchCount: z.number().int().nonnegative(),
});
/** Write-once private sidecar `<releaseId>.settings.json`; never public. */
export const ReleaseMetaSchema = z.object({
  formatVersion: z.literal(1), releaseId: ReleaseIdSchema, settings: ReleaseSettingsSchema,
  source: ReleaseSourceSchema, createdAt: z.string(),
});
/** Client-minted series key (`s`+20 hex), or an adopted pre-feature release directory hex. */
export const ShareKeySchema = z.string().regex(/^(s[a-f0-9]{20}|[a-f0-9]{64})$/);
export const PagesRefusalCodeSchema = z.enum(["series-busy", "newer-on-share", "share-foreign", "up-to-date", "share-files-mismatch"]);
// A GitHub host is an authority, never a URL or an arbitrary API path.
export const GitHubHostSchema = z.string().min(1).max(253).transform(value => value.toLowerCase()).refine(value =>
  !/[^a-z0-9.-]/.test(value) && value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)), "Invalid GitHub hostname");
export const GitHubLoginSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/)
  .refine(value => !/[^a-zA-Z0-9_.-]/.test(value), "Invalid GitHub login");
export const GitHubRepositoryNameSchema = z.string().max(300).refine(value => {
  const parts = value.split("/");
  return parts.length === 2 && parts.every(part => part.length > 0 && part !== "." && part !== ".." && !/[^a-zA-Z0-9_.-]/.test(part));
}, "Expected owner/repository without path traversal");
export const GitHubAccountSchema = z.object({ login: GitHubLoginSchema, host: GitHubHostSchema, active: z.boolean() });
export const GitHubRepositorySchema = z.object({ name: z.string(), private: z.boolean(), url: z.string() });
export const PagesPrepareSchema = z.object({
  eventId: IdSchema, releaseId: ReleaseIdSchema, artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  githubHost: GitHubHostSchema.optional(),
  account: GitHubLoginSchema, repository: GitHubRepositoryNameSchema,
  createRepository: z.enum(["public", "private"]).optional(),
  shareKey: ShareKeySchema.optional(),
});
export const PagesJobSchema = PagesPrepareSchema.extend({
  jobId: IdSchema, status: z.enum(["prepared", "pr-open", "merged", "deploying", "live", "failed", "unknown"]),
  branch: z.string(), baseBranch: z.string().optional(), baseSha: z.string().optional(), headSha: z.string().optional(),
  prNumber: z.number().int().optional(), prUrl: z.string().optional(), mergedSha: z.string().optional(),
  deploymentId: z.string().optional(), url: z.string().optional(), deployedUrl: z.string().optional(), verifiedAt: z.string().optional(), error: z.string().optional(),
  treeSha: z.string().optional(), createdAt: z.string().optional(), pagesConfigured: z.boolean().optional(), pagesConfigurationRequested: z.boolean().optional(),
  pagesConfigurationHash: z.string().optional(),
  publicationMode: z.enum(["workflow", "legacy-subdirectory", "legacy-branch"]).optional(),
  // Legacy jobs: boards/<releaseHex>. Series jobs: the version archive boards/<key>/v/<releaseHex>.
  sitePath: z.string().regex(/^boards\/(?:[a-f0-9]{64}|(?:s[a-f0-9]{20}|[a-f0-9]{64})\/v\/[a-f0-9]{64})$/).optional(), sourcePath: z.enum(["/", "/docs"]).optional(),
  autoPublish: z.boolean().optional(), autoPublishUntil: z.string().datetime().optional(),
  // Stable share directory relative to the source root (absent = Pages root in workflow mode).
  sharePath: z.string().regex(/^boards\/(?:s[a-f0-9]{20}|[a-f0-9]{64})$/).optional(),
  shareDeployedUrl: z.string().optional(), shareUrl: z.string().optional(), adoptedFrom: IdSchema.optional(),
  refusal: z.object({ code: PagesRefusalCodeSchema, message: z.string() }).optional(),
});
const ShareSourceSchema = z.object({ canvasBase: CanvasBaseSchema, documentVersion: z.number().int().nonnegative(), patchCount: z.number().int().nonnegative().optional() });
export const ShareSchema = z.object({
  seriesId: IdSchema, githubHost: GitHubHostSchema, account: GitHubLoginSchema, repository: GitHubRepositoryNameSchema,
  shareKey: ShareKeySchema.optional(), adoptable: z.boolean(), link: z.string().optional(), verified: z.boolean(),
  state: z.enum(["up-to-date", "changed", "legacy", "updating", "merged-unverified", "failed"]),
  releaseId: ReleaseIdSchema, title: z.string(), publishedJobId: IdSchema, settingsAvailable: z.boolean(),
  source: ShareSourceSchema, inFlightJobId: IdSchema.optional(),
  // Branch-directory shares keep older versions online under <link>v/<hex>/; workflow (Pages root) shares do not.
  archivesOnline: z.boolean().optional(),
  // Summary of the stored settings an update inherits; public data is reported only by size.
  settings: z.object({ network: z.enum(["offline", "cdn"]), theme: z.enum(["light", "dark"]), apiOrigins: PublicApiOriginsSchema, publicDataBytes: z.number().int().nonnegative(), live: z.object({ origin: PublicApiOriginSchema, paths: z.array(z.string()) }).optional() }).optional(),
});
export const ShareStatusSchema = z.object({
  current: ShareSourceSchema.required(), shares: z.array(ShareSchema),
});
export const ShareUpdateSchema = z.object({
  boardId: IdSchema, seriesId: IdSchema,
  expectedSource: z.object({ documentVersion: z.number().int().nonnegative(), patchCount: z.number().int().nonnegative() }),
  liveMode: z.enum(["keep", "current"]).default("keep"),
});
export const ShareUpdateResultSchema = z.union([
  z.object({ upToDate: z.literal(true), liveDrift: LiveDriftSchema.optional() }),
  z.object({ manifest: ReleaseManifestSchema, request: PagesPrepareSchema.omit({ eventId: true, createRepository: true }), liveDrift: LiveDriftSchema.optional() }),
]);
export type LiveRelease = z.infer<typeof LiveReleaseSchema>;
export type LiveState = z.infer<typeof LiveStateSchema>;
export type LiveDrift = z.infer<typeof LiveDriftSchema>;
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
export type ReleaseCreateInput = z.input<typeof ReleaseCreateSchema>;
export type PagesPrepareInput = z.infer<typeof PagesPrepareSchema>;
export type PagesJob = z.infer<typeof PagesJobSchema>;
export type GitHubAccount = z.infer<typeof GitHubAccountSchema>;
export type ReleaseSettings = z.infer<typeof ReleaseSettingsSchema>;
export type ReleaseMeta = z.infer<typeof ReleaseMetaSchema>;
export type Share = z.infer<typeof ShareSchema>;
export type ShareStatus = z.infer<typeof ShareStatusSchema>;
export type ShareUpdateResult = z.infer<typeof ShareUpdateResultSchema>;
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;
const releaseInput = z.object({ releaseId: ReleaseIdSchema });
export const createReleaseRpc = defineRpc({ name: "board.release.create", input: ReleaseCreateRpcSchema, output: ReleaseManifestSchema });
export const listReleasesRpc = defineRpc({ name: "board.release.list", input: z.object({ boardId: IdSchema }), output: z.array(ReleaseManifestSchema) });
export const previewReleaseRpc = defineRpc({ name: "board.release.preview", input: releaseInput, output: z.object({ manifest: ReleaseManifestSchema, html: z.string() }) });
export const downloadReleaseRpc = defineRpc({ name: "board.release.download", input: releaseInput, output: z.object({ manifest: ReleaseManifestSchema, fileName: z.string(), zipBase64: z.string() }) });
export const githubAccountsRpc = defineRpc({ name: "board.pages.accounts", input: z.object({ githubHost: GitHubHostSchema.optional() }), output: z.array(GitHubAccountSchema) });
export const githubRepositoriesRpc = defineRpc({ name: "board.pages.repositories", input: z.object({ account: GitHubLoginSchema, githubHost: GitHubHostSchema.optional() }), output: z.array(GitHubRepositorySchema) });
export const preparePagesRpc = defineRpc({ name: "board.pages.prepare", input: PagesPrepareSchema, output: PagesJobSchema });
export const publishPagesRpc = defineRpc({ name: "board.pages.publish", input: PagesPrepareSchema, output: PagesJobSchema });
export const mergePagesRpc = defineRpc({ name: "board.pages.merge", input: z.object({ jobId: IdSchema, expectedHead: z.string().regex(/^[a-f0-9]{40}$/) }), output: PagesJobSchema });
export const refreshPagesRpc = defineRpc({ name: "board.pages.refresh", input: z.object({ jobId: IdSchema }), output: PagesJobSchema });
// Host-user only, like every release/pages RPC: never on the agent bridge or MCP. Plugin RPC names are lowercase.
export const shareStatusRpc = defineRpc({ name: "board.release.share-status", input: z.object({ boardId: IdSchema }), output: ShareStatusSchema });
export const shareUpdateRpc = defineRpc({ name: "board.release.share-update", input: ShareUpdateSchema, output: ShareUpdateResultSchema });
export const listPagesJobsRpc = defineRpc({ name: "board.pages.list", input: z.object({ releaseId: ReleaseIdSchema.optional() }), output: z.array(PagesJobSchema) });
