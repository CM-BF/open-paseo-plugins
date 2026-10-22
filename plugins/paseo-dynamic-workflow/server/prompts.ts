export const PROMPT_MARKER = "## Dynamic workflows (paseo-dynamic-workflow)";

const OPT_IN = `Only launch one when the user explicitly opted into multi-agent orchestration: they asked in their own words ("use a workflow", "fan out agents", "orchestrate this with subagents"), invoked a skill or command that says to run one, or asked for a named workflow. A task that would merely benefit from parallelism does not count: describe what a workflow would do and roughly what it costs, and ask.`;

export function systemPromptMcp(): string {
  return `${PROMPT_MARKER}
The \`workflow\` tool runs a JavaScript orchestration script in the background: \`agent()\`, \`parallel()\`, \`pipeline()\`, \`phase()\` and \`log()\` start and coordinate Paseo agents (any provider) and return their results to the script. ${OPT_IN}
- Before writing a script, call \`workflow_reference\` once for the script API, patterns and resume.
- The tool returns at once. A \`<task-notification>\` message from the plugin arrives when the run ends: end your turn instead of waiting. \`workflow_status\` reports progress; \`workflow_stop\` stops a run.`;
}

export function systemPromptCli(cli: string): string {
  return `${PROMPT_MARKER}
The \`${cli}\` command runs a JavaScript orchestration script in the background: \`agent()\`, \`parallel()\`, \`pipeline()\`, \`phase()\` and \`log()\` start and coordinate Paseo agents (any provider) and return their results to the script. ${OPT_IN}
- Before writing a script, run \`${cli} reference\` once for the script API, patterns and resume.
- Launch with \`${cli} run --file script.js [--args-json '{...}'] [--resume <runId>]\`, \`run --script-path <path>\` to iterate, or \`run --name <saved-workflow>\`. Resume inherits saved args unless overridden. It returns at once; a \`<task-notification>\` message from the plugin arrives when the run ends, so end your turn instead of waiting. \`${cli} status [runId]\` reports progress; \`${cli} stop <runId>\` stops a run.`;
}

export function appendPrompt(existing: string | undefined, block: string): string {
  if (existing?.includes(PROMPT_MARKER)) return replacePrompt(existing, block);
  return existing?.trim() ? `${existing.trimEnd()}\n\n${block}` : block;
}

/** Replaces our block (from the marker to the next heading of the same level or the end). */
export function replacePrompt(existing: string, block: string): string {
  const start = existing.indexOf(PROMPT_MARKER);
  if (start < 0) return appendPrompt(existing, block);
  const rest = existing.slice(start + PROMPT_MARKER.length);
  const next = rest.search(/\n## /);
  const end = next < 0 ? existing.length : start + PROMPT_MARKER.length + next;
  return `${existing.slice(0, start)}${block}${existing.slice(end)}`;
}

export const WORKFLOW_TOOL_DESCRIPTION = `Execute a workflow script that orchestrates multiple Paseo agents deterministically. The run happens in the background: this tool returns immediately with a run id, and a <task-notification> message arrives when the workflow ends (end your turn rather than waiting). The user watches progress in the run card and the Dynamic workflows panel.

${OPT_IN} Workflows can start dozens of agents and spend a lot of tokens.

Call workflow_reference before writing your first script: it documents the full API, limits, patterns and resume.

Every script must begin with \`export const meta = {...}\`, a PURE LITERAL (no variables, calls or interpolation) with \`name\`, a one-line \`description\` and optionally \`phases\` (one { title, detail? } per phase() title). The body is plain JavaScript (not TypeScript), already async, and returns the result. Pass it inline via \`script\`; do not write it to a file first.

Globals: agent(prompt, {label, phase, schema, model, effort, agentType, provider, isolation: 'worktree', cwd}) starts one Paseo agent and resolves with its final text, or with a validated object when \`schema\` (JSON Schema, object at the root) is given, or null when the agent fails or is skipped. pipeline(items, ...stages) runs each item through the stages with no barrier; each stage gets (prev, original, index); a throwing stage makes that item null. parallel(thunks) is a barrier over functions (not promises); a throwing thunk gives null. phase(title), log(message), args, budget {total, spent(), remaining()}, workflow(nameOrRef, args). Date.now(), Math.random() and argless new Date() throw; there is no filesystem or network access.

Canonical pattern (pipeline by default; each review verifies as soon as it finishes):
  export const meta = { name: 'review-changes', description: 'Review changes across dimensions, verify each finding', phases: [{ title: 'Review' }, { title: 'Verify' }] }
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS_SCHEMA }),
    review => parallel(review.findings.map(f => () =>
      agent('Try to refute: ' + f.title, { label: 'verify:' + f.file, phase: 'Verify', schema: VERDICT_SCHEMA })
        .then(v => ({ ...f, verdict: v })))),
  )
  return { confirmed: results.flat().filter(Boolean).filter(f => f.verdict && f.verdict.isReal) }

To iterate, edit the script file named in the result and launch again with {scriptPath}; add resumeFromRunId to reuse completed agent() results.`;

export const STATUS_TOOL_DESCRIPTION =
  "Report a dynamic workflow run: status, phases, active agents, recent log lines and, once it ended, the result. Without runId, list your recent runs. waitSeconds (at most 50) waits for the run to end before answering; prefer ending your turn and waiting for the <task-notification>.";

export const STOP_TOOL_DESCRIPTION =
  "Stop a running dynamic workflow: queued agent() calls fail, running child agents are stopped and archived, and the run ends as stopped. Completed results stay in the journal for resumeFromRunId.";

export const REFERENCE_TOOL_DESCRIPTION =
  "Return the dynamic workflow authoring reference: script API and options, limits, pipeline versus barrier, quality patterns, prompts for child agents, and resume. Read it before writing your first workflow script. It does not itself authorize running a workflow.";
