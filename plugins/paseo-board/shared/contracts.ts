import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const PLUGIN_ID = "paseo-board";
export const IdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.:-]+$/);
export const JsonDataSchema = z.record(z.string(), z.unknown());
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
export const CanvasPatchSchema = z.object({
  id: IdSchema,
  selector: z.string().min(1).max(1000),
  operation: z.enum(["append", "prepend", "replace", "remove"]),
  html: z.string().max(2000000).default(""),
});
export const CanvasSchema = z.object({
  revision: z.number().int().nonnegative(),
  documentVersion: z.number().int().nonnegative(),
  html: z.string(),
  data: JsonDataSchema,
  patches: z.array(CanvasPatchSchema),
});
export const InteractionSchema = z.object({
  id: IdSchema,
  kind: z.enum(["question", "change", "fork", "return", "reply"]),
  text: z.string().min(1).max(24000),
  anchor: AnchorSchema.optional(),
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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const EventSchema = z.object({ id: IdSchema, source: z.string(), kind: z.string(), summary: z.string(), at: z.string(), revision: z.number(), data: JsonDataSchema.optional() });
export const ObservationSchema = z.object({ id: IdSchema, name: z.string(), value: z.unknown(), evidence: EvidenceSchema, updatedAt: z.string() });
export const BoardSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema, title: z.string(), projectId: z.string().optional(), workspaceId: z.string().optional(), ownerAgentId: z.string().optional(),
  revision: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(),
  canvas: CanvasSchema,
  decisions: z.array(DecisionSchema), interactions: z.array(InteractionSchema), events: z.array(EventSchema), observations: z.array(ObservationSchema),
  userState: JsonDataSchema,
  extraction: z.object({ lastCheckedAt: z.string().optional(), agentId: z.string().optional(), cursor: z.string().optional(), note: z.string().optional() }),
});
export const BoardSummarySchema = BoardSchema.pick({ id: true, title: true, projectId: true, workspaceId: true, ownerAgentId: true, revision: true, createdAt: true, updatedAt: true }).extend({ decisionCount: z.number(), pendingCount: z.number() });
export const CreateInputSchema = z.object({ id: IdSchema.optional(), title: z.string().min(1).max(200), projectId: z.string().optional(), workspaceId: z.string().optional(), ownerAgentId: z.string().optional(), html: z.string().max(4000000).default(""), data: JsonDataSchema.default({}) });
export const PublishInputSchema = z.object({
  boardId: IdSchema, expectedRevision: z.number().int().nonnegative(), eventId: IdSchema,
  title: z.string().min(1).max(200).optional(), ownerAgentId: z.string().optional(),
  html: z.string().max(4000000).optional(), patch: CanvasPatchSchema.optional(), data: JsonDataSchema.optional(),
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
export const EmitInputSchema = z.object({ boardId: IdSchema, eventId: IdSchema, source: z.string().min(1).max(200), kind: z.string().max(200).default("update"), summary: z.string().max(4000), data: JsonDataSchema.optional(), observation: z.object({ id: IdSchema, name: z.string().max(200), value: z.unknown(), evidence: EvidenceSchema }).optional() });
export const InteractInputSchema = z.object({ boardId: IdSchema, intentId: IdSchema, kind: z.enum(["question", "change", "fork", "return", "reply"]), text: z.string().min(1).max(24000), anchor: AnchorSchema.optional(), sourceInteractionId: IdSchema.optional() });
export const DecisionUpdateInputSchema = z.object({ boardId: IdSchema, expectedRevision: z.number().int().nonnegative(), eventId: IdSchema, decision: DecisionInputSchema });
export const StateInputSchema = z.object({ boardId: IdSchema, state: JsonDataSchema });
export type Board = z.infer<typeof BoardSchema>;
export type BoardSummary = z.infer<typeof BoardSummarySchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type Canvas = z.infer<typeof CanvasSchema>;
export type CanvasPatch = z.infer<typeof CanvasPatchSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type DecisionInput = z.infer<typeof DecisionInputSchema>;
export type Interaction = z.infer<typeof InteractionSchema>;
export type CreateInput = z.input<typeof CreateInputSchema>;
export type PublishInput = z.input<typeof PublishInputSchema>;
export type RespondInput = z.input<typeof RespondInputSchema>;
export type EmitInput = z.input<typeof EmitInputSchema>;
export type InteractInput = z.input<typeof InteractInputSchema>;
export type JsonData = z.infer<typeof JsonDataSchema>;

export const listBoardsRpc = defineRpc({ name: "board.list", input: z.object({ workspaceId: z.string().optional() }), output: z.object({ boards: z.array(BoardSummarySchema) }) });
export const readBoardRpc = defineRpc({ name: "board.read", input: z.object({ boardId: IdSchema, sinceRevision: z.number().optional() }), output: z.object({ board: BoardSchema.nullable(), unchanged: z.boolean().default(false) }) });
export const createBoardRpc = defineRpc({ name: "board.create", input: CreateInputSchema, output: BoardSchema });
export const publishBoardRpc = defineRpc({ name: "board.publish", input: PublishInputSchema, output: BoardSchema });
export const emitBoardRpc = defineRpc({ name: "board.emit", input: EmitInputSchema, output: BoardSchema });
export const interactBoardRpc = defineRpc({ name: "board.interact", input: InteractInputSchema, output: InteractionSchema });
export const recordDecisionRpc = defineRpc({ name: "board.decision", input: DecisionUpdateInputSchema, output: BoardSchema });
export const saveStateRpc = defineRpc({ name: "board.state", input: StateInputSchema, output: z.object({ saved: z.boolean() }) });
