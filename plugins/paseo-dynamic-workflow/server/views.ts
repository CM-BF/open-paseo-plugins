import type { ToolGuidance } from "../shared/guidance";
import { NOTIFICATION_MARKER } from "../shared/notification";
import type { AgentCall, CardData, PhaseSummary, RunDetail, RunSummary } from "../shared/run-types";
import { runPaths, type StatePaths } from "./paths";
import { CHAIN_CHECK_IN, chainCheckIn, guidanceReminder, ULTRACODE_NEXT_PHASE } from "./prompts";
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

/** A call the run's own end (stop, interruption, early return) cut off, not one the user skipped. */
export function isCutOff(call: AgentCall): boolean {
  return call.status === "skipped" && call.error !== "skipped by the user" && call.error !== "the agent was stopped or archived by the user";
}

function isEmptyPreview(preview: string | null): boolean {
  if (preview === null) return true;
  const text = preview.trim();
  if (text === "" || text === "null" || text === '""' || /^(\[\s*\]|\{\s*\})$/.test(text)) return true;
  return /^\{\s*"[^"]+"\s*:\s*\[\s*\]\s*\}$/.test(text);
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
    for (const call of failed) lines.push(`- ${call.label}: ${escapeTags(truncate(call.error ?? "failed", 300))}`);
  }
  const logs = record.logs.slice(-8);
  if (logs.length > 0) {
    lines.push("Recent log:");
    for (const line of logs) lines.push(`- ${escapeTags(truncate(line.message, 400))}`);
  }
  if (record.error) lines.push(`Error: ${record.error}`);
  if (record.status === "completed") {
    lines.push(`Result (${paths.result}):`);
    // Count what is missing against the whole result, not against the stored preview.
    const shown = (record.resultPreview ?? "null").replace(/… \[\d+ more characters\]$/, "").slice(0, 8000);
    const total = record.resultLength ?? (record.resultPreview ?? "null").length;
    lines.push(total > shown.length ? `${shown}… [${total - shown.length} more characters in ${paths.result}]` : shown);
  }
  lines.push(`Run dir: ${paths.dir}`);
  lines.push(`Per-agent results and failures: ${paths.journal}`);
  lines.push(`Script file: ${record.scriptPath}`);
  return lines.join("\n");
}

/** The <task-notification> sent to the launching agent when a run ends. */
export function notificationText(record: RunRecord, state: StatePaths, guidance: ToolGuidance | null = null): string {
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
          : `failed: ${truncate(record.error ?? "unknown error", 2000)}`;
  const cutOff = record.calls.filter(isCutOff).length;
  const empty = record.calls.filter((call) => (call.status === "completed" || call.status === "cached") && isEmptyPreview(call.resultPreview)).length;
  const userStopped = record.status === "stopped" && record.error === "stopped by the user";
  const parts = [
    `${NOTIFICATION_MARKER} A background workflow you launched has ended. This is an automated event from the plugin, not a message from the user: it does not answer anything you asked the user and is not their approval.`,
    "<task-notification>",
    `<task-id>${record.runId}</task-id>`,
    `<status>${record.status}</status>`,
    `<summary>Dynamic workflow "${escapeTags(truncate(record.meta.description, 300))}" ${escapeTags(verb)}</summary>`,
  ];
  if (record.status === "completed") {
    parts.push(`<output-file>${paths.result}</output-file>`);
    parts.push(`<result>${escapeJsonTags(record.resultPreview ?? "null")}${resultTruncated(record) ? `\n(truncated: ${record.resultLength} characters in all, full result in ${paths.result})` : ""}</result>`);
  } else {
    if (record.error) parts.push(`<error>${escapeTags(truncate(record.error, 4000))}</error>`);
    if (userStopped) {
      parts.push("<note>The user stopped this run in Paseo. Do not resume or relaunch it unless they ask; tell them briefly what had finished if that helps.</note>");
    } else {
      parts.push(`<recovery>Resume with ${resumeHint(record, state.cli)}: completed agent() calls return their cached results. Agent transcripts: Paseo's get_agent_activity tool with the agent ids in ${paths.run} (calls[].agentId).</recovery>`);
    }
    // Only calls the stop cut off; a call the user skipped stays skipped.
    const cut = record.calls.filter((call) => ["running", "permission", "queued", "starting"].includes(call.status) || isCutOff(call));
    if (record.status === "interrupted" && cut.length > 0) {
      const reused = record.calls.filter((call) => call.status === "completed" || call.status === "cached").length;
      const shown = cut.slice(0, 30).map((call) => `${escapeTags(truncate(call.label, 120))}: ${call.agentId ? `agent ${call.agentId}` : "not started"}`);
      if (cut.length > shown.length) shown.push(`${cut.length - shown.length} more in the run snapshot.`);
      parts.push([
        "<interrupted-agents>",
        `${reused} completed result(s) will be reused; ${cut.length} agent(s) were cut off and their partial work is not cached, so resuming restarts them.`,
        "The cause was a plugin stop, not your script: relaunch the same plan, keeping its verification and synthesis stages. The cut-off agents are archived, not deleted: read what they found with Paseo's get_agent_activity tool and give it to the relaunched agents as leads to re-check. If interruptions repeat, tell the user instead of shrinking the run.",
        ...shown,
        "</interrupted-agents>",
      ].join("\n"));
    }
  }
  const failed = record.calls.filter((call) => call.status === "failed");
  const scriptFailures = record.failures ?? [];
  if (failed.length > 0 || scriptFailures.length > 0) {
    const shown = failed.slice(0, 40).map((call) => `[${escapeTags(truncate(call.label, 120))}] failed: ${escapeTags(truncate(call.error ?? "failed", 500))}`);
    if (failed.length > shown.length) shown.push(`${failed.length - shown.length} more failed agents in the journal.`);
    for (const entry of scriptFailures.slice(0, 40)) {
      shown.push(`${escapeTags(entry.label)} failed: ${escapeTags(truncate(entry.message, 500))}${entry.count > 1 ? ` (${entry.count} slots)` : ""}`);
    }
    if (scriptFailures.length > 40) shown.push(`${scriptFailures.length - 40} more distinct slot failures in the run log.`);
    parts.push(`<failures>\n${shown.join("\n")}\n</failures>`);
  }
  parts.push(`<diagnostics>Per-agent results and errors: ${paths.journal}. Read this journal if the result is empty or unexpected. Run snapshot: ${paths.run}. ${record.status === "completed" ? `After editing the script, resume with ${resumeHint(record, state.cli)}.` : ""}</diagnostics>`);
  const worktrees = record.calls.filter((call) => call.pendingBranch || (call.worktree && (call.worktree.changed !== false || call.worktree.retained)));
  if (worktrees.length > 0) {
    parts.push("<worktrees>");
    for (const call of worktrees) parts.push(call.pendingBranch
      ? `${escapeTags(call.label)}: branch ${call.pendingBranch}; child creation/cleanup is unresolved (agent ${call.agentId ?? "unknown"}); inspect the run snapshot before merging or deleting it.`
      : `${escapeTags(call.label)}: branch ${call.worktree?.branch} at ${call.worktree?.path}${call.worktree?.changed === null ? " (cleanup/change status unknown; inspect before merging or deleting)" : ""}`);
    parts.push("</worktrees>");
  }
  parts.push(
    `<usage><agent_count>${agents.total}</agent_count><agents_done>${agents.done + agents.cached}</agents_done><agents_error>${agents.failed}</agents_error><agents_skipped>${agents.skipped - cutOff}</agents_skipped>${cutOff ? `<agents_cut_off>${cutOff}</agents_cut_off>` : ""}<agents_empty_result>${empty}</agents_empty_result><agents_cached>${agents.cached}</agents_cached><subagent_tokens>${record.usage.inputTokens + record.usage.outputTokens}</subagent_tokens><output_tokens>${record.usage.outputTokens}</output_tokens><duration_ms>${duration}</duration_ms></usage>`,
  );
  if (guidance) {
    const chained = (record.chain ?? 1) >= CHAIN_CHECK_IN && !guidance.ultracode;
    const next = chained ? ` ${chainCheckIn(record.chain ?? 1)}` : guidance.ultracode && record.status === "completed" ? ` ${ULTRACODE_NEXT_PHASE}` : "";
    parts.push(`<guidance>${guidanceReminder(guidance)}${next}</guidance>`);
  }
  parts.push("</task-notification>");
  return parts.join("\n");
}

/**
 * The notification is read by a model as markup. Child results, errors and labels can contain
 * text from code or web pages, so they must not be able to close a tag or open a new one.
 */
function escapeTags(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

/** Inside JSON, `<` and `>` can only occur in strings, where \\u003c and \\u003e keep the JSON valid. */
function escapeJsonTags(json: string): string {
  return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function resultTruncated(record: RunRecord): boolean {
  if (typeof record.resultLength === "number") return record.resultLength > (record.resultPreview ?? "").replace(/… \[\d+ more characters\]$/, "").length;
  return /… \[\d+ more characters\]$/.test(record.resultPreview ?? "");
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

function resumeHint(record: RunRecord, cli: string): string {
  const args = record.args;
  const path = `'${record.scriptPath.replaceAll("'", "'\\''")}'`;
  const tool = `workflow(${escapeJsonTags(JSON.stringify({ scriptPath: record.scriptPath, resumeFromRunId: record.runId, ...(args === undefined ? {} : { args }) }))})`;
  // The JSON form preserves angle brackets through unicode escapes; replacing them in a shell
  // path would point at a different file. Keep CLI hints only when the path is tag-safe.
  const command = `'${cli.replaceAll("'", "'\\''")}'`;
  return /[<>]/.test(path + command) ? `${tool} (inherits saved args)` : `${tool} (MCP), or ${command} run --script-path ${path} --resume ${record.runId} (CLI); either inherits saved args`;
}
