import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { CanvasBaseSchema, IdSchema, JsonDataSchema } from "./contracts";

export const ReleaseIdSchema = z.string().regex(/^release-[a-f0-9]{64}$/);
export const ReleaseManifestSchema = z.object({
  formatVersion: z.literal(1), releaseId: ReleaseIdSchema, artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string(), viewerVersion: z.number().int(), network: z.enum(["offline", "cdn"]),
  dependencies: z.array(z.string()), warnings: z.array(z.string()),
  files: z.array(z.object({ path: z.string(), sha256: z.string(), bytes: z.number().int().nonnegative() })),
});
export const ReleaseCreateSchema = z.object({
  boardId: IdSchema, expectedCanvasBase: CanvasBaseSchema, publicData: JsonDataSchema,
  title: z.string().min(1).max(200).optional(), network: z.enum(["offline", "cdn"]).default("offline"),
  theme: z.enum(["light", "dark"]).default("light"),
});
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
});
export const PagesJobSchema = PagesPrepareSchema.extend({
  jobId: IdSchema, status: z.enum(["prepared", "pr-open", "merged", "deploying", "live", "failed", "unknown"]),
  branch: z.string(), baseBranch: z.string().optional(), baseSha: z.string().optional(), headSha: z.string().optional(),
  prNumber: z.number().int().optional(), prUrl: z.string().optional(), mergedSha: z.string().optional(),
  deploymentId: z.string().optional(), url: z.string().optional(), deployedUrl: z.string().optional(), verifiedAt: z.string().optional(), error: z.string().optional(),
  treeSha: z.string().optional(), createdAt: z.string().optional(), pagesConfigured: z.boolean().optional(), pagesConfigurationRequested: z.boolean().optional(),
  pagesConfigurationHash: z.string().optional(),
  publicationMode: z.enum(["workflow", "legacy-subdirectory", "legacy-branch"]).optional(),
  sitePath: z.string().regex(/^boards\/[a-f0-9]{64}$/).optional(), sourcePath: z.enum(["/", "/docs"]).optional(),
  autoPublish: z.boolean().optional(), autoPublishUntil: z.string().datetime().optional(),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;
export type ReleaseCreateInput = z.input<typeof ReleaseCreateSchema>;
export type PagesPrepareInput = z.infer<typeof PagesPrepareSchema>;
export type PagesJob = z.infer<typeof PagesJobSchema>;
export type GitHubAccount = z.infer<typeof GitHubAccountSchema>;
export type GitHubRepository = z.infer<typeof GitHubRepositorySchema>;
const releaseInput = z.object({ releaseId: ReleaseIdSchema });
export const createReleaseRpc = defineRpc({ name: "board.release.create", input: ReleaseCreateSchema, output: ReleaseManifestSchema });
export const listReleasesRpc = defineRpc({ name: "board.release.list", input: z.object({ boardId: IdSchema }), output: z.array(ReleaseManifestSchema) });
export const previewReleaseRpc = defineRpc({ name: "board.release.preview", input: releaseInput, output: z.object({ manifest: ReleaseManifestSchema, html: z.string() }) });
export const downloadReleaseRpc = defineRpc({ name: "board.release.download", input: releaseInput, output: z.object({ manifest: ReleaseManifestSchema, fileName: z.string(), zipBase64: z.string() }) });
export const githubAccountsRpc = defineRpc({ name: "board.pages.accounts", input: z.object({ githubHost: GitHubHostSchema.optional() }), output: z.array(GitHubAccountSchema) });
export const githubRepositoriesRpc = defineRpc({ name: "board.pages.repositories", input: z.object({ account: GitHubLoginSchema, githubHost: GitHubHostSchema.optional() }), output: z.array(GitHubRepositorySchema) });
export const preparePagesRpc = defineRpc({ name: "board.pages.prepare", input: PagesPrepareSchema, output: PagesJobSchema });
export const publishPagesRpc = defineRpc({ name: "board.pages.publish", input: PagesPrepareSchema, output: PagesJobSchema });
export const mergePagesRpc = defineRpc({ name: "board.pages.merge", input: z.object({ jobId: IdSchema, expectedHead: z.string().regex(/^[a-f0-9]{40}$/) }), output: PagesJobSchema });
export const refreshPagesRpc = defineRpc({ name: "board.pages.refresh", input: z.object({ jobId: IdSchema }), output: PagesJobSchema });
export const listPagesJobsRpc = defineRpc({ name: "board.pages.list", input: z.object({ releaseId: ReleaseIdSchema.optional() }), output: z.array(PagesJobSchema) });
