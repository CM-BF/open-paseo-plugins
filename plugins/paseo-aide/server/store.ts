import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ActivitySchema, AlertSchema, ConfigSchema, FollowupSchema, type Activity } from "../shared/types";
import type { StatePaths } from "./paths";
import { describeError, log, SerialAppender, SerialWriter, shortId, writeAtomically } from "./util";

const AssistantSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  home: z.string(),
  createdAt: z.string(),
  /** Set when the user archived the chat; proactive work stops until Aide is set up again. */
  archivedAt: z.string().nullable().default(null),
});
export type AssistantRecord = z.infer<typeof AssistantSchema>;

/** A check-in started and not yet settled; survives a plugin restart so its agent can be cleaned up. */
const InFlightSchema = z.object({
  runId: z.string(),
  agentId: z.string().nullable(),
  startedAt: z.string(),
  reason: z.enum(["scheduled", "manual", "followup"]),
  followupId: z.string().nullable(),
});
export type InFlight = z.infer<typeof InFlightSchema>;

const OutboxEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(["checkin", "brief", "reminder", "welcome"]),
  text: z.string(),
  createdAt: z.string(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  retryAfter: z.number().nullable(),
  /** Counts toward the daily proactive-message cap and the unanswered limit. */
  counts: z.boolean(),
  alertIds: z.array(z.string()),
});
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;

const StateSchema = z.object({
  version: z.literal(1).default(1),
  secret: z.string().default(() => randomBytes(32).toString("hex")),
  port: z.number().int().nullable().default(null),
  config: ConfigSchema.prefault({}),
  assistant: AssistantSchema.nullable().default(null),
  /** Local date the daily counters belong to. */
  day: z.string().nullable().default(null),
  checkinsToday: z.number().int().default(0),
  /** Scheduled check-ins today, the ones the daily limit counts; Check now does not use it up. */
  scheduledToday: z.number().int().default(0),
  messagesToday: z.number().int().default(0),
  /** Proactive messages since the user last wrote to the assistant. */
  unanswered: z.number().int().default(0),
  lastUserAt: z.string().nullable().default(null),
  /** Consecutive check-ins that found nothing worth saying. */
  quietStreak: z.number().int().default(0),
  lastCheckinAt: z.string().nullable().default(null),
  lastBriefDay: z.string().nullable().default(null),
  inFlight: InFlightSchema.nullable().default(null),
  followups: z.array(FollowupSchema).default([]),
  alerts: z.array(AlertSchema).default([]),
  outbox: z.array(OutboxEntrySchema).default([]),
});
export type AideState = z.infer<typeof StateSchema>;

const MAX_ALERTS = 200;
const MAX_FOLLOWUPS = 200;

export class Store {
  state: AideState = StateSchema.parse({});
  private readonly writer: SerialWriter;

  constructor(private readonly paths: StatePaths) {
    this.writer = new SerialWriter(paths.state);
  }

  async load(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await readFile(this.paths.state, "utf8");
    } catch {
      // First start.
    }
    if (raw !== null) {
      const parsed = StateSchema.safeParse(safeJson(raw));
      if (parsed.success) this.state = parsed.data;
      else {
        // Keep the unreadable file for inspection instead of silently losing alerts and follow-ups.
        const aside = `${this.paths.state}.invalid-${Date.now()}`;
        await writeAtomically(aside, raw).catch(() => undefined);
        log(`state.json was invalid (${describeError(parsed.error)}); kept a copy at ${aside} and started fresh`);
      }
    }
    this.save();
    await this.writer.idle();
  }

  save(): void {
    const state = this.state;
    // Old settled entries are history, not state; the activity log keeps the record.
    if (state.alerts.length > MAX_ALERTS) state.alerts = keepNewest(state.alerts, MAX_ALERTS, (alert) => alert.status === "open" || alert.status === "snoozed");
    if (state.followups.length > MAX_FOLLOWUPS) state.followups = keepNewest(state.followups, MAX_FOLLOWUPS, (followup) => followup.status === "active");
    void this.writer.write(`${JSON.stringify(state, null, 1)}\n`);
  }

  idle(): Promise<void> {
    return this.writer.idle();
  }
}

function keepNewest<T extends { createdAt: string }>(items: T[], limit: number, keep: (item: T) => boolean): T[] {
  const pinned = items.filter(keep);
  const rest = items.filter((item) => !keep(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...pinned, ...rest.slice(0, Math.max(0, limit - pinned.length))];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const MAX_ACTIVITY_MEMORY = 400;
const MAX_ACTIVITY_FILE = 2000;

/** Append-only record of everything the assistant did on its own, newest kept in memory. */
export class ActivityLog {
  private entries: Activity[] = [];
  private readonly appender: SerialAppender;

  constructor(private readonly file: string) {
    this.appender = new SerialAppender(file);
  }

  async load(): Promise<void> {
    let lines: string[] = [];
    try {
      lines = (await readFile(this.file, "utf8")).split("\n").filter(Boolean);
    } catch {
      return;
    }
    const parsed = lines.flatMap((line) => {
      const result = ActivitySchema.safeParse(safeJson(line));
      return result.success ? [result.data] : [];
    });
    this.entries = parsed.slice(-MAX_ACTIVITY_MEMORY);
    if (lines.length > MAX_ACTIVITY_FILE) {
      await writeAtomically(this.file, `${parsed.slice(-MAX_ACTIVITY_FILE / 2).map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    }
  }

  add(entry: Omit<Activity, "id" | "at"> & { at?: string }): Activity {
    const full = ActivitySchema.parse({ ...entry, id: shortId("act"), at: entry.at ?? new Date().toISOString() });
    this.entries.push(full);
    if (this.entries.length > MAX_ACTIVITY_MEMORY) this.entries.splice(0, this.entries.length - MAX_ACTIVITY_MEMORY);
    void this.appender.append(JSON.stringify(full));
    return full;
  }

  recent(limit: number): Activity[] {
    return this.entries.slice(-limit).reverse();
  }

  idle(): Promise<void> {
    return this.appender.idle();
  }
}
