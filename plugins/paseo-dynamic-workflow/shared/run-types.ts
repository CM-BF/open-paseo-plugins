import { z } from "zod";

export const RunStatusSchema = z.enum(["running", "stopping", "completed", "failed", "stopped", "interrupted"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const AgentStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "permission",
  "completed",
  "cached",
  "failed",
  "skipped",
]);
export type AgentCallStatus = z.infer<typeof AgentStatusSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const WorktreeSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  workspaceId: z.string().nullable(),
  changed: z.boolean().nullable(),
});

export const AgentCallSchema = z.object({
  callId: z.string(),
  label: z.string(),
  phase: z.string().nullable(),
  status: AgentStatusSchema,
  agentId: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  resultPreview: z.string().nullable(),
  error: z.string().nullable(),
  usage: UsageSchema,
  worktree: WorktreeSchema.nullable(),
  /** Follow-up prompts sent because the reply did not match the schema. */
  repairs: z.number(),
});
export type AgentCall = z.infer<typeof AgentCallSchema>;

export const PhaseSummarySchema = z.object({
  title: z.string(),
  detail: z.string().nullable(),
  total: z.number(),
  running: z.number(),
  queued: z.number().default(0),
  done: z.number(),
  failed: z.number(),
  /** Added after 0.1.0 shipped cards; old rows lack it. */
  skipped: z.number().default(0),
});
export type PhaseSummary = z.infer<typeof PhaseSummarySchema>;

export const LogLineSchema = z.object({ at: z.string(), message: z.string() });

export const RunSummarySchema = z.object({
  runId: z.string(),
  name: z.string(),
  description: z.string(),
  status: RunStatusSchema,
  parentAgentId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  agents: z.object({
    total: z.number(),
    running: z.number(),
    queued: z.number().default(0),
    done: z.number(),
    failed: z.number(),
    skipped: z.number().default(0),
    cached: z.number(),
  }),
  error: z.string().nullable(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunDetailSchema = RunSummarySchema.extend({
  whenToUse: z.string().nullable(),
  workspaceId: z.string().nullable(),
  cwd: z.string(),
  scriptPath: z.string(),
  runDir: z.string(),
  journalPath: z.string(),
  resumedFrom: z.string().nullable(),
  phases: z.array(PhaseSummarySchema),
  calls: z.array(AgentCallSchema),
  logs: z.array(LogLineSchema),
  resultPreview: z.string().nullable(),
  resultPath: z.string().nullable(),
  usage: UsageSchema,
  budget: z.object({ total: z.number().nullable(), spent: z.number() }),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

/** Data of the timeline row the daemon appends to the launching agent (64 KiB cap). */
export const CardDataSchema = z.object({
  runId: z.string(),
  name: z.string(),
  description: z.string(),
  status: RunStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  phases: z.array(PhaseSummarySchema),
  active: z.array(
    z.object({
      callId: z.string(),
      label: z.string(),
      phase: z.string().nullable(),
      status: AgentStatusSchema,
      startedAt: z.string().nullable(),
      agentId: z.string().nullable(),
    }),
  ),
  agents: RunSummarySchema.shape.agents,
  logs: z.array(z.string()),
  resultPreview: z.string().nullable(),
  error: z.string().nullable(),
  usage: UsageSchema,
});
export type CardData = z.infer<typeof CardDataSchema>;
