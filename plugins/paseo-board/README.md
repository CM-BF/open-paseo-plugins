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

The default pointer belongs to the canvas. Hold **Option / Alt and drag** for a temporary region selection; releasing opens **提问 / 修改这里 / 开 fork** beside the selection and returns to normal interaction. **Right-click** anywhere on the canvas to use that position, or right-click inside existing selected text or a region to use the selection. **Esc** cancels. Text inputs and editable areas keep their native context menus; **Shift + right-click** bypasses the Board menu elsewhere. The toolbar selection controls remain available. Contextual actions open an empty host-owned editor beside the pointer, inside the canvas. **Enter** sends, **Shift + Enter** inserts a line break, and **Esc** closes it. IME composition does not send. The reference strip occupies a fixed toolbar row, so selecting or clearing a reference never moves or resizes the canvas. Generated pages may still request a preview through `board.ask`.

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
  "eventId": "explain-update-1",
  "patch": {
    "id": "explain-update-1",
    "selector": "#explanation",
    "operation": "append",
    "html": "<div id=\"new-explanation\">An interactive explanation…</div>"
  }
}
```

Use stable event IDs for retries. Conflicting versions reject rather than overwrite a newer change. A data update or local patch keeps the existing iframe and unrelated DOM, input values and animation state. A full document replacement is explicit and rebuilds the frame; use the state API to restore selected controls. Patch scripts execute once per document instance and are replayed when that document is reopened.

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

## Background events

Reuse `register_async_shell` to wait for external events. Its script calls `paseo-board emit` with stable event IDs and open JSON data. The board updates while the owner is idle. `emit` never sends an agent message. If interpretation or action is needed, the same shell can use `paseo-shell sendback` with an idempotency key. Board does not implement a second shell supervisor or read async-shell's private files.

An optional `observation` names an input to track. A changed value creates an observed record with supplied evidence and no invented reason. It does not automatically inspect all commands, files or parameters on the machine.

## Conversation and durability

Selections carry canvas and board versions, quote/geometry and a best-effort PNG. PNG capture can fail for protected or cross-origin content; missing capture is surfaced rather than silently treated as a complete visual snapshot. Old selections remain old; the agent must reconcile them before editing.

A fork is a new discussion agent with explicit context, not a clone of hidden provider state. It is linked without a parent relation to avoid cascade archival. It inherits the originating session’s permission mode (including auto-review), model, reasoning setting and available feature values. Its Board tools may read the source board and write its assigned interaction response, but cannot change the source canvas or another agent’s response. Bringing a conclusion back is a separate user action. `answered` means a reply exists; `applied` requires a result reference. A completed turn alone never means a requested change was made.

Questions leave durable markers at their original point, region or text location. They show delivery, work and answer status; clicking one opens the discussion and its follow-up actions beside it. Markers survive reopening. Replies and returns remain attached to their original thread. Old canvas versions stay visibly labelled; the plugin does not guess that an old point still refers to a newly positioned element.

A discussion agent answers through `board_respond` (or CLI `respond`) with `boardId`, `interactionId`, `eventId`, `expectedResponseRevision`, and `response`. Missing `responseRevision` means zero. Optional `html` / `htmlFile`, `patch`, and `data` create a freely interactive visual answer inside that marker’s discussion. This response has its own version and never replaces the main canvas. Explicit answers take precedence over fallback final-message collection. Source owners continue using `board_publish` with evidence when applying changes to the main canvas.

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
