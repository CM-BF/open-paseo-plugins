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
