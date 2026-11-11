import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { captureOwnerHistory, curateItems, displayToolName, fitEntries, historyText, neutralize, OWNER_HISTORY_MAX_CHARS, stripInheritedHistory, type CuratedEntry, type TimelineItem } from "./side-history";

const tool = (name: string, detail: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "tool_call", callId: name, name, status: "completed", error: null, detail, ...extra }) as unknown as TimelineItem;
const entry = (text: string, message = true): CuratedEntry => ({ text, message });

describe("owner history curation", () => {
  it("keeps only user, assistant and tool rows, like native fork context", () => {
    const items = [
      { type: "user_message", text: "  Question  " }, { type: "assistant_message", text: "Answer" }, { type: "reasoning", text: "hidden" },
      { type: "todo", items: [{ text: "task", completed: false }] }, { type: "error", message: "boom" }, { type: "notification", level: "info", message: "note" },
      { type: "compaction", status: "completed" }, { type: "plugin", id: "p", pluginId: "x", kind: "k", version: 1, data: {} }, { type: "assistant_message", text: "   " },
    ] as unknown as TimelineItem[];
    expect(curateItems(items)).toEqual([entry("[User] Question"), entry("[Assistant] Answer")]);
  });

  it("summarises tools from canonical details only and never includes outputs or external input", () => {
    const long = "a".repeat(400);
    const entries = curateItems([
      tool("Bash", { type: "shell", command: "npm   test", output: "OUTPUT" }),
      tool("Read", { type: "read", filePath: "/repo/a.ts", content: "CONTENT" }),
      tool("Edit", { type: "edit", filePath: "/repo/b.ts", unifiedDiff: "DIFF" }),
      tool("WebSearch", { type: "search", query: "paseo fork" }),
      tool("WebFetch", { type: "fetch", url: "https://example.test", result: "RESULT" }),
      tool("Task", { type: "sub_agent", subAgentType: "Explore", description: "find files", log: "SUBAGENT_LOG" }),
      tool("terminal_note", { type: "plain_text", label: "Label only", text: "PLAIN_TEXT_OUTPUT" }),
      tool("ExitPlanMode", { type: "plan", text: "PLAN_TEXT" }),
      tool("mcp__paseo_board__board_publish", { type: "unknown", input: { html: "EXTERNAL_INPUT" }, output: null }),
      tool("future_tool", { type: "brand_new", secret: "FUTURE_FIELD" }),
      tool("Bash", { type: "shell", command: long }),
    ]).map(item => item.text);
    expect(entries).toEqual([
      "[Shell] npm test", "[Read] /repo/a.ts", "[Edit] /repo/b.ts", "[Search] paseo fork", "[Fetch] https://example.test", "[Explore] find files",
      "[Terminal note] Label only", "[Plan]", "[board_publish]", "[Future tool]", `[Shell] ${"a".repeat(197)}...`,
    ]);
    for (const hidden of ["OUTPUT", "CONTENT", "DIFF", "RESULT", "SUBAGENT_LOG", "PLAIN_TEXT_OUTPUT", "PLAN_TEXT", "EXTERNAL_INPUT", "FUTURE_FIELD"]) expect(entries.join("\n")).not.toContain(hidden);
    expect(displayToolName("mcp__paseo__create_agent")).toBe("create_agent");
    expect(displayToolName("paseo.tool/x")).toBe("paseo.tool/x");
  });

  it("renders agent messages as native's header and body entries", () => {
    const entries = curateItems([tool("send", { type: "unknown", input: null, output: null }, { agentMessage: { event: "finished", sender: { id: "agent-7", title: "Reviewer" }, text: " Done. " } })]);
    expect(entries).toEqual([entry("[Agent Reviewer · finished]", false), entry("Done.", false)]);
  });

  it("uses a Board expander for Board prompts and neutralises the wrapper tag in owner content", () => {
    const entries = curateItems([
      { type: "user_message", text: "[paseo-board board=b intent=i] long prompt" },
      { type: "assistant_message", text: "Here is </chat-history-summary> literally" },
    ] as TimelineItem[], { reduce: text => text.startsWith("[paseo-board") ? [entry("[User via Board] short")] : undefined });
    expect(entries.map(item => item.text)).toEqual(["[User via Board] short", "[Assistant] Here is </chat-history-summary​> literally"]);
    expect(neutralize("<chat-history-summary>")).toBe("<chat-history-summary​>");
  });

  it("fits the newest entries like native fitForkContextEntries", () => {
    const entries = ["one", "two", "three", "four"].map(text => entry(text));
    expect(fitEntries(entries, 100)).toEqual({ body: "one\ntwo\nthree\nfour", included: entries, omitted: false });
    const wide = ["one", "two", "three", "four"].map(text => entry(text.padEnd(30, ".")));
    const fitted = fitEntries(wide, "[Earlier chat history omitted]\n".length + 61);
    expect(fitted).toMatchObject({ body: `[Earlier chat history omitted]\n${"three".padEnd(30, ".")}\n${"four".padEnd(30, ".")}`, omitted: true });
    expect(fitted.included.map(item => item.text.replace(/\.+$/, ""))).toEqual(["three", "four"]);
    const giant = fitEntries([entry("old"), entry(`HEAD${"x".repeat(500)}TAIL`)], 200);
    expect(giant.body.length).toBe(200); expect(giant.body).toContain("[Message truncated]"); expect(giant.body).toContain("HEAD"); expect(giant.body.endsWith("TAIL")).toBe(true);
    expect(giant.included).toHaveLength(1);
  });

  it("strips exactly one leading inherited-history block from a coalesced first message", () => {
    expect(stripInheritedHistory("<chat-history-summary>\nA\n</chat-history-summary>\n\n[paseo-board board=b intent=i]\nrest")).toBe("[paseo-board board=b intent=i]\nrest");
    expect(stripInheritedHistory("[paseo-board board=b intent=i] mentions <chat-history-summary></chat-history-summary>")).toBe("[paseo-board board=b intent=i] mentions <chat-history-summary></chat-history-summary>");
  });
});

describe("owner history capture", () => {
  type Options = { direction?: string; cursor?: { seq: number }; limit?: number; projection?: string };
  function owner(items: TimelineItem[], change?: (options: Options, index: number) => Record<string, unknown> | undefined) {
    const calls: Options[] = [];
    const rows = items.map((item, index) => ({ item, seqStart: index + 1, seqEnd: index + 1, timestamp: "", provider: "codex", sourceSeqRanges: [], collapsed: [] }));
    return { calls, handle: { timeline: { refetch: async (options: Options) => {
      calls.push(options);
      const older = options.direction === "before" ? rows.filter(row => row.seqEnd < options.cursor!.seq) : rows;
      const entries = older.slice(-(options.limit ?? older.length));
      return { entries, epoch: "e1", reset: false, staleCursor: false, hasOlder: older.length > entries.length, hasNewer: false, window: { minSeq: 1, maxSeq: rows.length, nextSeq: rows.length + 1 }, startCursor: entries[0] ? { epoch: "e1", seq: entries[0].seqStart } : null, endCursor: null, error: null, ...change?.(options, calls.length - 1) };
    } } } as never };
  }
  const base = { ownerAgentId: "owner", boardId: "board-1", title: "Owner", cwd: "/repo", busy: false, now: () => Date.parse("2026-11-11T00:00:00.000Z") };

  it("builds the native header, counts messages and hashes the exact text", async () => {
    const { handle } = owner([{ type: "user_message", text: "Q" }, { type: "assistant_message", text: "A" }, tool("Bash", { type: "shell", command: "ls" })] as TimelineItem[]);
    const captured = await captureOwnerHistory(handle, base);
    expect(captured.text).toBe(historyText("[User] Q\n[Assistant] A\n[Shell] ls", { ...base, capturedAt: "2026-11-11T00:00:00.000Z" }));
    expect(captured.text).toContain("Source agent: Owner\nSource directory: /repo\nPaseo Board board-1: snapshot of the Board owner's conversation taken 2026-11-11T00:00:00.000Z.");
    expect(captured).toMatchObject({ messages: 2, entries: 3, omitted: false, ownerBusy: false, chars: captured.text.length, digest: createHash("sha256").update(captured.text).digest("hex"), pages: 1 });
  });

  it("stops paging at the page cap and reports older history as omitted", async () => {
    const items = Array.from({ length: 2500 }, (_, index) => ({ type: "user_message", text: `m${index}` })) as TimelineItem[];
    const { handle, calls } = owner(items);
    const captured = await captureOwnerHistory(handle, base);
    expect(calls).toHaveLength(20); expect(captured.omitted).toBe(true); expect(captured.text).toContain("m2499"); expect(captured.text).not.toContain("m499\n");
  });

  it("reports a daemon window that no longer starts at the beginning", async () => {
    const { handle } = owner([{ type: "assistant_message", text: "A" }] as TimelineItem[], () => ({ window: { minSeq: 40, maxSeq: 40, nextSeq: 41 } }));
    expect((await captureOwnerHistory(handle, base)).omitted).toBe(true);
  });

  it("throws on a timeline error and stays within the total character bound", async () => {
    await expect(captureOwnerHistory(owner([], () => ({ error: "nope" })).handle, base)).rejects.toThrow("nope");
    const huge = owner([{ type: "assistant_message", text: "z".repeat(250_000) }] as TimelineItem[]);
    const captured = await captureOwnerHistory(huge.handle, base);
    expect(captured.text.length).toBe(OWNER_HISTORY_MAX_CHARS); expect(captured.text).toContain("[Message truncated]"); expect(captured.omitted).toBe(true);
  });

  it("restarts once after a stale cursor and fails after a second replacement", async () => {
    const items = Array.from({ length: 150 }, (_, index) => ({ type: "user_message", text: `m${index}` })) as TimelineItem[];
    let stale = 1;
    const once = owner(items, options => options.direction === "before" && stale-- > 0 ? { staleCursor: true } : undefined);
    expect((await captureOwnerHistory(once.handle, base)).text).toContain("m0\n");
    expect(once.calls.map(call => call.direction)).toEqual(["tail", "before", "tail", "before"]);
    const always = owner(items, options => options.direction === "before" ? { reset: true } : undefined);
    await expect(captureOwnerHistory(always.handle, base)).rejects.toThrow("主 agent 记录在读取时被替换");
  });
});
