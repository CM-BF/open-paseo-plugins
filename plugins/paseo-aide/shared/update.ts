import { z } from "zod";
import { UrgencySchema } from "./types";

// The plugin's own messages to the assistant start with an HTML comment carrying JSON. The chat
// renders them as a compact card, and the assistant (and the plugin) can tell them from the user.
export const UPDATE_PREFIX = "<!-- aide:";
const UPDATE_END = " -->";

export const UpdateItemSchema = z.object({ id: z.string(), title: z.string(), urgency: UrgencySchema });

export const UpdateDataSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["checkin", "brief", "reminder", "welcome"]),
  title: z.string(),
  at: z.string(),
  runId: z.string().nullable().default(null),
  followupId: z.string().nullable().default(null),
  items: z.array(UpdateItemSchema).default([]),
});
export type UpdateData = z.infer<typeof UpdateDataSchema>;

/** Renderer payload: the header plus the instructions the assistant received. */
export const UpdateRowSchema = UpdateDataSchema.extend({ body: z.string() });
export type UpdateRow = z.infer<typeof UpdateRowSchema>;

export function encodeUpdate(data: z.input<typeof UpdateDataSchema>, body: string): string {
  // A "-->" inside a string would close the comment early; > is the same JSON string.
  const json = JSON.stringify(UpdateDataSchema.parse(data)).replaceAll("-->", "--\\u003e");
  return `${UPDATE_PREFIX}${json}${UPDATE_END}\n${body}`;
}

export function isUpdateText(text: string): boolean {
  return text.trimStart().startsWith(UPDATE_PREFIX);
}

export function decodeUpdate(text: string): UpdateRow | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(UPDATE_PREFIX)) return null;
  const end = trimmed.indexOf(UPDATE_END, UPDATE_PREFIX.length);
  if (end < 0) return null;
  try {
    const data = UpdateDataSchema.safeParse(JSON.parse(trimmed.slice(UPDATE_PREFIX.length, end)));
    if (!data.success) return null;
    return { ...data.data, body: trimmed.slice(end + UPDATE_END.length).replace(/^\n/, "") };
  } catch {
    return null;
  }
}
