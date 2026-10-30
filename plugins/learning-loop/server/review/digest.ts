// The conversation replay a review run reads. Hermes replays the whole conversation to a same-model
// fork (warm cache); a review on another model gets "recent turns verbatim + a summary of older ones"
// (agent/background_review.py, routed path). Here: entries after the last review in full (capped
// per message), older ones shortened, the oldest dropped first when over budget, secrets redacted.

import { redact } from "../redact";
import { toolSummary, type TimelineEntryLike } from "../sessions/transcript";

export interface DigestOptions {
  /** Entries with seqEnd above this are "since the last review" and kept in full. */
  reviewedSeq: number;
  maxChars?: number;
  userChars?: number;
  assistantChars?: number;
}

export interface Digest {
  text: string;
  userTurns: number;
  toolCalls: number;
  newEntries: number;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)} …[${t.length - max} more chars]` : t;
}

export function buildDigest(entries: readonly TimelineEntryLike[], options: DigestOptions): Digest {
  const maxChars = options.maxChars ?? 60_000;
  const userChars = options.userChars ?? 4_000;
  const assistantChars = options.assistantChars ?? 3_000;
  const lines: Array<{ text: string; recent: boolean }> = [];
  let userTurns = 0;
  let toolCalls = 0;
  let newEntries = 0;
  let olderTools = 0;
  const flushOlderTools = () => {
    if (olderTools > 0) {
      lines.push({ text: `[${olderTools} tool call${olderTools === 1 ? "" : "s"}]`, recent: false });
      olderTools = 0;
    }
  };
  for (const entry of entries) {
    const recent = entry.seqEnd > options.reviewedSeq;
    if (recent) newEntries += 1;
    const item = entry.item;
    switch (item.type) {
      case "user_message":
        flushOlderTools();
        if (recent) userTurns += 1;
        lines.push({ text: `USER: ${clip(item.text, recent ? userChars : 300)}`, recent });
        break;
      case "assistant_message":
        flushOlderTools();
        if (item.text.trim()) lines.push({ text: `ASSISTANT: ${clip(item.text, recent ? assistantChars : 300)}`, recent });
        break;
      case "tool_call":
        if (recent) {
          toolCalls += 1;
          const error = item.status === "failed" && item.error ? ` — ${clip(String(typeof item.error === "string" ? item.error : JSON.stringify(item.error)), 300)}` : "";
          lines.push({ text: `TOOL: ${toolSummary(item.name, item.detail, item.status)}${error}`, recent });
        } else olderTools += 1;
        break;
      case "error":
        flushOlderTools();
        lines.push({ text: `ERROR: ${clip(item.message, recent ? 1000 : 200)}`, recent });
        break;
      default:
        break;
    }
  }
  flushOlderTools();

  let body = lines.map((line) => line.text);
  let total = body.reduce((sum, line) => sum + line.length + 1, 0);
  if (total > maxChars) {
    // Drop from the oldest, but keep the first user message: it usually states the task.
    const firstUser = body.findIndex((line) => line.startsWith("USER:"));
    const kept: string[] = [];
    let dropped = 0;
    for (let index = 0; index < body.length; index += 1) {
      if (total > maxChars && index !== firstUser) {
        total -= body[index]!.length + 1;
        dropped += 1;
        continue;
      }
      kept.push(body[index]!);
    }
    if (dropped > 0) kept.splice(firstUser === 0 ? 1 : 0, 0, `[${dropped} earlier lines omitted]`);
    body = kept;
  }
  const marker = lines.findIndex((line) => line.recent);
  const text = body.join("\n");
  const withMarker = marker > 0 && lines.length === body.length ? `${body.slice(0, marker).join("\n")}\n--- since the last review ---\n${body.slice(marker).join("\n")}` : text;
  return { text: redact(withMarker), userTurns, toolCalls, newEntries };
}
