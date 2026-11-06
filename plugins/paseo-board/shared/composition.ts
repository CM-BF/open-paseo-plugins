import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { IdSchema } from "./contracts";

export const COMPOSITION_SOURCE_LIMIT = 32;
export const COMPOSITION_SNAPSHOT_MAX_BYTES = 160_000;
export const BoardRefSchema = z.object({ hostId: IdSchema, boardId: IdSchema }).strict();
export type BoardRef = z.infer<typeof BoardRefSchema>;
export const boardRefKey = (ref: BoardRef): string => JSON.stringify([ref.hostId, ref.boardId]);
const Revision = z.number().int().nonnegative();
const Time = z.string().datetime();
const CoverageCount = z.object({ included: Revision, total: Revision, truncated: z.boolean() }).strict();
export const CompositionSnapshotSchema = z.object({
  sourceRef: BoardRefSchema,
  revision: Revision, canvasRevision: Revision, documentVersion: Revision,
  observedAt: Time,
  title: z.string().max(1000), createdAt: z.string().max(100), updatedAt: z.string().max(100),
  coverage: z.object({
    source: z.literal("persistent-store"), liveBrowserObserved: z.literal(false),
    historyComplete: z.literal(false),
    text: CoverageCount.extend({ replayComplete: z.boolean() }).strict(),
    data: CoverageCount, updates: CoverageCount, interactions: CoverageCount,
    note: z.string().max(1000),
  }).strict(),
  text: z.string().max(24000),
  data: z.array(z.object({ key: z.string().max(500), json: z.string().max(16000) }).strict()).max(32),
  updates: z.array(z.object({ id: IdSchema, at: z.string().max(100), kind: z.enum(["data", "patch", "document"]), boardRevision: Revision, canvasRevision: Revision, documentVersion: Revision, selectors: z.array(z.string().max(1000)).max(12) }).strict()).max(12),
  interactions: z.array(z.object({ id: IdSchema, status: z.enum(["saved", "sending", "delivered", "processing", "answered", "applied", "rejected", "failed"]), question: z.string().max(1200), response: z.string().max(2400).optional(), updatedAt: z.string().max(100) }).strict()).max(8),
  unreadUpdateCount: Revision, pendingCount: Revision,
}).strict();
export type CompositionSnapshot = z.infer<typeof CompositionSnapshotSchema>;
export const CompositionSnapshotReceiptSchema = z.object({
  sourceCreatedAt: z.string().min(1).max(100),
  revision: Revision, canvasRevision: Revision, documentVersion: Revision,
  observedAt: Time, receivedAt: Time,
}).strict();
export const CompositionSourcesStateSchema = z.object({
  boardId: IdSchema, boardCreatedAt: z.string().max(100), revision: Revision,
  sources: z.array(z.object({ ref: BoardRefSchema, grantedAt: Time, sourceCreatedAt: z.string().min(1).max(100).optional(), snapshot: CompositionSnapshotReceiptSchema.optional() }).strict()).max(COMPOSITION_SOURCE_LIMIT),
}).strict();
export type CompositionSourcesState = z.infer<typeof CompositionSourcesStateSchema>;
export const SourcesInputSchema = z.object({ boardId: IdSchema }).strict();
export const ReadSourceInputSchema = z.object({ boardId: IdSchema, source: BoardRefSchema }).strict();
export const SourceReadResultSchema = z.object({
  boardId: IdSchema, sourceRef: BoardRefSchema, sourcesRevision: Revision,
  availability: z.enum(["available", "not-yet-observed", "source-missing"]),
  provenance: z.enum(["local-store", "client-observed-cache", "none"]),
  snapshot: CompositionSnapshotSchema.optional(), receivedAt: Time.optional(),
  ageMs: Revision.optional(), stale: z.boolean(), freshness: z.enum(["read-now", "cached-not-live", "unavailable"]),
}).strict();
export type SourceReadResult = z.infer<typeof SourceReadResultSchema>;
export const CompositionSourceSelectionSchema = BoardRefSchema.extend({ sourceCreatedAt: z.string().min(1).max(100) }).strict();
export type CompositionSourceSelection = z.infer<typeof CompositionSourceSelectionSchema>;
export const SetCompositionSourcesInputSchema = z.object({ boardId: IdSchema, expectedRevision: Revision, sources: z.array(CompositionSourceSelectionSchema).max(COMPOSITION_SOURCE_LIMIT) }).strict();
export const SyncCompositionSourceInputSchema = z.object({ boardId: IdSchema, expectedSourcesRevision: Revision, ref: BoardRefSchema, snapshot: CompositionSnapshotSchema }).strict();
export const compositionSourcesRpc = defineRpc({ name: "board.composition.sources", input: SourcesInputSchema, output: CompositionSourcesStateSchema });
export const setCompositionSourcesRpc = defineRpc({ name: "board.composition.set-sources", input: SetCompositionSourcesInputSchema, output: CompositionSourcesStateSchema });
// The source host stamps its own identity; the client cannot label a read as another host.
export const inspectCompositionSourceRpc = defineRpc({ name: "board.composition.inspect", input: SourcesInputSchema, output: CompositionSnapshotSchema });
export const syncCompositionSourceRpc = defineRpc({ name: "board.composition.sync-source", input: SyncCompositionSourceInputSchema, output: CompositionSnapshotReceiptSchema });
export const readCompositionSourceRpc = defineRpc({ name: "board.composition.read-source", input: ReadSourceInputSchema, output: SourceReadResultSchema });
