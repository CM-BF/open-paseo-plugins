import { describe, expect, it } from "vitest";
import { describeRepeat, nextOccurrence, parseClock, parseDuration, parseRepeat, parseWhen } from "./when";

const LA = "America/Los_Angeles";
// Friday 23 October 2026, 10:00 in Los Angeles.
const NOW = Date.parse("2026-10-23T17:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("parseDuration and parseClock", () => {
  it("reads durations", () => {
    expect(parseDuration("90m")).toBe(90);
    expect(parseDuration("1h 30m")).toBe(90);
    expect(parseDuration("2 hours")).toBe(120);
    expect(parseDuration("1.5h")).toBe(90);
    expect(parseDuration("3 days")).toBe(4320);
    expect(parseDuration("9am")).toBeNull();
    expect(parseDuration("tomorrow")).toBeNull();
  });

  it("reads clock times", () => {
    expect(parseClock("9")).toBe(540);
    expect(parseClock("9am")).toBe(540);
    expect(parseClock("12am")).toBe(0);
    expect(parseClock("12pm")).toBe(720);
    expect(parseClock("9:30 pm")).toBe(21 * 60 + 30);
    expect(parseClock("21:05")).toBe(21 * 60 + 5);
    expect(parseClock("noon")).toBe(720);
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock("13pm")).toBeNull();
  });
});

describe("parseWhen", () => {
  it("reads relative times", () => {
    expect(parseWhen("in 2h", NOW, LA)).toBe(NOW + 2 * 3_600_000);
    expect(parseWhen("30m", NOW, LA)).toBe(NOW + 30 * 60_000);
    expect(parseWhen("now", NOW, LA)).toBe(NOW);
  });

  it("reads days and clock times in the user's zone", () => {
    expect(iso(parseWhen("tomorrow 9am", NOW, LA))).toBe("2026-10-24T16:00:00.000Z");
    expect(iso(parseWhen("tomorrow at 9:30", NOW, LA))).toBe("2026-10-24T16:30:00.000Z");
    expect(iso(parseWhen("today 16:00", NOW, LA))).toBe("2026-10-23T23:00:00.000Z");
    expect(iso(parseWhen("16:00", NOW, LA))).toBe("2026-10-23T23:00:00.000Z");
    // 08:00 already passed today, so the next 08:00 is tomorrow.
    expect(iso(parseWhen("8:00", NOW, LA))).toBe("2026-10-24T15:00:00.000Z");
    expect(iso(parseWhen("mon 9am", NOW, LA))).toBe("2026-10-26T16:00:00.000Z");
    expect(iso(parseWhen("on friday 16:00", NOW, LA))).toBe("2026-10-23T23:00:00.000Z");
    expect(iso(parseWhen("next friday 16:00", NOW, LA))).toBe("2026-10-30T23:00:00.000Z");
    expect(iso(parseWhen("fri 8:00", NOW, LA))).toBe("2026-10-30T15:00:00.000Z");
    expect(iso(parseWhen("2026-10-24 09:30", NOW, LA))).toBe("2026-10-24T16:30:00.000Z");
    expect(iso(parseWhen("2026-10-24T09:30:00+08:00", NOW, LA))).toBe("2026-10-24T01:30:00.000Z");
  });

  it("explains what it cannot read", () => {
    expect(() => parseWhen("sometime soon", NOW, LA)).toThrow(/Could not read/);
    expect(() => parseWhen("", NOW, LA)).toThrow(/Say when/);
  });
});

describe("repeats", () => {
  it("parses the supported forms", () => {
    expect(parseRepeat("every 3h")).toEqual({ kind: "interval", minutes: 180 });
    expect(parseRepeat("hourly")).toEqual({ kind: "interval", minutes: 60 });
    expect(parseRepeat("daily 9am")).toEqual({ kind: "daily", time: "09:00" });
    expect(parseRepeat("every day at 08:30")).toEqual({ kind: "daily", time: "08:30" });
    expect(parseRepeat("weekdays 8:30")).toEqual({ kind: "weekdays", time: "08:30" });
    expect(parseRepeat("every monday 9am")).toEqual({ kind: "weekly", weekday: 1, time: "09:00" });
    expect(parseRepeat("weekly fri 17:00")).toEqual({ kind: "weekly", weekday: 5, time: "17:00" });
    expect(parseRepeat("none")).toBeNull();
    expect(parseRepeat(undefined)).toBeNull();
  });

  it("refuses repeats that are too frequent or unreadable", () => {
    expect(() => parseRepeat("every 5m")).toThrow(/at least 30 minutes/);
    expect(() => parseRepeat("daily")).toThrow(/Give a time/);
    expect(() => parseRepeat("sometimes")).toThrow(/Could not read/);
  });

  it("finds the next occurrence", () => {
    expect(nextOccurrence({ kind: "interval", minutes: 90 }, NOW, LA)).toBe(NOW + 90 * 60_000);
    expect(iso(nextOccurrence({ kind: "daily", time: "09:00" }, NOW, LA))).toBe("2026-10-24T16:00:00.000Z");
    expect(iso(nextOccurrence({ kind: "daily", time: "11:00" }, NOW, LA))).toBe("2026-10-23T18:00:00.000Z");
    // Friday after 09:00: the next weekday 09:00 is Monday.
    expect(iso(nextOccurrence({ kind: "weekdays", time: "09:00" }, NOW, LA))).toBe("2026-10-26T16:00:00.000Z");
    expect(iso(nextOccurrence({ kind: "weekly", weekday: 3, time: "09:00" }, NOW, LA))).toBe("2026-10-28T16:00:00.000Z");
  });

  it("describes repeats", () => {
    expect(describeRepeat(null)).toBe("once");
    expect(describeRepeat({ kind: "interval", minutes: 180 })).toBe("every 3h");
    expect(describeRepeat({ kind: "interval", minutes: 45 })).toBe("every 45m");
    expect(describeRepeat({ kind: "weekly", weekday: 1, time: "09:00" })).toBe("every Monday at 09:00");
  });
});
