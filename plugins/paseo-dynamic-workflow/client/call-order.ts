import type { AgentCall } from "../shared/run-types";

/** Keep calls that need attention visible while completed calls accumulate. */
export function callsByAttention(calls: readonly AgentCall[]): AgentCall[] {
  const priority = (call: AgentCall) => {
    if (call.status === "starting" || call.status === "running" || call.status === "permission") return 0;
    if (call.status === "failed") return 1;
    if (call.status === "queued") return 2;
    return 3;
  };
  return [...calls].sort((a, b) => priority(a) - priority(b));
}
