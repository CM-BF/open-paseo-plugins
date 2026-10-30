import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { DEFAULT_MEMORY_CHAR_LIMIT, DEFAULT_PROJECT_CHAR_LIMIT, DEFAULT_USER_CHAR_LIMIT } from "./constants";

export const WRITE_APPROVAL = ["off", "background", "all"] as const;
export type WriteApproval = (typeof WRITE_APPROVAL)[number];

const limit = (fallback: number) => z.number().int().min(200).max(20_000).default(fallback);

export const preferencesSchema = z.object({
  /** Add the memory snapshot, skills index and guidance to new agents' system prompts. */
  injectPrompt: z.boolean().default(true),
  /** Add the learning MCP server (memory, skills, session_search) to new Claude, Codex and OpenCode agents. */
  injectTools: z.boolean().default(true),
  /** Preapprove the learning tools so agents do not ask before every memory write. */
  preapproveTools: z.boolean().default(true),
  userCharLimit: limit(DEFAULT_USER_CHAR_LIMIT),
  memoryCharLimit: limit(DEFAULT_MEMORY_CHAR_LIMIT),
  projectCharLimit: limit(DEFAULT_PROJECT_CHAR_LIMIT),
  /** off = write freely (Hermes default); background = stage background-review writes; all = stage every agent write. */
  writeApproval: z.enum(WRITE_APPROVAL).default("background"),
  /** Most skills listed in the system-prompt index (most recently used first). */
  skillsIndexLimit: z.number().int().min(0).max(300).default(80),
  /** Index agent timelines for session_search. */
  indexSessions: z.boolean().default(true),
  exportCatalog: z.boolean().default(false),
  sessionRetentionDays: z.number().int().min(0).max(3650).default(90),
  review: z
    .object({
      enabled: z.boolean().default(true),
      /** Paseo provider id of a Claude-family provider used for the headless review run. */
      provider: z.string().min(1).max(64).default("claude"),
      model: z.string().min(1).max(100).default("sonnet"),
      /** Review after this many user turns since the last review (Hermes memory.nudge_interval). */
      userTurns: z.number().int().min(1).max(100).default(6),
      /** Review after this many tool calls since the last review (Hermes skills.creation_nudge_interval). */
      toolCalls: z.number().int().min(1).max(500).default(20),
      cooldownMinutes: z.number().int().min(0).max(1440).default(15),
      dailyBudgetUsd: z.number().min(0).max(100).default(2),
      maxBudgetUsd: z.number().min(0.01).max(10).default(0.5),
      /** Review subagents and helper agents too (agents with a parent). */
      includeChildAgents: z.boolean().default(false),
      /** Review leftover activity when an agent is archived (the session boundary). */
      onArchive: z.boolean().default(true),
    })
    .default({
      enabled: true,
      provider: "claude",
      model: "sonnet",
      userTurns: 6,
      toolCalls: 20,
      cooldownMinutes: 15,
      maxBudgetUsd: 0.5,
      dailyBudgetUsd: 2,
      includeChildAgents: false,
      onArchive: true,
    }),
  curator: z
    .object({
      enabled: z.boolean().default(true),
      staleAfterDays: z.number().int().min(1).max(365).default(14),
      archiveAfterDays: z.number().int().min(1).max(730).default(30),
    })
    .default({ enabled: true, staleAfterDays: 14, archiveAfterDays: 30 }),
});

export type Preferences = z.output<typeof preferencesSchema>;

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 2,
  migrate: migratePreferences,
  schema: preferencesSchema,
});

export const DEFAULT_PREFERENCES: Preferences = preferencesSchema.parse({});

/** Existing choices win; missing v1 writeApproval meant off. New installs use proposals. */
export function migratePreferences(values: unknown, fromVersion: number): unknown {
  if (fromVersion !== 1) throw new Error(`Unsupported preferences version ${fromVersion}`);
  const old = values && typeof values === "object" ? values as Record<string, unknown> : {};
  return { ...old, writeApproval: old.writeApproval ?? "off", sessionRetentionDays: old.sessionRetentionDays ?? 0 };
}
