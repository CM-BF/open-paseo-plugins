import type { PluginTheme } from "@getpaseo/plugin";
import { formatLocal } from "../shared/time";
import type { Activity, Overview, Urgency } from "../shared/types";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "in 25 min", "3 h ago", "just now". */
export function relative(iso: string, now: number): string {
  const delta = Date.parse(iso) - now;
  const minutes = Math.round(Math.abs(delta) / 60_000);
  if (minutes < 1) return delta >= 0 ? "now" : "just now";
  const text = minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}

export function when(iso: string, timezone: string, now: number): string {
  return `${formatLocal(Date.parse(iso), timezone, now)} · ${relative(iso, now)}`;
}

export const STATE_LOOK: Record<Overview["state"], { label: string; tone: "success" | "warning" | "muted" | "danger" }> = {
  active: { label: "On", tone: "success" },
  quiet_hours: { label: "Quiet hours", tone: "muted" },
  paused: { label: "Paused", tone: "warning" },
  detached: { label: "Chat archived", tone: "danger" },
  not_set_up: { label: "Not set up", tone: "muted" },
};

export function toneColor(theme: PluginTheme, tone: "success" | "warning" | "muted" | "danger" | "accent"): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    case "accent":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function urgencyTone(urgency: Urgency): "danger" | "accent" | "muted" {
  return urgency === "high" ? "danger" : urgency === "normal" ? "accent" : "muted";
}

export const ACTIVITY_ICON: Record<Activity["kind"], string> = {
  setup: "Sparkles",
  checkin: "Radar",
  brief: "Sunrise",
  followup: "AlarmClock",
  delivery: "Send",
  feedback: "Check",
  schedule: "SlidersHorizontal",
  error: "TriangleAlert",
};

export function outcomeTone(outcome: Activity["outcome"]): "success" | "warning" | "muted" | "danger" | "accent" {
  switch (outcome) {
    case "alerted":
      return "accent";
    case "held":
      return "warning";
    case "failed":
      return "danger";
    case "sent":
    case "done":
      return "success";
    default:
      return "muted";
  }
}

export const INTERVALS = [30, 60, 90, 120, 180, 240, 360, 480, 720];

export function intervalLabel(minutes: number): string {
  return minutes < 60 ? `${minutes} min` : minutes % 60 === 0 ? `${minutes / 60} h` : `${(minutes / 60).toFixed(1)} h`;
}
