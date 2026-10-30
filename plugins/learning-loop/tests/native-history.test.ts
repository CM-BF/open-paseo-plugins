import { mkdtemp, mkdir, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeHistorySource, NATIVE_HISTORY_LIMITS } from "../server/sessions/native-history";
import { toIndexed } from "../server/sessions/transcript";

// Any accidental provider/CLI fallback turns the file-only tests into hard failures.
vi.mock("node:child_process", () => ({ spawn: () => { throw new Error("provider spawn forbidden"); }, exec: () => { throw new Error("provider exec forbidden"); }, execFile: () => { throw new Error("provider execFile forbidden"); } }));
vi.mock("@getpaseo/plugin", () => { throw new Error("daemon SDK forbidden in native history"); });

const sessionId = "01a188ff-3c34-77c1-8ae4-f45557210db6";
const at = "2026-10-29T12:00:00Z";
let dir: string;
let paseoHome: string;
let codexHome: string;
let claudeHome: string;
let source: NativeHistorySource;

async function put(file: string, text: string): Promise<void> { await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, text); }
function lines(...values: unknown[]): string { return values.map(value => JSON.stringify(value)).join("\n") + "\n"; }
function message(role: string, text: string) { return { type: "response_item", timestamp: at, payload: { type: "message", role, content: [{ type: "input_text", text }] } }; }
function codexText(...values: unknown[]): string { return lines({ type: "session_meta", payload: { id: sessionId } }, ...values); }
async function record(provider = "codex", id = "a1", session = sessionId, extra: Record<string, unknown> = {}) {
  await put(join(paseoHome, "agents", "project", `${id}.json`), JSON.stringify({ id, provider, cwd: "/repo", persistence: { provider, sessionId: session }, ...extra }));
}
function rollout(root = codexHome, archived = false): string { return archived ? join(root, "archived_sessions", `rollout-2026-10-29T12-00-00-${sessionId}.jsonl`) : join(root, "sessions", "2026", "10", "29", `rollout-2026-10-29T12-00-00-${sessionId}.jsonl`); }
function claudeFile(root = claudeHome): string { return join(root, "projects", "-repo", `${sessionId}.jsonl`); }
const fetchAll = () => source.fetch("a1", { direction: "after", limit: NATIVE_HISTORY_LIMITS.entries });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ll-native-history-"));
  paseoHome = join(dir, "paseo"); codexHome = join(dir, "codex"); claudeHome = join(dir, "claude");
  source = new NativeHistorySource({ paseoHome, codexHome, claudeHome });
});
afterEach(async () => { source.close(); await rm(dir, { recursive: true, force: true }); });

describe("NativeHistorySource", () => {
  it("reads Codex current and archived transcripts without duplicate event messages or tool output", async () => {
    await record();
    await put(rollout(codexHome, true), codexText(
      message("user", "查找旧的部署记录"), message("assistant", "Use the deployment command"),
      message("system", "hidden system instruction"),
      { type: "event_msg", payload: { type: "user_message", message: "查找旧的部署记录" } },
      { type: "response_item", timestamp: at, payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"npm test"}', call_id: "c1" } },
      { type: "response_item", payload: { type: "function_call_output", output: "SECRET TOOL OUTPUT", call_id: "c1" } },
      { type: "response_item", timestamp: at, payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Add File: a.txt", call_id: "c2" } },
      { type: "response_item", payload: { type: "reasoning", text: "private reasoning" } },
    ));
    const page = await fetchAll();
    expect(page.error).toBeNull();
    expect(page.epoch).toMatch(/^native-v1:/);
    const indexed = page.entries.map(toIndexed);
    expect(indexed.map(e => e?.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(indexed[2]?.text).toContain("npm test");
    expect(JSON.stringify(indexed)).not.toMatch(/SECRET|hidden system|private reasoning/);
    source.release("a1");
    await put(rollout(), codexText(message("user", "current transcript takes precedence")));
    source.close(); source = new NativeHistorySource({ paseoHome, codexHome });
    expect((await fetchAll()).entries.map(toIndexed)[0]?.text).toBe("current transcript takes precedence");
  });

  it("reads Claude text and tool_use while filtering tool results, thinking, meta and synthetic rows", async () => {
    await record("claude");
    await put(claudeFile(), lines(
      { type: "user", sessionId, timestamp: at, message: { content: "Please fix this" } },
      { type: "assistant", sessionId, timestamp: at, message: { content: [{ type: "text", text: "I will inspect it" }, { type: "thinking", thinking: "private" }, { type: "tool_use", name: "Read", id: "t1", input: { file_path: "src/main.ts" } }] } },
      { type: "user", sessionId, message: { content: [{ type: "tool_result", content: "PRIVATE OUTPUT", tool_use_id: "t1" }] } },
      { type: "user", isMeta: true, message: { content: "meta instruction" } },
      { type: "user", isSynthetic: true, message: { content: "synthetic instruction" } },
      { type: "user", isCompactSummary: true, message: { content: "compact summary" } },
      { type: "system", content: "system instruction" },
    ));
    const page = await fetchAll();
    expect(page.error).toBeNull();
    expect(page.entries.map(toIndexed).map(e => e?.role)).toEqual(["user", "assistant", "tool"]);
    expect(page.entries.map(toIndexed)[2]?.text).toContain("src/main.ts");
  });

  it("excludes Codex assistant analysis channels while retaining visible and legacy messages", async () => {
    await record();
    const assistant = (channel: string | null, text: string) => ({ type: "response_item", timestamp: at, payload: { type: "message", role: "assistant", channel, content: [{ type: "output_text", text }] } });
    await put(rollout(), codexText(
      assistant("analysis", "INTERNAL REASONING MUST NOT BE INDEXED"),
      assistant("confidence", "OTHER INTERNAL CHANNEL"),
      assistant("commentary", "Visible progress"),
      assistant("final", "Visible answer"),
      assistant(null, "Legacy visible answer"),
      message("assistant", "Older answer without a channel"),
    ));
    const page = await fetchAll();
    expect(page.error).toBeNull();
    expect(page.entries.map(toIndexed).map(entry => entry?.text)).toEqual(["Visible progress", "Visible answer", "Legacy visible answer", "Older answer without a channel"]);
  });

  it("resolves custom provider inheritance and native home without a daemon request", async () => {
    const customRoot = join(dir, "custom-codex");
    await record("work-codex");
    await put(join(paseoHome, "config.json"), JSON.stringify({ agents: { providers: { "work-codex": { extends: "team-codex" }, "team-codex": { extends: "codex", env: { CODEX_HOME: customRoot } } } } }));
    await put(rollout(customRoot), codexText(message("user", "custom profile history")));
    expect((await fetchAll()).entries.map(toIndexed)[0]?.text).toBe("custom profile history");
  });

  it("uses a bounded frozen view through pagination, then detects appends and file replacement after release", async () => {
    await record();
    await put(rollout(), codexText(message("user", "first"), message("assistant", "second")));
    const first = await source.fetch("a1", { direction: "after", limit: 1 });
    expect(first.hasNewer).toBe(true);
    await put(rollout(), codexText(message("user", "first"), message("assistant", "second"), message("user", "third")));
    const second = await source.fetch("a1", { direction: "after", cursor: first.endCursor!, limit: 1 });
    expect(second.epoch).toBe(first.epoch);
    expect(second.hasNewer).toBe(false);
    source.release("a1");
    const appended = await source.fetch("a1", { direction: "after", cursor: second.endCursor!, limit: 10 });
    expect(appended.reset).toBe(true);
    expect(appended.entries).toHaveLength(3);
    source.release("a1");
    await put(rollout() + ".new", codexText(message("user", "replacement")));
    await rename(rollout() + ".new", rollout());
    const replaced = await source.fetch("a1", { direction: "after", cursor: appended.endCursor!, limit: 10 });
    expect(replaced.reset).toBe(true);
    expect(replaced.epoch).not.toBe(appended.epoch);
    expect(replaced.entries).toHaveLength(1);
  });

  it("returns errors for missing records, unsupported providers and missing transcripts", async () => {
    expect((await fetchAll()).error).toMatch(/record.*not found/);
    await record("opencode");
    expect((await fetchAll()).error).toMatch(/unsupported/);
    await record("codex");
    expect((await fetchAll()).error).toMatch(/not found/);
  });

  it("does not publish partial pages for corrupt or unfinished JSONL", async () => {
    await record();
    await put(rollout(), codexText(message("user", "valid first row")) + '{"bad":\n');
    const corrupt = await fetchAll();
    expect(corrupt.error).toMatch(/invalid JSON/);
    expect(corrupt.entries).toHaveLength(0);
    await put(rollout(), codexText(message("user", "valid first row")) + '{"unfinished":');
    expect((await fetchAll()).error).toMatch(/incomplete final/);
    await put(rollout(), codexText(message("user", "valid first row")).trimEnd());
    expect((await fetchAll()).error).toBeNull();
  });

  it("rejects oversized lines, files, total text and entry counts without truncation", async () => {
    await record();
    await put(rollout(), "x".repeat(NATIVE_HISTORY_LIMITS.lineBytes + 1));
    expect((await fetchAll()).error).toMatch(/line exceeds/);
    await truncate(rollout(), NATIVE_HISTORY_LIMITS.fileBytes + 1);
    expect((await fetchAll()).error).toMatch(/file exceeds/);
    await put(rollout(), codexText(...Array.from({ length: 6 }, () => message("user", "a".repeat(6 * 1024 * 1024)))));
    expect((await fetchAll()).error).toMatch(/resource limit/);
    await put(rollout(), codexText(...Array.from({ length: NATIVE_HISTORY_LIMITS.entries + 1 }, () => message("user", "a"))));
    const tooMany = await fetchAll();
    expect(tooMany.error).toMatch(/resource limit/);
    expect(tooMany.entries).toHaveLength(0);
  });

  it("rejects unsafe ids, mismatched transcript identities and symlink escapes", async () => {
    expect((await source.fetch("../a1", { direction: "tail", limit: 1 })).error).toMatch(/Invalid agent id/);
    await record("claude", "a1", "../outside");
    expect((await fetchAll()).error).toMatch(/session id/);
    await record();
    await put(rollout(), lines({ type: "session_meta", payload: { id: "another-session" } }, message("user", "wrong identity")));
    expect((await fetchAll()).error).toMatch(/identity/);
    await rm(rollout());
    const outside = join(dir, "outside.jsonl");
    await put(outside, codexText(message("user", "not a source")));
    await symlink(outside, rollout());
    const linked = await fetchAll();
    expect(linked.error).not.toBeNull();
    expect(linked.entries).toHaveLength(0);
  });

  it("releases one session before retaining the next and honors cancellation/close", async () => {
    await record();
    await put(rollout(), codexText(message("user", "readable")));
    expect((await fetchAll()).error).toBeNull();
    source.release("a1");
    await rm(rollout());
    expect((await fetchAll()).error).not.toBeNull();
    const abort = new AbortController();
    abort.abort();
    const canceled = new NativeHistorySource({ paseoHome, codexHome, signal: abort.signal });
    expect((await canceled.fetch("a1", { direction: "tail", limit: 1 })).error).toMatch(/canceled/);
    source.close();
    expect((await fetchAll()).error).toMatch(/canceled/);
  });

  it("does not retain the previous session snapshot after reading a different agent", async () => {
    await record();
    await put(rollout(), codexText(message("user", "first agent")));
    expect((await fetchAll()).error).toBeNull();
    await record("claude", "a2");
    await put(claudeFile(), lines({ type: "user", sessionId, message: { content: "second agent" } }));
    await rm(rollout());
    expect((await source.fetch("a2", { direction: "tail", limit: 1 })).error).toBeNull();
    expect((await fetchAll()).error).not.toBeNull();
    source.release();
    await rm(claudeFile());
    expect((await source.fetch("a2", { direction: "tail", limit: 1 })).error).not.toBeNull();
  });

  it("has no executable SDK or process imports", async () => {
    const code = await readFile(new URL("../server/sessions/native-history.ts", import.meta.url), "utf8");
    expect(code).not.toMatch(/(?:from|import\()\s*["'](?:node:)?child_process/);
    expect(code).not.toMatch(/from\s*["']@getpaseo\/(?:plugin|server)/);
  });
});
