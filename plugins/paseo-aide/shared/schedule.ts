import { clampToWindow, clockToMinutes, dateKey, inWindow, zonedTimeToEpoch, type DateKey } from "./time";

export interface ScheduleConfig {
  timezone: string;
  checkins: { enabled: boolean; everyMinutes: number; maxPerDay: number };
  brief: { enabled: boolean; time: string };
  activeHours: { start: string; end: string };
}

/** A late brief is still useful at breakfast, not at dinner. */
export const BRIEF_GRACE_MS = 4 * 60 * 60 * 1000;
/** The first check-in waits a little after setup so the user can finish the watch list. */
export const FIRST_CHECKIN_DELAY_MS = 10 * 60 * 1000;
export const MAX_CHECKIN_INTERVAL_MINUTES = 8 * 60;

/**
 * Back-off for check-ins that keep finding nothing (HeartBeat 2.0's no-op governor): three quiet
 * runs in a row stretch the interval, up to three times the setting and never past eight hours.
 */
export function governorFactor(quietStreak: number): number {
  if (quietStreak < 3) return 1;
  if (quietStreak === 3) return 1.5;
  if (quietStreak === 4) return 2;
  return 3;
}

export function effectiveIntervalMinutes(config: ScheduleConfig, quietStreak: number): number {
  const stretched = Math.round(config.checkins.everyMinutes * governorFactor(quietStreak));
  return Math.max(config.checkins.everyMinutes, Math.min(stretched, MAX_CHECKIN_INTERVAL_MINUTES));
}

export function isActiveTime(ms: number, config: ScheduleConfig): boolean {
  return inWindow(ms, config.timezone, config.activeHours.start, config.activeHours.end);
}

/**
 * When the next background check-in should start, or null when check-ins are off. Missed runs
 * (the computer slept, Paseo was off) collapse into one: the next time is relative to the last
 * start, so a long gap yields a single overdue run rather than a backlog.
 */
export function nextCheckinAt(input: {
  config: ScheduleConfig;
  lastStartedAt: number | null;
  setupAt: number;
  quietStreak: number;
}): number | null {
  const { config } = input;
  if (!config.checkins.enabled) return null;
  const base = input.lastStartedAt === null
    ? input.setupAt + FIRST_CHECKIN_DELAY_MS
    : input.lastStartedAt + effectiveIntervalMinutes(config, input.quietStreak) * 60_000;
  return clampToWindow(base, config.timezone, config.activeHours.start, config.activeHours.end);
}

export interface BriefSlot {
  day: DateKey;
  at: number;
  /** The brief for `day` should go out now. */
  due: boolean;
  /** The grace period passed without a brief (Paseo was off); record it and move on. */
  missed: boolean;
}

/** Today's brief slot, given the day of the last brief sent (or skipped). */
export function briefSlot(now: number, config: ScheduleConfig, lastDay: DateKey | null): BriefSlot | null {
  if (!config.brief.enabled) return null;
  const day = dateKey(now, config.timezone);
  const at = zonedTimeToEpoch(day, clockToMinutes(config.brief.time), config.timezone);
  if (lastDay === day || now < at) return { day, at, due: false, missed: false };
  const late = now - at > BRIEF_GRACE_MS;
  return { day, at, due: !late, missed: late };
}

/** The next brief the user can expect, for display. */
export function nextBriefAt(now: number, config: ScheduleConfig, lastDay: DateKey | null): number | null {
  if (!config.brief.enabled) return null;
  const minutes = clockToMinutes(config.brief.time);
  const today = dateKey(now, config.timezone);
  const todayAt = zonedTimeToEpoch(today, minutes, config.timezone);
  if (lastDay !== today && now - todayAt <= BRIEF_GRACE_MS) return Math.max(todayAt, now);
  for (let offset = 1; offset <= 2; offset++) {
    const next = new Date(todayAt + offset * 86_400_000);
    const day = dateKey(next.getTime(), config.timezone);
    if (day !== today) return zonedTimeToEpoch(day, minutes, config.timezone);
  }
  return null;
}
