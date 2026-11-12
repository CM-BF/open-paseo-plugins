import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { skillMarkdown } from "./prompts";
import { curateItems, type TimelineItem } from "./side-history";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("history Side documentation matches what the runtime provides", () => {
  it("states that sub-agent reports are not available, because Paseo 0.15.x sends sub-agent cards with an empty log", () => {
    // The shape every provider in the installed 0.15.3 runtime emits (COMPAT(subagent-log): `log: ""`).
    const [card] = curateItems([{ type: "tool_call", callId: "t", name: "Task", status: "completed", error: null, detail: { type: "sub_agent", subAgentType: "Explore", description: "find files", log: "", actions: [] } } as unknown as TimelineItem]);
    expect(card).toEqual({ text: "[Explore] find files", message: false });
    const readme = read("README.md"), verification = read("docs/verification/2026-11-11-side-history.md");
    for (const doc of [readme, verification]) expect(doc).toMatch(/Sub-agent \(Task\) reports are not available/);
    for (const doc of [readme, verification, skillMarkdown("/plugin/bin/paseo-board")]) {
      expect(doc).not.toMatch(/sub-agent\/worktree logs?|sub-agent or worktree logs?|sub-agent logs? (?:is|are) (?:carried|included)/i);
    }
  });
});
