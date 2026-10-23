import { z } from "zod";
import { isClock, isValidTimeZone } from "./time";

const Clock = z.string().refine(isClock, "Use HH:MM");

export const ConfigSchema = z.object({
  /** What the assistant calls itself, and its chat's title. */
  name: z.string().trim().min(1).max(40).default("Aide"),
  /** Language for messages the assistant starts; empty follows the user's own language. */
  language: z.string().trim().max(40).default(""),
  /** The chat agent: "provider/model". */
  chatModel: z.string().min(1).default("claude/claude-sonnet-5-5"),
  /** The chat agent's permission mode; empty uses the provider default. */
  chatMode: z.string().default("auto"),
  /** Background check-ins run on a cheaper model. */
  checkinModel: z.string().min(1).default("claude/claude-haiku-4-5"),
  /** IANA zone for the brief, active hours and follow-ups; empty uses the daemon's zone. */
  timezone: z.string().default("").refine((value) => value === "" || isValidTimeZone(value), "Unknown time zone"),
  checkins: z.object({
    enabled: z.boolean().default(true),
    everyMinutes: z.number().int().min(30).max(720).default(120),
    maxPerDay: z.number().int().min(1).max(48).default(8),
  }).prefault({}),
  brief: z.object({
    enabled: z.boolean().default(true),
    time: Clock.default("08:30"),
  }).prefault({}),
  /** Check-ins and proactive messages happen only inside these hours; reminders you asked for still fire. */
  activeHours: z.object({
    start: Clock.default("08:00"),
    end: Clock.default("22:00"),
  }).prefault({}),
  /** Proactive check-in messages per day; urgent ones and briefs are not held back. */
  messagesPerDay: z.number().int().min(0).max(50).default(6),
  /** Held while the user leaves this many proactive messages unanswered (0 = never hold). */
  unansweredLimit: z.number().int().min(0).max(20).default(3),
  /** Pause proactive work until this time (ISO), or indefinitely with "always". */
  pausedUntil: z.string().nullable().default(null),
});
export type Config = z.infer<typeof ConfigSchema>;
export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

export const UrgencySchema = z.enum(["low", "normal", "high"]);
export type Urgency = z.infer<typeof UrgencySchema>;

export const AlertStatusSchema = z.enum(["open", "done", "snoozed", "muted"]);
export type AlertStatus = z.infer<typeof AlertStatusSchema>;

export const AlertSchema = z.object({
  id: z.string(),
  /** Stable identity chosen by the check-in, e.g. "gh:owner/repo#41:ci", used to recognise repeats. */
  key: z.string(),
  title: z.string(),
  detail: z.string(),
  urgency: UrgencySchema,
  source: z.enum(["checkin", "followup", "paseo"]),
  status: AlertStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  snoozedUntil: z.string().nullable(),
  /** Told the user in the chat (false while held by caps, quiet hours or the unanswered limit). */
  delivered: z.boolean(),
  runId: z.string().nullable(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const RepeatSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), minutes: z.number().int().positive() }),
  z.object({ kind: z.literal("daily"), time: Clock }),
  z.object({ kind: z.literal("weekdays"), time: Clock }),
  z.object({ kind: z.literal("weekly"), weekday: z.number().int().min(0).max(6), time: Clock }),
]);

export const FollowupSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** What to do when it fires. */
  prompt: z.string(),
  /** remind: message the user at that time. check: look in the background, speak only if needed. */
  mode: z.enum(["remind", "check"]),
  dueAt: z.string(),
  repeat: RepeatSchema.nullable(),
  until: z.string().nullable(),
  status: z.enum(["active", "done", "canceled"]),
  createdBy: z.enum(["assistant", "user"]),
  createdAt: z.string(),
  fired: z.number().int().nonnegative(),
  lastFiredAt: z.string().nullable(),
});
export type Followup = z.infer<typeof FollowupSchema>;

export const ActivityKindSchema = z.enum(["setup", "checkin", "brief", "followup", "delivery", "feedback", "schedule", "error"]);
export const ActivitySchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: ActivityKindSchema,
  title: z.string(),
  detail: z.string().optional(),
  outcome: z.enum(["quiet", "alerted", "held", "sent", "failed", "skipped", "done"]).optional(),
  runId: z.string().optional(),
  agentId: z.string().optional(),
  alertIds: z.array(z.string()).optional(),
});
export type Activity = z.infer<typeof ActivitySchema>;

/** Paseo work waiting on the user, computed from the host's agents (no model call). */
export const WaitingAgentSchema = z.object({
  agentId: z.string(),
  title: z.string(),
  project: z.string().nullable(),
  reason: z.enum(["permission", "error", "finished"]),
  since: z.string().nullable(),
  detail: z.string().nullable(),
});
export type WaitingAgent = z.infer<typeof WaitingAgentSchema>;

export const PlannedSchema = z.object({
  kind: z.enum(["checkin", "brief", "followup"]),
  at: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  followupId: z.string().nullable(),
});
export type Planned = z.infer<typeof PlannedSchema>;

export const OverviewSchema = z.object({
  version: z.string(),
  ready: z.boolean(),
  error: z.string().nullable(),
  timezone: z.string(),
  config: ConfigSchema,
  assistant: z.object({
    agentId: z.string(),
    workspaceId: z.string().nullable(),
    home: z.string(),
    createdAt: z.string(),
    archived: z.boolean(),
  }).nullable(),
  state: z.enum(["not_set_up", "active", "paused", "quiet_hours", "detached"]),
  /** A background check-in running now. */
  busy: z.object({ since: z.string(), agentId: z.string().nullable(), reason: z.enum(["scheduled", "manual", "followup"]) }).nullable(),
  today: z.object({ checkins: z.number(), messages: z.number(), unanswered: z.number() }),
  alerts: z.array(AlertSchema),
  waiting: z.array(WaitingAgentSchema),
  planned: z.array(PlannedSchema),
  followups: z.array(FollowupSchema),
  activity: z.array(ActivitySchema),
});
export type Overview = z.infer<typeof OverviewSchema>;
