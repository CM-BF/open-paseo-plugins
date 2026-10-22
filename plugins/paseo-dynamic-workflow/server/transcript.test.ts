import { describe, expect, it } from "vitest";
import { transcriptEntries } from "./transcript";

describe("transcriptEntries", () => {
  it("joins reply chunks and summarizes tool calls", () => {
    const { entries } = transcriptEntries([
      { type: "tool_call", name: "agent_message", status: "completed", agentMessage: { text: "Review src/a.js" } },
      { type: "tool_call", name: "Read", status: "completed", detail: { type: "read", filePath: "src/a.js" } },
      { type: "tool_call", name: "Bash", status: "failed", detail: { type: "shell", command: "npm test" } },
      { type: "reasoning", text: "thinking" },
      { type: "assistant_message", text: '{"ok":' },
      { type: "assistant_message", text: "true}" },
    ]);
    expect(entries).toEqual([
      { kind: "user", text: "Review src/a.js", status: null },
      { kind: "tool", text: "Read src/a.js", status: "completed" },
      { kind: "tool", text: "Bash: npm test", status: "failed" },
      { kind: "assistant", text: '{"ok":true}', status: null },
    ]);
  });
});
