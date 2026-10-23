import { LABEL_ROLE } from "../shared/ids";
import type { WaitingAgent } from "../shared/types";
import type { PaseoApi } from "./access";

const ORDER: Record<WaitingAgent["reason"], number> = { permission: 0, error: 1, finished: 2 };

/**
 * The user's Paseo agents that are waiting on them: approvals, failures and finished work
 * nobody has looked at. Read from the daemon, so it costs no model call.
 */
export const MAX_FINISHED = 15;

export async function waitingAgents(paseo: PaseoApi): Promise<WaitingAgent[]> {
  const result = await paseo.agents.list({ filter: { requiresAttention: true }, page: { limit: 100 } });
  const waiting: WaitingAgent[] = [];
  for (const { agent, project } of result.entries) {
    if (agent.archivedAt || agent.internal || agent.labels?.[LABEL_ROLE]) continue;
    const pending = agent.pendingPermissions ?? [];
    const reason: WaitingAgent["reason"] = agent.attentionReason ?? (pending.length > 0 ? "permission" : agent.status === "error" ? "error" : "finished");
    const detail = reason === "permission" ? (pending[0]?.title ?? pending[0]?.name ?? null) : reason === "error" ? (agent.lastError ?? null) : null;
    waiting.push({
      agentId: agent.id,
      title: agent.title?.trim() || "Untitled agent",
      project: project?.projectName ?? null,
      reason,
      since: agent.attentionTimestamp ?? agent.updatedAt ?? null,
      detail,
    });
  }
  waiting.sort((a, b) => ORDER[a.reason] - ORDER[b.reason] || (a.since ?? "").localeCompare(b.since ?? ""));
  // Approvals and failures all count; finished work nobody opened is only a hint.
  const blocking = waiting.filter((agent) => agent.reason !== "finished").slice(0, 50);
  return [...blocking, ...waiting.filter((agent) => agent.reason === "finished").slice(0, MAX_FINISHED)];
}
