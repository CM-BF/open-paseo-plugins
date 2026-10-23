import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { LABEL_ROLE, LABEL_RUN, MCP_SERVER } from "../shared/ids";
import type { PaseoApi } from "./access";
import type { HttpMcpServer } from "./mcp";
import type { Decision } from "./policy";
import { describeError, log, pause } from "./util";

const WAIT_SLICE_MS = 60_000;

/** Providers that take exact MCP tool preapprovals in Paseo 0.12. */
export function supportsToolGrants(provider: string): boolean {
  return /^(claude|codex|opencode)(\/|$)/.test(provider);
}

export function providerFamily(provider: string): string {
  return provider.split("/")[0] ?? provider;
}

/**
 * Permission settings for an unattended, read-only agent. Claude asks for anything beyond reading
 * its folder, and the plugin answers; Codex gets a read-only sandbox that asks before escaping it.
 */
export function readOnlyMode(provider: string): { modeId?: string; options?: Record<string, string> } {
  switch (providerFamily(provider)) {
    case "claude":
      return { modeId: "default" };
    case "codex":
      return { modeId: "auto", options: { sandbox_mode: "read-only", approval_policy: "on-request" } };
    default:
      return {};
  }
}

export interface CheckinAgentInput {
  paseo: PaseoApi;
  agentId: string;
  runId: string;
  cwd: string;
  parentId: string;
  title: string;
  provider: string;
  systemPrompt: string;
  prompt: string;
  mcp: HttpMcpServer;
  grants: { kind: "mcp"; server: string; tool: string }[];
  timeoutMs: number;
  /** Pauses before the second and third attempt to start the agent. */
  retryDelaysMs?: readonly number[];
  signal: AbortSignal;
  decide(request: AgentPermissionRequest): Decision;
}

export interface CheckinAgentResult {
  status: "idle" | "error";
  lastMessage: string | null;
  error: string | null;
}

/**
 * Starts the check-in as a child of the assistant and waits for it to finish. A child agent
 * (one with a parent) never triggers Paseo's attention badge or a phone notification, which
 * is what keeps a check-in that found nothing silent. Permission prompts are answered here as
 * well as by the lifecycle hook, so a missed hook event cannot stall the run.
 */
export async function runCheckinAgent(input: CheckinAgentInput): Promise<CheckinAgentResult> {
  const handle = await createWithRetry(input);
  const startedAt = Date.now();
  const deadline = startedAt + input.timeoutMs;
  for (;;) {
    if (input.signal.aborted) throw new Error("stopped: the plugin is shutting down");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`the check-in ran past its ${Math.round(input.timeoutMs / 60_000)}-minute limit`);
    const result = await handle.waitForFinish(Math.max(1000, Math.min(WAIT_SLICE_MS, remaining)));
    if (result.final?.archivedAt) throw new Error("the check-in agent was archived");
    if (result.status === "timeout") continue;
    if (result.status === "permission") {
      await answerPending(input, handle);
      await pause(1500);
      continue;
    }
    // A turn that has not registered yet reads as idle with no message: give it a moment.
    if (result.status === "idle" && result.lastMessage === null && Date.now() - startedAt < 15_000) {
      await pause(1000);
      continue;
    }
    return {
      status: result.status === "error" ? "error" : "idle",
      lastMessage: result.lastMessage,
      error: result.error ?? result.final?.lastError ?? null,
    };
  }
}

/** Failures that say nothing about the check-in itself: another plugin's slow hook, a dropped connection. */
const TRANSIENT_CREATE = /timed out|before agent\.create failed|DAEMON_CONNECTION_LOST|DAEMON_REQUEST_TIMEOUT|connection (lost|closed)/i;

async function createWithRetry(input: CheckinAgentInput) {
  const mode = readOnlyMode(input.provider);
  const options = {
    agentId: input.agentId,
    cwd: input.cwd,
    parent: input.parentId,
    title: input.title,
    labels: { [LABEL_ROLE]: "checkin", [LABEL_RUN]: input.runId },
    config: {
      provider: input.provider,
      ...(mode.modeId ? { modeId: mode.modeId } : {}),
      ...(mode.options ? { options: mode.options } : {}),
      systemPrompt: input.systemPrompt,
      mcpServers: { [MCP_SERVER]: input.mcp },
      ...(supportsToolGrants(input.provider) ? { toolPolicy: { preapproved: input.grants } } : {}),
    },
    prompt: input.prompt,
  };
  for (let attempt = 1; ; attempt++) {
    try {
      return await input.paseo.agents.create(options);
    } catch (error) {
      const message = describeError(error);
      // A create that failed late may still have made the agent; it is ours by id.
      if (/already exists/i.test(message)) return input.paseo.agents.ref(input.agentId);
      if (attempt >= 3 || input.signal.aborted || !TRANSIENT_CREATE.test(message)) throw error;
      log(`check-in ${input.runId}: starting the agent failed (${message}); retrying`);
      await pause(input.retryDelaysMs?.[attempt - 1] ?? (attempt === 1 ? 3000 : 10_000));
    }
  }
}

async function answerPending(input: CheckinAgentInput, handle: ReturnType<PaseoApi["agents"]["ref"]>): Promise<void> {
  const fresh = await handle.refresh();
  for (const request of fresh?.agent.pendingPermissions ?? []) {
    try {
      await handle.respondToPermission({ requestId: request.id, response: input.decide(request as AgentPermissionRequest) });
    } catch (error) {
      // Usually the hook answered first.
      log(`check-in ${input.runId}: permission ${request.id}: ${describeError(error)}`);
    }
  }
}

export async function archiveQuietly(paseo: PaseoApi, agentId: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await paseo.agents.ref(agentId).archive();
      return;
    } catch (error) {
      if (/not found|unknown agent/i.test(describeError(error))) return;
      if (attempt === 1) log(`could not archive check-in agent ${agentId}: ${describeError(error)}`);
      await pause(1000);
    }
  }
}
