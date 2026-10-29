import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const relativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/[\\\0\r\n*?\[\]]/.test(value) &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
    "请填写仓库内的相对文件名或目录，不使用 glob 或 ..",
  );
export const featureSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().trim().min(1).max(120),
  upstreamPaths: z.array(relativePathSchema).min(1).max(12),
  localPaths: z.array(relativePathSchema).max(12).default([]),
  adoption: z.enum(["adopted", "partial", "missing", "out-of-scope"]),
  notes: z.string().max(1500).default(""),
});
export type Feature = z.infer<typeof featureSchema>;
export const reviewSchema = z
  .object({
    mode: z.literal("recommend-only"),
    features: z.array(featureSchema).min(1).max(24),
  })
  .refine(
    (value) =>
      new Set(value.features.map((item) => item.id)).size ===
      value.features.length,
    "功能 ID 不能重复",
  )
  .refine((value) => JSON.stringify(value).length <= 20_000, "功能清单过长");
export const watchDraftSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  pluginId: z.string().trim().max(120).default(""),
  targetPath: z.string().trim().min(1).max(2000),
  repository: z.string().trim().min(3).max(200),
  ref: z.string().trim().max(200).default(""),
  paths: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  relationship: z.enum(["fork", "reference", "feature"]).default("reference"),
  notes: z.string().max(4000).default(""),
  baseline: revisionSchema.optional(),
  enabled: z.boolean().default(true),
  workspaceId: z
    .string()
    .regex(/^wks_[a-f0-9]{16}$/)
    .optional(),
  provider: z.string().trim().max(200).default(""),
  review: reviewSchema.optional(),
});
export type WatchDraft = z.infer<typeof watchDraftSchema>;
export const observationSchema = z.object({
  head: revisionSchema,
  ref: z.string(),
  url: z.string(),
  title: z.string(),
  date: z.string(),
  compareUrl: z.string(),
  comparison: z.enum(["ahead", "identical", "behind", "diverged", "unknown"]),
  commits: z.array(
    z.object({ sha: revisionSchema, title: z.string(), url: z.string() }),
  ),
  commitsTotal: z.number().int().nonnegative(),
  files: z.array(
    z.object({
      path: z.string(),
      status: z.string(),
      previousPath: z.string().optional(),
    }),
  ),
  filesTruncated: z.boolean(),
  matchedPaths: z.array(z.string()),
  hasUpdate: z.boolean(),
  needsReview: z.boolean(),
});
export type Observation = z.infer<typeof observationSchema>;
export const watchSchema = watchDraftSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  checkedAt: z.string().optional(),
  error: z.string().optional(),
  retryAt: z.string().optional(),
  observation: observationSchema.optional(),
});
export type Watch = z.infer<typeof watchSchema>;
export const featureReviewSchema = z.object({
  watchId: z.string().uuid(),
  baseline: revisionSchema.optional(),
  head: revisionSchema.optional(),
  checkedAt: z.string().optional(),
  error: z.string().optional(),
  complete: z.boolean(),
  compareUrl: z.string().optional(),
  features: z.array(
    featureSchema.extend({
      changedFiles: observationSchema.shape.files,
      evidence: z.enum(["changed", "no-path-change", "unknown"]),
      recommendation: z.string(),
      sources: z.array(
        z.object({
          path: z.string(),
          baselineUrl: z.string().optional(),
          headUrl: z.string().optional(),
        }),
      ),
    }),
  ),
  unclassifiedFiles: observationSchema.shape.files,
});
export const settingsSchema = z.object({
  enabled: z.boolean().default(true),
  intervalHours: z.number().int().min(1).max(168).default(24),
});
export type Settings = z.infer<typeof settingsSchema>;
export const stateSchema = z.object({
  version: z.literal(1),
  watches: z.array(watchSchema),
  settings: settingsSchema,
});
export type State = z.infer<typeof stateSchema>;
export const taskSchema = z.object({
  id: z.string().uuid(),
  watchId: z.string().uuid(),
  head: revisionSchema,
  intent: z.enum(["adapt", "review"]).default("adapt"),
  title: z.string(),
  workspaceId: z.string(),
  targetPath: z.string(),
  provider: z.string(),
  prompt: z.string(),
  createdAt: z.string(),
  status: z.enum(["preparing", "created", "uncertain", "failed"]),
  agentId: z.string().optional(),
  error: z.string().optional(),
});
export type UpdateTask = z.infer<typeof taskSchema>;
export const overviewRpc = defineRpc({
  name: "overview.get",
  input: z.object({}),
  output: z.object({
    watches: z.array(watchSchema),
    settings: settingsSchema,
    checking: z.boolean(),
    authentication: z.enum(["gh", "anonymous"]),
    tasks: z.array(taskSchema),
    reviews: z.array(featureReviewSchema).default([]),
  }),
});
export const saveRpc = defineRpc({
  name: "watch.save",
  input: watchDraftSchema,
  output: watchSchema,
});
export const removeRpc = defineRpc({
  name: "watch.remove",
  input: z.object({ id: z.string().uuid() }),
  output: z.object({ ok: z.boolean() }),
});
export const checkRpc = defineRpc({
  name: "watch.check",
  input: z.object({ id: z.string().uuid().optional() }),
  output: z.object({ started: z.boolean() }),
});
export const acknowledgeRpc = defineRpc({
  name: "watch.acknowledge",
  input: z.object({ id: z.string().uuid(), head: revisionSchema }),
  output: watchSchema,
});
export const settingsRpc = defineRpc({
  name: "settings.save",
  input: settingsSchema,
  output: settingsSchema,
});
export const launchRpc = defineRpc({
  name: "agent.launch",
  input: z.object({
    watchId: z.string().uuid(),
    head: revisionSchema,
    workspaceId: z.string().regex(/^wks_[a-f0-9]{16}$/),
    provider: z.string().min(1).max(200),
  }),
  output: taskSchema,
});
export const retryTaskRpc = defineRpc({
  name: "agent.retry",
  input: z.object({ taskId: z.string().uuid() }),
  output: taskSchema,
});
export const environmentRpc = defineRpc({
  name: "environment.get",
  input: z.object({}),
  output: z.object({
    workspaces: z.array(
      z.object({ id: z.string(), name: z.string(), directory: z.string() }),
    ),
    providers: z.array(z.object({ id: z.string(), label: z.string() })),
  }),
});
export const modelsRpc = defineRpc({
  name: "models.get",
  input: z.object({ provider: z.string(), cwd: z.string().optional() }),
  output: z.array(z.object({ id: z.string(), label: z.string() })),
});
export const discoveryRpc = defineRpc({
  name: "sources.discover",
  input: z.object({ root: z.string().optional() }),
  output: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      installedPath: z.string(),
      targetPath: z.string().optional(),
      sources: z.array(
        z.object({
          repository: z.string(),
          ref: z.string(),
          baseline: revisionSchema.optional(),
          paths: z.array(z.string()),
          relationship: z.enum(["fork", "reference", "feature"]),
          notes: z.string(),
        }),
      ),
      note: z.string(),
    }),
  ),
});

export function pendingCount(watches: Watch[]): number {
  return watches.filter(
    (watch) => watch.enabled && watch.observation?.hasUpdate,
  ).length;
}
