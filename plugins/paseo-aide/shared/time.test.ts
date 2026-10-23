import { describe, expect, it } from "vitest";
import { addDays, clampToWindow, dateKey, formatLocal, inWindow, isoInZone, localParts, weekdayOf, zonedTimeToEpoch } from "./time";

const LA = "America/Los_Angeles";
const SH = "Asia/Shanghai";

describe("zonedTimeToEpoch", () => {
  it("resolves a wall-clock time in the zone", () => {
    expect(new Date(zonedTimeToEpoch("2026-10-23", 8 * 60 + 30, LA)).toISOString()).toBe("2026-10-23T15:30:00.000Z");
    expect(new Date(zonedTimeToEpoch("2026-10-23", 8 * 60 + 30, SH)).toISOString()).toBe("2026-10-23T00:30:00.000Z");
  });

  it("moves a time inside the spring-forward gap to after the jump", () => {
    // 2026-03-08 02:30 does not exist in Los Angeles; 03:30 PDT is 10:30Z.
    expect(new Date(zonedTimeToEpoch("2026-03-08", 2 * 60 + 30, LA)).toISOString()).toBe("2026-03-08T10:30:00.000Z");
  });

  it("takes the first of two repeated readings when clocks fall back", () => {
    // 2026-11-01 01:30 happens at 08:30Z (PDT) and again at 09:30Z (PST).
    expect(new Date(zonedTimeToEpoch("2026-11-01", 90, LA)).toISOString()).toBe("2026-11-01T08:30:00.000Z");
  });
});

describe("calendar helpers", () => {
  it("reads local parts and date keys", () => {
    const ms = Date.parse("2026-10-23T23:30:00Z");
    expect(dateKey(ms, LA)).toBe("2026-10-23");
    expect(dateKey(ms, SH)).toBe("2026-10-24");
    expect(localParts(ms, SH)).toMatchObject({ hour: 7, minute: 30, weekday: 6 });
  });

  it("adds days across months and reports weekdays", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekdayOf("2026-10-23")).toBe(5);
  });

  it("formats with the zone offset", () => {
    expect(isoInZone(Date.parse("2026-10-23T23:00:00Z"), LA)).toBe("2026-10-23T16:00:00-07:00");
    expect(isoInZone(Date.parse("2026-10-23T23:00:00Z"), SH)).toBe("2026-10-24T07:00:00+08:00");
    const now = Date.parse("2026-10-23T17:00:00Z");
    expect(formatLocal(Date.parse("2026-10-23T23:00:00Z"), LA, now)).toBe("today 16:00");
    expect(formatLocal(Date.parse("2026-10-24T16:00:00Z"), LA, now)).toBe("tomorrow 09:00");
    expect(formatLocal(Date.parse("2026-10-27T16:00:00Z"), LA, now)).toBe("Tue 27 Oct 09:00");
  });
});

describe("windows", () => {
  const at = (iso: string) => Date.parse(iso);

  it("handles daytime and overnight windows", () => {
    expect(inWindow(at("2026-10-23T15:00:00Z"), LA, "08:00", "22:00")).toBe(true); // 08:00 local
    expect(inWindow(at("2026-10-24T05:00:00Z"), LA, "08:00", "22:00")).toBe(false); // 22:00 local
    expect(inWindow(at("2026-10-24T06:00:00Z"), LA, "22:00", "02:00")).toBe(true); // 23:00 local
    expect(inWindow(at("2026-10-24T10:00:00Z"), LA, "22:00", "02:00")).toBe(false); // 03:00 local
    expect(inWindow(at("2026-10-24T10:00:00Z"), LA, "00:00", "00:00")).toBe(true);
  });

  it("moves a time outside the window to the next opening", () => {
    const late = at("2026-10-24T06:00:00Z"); // 23:00 local
    expect(new Date(clampToWindow(late, LA, "08:00", "22:00")).toISOString()).toBe("2026-10-24T15:00:00.000Z");
    const early = at("2026-10-23T12:00:00Z"); // 05:00 local
    expect(new Date(clampToWindow(early, LA, "08:00", "22:00")).toISOString()).toBe("2026-10-23T15:00:00.000Z");
    const inside = at("2026-10-23T18:00:00Z");
    expect(clampToWindow(inside, LA, "08:00", "22:00")).toBe(inside);
  });
});
