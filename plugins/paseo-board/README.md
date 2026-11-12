# Paseo Board

Board composition adds user-selected cross-host sources and isolated `<paseo-board>` embeds to ordinary authored canvases. Monitors and briefings remain free-form Boards; no Paseo client changes or fixed dashboard layout are required. See [composition authoring](docs/composition-authoring.md) and [source reads and provenance](docs/composition-sources.md).

A persistent, fully interactive visualize with contextual human–agent conversations. The agent owns the HTML/CSS/JS canvas. The plugin owns identity, updates, selection, discussion receipts and evidence for the agent's default decisions. There is no task schema, prescribed workflow or component catalog.

## Use

Requires Paseo 0.13.2 or later, with no upper version cap. The development toolchain was verified with Node 22 LTS / Node 24 LTS and npm 11. Managed Git installations and updates run the manifest's locked production dependency installation automatically; npm must be available on the daemon's command path. This installs `linkedom`, used by the server to inspect authored HTML, without running dependency lifecycle scripts. The client bundle is already committed and does not need rebuilding during installation.

For a local directory installation, clone this repository, then run:

```sh
cd plugins/paseo-board
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
paseo plugin install "$PWD" --id paseo-board
```

On macOS, the bundled CLI is also available at `/Applications/Paseo.app/Contents/Resources/bin/paseo`. Keep this checkout at a stable location: a directory install uses it directly and does not run manifest preparation. After updating a directory checkout, repeat the dependency command before `paseo plugin reload paseo-board`. A `Could not resolve "linkedom"` error means this runtime dependency is unavailable in that checkout; install its locked dependencies rather than removing the import. Development and client bundle regeneration require a full `npm ci --include=dev --ignore-scripts` instead.

Click the **Board** pill beside an agent's composer to open its workspace's Boards panel. It restores the Board last selected through that agent's panel; a first visit opens the workspace list, and explicitly going back to the list keeps that choice. The sidebar **Boards** screen and Command Center remain available, and `/board` opens the same agent panel. Ask an agent to create a board, or create one and associate its owner in the UI.

Desktop/web entries remember their selected Board when you return to an agent, workspace or Boards screen; explicitly returning to **Boards** keeps the list selected. Reopening restores the Board's document and nested scroll positions and follow-updates preference for the same host and document. Retained cached content can appear before a required freshness read finishes. A replacement document starts with its own position, and restoration alone does not mark updates seen. A new iframe still reruns authored initialization; unsaved authored inputs and arbitrary JavaScript state are not automatically retained. See [reopening behavior, persistence and verification limits](docs/board-reopening.md).

Use the pencil beside a Board title to rename it in place. Enter saves and Esc cancels; a failed save retains your draft. Renaming does not replace the canvas or reset its controls. If another user changes the title while you are editing, confirm the current name before overwriting it.

The dashboard labels each Board's work state separately from synchronization: an idle Board can still be disconnected, and a busy Board can be fully synchronized. Commits update a compact server-side index. Existing hosts use one shared cursor check while the view is foregrounded, normally two seconds after the previous check completes; unchanged checks read no Board history. Changes fetch the latest summary of each affected Board, even if it updated many times. Background views pause checking, and connection failures back off to at most a thirty-second interval. An open Board still fetches its full persisted content when that Board actually changes; this optimization does not turn all content storage and transport into deltas.

Storage runs in a fixed pool of child processes, with bounded queues and request bytes. It isolates serialization and persistence from the coordinator, while arbitrary canvas rendering remains in the browser. See [worker ownership, limits and recovery](docs/worker-pool.md). Client, worker and application-runtime artifacts are committed; developers must run `npm run build:client`, `npm run build:worker` and `npm run build:app` after changing their source dependencies.

### Editable application backends and native visitor inbox

The installed `paseo-board-app` CLI initializes a normal Node/SQLite project with editable routes, storage, migrations and public files. It provides local run/status/stop, consistent backups and explicit restore, plus SSH plans and deployment lifecycle commands. Application logic is ordinary agent-authored code, not a fixed voting or CRUD product. See [backend scaffold](docs/app-backend-scaffold.md).

External comments have a separate native inbox under **More → Comment inbox**. Connect an application's private export endpoint, then explicitly sync a bounded page. The export token remains on the host. Agent read access and internal triage are independently controlled and initially disabled; received text is untrusted visitor data. Internal labels, status and notes do not modify the application, send an agent message or publish a public reply. These actions still require separate user authorization. See [inbox contract](docs/comment-inbox.md) and [architecture and acceptance scope](docs/app-backends-design.md).

Published Board pages can call an authored backend through `board.request` when the owner includes its exact API origin in the release. The frozen artifact retains its sandbox, supplies no host credentials and uses the website's real CORS origin. See [published application wiring](docs/published-apps.md), including comment intake, idempotent writes and preview limits.

Data the owner marks public under **More → 实时公开数据** reaches a shared page within seconds without republishing. Only the human marks paths and connects the backend; agent writes to those paths then flow until paused or stopped, and the page's code stays frozen. See [live public data](docs/live-data.md).

The 2026-11-08 delivery passed clean-source, browser-component, isolated real-SSH and production Helper checks and was installed locally. A newly created native agent verified default denial, separately granted read access and authorized internal triage. Actual Chrome visitor submission and the connected native Paseo interface verified inbox sync, literal visitor text, permission controls, 420px access, and Enter queue recovery after a full reload. Final readback confirmed the original agent timeline and triage result were unchanged, with permissions revoked and the source disabled. The dedicated fixture was then backed up and removed with one Board-only stop/start; all other Boards were preserved. The standalone `app.paseo.sh` direct connection was not verified. See [verification evidence and remaining limits](docs/verification/2026-11-08-app-backends.md).

The default pointer belongs to the canvas. **Right-click**, finish selecting ordinary text, or hold **Option / Alt and drag** a region to open the host-owned input directly beside your pointer. There is no action menu and no question/change mode to choose. **Enter** adds the current comment to the pending queue without sending. **Option / Alt + Enter** sends only the current comment to this Board's selected side conversation, creating one when none is selected. **Option / Alt + Shift + Enter** creates a new side conversation and selects it. **⌘ / Ctrl + Enter** sends the current comment together with all pending comments to the main owner. Existing-discussion follow-ups preserve their thread: Enter saves a follow-up draft, and Cmd/Ctrl+Enter sends that follow-up only after the separate pending queue has been handled. Unknown send results always retry their original immutable payload and destination. The destination can also be chosen with the send buttons. Select a previous associated fork to reuse it; the thread being viewed does not silently change the destination. If a new side is being created, side messages wait for that same side. Selecting a historical side changes future sends without redirecting already queued messages. **Shift + Enter** inserts a line break; IME confirmation does not send. Click outside or press **Esc** to close. Inputs and editable areas keep native selection/context menus; **Shift + right-click** keeps the native menu elsewhere. The header stays on one 48px row. **选择工具** contains the selection modes, **快捷键** shows a compact reference, and **更多** holds discussions, changes, drafts and publishing. Menus do not resize the canvas. Generated pages can request the same input through `board.ask`; the human chooses the destination when sending.

**Collect several comments before sending:** use **加入待发送** in the local composer, then open **更多 → 草稿** to review, edit or remove the queued comments and send the group to the main or selected Side conversation. Each comment keeps its own frozen location and available PNG; one submission produces one request and one discussion with several numbered positions. Merely closing an ordinary draft does not enroll it in the group. Existing-thread replies retain their single-send flow. The current implementation and verification status are described in [grouped comments](docs/grouped-comments.md).

Decision records describe choices made by the agent, with three distinct sources: explicit agent records, observed changes in declared inputs, and conservatively inferred candidates from visible assistant messages. Unknown rationale stays unknown. User messages and hidden reasoning are not extracted. Candidate collection is a heuristic, not a complete account of all implicit choices.

## Agent interface

New agents receive `board_create`, `board_list`, `board_read`, `board_publish`, `board_respond`, `board_decision`, `board_emit`, `board_feed`, `board_sources`, and `board_read_source` MCP tools. Existing sessions can use:

```sh
~/.paseo/paseo-board/bin/paseo-board read --file /absolute/request.json
```

All commands also accept `--json` or JSON on stdin. Prefer an input file for HTML and complex data. `create`, `publish`, and `respond` accept `htmlFile`. Read the installed `paseo-board` skill for full input shapes and examples.

For requests from a Board or an established Board task, diagrams, simulations, interactive results and changes go to that existing shared main canvas by default, beginning with the first reply. Read it before publishing; Main and Side select the receiving agent, not the result surface. Keep the conversation to a short outcome/entry point unless the user requests another destination. Text-only explanations can remain in the discussion; unrelated chat is unaffected. Without an interaction ID, do not invent one: text can stay in chat and visual results update the known Board. Create a Board only for a new Board task without an existing one.

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
// Or render only one arbitrary JSON path, initially and when its value changes:
const stopWatching = board.watch('/live/source-a', (value, context) => {
  if (context.exists) draw(value);
});
const saved = board.getState();
board.saveState({ zoom: 1.5 });
// Call from an actual click. Opens the local composer; the user sends.
button.onclick = () => board.ask({
  prompt: "Explain this part", kind: "question",
  anchor: document.querySelector("#comparison")
}).then(result => {
  // "queued" means saved in the local pending list, not submitted to an agent.
  if (result.status === "submitted") console.log("Request accepted");
});
```

`board.restoreState()`, `board.onState(callback)` and `board.getContext()` are also available. `window.openai.sendFollowUpMessage` is compatible with visualize-style requests. The result describes the composer action, not the model's answer: `submitted` means the request was accepted, `queued` means the comment was saved locally for later grouped sending, and `cancelled` means it was not submitted through this composer. `anchor` accepts a connected authored element in this document, `{target: element}`, or a plain versioned anchor. Element anchors become selector/geometry/binding data before crossing the iframe boundary; DOM nodes and events are never sent as message payloads. Detached, foreign-document and Board-overlay elements are rejected. Plain anchors preserve their captured revision; invalid core fields reject rather than guessing a different target. Use stable DOM IDs for local edits; selection also works without IDs.

The **Components** selection mode inspects the existing DOM without rewriting it. Hold **Command/Control+Shift** to preview the component under the pointer, then click to select it. The inspector shows actual ancestors and direct visible children. **Reference component** opens the usual composer with an element anchor; **Esc** exits. Discovery uses existing IDs and semantic elements, with the clicked element as a fallback; an optional `data-board-component="Chart"` supplies a label and boundary. Neither this attribute nor a component schema is required. Arbitrary authored HTML, CSS, JavaScript, event handlers and rendering libraries keep their existing behavior outside selection mode.

The inspector also prepares structural edits. Drag the selected component body or its move handle. Pointer insertion at sibling edges and actual gaps places components between siblings, with container centers retaining nesting. Inert visual copies make room before the drop while the original nodes remain unchanged. **••• → 拖动让位动画** turns off movement while retaining the static preview; reduced-motion preferences do the same. The toggle lasts only for the current canvas frame. **Tab/Shift+Tab** still choose the destination's parent/child level; **Up/Down** insert before/after the target, and **Left/Right** insert at the beginning/end inside it. Complex positioning may refuse automatic dragging, and a copy that exceeds its bounds falls back to a labelled insertion line. Runtime `8a8f428` was verified and installed during that delivery after all 26 clean verification commands and five actual primary-daemon Web checks passed. See [pointer insertion behavior and limits](docs/component-editing.md#pointer-insertion-and-drag-preview) and the [delivery evidence and limitations](docs/verification/2026-11-03-drag-preview.md).

**Command/Control+C/X/V** copy/cut/paste the selected component within the current Board; normal text controls retain their clipboard behavior. Cut leaves the source in place until a paste is saved. **Edit text** changes an individual direct text run while retaining inline markup. Dropping prepares a change; the host's **Save changes** control commits the preview, and **Cancel** keeps the original. Changes use the existing versioned patch journal and reject concurrent stale edits.

The component **布局** menu can make contents collapsible, wrap a component in a titled disclosure, or limit its height to a local scrolling window. Preview changes and drag the preview’s bottom handle or enter a height, then use the existing host Save/Cancel controls. **恢复原样** stages removal of these settings. Structure survives reload and static export; each viewer’s open/closed choices are stored separately. See [container layout controls and limits](docs/container-layout.md).

Move preserves the existing node and listeners. Copy produces authored structure with distinct IDs/internal references, strips scripts and inline handlers only from the copy, and does not reproduce JavaScript closures, runtime state or external ID-bound styles. Runtime-only or ambiguously identified elements cannot be persistently edited by guessing a source target. Agent code/data updates remain available. See [the editing contract and limits](docs/component-editing.md).

For custom tab or disclosure navigation, register an optional reveal handler:

```js
const stopReveal = board.onReveal(async ({ target, reason, signal }) => {
  // Called only when the user explicitly locates a discussion in the sidebar.
  if (reason !== 'interaction' || !myPanel.contains(target)) return;
  await prepareMyPanel({ signal });
  if (signal.aborted) return;
  showMyPanel(); // Your existing state/navigation implementation.
});
// Call stopReveal() when this authored component is removed.
```

`target` is the verified live DOM element; `reason` is `"interaction"`. Callbacks run sequentially. A new navigation request, ordinary canvas interaction, selection change or three-second deadline aborts the signal. Async handlers must check it before changing their own state. The runtime revalidates the request before navigating, but cannot stop arbitrary authored JavaScript that ignores cancellation. Navigation grants no `board.ask` activation or message submission. Unknown, deleted, ambiguous and old-document targets do not invoke the callback. A custom view without standard ARIA tab relationships needs this callback to reveal itself; Board never guesses its buttons or rewrites its visibility styles.

`board.watch` returns an unsubscribe function. It distinguishes missing values from null, isolates callback data and skips changes outside its selected JSON Pointer. Clean up subscriptions before removing their components. It preserves arbitrary rendering code; it does not choose a chart or rebuild DOM. Compatible host-to-frame delivery uses versioned path deltas, verified array tails and automatic full-snapshot recovery without remounting. Unchanged theme values cause no CSS rewrite or theme event. Legacy frames keep full snapshots. Host-side diffing, upstream RPC polling, whole-envelope persistence and legacy full-data callbacks remain broader costs.

Use `board.watch(path, render, { schedule: 'frame' })` to keep the initial synchronous callback and coalesce subsequent rendering to the latest value per animation frame. Unsubscribe cancels pending work. This optional scheduling policy does not retain intermediate events or change the author's chart/DOM implementation.

For a compact agent check, call `board_read` with `view:"inspect"`, optional `dataPaths`, `interactionIds`, `selector`, and `recentLimit` (default 8, maximum 20). This omits historical images and full HTML, bounds requested values/excerpts, and reports every omission. It retains the same reader permissions as a full read. The default full view is unchanged. Both expose persistent evidence; neither observes live browser pixels or proves that a renderer succeeded.

The host supplies a default palette; authored CSS takes precedence through a lower-priority default layer. Headings and body text inherit their surrounding color. For a fixed light or dark design, set its background, foreground and `color-scheme` together, and provide coherent colors for controls and muted text. For an adaptive design, use matching host surface and text tokens. Host theme changes preserve the canvas runtime and do not override an authored `color-scheme`; images and Canvas/WebGL drawings still need the author's own palette handling.

The installed Board skill documents the injected visualize design system: semantic surface/text pairs, categorical and ordered chart colors, local Geist/system font stacks, typography, layout helpers, buttons, fields and SVG plot classes. These are optional tools for free HTML, not a prescribed layout. The default page width is 960px and may be overridden for a wide desktop board. Scope custom CSS to the component that owns it instead of globally redefining shared classes such as `.card`; update its existing style element and clean up listeners when replacing it.

Network access is limited to HTTPS resources on `unpkg.com`, `cdn.jsdelivr.net`, `esm.sh` and `cdnjs.cloudflare.com`; fonts are not downloaded automatically. Lucide and Floating UI helpers are included only when the **initial HTML** requests them. A patch that first introduces `data-lucide` or `data-tooltip` does not install those helpers; later icons also need `createIcons()` after the loader is ready. The skill explains those conditions and alternatives.

Visual verification needs the actual Board renderer. A raw HTML file lacks its injected styles and runtime, and there is no `board_preview` tool. Use an owned test Board in Paseo, or an isolated development harness built with `buildBoardDocument` for explicit light/dark palettes without changing the user's global theme. Clearly distinguish renderer checks from native UI verification; the repository's browser tests cover their fixtures, not every authored design.

### Liquid-glass style preset (optional)

An agent can give a Board the built-in "liquid glass" (液态玻璃) look by writing semantic markup only: `data-style="liquid-glass"` on the outermost container (plus `data-lg-page` for a whole page), `data-lg` roles (`nav`, `card`, `expand`, `split`, `palette`, `dock`, `chart`), named controls (`data-lg-name` / `data-lg-key` with `data-lg-by`), rolling numbers (`data-lg-count`), `lg-*` layout helpers and built-in icons (`data-lg-icon`). The [example page](examples/liquid-glass.html) has no page script and no page CSS. Re-tint with `--lg-accent`, `--lg-peach`, `--lg-rose`, `--lg-apricot`, `--lg-chart-top`/`--lg-chart-bottom` and `--lg-ink` on the scope.

- **Opt-in.** Board inlines the preset (version 1.0.0, CSS + JS, no network) only when the base HTML or a patch contains the marker in an attribute, CSS selector, `dataset.style` or `setAttribute` context. Every other Board produces byte-identical documents and releases (pinned by tests). `data-lg-builtin="off"` opts out; a Board that already inlines the prototype kit (`#lg-kit-script`) keeps it.
- **Everywhere the canvas runs:** live Board, response canvases, exported and published releases (offline exports included), light and dark hosts (the preset owns a fixed light colour scheme), desktop and narrow panes (compact dock that tucks away while scrolling down; the page always reserves space below the last content).
- **Keyboard.** `/` opens the page's command palette. In Paseo it works before you click into the canvas when this Board's screen (or, for the Board route screen, nothing) has focus; text fields, the composer, terminals, dialogs, `⌘K`, `?` and other shortcuts stay with Paseo. Esc hands focus back. Published pages focus their canvas on load.
- **Live patches.** A patch that first introduces the marker rebuilds the canvas once when it is idle, keeping the reading position.
- **Cost.** A glass document grows by about 140 KB (about 35 KB gzip). The plugin's client bundle and store worker each carry the preset as string constants: `client/hermes-bundle.js` grew by 150,519 bytes and `server/assets/store-worker.txt` by 143,410 bytes at 1.0.0.
- **Limits.** Component move/copy/layout in the Board UI works for cards, KPI tiles, lists, nav, split and dock; charts and expand modules contain generated structure, so edit their source instead. See [the preset reference](docs/liquid-glass.md) for the full contract, coverage matrix, measured behaviour and a manual Paseo checklist.

The [interactive diff example](examples/interactive-diff.html) uses the injected palette and controls, with split/unified views and editable bounded line comparisons. Append its self-contained section to a Board; its controls remain local and save only their own state field. It is illustrative content, not a mandatory Board layout or a publication-history diff.

## Latest-state feeds

Use a feed when a background process reports successive arbitrary JSON values. The installed dependency-free Node helper handles sequence IDs, identical retries and a durable pending operation; the canvas decides how to render the data.

```js
import { createFeed } from '/absolute/paseo-home/paseo-board/lib/feed.mjs';
const feed = await createFeed({
  boardId: 'my-project', sourceId: 'source-a', path: '/live/a',
  stateFile: '/absolute/private-task-directory/source-a.json',
  focusSelectors: ['#source-a-view']
});
await feed.set({ value: 42 }); // Quiet: data updates without an unread/highlight item.
await feed.set({ value: 43 }, { attention: 'milestone' });
// Canvas: const off = board.watch('/live/a', value => render(value));
```

The installed skill supplies the actual import path and the equivalent CLI/MCP `feed` actions (`open`, `set`, `append`, `status`, `close`). The process requires its owning agent's binding; do not copy its value into code or prompts. A detached async-shell task needs an explicit launch-time environment handoff, shown below. Use a unique durable `stateFile`, await each operation, and keep sources on disjoint object paths. A set replaces that source's complete value. Missing object parents are created; overlapping sources and scalar/array parents are rejected.

Register the producer from the owning agent's ordinary shell tool using the public async-shell CLI. Replace the CLI path with the installed one; the generated Board skill supplies it. The shell expands these variables locally without exposing their values to the model:

```bash
/absolute/paseo-home/paseo-async-shell/bin/paseo-shell register \
  --description "Update this Board from task data" \
  --idempotency-key "my-board-source-a-v1" \
  --cwd /absolute/task-directory --timeout 3600 \
  --env "PASEO_BOARD_HOME=${PASEO_BOARD_HOME:?Board runtime missing}" \
  --env "PASEO_BOARD_BINDING=${PASEO_BOARD_BINDING:?Board session identity missing}" \
  -- node /absolute/task-directory/producer.mjs
```

The MCP registration server does **not** inherit the calling session's environment. Do not enable shell tracing or print the binding; do not override `PASEO_AGENT_ID`, which async-shell sets from the caller. Its public task receipt excludes environment overrides. A Node registration wrapper should capture output and avoid logging raw `execFile` errors, which can contain expanded arguments. Keep the registration idempotency key when its result is uncertain. The private `stateFile` stores pending data and ACKs, not credentials; restarting a producer still requires this owning-agent launch environment. No extra supervisor or Board credential store is introduced.

Unknown outcomes retain exactly one pending request; restarting with the same configuration replays it before accepting new work. Confirmed conflicts need inspection and explicit reconciliation. A changed generation fences older producers; changing the same path through normal publication also stops a stale feed. `feed.retry()`, `feed.status()`, explicit `feed.reopen({discardRejected:true})`, and `feed.close()` expose recovery rather than silently overwriting another writer.

Quiet and milestone affect attention, not durability or model wakeups. Neither wakes an agent. Values are limited to 256,000 bytes, one pending request per local journal, 64 retained source identities per Board and 32 recent replay receipts per source. Keep large artifacts outside Board and publish references or summaries. Default feeds retain latest state; use explicit records mode below when every accepted sample must remain. Atomic whole-Board storage and upstream polling remain. Frame deltas do not turn this bounded store into an unbounded telemetry database. Async-shell remains the process supervisor.

## Optional latest-state coalescing

```js
import { createLatestWriter } from '/absolute/paseo-home/paseo-board/lib/feed.mjs';
const writer = createLatestWriter(feed, { delayMs: 16 });
const outcomes = [writer.offer({ progress: 10 }), writer.offer({ progress: 20 }), writer.offer({ progress: 30 })];
await writer.flush();
const dispositions = await Promise.all(outcomes);
await writer.close();
```

This helper retains one immutable submitted request plus one replaceable staged latest value. Each offer returns `committed` with an ACK, `superseded` before submission, or `cancelled` before submission. Staged values are volatile until the raw feed journals them. Ordinary awaited `feed.set` is unchanged; records and milestones cannot be coalesced. Drain first and use raw `feed.set` for a milestone while the helper is idle.

`flush`/`drain` returns the last durable ACK or exposes the original error; it never retries silently. `retry` verifies the exact retained request before using the SDK's guarded retry, so an earlier ACK cannot become proof of a new write. Unknown writes block later submissions. A rejected offer stays rejected even after successful retry. `dispose` cancels staged work, waits for any active call and preserves durable pending state for explicit raw-feed reconciliation. `close` drains and closes; a failed drain requires explicit recovery before closing again. The helper is not a durable queue or a process supervisor. `delayMs` defaults to 0 and is bounded to 60000.

## Optional ordered records

```js
const samples = await createFeed({
  boardId: 'my-project', sourceId: 'samples-a', path: '/history/a',
  mode: 'records', capacity: { maxRecords: 10000, maxBytes: 1000000 },
  stateFile: '/absolute/private-task-directory/samples-a.json'
});
await samples.append([{ step: 1, loss: 0.8 }, { step: 2, loss: 0.6 }]);
// Canvas remains arbitrary author code, optionally coalesced to display frames:
// board.watch('/history/a', records => draw(records), { schedule: 'frame' });
```

Records are arbitrary JSON in an ordinary retained array. Each batch commits atomically, with per-source ordering, the same durable journal and exact ACK replay as latest feeds. Retry cannot duplicate a batch; generation changes retain compatible prior records and fence old writers. Manual same-path edits conflict. Mode and records path are stable source identities; different sources use disjoint paths, without a cross-source total order.

A batch contains 1–1000 records and at most 256,000 UTF-8 serialized bytes. Retention defaults to 10,000 records / 1,000,000 serialized-array bytes, capped at 50,000 / 1,500,000; existing compatible records count toward it. Overall canvas JSON is limited to 2,000,000 bytes across all sources, and the persisted Board envelope to 64,000,000 bytes; either may reject earlier. The per-source cap leaves room for other data but does not reserve that room, and compact history still grows. `capacity_exceeded` rejects the entire batch before mutation and reports usage and limits. There is no automatic eviction. Inspect `recordCount`, `recordBytes` and `capacity`; keep larger histories in external artifacts. Display coalescing may skip frames, never accepted records.

## Multiple writers

`board_read` adds an `authoring` view. `materializedAuthoredHtml` statically replays the ordered patch journal without executing scripts; an optional `selector` returns a composed target fragment. `canvas.html` remains the underlying base document for replay and is **not** the current patched source. An unresolved/ambiguous/dynamic patch stops composition and returns null with its failure location. This view is authored source, not the running DOM, event listeners or Canvas pixels.

On fragment canvases, `selector: "body"` with `append` or `prepend` inserts at the authored fragment boundary. Existing saved entries also replay through export and Board copy without migration. Read without a selector to obtain the complete composed source; the virtual `body` wrapper is not an editable component. Fragment `html`/`head` insertion is unsupported, and replacing/removing document roots is rejected before saving. For a different incomplete journal, export/copy identifies the failing patch and selector: reconcile the base and **every** later patch in a complete draft before a guarded full replacement. Republishing only `canvas.html` would lose later work. Live patches targeting script-generated elements remain supported, but static export cannot execute those scripts to resolve the target.

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

Reuse async-shell to wait for external events, using the environment handoff above for scripts that write Board data. Its script calls `paseo-board emit` with stable event IDs. Shared data uses conditional `dataPatch`, or traditional `data` with the canvas base captured when that payload was prepared. Pure facts/observations need no canvas condition. Delayed data producers must reconcile a conflict instead of overwriting newer results. The board updates while the owner is idle. `emit` never sends an agent message. If interpretation or action is needed, the same shell can use `paseo-shell sendback` with an idempotency key. Board does not implement a second shell supervisor or read async-shell's private files.

An optional `observation` names an input to track. A changed value creates an observed record with supplied evidence and no invented reason. It does not automatically inspect all commands, files or parameters on the machine.

## Conversation and durability

Desktop/web contextual message drafts are saved on this client, separately for each host and Board. Escape/outside click tucks a draft away; **草稿** resumes it with its original component reference and PNG. Reopening never sends automatically, and uncertain sends keep the same request identity. See [draft recovery and platform limits](docs/message-drafts.md).

Use **更多 → 导出与发布** to create a fixed interactive website. **复制为发布 Board** first creates an independent editable copy when the published design should differ from the working Board. Each export captures the final authored source and explicitly selected public data; discussions, drafts and author saved controls are excluded. Preview the frozen result, then download its ZIP for a static server or choose GitHub Pages. Later Board edits do not alter that snapshot.

GitHub Pages uses an existing `gh` login on the daemon machine. Choose the account and repository, review the frozen snapshot, then click **一键发布**. The server creates and verifies its PR, merges the fixed commit, and checks deployment plus every public file before showing an online link. Closing or reloading the panel does not stop an explicitly authorized publication. Existing branch-based Pages sites receive the release in a separate directory while their source settings and other pages remain intact. Repository/organization permissions, required checks, Actions policy and Pages availability still apply; old prepare-only requests never gain automatic-merge authorization merely by reopening the panel. The [publishing guide](docs/publishing-design.md) covers the local export CLI, supported resources and recovery limits. `board.publish` remains the separate operation for editing the working canvas.

The publisher supports **github.com and GitHub Enterprise**. **读取 GitHub 账号** discovers configured accounts; optionally enter the company GitHub hostname to query only that server. Select an account by both login and hostname. Company GitHub does not require a github.com login. If the selected host has no usable account, run `gh auth login --hostname <your-github-host>` on the machine running that Board's daemon. The selected hostname stays bound to repository reads, publication and retries; token lookup never switches the global active account.

New GitHub Enterprise Server sites use branch-based Pages publication without requiring the unsupported public Pages deployment Action. Existing branch-based sites keep their source settings and receive a separate release directory. The site URL comes from the selected GitHub server, including internal/custom domains. A successful deployment behind company login can be opened as **打开网页（内容待核验）**; it is marked verified only after its actual files match. Company Pages availability, permissions, network access and TLS trust still apply; the plugin does not bypass company policy or send GitHub credentials to the published website.

Selections carry canvas and board versions, quote/geometry and a best-effort PNG. PNG capture can fail for protected or cross-origin content; missing capture is surfaced rather than silently treated as a complete visual snapshot. Old selections remain old; the agent must reconcile them before editing.

Sticky elements can be captured when their geometry is reproducible, including ordinary unscrolled tab bars and elements still before their sticky threshold. Shadows use directional paint bounds, so a small halo does not invalidate a nearby selection. Displaced or ambiguous sticky positions, transformed sticky content and unsupported scrollport geometry still report a capture limitation while retaining the geometric reference. Capture does not move the live element or reset its input, focus or scroll position.

A fork is a separate conversation context on the **same shared Board**, like `/btw`; it is not a clone of hidden provider state. It is linked without a parent relation to avoid cascade archival and inherits the originating session's permission mode (including auto-review), model, reasoning and feature values. A user-requested modification is performed directly with revision-checked Board patches—no return-to-main step is required. Associated forks can publish to that Board and record decisions/events, while ownership and other agents' interaction receipts remain protected. `board_respond` attaches text explanations/receipts to the original marker; interactive figures belong on the shared main canvas unless the user explicitly requests a separate answer visual. Legacy return records remain readable. `answered` means a reply exists; `applied` needs concrete result evidence. A completed turn alone never proves a requested change was made. Explicit `processing` receipts remain in progress across completed turns and plugin restarts, so an async-shell continuation can finish the request later.

Questions leave small, translucent numbered markers. New references also capture component identity and relative position, so their markers follow layout changes; native closed details and clipped scroll containers can show a marker on their visible summary or container. Markers inside inactive tabs or hard-hidden custom views stay hidden instead of appearing on the shared dashboard shell. This works with ordinary `hidden`, `display:none`, `visibility:hidden`, `content-visibility:hidden`, zero opacity and `aria-hidden` boundaries without requiring a tab schema. The original quote, coordinates, image and version remain unchanged. Hover, focus or selection brings markers into full contrast. Pending work shows a soft animated halo and rotating ring, respecting reduced-motion settings; completed work is still. Clicking a marker opens its conversation.

A permanent discussion index at the right lists every root thread, including offscreen, hidden, collapsed, deleted and unanchored content. Selecting an entry explicitly requests navigation: Board can open native details and activate a uniquely associated, enabled ARIA tab (`role="tab"`, `aria-controls` and `aria-selected`, inside a tablist, controlling one `role="tabpanel"`). Nested navigation proceeds from the outer view inward, then scrolls the target's containers. Ambiguous controls, links and form-submit controls remain untouched. Passive updates never activate navigation. Custom navigation uses `board.onReveal` above. None of these actions submits a message. Follow-ups share the original number. Selection and popovers do not change the canvas width. The index stays narrow at compact widths.

The compact update navigator moves directly to recent published changes and briefly highlights their visible target, including nested horizontal/vertical scroll areas. It follows the newest unread change by default; previous/next pauses following so concurrent arrivals do not move the place being reviewed. Input, dragging, selection and composition defer automatic navigation. The Board index shows unread counts. Each update becomes seen only after all of its locations are confirmed visible; stale/deleted targets stay available without a fabricated location. The highlight stops after three pulses, with a static alternative for reduced motion.

Stable, unique HTML IDs identify the same component through local patches; use a new ID for a different component. Duplicate IDs, missing targets and whole-document replacement do not silently bind an old marker to new content. Historical references without component metadata keep their frozen positions and remain accessible in the index. Layout, DOM changes, scrolling and completed CSS transitions update placement; pure CSS transform animation is not tracked frame by frame. Old references remain labelled as old even when their component can still be located.

Messages carry only the current request, Board/interaction IDs, versions, frozen selection evidence and a brief receipt instruction. Full canvas code, data and decision history stay available through `board_read`. A follow-up sends a bounded source excerpt; its complete selected source text/reply/version/references are preserved as `interaction.sourceSnapshot`, so later edits cannot rewrite what the user selected. No source HTML is copied into that snapshot. Retries preserve the original destination, source, creation settings and message rather than consulting whichever side is selected later.

A discussion agent records text explanations or receipts through `board_respond` (or CLI `respond`) with `boardId`, `interactionId`, `eventId`, `expectedResponseRevision`, and `response`. Missing `responseRevision` means zero. When the user explicitly requests a separate answer visual, optional `html` / `htmlFile`, `patch`, and `data` create a freely interactive canvas inside that marker’s discussion. It has its own version and never updates the main canvas. Otherwise, owners and associated forks use `board_publish` with evidence for visual results and changes to the shared main canvas. Explicit answers take precedence over fallback final-message collection.

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
