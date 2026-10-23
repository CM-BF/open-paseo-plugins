interface RecordValue {
  [key: string]: unknown;
}

export interface RateLimit {
  message: string;
  /** Absolute Unix time in milliseconds, only when supplied by the provider. */
  resetAt: number | null;
}

export interface UsageRecovery {
  status: "exhausted" | "available";
  resetAt: number | null;
}

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function absoluteTime(value: unknown): number | null {
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)$/i.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const number = finite(value) ??
    (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null);
  if (number === null || number <= 0) return null;
  // Provider error payloads use Unix seconds; accept explicit Unix milliseconds too.
  const milliseconds = number < 100_000_000_000 ? number * 1000 : number;
  return Number.isFinite(milliseconds) && milliseconds <= 8.64e15 ? milliseconds : null;
}

function structuredReset(value: unknown, depth = 0): number | null {
  if (depth > 8) return null;
  const object = record(value);
  if (!object) return null;
  for (const key of ["resets_at", "reset_at", "resetsAt", "resetAt"]) {
    const timestamp = absoluteTime(object[key]);
    if (timestamp !== null) return timestamp;
  }
  // Restrict traversal to the error envelope, not arbitrary quoted/tool data.
  for (const key of ["error", "details", "metadata"]) {
    const timestamp = structuredReset(object[key], depth + 1);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function errorPayload(message: string): RecordValue | null {
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return record(JSON.parse(message.slice(start, end + 1)));
  } catch {
    return null;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function wallClock(formatter: Intl.DateTimeFormat, timestamp: number): WallClock {
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
  };
}

function utcClock(clock: WallClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
}

/** Find exact instants, including both sides of a DST overlap. Never guess an offset. */
function wallClockInstants(clock: WallClock, formatter: Intl.DateTimeFormat): number[] {
  const local = utcClock(clock);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 12) {
    const sample = local + hours * 3_600_000;
    offsets.add(utcClock(wallClock(formatter, sample)) - sample);
  }
  return [...offsets].map((offset) => local - offset)
    .filter((timestamp) => utcClock(wallClock(formatter, timestamp)) === local);
}

function claudeWallClockReset(message: string, now: number): number | null {
  const match = message.match(
    /\bresets\s+(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:,?\s+|\s+at\s+))?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+\(([A-Za-z0-9_+\-/]+)\)/i,
  );
  if (!match) return null;
  const hour = Number(match[4]);
  const minute = Number(match[5] ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: match[7], year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
  } catch {
    return null;
  }
  const current = wallClock(formatter, now);
  const target = {
    ...current,
    hour: hour % 12 + (match[6]!.toLowerCase() === "pm" ? 12 : 0), minute,
  };
  if (match[1]) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    target.year = Number(match[3] ?? current.year);
    target.month = months.indexOf(match[1].toLowerCase()) + 1;
    target.day = Number(match[2]);
    const validated = new Date(utcClock(target));
    if (validated.getUTCMonth() + 1 !== target.month || validated.getUTCDate() !== target.day) return null;
    const candidates = wallClockInstants(target, formatter).filter((timestamp) => timestamp > now);
    return candidates.length === 1 ? candidates[0]! : null;
  }
  // Claude Code includes the calendar date whenever its reset is more than 24h away.
  const tomorrow = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  const nextDay = {
    ...target, year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate(),
  };
  const candidates = [target, nextDay].flatMap((clock) => wallClockInstants(clock, formatter))
    .filter((timestamp) => timestamp > now && timestamp - now <= 86_400_000);
  // Nonexistent or ambiguous local times need the quota endpoint's absolute timestamp.
  return candidates.length === 1 ? candidates[0]! : null;
}

function resetFromMessage(message: string, now: number): number | null {
  const structured = structuredReset(errorPayload(message));
  if (structured !== null) return structured;

  const absolute = message.match(
    /(?:reset(?:s)?(?:\s+at)?|try\s+again(?:\s+at)?|retry(?:\s+at)?)[^\d]{0,12}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i,
  );
  if (absolute?.[1]) return absoluteTime(absolute[1]);

  const relative = message.match(
    /(?:try\s+again|retry|reset(?:s)?)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:days?|hours?|minutes?|seconds?|[dhms])(?![a-z])(?:\s*[, ]?\s*(?:and\s+)?)?)+)/i,
  );
  if (!relative?.[1]) return claudeWallClockReset(message, now);
  let milliseconds = 0;
  for (const part of relative[1].matchAll(/(\d+(?:\.\d+)?)\s*(days?|hours?|minutes?|seconds?|[dhms])/gi)) {
    const multiplier = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }[part[2]![0]!.toLowerCase()];
    milliseconds += Number(part[1]) * multiplier!;
  }
  const resetAt = now + milliseconds;
  return milliseconds > 0 && Number.isFinite(resetAt) && resetAt <= 8.64e15 ? resetAt : null;
}

function rateLimited(message: string, code?: unknown): boolean {
  if (typeof code === "string" && /^(?:429|rate[_-]limit(?:ed|_exceeded|_reached|_error)?|usage[_-]limit(?:_exceeded|_reached)?|too_many_requests)$/i.test(code)) return true;
  return /\brate[ _-]*limit(?:ed|ing|[ _-](?:exceeded|reached|error))?\b|\busage[ _-]*limit(?:[ _-](?:exceeded|reached))?\b|\btoo many requests\b|\b(?:HTTP|API Error:)\s*429\b/i.test(message)
    || claudeLimitNotice(message);
}

const claudeLimitPrefix = /^(?:You've (?:hit|reached|exceeded) your (?:(?:session|weekly|(?:Opus|Sonnet|Haiku|Fable|Omelette)(?: weekly| usage)?|fast|usage(?: credit)?) )?(?:limit|allowance)|You're out of (?:extra usage|usage credits))(?=\s*(?:[.·]|$))/i;

function claudeLimitNotice(message: string): boolean {
  // These are Claude Code's rejected-quota notices, distinct from "You're close to...".
  return claudeLimitPrefix.test(message.trim());
}

function claudeAssistantLimitNotice(message: string): boolean {
  const prefix = message.match(claudeLimitPrefix);
  if (!prefix) return false;
  // Ordinary assistant explanations can quote a limit notice and then discuss it.
  // Only the complete provider-style notice is accepted as a standalone assistant row.
  return /^(?:\.?|\s*·\s*resets\s+[^·\r\n()]+\([A-Za-z0-9_+\-/]+\)(?:\s*·\s*progress saved)?)$/i
    .test(message.slice(prefix[0].length));
}

function itemOf(value: unknown): RecordValue | null {
  const object = record(value);
  return object ? record(object.item) ?? object : null;
}

/** Inspect provider errors only. User text, reasoning and tool results are never evidence. */
export function detectRateLimit(input: {
  outcome: { kind: string; error?: { message?: string; code?: string } };
  timeline?: readonly unknown[];
  now?: number;
  provider?: string;
}): RateLimit | null {
  const now = input.now ?? Date.now();
  if (input.outcome.kind === "failed" && input.outcome.error) {
    const { message = "", code } = input.outcome.error;
    // A concrete failure is authoritative, including when it is unrelated to quota.
    return rateLimited(message, code)
      ? { message: message || String(code), resetAt: resetFromMessage(message, now) }
      : null;
  }
  if (input.outcome.kind !== "failed" && input.outcome.kind !== "completed") return null;

  const timeline = input.timeline ?? [];
  // Stop at the latest user/turn boundary. A rate error in an earlier turn is stale.
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = itemOf(timeline[index]);
    if (!item) continue;
    if (item.type === "user_message" || item.type === "turn_started") return null;
    if (item.type === "error") {
      const message = typeof item.message === "string" ? item.message : "";
      return rateLimited(message, item.code) ? { message, resetAt: resetFromMessage(message, now) } : null;
    }
    if (item.type === "assistant_message") {
      const message = typeof item.text === "string" ? item.text.trim() : "";
      if (!message) continue;
      // Claude can complete an SDK turn with its API error in an assistant row.
      const isApiError = item.isApiErrorMessage === true || /^API Error\s*:/i.test(message)
        || (input.provider === "claude" && claudeAssistantLimitNotice(message));
      return isApiError && rateLimited(message)
        ? { message, resetAt: resetFromMessage(message, now) }
        : null;
    }
    if (item.type === "tool_call" || item.type === "reasoning") return null;
  }
  return null;
}

function canonicalModel(value: string): string {
  return value.split("/").at(-1)!.toLowerCase().replace(/[^a-z0-9]/g, "");
}

type WindowScope = "shared" | "main" | "other" | "unknown";

function windowScope(window: RecordValue, mainModel: string): WindowScope {
  const id = typeof window.id === "string" ? window.id : "";
  if (id.startsWith("code_review:") || id === "code_review") return "other";
  if (!id.startsWith("limit:")) return "shared";
  let identity = id.slice("limit:".length).split(":")[0]!;
  try { identity = decodeURIComponent(identity); } catch { /* Malformed scopes stay unknown. */ }
  const label = typeof window.label === "string" ? window.label.split("·")[0]!.trim() : "";
  const candidates = [identity, label].filter(Boolean);
  const main = canonicalModel(mainModel);
  if (candidates.some((candidate) => canonicalModel(candidate) === main)) return "main";
  // Model names in labels are authoritative even when metered_feature is an opaque codename.
  if (candidates.some((candidate) => /\b(?:gpt[- _]?\d|o[1-9](?:[- _]|$)|codex[- _]?\d)/i.test(candidate))) return "other";
  return "unknown";
}

function claudeModelFamily(value: string): string | null {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ")
    .match(/\b(opus|sonnet|haiku|fable|omelette)\b/)?.[1] ?? null;
}

function claudeWindowScope(window: RecordValue, mainModel: string): WindowScope {
  const id = typeof window.id === "string" ? window.id : "";
  if (["five_hour", "seven_day", "weekly"].includes(id)) return "shared";
  const surface = id.match(/^weekly(?:_surface_|:surface:)(.+)$/)?.[1];
  if (surface) {
    if (["code", "claude_code"].includes(surface)) return "shared";
    if (["chat", "claude_ai", "api"].includes(surface)) return "other";
    return "unknown";
  }
  const model = id.match(/^(?:seven_day_|weekly_model_|weekly:(?:model:)?)(.+)$/)?.[1];
  if (!model) return "unknown";
  const mainFamily = claudeModelFamily(mainModel);
  const family = claudeModelFamily(model);
  if (family && mainFamily) return family === mainFamily ? "main" : "other";
  if (canonicalModel(model) === canonicalModel(mainModel)) return "main";
  // API ids can be opaque; a model-scoped window's display label still names the family.
  const labelFamily = typeof window.label === "string" ? claudeModelFamily(window.label) : null;
  if (labelFamily && mainFamily) return labelFamily === mainFamily ? "main" : "other";
  return "unknown";
}

function exhausted(window: RecordValue): boolean | null {
  const used = finite(window.usedPct);
  const remaining = finite(window.remainingPct);
  if ((used !== null && used >= 100) || (remaining !== null && remaining <= 0)) return true;
  if ((used !== null && used >= 0 && used < 100) || (remaining !== null && remaining > 0 && remaining <= 100)) return false;
  return null;
}

function recoveryFromWindows(windows: unknown[], mainModel: string, now: number, provider: string): UsageRecovery | null {
  let relevant = 0;
  let unknown = false;
  const blocking: Array<number | null> = [];
  for (const value of windows) {
    const window = record(value);
    if (!window) continue;
    const scope = provider === "claude" ? claudeWindowScope(window, mainModel) : windowScope(window, mainModel);
    if (scope === "other") continue;
    const blocked = exhausted(window);
    if (scope === "unknown") {
      if (blocked !== false) unknown = true;
      continue;
    }
    relevant++;
    if (blocked === null) unknown = true;
    if (blocked) {
      const resetAt = absoluteTime(window.resetsAt);
      blocking.push(resetAt !== null && resetAt > now ? resetAt : null);
    }
  }
  if (blocking.length > 0) {
    return {
      status: "exhausted",
      // Every exhausted window has to reset. Missing/past dates cannot prove recovery.
      resetAt: blocking.every((timestamp) => timestamp !== null) ? Math.max(...blocking as number[]) : null,
    };
  }
  return relevant > 0 && !unknown ? { status: "available", resetAt: null } : null;
}

/** Consume a fresh, session-scoped listUsageReports result, without using lastSuccessful. */
export function usageRecovery(rawUsage: unknown, mainModel: string, now: number, provider = "codex"): UsageRecovery | null {
  if (provider !== "codex" && provider !== "claude") return null;
  const payload = record(rawUsage);
  if (!payload || !Array.isArray(payload.reports)) return null;
  const reports = payload.reports.flatMap((value) => {
    const entry = record(value);
    if (!entry) return [];
    const source = typeof entry.sourceId === "string" ? entry.sourceId : "";
    const label = typeof entry.sourceLabel === "string" ? entry.sourceLabel : "";
    const matches = provider === "claude"
      ? /(?:^|[:/._-])claude(?:$|[:/._-])/i.test(source) || /^claude$/i.test(label)
      : /(?:^|[:/._-])codex(?:$|[:/._-])/i.test(source) || /^codex$/i.test(label);
    if (!matches) return [];
    return [entry];
  });
  // A session normally has one login. If several identities were returned, avoid treating
  // another account's remaining quota as evidence that the agent's account recovered.
  if (reports.length !== 1) return null;
  const report = record(reports[0]!.report);
  if (!report || report.status !== "available" || !Array.isArray(report.windows)) return null;
  return recoveryFromWindows(report.windows, mainModel, now, provider);
}
