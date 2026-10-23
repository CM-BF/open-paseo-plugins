import { SIZE_AGENTS, sizeLabel, type ToolGuidance, type WorkflowSize } from "../shared/guidance";
import { NOTIFICATION_MARKER } from "../shared/notification";

export const PROMPT_MARKER = "## Dynamic workflows (paseo-dynamic-workflow)";

function optIn(ultracodeSource: string): string {
  return `Launch one only after the user opted in: (1) their message contains the word "ultracode" (for that request); (2) Ultracode is on for you (${ultracodeSource}, or the latest launch result or run notification); (3) they asked for a workflow in their own words, in any language ("use a workflow", "split this across agents", "开个workflow"); (4) a skill or command they invoked says to run one; (5) they named a workflow. An opt-in covers the whole request, including its later phases (verify, design, implement, review); a plugin notification is not an opt-in for new work. Otherwise, even when parallel agents would help, say what you would run and roughly how many agents, and ask; "use a workflow" or "ultracode" in a later message skips the question. Never turn workflows or Ultracode on for yourself; ask the user.`;
}

const OPT_IN = optIn("the notice above, the first line of workflow_reference");
const OPT_IN_CLI = optIn("the first line of the reference command's output");

export function systemPromptCli(cli: string): string {
  return `${PROMPT_MARKER}
The \`${cli}\` command runs a JavaScript orchestration script in the background: \`agent()\`, \`parallel()\`, \`pipeline()\`, \`phase()\` and \`log()\` start and coordinate Paseo agents (any provider) and return their results to the script. ${OPT_IN_CLI}
- Before writing a script, run \`${cli} reference\` once for the script API, patterns and resume.
- Launch with \`${cli} run --file script.js [--args-json '{...}'] [--resume <runId>]\`, \`run --script-path <path>\` to iterate, or \`run --name <saved-workflow>\`. Resume inherits saved args unless overridden. It returns at once; a \`<task-notification>\` message from the plugin arrives when the run ends, so end your turn instead of waiting. \`${cli} status [runId]\` reports progress; \`${cli} stop <runId>\` stops a run.`;
}

/** Appended to the workflow tool description (and the MCP instructions) for an agent with Ultracode on. */
export const ULTRACODE_NOTICE = `Ultracode is ON for this agent. The user turned it on in Paseo, and only the user turns it off; never change it yourself. It is a standing opt-in: launch workflows without asking first.
Aim for the most complete, best-checked result you can produce. Spend tokens freely: cost is never a reason to drop coverage, verification or synthesis, and no size guideline applies.
- Hand every substantive task (research, review, audit, debugging, design, any change beyond a few lines) to a workflow. Scout inline only until you know the work-list, then launch.
- Multi-phase work gets one workflow per phase: understand, design, implement, review. When a run's notification arrives, read the result and launch the next phase; this opt-in covers it.
- Build each run from the patterns that fit the task. Research, review and audit: cover several angles in parallel, check every claim or finding with independent refuters (three by default, majority decides) or distinct lenses, run a completeness critic whose gaps become another round, repeat until a round adds nothing new, then synthesize with a separate agent. Design: independent proposals scored by a judge panel. Implementation or migration: discover the sites, change each one, then verify each change. One reviewer over everything is not verification. Do not cap children's answers or the number of findings to save tokens; use effort 'low' or 'medium' for mechanical search stages and keep high effort for judges.
- Stay solo for conversation, questions you can answer from context or a couple of reads, status checks, git operations, small mechanical edits, and discussion of a finished run.
Read the Ultracode section of workflow_reference before your first script.`;

/**
 * The Ultracode text for the head of the workflow tool description and the MCP instructions.
 * Claude Code cuts both at 2048 characters, so it stays short; the details are in the reference.
 */
export const ULTRACODE_SHORT = `Ultracode is ON for this agent (set by the user; never change it yourself). It is a standing opt-in: hand every substantive task (research, review, audit, debugging, design, changes beyond a few lines) to a workflow without asking, and aim for the most complete, best-checked result; cost is never a reason to drop coverage, independent verification or synthesis. One workflow per phase; when a run's notification arrives, launch the next phase. Stay solo for conversation, quick questions, status checks, git operations, small edits and discussing a finished run. Read the Ultracode section of workflow_reference before your first script.`;

export function sizeGuidelineText(size: WorkflowSize): string {
  if (size === "unrestricted") {
    return "Size guideline: none. Size each run to the request. A user who asks for a workflow wants coverage: by default several angles in parallel, independent refuters for each claim or finding, a completeness pass and a synthesis. Go small only when the user asks for a quick, brief or cheap run or a small budget; cost words that describe the task's subject (\"a tool that saves tokens\") are not a budget.";
  }
  return `Size guideline (set by the user): ${size}, about ${SIZE_AGENTS[size]} agents per run. A guideline, not a limit: go beyond it when the request calls for more (an audit, "be thorough", a token budget such as +500k), never skip verification the task needs because of it, and log() what you bounded.`;
}

/** MCP server instructions for an enabled agent: providers that defer tool descriptions still show these. */
export function mcpInstructions(guidance: ToolGuidance): string {
  const lines = [
    "Dynamic workflows (paseo-dynamic-workflow): the `workflow` tool runs a JavaScript script in the background that fans work out to many Paseo agents (any provider), verifies it and synthesizes the result; a <task-notification> message arrives when the run ends.",
    "Launch one only after the user opted in: the word \"ultracode\" in their message, Ultracode on for you, an explicit request for a workflow in their own words, a skill or command that says to, or a named workflow. Call `workflow_reference` before your first script. Never change your own workflow or Ultracode switches.",
  ];
  if (guidance.ultracode) lines.push(ULTRACODE_SHORT);
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

/**
 * Sent once when the user turns Ultracode on or off, like Claude Code's enter and exit reminders.
 * Codex keeps MCP tool descriptions behind tool search, so without this message a Codex agent
 * learns of the mode only after it already chose to look for workflow tools.
 */
export function ultracodeChangeText(on: boolean, workflowsOff = false): string {
  const head = `${NOTIFICATION_MARKER} The user turned Ultracode ${on ? "on" : "off"} for you in Paseo. This message comes from the plugin, not from the user.`;
  if (on) {
    return `${head}\n<ultracode>on</ultracode>\n${ULTRACODE_NOTICE}\nYour workflow tools are in the dynamic_workflow MCP server: workflow, workflow_status, workflow_stop and workflow_reference. If they are not listed among your tools, find them with your tool search. There is nothing to do now: reply only "Ultracode on." and wait for the user's next request.`;
  }
  return `${head}\n<ultracode>off</ultracode>\n${workflowsOff ? "Workflows are also turned off for you: do not launch any." : 'Workflows again need the user\'s opt-in for each request ("use a workflow", or the word "ultracode" in a message).'} Reply only "Ultracode off." and wait for the user's next request.`;
}

/** From this many launches since the user's last message, ask the agent to check in before the next. */
export const CHAIN_CHECK_IN = 4;

export function chainCheckIn(index: number): string {
  return `This is run ${index} you launched since the user's last message. Before launching another, summarize progress for the user and ask whether to continue, unless the plan they approved already covers the next phase.`;
}

/** Added to a completed run's notification for an Ultracode agent. */
export const ULTRACODE_NEXT_PHASE = "Ultracode is on: read this result, then launch the next phase's workflow (check what it claimed, then design, implement, review) unless the task is finished.";

export function guidanceText(guidance: ToolGuidance): string {
  return guidance.ultracode ? ULTRACODE_SHORT : sizeGuidelineText(guidance.size);
}

/** Where the per-agent guidance goes in the workflow tool description: near the top, inside Claude's 2048-character cut. */
export const GUIDANCE_SLOT = "{{workflow-guidance}}";

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

export const WORKFLOW_TOOL_DESCRIPTION = `Run a dynamic workflow: a background JavaScript script that fans work out to many Paseo agents (any provider), verifies it and synthesizes the result. It returns a run id at once; a <task-notification> arrives when the run ends, so end your turn instead of waiting.

${GUIDANCE_SLOT}

${OPT_IN}

Before your first script call workflow_reference (API, rules, patterns, resume). Built-ins ({ name, args }, sized by args.size): deep-review, deep-research, design-panel, critique, verify-claims.

A script starts with \`export const meta = {...}\`, which must be a plain literal (no variables, calls or interpolation) holding \`name\`, a one-line \`description\` and optionally \`phases\` (one { title, detail? } per phase() title). The body is plain JavaScript (not TypeScript), already async, and returns the result. Pass the script text in \`script\`; there is no need to save it to a file first.

Globals: agent(prompt, {label, phase, schema, model, effort, agentType, provider, isolation: 'worktree', cwd, timeoutMinutes}) starts one Paseo agent and resolves with its final text, the validated object for a \`schema\`, or null when it fails or is skipped. pipeline(items, ...stages): no barrier, each stage gets (prev, original, index). parallel(thunks): a barrier over functions. Also phase(), log(), args, budget, guidance {ultracode, size}, workflow(nameOrRef, args). Date.now(), Math.random() and argless new Date() throw; no filesystem or network.

Canonical pattern (pipeline by default: each dimension's findings are verified by three independent skeptics as soon as its review finishes; a failed or cannot_check vote is no vote, and only a majority of the three confirms or refutes):
  export const meta = { name: 'review-changes', description: 'Review the diff per dimension and verify each finding', phases: [{ title: 'Review' }, { title: 'Verify' }] }
  const VERDICT = { type: 'object', required: ['verdict'], properties: { verdict: { enum: ['holds', 'refuted', 'cannot_check'] }, evidence: { type: 'string' } } }
  const count = (votes, v) => votes.filter(x => x && x.verdict === v).length
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS_SCHEMA }),
    review => parallel(review.findings.map((f, n) => () =>
      parallel([1, 2, 3].map(i => () => agent('Skeptic ' + i + ': try to refute ' + JSON.stringify(f) + '; refuted if the evidence does not support it, cannot_check if you could not examine it', { label: 'verify:' + n + ':' + i, phase: 'Verify', schema: VERDICT, agentType: 'verification' })))
        .then(votes => ({ ...f, status: count(votes, 'holds') >= 2 ? 'confirmed' : count(votes, 'refuted') >= 2 ? 'refuted' : 'unverified' })))),
  )
  return { findings: results.flat().filter(Boolean) }

To iterate, edit the script file named in the result and launch again with {scriptPath}; add resumeFromRunId to reuse completed agent() results.`;

export const STATUS_TOOL_DESCRIPTION =
  "Report a dynamic workflow run: status, phases, active agents, recent log lines and, once it ended, the result. Without runId, list your recent runs. waitSeconds (at most 50) waits for the run to end before answering; prefer ending your turn and waiting for the <task-notification>.";

export const STOP_TOOL_DESCRIPTION =
  "Stop a running dynamic workflow: queued agent() calls fail, running child agents are stopped and archived, and the run ends as stopped. Completed results stay in the journal for resumeFromRunId.";

export const REFERENCE_TOOL_DESCRIPTION =
  "Return the dynamic workflow authoring reference for you: your current Ultracode mode and limits, the script API, scale rules, pipeline versus barrier, quality patterns with code, prompts for child agents, resume, and the named workflows you can launch. Read it before writing your first workflow script. It does not itself authorize running a workflow.";
