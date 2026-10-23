import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const transferSchema = z.object({
  mainAgentId: z.string(),
  fallbackAgentId: z.string(),
  phase: z.string(),
  message: z.string(),
});

export type TransferData = z.output<typeof transferSchema>;

export const statusRpc = defineRpc({
  name: "fallback.status",
  input: z.object({}),
  output: z.object({
    enabled: z.boolean(),
    fallbackModel: z.string(),
    fallbackThinking: z.string(),
    agents: z.array(
      z.object({
        agentId: z.string(),
        mainProvider: z.string().optional(),
        mainModel: z.string(),
        mainThinking: z.string().nullable(),
        fallbackAgentId: z.string().nullable().optional(),
        transferKind: z.enum(["model", "fork"]).optional(),
        phase: z.string(),
        resetAt: z.number().nullable(),
        lastError: z.string().nullable(),
      }),
    ),
    error: z.string().nullable(),
  }),
});

export const configureRpc = defineRpc({
  name: "fallback.configure",
  input: z.object({ enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean() }),
});
