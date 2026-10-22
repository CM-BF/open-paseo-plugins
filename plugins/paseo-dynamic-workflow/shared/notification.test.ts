import { describe, expect, it } from "vitest";
import { parseNotice } from "./notification";

describe("parseNotice", () => {
  it("reads the plugin's task notification", () => {
    const text =
      "[paseo-dynamic-workflow] A background workflow you launched has ended.\n<task-notification>\n<task-id>wf_abc123</task-id>\n<status>completed</status>\n<summary>Dynamic workflow \"x\" completed</summary>\n</task-notification>";
    expect(parseNotice(text)).toMatchObject({ runId: "wf_abc123", status: "completed", summary: 'Dynamic workflow "x" completed' });
  });

  it("ignores other messages", () => {
    expect(parseNotice("<task-notification><task-id>wf_x</task-id></task-notification>")).toBeNull();
    expect(parseNotice("[paseo-dynamic-workflow] hello")).toBeNull();
  });
});

describe("CardDataSchema", () => {
  it("accepts cards written before the skipped count existed", async () => {
    const { CardDataSchema } = await import("./run-types");
    const parsed = CardDataSchema.parse({
      runId: "wf_x",
      name: "n",
      description: "d",
      status: "completed",
      startedAt: "2026-10-22T00:00:00Z",
      endedAt: null,
      phases: [{ title: "A", detail: null, total: 1, running: 0, done: 1, failed: 0 }],
      active: [],
      agents: { total: 1, running: 0, done: 1, failed: 0, cached: 0 },
      logs: [],
      resultPreview: null,
      error: null,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    });
    expect(parsed.agents.skipped).toBe(0);
    expect(parsed.phases[0]?.skipped).toBe(0);
  });
});
