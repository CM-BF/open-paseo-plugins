import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { createComponentLayoutTools } from "./component-layout";

export const PLUGIN_ID = "paseo-board";
export const IdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.:-]+$/);
export const JsonDataSchema = z.record(z.string(), z.unknown());
export const ReadInputSchema = z.object({
  boardId: IdSchema,
  view: z.enum(["full", "inspect"]).default("full"),
  selector: z.string().min(1).max(1000).optional(),
  dataPaths: z.array(z.string().max(2000).refine(path => {
    if ((path !== "" && !path.startsWith("/")) || /~(?![01])/.test(path)) return false;
    const parts = path === "" ? [] : path.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    return parts.length <= 64 && !parts.some(part => ["__proto__", "prototype", "constructor"].includes(part));
  }, "Expected a safe JSON Pointer")).max(20).optional(),
  interactionIds: z.array(IdSchema).max(20).optional(),
  recentLimit: z.number().int().min(1).max(20).default(8),
});
export const EvidenceSchema = z.object({
  kind: z.enum(["agent", "message", "file", "command", "event", "user"]),
  reference: z.string().max(4000),
  excerpt: z.string().max(12000).optional(),
});
export const DecisionInputSchema = z.object({
  id: IdSchema,
  choice: z.string().min(1).max(4000),
  rationale: z.string().max(8000).optional(),
  impact: z.string().max(8000).optional(),
  basis: z.enum(["explicit", "observed", "inferred"]),
  status: z.enum(["active", "questioned", "superseded", "dismissed"]).default("active"),
  evidence: z.array(EvidenceSchema).max(30).default([]),
  related: z.array(z.string().max(1000)).max(30).default([]),
  supersedes: IdSchema.optional(),
  authorAgentId: z.string().optional(),
});
export const DecisionSchema = DecisionInputSchema.extend({ createdAt: z.string(), updatedAt: z.string() });
export const RectSchema = z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() });
// Optional DOM identity hints. The frozen quote/rect/image remain the source of truth.
export const AnchorElementSchema = z.object({
  selector: z.string().min(1).max(1000),
  tag: z.string().min(1).max(100),
  id: z.string().min(1).max(1000).optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{8}$/),
});
export const AnchorBindingSchema = z.object({
  documentVersion: z.number().int().nonnegative(),
  key: z.string().min(1).max(160),
  target: AnchorElementSchema,
  ancestors: z.array(AnchorElementSchema).max(8),
  relative: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
});
export const AnchorSchema = z.object({
  boardRevision: z.number().int().nonnegative(),
  canvasRevision: z.number().int().nonnegative(),
  kind: z.enum(["board", "text", "region", "point", "element"]),
  text: z.string().max(12000).optional(),
  selector: z.string().max(1000).optional(),
  rect: RectSchema.optional(),
  binding: AnchorBindingSchema.optional(),
  viewport: z.object({ width: z.number().positive(), height: z.number().positive(), scrollX: z.number(), scrollY: z.number() }).optional(),
  image: z.object({ mimeType: z.literal("image/png"), data: z.string().max(3000000) }).optional(),
});
export const COMMENT_LIMIT = 20;
export const COMMENT_TEXT_LIMIT = 24000;
export const COMMENT_IMAGE_LIMIT = 6_000_000;
export const CommentSchema = z.object({
  id: IdSchema,
  text: z.string().min(1).max(COMMENT_TEXT_LIMIT).refine(text => text.trim().length > 0, "Comment text cannot be blank"),
  anchor: AnchorSchema.optional(),
}).refine(comment => !comment.anchor?.image || /^[A-Za-z0-9+/]*={0,2}$/.test(comment.anchor.image.data), "Comment PNG must contain ASCII base64 data");
export const CommentsSchema = z.array(CommentSchema).min(1).max(COMMENT_LIMIT).superRefine((comments, context) => {
  if (new Set(comments.map(comment => comment.id)).size !== comments.length) context.addIssue({ code: "custom", message: "Comment IDs must be unique" });
  if (comments.reduce((total, comment) => total + comment.text.length, 0) > COMMENT_TEXT_LIMIT) context.addIssue({ code: "custom", message: `Comments exceed ${COMMENT_TEXT_LIMIT} text characters` });
  if (comments.reduce((total, comment) => total + (comment.anchor?.image?.data.length ?? 0), 0) > COMMENT_IMAGE_LIMIT) context.addIssue({ code: "custom", message: `Comment PNGs exceed ${COMMENT_IMAGE_LIMIT} base64 characters` });
});
function validateCommentContext(input: { comments?: unknown[]; anchor?: unknown; sourceInteractionId?: string }, context: z.RefinementCtx): void {
  if (!input.comments) return;
  if (input.anchor !== undefined) context.addIssue({ code: "custom", path: ["anchor"], message: "Grouped comments carry their own anchors" });
  if (input.sourceInteractionId !== undefined) context.addIssue({ code: "custom", path: ["sourceInteractionId"], message: "Grouped comments cannot inherit a source interaction" });
}
export const ComponentIdentitySchema = z.object({
  tag: z.string().min(1).max(100), id: z.string().min(1).max(1000).optional(),
  // Structural identity excludes live text and control values.
  fingerprint: z.string().regex(/^[a-f0-9]{8}$/),
  authoredHtml: z.string().max(240000).optional(),
});
export const ComponentLayoutSchema = z.object({
  collapse: z.enum(["none", "contents", "group"]),
  maxHeight: z.number().int().min(80).max(2000).nullable(),
  title: z.string().min(1).max(120).optional(),
  placement: z.partialRecord(z.enum(["grid-column", "grid-row", "order", "flex-grow", "flex-shrink", "flex-basis", "align-self", "justify-self", "width", "min-width", "max-width", "margin-top", "margin-right", "margin-bottom", "margin-left"]), z.string().max(240)).optional(),
  flow: z.partialRecord(z.enum(["display", "flex-direction", "flex-wrap", "align-items", "justify-content", "align-content", "grid-template-columns", "grid-template-rows", "grid-auto-columns", "grid-auto-rows", "grid-auto-flow", "column-gap", "row-gap"]), z.string().max(240)).optional(),
}).strict().refine(value => createComponentLayoutTools().validate(value), "Expected bounded component layout options");
export const CanvasPatchSchema = z.object({
  id: IdSchema,
  selector: z.string().min(1).max(1000),
  operation: z.enum(["append", "prepend", "replace", "remove", "move", "copy", "text", "layout"]),
  html: z.string().max(2000000).default(""),
  sourceIdentity: ComponentIdentitySchema.optional(), destinationIdentity: ComponentIdentitySchema.optional(),
  destination: z.string().min(1).max(1000).optional(), position: z.enum(["before", "after", "append", "prepend"]).optional(),
  copyIdPrefix: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,100}$/).optional(),
  text: z.string().max(24000).optional(), expectedText: z.string().max(24000).optional(),
  textNodeIndex: z.number().int().min(0).max(10000).optional(),
  layout: ComponentLayoutSchema.optional(),
}).superRefine((patch, context) => {
  if (!["move", "copy", "text", "layout"].includes(patch.operation)) {
    if (patch.layout !== undefined) context.addIssue({ code: "custom", path: ["layout"], message: "Layout options require a layout operation" });
    return;
  }
  const missing = (field: string) => context.addIssue({ code: "custom", path: [field], message: `Component edit requires ${field}` });
  if (!patch.sourceIdentity) missing("sourceIdentity");
  if (patch.operation === "layout") {
    if (!patch.layout) missing("layout");
    if (patch.html !== "" || patch.destination !== undefined || patch.destinationIdentity !== undefined || patch.position !== undefined || patch.text !== undefined || patch.expectedText !== undefined || patch.textNodeIndex !== undefined || patch.copyIdPrefix !== undefined) context.addIssue({ code: "custom", message: "Layout edits accept only identity and bounded layout options" });
  } else if (patch.operation === "text") {
    if (patch.text === undefined) missing("text");
    if (patch.expectedText === undefined) missing("expectedText");
  } else {
    if (!patch.destination) missing("destination");
    if (!patch.destinationIdentity) missing("destinationIdentity");
    if (!patch.position) missing("position");
    if (patch.operation === "copy" && !patch.copyIdPrefix) missing("copyIdPrefix");
  }
  if (patch.operation !== "layout" && patch.layout !== undefined) context.addIssue({ code: "custom", path: ["layout"], message: "Layout options require a layout operation" });
});
export const CanvasSchema = z.object({
  revision: z.number().int().nonnegative(),
  documentVersion: z.number().int().nonnegative(),
  html: z.string(),
  data: JsonDataSchema,
  patches: z.array(CanvasPatchSchema),
});
export const CanvasBaseSchema = CanvasSchema.pick({ revision: true, documentVersion: true });
export const DataPatchSchema = z.object({
  path: z.string().min(1).max(2000),
  operation: z.enum(["set", "remove"]),
  expected: z.object({ exists: z.boolean(), value: z.unknown().optional() }),
  value: z.unknown().optional(),
}).superRefine((patch, context) => {
  const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
  if (has(patch.expected, "value") !== patch.expected.exists) context.addIssue({ code: "custom", path: ["expected", "value"], message: "Expected value is required exactly when expected.exists is true" });
  if (has(patch, "value") !== (patch.operation === "set")) context.addIssue({ code: "custom", path: ["value"], message: "A value is required only for set operations" });
});
export const DataPatchesSchema = z.array(DataPatchSchema).min(1).max(100);
export const FocusSelectorsSchema = z.array(z.string().min(1).max(1000)).max(12);
// Feeds carry arbitrary JSON. Their identities are bound by the transport,
// never by an agent-supplied actor or a transferable per-feed credential.
export const FeedCapacitySchema = z.object({
  maxRecords: z.number().int().min(1).max(50_000).default(10_000),
  maxBytes: z.number().int().min(2).max(1_500_000).default(1_000_000),
}).strict();
export const FEED_BATCH_RECORD_LIMIT = 1_000;
export const FeedAckSchema = z.object({
  boardId: IdSchema, sourceId: IdSchema, generation: z.number().int().positive(),
  seq: z.number().int().nonnegative(), revision: z.number().int().nonnegative(),
  canvasRevision: z.number().int().nonnegative(), acceptedAt: z.string(),
  recordCount: z.number().int().nonnegative().optional(), recordBytes: z.number().int().nonnegative().optional(),
});
export const FeedStateSchema = z.object({
  sourceId: IdSchema, path: z.string(), generation: z.number().int().positive(),
  mode: z.enum(["latest", "records"]).default("latest"), capacity: FeedCapacitySchema.optional(),
  recordCount: z.number().int().nonnegative().optional(), recordBytes: z.number().int().nonnegative().optional(),
  actorAgentId: z.string().optional(), closed: z.boolean(), seq: z.number().int().nonnegative(),
  openedAt: z.string(), lastAcceptedAt: z.string().optional(),
  focusSelectors: FocusSelectorsSchema.default([]),
  lastAck: FeedAckSchema.optional(),
  lastError: z.object({ code: z.string(), message: z.string(), at: z.string() }).optional(),
  // Internal, bounded reconciliation metadata. No values or bearer credentials.
  valueFingerprint: z.string(), openRequestId: IdSchema, openFingerprint: z.string(),
  openAck: FeedAckSchema,
  receipts: z.array(z.object({ seq: z.number().int().positive(), fingerprint: z.string(), ack: FeedAckSchema })).max(32),
});
const FeedIdentityShape = { boardId: IdSchema, sourceId: IdSchema };
export const FeedInputSchema = z.discriminatedUnion("action", [
  z.object({ ...FeedIdentityShape, action: z.literal("open"), path: z.string().min(1).max(2000),
    requestId: IdSchema, expectedGeneration: z.number().int().nonnegative(), focusSelectors: FocusSelectorsSchema.default([]),
    mode: z.enum(["latest", "records"]).optional(), capacity: FeedCapacitySchema.optional() }),
  z.object({ ...FeedIdentityShape, action: z.literal("set"), generation: z.number().int().positive(), seq: z.number().int().positive(),
    value: z.unknown(), attention: z.enum(["quiet", "milestone"]).default("quiet"), focusSelectors: FocusSelectorsSchema.optional() }),
  z.object({ ...FeedIdentityShape, action: z.literal("append"), generation: z.number().int().positive(), seq: z.number().int().positive(),
    records: z.array(z.unknown()).min(1).max(FEED_BATCH_RECORD_LIMIT), attention: z.enum(["quiet", "milestone"]).default("quiet"), focusSelectors: FocusSelectorsSchema.optional() }),
  z.object({ ...FeedIdentityShape, action: z.literal("close"), generation: z.number().int().positive() }),
  z.object({ ...FeedIdentityShape, action: z.literal("status") }),
]);
export const FeedResultSchema = z.object({ source: FeedStateSchema, ack: FeedAckSchema.optional() });
export type FeedInput = z.input<typeof FeedInputSchema>;
export type FeedState = z.infer<typeof FeedStateSchema>;
export type FeedAck = z.infer<typeof FeedAckSchema>;
export type FeedResult = z.infer<typeof FeedResultSchema>;

export const CanvasUpdateSchema = z.object({
  id: IdSchema, eventId: IdSchema, at: z.string(),
  boardRevision: z.number().int().nonnegative(), canvasRevision: z.number().int().nonnegative(), documentVersion: z.number().int().nonnegative(),
  kind: z.enum(["patch", "data", "document"]),
  targets: z.array(z.object({ selector: z.string().min(1).max(1000), operation: CanvasPatchSchema.shape.operation.optional(), patchId: IdSchema.optional() })).max(12),
  actorAgentId: z.string().optional(),
});
export const DestinationSchema = z.enum(["main", "side", "new-side"]);
/** What a send that creates a new Side starts with. Absent means blank; the server never defaults to history. */
export const SideContextSchema = z.enum(["blank", "owner-history"]);
export type SideContext = z.infer<typeof SideContextSchema>;
/** User-visible provenance of a Side created with the owner's history. Never contains the history text. */
export const InheritedHistorySchema = z.object({
  sourceAgentId: z.string().min(1).max(160),
  capturedAt: z.string().min(1).max(100),
  /** User and assistant chat messages actually included. A Board question counts once; its recorded Board answer is an entry, not a message. */
  messages: z.number().int().nonnegative(),
  /** All curated lines included, including tool summaries and Board answers. */
  entries: z.number().int().nonnegative(),
  /** Older history existed but was not included. */
  omitted: z.boolean(),
  /** The owner had an active turn or pending permission at capture. */
  ownerBusy: z.boolean(),
  chars: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Derived from the first-send outcome: provenance never claims history the Side did not receive. */
  state: z.enum(["frozen", "sent", "uncertain", "not_sent"]),
});
export type InheritedHistory = z.infer<typeof InheritedHistorySchema>;
function validateSideContext(input: { sideContext?: unknown; destination?: string; kind: string }, context: z.RefinementCtx): void {
  if (input.sideContext === undefined) return;
  if (input.destination === "side" || input.destination === "new-side" || (!input.destination && input.kind === "fork")) return;
  context.addIssue({ code: "custom", path: ["sideContext"], message: "sideContext applies only to a send that may create a Side" });
}
export const SourceSnapshotSchema = z.object({
  id: IdSchema, text: z.string().max(24000), response: z.string().max(64000).optional(),
  responseRevision: z.number().int().nonnegative(), resultReferences: z.array(z.string()),
  responseCanvasRevision: z.number().int().nonnegative().optional(),
  // One flat original group survives follow-ups; never embed another snapshot.
  comments: CommentsSchema.optional(), commentSourceId: IdSchema.optional(),
});
export const InteractionSchema = z.object({
  id: IdSchema,
  expectedCreatedAt: z.string().min(1).max(100).optional(),
  kind: z.enum(["question", "change", "fork", "return", "reply"]),
  destination: DestinationSchema.optional(),
  text: z.string().min(1).max(24000),
  anchor: AnchorSchema.optional(),
  comments: CommentsSchema.optional(),
  status: z.enum(["saved", "sending", "delivered", "processing", "answered", "applied", "rejected", "failed"]),
  agentId: z.string().optional(),
  response: z.string().max(64000).optional(),
  responseRevision: z.number().int().nonnegative().optional(),
  responseSource: z.enum(["explicit", "timeline"]).optional(),
  responseMethod: z.enum(["respond", "publish"]).optional(),
  responseCanvas: CanvasSchema.optional(),
  resultReferences: z.array(z.string()).default([]),
  error: z.string().optional(),
  sourceInteractionId: IdSchema.optional(),
  sourceSnapshot: SourceSnapshotSchema.optional(),
  sideContext: SideContextSchema.optional(),
  inheritedHistory: InheritedHistorySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).superRefine(validateCommentContext);
export const EventSchema = z.object({ id: IdSchema, source: z.string(), kind: z.string(), summary: z.string(), at: z.string(), revision: z.number(), data: JsonDataSchema.optional() });
export const ObservationSchema = z.object({ id: IdSchema, name: z.string(), value: z.unknown(), evidence: EvidenceSchema, updatedAt: z.string() });
export const BoardSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema, title: z.string(), projectId: z.string().optional(), workspaceId: z.string().optional(), ownerAgentId: z.string().optional(),
  sideAgentId: z.string().optional(), pendingSideInteractionId: IdSchema.optional(), sideAgentRevision: z.number().int().nonnegative().optional(),
  revision: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(),
  canvas: CanvasSchema,
  updates: z.array(CanvasUpdateSchema).max(80).default([]), seenUpdateIds: z.array(IdSchema).max(80).default([]),
  feeds: z.array(FeedStateSchema).max(64).optional(),
  decisions: z.array(DecisionSchema), interactions: z.array(InteractionSchema), events: z.array(EventSchema), observations: z.array(ObservationSchema),
  userState: JsonDataSchema,
  extraction: z.object({ lastCheckedAt: z.string().optional(), agentId: z.string().optional(), cursor: z.string().optional(), note: z.string().optional() }),
});
export const BoardSummarySchema = BoardSchema.pick({ id: true, title: true, projectId: true, workspaceId: true, ownerAgentId: true, revision: true, createdAt: true, updatedAt: true }).extend({ decisionCount: z.number(), pendingCount: z.number(), unreadUpdateCount: z.number().int().nonnegative().default(0), latestUpdateRevision: z.number().int().nonnegative().default(0), status: z.enum(["processing", "error", "idle"]).default("idle") });
// Independent transport sequence also covers attention changes that preserve content revision.
export const BoardEventCursorSchema = z.object({ epoch: z.string().min(1).max(160), sequence: z.number().int().nonnegative() });
export const BoardChangeReasonSchema = z.enum(["content", "attention", "metadata", "operational"]);
export const BoardChangeSchema = z.object({ cursor: BoardEventCursorSchema, summary: BoardSummarySchema, canvasRevision: z.number().int().nonnegative(), reason: BoardChangeReasonSchema });
export const BoardChangesSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("snapshot"), cursor: BoardEventCursorSchema, boards: z.array(BoardSummarySchema) }),
  z.object({ mode: z.literal("delta"), cursor: BoardEventCursorSchema, changes: z.array(BoardChangeSchema) }),
  z.object({ mode: z.literal("compact"), fromCursor: BoardEventCursorSchema, cursor: BoardEventCursorSchema, changes: z.array(BoardChangeSchema) }),
]);
export type BoardEventCursor = z.infer<typeof BoardEventCursorSchema>;
export type BoardChange = z.infer<typeof BoardChangeSchema>;
export type BoardChanges = z.infer<typeof BoardChangesSchema>;
export const BOARD_CHANGE_EVENT = "board.changed";
// Structural public event contract; registration is capability-gated until the host API ships.
export const boardChangedEvent = { name: BOARD_CHANGE_EVENT, schema: BoardChangeSchema };
export const CreateInputSchema = z.object({ id: IdSchema.optional(), title: z.string().min(1).max(200), projectId: z.string().optional(), workspaceId: z.string().optional(), ownerAgentId: z.string().optional(), html: z.string().max(4000000).default(""), data: JsonDataSchema.default({}) });
export const PublishInputSchema = z.object({
  boardId: IdSchema, expectedRevision: z.number().int().nonnegative(), eventId: IdSchema,
  canvasBase: CanvasBaseSchema.optional(), replaceDocument: z.boolean().optional(),
  title: z.string().min(1).max(200).optional(), ownerAgentId: z.string().optional(),
  html: z.string().max(4000000).optional(), patch: CanvasPatchSchema.optional(), data: JsonDataSchema.optional(),
  dataPatch: DataPatchesSchema.optional(), focusSelectors: FocusSelectorsSchema.optional(),
  decisions: z.array(DecisionInputSchema).max(50).optional(), summary: z.string().max(4000).default("Board updated"),
  interactionResult: z.object({ id: IdSchema, status: z.enum(["processing", "applied", "rejected", "failed"]), response: z.string().max(64000).optional(), resultReferences: z.array(z.string()).default([]) }).optional(),
});
export const RespondInputSchema = z.object({
  boardId: IdSchema, interactionId: IdSchema, eventId: IdSchema,
  expectedResponseRevision: z.number().int().nonnegative(),
  status: z.enum(["processing", "answered", "rejected", "failed"]).default("answered"),
  response: z.string().min(1).max(64000),
  html: z.string().max(4000000).optional(), patch: CanvasPatchSchema.optional(), data: JsonDataSchema.optional(),
  resultReferences: z.array(z.string().max(4000)).max(100).optional(),
});
export const EmitInputSchema = z.object({ boardId: IdSchema, eventId: IdSchema, source: z.string().min(1).max(200), kind: z.string().max(200).default("update"), summary: z.string().max(4000), canvasBase: CanvasBaseSchema.optional(), data: JsonDataSchema.optional(), dataPatch: DataPatchesSchema.optional(), focusSelectors: FocusSelectorsSchema.optional(), observation: z.object({ id: IdSchema, name: z.string().max(200), value: z.unknown(), evidence: EvidenceSchema }).optional() });
export const InteractInputSchema = z.object({ boardId: IdSchema, expectedCreatedAt: z.string().min(1).max(100).optional(), intentId: IdSchema, kind: z.enum(["question", "change", "fork", "return", "reply"]), destination: DestinationSchema.optional(), text: z.string().min(1).max(24000), anchor: AnchorSchema.optional(), comments: CommentsSchema.optional(), sourceInteractionId: IdSchema.optional(), sideContext: SideContextSchema.optional() }).superRefine(validateCommentContext).superRefine(validateSideContext);
export const SelectSideAgentInputSchema = z.object({ boardId: IdSchema, agentId: z.string().min(1).max(160), expectedRevision: z.number().int().nonnegative(), eventId: IdSchema });
export const RenameInputSchema = z.object({ boardId: IdSchema, expectedTitle: z.string(), title: z.string().trim().min(1).max(200), eventId: IdSchema });
export const EditInputSchema = z.object({
  boardId: IdSchema, expectedCreatedAt: z.string().min(1).max(100).optional(), canvasBase: CanvasBaseSchema, eventId: IdSchema,
  patch: CanvasPatchSchema.refine(patch => ["move", "copy", "text", "layout"].includes(patch.operation) && patch.html === "", "User edits support move, copy, text and layout operations without caller-supplied HTML"),
});
export const DecisionUpdateInputSchema = z.object({ boardId: IdSchema, expectedRevision: z.number().int().nonnegative(), eventId: IdSchema, decision: DecisionInputSchema });
export const StateInputSchema = z.object({ boardId: IdSchema, expectedCreatedAt: z.string().min(1).max(100).optional(), state: JsonDataSchema });
export const MarkUpdatesSeenInputSchema = z.object({ boardId: IdSchema, updateIds: z.array(IdSchema).max(80) });
export type Board = z.infer<typeof BoardSchema>;
export type BoardSummary = z.infer<typeof BoardSummarySchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type BoardComment = z.infer<typeof CommentSchema>;
export type Canvas = z.infer<typeof CanvasSchema>;
export type CanvasBase = z.infer<typeof CanvasBaseSchema>;
export type DataPatch = z.infer<typeof DataPatchSchema>;
export type CanvasPatch = z.infer<typeof CanvasPatchSchema>;
export type CanvasUpdate = z.infer<typeof CanvasUpdateSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type DecisionInput = z.infer<typeof DecisionInputSchema>;
export type Interaction = z.infer<typeof InteractionSchema>;
export type CreateInput = z.input<typeof CreateInputSchema>;
export type PublishInput = z.input<typeof PublishInputSchema>;
export type RespondInput = z.input<typeof RespondInputSchema>;
export type EmitInput = z.input<typeof EmitInputSchema>;
export type InteractInput = z.input<typeof InteractInputSchema>;
export type SelectSideAgentInput = z.input<typeof SelectSideAgentInputSchema>;
export type RenameInput = z.input<typeof RenameInputSchema>;
export type EditInput = z.input<typeof EditInputSchema>;
export const EditRefusalCodeSchema = z.enum(["board_identity_changed", "invalid_input", "revision_conflict", "edit_conflict", "idempotency_conflict", "unauthorized", "forbidden", "board_not_found", "not_found", "size_limit"]);
export const EditResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), eventId: IdSchema, board: BoardSchema }),
  z.object({ status: z.literal("rejected"), eventId: IdSchema, code: EditRefusalCodeSchema, componentTarget: z.enum(["source", "destination"]).optional() }),
]);
export type EditResult = z.infer<typeof EditResultSchema>;
export type ComponentIdentity = z.infer<typeof ComponentIdentitySchema>;
export type JsonData = z.infer<typeof JsonDataSchema>;
export type MarkUpdatesSeenInput = z.input<typeof MarkUpdatesSeenInputSchema>;

export const listBoardsRpc = defineRpc({ name: "board.list", input: z.object({ workspaceId: z.string().optional() }), output: z.object({ boards: z.array(BoardSummarySchema), cursor: BoardEventCursorSchema.optional() }) });
export const readBoardRpc = defineRpc({ name: "board.read", input: z.object({ boardId: IdSchema, sinceRevision: z.number().optional() }), output: z.object({ board: BoardSchema.nullable(), unchanged: z.boolean().default(false) }) });
export const createBoardRpc = defineRpc({ name: "board.create", input: CreateInputSchema, output: BoardSchema });
export const publishBoardRpc = defineRpc({ name: "board.publish", input: PublishInputSchema, output: BoardSchema });
export const emitBoardRpc = defineRpc({ name: "board.emit", input: EmitInputSchema, output: BoardSchema });
export const interactBoardRpc = defineRpc({ name: "board.interact", input: InteractInputSchema, output: InteractionSchema });
export const selectSideAgentRpc = defineRpc({ name: "board.side-agent", input: SelectSideAgentInputSchema, output: BoardSchema });
export const renameBoardRpc = defineRpc({ name: "board.rename", input: RenameInputSchema, output: BoardSchema });
export const editBoardRpc = defineRpc({ name: "board.edit", input: EditInputSchema, output: EditResultSchema });
export const recordDecisionRpc = defineRpc({ name: "board.decision", input: DecisionUpdateInputSchema, output: BoardSchema });
export const saveStateRpc = defineRpc({ name: "board.state", input: StateInputSchema, output: z.object({ saved: z.boolean() }) });
export const markUpdatesSeenRpc = defineRpc({ name: "board.updates-seen", input: MarkUpdatesSeenInputSchema, output: BoardSchema });

export const feedBoardRpc = defineRpc({ name: "board.feed", input: FeedInputSchema, output: FeedResultSchema });

export const boardChangesRpc = defineRpc({ name: "board.changes", input: z.object({ cursor: BoardEventCursorSchema.optional(), compact: z.boolean().optional() }), output: BoardChangesSchema });
export const boardCheckRpc = defineRpc({ name: "board.check", input: z.object({ cursor: BoardEventCursorSchema }), output: z.object({ changed: z.boolean() }) });
