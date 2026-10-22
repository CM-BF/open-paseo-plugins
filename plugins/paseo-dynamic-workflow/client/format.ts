import type { PluginTheme } from "@getpaseo/plugin";
import type { AgentCallStatus, RunStatus } from "../shared/run-types";

export type Tone = "accent" | "success" | "danger" | "warning" | "muted";

export function toneColor(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "accent":
      return theme.colors.accent;
    case "success":
      return theme.colors.statusSuccess;
    case "danger":
      return theme.colors.statusDanger;
    case "warning":
      return theme.colors.statusWarning;
    case "muted":
      return theme.colors.foregroundMuted;
  }
}

export const RUN_LOOK: Record<RunStatus, { label: string; glyph: string; tone: Tone }> = {
  running: { label: "Running", glyph: "●", tone: "accent" },
  stopping: { label: "Stopping", glyph: "●", tone: "warning" },
  completed: { label: "Completed", glyph: "✓", tone: "success" },
  failed: { label: "Failed", glyph: "✗", tone: "danger" },
  stopped: { label: "Stopped", glyph: "■", tone: "muted" },
  interrupted: { label: "Interrupted", glyph: "!", tone: "warning" },
};

export const CALL_LOOK: Record<AgentCallStatus, { label: string; glyph: string; tone: Tone }> = {
  queued: { label: "queued", glyph: "○", tone: "muted" },
  starting: { label: "starting", glyph: "◌", tone: "accent" },
  running: { label: "running", glyph: "●", tone: "accent" },
  permission: { label: "needs permission", glyph: "?", tone: "warning" },
  completed: { label: "done", glyph: "✓", tone: "success" },
  cached: { label: "cached", glyph: "↺", tone: "muted" },
  failed: { label: "failed", glyph: "✗", tone: "danger" },
  skipped: { label: "skipped", glyph: "–", tone: "muted" },
};

export function isLiveRun(status: RunStatus): boolean {
  return status === "running" || status === "stopping";
}

export function isLiveCall(status: AgentCallStatus): boolean {
  return status === "queued" || status === "starting" || status === "running" || status === "permission";
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function elapsed(start: string | null, end: string | null, now: number): string | null {
  if (!start) return null;
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return formatDuration(to - from);
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function formatClock(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error:\s*/, "");
}
