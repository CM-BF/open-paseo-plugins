import { NOTIFICATION_MARKER } from "../shared/notification";
import type { AgentCall, CardData, PhaseSummary, RunDetail, RunSummary } from "../shared/run-types";
import { runPaths, type StatePaths } from "./paths";
import type { RunRecord } from "./run-store";
import { formatDuration, truncate } from "./util";

const UNGROUPED = "Agents";

export function phaseSummaries(record: RunRecord): PhaseSummary[] {
  const details = new Map((record.meta.phases ?? []).map((phase) => [phase.title, phase.detail ?? null]));
  const order = [...record.phaseOrder];
  const byPhase = new Map<string, AgentCall[]>();
  for (const call of record.calls) {
    const title = call.phase ?? UNGROUPED;
    if (!order.includes(title)) order.push(title);
    const list = byPhase.get(title) ?? [];
    list.push(call);
    byPhase.set(title, list);
  }
  return order.map((title) => {
    const calls = byPhase.get(title) ?? [];
    return {
      title,
      detail: details.get(title) ?? null,
      total: calls.length,
      running: calls.filter(isRunning).length,
      queued: calls.filter((call) => call.status === "queued").length,
      done: calls.filter((call) => call.status === "completed" || call.status === "cached").length,
      failed: calls.filter((call) => call.status === "failed").length,
      skipped: calls.filter((call) => call.status === "skipped").length,
    };
  });
}

function isRunning(call: AgentCall): boolean {
  return call.status === "starting" || call.status === "running" || call.status === "permission";
}

function counts(record: RunRecord): RunSummary["agents"] {
  return {
    total: record.calls.length,
    running: record.calls.filter(isRunning).length,
    queued: record.calls.filter((call) => call.status === "queued").length,
    done: record.calls.filter((call) => call.status === "completed").length,
    failed: record.calls.filter((call) => call.status === "failed").length,
    skipped: record.calls.filter((call) => call.status === "skipped").length,
    cached: record.calls.filter((call) => call.status === "cached").length,
  };
}

export function runSummary(record: RunRecord): RunSummary {
  return {
    runId: record.runId,
    name: record.meta.name,
    description: record.meta.description,
    status: record.status,
    parentAgentId: record.parentAgentId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    agents: counts(record),
    error: record.error,
  };
}

export function runDetail(record: RunRecord, state: StatePaths): RunDetail {
  const paths = runPaths(state, record.runId);
  return {
    ...runSummary(record),
    whenToUse: record.meta.whenToUse ?? null,
    workspaceId: record.workspaceId,
    cwd: record.cwd,
    scriptPath: record.scriptPath,
    runDir: paths.dir,
    journalPath: paths.journal,
    resumedFrom: record.resumedFrom,
    phases: phaseSummaries(record),
    calls: record.calls,
    logs: record.logs.slice(-100),
    resultPreview: record.resultPreview,
    resultPath: record.status === "completed" ? paths.result : null,
    usage: record.usage,
    budget: { total: record.budgetTotal, spent: record.usage.outputTokens },
  };
}

/** Polling payload: full call results and errors belong to the expanded row only. */
export function compactRunDetail(detail: RunDetail): RunDetail {
  return {
    ...detail,
    calls: detail.calls.map((call) => ({ ...call, resultPreview: null, error: null })),
    logs: detail.logs.slice(-20).map((line) => ({ ...line, message: truncate(line.message, 240) })),
  };
}

export function cardData(record: RunRecord): CardData {
  const active = record.calls
    .filter((call) => call.status === "starting" || call.status === "running" || call.status === "permission")
    .slice(0, 8)
    .map((call) => ({
      callId: call.callId,
      label: truncate(call.label, 80),
      phase: call.phase,
      status: call.status,
      startedAt: call.startedAt,
      agentId: call.agentId,
    }));
  return {
    runId: record.runId,
    name: record.meta.name,
    description: truncate(record.meta.description, 300),
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    phases: phaseSummaries(record)
      .slice(0, 30)
      .map((phase) => ({ ...phase, title: truncate(phase.title, 120), detail: phase.detail === null ? null : truncate(phase.detail, 200) })),
    active,
    agents: counts(record),
    logs: record.logs.slice(-3).map((line) => truncate(line.message, 240)),
    resultPreview: record.resultPreview === null ? null : truncate(record.resultPreview, 600),
    error: record.error === null ? null : truncate(record.error, 600),
    usage: record.usage,
  };
}

/** The text the status and stop tools return. */
export function statusText(record: RunRecord, state: StatePaths): string {
  const paths = runPaths(state, record.runId);
  const end = record.endedAt ? Date.parse(record.endedAt) : Date.now();
  const elapsed = formatDuration(end - Date.parse(record.startedAt));
  const agents = counts(record);
  const lines = [
    `Workflow "${record.meta.name}" (run ${record.runId}): ${record.status}, ${elapsed}`,
    `Agents: ${agents.total} total, ${agents.running} running, ${agents.queued} queued, ${agents.done} done, ${agents.cached} cached, ${agents.failed} failed, ${agents.skipped} skipped`,
    `Output tokens: ${record.usage.outputTokens}${record.budgetTotal !== null ? ` of a ${record.budgetTotal} budget` : ""}`,
  ];
  const phases = phaseSummaries(record);
  if (phases.length > 0) {
    lines.push("Phases:");
    for (const phase of phases) {
      lines.push(`- ${phase.title}: ${phase.done}/${phase.total} done${phase.running ? `, ${phase.running} running` : ""}${phase.queued ? `, ${phase.queued} queued` : ""}${phase.failed ? `, ${phase.failed} failed` : ""}${phase.skipped ? `, ${phase.skipped} skipped` : ""}`);
    }
  }
  const running = record.calls.filter(isRunning).slice(0, 10);
  if (running.length > 0) {
    lines.push("Active agents:");
    for (const call of running) lines.push(`- ${call.label} [${call.status}]${call.agentId ? ` agent ${call.agentId}` : ""}`);
  }
  const failed = record.calls.filter((call) => call.status === "failed").slice(-5);
  if (failed.length > 0) {
    lines.push("Recent failures:");
    for (const call of failed) lines.push(`- ${call.label}: ${truncate(call.error ?? "failed", 300)}`);
  }
  const logs = record.logs.slice(-8);
  if (logs.length > 0) {
    lines.push("Recent log:");
    for (const line of logs) lines.push(`- ${truncate(line.message, 400)}`);
  }
  if (record.error) lines.push(`Error: ${record.error}`);
  if (record.status === "completed") {
    lines.push(`Result (${paths.result}):`);
    lines.push(truncate(record.resultPreview ?? "null", 8000));
  }
  lines.push(`Run dir: ${paths.dir}`);
  lines.push(`Per-agent results and failures: ${paths.journal}`);
  lines.push(`Script file: ${record.scriptPath}`);
  return lines.join("\n");
}

/** The <task-notification> sent to the launching agent when a run ends. */
export function notificationText(record: RunRecord, state: StatePaths): string {
  const paths = runPaths(state, record.runId);
  const agents = counts(record);
  const duration = record.endedAt ? Date.parse(record.endedAt) - Date.parse(record.startedAt) : 0;
  const verb =
    record.status === "completed"
      ? "completed"
      : record.status === "stopped"
        ? "was stopped"
        : record.status === "interrupted"
          ? "was interrupted"
          : `failed: ${firstLine(record.error ?? "unknown error")}`;
  const parts = [
    `${NOTIFICATION_MARKER} A background workflow you launched has ended. This message comes from the plugin, not from the user.`,
    "<task-notification>",
    `<task-id>${record.runId}</task-id>`,
    `<status>${record.status}</status>`,
    `<summary>Dynamic workflow "${record.meta.name}" ${verb}</summary>`,
  ];
  if (record.status === "completed") {
    parts.push(`<output-file>${paths.result}</output-file>`);
    parts.push(`<result>${record.resultPreview ?? "null"}${(record.resultPreview ?? "").includes("more characters]") ? `\n(full result in ${paths.result})` : ""}</result>`);
  } else {
    if (record.error) parts.push(`<error>${truncate(record.error, 4000)}</error>`);
    parts.push(`<recovery>Resume with ${resumeHint(record)}: completed agent() calls return their cached results.</recovery>`);
  }
  const failed = record.calls.filter((call) => call.status === "failed");
  if (failed.length > 0) {
    const shown = failed.slice(0, 20).map((call) => `${truncate(call.label, 120)}: ${truncate(call.error ?? "failed", 500)}`);
    if (failed.length > shown.length) shown.push(`${failed.length - shown.length} more failures in the journal.`);
    parts.push(`<failures>\n${shown.join("\n")}\n</failures>`);
  }
  parts.push(`<diagnostics>Per-agent results and errors: ${paths.journal}. Read this journal if the result is empty or unexpected. Run snapshot: ${paths.run}. ${record.status === "completed" ? `After editing the script, resume with ${resumeHint(record)}.` : ""}</diagnostics>`);
  const worktrees = record.calls.filter((call) => call.pendingBranch || (call.worktree && (call.worktree.changed !== false || call.worktree.retained)));
  if (worktrees.length > 0) {
    parts.push("<worktrees>");
    for (const call of worktrees) parts.push(call.pendingBranch
      ? `${call.label}: branch ${call.pendingBranch}; child creation/cleanup is unresolved (agent ${call.agentId ?? "unknown"}); inspect the run snapshot before merging or deleting it.`
      : `${call.label}: branch ${call.worktree?.branch} at ${call.worktree?.path}${call.worktree?.changed === null ? " (cleanup/change status unknown; inspect before merging or deleting)" : ""}`);
    parts.push("</worktrees>");
  }
  parts.push(
    `<usage><agent_count>${agents.total}</agent_count><cached>${agents.cached}</cached><failed>${agents.failed}</failed><skipped>${agents.skipped}</skipped><output_tokens>${record.usage.outputTokens}</output_tokens><input_tokens>${record.usage.inputTokens}</input_tokens><duration_ms>${duration}</duration_ms></usage>`,
  );
  parts.push("</task-notification>");
  return parts.join("\n");
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

function resumeHint(record: RunRecord): string {
  const args = record.args;
  const path = `'${record.scriptPath.replaceAll("'", "'\\''")}'`;
  return `workflow(${JSON.stringify({ scriptPath: record.scriptPath, resumeFromRunId: record.runId, ...(args === undefined ? {} : { args }) })}) or paseo-workflow run --script-path ${path} --resume ${record.runId} (inherits saved args)`;
}
