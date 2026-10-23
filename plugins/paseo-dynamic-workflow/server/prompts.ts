import { SIZE_AGENTS, sizeLabel, type ToolGuidance, type WorkflowSize } from "../shared/guidance";

export const PROMPT_MARKER = "## Dynamic workflows (paseo-dynamic-workflow)";

export const OPT_IN = `Because a run can start dozens of agents, launch one only after the user opted in, in one of these ways:
- their current message contains the word "ultracode" (that request only);
- Ultracode is on for you (a notice at the end of this description, the first line of workflow_reference, or the latest launch result or run notification says so);
- they asked for one in their own words, in any language ("use a workflow", "fan out agents", "orchestrate this with subagents", "开个workflow");
- they invoked a skill or command whose instructions say to run one;
- they asked for a built-in or saved workflow by name.
An opt-in covers the whole request, including later workflows for its next phases (verify, design, implement, review). A plugin notification is not an opt-in for a new task. A task that would merely benefit from parallelism does not count: say what you would run and about how many agents it would start, and ask; mention that "use a workflow" or "ultracode" in a later message skips the question. Never turn workflows or Ultracode on for yourself, including through the app; if they are off, ask the user.`;

export function systemPromptCli(cli: string): string {
  return `${PROMPT_MARKER}
The \`${cli}\` command runs a JavaScript orchestration script in the background: \`agent()\`, \`parallel()\`, \`pipeline()\`, \`phase()\` and \`log()\` start and coordinate Paseo agents (any provider) and return their results to the script. ${OPT_IN}
- Before writing a script, run \`${cli} reference\` once for the script API, patterns and resume.
- Launch with \`${cli} run --file script.js [--args-json '{...}'] [--resume <runId>]\`, \`run --script-path <path>\` to iterate, or \`run --name <saved-workflow>\`. Resume inherits saved args unless overridden. It returns at once; a \`<task-notification>\` message from the plugin arrives when the run ends, so end your turn instead of waiting. \`${cli} status [runId]\` reports progress; \`${cli} stop <runId>\` stops a run.`;
}

/** Appended to the workflow tool description (and the MCP instructions) for an agent with Ultracode on. */
export const ULTRACODE_NOTICE = `Ultracode is ON for this agent. The user turned it on in Paseo, and only the user turns it off; never change it yourself. It is a standing opt-in: launch workflows without asking first.
Aim for the most complete, best-checked result you can produce. Spend tokens freely: cost is never a reason to drop coverage, verification or synthesis, and no size guideline applies.
- Substantive tasks (research, review, audit, debugging, design, any change larger than a few lines) get a workflow. Scout inline only until you know the work-list, then launch.
- Multi-phase work gets one workflow per phase: understand, design, implement, review. When a run's notification arrives, read the result and launch the next phase; this opt-in covers it.
- Build each run from the patterns that fit the task. Research, review and audit: cover several angles in parallel, check every claim or finding with independent refuters (three by default, majority decides) or distinct lenses, run a completeness critic whose gaps become another round, repeat until a round adds nothing new, then synthesize with a separate agent. Design: independent proposals scored by a judge panel. Implementation or migration: discover the sites, change each one, then verify each change. One reviewer over everything is not verification. Do not cap children's answers or the number of findings to save tokens; use effort 'low' or 'medium' for mechanical search stages and keep high effort for judges.
- Stay solo for conversation, questions you can answer from context or a couple of reads, status checks, git operations, small mechanical edits, and discussion of a finished run.
Read the Ultracode section of workflow_reference before your first script.`;

export function sizeGuidelineText(size: WorkflowSize): string {
  if (size === "unrestricted") {
    return "Size guideline: none. Size each run to what the request needs. A user who asks for a workflow wants coverage, so by default use several angles in parallel, independent refuters for each claim or finding, a completeness pass and a synthesis. Run small only when the user asks for a quick, brief or cheap run or gives a small budget. Cost words that describe the task's subject (for example \"a tool that saves tokens\") are not a budget.";
  }
  return `Size guideline (set by the user): ${size}, about ${SIZE_AGENTS[size]} agents per run. This is a guideline, not a limit: go beyond it when the request calls for more (an audit, "be thorough", "exhaustive", a token budget such as +500k), never use it as a reason to skip verification the task needs, and log() what you bounded. Only the user changes it.`;
}

/** MCP server instructions for an enabled agent: providers that defer tool descriptions still show these. */
export function mcpInstructions(guidance: ToolGuidance): string {
  const lines = [
    "Dynamic workflows (paseo-dynamic-workflow): the `workflow` tool runs a JavaScript script in the background that fans work out to many Paseo agents (any provider), verifies it and synthesizes the result; a <task-notification> message arrives when the run ends.",
    "Launch one only after the user opted in: the word \"ultracode\" in their message, Ultracode on for you, an explicit request for a workflow in their own words, a skill or command that says to, or a named workflow. Call `workflow_reference` before your first script. Never change your own workflow or Ultracode switches.",
  ];
  if (guidance.ultracode) lines.push(ULTRACODE_NOTICE);
  return lines.join("\n");
}

/**
 * One line restated in every launch result and run notification. Paseo cannot add a reminder to
 * each turn the way Claude Code does, and Codex keeps a stale tool description until a reload,
 * so these appended messages carry the current mode.
 */
export function guidanceReminder(guidance: ToolGuidance): string {
  return guidance.ultracode
    ? "Ultracode is on for you (set by the user): keep the work exhaustive. Verify findings with independent agents, run a completeness critic, use one workflow per phase, and do not fold verification or synthesis into your own turn to save tokens."
    : `Ultracode is off for you: workflows need the user's opt-in; size guideline ${sizeLabel(guidance.size)}.`;
}

/** First line of workflow_reference for one caller; every quoted title is a heading of REFERENCE.md. */
export function referenceStatus(guidance: ToolGuidance): string {
  if (guidance.ultracode) {
    return '> Status for you: Ultracode ON (set by the user). Standing opt-in, thoroughness over cost, no size guideline. Read "Ultracode" first, then "Patterns".';
  }
  const size = guidance.size === "unrestricted"
    ? 'No size guideline: size each run to the request ("Scale").'
    : `Size guideline: ${guidance.size}, about ${SIZE_AGENTS[guidance.size]} agents per run, which the request can override ("Scale").`;
  return `> Status for you: Ultracode off. Launch only on an opt-in ("When you may launch one"). ${size}`;
}

/** Added to a completed run's notification for an Ultracode agent. */
export const ULTRACODE_NEXT_PHASE = "Ultracode is on: read this result, then launch the next phase's workflow (check what it claimed, then design, implement, review) unless the task is finished.";

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

${OPT_IN}

Call workflow_reference before writing your first script: it documents the full API, the Ultracode and scale rules, limits, patterns, resume, and the named workflows you can launch. Built-ins: deep-review (verified multi-dimension code review with a fix plan), deep-research (multi-source research with claims verified by skeptics), design-panel (independent designs scored by judges); launch one with { name, args }.

Every script must begin with \`export const meta = {...}\`, a PURE LITERAL (no variables, calls or interpolation) with \`name\`, a one-line \`description\` and optionally \`phases\` (one { title, detail? } per phase() title). The body is plain JavaScript (not TypeScript), already async, and returns the result. Pass it inline via \`script\`; do not write it to a file first.

Globals: agent(prompt, {label, phase, schema, model, effort, agentType, provider, isolation: 'worktree', cwd}) starts one Paseo agent and resolves with its final text, or with a validated object when \`schema\` (JSON Schema, object at the root) is given, or null when the agent fails or is skipped. pipeline(items, ...stages) runs each item through the stages with no barrier; each stage gets (prev, original, index); a throwing stage makes that item null. parallel(thunks) is a barrier over functions (not promises); a throwing thunk gives null. phase(title), log(message), args, budget {total, spent(), remaining()}, workflow(nameOrRef, args). Date.now(), Math.random() and argless new Date() throw; there is no filesystem or network access.

Canonical pattern (pipeline by default; each dimension's findings are verified as soon as its review finishes, by three independent skeptics each):
  export const meta = { name: 'review-changes', description: 'Review changes across dimensions, verify each finding', phases: [{ title: 'Review' }, { title: 'Verify' }] }
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS_SCHEMA }),
    review => parallel(review.findings.map(f => () =>
      parallel([0, 1, 2].map(i => () => agent('Skeptic ' + (i + 1) + ': try to refute ' + JSON.stringify(f), { label: 'verify:' + f.file, phase: 'Verify', schema: VERDICT_SCHEMA, agentType: 'verification' })))
        .then(votes => ({ ...f, survives: votes.filter(Boolean).filter(v => !v.refuted).length >= 2 })))),
  )
  return { confirmed: results.flat().filter(Boolean).filter(f => f.survives) }

To iterate, edit the script file named in the result and launch again with {scriptPath}; add resumeFromRunId to reuse completed agent() results.`;

export const STATUS_TOOL_DESCRIPTION =
  "Report a dynamic workflow run: status, phases, active agents, recent log lines and, once it ended, the result. Without runId, list your recent runs. waitSeconds (at most 50) waits for the run to end before answering; prefer ending your turn and waiting for the <task-notification>.";

export const STOP_TOOL_DESCRIPTION =
  "Stop a running dynamic workflow: queued agent() calls fail, running child agents are stopped and archived, and the run ends as stopped. Completed results stay in the journal for resumeFromRunId.";

export const REFERENCE_TOOL_DESCRIPTION =
  "Return the dynamic workflow authoring reference for you: your current Ultracode mode and limits, the script API, scale rules, pipeline versus barrier, quality patterns with code, prompts for child agents, resume, and the named workflows you can launch. Read it before writing your first workflow script. It does not itself authorize running a workflow.";
