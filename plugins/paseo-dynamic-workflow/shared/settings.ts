import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PreferencesSchema = z.object({
  /** Add the workflow tools and instructions to agents created from now on. */
  injectIntoNewAgents: z.boolean().default(true),
  /** Preapprove the workflow MCP tools (Claude, Codex; never OpenCode). */
  preapproveTools: z.boolean().default(true),
  /** Concurrent child agents per run. 0 means min(8, CPUs - 2). */
  maxConcurrentAgents: z.number().int().min(0).max(16).default(0),
  /** Child agents a run may start over its lifetime. */
  maxAgentsPerRun: z.number().int().min(1).max(1000).default(1000),
  /** Archive each child agent once its result is recorded. */
  archiveFinishedAgents: z.boolean().default(true),
  /** Stop a child agent that runs longer than this. 0 means no limit. */
  agentTimeoutMinutes: z.number().int().min(0).max(24 * 60).default(0),
});
export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = PreferencesSchema.parse({});

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: PreferencesSchema,
});
