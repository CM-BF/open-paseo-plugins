import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const memoryTargetSchema = z.enum(["user", "memory", "project"]);
export type MemoryTarget = z.output<typeof memoryTargetSchema>;

export const memoryOpSchema = z.object({
  action: z.enum(["add", "patch", "remove"]),
  content: z.string().max(20_000).optional(),
  old_text: z.string().max(20_000).optional(),
});
export type MemoryOp = z.output<typeof memoryOpSchema>;

export const actorSchema = z.object({
  kind: z.enum(["agent", "review", "user", "curator"]),
  agentId: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  runId: z.string().nullable().default(null),
  evidence: z.object({ epoch: z.string(), fromSeq: z.number(), toSeq: z.number() }).optional(),
});
export type Actor = z.output<typeof actorSchema>;

export const projectRefSchema = z.object({ key: z.string(), root: z.string(), name: z.string(), scope: z.enum(["repo", "workspace"]).optional() });
export type ProjectRef = z.output<typeof projectRefSchema>;

export const memoryEntryMetaSchema = z.object({
  id: z.string(), revision: z.string(), contentHash: z.string().optional(), source: z.enum(["legacy", "learned"]), actor: actorSchema.nullable(),
  createdAt: z.string().nullable(), updatedAt: z.string().nullable(), reviewDue: z.string().nullable(),
  state: z.enum(["active", "reference", "archived"]),
});
export type MemoryEntryMeta = z.output<typeof memoryEntryMetaSchema>;
export const memoryStoreViewSchema = z.object({
  target: memoryTargetSchema,
  project: projectRefSchema.nullable(),
  label: z.string(),
  limit: z.number(),
  used: z.number(),
  entries: z.array(z.string()),
  revision: z.string().optional(),
  metadata: z.array(memoryEntryMetaSchema).optional(),
});
export type MemoryStoreView = z.output<typeof memoryStoreViewSchema>;

export const pendingWriteSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  actor: actorSchema,
  target: memoryTargetSchema,
  project: projectRefSchema.nullable(),
  operations: z.array(memoryOpSchema),
  /** Full text of each entry a patch/remove targeted when it was staged (approval refuses if it changed). */
  pinned: z.array(z.string()),
  revision: z.string().optional(),
});
export type PendingWrite = z.output<typeof pendingWriteSchema>;

export const skillStateSchema = z.enum(["active", "stale", "archived"]);
export const skillSummarySchema = z.object({
  name: z.string(),
  category: z.string().nullable(),
  description: z.string(),
  state: skillStateSchema,
  pinned: z.boolean(),
  createdBy: z.enum(["agent", "review", "user", "curator", "unknown"]),
  createdAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  useCount: z.number(),
  viewCount: z.number(),
  patchCount: z.number(),
  revision: z.string().optional(),
  validity: z.enum(["active", "reference", "archived"]).optional(),
  reviewDue: z.string().nullable().optional(),
  source: z.object({ kind: z.enum(["learned", "legacy"]), agentId: z.string().nullable(), runId: z.string().nullable() }).optional(),
  files: z.array(z.string()),
});
export type SkillSummary = z.output<typeof skillSummarySchema>;

export const ledgerEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actor: actorSchema,
  skill: z.string(),
  action: z.string(),
  summary: z.string(),
  files: z.array(z.object({ path: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
  rolledBack: z.boolean(),
});
export type LedgerEntry = z.output<typeof ledgerEntrySchema>;

export const sessionInfoSchema = z.object({
  agentId: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  cwd: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  archived: z.boolean(),
  messageCount: z.number(),
});
export type SessionInfo = z.output<typeof sessionInfoSchema>;

export const sessionMessageSchema = z.object({
  seq: z.number(),
  role: z.enum(["user", "assistant", "tool"]),
  at: z.string().nullable(),
  text: z.string(),
});
export type SessionMessage = z.output<typeof sessionMessageSchema>;

export const searchHitSchema = z.object({
  session: sessionInfoSchema,
  anchor: sessionMessageSchema,
  snippet: z.string(),
});
export type SearchHit = z.output<typeof searchHitSchema>;

export const reviewRunSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentTitle: z.string().nullable(),
  trigger: z.enum(["threshold", "archive", "manual", "curator"]),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(["running", "updated", "nothing", "failed", "staged"]),
  model: z.string().nullable(),
  costUsd: z.number().nullable(),
  actions: z.array(z.string()),
  note: z.string().nullable(),
});
export type ReviewRun = z.output<typeof reviewRunSchema>;

export const routeStatusSchema = z.object({ ok: z.boolean(), providerId: z.string(), detail: z.string() });

const okMessage = z.object({ ok: z.boolean(), message: z.string() });

export const overviewRpc = defineRpc({
  name: "overview.get",
  input: z.object({}),
  output: z.object({
    stateDir: z.string(),
    memory: z.array(z.object({ label: z.string(), used: z.number(), limit: z.number(), entries: z.number() })),
    pending: z.number(),
    skills: z.object({ active: z.number(), stale: z.number(), archived: z.number() }),
    sessions: z.object({ sessions: z.number(), messages: z.number(), lastSyncAt: z.string().nullable() }),
    reviews: z.object({ total: z.number(), lastAt: z.string().nullable(), running: z.number(), queued: z.number().optional() }),
    route: routeStatusSchema,
    boundAgents: z.number(),
    budget: z.object({ day: z.string(), charged: z.number(), reserved: z.number(), limit: z.number() }).optional(),
  }),
});

export const memoryListRpc = defineRpc({
  name: "memory.list",
  input: z.object({}),
  output: z.object({
    stores: z.array(memoryStoreViewSchema),
    pending: z.array(pendingWriteSchema),
  }),
});

export const memoryWriteRpc = defineRpc({
  name: "memory.write",
  input: z.object({
    target: memoryTargetSchema,
    projectKey: z.string().nullable().default(null),
    operations: z.array(memoryOpSchema).min(1).max(50),
  }),
  output: okMessage,
});

export const pendingResolveRpc = defineRpc({
  name: "memory.pending.resolve",
  input: z.object({ id: z.string(), approve: z.boolean() }),
  output: okMessage,
});

export const rememberRpc = defineRpc({
  name: "memory.remember",
  input: z.object({
    text: z.string().min(1).max(4000),
    target: memoryTargetSchema,
    cwd: z.string().nullable().default(null),
    agentId: z.string().nullable().default(null),
  }),
  output: okMessage,
});

export const skillsListRpc = defineRpc({
  name: "skills.list",
  input: z.object({ includeArchived: z.boolean().default(true) }),
  output: z.object({ skills: z.array(skillSummarySchema) }),
});

export const skillViewRpc = defineRpc({
  name: "skills.view",
  input: z.object({ name: z.string(), filePath: z.string().nullable().default(null) }),
  output: z.object({ name: z.string(), filePath: z.string().nullable(), content: z.string(), files: z.array(z.string()) }),
});

export const skillActionRpc = defineRpc({
  name: "skills.action",
  input: z.object({ name: z.string(), action: z.enum(["pin", "unpin", "archive", "restore", "delete", "reference", "activate"]) }),
  output: okMessage,
});

export const ledgerListRpc = defineRpc({
  name: "skills.ledger",
  input: z.object({ skill: z.string().nullable().default(null), limit: z.number().int().min(1).max(500).default(50) }),
  output: z.object({ entries: z.array(ledgerEntrySchema) }),
});

export const ledgerRollbackRpc = defineRpc({
  name: "skills.ledger.rollback",
  input: z.object({ id: z.string() }),
  output: okMessage,
});

export const sessionsSearchRpc = defineRpc({
  name: "sessions.search",
  input: z.object({
    query: z.string().max(500),
    limit: z.number().int().min(1).max(50).default(20),
    sort: z.enum(["relevance", "newest", "oldest"]).default("relevance"),
    scopePath: z.string().nullable().default(null),
  }),
  output: z.object({ hits: z.array(searchHitSchema), recent: z.array(sessionInfoSchema) }),
});

export const sessionsReadRpc = defineRpc({
  name: "sessions.read",
  input: z.object({ agentId: z.string(), aroundSeq: z.number().int().nullable().default(null), window: z.number().int().min(1).max(200).default(30) }),
  output: z.object({ session: sessionInfoSchema.nullable(), messages: z.array(sessionMessageSchema) }),
});

export const sessionsReindexRpc = defineRpc({
  name: "sessions.reindex",
  input: z.object({}),
  output: okMessage,
});

export const reviewsListRpc = defineRpc({
  name: "reviews.list",
  input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
  output: z.object({ runs: z.array(reviewRunSchema) }),
});

export const reviewRunRpc = defineRpc({
  name: "reviews.run",
  input: z.object({ agentId: z.string() }),
  output: okMessage,
});

export const learnRpc = defineRpc({
  name: "learn.start",
  input: z.object({ agentId: z.string(), request: z.string().max(8000) }),
  output: okMessage,
});

export const curatorRunRpc = defineRpc({
  name: "curator.run",
  input: z.object({ consolidate: z.boolean().default(false) }),
  output: okMessage,
});

/** Timeline row written after a background review. */
export const updateRowSchema = z.object({
  runId: z.string(),
  status: z.enum(["running", "updated", "nothing", "failed", "staged"]),
  trigger: z.string(),
  actions: z.array(z.string()),
  model: z.string().nullable(),
  costUsd: z.number().nullable(),
  note: z.string().nullable(),
});
export type UpdateRow = z.output<typeof updateRowSchema>;

export const skillProposalSchema = z.object({
  id: z.string(), createdAt: z.string(), actor: actorSchema,
  revisions: z.record(z.string(), z.string()),
  summary: z.string(),
  diff: z.array(z.object({ name: z.string(), path: z.string(), before: z.string().nullable(), after: z.string().nullable() })),
});
export type SkillProposal = z.output<typeof skillProposalSchema>;
export const skillPendingRpc = defineRpc({ name: "skills.pending", input: z.object({}), output: z.object({ proposals: z.array(skillProposalSchema) }) });
export const skillPendingResolveRpc = defineRpc({ name: "skills.pending.resolve", input: z.object({ id: z.string(), approve: z.boolean() }), output: okMessage });

export const memoryValidityRpc = defineRpc({ name: "memory.validity", input: z.object({ target: memoryTargetSchema, projectKey: z.string().nullable(), id: z.string(), revision: z.string(), state: z.enum(["active", "reference", "archived"]), reviewDue: z.string().nullable() }), output: okMessage });

export const sessionsClearRpc = defineRpc({ name: "sessions.clear", input: z.object({}), output: okMessage });

export const skillValidityRpc = defineRpc({ name: "skills.validity", input: z.object({ name: z.string(), revision: z.string(), validity: z.enum(["active", "reference"]), reviewDue: z.string().nullable() }), output: okMessage });
