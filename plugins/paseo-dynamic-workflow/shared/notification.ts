import { z } from "zod";

export const NOTIFICATION_MARKER = "[paseo-dynamic-workflow]";
export const NOTICE_KIND = "dynamic-workflow-notice";
export const NOTICE_VERSION = 1;

export const NoticeDataSchema = z.object({
  runId: z.string(),
  status: z.string(),
  summary: z.string(),
  text: z.string(),
});
export type NoticeData = z.infer<typeof NoticeDataSchema>;

const MAX_TEXT = 30_000;

/** Reads a task notification the plugin sent as a user message; null for any other text. */
export function parseNotice(text: string): NoticeData | null {
  if (!text.startsWith(NOTIFICATION_MARKER)) return null;
  const runId = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1];
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1];
  if (!runId || !status || !summary) return null;
  return { runId, status, summary, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text };
}
