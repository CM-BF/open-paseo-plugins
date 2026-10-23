import { describe, expect, it } from "vitest";
import { BRIEF_GRACE_MS, briefSlot, effectiveIntervalMinutes, FIRST_CHECKIN_DELAY_MS, governorFactor, nextBriefAt, nextCheckinAt, type ScheduleConfig } from "./schedule";

const config: ScheduleConfig = {
  timezone: "America/Los_Angeles",
  checkins: { enabled: true, everyMinutes: 120, maxPerDay: 8 },
  brief: { enabled: true, time: "08:30" },
  activeHours: { start: "08:00", end: "22:00" },
};
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("governor", () => {
  it("stretches the interval after quiet runs, capped", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(governorFactor)).toEqual([1, 1, 1, 1.5, 2, 3, 3]);
    expect(effectiveIntervalMinutes(config, 0)).toBe(120);
    expect(effectiveIntervalMinutes(config, 4)).toBe(240);
    expect(effectiveIntervalMinutes({ ...config, checkins: { ...config.checkins, everyMinutes: 240 } }, 6)).toBe(480);
  });
});

describe("nextCheckinAt", () => {
  it("waits after setup, then follows the interval", () => {
    const setupAt = at("2026-10-23T17:00:00Z"); // 10:00 local
    expect(nextCheckinAt({ config, lastStartedAt: null, setupAt, quietStreak: 0 })).toBe(setupAt + FIRST_CHECKIN_DELAY_MS);
    const last = at("2026-10-23T18:00:00Z");
    expect(iso(nextCheckinAt({ config, lastStartedAt: last, setupAt, quietStreak: 0 }))).toBe("2026-10-23T20:00:00.000Z");
    expect(iso(nextCheckinAt({ config, lastStartedAt: last, setupAt, quietStreak: 5 }))).toBe("2026-10-24T00:00:00.000Z");
  });

  it("moves runs outside active hours to the next morning", () => {
    const last = at("2026-10-24T04:30:00Z"); // 21:30 local; +2h is 23:30
    expect(iso(nextCheckinAt({ config, lastStartedAt: last, setupAt: 0, quietStreak: 0 }))).toBe("2026-10-24T15:00:00.000Z");
  });

  it("is off when check-ins are disabled", () => {
    expect(nextCheckinAt({ config: { ...config, checkins: { ...config.checkins, enabled: false } }, lastStartedAt: null, setupAt: 0, quietStreak: 0 })).toBeNull();
  });
});

describe("brief", () => {
  const briefAt = at("2026-10-23T15:30:00Z"); // 08:30 local

  it("is due at its time once per day", () => {
    expect(briefSlot(briefAt - 60_000, config, null)).toMatchObject({ day: "2026-10-23", due: false, missed: false });
    expect(briefSlot(briefAt, config, null)).toMatchObject({ due: true, missed: false });
    expect(briefSlot(briefAt + 60_000, config, "2026-10-23")).toMatchObject({ due: false, missed: false });
  });

  it("is skipped once the grace period passes", () => {
    expect(briefSlot(briefAt + BRIEF_GRACE_MS + 1, config, "2026-10-22")).toMatchObject({ due: false, missed: true });
  });

  it("reports the next brief", () => {
    expect(iso(nextBriefAt(briefAt - 3_600_000, config, "2026-10-22"))).toBe("2026-10-23T15:30:00.000Z");
    expect(iso(nextBriefAt(briefAt + 3_600_000, config, "2026-10-23"))).toBe("2026-10-24T15:30:00.000Z");
    expect(nextBriefAt(briefAt, { ...config, brief: { enabled: false, time: "08:30" } }, null)).toBeNull();
  });
});
