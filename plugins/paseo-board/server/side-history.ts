import { createHash } from "node:crypto";
import type { Agent, Cursor, TimelineEntry } from "./sdk";
import type { HistorySnapshot } from "./journal";

/**
 * Owner history for a new Side, curated like Paseo's native fork context
 * (activity-curator buildAgentForkContextAttachment) using only the public
 * plugin SDK: projected timeline pages in, one bounded chat_history text out.
 * Deliberate differences are documented in DESIGN-FORK.md (AMENDMENTS A3/A4/A18): unlike native, each
 * tool call also carries a short excerpt of its own output, inside the same overall budget.
 */
export const OWNER_HISTORY_MAX_CHARS = 100_000; // native MAX_FORK_CONTEXT_CHARS
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const MAX_RECEIVED_CHARS = 8_000_000;
const MAX_CAPTURE_MS = 8_000;
const MAX_TOOL_SUMMARY_CHARS = 200;
/**
 * Per tool call: the whole rendered excerpt block under the call (`  Label: ` plus the head and tail around a
 * marker, every line indented) never exceeds this.
 */
export const MAX_TOOL_OUTPUT_CHARS = 600;
/** Each excerpt line is indented by this under its call. */
const OUTPUT_INDENT = "  ";
const MAX_METADATA_CHARS = 1_000;
const OMITTED = "[Earlier chat history omitted]\n";
const TRUNCATED = "\n[Message truncated]\n";
export const EMPTY_HISTORY = "No chat history to display.";

export type TimelineItem = TimelineEntry["item"];
type ToolCallItem = Extract<TimelineItem, { type: "tool_call" }>;
/**
 * One curated line (or block). `message` marks user/assistant content counted in provenance;
 * `output` marks a tool call that carries an excerpt of its output.
 */
export interface CuratedEntry { text: string; message: boolean; output?: boolean }
/** Expands owner messages that are Board prompts into the user's own words plus the Board's answer. */
export interface BoardPromptExpander {
  /** Loads what reduce() needs for these items (for example the Board's recorded answers). */
  prepare(items: readonly TimelineItem[]): Promise<void>;
  /** Undefined keeps the generic `[User]` rendering. */
  reduce(text: string): CuratedEntry[] | undefined;
}
export type CapturedHistory = HistorySnapshot & { text: string; durationMs: number; pages: number };

const BOARD_MARKER = /^\[paseo-board board=([a-zA-Z0-9_.:-]+) intent=([a-zA-Z0-9_.:-]+)\]/;
/** The marker every Board prompt starts with. */
export function parseBoardMarker(text: string): { boardId: string; intentId: string } | undefined {
  const match = BOARD_MARKER.exec(text);
  return match ? { boardId: match[1], intentId: match[2] } : undefined;
}
/**
 * A provider that re-reads its history can coalesce the chat_history attachment and the prompt
 * into one user message. The plugin wrote that block itself, so removing one leading block is exact.
 */
export function stripInheritedHistory(text: string): string {
  return text.startsWith("<chat-history-summary>") ? text.replace(/^<chat-history-summary>[^]*?<\/chat-history-summary>\s*/, "") : text;
}
/** Owner content may mention the wrapper tag; it must not end the attachment early. */
export function neutralize(text: string): string {
  return text.replace(/<(\/?)chat-history-summary>/g, "<$1chat-history-summary​>");
}
export function clip(value: string | undefined, max: number): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
/** Native humanized names, except MCP names show the tool itself (`mcp__paseo_board__board_publish` → `board_publish`). */
export function displayToolName(name: string): string {
  const trimmed = name.trim();
  const mcp = /^mcp__.+?__(.+)$/.exec(trimmed);
  if (mcp) return mcp[1];
  if (!trimmed) return "Tool";
  if (/[:./]/.test(trimmed) || trimmed.includes("__")) return trimmed;
  return trimmed.replace(/[._-]+/g, " ").split(" ").filter(Boolean).join(" ").toLowerCase().replace(/^./, character => character.toUpperCase());
}
const BINARY_OMITTED = "[binary data omitted]";
const IMAGE_OMITTED = "[image omitted]";
const nonEmpty = (value: unknown) => typeof value === "string" && value ? value : undefined;
// Base64 needs all three character classes; a long run of only letters or digits is ordinary text.
const looksEncoded = (run: string) => /[0-9]/.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run);
/** A JSON string value that is a data URL or an encoded blob; replaced as a whole before stringifying. */
const encodedValue = (value: string) => /^data:[^,]{1,100};base64,/.test(value) || (value.length >= 200 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(value) && looksEncoded(value));
/** Readable text of a tool result value: MCP content blocks keep their text, images and blobs become short markers. */
function outputValueText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const blocks = Array.isArray(value) ? value : typeof value === "object" && Array.isArray((value as { content?: unknown }).content) ? (value as { content: unknown[] }).content : undefined;
  if (blocks?.length && blocks.every(block => typeof block === "object" && block !== null && typeof (block as { type?: unknown }).type === "string")) {
    return blocks.map(raw => {
      const block = raw as { type: string; text?: unknown; resource?: { text?: unknown; uri?: unknown }; uri?: unknown; name?: unknown };
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (block.type === "image") return IMAGE_OMITTED;
      if (block.type === "resource") return nonEmpty(block.resource?.text) ?? BINARY_OMITTED;
      if (block.type === "resource_link") return [nonEmpty(block.name), nonEmpty(block.uri)].filter(Boolean).join(" ");
      if (block.type === "audio") return BINARY_OMITTED;
      return jsonText(block);
    }).filter(Boolean).join("\n");
  }
  return jsonText(value);
}
function jsonText(value: unknown): string | undefined {
  try { return JSON.stringify(value, (_key, child: unknown) => typeof child === "string" && encodedValue(child) ? BINARY_OMITTED : child); }
  catch { return undefined; }
}
/**
 * Every ECMA-48 escape sequence, in this order: control strings (OSC, DCS, SOS, PM, APC) with their payload up
 * to BEL or ST; CSI; then any other ESC + intermediate bytes (0x20-0x2F) + final byte (0x30-0x7E), which covers
 * charset designations such as ESC ( B or ESC ) 0, DEC private (ESC 7, ESC =), 7-bit C1 (ESC M) and ESC c.
 * SO/SI charset shifts and a stray ESC go too. None of them is readable text, so none may count as binary.
 */
export function stripTerminalEscapes(raw: string): string {
  return raw
    .replace(/\u001B[\]PX^_][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[ -/]*[0-~]/g, "")
    .replace(/[\u000E\u000F\u001B]/g, "");
}
/**
 * Terminal escapes, carriage-return redraws, binary bytes and encoded blobs removed; blank-line runs collapsed.
 * Returns undefined when nothing readable is left.
 */
export function sanitizeOutput(raw: string): string | undefined {
  const text = stripTerminalEscapes(raw);
  // Binary output (NUL bytes, many control or replacement characters) has no readable excerpt.
  const controls = text.match(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g)?.length ?? 0;
  if (text.includes("\u0000") || controls > Math.max(4, text.length * 0.02)) return BINARY_OMITTED;
  const lines = text.replace(/\r\n/g, "\n").split("\n").map(line => (line.split("\r").filter(Boolean).pop() ?? "").trimEnd());
  const cleaned = lines.join("\n")
    .replace(/data:[^,\s]{1,100};base64,[A-Za-z0-9+/=]*/g, BINARY_OMITTED)
    // MIME-wrapped base64 (several full-width lines) and long single-line runs. Anchored to line starts, so
    // a huge single-line output is scanned once instead of being retried from every position.
    .replace(/^(?:[A-Za-z0-9+/]{60,}={0,2}\n){2,}(?:[A-Za-z0-9+/]+={0,2}$)?/gm, run => looksEncoded(run) ? BINARY_OMITTED + (run.endsWith("\n") ? "\n" : "") : run)
    .replace(/[A-Za-z0-9+/_-]{200,}={0,2}/g, run => looksEncoded(run) ? BINARY_OMITTED : run)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || undefined;
}
const outputMarker = (omitted: number) => `\n[… ${omitted} characters of output omitted …]\n`;
const isHighSurrogate = (code: number) => code >= 0xD800 && code <= 0xDBFF;
const isLowSurrogate = (code: number) => code >= 0xDC00 && code <= 0xDFFF;
/**
 * Head and tail around a marker naming exactly how many characters of `text` were left out. The result,
 * rendered with `indent` characters after every line break (the marker's two included), is at most `max`
 * characters; head and tail get about half each. A surrogate pair is never split.
 */
export function excerptOutput(text: string, max = MAX_TOOL_OUTPUT_CHARS, indent = 0): string {
  const weight = (index: number) => text.charCodeAt(index) === 10 ? 1 + indent : 1;
  let whole = 0;
  for (let index = 0; index < text.length; index++) whole += weight(index);
  if (whole <= max) return text;
  // Budget the marker with the largest count it can show; the real count is never longer, so the result stays within max.
  let marker = outputMarker(text.length), head = 0, tail = 0;
  for (let pass = 0; pass < 2; pass++) {
    const available = Math.max(0, max - marker.length - 2 * indent);
    let used = 0;
    for (head = 0; head < text.length && used + weight(head) <= Math.ceil(available / 2); head++) used += weight(head);
    if (head > 0 && isHighSurrogate(text.charCodeAt(head - 1))) { head--; used -= weight(head); }
    const room = available - used;
    used = 0;
    for (tail = 0; tail < text.length - head && used + weight(text.length - 1 - tail) <= room; tail++) used += weight(text.length - 1 - tail);
    if (tail > 0 && isLowSurrogate(text.charCodeAt(text.length - tail))) tail--;
    marker = outputMarker(text.length - head - tail);
  }
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}
/** `  Label: excerpt`, every further line indented, so an output line can never pass for an `[User]` or `[Assistant]` entry. */
function outputBlock(label: string, text: string): string {
  const prefix = `${OUTPUT_INDENT}${label}: `;
  const excerpt = excerptOutput(text, MAX_TOOL_OUTPUT_CHARS - prefix.length, OUTPUT_INDENT.length);
  return prefix + excerpt.replace(/\n/g, `\n${OUTPUT_INDENT}`);
}
/**
 * The tool call's own result, never its input: edit/write bodies and plans are input, and plain_text
 * may carry the agent's thinking, so those have none. Failed calls show their error first.
 */
function toolOutput(item: ToolCallItem): string | undefined {
  const detail = item.detail as { type: string; [key: string]: unknown };
  let raw: unknown;
  switch (detail.type) {
    case "shell": raw = detail.output; break;
    case "read": raw = detail.content; break;
    case "search": {
      const paths = Array.isArray(detail.filePaths) ? detail.filePaths.filter(path => typeof path === "string") : [];
      const web = Array.isArray(detail.webResults) ? (detail.webResults as Array<{ title?: unknown; url?: unknown }>).map(result => [nonEmpty(result?.title), nonEmpty(result?.url)].filter(Boolean).join(" — ")).filter(Boolean) : [];
      raw = nonEmpty(detail.content) ?? (paths.length ? paths.join("\n") : web.length ? web.join("\n") : undefined);
      break;
    }
    case "fetch": raw = detail.result; break;
    case "worktree_setup": raw = detail.log; break;
    case "sub_agent": raw = detail.log; break;
    case "unknown": raw = detail.output; break;
    default: raw = undefined;
  }
  const failed = item.status === "failed";
  const parts = [failed ? outputValueText(typeof item.error === "object" && item.error !== null && typeof (item.error as { message?: unknown }).message === "string" ? (item.error as { message: string }).message : item.error) : undefined, outputValueText(raw)]
    .map(part => part === undefined ? undefined : sanitizeOutput(part)).filter((part): part is string => Boolean(part));
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  if (!unique.length) return undefined;
  const exit = detail.type === "shell" && typeof detail.exitCode === "number" && detail.exitCode !== 0 ? ` (exit ${detail.exitCode})` : "";
  const label = failed ? `Error${exit}` : item.status === "running" ? `Output so far${exit}` : item.status === "canceled" ? "Output (canceled)" : `Output${exit}`;
  return outputBlock(label, unique.join("\n"));
}
function toolEntries(item: ToolCallItem): CuratedEntry[] {
  if (item.agentMessage) {
    const message = item.agentMessage, body = message.text.trim();
    return [{ text: `[Agent ${message.sender.title || message.sender.id} · ${message.event}]`, message: false }, ...(body ? [{ text: body, message: false }] : [])];
  }
  // The summary comes from the canonical detail only (never external tool input); the output excerpt is the call's own result.
  const detail = item.detail as { type: string; [key: string]: unknown };
  const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
  let display: { name?: string; summary?: string } = {};
  switch (detail.type) {
    case "shell": display = { name: "Shell", summary: text(detail.command) }; break;
    case "read": display = { name: "Read", summary: text(detail.filePath) }; break;
    case "edit": display = { name: "Edit", summary: text(detail.filePath) }; break;
    case "write": display = { name: "Write", summary: text(detail.filePath) }; break;
    case "search": display = { name: "Search", summary: text(detail.query) }; break;
    case "fetch": display = { name: "Fetch", summary: text(detail.url) }; break;
    case "worktree_setup": display = { name: "Worktree setup", summary: text(detail.branchName) }; break;
    case "sub_agent": display = { name: text(detail.subAgentType) ?? "Task", summary: text(detail.description) }; break;
    case "plain_text": display = { summary: text(detail.label) }; break;
    case "plan": display = { name: "Plan" }; break;
    default: break; // unknown and future detail types: name only
  }
  const name = display.name ?? displayToolName(item.name);
  const summary = clip(display.summary, MAX_TOOL_SUMMARY_CHARS);
  const header = summary ? `[${name}] ${summary}` : `[${name}]`;
  const output = toolOutput(item);
  if (!output) return [{ text: header, message: false }];
  // The excerpt block stays in the same entry as its call, so fitting keeps or drops both.
  return [{ text: `${header}\n${output}`, message: false, output: true }];
}
/** Keeps user and assistant messages and tool calls; drops reasoning, todo, errors, notifications, compaction and plugin rows. */
export function curateItems(items: readonly TimelineItem[], expander?: Pick<BoardPromptExpander, "reduce">): CuratedEntry[] {
  const entries: CuratedEntry[] = [];
  for (const item of items) {
    if (item.type === "user_message") {
      const reduced = expander?.reduce(item.text);
      if (reduced) entries.push(...reduced);
      else if (item.text.trim()) entries.push({ text: `[User] ${item.text.trim()}`, message: true });
    } else if (item.type === "assistant_message") {
      if (item.text.trim()) entries.push({ text: `[Assistant] ${item.text.trim()}`, message: true });
    } else if (item.type === "tool_call") entries.push(...toolEntries(item));
  }
  return entries.map(entry => ({ ...entry, text: neutralize(entry.text) }));
}
/**
 * Port of native fitForkContextEntries: newest first within the budget, an omission marker, head+tail for one giant entry.
 * `olderOmitted` means rows before `entries` were never read (paging guards or a daemon window gap): the text
 * then always starts with the omission marker, even when everything that was read fits.
 */
export function fitEntries(entries: readonly CuratedEntry[], budget: number, olderOmitted = false): { body: string; included: CuratedEntry[]; omitted: boolean } {
  const length = entries.reduce((total, entry) => total + entry.text.length + 1, -1);
  if (!olderOmitted && length <= budget) return { body: entries.map(entry => entry.text).join("\n"), included: [...entries], omitted: false };
  const selected: CuratedEntry[] = [];
  let remaining = budget - OMITTED.length;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const size = entry.text.length + (selected.length > 0 ? 1 : 0);
    if (size > remaining) {
      if (selected.length === 0) {
        const available = Math.max(0, remaining - TRUNCATED.length), head = Math.ceil(available / 2);
        selected.push({ ...entry, text: entry.text.slice(0, head) + TRUNCATED + entry.text.slice(entry.text.length - (available - head)) });
      }
      break;
    }
    selected.push(entry);
    remaining -= size;
  }
  const included = selected.reverse();
  return { body: included.length ? OMITTED + included.map(entry => entry.text).join("\n") : OMITTED.trimEnd(), included, omitted: true };
}
interface HistoryMeta { title?: string | null; cwd?: string | null; boardId: string; capturedAt: string; busy: boolean }
const metadata = (value: string | null | undefined) => neutralize(value?.trim() ?? "").slice(0, MAX_METADATA_CHARS);
export function historyText(body: string, meta: HistoryMeta): string {
  const header = ["Chat history from a previous Paseo agent."];
  if (metadata(meta.title)) header.push(`Source agent: ${metadata(meta.title)}`);
  if (metadata(meta.cwd)) header.push(`Source directory: ${metadata(meta.cwd)}`);
  header.push(`Paseo Board ${meta.boardId}: snapshot of the Board owner's conversation taken ${meta.capturedAt}${meta.busy ? "; the owner was mid-turn, so its latest turn may be incomplete" : ""}.`);
  return `<chat-history-summary>\n${header.join("\n")}\n\n${body}\n</chat-history-summary>`;
}
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** Native transport: the daemon puts chat_history attachments before the prompt; the user message text stays the prompt. */
export function chatHistoryAttachment(text: string) {
  return { type: "text" as const, mimeType: "text/plain" as const, contextKind: "chat_history", title: "Chat history", text };
}

class TimelineReplaced extends Error {}
export interface CaptureOptions {
  ownerAgentId: string; boardId: string; title?: string | null; cwd?: string | null; busy: boolean;
  expander?: BoardPromptExpander;
  now?: () => number;
}
/**
 * Reads the owner's projected timeline newest-first, bounded by pages, received bytes, time and the
 * curated budget. A replacement while paging restarts once from a fresh tail; a second one fails.
 */
export async function captureOwnerHistory(owner: Pick<Agent, "timeline">, options: CaptureOptions): Promise<CapturedHistory> {
  try { return await captureOnce(owner, options); }
  catch (error) {
    if (!(error instanceof TimelineReplaced)) throw error;
    return captureOnce(owner, options);
  }
}
async function captureOnce(owner: Pick<Agent, "timeline">, options: CaptureOptions): Promise<CapturedHistory> {
  const now = options.now ?? Date.now, started = now();
  const meta: HistoryMeta = { title: options.title, cwd: options.cwd, boardId: options.boardId, capturedAt: new Date(started).toISOString(), busy: options.busy };
  const budget = OWNER_HISTORY_MAX_CHARS - historyText("", meta).length;
  const chunks: CuratedEntry[][] = [];
  let epoch: string | undefined, cursor: Cursor | undefined, received = 0, curated = 0, pages = 0, older = false, gap = false;
  for (;;) {
    const page = await owner.timeline.refetch(pages === 0
      ? { direction: "tail", limit: PAGE_LIMIT, projection: "projected" }
      : { direction: "before", cursor, limit: PAGE_LIMIT, projection: "projected" });
    if (page.error) throw new Error(page.error);
    if (pages === 0) epoch = page.epoch;
    else if (page.reset || page.staleCursor || page.epoch !== epoch) throw new TimelineReplaced("主 agent 记录在读取时被替换");
    pages++;
    received += JSON.stringify(page.entries).length;
    const items = page.entries.map(entry => entry.item);
    await options.expander?.prepare(items);
    const entries = curateItems(items, options.expander);
    chunks.push(entries);
    curated += entries.reduce((total, entry) => total + entry.text.length + 1, 0);
    older = Boolean(page.hasOlder && page.startCursor);
    // The daemon may no longer hold the earliest rows of this timeline.
    gap = !older && (page.window?.minSeq ?? 1) > 1;
    if (!older || curated > budget || pages >= MAX_PAGES || received > MAX_RECEIVED_CHARS || now() - started > MAX_CAPTURE_MS) break;
    cursor = page.startCursor ?? undefined;
  }
  const entries = chunks.reverse().flat();
  // Older rows that were never read are omitted history too: the Side must see the marker, not a history that looks complete.
  const fitted = entries.length || older || gap ? fitEntries(entries, budget, older || gap) : undefined;
  const text = historyText(fitted ? fitted.body : EMPTY_HISTORY, meta);
  return {
    sourceAgentId: options.ownerAgentId, capturedAt: meta.capturedAt,
    messages: fitted?.included.filter(entry => entry.message).length ?? 0, entries: fitted?.included.length ?? 0,
    toolOutputs: fitted?.included.filter(entry => entry.output).length ?? 0,
    omitted: older || gap || Boolean(fitted?.omitted), ownerBusy: options.busy,
    chars: text.length, digest: sha256(text), text, durationMs: now() - started, pages,
  };
}
