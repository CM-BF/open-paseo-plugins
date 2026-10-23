import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { AgentCallSchema, RunDetailSchema, RunSummarySchema } from "./run-types";

export const AgentAccessSchema = z.object({
  enabled: z.boolean(),
  cliPath: z.string(),
  providerFamily: z.string().nullable(),
  isWorkflowChild: z.boolean(),
  hasMcpBinding: z.boolean(),
});
export type AgentAccess = z.infer<typeof AgentAccessSchema>;

export const getAgentAccessRpc = defineRpc({
  name: "agent-access.get",
  input: z.object({ agentId: z.string().min(1) }),
  output: AgentAccessSchema,
});

export const setAgentAccessRpc = defineRpc({
  name: "agent-access.set",
  input: z.object({ agentId: z.string().min(1), enabled: z.boolean() }),
  output: AgentAccessSchema,
});

export const listRunsRpc = defineRpc({
  name: "runs.list",
  input: z.object({ agentId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({ runs: z.array(RunSummarySchema) }),
});

export const getRunRpc = defineRpc({
  name: "runs.get",
  input: z.object({ runId: z.string(), compact: z.boolean().optional() }),
  output: z.object({ run: RunDetailSchema.nullable() }),
});

/** Expanded call details are fetched on demand instead of included in live run polling. */
export const getCallRpc = defineRpc({
  name: "runs.get-call",
  input: z.object({ runId: z.string(), callId: z.string() }),
  output: z.object({ call: AgentCallSchema.nullable() }),
});

export const stopRunRpc = defineRpc({
  name: "runs.stop",
  input: z.object({ runId: z.string() }),
  output: z.object({ stopped: z.boolean(), message: z.string() }),
});

export const skipCallRpc = defineRpc({
  name: "runs.skip-call",
  input: z.object({ runId: z.string(), callId: z.string() }),
  output: z.object({ skipped: z.boolean(), message: z.string() }),
});

export const serviceStatusRpc = defineRpc({
  name: "service.status",
  input: z.object({}),
  output: z.object({
    version: z.string(),
    stateDir: z.string(),
    bridgeListening: z.boolean(),
    bridgeError: z.string().nullable(),
    paseoReady: z.boolean(),
    activeRuns: z.number(),
    cliPath: z.string(),
    mcpPath: z.string(),
  }),
});

export const TranscriptEntrySchema = z.object({
  kind: z.enum(["user", "assistant", "tool", "error"]),
  text: z.string(),
  status: z.string().nullable(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const transcriptRpc = defineRpc({
  name: "calls.transcript",
  input: z.object({ agentId: z.string() }),
  output: z.object({ entries: z.array(TranscriptEntrySchema), truncated: z.boolean() }),
});
