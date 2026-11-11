import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { IdSchema, JsonDataSchema } from "./contracts";
import { InboxScopeSchema } from "./inbox";
import { LIVE_LIMITS, LiveChannelIdSchema, LivePathSchema, LiveStateSchema, PublicApiOriginSchema, livePathsDisjoint } from "./release-contracts";

export { LIVE_LIMITS };
/** Health value for a backend whose runtime predates live data: its health response has no `live` field. */
export const LIVE_RUNTIME_OUTDATED = -1;

export const LiveMarkSchema = z.object({ path: LivePathSchema, subtree: z.boolean() }).strict();
const LiveMarkListSchema = z.array(LiveMarkSchema).max(LIVE_LIMITS.paths).refine(marks => livePathsDisjoint(marks.map(mark => mark.path)), "公开路径不能重复或互相包含");
export const LiveMarksSchema = LiveMarkListSchema.min(1);
export const LiveChannelStateSchema = z.enum(["pending", "ready", "paused", "blocked", "revoking", "revoked"]);
export const LiveWithheldSchema = z.object({ path: LivePathSchema, reason: z.enum(["absent", "object-without-subtree", "non-object-parent"]) }).strict();
export const LiveErrorSchema = z.object({ code: z.string(), message: z.string(), at: z.string() }).strict();
export const LiveTokenSchema = z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/);
export const LiveDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Everything the UI may see about a channel. Deliberately has no token field. */
export const LiveChannelSchema = z.object({
  channelId: LiveChannelIdSchema, origin: PublicApiOriginSchema, deploymentId: IdSchema, marks: LiveMarksSchema,
  state: LiveChannelStateSchema, eventId: IdSchema,
}).strict();
export const LiveStatusSchema = z.object({
  state: LiveStateSchema, seq: z.number().int().nonnegative(), pushedAt: z.string().optional(),
  pushedBytes: z.number().int().nonnegative().optional(), pushedCanvasRevision: z.number().int().nonnegative().optional(),
  lastError: LiveErrorSchema.optional(), attempts: z.number().int().nonnegative(), nextAttemptAt: z.string().optional(),
  withheld: z.array(LiveWithheldSchema),
}).strict();
export const LivePreviewSchema = z.object({
  values: JsonDataSchema.optional(), bytes: z.number().int().nonnegative(), overLimit: z.boolean(),
  withheld: z.array(LiveWithheldSchema), pathBytes: z.record(z.string(), z.number().int().nonnegative()),
}).strict();
export const LiveBackendSchema = z.object({ id: z.string(), deploymentId: z.string(), live: z.number() }).strict();

export const LiveGetInputSchema = InboxScopeSchema.extend({
  marks: LiveMarkListSchema.optional(), probeOrigin: PublicApiOriginSchema.optional(),
  pageOrigins: z.array(PublicApiOriginSchema).max(8).optional(),
}).strict();
export const LiveGetOutputSchema = z.object({
  channel: LiveChannelSchema.nullable(), status: LiveStatusSchema, preview: LivePreviewSchema.nullable(),
  backend: LiveBackendSchema.nullable(), originProblems: z.array(z.string()), consentDigest: LiveDigestSchema.nullable(),
}).strict();

const setBase = { ...InboxScopeSchema.shape, eventId: IdSchema, expectedEventId: IdSchema.nullable() };
export const LiveSetInputSchema = z.discriminatedUnion("action", [
  z.object({ ...setBase, action: z.literal("upsert"), origin: PublicApiOriginSchema, deploymentId: IdSchema, token: LiveTokenSchema.optional(), marks: LiveMarksSchema, consentDigest: LiveDigestSchema, acknowledgedPublic: z.literal(true) }).strict(),
  z.object({ ...setBase, action: z.literal("pause") }).strict(),
  z.object({ ...setBase, action: z.literal("resume"), consentDigest: LiveDigestSchema }).strict(),
  z.object({ ...setBase, action: z.literal("revoke") }).strict(),
  // Ends retries and wipes the token without reaching the backend; its copy may remain.
  z.object({ ...setBase, action: z.literal("stop-local") }).strict(),
]);
export const LiveSetOutputSchema = z.object({ channel: LiveChannelSchema, status: LiveStatusSchema }).strict();

// Host-user only, like every release/pages RPC: never on the agent bridge or MCP.
export const liveGetRpc = defineRpc({ name: "board.live.get", input: LiveGetInputSchema, output: LiveGetOutputSchema });
export const liveSetRpc = defineRpc({ name: "board.live.set", input: LiveSetInputSchema, output: LiveSetOutputSchema });

export type LiveMark = z.infer<typeof LiveMarkSchema>;
export type LiveChannel = z.infer<typeof LiveChannelSchema>;
export type LiveChannelState = z.infer<typeof LiveChannelStateSchema>;
export type LiveStatus = z.infer<typeof LiveStatusSchema>;
export type LiveWithheld = z.infer<typeof LiveWithheldSchema>;
export type LivePreview = z.infer<typeof LivePreviewSchema>;
export type LiveGetInput = z.infer<typeof LiveGetInputSchema>;
export type LiveGetOutput = z.infer<typeof LiveGetOutputSchema>;
export type LiveSetInput = z.infer<typeof LiveSetInputSchema>;
export type LiveSetOutput = z.infer<typeof LiveSetOutputSchema>;
