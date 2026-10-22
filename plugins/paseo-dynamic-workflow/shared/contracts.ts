import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { RunDetailSchema, RunSummarySchema } from "./run-types";

export const listRunsRpc = defineRpc({
  name: "runs.list",
  input: z.object({ agentId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
  output: z.object({ runs: z.array(RunSummarySchema) }),
});

export const getRunRpc = defineRpc({
  name: "runs.get",
  input: z.object({ runId: z.string() }),
  output: z.object({ run: RunDetailSchema.nullable() }),
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
