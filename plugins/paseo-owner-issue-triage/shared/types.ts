import { z } from "zod";

export const PLUGIN_ID = "paseo-owner-issue-triage";
export const VERSION = "0.1.0";
export const RepoSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/).transform((v) => v.toLowerCase());
export const WorkerConfigSchema = z.object({
  provider: z.string().min(1).max(80).default("codex"),
  model: z.string().min(1).max(120).default("gpt-6-astra"),
  modeId: z.string().min(1).max(80).default("full-access"),
  thinkingOptionId: z.string().max(80).default("ultra"),
  featureValues: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).default({ service_tier: "priority" }),
});
export const ConfigSchema = z.object({
  enabled: z.boolean().default(false),
  repos: z.array(RepoSchema).max(10).default([]),
  pollSeconds: z.number().int().min(60).max(86400).default(180),
  backfillDays: z.number().int().min(0).max(365).default(0),
  worker: WorkerConfigSchema.prefault({}),
  workerTimeoutSeconds: z.number().int().min(60).max(7200).default(1800),
});
export type Config = z.infer<typeof ConfigSchema>;
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;
export const OwnerSchema = z.object({ id: z.number().int().positive(), login: z.string() });
export const SnapshotSchema = z.object({
  repo: z.string(), number: z.number().int().positive(), title: z.string(), body: z.string(),
  url: z.string(), authorId: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(),
  state: z.enum(["open", "closed"]),
  comments: z.array(z.object({ id: z.number(), body: z.string(), createdAt: z.string(), updatedAt: z.string() })),
  fingerprint: z.string(),
});
export type IssueSnapshot = z.infer<typeof SnapshotSchema>;
export const ResultSchema = z.object({
  category: z.enum(["bug", "feature", "docs", "question", "maintenance", "unknown"]),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  plugins: z.array(z.string().max(100)).max(20),
  summary: z.string().min(1).max(4000),
  nextSteps: z.array(z.string().max(2000)).max(15),
  confidence: z.enum(["low", "medium", "high"]),
});
export type TriageResult = z.infer<typeof ResultSchema>;
export const RunSchema = z.object({
  id: z.string(), agentId: z.string(), fingerprint: z.string(), snapshot: SnapshotSchema,
  startedAt: z.string(), finishedAt: z.string().nullable().default(null),
  phase: z.enum(["reserved", "running", "completed", "failed"]),
  result: ResultSchema.nullable().default(null), error: z.string().nullable().default(null),
  settings: WorkerConfigSchema, attempt: z.number().int().positive(),
});
export type Run = z.infer<typeof RunSchema>;
export const ItemStatusSchema = z.enum(["discovered", "queued", "analyzing", "completed", "failed", "claimed", "closed"]);
export const ItemSchema = z.object({
  key: z.string(), source: z.enum(["github", "diagnostic"]).default("github"), snapshot: SnapshotSchema,
  unavailable: z.boolean().default(false), retryRequested: z.boolean().default(false),
  status: ItemStatusSchema, discoveredAt: z.string(), updatedAt: z.string(),
  claimed: z.string().nullable().default(null),
  processedFingerprint: z.string().nullable().default(null),
  run: RunSchema.nullable().default(null), history: z.array(RunSchema).default([]),
  error: z.string().nullable().default(null), retryAt: z.number().nullable().default(null),
  attempts: z.number().int().nonnegative().default(0),
});
export type Item = z.infer<typeof ItemSchema>;
export const ScanSchema = z.object({
  lastStartedAt: z.string().nullable().default(null), lastSucceededAt: z.string().nullable().default(null),
  nextAt: z.number().default(0), failures: z.number().int().nonnegative().default(0), error: z.string().nullable().default(null),
  cursors: z.record(z.string(), z.string()).default({}),
});
export const StateSchema = z.object({
  version: z.literal(1).default(1), createdAt: z.string(), enabledAt: z.string().nullable().default(null),
  owner: OwnerSchema.nullable().default(null), config: ConfigSchema.prefault({}),
  scan: ScanSchema.prefault({}), items: z.array(ItemSchema).default([]),
  claims: z.record(z.string(), z.string()).default({}),
});
export type State = z.infer<typeof StateSchema>;
export const OverviewSchema = z.object({
  version: z.string(), owner: OwnerSchema.nullable(), config: ConfigSchema,
  scan: ScanSchema, scanning: z.boolean(), workerError: z.string().nullable(),
  items: z.array(ItemSchema), counts: z.record(z.string(), z.number()),
});
export type Overview = z.infer<typeof OverviewSchema>;
export const CatalogSchema = z.object({
  providers: z.array(z.object({ id: z.string(), models: z.array(z.object({ id: z.string(), label: z.string(), thinking: z.array(z.string()) })), modes: z.array(z.object({ id: z.string(), label: z.string() })) })),
});
