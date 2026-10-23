import { describe, expect, test } from "vitest";
import { detectRateLimit, usageRecovery } from "./rate-limit.js";

const now = Date.parse("2026-10-22T18:00:00Z");
const later = Date.parse("2026-10-22T19:00:00Z");
const laterStill = Date.parse("2026-10-22T20:00:00Z");

function failed(message: string, code?: string) {
  return detectRateLimit({ outcome: { kind: "failed", error: { message, code } }, now });
}

describe("detectRateLimit", () => {
  test.each([
    "You've hit your usage limit. Try again later.",
    "Rate limit reached for gpt-6-astra.",
    "Too many requests",
    "API Error: 429",
    '{"error":{"type":"rate_limit_exceeded","message":"Please wait"}}',
    '{"error":{"type":"usage_limit_reached","message":"Please wait"}}',
  ])("recognizes a provider failure: %s", (message) => {
    expect(failed(message)).toEqual({ message, resetAt: null });
  });

  test.each(["rate_limit_exceeded", "rate_limit_error", "usage_limit_reached", "429"])(
    "accepts an explicit outcome code: %s",
    (code) => expect(failed("Please wait", code)).toEqual({ message: "Please wait", resetAt: null }),
  );

  test.each([
    "Authentication failed",
    "Connection reset by peer",
    "The remote tool exited with code 429",
    "Not enough credits",
  ])("ignores an unrelated provider error: %s", (message) => {
    expect(failed(message)).toBeNull();
  });

  test.each(["resets_at", "reset_at", "resetsAt", "resetAt"])(
    "reads the provider's Unix-seconds %s field",
    (key) => {
      const message = `API Error: 429 ${JSON.stringify({ error: { type: "rate_limit_error", [key]: later / 1000 } })}`;
      expect(failed(message)?.resetAt).toBe(later);
    },
  );

  test("reads ISO and Unix-millisecond reset fields", () => {
    for (const timestamp of ["2026-10-22T19:00:00Z", later]) {
      expect(failed(JSON.stringify({ error: { type: "rate_limit_error", resets_at: timestamp } }))?.resetAt).toBe(later);
    }
  });

  test("reads nested error details without treating another timestamp as a reset", () => {
    expect(failed(JSON.stringify({ error: { type: "rate_limit_error", details: { resets_at: later / 1000 } } }))?.resetAt).toBe(later);
    expect(failed(JSON.stringify({ error: { type: "rate_limit_error", timestamp: later / 1000 } }))?.resetAt).toBeNull();
  });

  test.each([
    ["Try again in 1h 2m 3s", 3_723_000],
    ["Retry in 1 hour, 2 minutes and 3 seconds.", 3_723_000],
    ["Resets in 1d2h", 93_600_000],
    ["Try again in 1.5 minutes", 90_000],
  ])("parses explicit retry duration %s", (suffix, duration) => {
    expect(failed(`Rate limit reached. ${suffix}`)?.resetAt).toBe(now + Number(duration));
  });

  test.each([
    "Rate limit reached. Try again at 2026-10-22T19:00:00Z.",
    "Usage limit reached. Resets at 2026-10-22T12:00:00-07:00.",
  ])("parses an explicit absolute retry date: %s", (message) => {
    expect(failed(message)?.resetAt).toBe(later);
  });

  test.each([
    "Rate limit reached. Try again later.",
    "Rate limit reached on 2026-10-22T19:00:00Z.",
    "Rate limit reached. Try again in 2 milliseconds.",
    'Rate limit reached {"error":{"resets_at":"not a date"}}',
    'Rate limit reached {"error":{"resets_at":"2026-10-22T19:00:00"}}',
  ])("does not guess an unavailable reset date: %s", (message) => {
    expect(failed(message)?.resetAt).toBeNull();
  });

  test("uses a current-turn explicit error timeline row", () => {
    const message = "Too many requests. Try again in 3s.";
    expect(detectRateLimit({
      outcome: { kind: "completed" }, now,
      timeline: [{ item: { type: "user_message", text: "Continue" } }, { item: { type: "error", message } }],
    })).toEqual({ message, resetAt: now + 3000 });
  });

  test("handles Claude's assistant API error on a nominally completed turn", () => {
    const message = 'API Error: 429 {"error":{"type":"rate_limit_error","resets_at":1792695600}}';
    expect(detectRateLimit({ outcome: { kind: "completed" }, now, timeline: [{ type: "assistant_message", text: message }] }))
      .toMatchObject({ message, resetAt: 1792695600000 });
  });

  test.each([
    { type: "user_message", text: "Build a rate limit plugin" },
    { type: "assistant_message", text: "We should implement rate limit handling" },
    { type: "reasoning", text: "API Error: 429 rate_limit_error" },
    { type: "tool_call", status: "failed", error: { message: "rate limit reached" } },
    { type: "notification", level: "error", message: "rate limit reached" },
    { type: "plugin", data: { message: "rate limit reached" } },
  ])("ignores rate-limit words in non-error content: $type", (item) => {
    expect(detectRateLimit({ outcome: { kind: "completed" }, timeline: [item], now })).toBeNull();
  });

  test.each([
    [{ type: "error", message: "Rate limit reached" }, { type: "user_message", text: "hello" }],
    [{ type: "error", message: "Rate limit reached" }, { type: "turn_started" }],
    [{ type: "error", message: "Rate limit reached" }, { type: "assistant_message", text: "Recovered successfully" }],
    [{ type: "assistant_message", text: "API Error: 429" }, { type: "tool_call", status: "completed" }],
  ])("ignores a stale or already recovered timeline error", (...timeline) => {
    expect(detectRateLimit({ outcome: { kind: "completed" }, timeline, now })).toBeNull();
  });

  test("current non-quota failure overrides stale timeline quota errors", () => {
    expect(detectRateLimit({
      outcome: { kind: "failed", error: { message: "Connection refused" } }, now,
      timeline: [{ type: "error", message: "Rate limit reached" }],
    })).toBeNull();
  });

  test("cancelled turns never trigger model changes", () => {
    expect(detectRateLimit({ outcome: { kind: "canceled" }, timeline: [{ type: "error", message: "Rate limit reached" }], now })).toBeNull();
  });

  test.each([
    "You've hit your session limit · resets 2pm (America/Los_Angeles)",
    "You've hit your weekly limit · resets Oct 29, 2pm (America/Los_Angeles)",
    "You've hit your Opus limit · resets 2pm (America/Los_Angeles)",
    "You've reached your Sonnet weekly allowance · resets 2pm (America/Los_Angeles)",
    "You've exceeded your Opus usage allowance.",
    "You're out of extra usage · resets 2pm (America/Los_Angeles)",
  ])("recognizes Claude's rejected quota notice on a completed turn: %s", (message) => {
    expect(detectRateLimit({
      provider: "claude", outcome: { kind: "completed" }, now,
      timeline: [{ type: "assistant_message", text: message }],
    })?.message).toBe(message);
    expect(failed(message)?.message).toBe(message);
  });

  test("requires Claude provider context for unmarked assistant limit notices", () => {
    const timeline = [{ type: "assistant_message", text: "You've hit your session limit · resets 2pm (America/Los_Angeles)" }];
    expect(detectRateLimit({ outcome: { kind: "completed" }, timeline, now })).toBeNull();
    expect(detectRateLimit({ provider: "codex", outcome: { kind: "completed" }, timeline, now })).toBeNull();
  });

  test.each([
    "You're close to your session limit",
    "Your weekly limit still applies, and responses may pause while waiting for spare capacity.",
    "You've hit your session limit. This message indicates a rejected request.",
    "You've hit your session limit · resets 2pm (America/Los_Angeles). This is an example error.",
    "The CLI says: You've hit your session limit · resets 2pm (America/Los_Angeles)",
    "```\nYou've hit your session limit · resets 2pm (America/Los_Angeles)\n```",
    "API is overloaded. Try again later.",
  ])("ignores Claude quota warnings and assistant discussion: %s", (text) => {
    expect(detectRateLimit({ provider: "claude", outcome: { kind: "completed" },
      timeline: [{ type: "assistant_message", text }], now })).toBeNull();
  });

  test("does not use Claude quota words from user prompts or tool output", () => {
    const text = "You've hit your session limit · resets 2pm (America/Los_Angeles)";
    for (const item of [{ type: "user_message", text }, { type: "reasoning", text },
      { type: "tool_call", result: text }]) {
      expect(detectRateLimit({ provider: "claude", outcome: { kind: "completed" }, timeline: [item], now })).toBeNull();
    }
  });

  test("resolves the named timezone instead of the daemon's timezone", () => {
    const message = "You've hit your session limit · resets 2pm (America/Los_Angeles)";
    expect(failed(message)?.resetAt).toBe(Date.parse("2026-10-22T21:00:00Z"));
    expect(detectRateLimit({ provider: "claude", outcome: { kind: "completed" },
      timeline: [{ type: "assistant_message", text: `${message} · progress saved` }], now })?.resetAt)
      .toBe(Date.parse("2026-10-22T21:00:00Z"));
  });

  test("resolves a time-only next-day reset and 12am / 12pm correctly", () => {
    const at = Date.parse("2026-10-23T01:00:00Z"); // 6pm PDT
    for (const [time, timestamp] of [["2pm", "2026-10-23T21:00:00Z"],
      ["12am", "2026-10-23T07:00:00Z"], ["12pm", "2026-10-23T19:00:00Z"]]) {
      expect(detectRateLimit({ outcome: { kind: "failed", error: {
        message: `You've hit your session limit · resets ${time} (America/Los_Angeles)`,
      } }, now: at })?.resetAt).toBe(Date.parse(timestamp!));
    }
  });

  test.each([
    ["Oct 29, 2pm", "2026-10-29T21:00:00Z"],
    ["Nov 2, 2pm", "2026-11-02T22:00:00Z"],
    ["Nov 2 at 2:15pm", "2026-11-02T22:15:00Z"],
    ["Jan 2, 2027, 2pm", "2027-01-02T22:00:00Z"],
  ])("resolves a date-specific Claude reset across DST and year boundaries: %s", (clock, timestamp) => {
    expect(failed(`You've hit your weekly limit · resets ${clock} (America/Los_Angeles)`)?.resetAt)
      .toBe(Date.parse(timestamp));
  });

  test.each([
    ["2026-11-01T07:30:00Z", "1:30am"], // Both fall-back occurrences are still in the future.
    ["2026-03-08T08:30:00Z", "2:30am"], // Spring-forward local time does not exist.
  ])("leaves ambiguous/nonexistent DST wall clocks to the usage endpoint", (at, time) => {
    expect(detectRateLimit({ outcome: { kind: "failed", error: {
      message: `You've hit your session limit · resets ${time} (America/Los_Angeles)`,
    } }, now: Date.parse(at) })?.resetAt).toBeNull();
  });

  test.each([
    "You've hit your weekly limit · resets Feb 30, 2pm (America/Los_Angeles)",
    "You've hit your session limit · resets 13pm (America/Los_Angeles)",
    "You've hit your session limit · resets 2pm (Invalid/Timezone)",
    "You've hit your session limit · resets 2pm",
  ])("does not guess malformed or unzoned Claude reset times: %s", (message) => {
    expect(failed(message)?.resetAt).toBeNull();
  });
});

function usage(windows: unknown[], extraEntry: Record<string, unknown> = {}) {
  return { requestId: "test", reports: [{
    id: "codex-source:codex/account", sourceId: "codex-source:codex", sourceLabel: "Codex",
    account: {}, fetchedAt: new Date(now).toISOString(),
    report: { status: "available", windows }, ...extraEntry,
  }] };
}

const sharedAvailable = { id: "five_hour", label: "5-hour", summary: true, usedPct: 5, remainingPct: 95 };

describe("usageRecovery", () => {
  test("recognizes current available shared quotas", () => {
    expect(usageRecovery(usage([sharedAvailable]), "gpt-6-astra", now)).toEqual({ status: "available", resetAt: null });
  });

  test("waits for every exhausted relevant window", () => {
    expect(usageRecovery(usage([
      { id: "five_hour", label: "5-hour", usedPct: 100, resetsAt: new Date(later).toISOString() },
      { id: "weekly", label: "Weekly", remainingPct: 0, resetsAt: new Date(laterStill).toISOString() },
    ]), "gpt-6-astra", now)).toEqual({ status: "exhausted", resetAt: laterStill });
  });

  test("does not invent a recovery date for missing or past resets", () => {
    for (const resetsAt of [null, "invalid", new Date(now - 1000).toISOString()]) {
      expect(usageRecovery(usage([{ id: "weekly", usedPct: 100, resetsAt }]), "gpt-6-astra", now))
        .toEqual({ status: "exhausted", resetAt: null });
    }
    expect(usageRecovery(usage([
      { id: "weekly", usedPct: 100 },
      { id: "five_hour", usedPct: 100, resetsAt: new Date(later).toISOString() },
    ]), "gpt-6-astra", now)).toEqual({ status: "exhausted", resetAt: null });
  });

  test("main-model limits block restoration while fallback-model limits do not", () => {
    const payload = usage([
      sharedAvailable,
      { id: "limit:gpt-6-astra:weekly", label: "GPT-6 Astra · Weekly", usedPct: 100, resetsAt: new Date(later).toISOString() },
      { id: "limit:gpt-6.1:weekly", label: "GPT-6.1 · Weekly", usedPct: 100, resetsAt: new Date(laterStill).toISOString() },
    ]);
    expect(usageRecovery(payload, "codex/gpt-6-astra", now)).toEqual({ status: "exhausted", resetAt: later });
    expect(usageRecovery(payload, "gpt-6.1", now)).toEqual({ status: "exhausted", resetAt: laterStill });
  });

  test("an exhausted Astra-only quota does not block GPT-6.1", () => {
    expect(usageRecovery(usage([
      sharedAvailable,
      { id: "limit:gpt-6-astra:weekly", label: "GPT-6 Astra · Weekly", usedPct: 100, resetsAt: new Date(later).toISOString() },
    ]), "gpt-6.1", now)).toEqual({ status: "available", resetAt: null });
  });

  test("matches a model label when metered_feature is an opaque codename", () => {
    expect(usageRecovery(usage([
      sharedAvailable,
      { id: "limit:codex_bengalfox:five_hour", label: "GPT-5.3-Codex-Spark · 5-hour", usedPct: 100, resetsAt: new Date(later).toISOString() },
    ]), "gpt-5.3-codex-spark", now)).toEqual({ status: "exhausted", resetAt: later });
  });

  test("decodes model scope identities and excludes code-review quota", () => {
    expect(usageRecovery(usage([
      { id: "limit:openai%2Fgpt-6-astra:weekly", label: "Premium", usedPct: 100, resetsAt: new Date(later).toISOString() },
      { id: "code_review:weekly", label: "Code review · Weekly", usedPct: 100, resetsAt: new Date(laterStill).toISOString() },
    ]), "gpt-6-astra", now)).toEqual({ status: "exhausted", resetAt: later });
    expect(usageRecovery(usage([sharedAvailable, { id: "code_review:weekly", usedPct: 100 }]), "gpt-6-astra", now))
      .toEqual({ status: "available", resetAt: null });
  });

  test("does not assert recovery when relevant quota data is incomplete", () => {
    for (const windows of [[], [{ id: "weekly", usedPct: null }], [sharedAvailable, { id: "weekly" }],
      [sharedAvailable, { id: "limit:opaque:weekly", label: "Premium", usedPct: 100 }],
      [sharedAvailable, { id: "limit:codex_opaque:weekly", label: "Premium", usedPct: 100 }]]) {
      expect(usageRecovery(usage(windows), "gpt-6-astra", now)).toBeNull();
    }
  });

  test.each([
    { status: "error", error: "connection failed" },
    { status: "unavailable", problem: { kind: "expired", expiresAt: new Date(now).toISOString() } },
  ])("ignores historical successful quota when the current report is $status", (report) => {
    const raw = usage([], { report, lastSuccessful: { fetchedAt: new Date(now - 1000).toISOString(), report: { status: "available", windows: [sharedAvailable] } } });
    expect(usageRecovery(raw, "gpt-6-astra", now)).toBeNull();
  });

  test("ignores other usage sources and ambiguous login accounts", () => {
    const raw = usage([sharedAvailable]);
    expect(usageRecovery({ reports: [{ ...raw.reports[0], sourceId: "claude", sourceLabel: "Claude" }] }, "gpt-6-astra", now)).toBeNull();
    expect(usageRecovery({ reports: [...raw.reports, ...raw.reports] }, "gpt-6-astra", now)).toBeNull();
    expect(usageRecovery(null, "gpt-6-astra", now)).toBeNull();
  });
});

function claudeUsage(windows: unknown[], extraEntry: Record<string, unknown> = {}) {
  return usage(windows, {
    id: "claude-source:claude/account", sourceId: "claude-source:claude", sourceLabel: "Claude", ...extraEntry,
  });
}

describe("Claude usageRecovery", () => {
  const opus = "claude-opus-4-6";
  const sonnet = "claude-sonnet-4-6";
  const reset = new Date(later).toISOString();

  test.each(["weekly", "seven_day", "five_hour"])("shared %s exhaustion blocks all models", (id) => {
    const payload = claudeUsage([{ id, usedPct: 100, resetsAt: reset }]);
    for (const model of [opus, sonnet]) {
      expect(usageRecovery(payload, model, now, "claude")).toEqual({ status: "exhausted", resetAt: later });
    }
  });

  test.each(["seven_day_opus", "weekly_model_opus", "weekly:model:opus", "weekly:opus"])(
    "Opus-only %s exhaustion permits Sonnet but blocks Opus", (id) => {
      const payload = claudeUsage([sharedAvailable, { id, label: "Weekly · Opus", usedPct: 100, resetsAt: reset }]);
      expect(usageRecovery(payload, opus, now, "claude")).toEqual({ status: "exhausted", resetAt: later });
      expect(usageRecovery(payload, sonnet, now, "claude")).toEqual({ status: "available", resetAt: null });
    },
  );

  test.each(["seven_day_sonnet", "weekly_model_sonnet", "weekly:model:sonnet"])(
    "Sonnet-only %s exhaustion permits Opus but blocks Sonnet", (id) => {
      const payload = claudeUsage([sharedAvailable, { id, label: "Weekly · Sonnet", usedPct: 100, resetsAt: reset }]);
      expect(usageRecovery(payload, opus, now, "claude")).toEqual({ status: "available", resetAt: null });
      expect(usageRecovery(payload, sonnet, now, "claude")).toEqual({ status: "exhausted", resetAt: later });
    },
  );

  test("uses main family from provider-qualified and versioned model ids", () => {
    expect(usageRecovery(claudeUsage([{ id: "weekly_model_opus_4_6", usedPct: 100, resetsAt: reset }]),
      "anthropic/claude-opus-4-6[1m]", now, "claude")).toEqual({ status: "exhausted", resetAt: later });
  });

  test("resolves opaque model scope ids using a model-scoped display family", () => {
    const payload = claudeUsage([sharedAvailable, {
      id: "weekly_model_opaque_7", label: "Weekly · Opus", usedPct: 100, resetsAt: reset,
    }]);
    expect(usageRecovery(payload, opus, now, "claude")).toEqual({ status: "exhausted", resetAt: later });
    expect(usageRecovery(payload, sonnet, now, "claude")).toEqual({ status: "available", resetAt: null });
  });

  test("keeps surface scopes distinct from models and includes Claude Code limits", () => {
    const payload = claudeUsage([sharedAvailable,
      { id: "weekly_surface_code", label: "Weekly · Code", usedPct: 100, resetsAt: reset },
      { id: "weekly_surface_chat", usedPct: 100, resetsAt: new Date(laterStill).toISOString() },
    ]);
    expect(usageRecovery(payload, opus, now, "claude")).toEqual({ status: "exhausted", resetAt: later });
    expect(usageRecovery(claudeUsage([sharedAvailable, {
      id: "weekly_surface_opus", label: "Weekly · Opus", usedPct: 100,
    }]), opus, now, "claude")).toBeNull();
  });

  test("uses only the requested provider and never another login's account", () => {
    const codex = usage([sharedAvailable]);
    const claude = claudeUsage([{ id: "weekly", usedPct: 100, resetsAt: reset }]);
    const mixed = { reports: [...codex.reports, ...claude.reports] };
    expect(usageRecovery(mixed, opus, now, "claude")).toEqual({ status: "exhausted", resetAt: later });
    expect(usageRecovery(mixed, "gpt-6.1", now)).toEqual({ status: "available", resetAt: null });
    expect(usageRecovery(codex, opus, now, "claude")).toBeNull();
    expect(usageRecovery({ reports: [...claude.reports, ...claude.reports] }, opus, now, "claude")).toBeNull();
  });

  test("never uses lastSuccessful or ambiguous unknown model quota to infer recovery", () => {
    expect(usageRecovery(claudeUsage([], {
      report: { status: "error", error: "Rate limited by Claude. Try again in 45m." },
      lastSuccessful: { fetchedAt: new Date(now - 1000).toISOString(), report: { status: "available", windows: [sharedAvailable] } },
    }), opus, now, "claude")).toBeNull();
    expect(usageRecovery(claudeUsage([sharedAvailable, {
      id: "weekly_model_opaque", label: "Weekly · Premium", usedPct: 100,
    }]), opus, now, "claude")).toBeNull();
    expect(usageRecovery(claudeUsage([sharedAvailable, {
      id: "weekly_model_opus", usedPct: 100,
    }]), "default", now, "claude")).toBeNull();
  });
});
