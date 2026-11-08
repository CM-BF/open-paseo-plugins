import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { IdSchema } from "./contracts";
import { InboxScopeSchema, InboxMutationResultSchema } from "./inbox";

export const InboxEndpointSchema = z.string().max(2_000).url().refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}, "Use an HTTPS export endpoint without credentials, query or fragment; loopback HTTP is permitted for local development");
export const InboxConnectInputSchema = InboxScopeSchema.extend({
  expectedRevision: z.number().int().nonnegative(), eventId: IdSchema,
  expectedConnectionEventId: IdSchema.nullable(),
  sourceId: IdSchema, deploymentId: IdSchema, label: z.string().trim().min(1).max(200), enabled: z.boolean(),
  endpoint: InboxEndpointSchema, token: z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/).optional(),
}).strict();
export const InboxSyncInputSchema = InboxScopeSchema.extend({
  expectedRevision: z.number().int().nonnegative(), eventId: IdSchema, sourceId: IdSchema,
}).strict();
export const InboxConnectionSchema = z.object({
  sourceId: IdSchema, deploymentId: IdSchema, label: z.string(), endpoint: InboxEndpointSchema,
  enabled: z.boolean(), state: z.enum(["pending", "ready"]), eventId: IdSchema,
}).strict();
export const inboxConnectRpc = defineRpc({ name: "board.inbox.connect", input: InboxConnectInputSchema, output: InboxConnectionSchema });
export const InboxReconcileInputSchema = InboxScopeSchema.extend({ sourceId: IdSchema, eventId: IdSchema }).strict();
export const inboxReconcileRpc = defineRpc({ name: "board.inbox.reconcile", input: InboxReconcileInputSchema, output: z.object({ state: z.enum(["ready", "cancelled"]) }) });
export const inboxConnectionsRpc = defineRpc({ name: "board.inbox.connections", input: InboxScopeSchema, output: z.array(InboxConnectionSchema) });
export const inboxSyncRpc = defineRpc({ name: "board.inbox.sync", input: InboxSyncInputSchema, output: InboxMutationResultSchema.extend({ unchanged: z.boolean().optional() }) });
export type InboxConnection = z.infer<typeof InboxConnectionSchema>;
export type InboxConnectInput = z.infer<typeof InboxConnectInputSchema>;
export type InboxSyncInput = z.infer<typeof InboxSyncInputSchema>;
