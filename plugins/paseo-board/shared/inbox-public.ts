import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { IdSchema } from "./contracts";
import { InboxPublicStateSchema, InboxScopeSchema } from "./inbox";

/*
 * Public comment threads in the owner's inbox (public-threads DESIGN §5.4, §12 A3, A4, A19).
 * Human-only RPCs: registered as host-user RPCs, never as MCP or CLI tools. The thread view reads the backend's
 * owner moderation listing, so comments that were never imported (a flood) or were archived can still be hidden.
 */

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const TAG = /^[a-f0-9]{12}$/;
const PageSchema = z.string().max(2_000).refine(value => { try { return /^https?:$/.test(new URL(value).protocol); } catch { return false; } }, "Expected an HTTP(S) page address");
export const PUBLIC_TEXT = {
  applied: "已更新，访客页面会在十几秒内看到变化。",
  syncing: "已记录，正在同步到后端；连接恢复后会自动完成。",
  failed: (error: string) => `没能更新页面上的状态：${error}`.slice(0, 300),
  humanOnly: "只有你可以在页面上隐藏、显示或标为已解决。",
  withdrawn: "访客已撤回这条评论，不能再在页面上显示。",
  replyResolve: "只能把整个讨论标为已解决。",
} as const;

const AnchorSchema = z.object({
  selector: z.string().max(500).optional(), quote: z.string().max(1_000).optional(), prefix: z.string().max(64).optional(), suffix: z.string().max(64).optional(),
  start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional(),
}).strict();
export const InboxPublicMessageSchema = z.object({
  id: z.string().min(1).max(200), by: z.enum(["visitor", "owner", "agent"]),
  tag: z.string().regex(TAG).optional(), name: z.string().max(160).optional(), text: z.string().max(8_000), createdAt: z.string().max(40),
  hidden: z.boolean().optional(), withdrawn: z.literal(true).optional(), replyTo: z.string().max(200).optional(),
  /** Visitor messages imported into this inbox: the ledger comment (for replies and triage). */
  commentId: IdSchema.optional(),
  /** Visitor messages: what the inbox asked the page to show, and whether the backend has confirmed it. */
  state: InboxPublicStateSchema.optional(),
}).strict();
export const InboxPublicThreadSchema = InboxPublicMessageSchema.extend({
  page: z.string().max(2_000), resolved: z.boolean(), anchor: AnchorSchema.optional(),
  replies: z.array(InboxPublicMessageSchema).max(100), omitted: z.number().int().nonnegative(),
}).strict();
export type InboxPublicThread = z.infer<typeof InboxPublicThreadSchema>;
export type InboxPublicMessage = z.infer<typeof InboxPublicMessageSchema>;
export const InboxPublicSourceViewSchema = z.object({
  sourceId: IdSchema, label: z.string().max(200),
  state: z.enum(["ok", "error", "unsupported"]), error: z.string().max(300).nullable(),
  publicThreads: z.boolean(),
  pages: z.array(z.object({ page: z.string().max(2_000), paused: z.boolean(), pending: z.boolean(), error: z.string().max(300).nullable() }).strict()).max(500),
  threads: z.array(InboxPublicThreadSchema).max(100), total: z.number().int().nonnegative(), truncated: z.boolean(),
}).strict();
export type InboxPublicSourceView = z.infer<typeof InboxPublicSourceViewSchema>;
export const InboxPublicThreadsSchema = z.object({ revision: z.number().int().nonnegative(), sources: z.array(InboxPublicSourceViewSchema).max(32) }).strict();
export type InboxPublicThreads = z.infer<typeof InboxPublicThreadsSchema>;

export const InboxPublicStateInputSchema = InboxScopeSchema.extend({
  eventId: IdSchema, sourceId: IdSchema, externalId: z.string().regex(UUID),
  hidden: z.boolean().optional(), resolved: z.boolean().optional(), retry: z.literal(true).optional(),
  /** The backend's state as the thread view showed it, for a comment the inbox has no record of yet. */
  known: z.object({ hidden: z.boolean(), resolved: z.boolean(), withdrawn: z.literal(true).optional(), parentId: z.string().regex(UUID).optional(), publicTag: z.string().regex(TAG).optional() }).strict().optional(),
}).strict().refine(value => value.hidden !== undefined || value.resolved !== undefined || value.retry === true, "Nothing to change");
export type InboxPublicStateInput = z.input<typeof InboxPublicStateInputSchema>;
export const InboxPublicResultSchema = z.object({
  status: z.enum(["applied", "syncing", "failed"]), revision: z.number().int().nonnegative(), message: z.string().max(300),
  state: InboxPublicStateSchema.optional(), changed: z.number().int().nonnegative().optional(),
}).strict();
export type InboxPublicResult = z.infer<typeof InboxPublicResultSchema>;
export const InboxPublicPageInputSchema = InboxScopeSchema.extend({ eventId: IdSchema, sourceId: IdSchema, page: PageSchema, paused: z.boolean() }).strict();
export type InboxPublicPageInput = z.infer<typeof InboxPublicPageInputSchema>;
export const InboxPublicVisitorInputSchema = InboxScopeSchema.extend({ eventId: IdSchema, sourceId: IdSchema, page: PageSchema, tag: z.string().regex(TAG), hidden: z.boolean() }).strict();
export type InboxPublicVisitorInput = z.infer<typeof InboxPublicVisitorInputSchema>;

export const inboxPublicThreadsRpc = defineRpc({ name: "board.inbox.public-threads", input: InboxScopeSchema, output: InboxPublicThreadsSchema });
export const inboxPublicStateRpc = defineRpc({ name: "board.inbox.public-state", input: InboxPublicStateInputSchema, output: InboxPublicResultSchema });
export const inboxPublicPageRpc = defineRpc({ name: "board.inbox.public-page", input: InboxPublicPageInputSchema, output: InboxPublicResultSchema });
export const inboxPublicVisitorRpc = defineRpc({ name: "board.inbox.public-hide-visitor", input: InboxPublicVisitorInputSchema, output: InboxPublicResultSchema });
