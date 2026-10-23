import { SIZE_AGENTS, sizeLabel, type ToolGuidance, type WorkflowSize } from "../shared/guidance";

export const PROMPT_MARKER = "## Dynamic workflows (paseo-dynamic-workflow)";

const OPT_IN = `Launch one only when the user opted into multi-agent orchestration. Opt-in means one of: the user's message contains the keyword "ultracode" (that turn only); Ultracode is on for you (this tool's description or \`workflow_reference\` says so); the user asked in their own words ("use a workflow", "fan out agents", "orchestrate this with subagents"); the user invoked a skill or command that says to run one; or the user asked for a named workflow. A task that would merely benefit from parallelism does not count: describe what a workflow would do and roughly what it costs, and ask; mention that "use a workflow" or "ultracode" in a later message skips the ask.`;

export function systemPromptCli(cli: string): string {
  return `${PROMPT_MARKER}
The \`${cli}\` command runs a JavaScript orchestration script in the background: \`agent()\`, \`parallel()\`, \`pipeline()\`, \`phase()\` and \`log()\` start and coordinate Paseo agents (any provider) and return their results to the script. ${OPT_IN}
- Before writing a script, run \`${cli} reference\` once for the script API, patterns and resume.
- Launch with \`${cli} run --file script.js [--args-json '{...}'] [--resume <runId>]\`, \`run --script-path <path>\` to iterate, or \`run --name <saved-workflow>\`. Resume inherits saved args unless overridden. It returns at once; a \`<task-notification>\` message from the plugin arrives when the run ends, so end your turn instead of waiting. \`${cli} status [runId]\` reports progress; \`${cli} stop <runId>\` stops a run.`;
}

/** Appended to the workflow tool description for an agent with Ultracode on. */
export const ULTRACODE_NOTICE = `Ultracode is on for this agent: the user's opt-in is standing. Optimize for the most exhaustive, correct answer, not the fastest or cheapest; token cost is not a constraint and no size guideline applies. Run a workflow for every substantive task (solo only on conversational or trivial turns): decompose and cover in parallel, verify every finding or claim with several independent skeptics, add a completeness critic, loop until a round finds nothing new, then synthesize. For multi-phase work run one workflow per phase (understand, design, implement, review) and read each result before the next. See the Ultracode section of workflow_reference.`;

export function sizeGuidelineText(size: WorkflowSize): string {
  if (size === "unrestricted") return "Workflow size: unrestricted; no size guideline applies. Scale to the request, and when unsure lean toward thoroughness for research, review and audit work.";
  return `Workflow size guideline: ${size}, keep workflows under ${SIZE_AGENTS[size]} agents. This is a guideline, not a hard limit: follow it unless the user's request calls for a different scale (an audit, a "be thorough", a token budget such as "+500k"). The user can change it in the plugin settings or turn on Ultracode for this agent.`;
}

/**
 * One line restated in every launch result and run notification. Paseo cannot add a reminder to
 * each turn the way Claude Code does, and Codex keeps a stale tool description until a reload,
 * so these appended messages carry the current mode.
 */
export function guidanceReminder(guidance: ToolGuidance): string {
  return guidance.ultracode
    ? "Ultracode is on for you: keep the work exhaustive. Verify findings with independent agents, run a completeness critic, use one workflow per phase, and do not fold verification or synthesis into your own turn to save tokens."
    : `Ultracode is off for you: the standard opt-in rule applies; size guideline ${sizeLabel(guidance.size)}.`;
}

export function guidanceText(guidance: ToolGuidance): string {
  return guidance.ultracode ? ULTRACODE_NOTICE : sizeGuidelineText(guidance.size);
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
