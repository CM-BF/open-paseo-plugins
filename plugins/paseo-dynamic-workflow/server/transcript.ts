import type { TranscriptEntry } from "../shared/contracts";
import { truncate } from "./util";

const MAX_ENTRIES = 80;
const MAX_TEXT = 1500;

interface Item {
  type: string;
  text?: string;
  message?: string;
  name?: string;
  status?: string;
  detail?: Record<string, unknown>;
  /** Set on a tool row that carries a prompt from another agent (how a child's task arrives). */
  agentMessage?: { text?: string } | null;
}

/** A child agent's timeline as short lines: prompts, replies, and one line per tool call. */
export function transcriptEntries(items: readonly Item[]): { entries: TranscriptEntry[]; truncated: boolean } {
  const entries: TranscriptEntry[] = [];
  for (const item of items) {
    if (item.type === "user_message" && item.text) {
      entries.push({ kind: "user", text: truncate(item.text, MAX_TEXT), status: null });
    } else if (item.type === "assistant_message" && item.text) {
      const last = entries[entries.length - 1];
      // Providers stream a reply as several chunks.
      if (last?.kind === "assistant") last.text = truncate(last.text + item.text, MAX_TEXT);
      else entries.push({ kind: "assistant", text: truncate(item.text, MAX_TEXT), status: null });
    } else if (item.type === "tool_call" && typeof item.agentMessage?.text === "string") {
      entries.push({ kind: "user", text: truncate(item.agentMessage.text, MAX_TEXT), status: null });
    } else if (item.type === "tool_call") {
      entries.push({ kind: "tool", text: truncate(toolLine(item), 400), status: item.status ?? null });
    } else if (item.type === "error" && item.message) {
      entries.push({ kind: "error", text: truncate(item.message, MAX_TEXT), status: null });
    }
  }
  const truncated = entries.length > MAX_ENTRIES;
  return { entries: truncated ? entries.slice(-MAX_ENTRIES) : entries, truncated };
}

function toolLine(item: Item): string {
  const detail = item.detail ?? {};
  const name = item.name ?? "tool";
  switch (detail.type) {
    case "shell":
      return `${name}: ${String(detail.command ?? "")}`;
    case "read":
    case "write":
    case "edit":
      return `${name} ${String(detail.filePath ?? "")}`;
    case "search":
      return `${name}: ${String(detail.query ?? "")}`;
    case "fetch":
      return `${name} ${String(detail.url ?? "")}`;
    default:
      return name;
  }
}
