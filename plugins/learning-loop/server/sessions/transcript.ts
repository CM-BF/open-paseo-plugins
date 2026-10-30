import type { AgentTimelineItem, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { IndexedMessage } from "./index";

/** The fields of a fetched timeline entry this plugin reads. */
export interface TimelineEntryLike {
  item: AgentTimelineItem;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** One line per tool call: what it did, never its output. */
export function toolSummary(name: string, detail: ToolCallDetail | undefined, status?: string): string {
  const failed = status === "failed" ? " (failed)" : "";
  if (!detail) return `${name}${failed}`;
  switch (detail.type) {
    case "shell":
      return `$ ${clip(detail.command, 300)}${detail.exitCode ? ` (exit ${detail.exitCode})` : ""}${failed}`;
    case "read":
      return `read ${detail.filePath}${failed}`;
    case "edit":
      return `edit ${detail.filePath}${failed}`;
    case "write":
      return `write ${detail.filePath}${failed}`;
    case "search":
      return `${detail.toolName ?? "search"} ${clip(detail.query, 200)}${failed}`;
    case "fetch":
      return `fetch ${detail.url}${failed}`;
    case "sub_agent":
      return `subagent ${clip(detail.description ?? detail.subAgentType ?? "", 200)}${failed}`;
    case "plain_text":
      return `${name}: ${clip(detail.label ?? detail.text ?? "", 200)}${failed}`;
    case "plan":
      return `plan: ${clip(detail.text, 200)}`;
    case "worktree_setup":
      return `worktree ${detail.branchName}`;
    case "unknown": {
      let input = "";
      try {
        input = detail.input === undefined ? "" : JSON.stringify(detail.input);
      } catch {
        input = "";
      }
      return `${name}${input && input !== "{}" ? ` ${clip(input, 200)}` : ""}${failed}`;
    }
    default:
      return `${name}${failed}`;
  }
}

/** The searchable message for an entry, or null for rows that carry no conversation. */
export function toIndexed(entry: TimelineEntryLike): IndexedMessage | null {
  const item = entry.item;
  const at = entry.timestamp ?? null;
  switch (item.type) {
    case "user_message":
      return item.text.trim() ? { seq: entry.seqStart, role: "user", at, text: item.text } : null;
    case "assistant_message":
      return item.text.trim() ? { seq: entry.seqStart, role: "assistant", at, text: item.text } : null;
    case "tool_call":
      return { seq: entry.seqStart, role: "tool", at, text: toolSummary(item.name, item.detail, item.status) };
    case "error":
      return { seq: entry.seqStart, role: "tool", at, text: `error: ${clip(item.message, 500)}` };
    default:
      return null;
  }
}
