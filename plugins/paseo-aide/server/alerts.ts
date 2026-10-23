import { z } from "zod";
import { UrgencySchema, type Alert, type Config } from "../shared/types";
import { shortId } from "./util";

export const ReportItemSchema = z.object({
  key: z.string().max(300).describe("Stable identity so repeats are recognised, e.g. \"gh:owner/repo#41:ci\", \"mail:<thread-id>\", \"paseo:<agent-id>:permission\"."),
  title: z.string().min(1).max(200).describe("One line the user would understand on a lock screen."),
  detail: z.string().max(2000).default("").describe("What happened, why it matters, what you suggest; facts you checked, with links or ids."),
  urgency: UrgencySchema.default("normal").describe("high only when waiting would cost the user something today."),
});
export type ReportItem = z.infer<typeof ReportItemSchema>;

export const ReportSchema = z.object({
  notify: z.boolean().describe("true only when something new or materially changed should reach the user now."),
  summary: z.string().max(2000).describe("One or two sentences: what you checked and what you found, including sources you could not reach."),
  items: z.array(ReportItemSchema).max(10).default([]).describe("Findings. With notify=false they are kept for the morning brief."),
});
export type Report = z.infer<typeof ReportSchema>;

const DONE_MEMORY_MS = 24 * 60 * 60 * 1000;

export interface MergeOutcome {
  alerts: Alert[];
  /** New, reopened or materially changed alerts: what the user would be told. */
  fresh: Alert[];
  suppressed: { key: string; reason: "muted" | "snoozed" | "unchanged" | "done" }[];
}

export function normalizeKey(key: string, title: string): string {
  const base = key.trim() || title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  return base.replace(/\s+/g, " ").slice(0, 200);
}

const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** Folds a check-in's findings into the alert list, recognising repeats by key. */
export function mergeReport(alerts: readonly Alert[], report: Report, options: { now: number; runId: string; source: Alert["source"] }): MergeOutcome {
  const next = alerts.map((alert) => ({ ...alert }));
  const fresh: Alert[] = [];
  const suppressed: MergeOutcome["suppressed"] = [];
  const at = new Date(options.now).toISOString();
  for (const item of report.items) {
    const key = normalizeKey(item.key, item.title);
    if (!key) continue;
    const existing = [...next].reverse().find((alert) => alert.key === key);
    const changed = existing ? !same(existing.title, item.title) || !same(existing.detail, item.detail) : true;
    if (existing?.status === "muted") {
      suppressed.push({ key, reason: "muted" });
      continue;
    }
    if (existing?.status === "snoozed" && existing.snoozedUntil && Date.parse(existing.snoozedUntil) > options.now) {
      Object.assign(existing, { title: item.title, detail: item.detail, urgency: item.urgency, updatedAt: at });
      suppressed.push({ key, reason: "snoozed" });
      continue;
    }
    if (existing?.status === "open" && !changed) {
      suppressed.push({ key, reason: "unchanged" });
      continue;
    }
    if (existing?.status === "done" && !changed && options.now - Date.parse(existing.updatedAt) < DONE_MEMORY_MS) {
      suppressed.push({ key, reason: "done" });
      continue;
    }
    if (existing && (existing.status === "open" || existing.status === "snoozed")) {
      // An open alert that changed, or a snooze that ran out: same alert, told again.
      Object.assign(existing, { title: item.title, detail: item.detail, urgency: item.urgency, status: "open", snoozedUntil: null, updatedAt: at, delivered: false, runId: options.runId });
      fresh.push(existing);
      continue;
    }
    const alert: Alert = {
      id: shortId("al"),
      key,
      title: item.title,
      detail: item.detail,
      urgency: item.urgency,
      source: options.source,
      status: "open",
      createdAt: at,
      updatedAt: at,
      snoozedUntil: null,
      delivered: false,
      runId: options.runId,
    };
    next.push(alert);
    fresh.push(alert);
  }
  return { alerts: next, fresh, suppressed };
}

export type DeliveryDecision = { deliver: true } | { deliver: false; reason: "quiet" | "outside active hours" | "daily message limit" | "waiting for your reply" | "paused" };

/** Whether a check-in's findings reach the chat now, or stay in the inbox for later. */
export function deliveryDecision(input: {
  notify: boolean;
  fresh: readonly Alert[];
  config: Pick<Config, "messagesPerDay" | "unansweredLimit">;
  messagesToday: number;
  unanswered: number;
  activeNow: boolean;
  paused: boolean;
  /** The user asked for this check (Check now, or a follow-up they set). */
  requested: boolean;
}): DeliveryDecision {
  if (!input.notify || input.fresh.length === 0) return { deliver: false, reason: "quiet" };
  if (input.requested) return { deliver: true };
  if (input.paused) return { deliver: false, reason: "paused" };
  if (input.fresh.some((alert) => alert.urgency === "high")) return { deliver: true };
  if (!input.activeNow) return { deliver: false, reason: "outside active hours" };
  if (input.messagesToday >= input.config.messagesPerDay) return { deliver: false, reason: "daily message limit" };
  if (input.config.unansweredLimit > 0 && input.unanswered >= input.config.unansweredLimit) return { deliver: false, reason: "waiting for your reply" };
  return { deliver: true };
}

/** The first JSON object in a model's final message that parses as a report. */
export function extractReport(text: string | null): Report | null {
  if (!text) return null;
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(match[1]!);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = ReportSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON; try the next candidate.
    }
  }
  return null;
}
