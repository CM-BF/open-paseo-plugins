import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_WORKFLOW_SIZE, WORKFLOW_SIZES } from "./guidance";

export const PreferencesSchema = z.object({
  /** Preapprove the workflow MCP tools (Claude, Codex; never OpenCode). */
  preapproveTools: z.boolean().default(true),
  /** Concurrent child agents per run. 0 means min(16, max(2, CPUs - 2)). */
  maxConcurrentAgents: z.number().int().min(0).max(16).default(0),
  /** Child agents a run may start over its lifetime. */
  maxAgentsPerRun: z.number().int().min(1).max(1000).default(1000),
  /** Archive each child agent once its result is recorded. */
  archiveFinishedAgents: z.boolean().default(true),
  /** Stop a child agent that runs longer than this. 0 means no limit. */
  agentTimeoutMinutes: z.number().int().min(0).max(24 * 60).default(0),
  /** Size guideline the workflow tool states to agents without Ultracode (small 5, medium 10, large 50 agents). */
  workflowSize: z.enum(WORKFLOW_SIZES).default(DEFAULT_WORKFLOW_SIZE),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = PreferencesSchema.parse({});

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 2,
  schema: PreferencesSchema,
  // The former global injection flag is intentionally discarded; agent access starts disabled.
  migrate: (values) => PreferencesSchema.parse(values),
});
