import { createHash } from "node:crypto";
import type { Agent, Cursor, TimelineEntry } from "./sdk";
import type { HistorySnapshot } from "./journal";

/**
 * Owner history for a new Side, curated like Paseo's native fork context
 * (activity-curator buildAgentForkContextAttachment) using only the public
 * plugin SDK: projected timeline pages in, one bounded chat_history text out.
 * Deliberate differences are documented in DESIGN-FORK.md (AMENDMENTS A3/A4).
 */
export const OWNER_HISTORY_MAX_CHARS = 100_000; // native MAX_FORK_CONTEXT_CHARS
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const MAX_RECEIVED_CHARS = 8_000_000;
const MAX_CAPTURE_MS = 8_000;
const MAX_TOOL_SUMMARY_CHARS = 200;
const MAX_METADATA_CHARS = 1_000;
const OMITTED = "[Earlier chat history omitted]\n";
const TRUNCATED = "\n[Message truncated]\n";
export const EMPTY_HISTORY = "No chat history to display.";

export type TimelineItem = TimelineEntry["item"];
type ToolCallItem = Extract<TimelineItem, { type: "tool_call" }>;
/** One curated line (or block). `message` marks user/assistant content counted in provenance. */
export interface CuratedEntry { text: string; message: boolean }
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
function toolEntries(item: ToolCallItem): CuratedEntry[] {
  if (item.agentMessage) {
    const message = item.agentMessage, body = message.text.trim();
    return [{ text: `[Agent ${message.sender.title || message.sender.id} · ${message.event}]`, message: false }, ...(body ? [{ text: body, message: false }] : [])];
  }
  // Summaries come from the canonical detail only; outputs, contents, diffs and external tool input never do.
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
  return [{ text: summary ? `[${name}] ${summary}` : `[${name}]`, message: false }];
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
    omitted: older || gap || Boolean(fitted?.omitted), ownerBusy: options.busy,
    chars: text.length, digest: sha256(text), text, durationMs: now() - started, pages,
  };
}
