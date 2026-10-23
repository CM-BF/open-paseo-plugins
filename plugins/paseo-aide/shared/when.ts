import { addDays, clockToMinutes, dateKey, minutesToClock, weekdayOf, zonedTimeToEpoch } from "./time";

// The small time language agents and people use for follow-ups:
//   when:   "in 2h", "tomorrow 9am", "fri 16:00", "16:00", "2026-10-24 09:30", ISO 8601
//   repeat: "every 3h", "daily 09:00", "weekdays 8:30", "every monday 9am"

export type Repeat =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; weekday: number; time: string };

/** Floor for repeating follow-ups, so a careless loop cannot wake the agent every few minutes. */
export const MIN_REPEAT_MINUTES = 30;

const UNITS: Record<string, number> = {
  m: 1, min: 1, mins: 1, minute: 1, minutes: 1,
  h: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
  d: 1440, day: 1440, days: 1440,
  w: 10080, week: 10080, weeks: 10080,
};

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

export const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function normalize(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ").replace(/ at /g, " ").replace(/^at /, "");
}

/** "90m", "1h 30m", "2 hours", "1.5h" → minutes; null when the text is not a duration. */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const pattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let consumed = "";
  for (const match of text.matchAll(pattern)) {
    const unit = UNITS[match[2]!];
    if (unit === undefined) return null;
    total += Number(match[1]) * unit;
    consumed += match[0];
  }
  if (consumed.replace(/\s|and|,/g, "") !== text.replace(/\s|and|,/g, "")) return null;
  return total > 0 ? Math.round(total) : null;
}

/** "9", "9am", "9:30", "21:05", "9:30 pm", "noon", "midnight" → minute of day. */
export function parseClock(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (text === "noon") return 12 * 60;
  if (text === "midnight") return 0;
  const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  } else if (!match[2] && hour > 23) return null;
  if (hour > 23) return null;
  return hour * 60 + minute;
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})(?:[ t](.+))?$/;

/** The instant a "when" expression names, in the user's zone. Throws a message an agent can act on. */
export function parseWhen(input: string, now: number, timeZone: string): number {
  const text = normalize(input);
  if (!text) throw new Error("Say when, e.g. \"in 2h\", \"tomorrow 9am\", \"fri 16:00\" or an ISO time.");
  if (text === "now") return now;
  if (ISO_WITH_ZONE.test(text)) {
    const ms = Date.parse(input.trim());
    if (Number.isFinite(ms)) return ms;
  }
  const relative = text.startsWith("in ") ? text.slice(3) : text;
  const minutes = parseDuration(relative);
  if (minutes !== null) return now + minutes * 60_000;

  const dated = LOCAL_DATE_TIME.exec(text);
  if (dated) {
    const clock = dated[2] ? parseClock(dated[2]) : 9 * 60;
    if (clock === null) throw new Error(`Could not read the time in "${input}"; use HH:MM.`);
    return zonedTimeToEpoch(dated[1]!, clock, timeZone);
  }

  const today = dateKey(now, timeZone);
  const words = text.split(" ");
  const first = words[0]!;
  const rest = words.slice(1).join(" ");
  if (first === "today" || first === "tonight" || first === "tomorrow") {
    const clock = rest ? parseClock(rest) : first === "tonight" ? 20 * 60 : 9 * 60;
    if (clock === null) throw new Error(`Could not read the time in "${input}".`);
    return zonedTimeToEpoch(first === "tomorrow" ? addDays(today, 1) : today, clock, timeZone);
  }
  const weekdayWords = first === "next" || first === "on" ? words.slice(1) : words;
  const weekday = WEEKDAY_NAMES[weekdayWords[0] ?? ""];
  if (weekday !== undefined) {
    const clockText = weekdayWords.slice(1).join(" ");
    const clock = clockText ? parseClock(clockText) : 9 * 60;
    if (clock === null) throw new Error(`Could not read the time in "${input}".`);
    // "next friday" said on a Friday means the one a week away.
    for (let offset = first === "next" ? 1 : 0; offset <= 7; offset++) {
      const day = addDays(today, offset);
      if (weekdayOf(day) !== weekday) continue;
      const at = zonedTimeToEpoch(day, clock, timeZone);
      if (at > now) return at;
    }
  }
  const clock = parseClock(text);
  if (clock !== null) {
    const at = zonedTimeToEpoch(today, clock, timeZone);
    return at > now ? at : zonedTimeToEpoch(addDays(today, 1), clock, timeZone);
  }
  throw new Error(`Could not read "${input}". Use e.g. "in 2h", "tomorrow 9am", "fri 16:00", "2026-10-24 09:30" or an ISO time with offset.`);
}

/** A repeat expression; null for "none" or an empty string. */
export function parseRepeat(input: string | null | undefined): Repeat | null {
  const text = normalize(input ?? "");
  if (!text || text === "none" || text === "no" || text === "once") return null;
  if (text === "hourly") return { kind: "interval", minutes: Math.max(60, MIN_REPEAT_MINUTES) };
  const body = text.startsWith("every ") ? text.slice(6) : text;

  const clockAfter = (words: string[], label: string): string => {
    const clock = parseClock(words.join(" "));
    if (clock === null) throw new Error(`Give a time for "${label}", e.g. "${label} 09:00".`);
    return minutesToClock(clock);
  };
  const words = body.split(" ");
  const head = words[0]!;
  if (head === "daily" || head === "day") return { kind: "daily", time: clockAfter(words.slice(1), "daily") };
  if (head === "weekdays" || head === "weekday") return { kind: "weekdays", time: clockAfter(words.slice(1), "weekdays") };
  if (head === "weekly") {
    const weekday = WEEKDAY_NAMES[words[1] ?? ""];
    if (weekday === undefined) throw new Error("Name the day for a weekly repeat, e.g. \"weekly mon 09:00\".");
    return { kind: "weekly", weekday, time: clockAfter(words.slice(2), `weekly ${words[1]}`) };
  }
  const weekday = WEEKDAY_NAMES[head];
  if (weekday !== undefined) return { kind: "weekly", weekday, time: clockAfter(words.slice(1), `every ${head}`) };

  const minutes = parseDuration(body);
  if (minutes !== null) {
    if (minutes < MIN_REPEAT_MINUTES) throw new Error(`Repeats must be at least ${MIN_REPEAT_MINUTES} minutes apart.`);
    return { kind: "interval", minutes };
  }
  throw new Error(`Could not read the repeat "${input}". Use e.g. "every 3h", "daily 09:00", "weekdays 8:30" or "every monday 9am".`);
}

/** The first occurrence strictly after `after`. */
export function nextOccurrence(repeat: Repeat, after: number, timeZone: string): number {
  if (repeat.kind === "interval") return after + repeat.minutes * 60_000;
  const clock = clockToMinutes(repeat.time);
  const start = dateKey(after, timeZone);
  for (let offset = 0; offset <= 8; offset++) {
    const day = addDays(start, offset);
    const weekday = weekdayOf(day);
    if (repeat.kind === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    if (repeat.kind === "weekly" && weekday !== repeat.weekday) continue;
    const at = zonedTimeToEpoch(day, clock, timeZone);
    if (at > after) return at;
  }
  throw new Error("No next occurrence within a week");
}

export function describeRepeat(repeat: Repeat | null): string {
  if (!repeat) return "once";
  switch (repeat.kind) {
    case "interval":
      return repeat.minutes % 1440 === 0 ? `every ${repeat.minutes / 1440}d` : repeat.minutes % 60 === 0 ? `every ${repeat.minutes / 60}h` : `every ${repeat.minutes}m`;
    case "daily":
      return `every day at ${repeat.time}`;
    case "weekdays":
      return `weekdays at ${repeat.time}`;
    case "weekly":
      return `every ${WEEKDAY_LABELS[repeat.weekday]} at ${repeat.time}`;
  }
}
