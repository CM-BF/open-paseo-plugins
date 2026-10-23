// Wall-clock arithmetic in an IANA time zone with nothing but Intl, so the daemon
// and every client agree on "08:30 in the user's zone" across DST changes.

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isValidTimeZone(zone) ? zone : "UTC";
}

export function localParts(ms: number, timeZone: string): LocalParts {
  const values: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) values[part.type] = part.value;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    // Some engines print midnight as 24 even with h23.
    hour: Number(values.hour) % 24,
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: WEEKDAYS.indexOf(values.weekday ?? "Sun"),
  };
}

/**
 * Epoch ms of a wall-clock time in `timeZone`. A time skipped by a DST jump resolves to the
 * same clock reading after the jump; a repeated hour resolves to its first occurrence.
 */
export function zonedTimeToEpoch(date: DateKey, minuteOfDay: number, timeZone: string): number {
  const { year, month, day } = parseDateKey(date);
  const wanted = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let guess = wanted;
  let previous = wanted;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = localParts(guess, timeZone);
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const drift = shown - wanted;
    if (drift === 0) return earliestOccurrence(guess, wanted, timeZone);
    previous = guess;
    guess -= drift;
  }
  // The reading does not exist (a DST gap): the search alternates around the jump; take the later instant.
  return Math.max(guess, previous);
}

/** In a repeated hour, both offsets show the same clock time: prefer the earlier instant. */
function earliestOccurrence(found: number, wanted: number, timeZone: string): number {
  const earlier = found - 60 * 60 * 1000;
  const parts = localParts(earlier, timeZone);
  const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return shown === wanted ? earlier : found;
}

/** A calendar date in the user's zone, "YYYY-MM-DD". */
export type DateKey = string;

export function dateKey(ms: number, timeZone: string): DateKey {
  const parts = localParts(ms, timeZone);
  return formatDateKey(parts.year, parts.month, parts.day);
}

export function formatDateKey(year: number, month: number, day: number): DateKey {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseDateKey(key: DateKey): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`Invalid date ${key}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function addDays(key: DateKey, days: number): DateKey {
  const { year, month, day } = parseDateKey(key);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatDateKey(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** 0 = Sunday for a calendar date. */
export function weekdayOf(key: DateKey): number {
  const { year, month, day } = parseDateKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

const CLOCK = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function isClock(value: string): boolean {
  return CLOCK.test(value.trim());
}

/** "08:30" → 510. */
export function clockToMinutes(value: string): number {
  const match = CLOCK.exec(value.trim());
  if (!match) throw new Error(`Invalid time ${value}; use HH:MM`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesToClock(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

export function minuteOfDay(ms: number, timeZone: string): number {
  const parts = localParts(ms, timeZone);
  return parts.hour * 60 + parts.minute;
}

/** Whether `ms` falls in a daily window; an equal start and end means all day, and windows may cross midnight. */
export function inWindow(ms: number, timeZone: string, start: string, end: string): boolean {
  const from = clockToMinutes(start);
  const to = clockToMinutes(end);
  if (from === to) return true;
  const now = minuteOfDay(ms, timeZone);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/** `ms` when it is inside the window, else the next time the window opens. */
export function clampToWindow(ms: number, timeZone: string, start: string, end: string): number {
  if (inWindow(ms, timeZone, start, end)) return ms;
  const opens = clockToMinutes(start);
  const today = dateKey(ms, timeZone);
  const candidate = zonedTimeToEpoch(today, opens, timeZone);
  return candidate > ms ? candidate : zonedTimeToEpoch(addDays(today, 1), opens, timeZone);
}

/** "Thu 23 Oct 16:00" in the user's zone. */
export function formatLocal(ms: number, timeZone: string, now?: number): string {
  const parts = localParts(ms, timeZone);
  const clock = `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
  if (now !== undefined) {
    const today = dateKey(now, timeZone);
    const key = formatDateKey(parts.year, parts.month, parts.day);
    if (key === today) return `today ${clock}`;
    if (key === addDays(today, 1)) return `tomorrow ${clock}`;
  }
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][parts.month - 1];
  return `${WEEKDAYS[parts.weekday]} ${parts.day} ${month} ${clock}`;
}

/** ISO 8601 with the zone's offset, e.g. 2026-10-23T16:00:00-07:00. */
export function isoInZone(ms: number, timeZone: string): string {
  const parts = localParts(ms, timeZone);
  const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = Math.round((shown - Math.floor(ms / 1000) * 1000) / 60_000);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${formatDateKey(parts.year, parts.month, parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
