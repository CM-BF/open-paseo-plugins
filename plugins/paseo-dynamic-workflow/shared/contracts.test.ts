import { expect, it } from "vitest";
import { z } from "zod";
import { AgentAccessSchema, setAgentAccessRpc } from "./contracts";

// The shapes the previous release used, frozen here to check both directions of a version skew.
const OldAccess = z.object({ enabled: z.boolean(), cliPath: z.string(), providerFamily: z.string().nullable(), isWorkflowChild: z.boolean(), hasMcpBinding: z.boolean() });
const OldSetInput = z.object({ agentId: z.string().min(1), enabled: z.boolean() });
const base = { enabled: true, cliPath: "/x", providerFamily: "codex", isWorkflowChild: false, hasMcpBinding: true };

it("tolerates an old client or an old server around the access RPC", () => {
  expect(OldAccess.parse({ ...base, ultracode: true })).toEqual(base);
  expect(AgentAccessSchema.parse(base)).toEqual({ ...base, ultracode: false });
  expect(setAgentAccessRpc.input.parse({ agentId: "a", enabled: true })).toEqual({ agentId: "a", enabled: true });
  expect(setAgentAccessRpc.input.parse({ agentId: "a", ultracode: true })).toEqual({ agentId: "a", ultracode: true });
  // Rolling back the server makes an Ultracode-only request fail loudly instead of disabling the agent.
  expect(OldSetInput.safeParse({ agentId: "a", ultracode: true }).success).toBe(false);
});
