export const PROMPT_MARKER = "## Paseo Board — persistent interactive conversation";
export const PROMPT_END = "<!-- /paseo-board-instructions -->";

export function boardInstructions(cli: string, skill: string): string {
  return `${PROMPT_MARKER}
Paseo Board is a general, live, interactive visualize, not a task-specific dashboard. When a visual shared surface helps this task, use board_create/read/publish/respond/decision/emit (MCP) or ${cli}. Read ${skill} for the canvas API. The canvas is yours: arbitrary HTML/CSS/JS, SVG/Canvas, animations, simulations, controls and task-specific layouts; keep ordinary controls fully interactive. User questions can be answered by adding an animation or component exactly where they pointed.
Publish complete HTML from an absolute htmlFile, or patch a stable selector to preserve other controls; data-only updates use an open JSON object. Read the latest board revision before a publish. Record important defaults YOU chose (scope, compatibility, budget, assumptions, consequential dependencies) with rationale and evidence, not the user's decisions or hidden reasoning. Inferred candidates are not facts. Board intents include frozen selection/version context: recheck stale anchors and link the resulting canvas/artifact to interactionResult, never equate delivery with application.
Waiting and event sources belong to paseo-async-shell. Its script can call ${cli} emit using stable eventId values while you are idle. Board emit only saves data; use async-shell sendback selectively if explanation/action is required. Do not poll the board or wake yourself in a loop. Ordinary progress updates the board silently. Explicit processing receipts may continue across completed turns while background work runs. The user chooses routing: Enter sends to the main owner, Command/Control+Enter reuses the selected side (or creates one), and Command/Control+Option/Alt+Enter creates and selects a new side. Historical associated forks can be selected by the user; do not change ownership or side routing from agent tools. A fork is a separate conversation context on the same shared Board, like /btw. Fulfill the user's change requests directly with board_publish; use board_decision for your defaults and board_emit for external updates. No return to the owner is required. Use board_respond for text or fully interactive explanations at your assigned marker. Preserve Board ownership and other agents' interaction receipts; chat text is only a fallback.
CLI accepts: ${cli} <list|read|create|publish|respond|decision|emit> --file /absolute/input.json; --json '{...}' or JSON on stdin also work. No shell escaping is required with --file. Existing sessions without MCP can use the absolute CLI path. Local CLI is trusted same-user access; a session binding narrows it to that agent's boards.
${PROMPT_END}`;
}

export function replaceInstructions(original: string, block: string): string {
  const start = original.indexOf(PROMPT_MARKER);
  const end = start >= 0 ? original.indexOf(PROMPT_END, start) : -1;
  if (start >= 0 && end >= start) return `${original.slice(0, start)}${block}${original.slice(end + PROMPT_END.length)}`;
  return `${original}${original ? "\n\n" : ""}${block}`;
}

export function skillMarkdown(cli: string): string {
  return `---
name: paseo-board
description: Build and update a persistent, completely interactive canvas as the main human-agent conversation surface; use contextual questions, forks, recorded agent decisions and async events.
---

# Paseo Board

This is an advanced live visualize. The free canvas is the main product. Do not force a fixed task workflow, card schema, sidebar layout, ML interface or component catalog. Design the content around this task and the user's question. Preserve desktop interaction; mobile compatibility must not restrict it.

## Tools and persistence

- board_create: title, optional id, html/htmlFile, data. A bound agent owns its new board.
- board_list and board_read: recover current revision, canvas, decisions and pending interactions. read requires boardId.
- board_publish: boardId, expectedRevision, stable eventId, plus html/htmlFile, patch, data, decisions, and/or interactionResult.
- board_respond: boardId, interactionId, expectedResponseRevision (missing responseRevision means 0), stable eventId, response text, optional status (processing/answered/rejected/failed), html/htmlFile, patch, data, resultReferences. This writes only the assigned interaction, not the source canvas. Visual replies are completely free interactive HTML/JS. Read responseRevision before each update; response canvas patches/data preserve its other controls.
- board_decision: boardId, expectedRevision, eventId, decision {id, choice, rationale?, impact?, basis: "explicit", evidence, related}. These are your default choices, not requests for approval. Unknown reasons stay unknown.
- board_emit: boardId, eventId, source, summary, optional kind/data/observation. It never wakes a model. An observation has stable id, name, value and evidence; changes become observed facts without invented reasons.
- CLI: ${cli} OPERATION --file /absolute/input.json; or --json JSON, or JSON on stdin. Use read --json '{"boardId":"..."}'. Keys match MCP, and publish/create/respond can read htmlFile. No command executes arbitrary input as shell code.

Save files before publishing. Use a stable eventId for retry of identical input. Reusing it with different input is an error. A revision conflict means another writer changed state: read, reconcile and issue a NEW eventId for the revised change. Do not blindly overwrite.

## Free canvas and local changes

HTML may include scripts, style, SVG, Canvas, WebGL and arbitrary controls. It runs in a network-restricted sandbox. Put scripts and essential assets inline; do not depend on arbitrary remote scripts or localhost APIs. The canvas cannot execute shell commands or send messages by itself.

Choose a coherent color policy. For host-adaptive content, use paired host tokens for both background and text. For a fixed light/dark canvas, explicitly set its surface, text and color-scheme together; use local palette variables for controls and secondary text rather than mixing a fixed white surface with host-adaptive foreground. Board defaults have low CSS priority and headings inherit their surrounding text color. Verify the same canvas under both light and dark host themes, including inputs, buttons and muted labels. Changing the host theme does not recolor images, Canvas/WebGL pixels or arbitrary custom drawings automatically.

Stable HTML IDs make precise updates easy: patch {id:"explain-v1", selector:"#comparison", operation:"append", html:"..."}. Supported operations: append, prepend, replace, remove. Patches may add script-powered animations. Preserve existing controls by modifying only the target. Full html replacement rebuilds the document, so reserve it for intentional redesigns and preserve serializable state through the bridge.

Preserve a component's stable HTML ID when moving or making it collapsible, and give a new component a different ID. New selections capture an optional component binding so discussion markers can follow layout changes or remain on a collapsed component's visible container. The original quote, rectangle, image and version remain frozen evidence; a marker's current display location does not make an old reference current. A missing or ambiguous component remains accessible through the discussion index rather than being silently attached to unrelated content. No prescribed component schema is required.

Use the injected window.board API: board.getData(), board.onData(callback), board.getState(), board.saveState(json), board.restoreState(), board.onState(callback), board.getContext(), board.ask({prompt,kind:"question"|"change"|"fork",anchor?}). Subscribe with onData and render getData() initially; onData/onState return unsubscribe functions. User-facing ask/change/fork actions open the trusted host composer; call ask from a real user click, and the native composer confirms before sending. Plugin selection works even without semantic IDs: selected text, a point or region, geometry and the current version travel together. Add IDs where useful, not mandatory object schemas.

## Answer on the board

A user may say "add an animation here". Read the anchored context, compare its version to the current board, then publish a local interactive explanation. If an old location cannot be safely matched, preserve the original question and explain the mismatch. Every meaningful request can reference interactionResult {id, status:"processing"|"applied"|"rejected"|"failed", response, resultReferences}. Mark applied only after a concrete canvas change, artifact or verified result satisfies it; include that evidence. A finished turn or "received" is insufficient. An explicit processing receipt stays active after a normal turn ends; publish its final outcome when background work actually finishes.

The host composer routes Enter to the main owner, Command/Control+Enter to the selected side (creating one if absent), and Command/Control+Option/Alt+Enter to a new side. The user can select a previous associated fork. Viewing a thread does not change this destination; queued messages and retries retain their original target. Side selection is a user control, not an agent publish field.

Messages are compact references: read the Board when context is needed and before editing. Source excerpts are bounded; the current interaction's sourceSnapshot preserves the complete selected source text/reply/version/references, without copying its HTML. The frozen anchor and any attached PNG remain the original reference evidence.

Forks isolate conversation context while sharing the same Board, like /btw. They are independent sessions linked by board/interaction IDs, not actual Paseo children, and inherit the originating mode (including auto-review), model, thinking and provider features. Follow the user's actual request: if they ask for a modification, carry it out and publish a revision-checked patch directly to this Board. Record your own consequential defaults with board_decision; background events may use board_emit. Mark your assigned interaction applied only after concrete changes or verified results, with resultReferences. Do not change the Board owner or another agent's interaction receipt. For a local explanation use board_respond with the exact boardId and interactionId, text and optional htmlFile. Returning a result to the owner remains an optional legacy action, never a prerequisite to implementing a branch request.

## Capture consequential defaults

Record choices about scope, compatibility, budgets, dependencies, assumptions, visible behavior or result interpretation when you choose them. State the choice, reason, expected effect and evidence. Do not record every tool selection. Do not pretend a later guess is the original reason. The plugin also scans external assistant messages conservatively; these remain inferred candidates, with original excerpts and bounded coverage. It never reads hidden reasoning. User messages are requirements, not agent decisions.

## Async events

Use the existing register_async_shell tool to wait or monitor. Inside its script, call the absolute CLI emit with a stable eventId and explicit source. A regular event updates the same live board without waking an agent. For a meaningful milestone requiring interpretation, call paseo-shell sendback with a stable idempotency key. Do not run a second task supervisor or read another plugin's private JSON.

For safe JSON quoting, write input to a temporary file or use a program that writes JSON to the CLI's stdin. Observations only compare values the agent or user chose to track; they are not a claim to monitor all command-line/configuration changes.
`;
}
