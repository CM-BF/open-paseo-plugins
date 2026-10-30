export const PROMPT_MARKER = "## Paseo Board — persistent interactive conversation";
export const PROMPT_END = "<!-- /paseo-board-instructions -->";

export function boardInstructions(cli: string, skill: string): string {
  return `${PROMPT_MARKER}
Paseo Board is a general, live, interactive visualize, not a task-specific dashboard. When a visual shared surface helps this task, use board_create/read/publish/respond/decision/emit/feed (MCP) or ${cli}. Read ${skill} for the canvas API. The canvas is yours: arbitrary HTML/CSS/JS, SVG/Canvas, animations, simulations, controls and task-specific layouts; keep ordinary controls fully interactive. User questions can be answered by adding an animation or component exactly where they pointed. For compact checks use board_read view:inspect with dataPaths/interactionIds; persistent facts are not live-render verification. For latest-state producers use the installed feed SDK plus board.watch(path,render), keeping source parsing and free rendering task-specific while the plugin handles sequence/retries. Feed defaults to quiet attention; milestones may locate actual changed components.
Read the Board before drafting. authoring.canvasBase identifies that content snapshot; authoring.materializedAuthoredHtml or optional selector target includes statically replayed patches. canvas.html is only BASE source, never assume it is the current page. If static replay is incomplete, inspect the reported patch and ordered log rather than rebuilding from the base. Retain canvasBase with every HTML patch or traditional data write; full html/htmlFile additionally requires replaceDocument:true. For shared object leaves, use conditional dataPatch with JSON Pointer paths and expected old values. Arrays are checked/replaced as wholes. On conflict, merge the current content and produce a revised draft; never just substitute a newer revision number. Different HTML selectors are not proof of independence because scripts and parent replacements can affect the whole canvas. Use optional focusSelectors (up to 12 actual affected elements) for data updates; patch locations are automatic. Record important defaults YOU chose (scope, compatibility, budget, assumptions, consequential dependencies) with rationale and evidence, not the user's decisions or hidden reasoning. Inferred candidates are not facts. Board intents include frozen selection/version context: recheck stale anchors and link the resulting canvas/artifact to interactionResult, never equate delivery with application.
Waiting and event sources belong to paseo-async-shell. For Board-writing producers, register from this agent's ordinary shell using the public paseo-shell CLI and forward PASEO_BOARD_HOME/PASEO_BOARD_BINDING through --env shell expansion as documented in the skill; the MCP registration process does not inherit this session environment. Its script can call ${cli} emit using stable eventId values while you are idle. Board emit only saves data; use async-shell sendback selectively if explanation/action is required. Do not poll the board or wake yourself in a loop. Ordinary progress updates the board silently. Explicit processing receipts may continue across completed turns while background work runs. The user chooses routing: Enter sends to the main owner, Command/Control+Enter reuses the selected side (or creates one), and Command/Control+Option/Alt+Enter creates and selects a new side. Historical associated forks can be selected by the user; do not change ownership or side routing from agent tools. A fork is a separate conversation context on the same shared Board, like /btw. Fulfill the user's change requests directly with board_publish; use board_decision for your defaults and board_emit for external updates. No return to the owner is required. Use board_respond for text or fully interactive explanations at your assigned marker. Preserve Board ownership and other agents' interaction receipts; chat text is only a fallback.
CLI accepts: ${cli} <list|read|create|publish|respond|decision|emit|feed> --file /absolute/input.json; --json '{...}' or JSON on stdin also work. No shell escaping is required with --file. Existing sessions without MCP can use the absolute CLI path. Local CLI is trusted same-user access; a session binding narrows it to that agent's boards.
${PROMPT_END}`;
}

export function replaceInstructions(original: string, block: string): string {
  const start = original.indexOf(PROMPT_MARKER);
  const end = start >= 0 ? original.indexOf(PROMPT_END, start) : -1;
  if (start >= 0 && end >= start) return `${original.slice(0, start)}${block}${original.slice(end + PROMPT_END.length)}`;
  return `${original}${original ? "\n\n" : ""}${block}`;
}

export function skillMarkdown(cli: string): string {
  const feedSdk = cli.replace(/\/bin\/[^/]+$/, "/lib/feed.mjs");
  const asyncShellCli = cli.replace(/\/[^/]+\/bin\/[^/]+$/, "/paseo-async-shell/bin/paseo-shell");
  return `---
name: paseo-board
description: Build and update a persistent, completely interactive canvas as the main human-agent conversation surface; use contextual questions, forks, recorded agent decisions and async events.
---

# Paseo Board

This is an advanced live visualize. The free canvas is the main product. Do not force a fixed task workflow, card schema, sidebar layout, ML interface or component catalog. Design the content around this task and the user's question. Preserve desktop interaction; mobile compatibility must not restrict it.

## Tools and persistence

- board_create: title, optional id, html/htmlFile, data. A bound agent owns its new board.
- board_list and board_read: recover current revision, canvas, decisions and pending interactions. read requires boardId; optional selector returns a current statically composed target. authoring includes canvasBase, materializedAuthoredHtml and replay status. canvas.html is the base document only. Static source does not execute scripts or represent running DOM/closures.
- For a status/data check, use board_read with view:"inspect", optional dataPaths:["/live/a"], interactionIds:["intent-id"], selector and recentLimit (default 8, maximum 20). It returns compact persisted evidence and exact response revisions without historical PNGs or full HTML. Oversized values are explicitly omitted; text excerpts say when truncated. Use a narrower path or view:"full" for complete evidence before editing. Neither read mode observes the live browser, rendered pixels or client errors.
- board_publish: boardId, expectedRevision, stable eventId, plus patch, data/dataPatch, decisions and/or interactionResult. A patch or traditional data requires canvasBase from the draft's original read. Full html/htmlFile also requires replaceDocument:true. Conditional dataPatch may omit canvasBase. expectedRevision guards metadata; canvas writes use their independent content conditions. Data-only changes may include focusSelectors (up to 12).
- board_respond: boardId, interactionId, expectedResponseRevision (missing responseRevision means 0), stable eventId, response text, optional status (processing/answered/rejected/failed), html/htmlFile, patch, data, resultReferences. This writes only the assigned interaction, not the source canvas. Visual replies are completely free interactive HTML/JS. Read responseRevision before each update; response canvas patches/data preserve its other controls.
- board_decision: boardId, expectedRevision, eventId, decision {id, choice, rationale?, impact?, basis: "explicit", evidence, related}. These are your default choices, not requests for approval. Unknown reasons stay unknown.
- board_emit: boardId, eventId, source, summary, optional kind/data/dataPatch/focusSelectors/observation. Traditional data requires its original canvasBase; dataPatch uses expected old values. Pure events/observations need neither. focusSelectors requires data or dataPatch and names up to 12 affected canvas elements. It never wakes a model. An observation has stable id, name, value and evidence; changes become observed facts without invented reasons.
- board_feed: a persistent latest-value source with action open/set/close/status. Prefer its producer helper below instead of hand-writing generation, sequence and retry state. It accepts arbitrary JSON, not a task schema, and never wakes agents. Quiet progress does not add unread navigation items; explicit milestones may locate their actual rendering elements.
- CLI: ${cli} OPERATION --file /absolute/input.json; or --json JSON, or JSON on stdin. Use read --json '{"boardId":"..."}'. Keys match MCP, and publish/create/respond can read htmlFile. No command executes arbitrary input as shell code.

Save files before publishing. Use a stable eventId for retry of identical input. Reusing it with different input is an error. A revision_conflict or data_conflict means the edit conditions no longer hold: inspect current content and reported recent writers/targets, merge your intended change and issue a NEW eventId for the revised draft. Never refresh only expectedRevision/canvasBase and resend old content. A durable publish receipt is not browser execution confirmation; inspect any reported rendering failure before claiming application.

## Collaborative edits

Keep the original authoring.canvasBase = {revision, documentVersion} with your draft. Canvas updates reject that base if another canvas write has committed, even if you replace expectedRevision with the newest Board number. Unrelated discussion or attention changes do not invalidate a pure canvas write. HTML/JS is conservatively versioned as a whole canvas: two different selectors may still overlap through ancestors or scripts. Read, merge and resubmit a small patch after a conflict. Do not impose task slots or permanent writer locks.

For shared JSON data use dataPatch, an array of conditional object-path edits. Example: [{path:"/metrics/score",operation:"set",expected:{exists:true,value:0.5},value:0.6}]. To create a field use expected:{exists:false}; remove uses operation:"remove" without a new value. JSON Pointer escapes are ~0 for ~ and ~1 for /. Parent objects must already exist. All conditions are checked atomically; any mismatch rejects the entire operation. Different leaves can coexist without replacing siblings. Arrays are indivisible values: compare/replace the whole array, never assume an index remains the same item. Traditional data remains a shallow top-level merge under canvasBase; it is not a recursive merge.

An explicit whole-document replacement clears the patch journal and resets running code. Require replaceDocument:true and the original canvasBase; first account for all current patches using materializedAuthoredHtml. If replay reports a dynamic or missing target, materializedAuthoredHtml is null. Inspect base source plus the ordered patch log and the actual rendering, or use a narrowly scoped patch; never treat the old base as a complete current page.

## Free canvas and local changes

HTML may include scripts, style, SVG, Canvas, WebGL and arbitrary controls. It runs in a network-restricted sandbox. Inline scripts/assets and blob workers work. HTTPS scripts, modules, styles, fonts, images and fetch are allowed from unpkg.com, cdn.jsdelivr.net, esm.sh and cdnjs.cloudflare.com; use small versioned builds when a library helps. Other hosts, Google Fonts, localhost APIs and nested frames are blocked. Keep essential data inline or in board data, and handle CDN loading failures. The canvas cannot execute shell commands or send messages by itself.

Choose a coherent color policy. For host-adaptive content, use paired host tokens for both background and text. For a fixed light/dark canvas, explicitly set its surface, text and color-scheme together; use local palette variables for controls and secondary text rather than mixing a fixed white surface with host-adaptive foreground. Board defaults have low CSS priority and headings inherit their surrounding text color. Verify the same canvas under both light and dark host themes, including inputs, buttons and muted labels. Changing the host theme does not recolor images, Canvas/WebGL pixels or arbitrary custom drawings automatically.

### Injected design system: use, adapt or ignore

Board already includes visualize's CSS, tokens and optional helpers. Do not re-import its stylesheet or recreate every button from scratch. These are optional drawing materials, not a required component catalog or page template. A diagram, editorial layout, simulator or custom spatial canvas is equally valid; avoid turning every paragraph into a card. Let the user's question determine the visual hierarchy and interaction.

The stylesheet is in the low-priority paseo-board-defaults CSS layer, so ordinary authored CSS wins. Board uses the page surface: body starts at max-width 960px, centered, with 40px 28px 28px padding (16px 14px 20px in a narrow pane). This is a default, not a desktop size limit. A deliberately wide board may override body max-width/padding, then give its own sections appropriate widths and scrolling. Do not apply fixed width/height to all content just to imitate a screenshot.

**Tokens available through var(...):**

| Purpose | Tokens |
| --- | --- |
| Page and secondary text | --background / --foreground; --muted-foreground |
| Surface/text pairs | --card / --card-foreground, --popover / --popover-foreground, --primary / --primary-foreground, --secondary / --secondary-foreground, --accent / --accent-foreground |
| Quiet surfaces and outlines | --muted, --border, --input, --ring |
| Status accents | --destructive, --success, --warning (no matching status-foreground tokens) |
| Categorical data | --viz-series-1 through --viz-series-8: blue, orange, green, pink, violet, teal, red, yellow |
| Ordered data | --viz-neutral-1..5 (weak to strong), --viz-sequential-1..6, --viz-diverging-1..7 (4 is the midpoint) |
| Focus/context | --viz-focus, --viz-focus-2, --viz-recede, --viz-recede-foreground |
| Type and shape | --font-sans, --font-mono, --font-size-base, --radius, --shadow-sm, --shadow-lg |

Use the semantic tokens above rather than coupling authored content to the internal --host-* palette. The font stacks use locally installed Geist / Geist Mono, then system fallbacks; the sans stack includes Chinese fonts. No font is downloaded automatically. Keep body text in --font-sans and reserve --font-mono / tabular numerals for values and code. Defaults are 14px body text with 1.55 line height and 600-weight headings; choose a readable size and a small, consistent hierarchy for the actual viewing distance. Do not make every label tiny or every title oversized. There is no built-in spacing-token scale: use consistent local gaps (for example 8/12/16/24/32px), larger spacing between groups than within them, and scoped variables if helpful. Let long text wrap and give grid/flex children min-width:0.

**Optional classes:**

- Layout/surfaces: .card, .viz-grid (auto-fit columns, 10px gap), .viz-row (wrapping row, 8px gap), .viz-stack (14px gap), .viz-controls; .viz-stat with .viz-stat-value, and .viz-badge. Use plain sections when a surface or badge adds no meaning.
- Actions: .btn plus .btn-primary, .btn-ghost, .btn-sm, .btn-icon or .btn-block. .btn-primary is a strong foreground/background inversion, not necessarily the accent color. Pressed state uses aria-pressed, aria-selected or .is-selected; .viz-segmented groups toggle buttons. Supply real labels, focus states and disabled behavior.
- Fields: .form-label, .form-control, .form-select, .form-range, .form-check (optionally .form-switch), .form-check-input, .form-check-label. Classes style native controls; authors still wire their behavior.
- Text/tables: .text-muted, .text-small, .text-mono, .text-destructive, .text-success, .text-warning, .sr-only; native tables are styled, with .table-responsive for horizontal overflow and .table-sm for denser cells. Muted text still needs contrast on its actual surface.

For example, this self-contained local control uses the existing styles without creating a task template:

\`\`\`html
<section id="motion-demo" class="viz-stack" aria-labelledby="motion-title">
  <style id="motion-demo-style">
    #motion-demo { color:var(--foreground); background:var(--background); }
    #motion-demo .motion-controls { gap:12px; }
  </style>
  <h2 id="motion-title">Explore the motion</h2>
  <div class="viz-row motion-controls">
    <label class="form-label" for="motion-rate">Speed
      <input id="motion-rate" class="form-range" type="range" min="1" max="5" value="1">
    </label>
    <output id="motion-value" class="text-mono" for="motion-rate">1×</output>
    <button id="motion-reset" class="btn btn-ghost" type="button">Reset</button>
  </div>
  <script>
    (() => {
      const section = document.getElementById('motion-demo');
      const rate = section.querySelector('#motion-rate');
      const value = section.querySelector('#motion-value');
      rate.oninput = () => { value.textContent = rate.value + '×'; };
      section.querySelector('#motion-reset').onclick = () => { rate.value = '1'; rate.oninput(); };
    })();
  </script>
</section>
\`\`\`

Do not globally redefine .card, .btn or .text-muted to serve one new component: older content and other agents may use them. Use #your-component .your-class or a specific additional class, and keep each component's style element under a stable ID. A fixed-palette component must set its own surface/text pairs, muted text, outlines and control colors (including any inherited helper tokens it uses), plus color-scheme:light or dark. Setting only background:white is incomplete; setting color-scheme alone does not replace the host's palette. A whole fixed-palette page should also set its page background/text so margins match.

**Charts and drawings:** .viz-plot on an SVG opts into themed structure: .viz-plot-grid, .viz-plot-axis, .viz-plot-label (haloed annotation), .viz-plot-line, .viz-plot-mark, .viz-plot-area and .viz-plot-basemap. data-viz-series="1" through "8" selects a series; --viz-series can instead select a focus/sequential/diverging token, and --viz-fill controls an area's strength. .viz-plot-scroll supports wide plots with --viz-plot-min-width (660px default). Legends use .viz-legend with .viz-swatch. Use categorical colors for identities, sequential colors for magnitude and diverging colors for a meaningful midpoint; keep identities consistent across updates and supply labels or shapes as well as color. For example:

\`\`\`html
<svg id="curve-preview" class="viz-plot" viewBox="0 0 320 120" role="img" aria-labelledby="curve-title">
  <title id="curve-title">Illustrative curve rising from left to right</title>
  <path class="viz-plot-axis" d="M20 15V100H300"/>
  <path class="viz-plot-line" data-viz-series="1" d="M20 90C100 90 180 20 300 20"/>
  <text class="viz-plot-label" x="204" y="56">Illustration</text>
</svg>
\`\`\`

CSS/SVG colors follow the host automatically. Canvas/WebGL must resolve colors in their element's theme context and redraw on window's paseo:themechange event (event.detail.theme is light or dark), plus resize when needed. For Canvas, a computed CSS color property on a probe element resolves var()/light-dark(); copying an unresolved custom-property string directly into drawing APIs is unreliable. Keep dense plots readable through zoom or local horizontal scrolling rather than shrinking all labels for mobile.

**Icons and tooltips have an initial-load condition.** If the initial document source contains lucide, Board includes a CDN Lucide loader and initializes <i data-lucide="name"></i> icons at 16px. For icons added later, call window.lucide.createIcons() after inserting them; if the initial loader is still pending, wait for its load event (script ID codex-visualization-lucide). If the initial source contains data-tooltip, dataset.tooltip or floatingui, Board loads Floating UI and delegates themed tooltips for data-tooltip="…" (optional data-tooltip-placement). Those delegated tooltips work on later elements once loaded. A patch that introduces either feature for the first time does NOT automatically load its helper. Include the intended helper usage in initial HTML, or explicitly load a library from an allowed CDN and wire its initialization/tooltip behavior yourself; self-contained SVG/native title is another option. Handle loading failure and keep important actions understandable without a tooltip. Do not assume visualize-only export, preview or follow-up APIs are Board features; use window.board below.

### Maintain a long-lived composition

Stable HTML IDs make precise updates easy: patch {id:"explain-v1", selector:"#comparison", operation:"append", html:"..."}. Supported operations: append, prepend, replace, remove. Patches may add script-powered animations. Choose the smallest stable element containing the intended change; do not replace an enclosing layout or status panel merely to edit one sentence. A highlight describes the published target, not an exact visual diff. Preserve existing controls by modifying only the target. Full html replacement requires replaceDocument:true and canvasBase, rebuilds the document and clears its patch journal; reserve it for intentional redesigns and preserve current contributions plus serializable state.

Before extending a layout, read its current composed source and reuse its typography, spacing and section structure. Replace an owned style element when its rules change instead of appending successive overrides; avoid duplicate IDs. Keep component CSS scoped, and explicitly dispose of its window listeners, timers, animation loops and board subscriptions before replacing/removing that component: removing DOM does not automatically clean those up. Data-only changes should update existing nodes and drawings, not rebuild a form or reset the user's zoom. After a patch, inspect surrounding sections as well as the changed one for overflow, clipping, inconsistent spacing and contrast; fix the smallest affected scope rather than starting the whole board over.

Committed main-canvas changes retain a bounded set of locations for the user to visit and highlight directly. Patch selectors are captured automatically; document replacement is recorded as a whole-document change. For data-only publish or emit, include focusSelectors:["#comparison", "#summary"] when those elements actually render the changed data. Do not supply focusSelectors together with html/patch or without data/dataPatch, and do not invent locations when unknown. A repeated data value creates no new location. These locations do not require task-specific components or a textual activity feed. The host alone marks individual updates seen; agent tools cannot acknowledge them for the user.

Preserve a component's stable HTML ID when moving or making it collapsible, and give a new component a different ID. New selections capture an optional component binding so discussion markers can follow layout changes or remain on a collapsed component's visible container. The original quote, rectangle, image and version remain frozen evidence; a marker's current display location does not make an old reference current. A missing or ambiguous component remains accessible through the discussion index rather than being silently attached to unrelated content. No prescribed component schema is required.

Use the injected window.board API: board.getData(), board.onData(callback), board.getState(), board.saveState(json), board.restoreState(), board.onState(callback), board.getContext(), board.ask({prompt,kind:"question"|"change"|"fork",anchor?}). Subscribe with onData and render getData() initially; onData/onState return unsubscribe functions. User-facing ask/change/fork actions open the trusted host composer; call ask from a real user click, and the native composer confirms before sending. Plugin selection works even without semantic IDs: selected text, a point or region, geometry and the current version travel together. Add IDs where useful, not mandatory object schemas.

Prefer board.watch("/live/a", (value, context) => render(value)) for a component that uses one data path. It renders immediately and again only when that value changes, skipping unrelated sibling updates and object-key ordering differences. context.exists distinguishes missing data (value is undefined) from JSON null; context also includes path, boardRevision and canvasRevision. The callback receives its own copy. JSON Pointer escapes are ~0 and ~1; an empty path selects all data. The returned unsubscribe function must be called before removing/replacing the component. Arrays may be read by index, but for collaborative updates keep stable object keys when identities matter. No DOM is rebuilt automatically: render only your changed nodes and preserve controls. Whole snapshots still travel to the frame; watch reduces render/copy work rather than promising a fully incremental transport.

### Preview what actually renders

There is no board_preview tool. Opening an authored HTML file directly omits Board's injected styles, sandbox, data and patch replay. For actual UI verification, publish to an owned test Board and open it through Paseo with available browser/computer tools. Inspect a desktop viewport and a narrower pane, exercise controls and a local patch, and capture the real rendering. Check light and dark host palettes in an isolated test context; do not change the user's global theme solely to run a test. In a repository development checkout, an isolated browser harness can use shared/document.ts's buildBoardDocument with real FrameSnapshots and explicit light/dark themes; this verifies the renderer, not the native Paseo UI. npm run test:browser and npm run test:host run the repository's regression fixtures, not a preview of your arbitrary new board. If an actual browser/host is unavailable, report that limit and only claim the source checks performed. Never invent a successful screenshot or treat a publish receipt as visual verification.

## Answer on the board

A user may say "add an animation here". Read the anchored context, compare its version to the current board, then publish a local interactive explanation. If an old location cannot be safely matched, preserve the original question and explain the mismatch. Every meaningful request can reference interactionResult {id, status:"processing"|"applied"|"rejected"|"failed", response, resultReferences}. Mark applied only after a concrete canvas change, artifact or verified result satisfies it; include that evidence. A finished turn or "received" is insufficient. An explicit processing receipt stays active after a normal turn ends; publish its final outcome when background work actually finishes.

The host composer routes Enter to the main owner, Command/Control+Enter to the selected side (creating one if absent), and Command/Control+Option/Alt+Enter to a new side. The user can select a previous associated fork. Viewing a thread does not change this destination; queued messages and retries retain their original target. Side selection is a user control, not an agent publish field.

Messages are compact references: read the Board when context is needed and before editing. Source excerpts are bounded; the current interaction's sourceSnapshot preserves the complete selected source text/reply/version/references, without copying its HTML. The frozen anchor and any attached PNG remain the original reference evidence.

Forks isolate conversation context while sharing the same Board, like /btw. They are independent sessions linked by board/interaction IDs, not actual Paseo children, and inherit the originating mode (including auto-review), model, thinking and provider features. Follow the user's actual request: if they ask for a modification, carry it out and publish a revision-checked patch directly to this Board. Record your own consequential defaults with board_decision; background events may use board_emit. Mark your assigned interaction applied only after concrete changes or verified results, with resultReferences. Do not change the Board owner or another agent's interaction receipt. For a local explanation use board_respond with the exact boardId and interactionId, text and optional htmlFile. Returning a result to the owner remains an optional legacy action, never a prerequisite to implementing a branch request.

## Capture consequential defaults

Record choices about scope, compatibility, budgets, dependencies, assumptions, visible behavior or result interpretation when you choose them. State the choice, reason, expected effect and evidence. Do not record every tool selection. Do not pretend a later guess is the original reason. The plugin also scans external assistant messages conservatively; these remain inferred candidates, with original excerpts and bounded coverage. It never reads hidden reasoning. User messages are requirements, not agent decisions.

## Async events

### Latest-state producers

For a process that reports successive values, import createFeed from ${feedSdk}. A minimal Node module is:

\`\`\`js
import { createFeed } from '${feedSdk}';
const feed = await createFeed({
  boardId: 'my-board', sourceId: 'source-a', path: '/live/a',
  stateFile: '/absolute/private-task-directory/source-a.json',
  focusSelectors: ['#source-a-view']
});
await feed.set({ value: 0.86, note: 'Any task-owned JSON' });
// Ask for navigation/highlighting only at a meaningful milestone:
await feed.set({ value: 0.91, note: 'A result worth looking at' }, { attention: 'milestone' });
\`\`\`

In the canvas use board.watch('/live/a', (value, context) => { /* render your own nodes */ }). Bind the path and actual focus selector once; the task still decides what data means and how to display it. A feed owns its whole value at that path; set replaces that value, not a recursive merge. Missing object parents are created; parent arrays/scalars and overlapping active feed paths are rejected. Different sources should use disjoint stable object paths, never compete over a shared metrics array. Derive a comparison table from the independently updated values.

The SDK requires the owning agent's Board identity. async-shell's MCP process and supervised task do not automatically inherit the calling agent session environment. Register the producer from that agent's ordinary shell tool through the existing public CLI; shell expansion passes the current values without printing or asking the model to copy them:

\`\`\`bash
${asyncShellCli} register \\
  --description "Update this Board from task data" \\
  --idempotency-key "my-board-source-a-v1" \\
  --cwd /absolute/task-directory --timeout 3600 \\
  --env "PASEO_BOARD_HOME=\${PASEO_BOARD_HOME:?Board runtime missing}" \\
  --env "PASEO_BOARD_BINDING=\${PASEO_BOARD_BINDING:?Board session identity missing}" \\
  -- node /absolute/task-directory/producer.mjs
\`\`\`

This remains an async-shell supervised task, with its existing recovery and completion notification. Do not enable shell tracing, echo the binding, copy it into prompts/source, or read another agent's credentials. PASEO_AGENT_ID is set by async-shell from its caller; do not supply it as an override. The public registration receipt omits environment overrides. If using Node to register, capture output and never print the raw execFile error because it may include expanded argv. Reuse the registration idempotency key when its outcome is unknown. A plain register_async_shell call without this environment handoff is insufficient for a bound Board producer.

stateFile is an absolute, private, durable journal unique to that producer; it saves requests and ACKs, never credentials. Restart with the same configuration/stateFile under the same owning-agent environment. Await each set: concurrent/infinite queued writes are not accepted. Values are bounded to 256,000 bytes and JSON depth 64; store large artifacts separately and send their references/summary. A Board retains at most 64 source identities and 32 recent per-source receipts. This is latest state, not a full event stream or an unbounded telemetry database.

The helper writes one pending request before sending, retries unknown outcomes with the same generation/sequence/value, and resumes that pending write when reopened with the same config/stateFile. Successful set returns a small durable ACK; it does not prove that the browser rendered. Await feed.retry() to settle a retained operation before changing its value. Confirmed validation/conflict errors are not silently retried. Inspect feed.status() or board_read view:inspect before recovery; after deciding how to reconcile a confirmed rejection, feed.reopen({discardRejected:true}) explicitly starts a new generation. A replacement process may use createFeed({...config,restart:true}) for an intentional generation change, but must resolve unknown pending writes first. Never automatically reopen just to force an old value over someone else's edit. feed.close() releases its path after pending work is settled; old generations remain fenced.

The equivalent board_feed calls are: open with boardId/sourceId/path/requestId/expectedGeneration (0 when new); set with boardId/sourceId/generation/seq/value and optional attention/focusSelectors; status with boardId/sourceId; close with boardId/sourceId/generation. Open IDs and set sequences identify immutable requests. A new source has sequence 0, and its first set uses 1. A previous generation or an old sequence cannot roll back data; a manual same-path edit causes data_conflict until explicitly reconciled. An exact retained duplicate is inert. Preserve identical request fields on retry, including attention and selectors.

Use the existing async-shell supervisor to wait or monitor; Board-writing scripts need the registration environment handoff above. Inside its script, call the absolute CLI emit with a stable eventId and explicit source. A regular event updates the same live board without waking an agent. Data producers use conditional dataPatch or a retained canvasBase; a stale producer must reconcile its expected old values instead of overwriting a newer result. Background refreshers should publish only changed data with precise focusSelectors, or a small HTML patch when markup actually changes. Do not repeatedly resend the whole document as a refresh strategy; it resets controls, broadens highlights and can discard other writers’ contributions. For a meaningful milestone requiring interpretation, call paseo-shell sendback with a stable idempotency key. Do not run a second task supervisor or read another plugin's private JSON.

For safe JSON quoting, write input to a temporary file or use a program that writes JSON to the CLI's stdin. Observations only compare values the agent or user chose to track; they are not a claim to monitor all command-line/configuration changes.
`;
}
