# Paseo Board

A persistent, fully interactive visualize with contextual human–agent conversations. The agent owns the HTML/CSS/JS canvas. The plugin owns identity, updates, selection, discussion receipts and evidence for the agent's default decisions. There is no task schema, prescribed workflow or component catalog.

## Use

Requires Paseo 0.13.2 or later, with no upper version cap. The development toolchain was verified with Node 22 LTS / Node 24 LTS and npm 11. For a local directory installation, clone this repository, then run:

```sh
cd plugins/paseo-board
npm ci --ignore-scripts --no-audit --no-fund
paseo plugin install "$PWD" --id paseo-board
```

On macOS, the bundled CLI is also available at `/Applications/Paseo.app/Contents/Resources/bin/paseo`. Keep this checkout at a stable location: a directory install uses it directly and does not install its npm dependencies. The committed client bundle is ready to load; regenerate it after changing client code.

Open **Boards** in Paseo's sidebar or Command Center. `/board` opens the current workspace's boards beside an agent. Ask an agent to create a board, or create one and associate its owner in the UI.

The default pointer belongs to the canvas. **Right-click**, finish selecting ordinary text, or hold **Option / Alt and drag** a region to open the host-owned input directly beside your pointer. There is no action menu and no question/change mode to choose. **Enter** sends to the main owner. **⌘ / Ctrl + Enter** sends to this Board's selected side conversation, creating one when none is selected. **⌘ / Ctrl + Option / Alt + Enter** creates a new side conversation and selects it. The destination can also be chosen with the send buttons. Select a previous associated fork to reuse it; the thread being viewed does not silently change the destination. If a new side is being created, side messages wait for that same side. Selecting a historical side changes future sends without redirecting already queued messages. **Shift + Enter** inserts a line break; IME confirmation does not send. Click outside or press **Esc** to close. Inputs and editable areas keep native selection/context menus; **Shift + right-click** keeps the native menu elsewhere. Toolbar selection controls remain available. The fixed-height reference strip never moves or resizes the canvas. Generated pages can request the same input through `board.ask`; the human chooses the destination when sending.

Decision records describe choices made by the agent, with three distinct sources: explicit agent records, observed changes in declared inputs, and conservatively inferred candidates from visible assistant messages. Unknown rationale stays unknown. User messages and hidden reasoning are not extracted. Candidate collection is a heuristic, not a complete account of all implicit choices.

## Agent interface

New agents receive `board_create`, `board_list`, `board_read`, `board_publish`, `board_respond`, `board_decision`, and `board_emit` MCP tools. Existing sessions can use:

```sh
~/.paseo/paseo-board/bin/paseo-board read --file /absolute/request.json
```

All commands also accept `--json` or JSON on stdin. Prefer an input file for HTML and complex data. `create`, `publish`, and `respond` accept `htmlFile`. Read the installed `paseo-board` skill for full input shapes and examples.

```json
{
  "boardId": "my-project",
  "expectedRevision": 12,
  "canvasBase": { "revision": 4, "documentVersion": 1 },
  "eventId": "explain-update-1",
  "patch": {
    "id": "explain-update-1",
    "selector": "#explanation",
    "operation": "append",
    "html": "<div id=\"new-explanation\">An interactive explanation…</div>"
  }
}
```

Use stable event IDs for identical retries. Keep the original `authoring.canvasBase` with the draft; substituting a newer Board `expectedRevision` cannot make that stale canvas draft valid. A conflict requires reading and merging the current content before a new event ID is submitted. A data update or local patch keeps the existing iframe and unrelated DOM, input values and animation state. A full document replacement requires `replaceDocument: true` plus its original `canvasBase` and rebuilds the frame; use the state API to restore selected controls. Patch scripts execute once per document instance and are replayed when that document is reopened.

Canvas changes also retain their locations so the user can jump to and highlight recent work. Patch targets are recorded automatically, including their patch IDs; full replacement is a document-level update. For a **data-only** publish or emit, add `focusSelectors: ["#comparison", "#summary"]` (at most 12 actual affected elements). Do not include this field with HTML/patch or without data/dataPatch. Missing hints remain unlocated rather than guessing. Unchanged data values, decisions, responses and operational checkpoints do not create canvas updates.

Each Board persists its latest 80 canvas updates with their versions and the bound writer's identity when available. The user-facing `markUpdatesSeenRpc` acknowledges specific update IDs without modifying content revisions, history or authored user state. Visiting the newest change does not acknowledge older ones. `board_list` exposes `unreadUpdateCount` and `latestUpdateRevision`; agent tools cannot mark updates seen.

Canvas API:

```js
const draw = data => { /* Your own interactive rendering */ };
draw(board.getData());
const unsubscribe = board.onData(draw);
const saved = board.getState();
board.saveState({ zoom: 1.5 });
// Call from an actual click. Opens the local composer; the user sends.
button.onclick = () => board.ask({ prompt: "Explain this part", kind: "question" });
```

`board.restoreState()`, `board.onState(callback)` and `board.getContext()` are also available. `window.openai.sendFollowUpMessage` is compatible with visualize-style requests. The result is a submission receipt, not the model's answer. Use stable DOM IDs for local edits; selection also works without IDs.

The host supplies a default palette; authored CSS takes precedence through a lower-priority default layer. Headings and body text inherit their surrounding color. For a fixed light or dark design, set its background, foreground and `color-scheme` together, and provide coherent colors for controls and muted text. For an adaptive design, use matching host surface and text tokens. Host theme changes preserve the canvas runtime and do not override an authored `color-scheme`; images and Canvas/WebGL drawings still need the author's own palette handling.

The installed Board skill documents the injected visualize design system: semantic surface/text pairs, categorical and ordered chart colors, local Geist/system font stacks, typography, layout helpers, buttons, fields and SVG plot classes. These are optional tools for free HTML, not a prescribed layout. The default page width is 960px and may be overridden for a wide desktop board. Scope custom CSS to the component that owns it instead of globally redefining shared classes such as `.card`; update its existing style element and clean up listeners when replacing it.

Network access is limited to HTTPS resources on `unpkg.com`, `cdn.jsdelivr.net`, `esm.sh` and `cdnjs.cloudflare.com`; fonts are not downloaded automatically. Lucide and Floating UI helpers are included only when the **initial HTML** requests them. A patch that first introduces `data-lucide` or `data-tooltip` does not install those helpers; later icons also need `createIcons()` after the loader is ready. The skill explains those conditions and alternatives.

Visual verification needs the actual Board renderer. A raw HTML file lacks its injected styles and runtime, and there is no `board_preview` tool. Use an owned test Board in Paseo, or an isolated development harness built with `buildBoardDocument` for explicit light/dark palettes without changing the user's global theme. Clearly distinguish renderer checks from native UI verification; the repository's browser tests cover their fixtures, not every authored design.

## Multiple writers

`board_read` adds an `authoring` view. `materializedAuthoredHtml` statically replays the ordered patch journal without executing scripts; an optional `selector` returns a composed target fragment. `canvas.html` remains the underlying base document for replay and is **not** the current patched source. An unresolved/ambiguous/dynamic patch stops composition and returns null with its failure location. This view is authored source, not the running DOM, event listeners or Canvas pixels.

HTML patches and traditional `data` require the captured `{revision, documentVersion}` in `canvasBase`. Pure canvas writes tolerate unrelated discussion metadata changes. They conservatively conflict with any newer canvas write: different selectors are not proof of independence when parent replacements, global CSS and arbitrary JS are allowed. Full document replacement also requires `replaceDocument: true`; it clears the patch journal. These controls reject stale bases but cannot infer the author's intent if the author deliberately supplies new conditions with old content.

For independent JSON fields, `publish` and `emit` accept atomic conditional `dataPatch` operations:

```json
{
  "dataPatch": [{
    "path": "/metrics/score",
    "operation": "set",
    "expected": { "exists": true, "value": 0.5 },
    "value": 0.6
  }],
  "focusSelectors": ["#comparison"]
}
```

Different object leaves can commit concurrently while preserving siblings. All conditions are checked against one snapshot before applying the batch. Existing parent objects are required; duplicate/ancestor paths within one batch are rejected. Use `expected: {exists: false}` to add a field, or `operation: "remove"` without a new value to delete one. JSON Pointer escapes `~` and `/` as `~0` and `~1`. Arrays are compared and replaced as whole values, never edited through unstable indices. Do not combine `dataPatch` with traditional `data`; the latter remains a shallow top-level merge protected by `canvasBase`.

Conflicts carry current/base versions, recent update locations and writer attribution when available, plus whether the bounded history covers the requested range. No tool silently refreshes conditions and retries an old payload. Durable acceptance does not prove arbitrary browser scripts executed successfully; retain rendering error checks before claiming a change is applied.

## Background events

Reuse `register_async_shell` to wait for external events. Its script calls `paseo-board emit` with stable event IDs. Shared data uses conditional `dataPatch`, or traditional `data` with the canvas base captured when that payload was prepared. Pure facts/observations need no canvas condition. Delayed data producers must reconcile a conflict instead of overwriting newer results. The board updates while the owner is idle. `emit` never sends an agent message. If interpretation or action is needed, the same shell can use `paseo-shell sendback` with an idempotency key. Board does not implement a second shell supervisor or read async-shell's private files.

An optional `observation` names an input to track. A changed value creates an observed record with supplied evidence and no invented reason. It does not automatically inspect all commands, files or parameters on the machine.

## Conversation and durability

Selections carry canvas and board versions, quote/geometry and a best-effort PNG. PNG capture can fail for protected or cross-origin content; missing capture is surfaced rather than silently treated as a complete visual snapshot. Old selections remain old; the agent must reconcile them before editing.

A fork is a separate conversation context on the **same shared Board**, like `/btw`; it is not a clone of hidden provider state. It is linked without a parent relation to avoid cascade archival and inherits the originating session's permission mode (including auto-review), model, reasoning and feature values. A user-requested modification is performed directly with revision-checked Board patches—no return-to-main step is required. Associated forks can publish to that Board and record decisions/events, while ownership and other agents' interaction receipts remain protected. `board_respond` still attaches explanations or interactive figures to the original marker. Legacy return records remain readable. `answered` means a reply exists; `applied` needs concrete result evidence. A completed turn alone never proves a requested change was made. Explicit `processing` receipts remain in progress across completed turns and plugin restarts, so an async-shell continuation can finish the request later.

Questions leave small, translucent numbered markers. New references also capture component identity and relative position, so their markers follow layout changes; when content is collapsed or clipped, a marker can stay on its visible summary or container. The original quote, coordinates, image and version remain unchanged. Hover, focus or selection brings markers into full contrast. Pending work shows a soft animated halo and rotating ring, respecting reduced-motion settings; completed work is still. Clicking a marker opens its conversation.

A permanent discussion index at the right lists every root thread, including offscreen, collapsed, deleted and unanchored content. Selecting an entry opens its discussion and locates the current component when identifiable; it never submits a message or automatically operates authored controls. Follow-ups share the original number. Selection and popovers do not change the canvas width. The index stays narrow at compact widths.

The compact update navigator moves directly to recent published changes and briefly highlights their visible target, including nested horizontal/vertical scroll areas. It follows the newest unread change by default; previous/next pauses following so concurrent arrivals do not move the place being reviewed. Input, dragging, selection and composition defer automatic navigation. The Board index shows unread counts. Each update becomes seen only after all of its locations are confirmed visible; stale/deleted targets stay available without a fabricated location. The highlight stops after three pulses, with a static alternative for reduced motion.

Stable, unique HTML IDs identify the same component through local patches; use a new ID for a different component. Duplicate IDs, missing targets and whole-document replacement do not silently bind an old marker to new content. Historical references without component metadata keep their frozen positions and remain accessible in the index. Layout, DOM changes, scrolling and completed CSS transitions update placement; pure CSS transform animation is not tracked frame by frame. Old references remain labelled as old even when their component can still be located.

Messages carry only the current request, Board/interaction IDs, versions, frozen selection evidence and a brief receipt instruction. Full canvas code, data and decision history stay available through `board_read`. A follow-up sends a bounded source excerpt; its complete selected source text/reply/version/references are preserved as `interaction.sourceSnapshot`, so later edits cannot rewrite what the user selected. No source HTML is copied into that snapshot. Retries preserve the original destination, source, creation settings and message rather than consulting whichever side is selected later.

A discussion agent answers through `board_respond` (or CLI `respond`) with `boardId`, `interactionId`, `eventId`, `expectedResponseRevision`, and `response`. Missing `responseRevision` means zero. Optional `html` / `htmlFile`, `patch`, and `data` create a freely interactive visual answer inside that marker’s discussion. This response has its own version and never replaces the main canvas. Explicit answers take precedence over fallback final-message collection. Owners and associated forks use `board_publish` with evidence when applying changes to the main canvas.

Data and a mutation journal live under `~/.paseo/plugin-data/paseo-board`. Atomic replacement, per-board serialization, optimistic revisions and durable deduplication protect updates. Extraction scan checkpoints persist separately from content revisions, so background scanning does not cause edit conflicts or fill the content history; their display catches up on the next full read or content update. The plugin service is the sole writer; direct concurrent file editing is unsupported. Per-board storage currently has a 64 MiB limit and rejects further growth instead of silently deleting history. Back up the directory while the plugin is stopped to migrate or restore it.

## Platforms and boundaries

- Desktop/web is the complete interactive runtime; mobile provides native summaries, decisions and discussion. Mobile parity does not constrain desktop features.
- The canvas uses an opaque sandbox and the same library CDN policy as paseo-visualize. It has no Paseo SDK, host filesystem, host storage, arbitrary network access or automatic message sending. Host data reaches it through a checked, frame-scoped bridge.
- CLI access is trusted same-user local access. Agent session bindings scope Board tools to owned boards or a fork's source board. This does not sandbox an otherwise unrestricted shell on the same operating-system account.
- A lost send response is displayed as uncertain and is not blindly retried. Paseo 0.13.2 has no atomic idle-only enqueue API; a narrow idle-check/send race remains. Background monitors obey async-shell's own agent lifecycle.
- Rendering reuses audited local copies of paseo-visualize assets, with attribution in `NOTICE`. No runtime imports reach another plugin's private installation.

## Develop and validate

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm test
npm run test:browser
npm run test:host
```

Before installing a changed client, regenerate the committed Hermes compatibility bundle with `npm run build:client`. The build script and its dependencies are contained in this plugin directory. This lowers the host UI bundle; the string-contained desktop canvas runtime retains its full JavaScript capabilities.

Canvas browser tests run the actual React `CanvasFrame` in Chrome, exercising DOM preservation, patch execution/replay, data updates, selection capture and message-source checks. The host browser suite also renders the real `BoardView` with a fixture RPC transport, checking canvas geometry, local input, marker lifecycle and interactive answers; it is not a live-daemon test. Both suites default to the macOS Chrome application; set `BROWSER_PATH` to another Chrome/Chromium executable when needed. Install the new plugin with the Paseo CLI; reload only its own runtime after source changes. Do not restart the daemon to load plugin code.

`DESIGN.md` records product constraints. `IMPLEMENTATION.md` records implementation details and validation boundaries. `PROGRESS.md` records publication status and dated verification.
