import { describe, expect, it } from "vitest";
import type { Alert } from "../shared/types";
import { deliveryDecision, extractReport, mergeReport, normalizeKey, type Report } from "./alerts";

const NOW = Date.parse("2026-10-23T18:00:00Z");
const base: Alert = {
  id: "al_1",
  key: "gh:o/r#41:ci",
  title: "CI failed on PR #41",
  detail: "3 timeouts in test_api.py",
  urgency: "normal",
  source: "checkin",
  status: "open",
  createdAt: "2026-10-23T16:00:00.000Z",
  updatedAt: "2026-10-23T16:00:00.000Z",
  snoozedUntil: null,
  delivered: true,
  runId: "ck_old",
};
const report = (items: Report["items"], notify = true): Report => ({ notify, summary: "s", items });
const item = (overrides: Partial<Report["items"][number]> = {}) => ({ key: base.key, title: base.title, detail: base.detail, urgency: "normal" as const, ...overrides });
const merge = (alerts: Alert[], r: Report) => mergeReport(alerts, r, { now: NOW, runId: "ck_new", source: "checkin" });

describe("mergeReport", () => {
  it("creates alerts for new keys", () => {
    const outcome = merge([], report([item({ key: "mail:abc", title: "Reply from Ana" })]));
    expect(outcome.fresh).toHaveLength(1);
    expect(outcome.alerts[0]).toMatchObject({ key: "mail:abc", status: "open", delivered: false, runId: "ck_new" });
  });

  it("does not repeat an open alert that did not change", () => {
    const outcome = merge([base], report([item()]));
    expect(outcome.fresh).toHaveLength(0);
    expect(outcome.suppressed).toEqual([{ key: base.key, reason: "unchanged" }]);
  });

  it("tells again when an open alert changed", () => {
    const outcome = merge([base], report([item({ detail: "now 5 failures, and the build is red on main" })]));
    expect(outcome.fresh).toHaveLength(1);
    expect(outcome.alerts).toHaveLength(1);
    expect(outcome.alerts[0]).toMatchObject({ id: "al_1", delivered: false, detail: "now 5 failures, and the build is red on main" });
  });

  it("never raises muted keys and holds snoozed ones until they wake", () => {
    const muted = { ...base, status: "muted" as const };
    expect(merge([muted], report([item({ detail: "changed" })])).suppressed).toEqual([{ key: base.key, reason: "muted" }]);
    const snoozed = { ...base, status: "snoozed" as const, snoozedUntil: "2026-10-23T20:00:00.000Z" };
    const held = merge([snoozed], report([item({ detail: "changed" })]));
    expect(held.fresh).toHaveLength(0);
    expect(held.alerts[0]).toMatchObject({ status: "snoozed", detail: "changed" });
    const woke = merge([{ ...snoozed, snoozedUntil: "2026-10-23T17:00:00.000Z" }], report([item()]));
    expect(woke.fresh).toHaveLength(1);
    expect(woke.alerts[0]).toMatchObject({ status: "open", snoozedUntil: null });
  });

  it("treats a recurrence after done as a new alert, but not the same text the same day", () => {
    const done = { ...base, status: "done" as const, updatedAt: "2026-10-23T17:00:00.000Z" };
    expect(merge([done], report([item()])).suppressed).toEqual([{ key: base.key, reason: "done" }]);
    const again = merge([done], report([item({ detail: "failed again on a new commit" })]));
    expect(again.fresh).toHaveLength(1);
    expect(again.alerts).toHaveLength(2);
  });

  it("derives a key from the title when the model gives none", () => {
    expect(normalizeKey("", "Dentist moved to 3 PM!")).toBe("dentist-moved-to-3-pm");
    expect(normalizeKey("  a  b ", "x")).toBe("a b");
  });
});

describe("deliveryDecision", () => {
  const fresh = [{ ...base, urgency: "normal" as const }];
  const input = { notify: true, fresh, config: { messagesPerDay: 6, unansweredLimit: 3 }, messagesToday: 0, unanswered: 0, activeNow: true, paused: false, requested: false };

  it("delivers news inside the limits", () => {
    expect(deliveryDecision(input)).toEqual({ deliver: true });
  });

  it("stays quiet without news", () => {
    expect(deliveryDecision({ ...input, notify: false })).toEqual({ deliver: false, reason: "quiet" });
    expect(deliveryDecision({ ...input, fresh: [] })).toEqual({ deliver: false, reason: "quiet" });
  });

  it("holds ordinary news at the limits and lets urgent news through", () => {
    expect(deliveryDecision({ ...input, messagesToday: 6 })).toEqual({ deliver: false, reason: "daily message limit" });
    expect(deliveryDecision({ ...input, unanswered: 3 })).toEqual({ deliver: false, reason: "waiting for your reply" });
    expect(deliveryDecision({ ...input, activeNow: false })).toEqual({ deliver: false, reason: "outside active hours" });
    const urgent = [{ ...base, urgency: "high" as const }];
    expect(deliveryDecision({ ...input, fresh: urgent, unanswered: 9, messagesToday: 99, activeNow: false })).toEqual({ deliver: true });
  });

  it("respects a pause but not for checks the user asked for", () => {
    expect(deliveryDecision({ ...input, paused: true, fresh: [{ ...base, urgency: "high" }] })).toEqual({ deliver: false, reason: "paused" });
    expect(deliveryDecision({ ...input, paused: true, requested: true })).toEqual({ deliver: true });
  });
});

describe("extractReport", () => {
  it("reads a fenced or bare JSON report", () => {
    expect(extractReport("Done.\n```json\n{\"notify\": false, \"summary\": \"nothing new\"}\n```")).toEqual({ notify: false, summary: "nothing new", items: [] });
    expect(extractReport("{\"notify\": true, \"summary\": \"x\", \"items\": [{\"key\": \"k\", \"title\": \"t\"}]}")?.items[0]).toMatchObject({ key: "k", urgency: "normal", detail: "" });
    expect(extractReport("no json here")).toBeNull();
    expect(extractReport(null)).toBeNull();
  });
});
