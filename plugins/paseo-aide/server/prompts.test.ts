import { describe, expect, it } from "vitest";
import type { ScheduleConfig } from "../shared/schedule";
import { DEFAULT_CONFIG } from "../shared/types";
import { briefBody, checkinPrompt, watchesPaseo } from "./prompts";

const schedule: ScheduleConfig = { timezone: "America/Los_Angeles", checkins: DEFAULT_CONFIG.checkins, brief: DEFAULT_CONFIG.brief, activeHours: DEFAULT_CONFIG.activeHours };
const NOW = Date.parse("2026-10-23T17:00:00Z");
const waiting = [{ agentId: "a1", title: "Fix login", project: "app", reason: "permission" as const, since: "2026-10-23T15:00:00.000Z", detail: "Bash: npm publish" }];

function prompt(watchlist: string | null) {
  return checkinPrompt({ now: NOW, config: DEFAULT_CONFIG, schedule, reason: "scheduled", focus: null, watchlist, memory: null, alerts: [], followups: [], waiting, conversation: [] });
}

describe("what a check-in is told to watch", () => {
  it("includes Paseo work only when the watch list mentions Paseo", () => {
    expect(watchesPaseo("- Paseo: agents waiting on me")).toBe(true);
    expect(watchesPaseo("- my CI on GitHub")).toBe(false);
    expect(prompt("- Paseo: agents waiting on me")).toMatch(/Fix login in app needs an approval since today 08:00: Bash: npm publish \(key paseo:a1:permission\)/);
    expect(prompt("- my CI on GitHub")).not.toMatch(/Paseo work waiting/);
  });

  it("leaves Paseo out of the brief when it is not watched", () => {
    const base = { now: NOW, config: DEFAULT_CONFIG, schedule, alerts: [], today: [] };
    expect(briefBody({ ...base, waiting: undefined })).not.toMatch(/Paseo work/);
    expect(briefBody({ ...base, waiting })).toMatch(/Paseo work waiting on the user:\n- Fix login/);
  });
});
