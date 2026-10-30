# Paseo Board publication and verification

## Goal

Provide a persistent, fully interactive, task-independent conversation canvas for humans and agents. The agent freely authors HTML/CSS/JS; the plugin supplies durable identity, incremental updates, selection, contextual questions/forks and records of meaningful default decisions. Desktop capability is primary; mobile has a compatibility view.

## Decisions

- Keep the free canvas as the main surface, with no required task schema or component catalog, so better models can create richer interactions.
- Reuse attributed renderer assets as local copies because no stable cross-plugin renderer interface is available. Reuse async-shell through its public CLI rather than building another supervisor.
- Use revisioned patches and separate operational checkpoints to preserve controls and avoid false content-update conflicts.
- Separate message delivery from application: an applied receipt needs concrete result references.
- Keep contextual selection and actions near the pointer. Selection holds its displayed version, and the host owns the final message composer.
- Publish only tracked plugin content from local source commit `4fc08fc`, then make build tooling self-contained and remove private machine/session identifiers from public documentation.

## Subtasks

| Task | Status |
| --- | --- |
| Storage, revisions, durability and delivery | Complete; source tests and real fixture flow verified |
| Free canvas, local patches and saved controls | Complete; browser and native desktop checks verified |
| Questions, forks, selected-reply return and default decisions | Complete; documented source and live fixture checks |
| Option/Alt selection and right-click actions | Complete; 25 browser scenarios and native desktop checks |
| Self-contained public build and fresh checkout validation | Complete; clean dependency install and source checks passed |
| Direct publication to remote main | Authorized by user; this change targets main |

## Verification records

### 2026-10-29 — original local source `4fc08fc`

- Daemon: Paseo 0.13.2, primary local daemon. Installed source: retained directory `~/.paseo/local-plugins/paseo-board/dev`. No daemon restart or unrelated plugin reload.
- TypeScript check passed; 55 source tests across five files passed; isolated real Chrome + React integration passed 25 scenarios; Hermes compatibility build/evaluation passed.
- Actual native Paseo UI verified the right-click menu, blank focused change composer, original toolbar preserving the selected point, cancellation without a new intent, and Board reply patches appearing live. The final reload preserved the latest curve, speed and draft.
- Earlier real fixtures verified newly injected tools, local updates, a discussion fork's later reply, returning that selected reply to the owner, and an actual async-shell event while the owner stayed idle. Duplicate events were inert. These are previous recorded checks, not rerun publication checks.
- Backup locations: `~/.paseo/backups/paseo-board-context-actions-20261029-014059` and `~/.paseo/backups/paseo-board-context-actions-20261029-013738`. Private identities and state are not included in this repository.
- Screenshot paths: no persistent screenshots were retained for the final contextual-action walkthrough. Native UI observations are recorded in local session history; no screenshots or mock results are represented as production evidence here.

### 2026-10-29 — publication preparation

- Exported tracked plugin files from `4fc08fc` into a separate checkout based on public main. The daemon continues using its retained local runtime.
- Public documentation removes private filesystem/session identifiers while preserving copyright and license attribution.
- Added a local `scripts/build-client.mjs` with explicit Babel dependencies, so the public plugin builds without tools from the developer's other checkout. Pinned ReactDOM to React's exact version.
- Clean installation, TypeScript, 55 source tests, standalone client build, 25 real Chrome integration scenarios and Hermes evaluation passed in the publication checkout.
- A clean dependency audit identified old test-only dependencies. Vitest was updated to 4.1.12 and Vite pinned to 7.3.7; clean installation, TypeScript and all 55 tests passed again with Node 22.23.4 and npm 11.21.1. The resulting dependency audit reports zero vulnerabilities.
- npm 10 hit an Arborist peer-resolution error while generating the newer test dependency graph; npm 11 generated the lock normally. No force or legacy-peer-deps bypass was used. The README specifies the verified toolchain.
- Public main's Git history is the publication record. The private development checkout records the verified remote commit after push.

## Known boundaries and next steps

### 2026-10-29 — open-ended Paseo compatibility

- Removed the speculative `<0.14.0` upper bound from the manifest; the supported API baseline remains `>=0.13.2`. Updating Paseo no longer requires a manifest-only plugin release just because its minor or major version changed.
- README and OVERVIEW now state the minimum version and no upper cap. Development dependency pins remain for repeatable builds; they do not gate the installed plugin's host version. Node/npm versions in the README describe the verified development toolchain.
- Validated the host's `assertPluginCompatibility` function for both daemon and app: `0.13.2`, `0.13.3`, `0.14.0-beta.1`, `0.14.0`, and `1.0.0` are accepted; `0.13.1` is rejected (12 checks passed). This validates the version gate, not future host APIs or UI behavior. No runtime code changed or UI retest was needed for this metadata update.

- Physical phone behavior and a fresh narrow-width native walkthrough have not been verified; no mobile parity is claimed.
- Source and fixture tests do not replace the real native desktop checks recorded above.
- Decision extraction is conservative and cannot recover unstated private reasoning. A send with uncertain acknowledgement is not blindly retried; the SDK still has a narrow idle-check/send race.
- Future changes should rerun the documented checks and update this ledger; preserve the native runtime's retained directory when cleaning publication checkouts. See `IMPLEMENTATION.md` for detailed behavior and limitations.

### 2026-10-29 — Issue #3 and pointer-local input

- Request: fix reference-induced canvas movement, preserve spatial question markers, inherit fork permission settings and return answers to the Board. The user additionally requested typing beside the pointer and Enter to send.
- Implemented a constant-height reference row and a host-owned in-canvas composer. Enter sends; Shift+Enter adds a line; IME composition is not submission. Ordinary selection and generated requests share this route.
- Added persistent thread markers projected from interactions, with optimistic sending state, version warnings, local replies and optional interactive HTML answers. Marker messages do not change the canvas content revision or rebuild its iframe.
- Fork settings now use the origin's public current mode/model/reasoning/features. A scoped respond operation can write only the assigned response, with its own response revision; the source canvas retains owner-only mutation semantics.
- Repaired completion/history ordering so a late canonical final reply is not permanently skipped. Explicit responses take precedence over timeline fallback.
- Final source checks passed: TypeScript, 70 tests across six files, standalone client build and Hermes evaluation. Canvas browser integration passed 29 scenarios; actual BoardView browser integration passed 10 scenarios, including failed-send retry and visual-answer submission receipts. Host fixture RPC/UI adapters are explicitly identified and are separate from the real daemon checks below.
- Primary daemon 0.13.2, retained directory installation `~/.paseo/local-plugins/paseo-board/dev`: created a fresh inexpensive Codex fixture owner in auto-review/medium/Fast, opened a real fork from the native desktop Board with pointer-local input and Enter. The actual fork snapshot retained all four settings. Both an original response and a later selected reply used the newly injected response tool and appeared at one marker, with independent interactive HTML. A real click changed the answer button to “图解可交互”; the main input and count remained unchanged by response updates.
- Native automation's first typeText dropped Unicode; that malformed fixture prompt was retained as evidence. The subsequent paste was read back from the actual editor before Enter and the exact requested Chinese answer was verified. No malformed input is represented as a successful complete prompt.
- Reviewed and fixed two additional edges: unconfirmed failed sends reuse the original immutable intent instead of referring to a nonexistent parent; reopening the same marker after scrolling forces fresh viewport coordinates. A visual-answer question preserves response-local selection context, and its ask promise waits for accepted submission.
- The initial deployment backup guard failed on an already-applied journal entry, but the shell erroneously continued to reload. No board data was edited in that step; both original boards' revisions, canvas revisions and interaction statuses were checked unchanged afterward. The gap is documented rather than claiming a pre-reload snapshot. Older runtime backups remained available.
- Final installation stopped only this plugin, captured a complete source/data backup, removed only the two archived fixture agents' Board data/journal rows, copied the final source and enabled the plugin. Backup and private live verification record: `~/.paseo/backups/paseo-board-issue-3-final-20261029-185246/`. Restore instructions are included there. No shared daemon restart or unrelated plugin reload occurred.
- Final native UI check confirmed the fixture disappeared, both original Boards remained, historical questions reopened as persistent old-version markers, and the live development Board accepted the local release explanation without replacing its curve or input. Native screenshots were observed and retained in session history, not exported as repository files. Smaller desktop viewport bounds were covered by the browser fixture; physical-phone testing is not claimed.
- The Board change was pushed to public main as `680fd0524c96435e83b0a6cb32f429699b45249f` and verified through both the remote ref and GitHub API. The separate owner-only GitHub triage plugin is integrated under its own directory.

### 2026-10-29 — direct input and shared-Board forks

- User correction: forks isolate conversation context like `/btw`, while fulfilling requested changes directly on the same Board. Removed the discussion-only authorization and the mandatory return-to-main UI; retained ownership, own-interaction receipts and revision conflict checks.
- Unified interaction: right-click, text selection and completed Option/Alt region selection open pointer-local input immediately. Enter sends to the current conversation, Command/Control+Enter starts a fork; Shift+Enter remains newline with IME guards. No question/change classification is required.
- Two additional Board intents arrived while implementation was running: click outside to close without a desktop close button, and animate work in progress at its marker. Both are included in this delivery.
- A fourth intent requests smaller, translucent markers; that visual adjustment is included. Source TypeScript, 76 tests across six files and Hermes build passed. Canvas browser integration passed 26 rewritten scenarios (old menu scenarios were replaced/combined), and actual BoardView integration passed 12 scenarios. The isolated tests use explicit fixture transports; live daemon acceptance is recorded separately below.
- The compact-dot adjustment was followed by five targeted real Chrome scenarios, then all 12 BoardView scenarios and final Hermes evaluation on the combined source through `2d45d8b` plus the generated bundle and stale-marker assertion recorded in this delivery. The complete 26-scenario canvas run preceded the size-only adjustment; it is not claimed as a later rerun.
- Main daemon 0.13.2 remains installed from `~/.paseo/local-plugins/paseo-board/dev`. A fresh Codex Luna/low/auto-review/priority fixture owner created a Board after installation. Native desktop right-click opened focused input directly; clicking outside closed it; Command+Enter created an actual fork with the inherited settings. The fork published a patch to the shared target and marked its interaction applied with canvas and patch references. The owner's identity stayed unchanged. Native UI confirmed the new target text, the pre-existing draft and counter value 2 together.
- The first evidence assertion expected a bare selector while the actual valid result reference was `canvas:#fixture-target`. The assertion was corrected after inspecting the stored patch and receipt; no result was rewritten. Original private evidence and the full final fixture Board are retained under `~/.paseo/backups/paseo-board-direct-input-20261029-190909/` with source/data backups and restore instructions.
- Both fixture agents were archived. Cleanup stopped only Board, backed up current data, removed only the fixture Board and its exact delivery/binding/cursor/active rows, and re-enabled Board. Other Boards were compared unchanged while stopped; the native list then contained only the two original Boards. Cleanup backup: `~/.paseo/backups/paseo-board-direct-input-cleanup-20261029-191351/`. No shared daemon restart, shared workspace archival or unrelated plugin change occurred.
- Screenshots were observed in native UI session history, not exported to public files because the window includes unrelated sidebar content. The real native walkthrough covers desktop; reduced motion, keyboard/IME edges, delayed captures and compact bounds are browser-fixture checks. Physical-phone behavior was not rerun.
- Existing fork sessions may retain an older provider system prompt; the installed SDK cannot rewrite it in place. New forks receive the updated shared-canvas instructions. Publication targets the already-authorized public main; its resulting SHA is recorded in the private release receipt and Git history.

### 2026-10-29 — component anchors and discussion index (in progress)

- Request: keep discussion markers attached to components when layout changes or content collapses, and expose all threads in a persistent side index so they are discoverable on a two-dimensional canvas.
- Design: retain immutable reference evidence while adding optional component identity and relative placement. Follow verified component identity, use a visible collapsed container where possible, and keep unlocatable/deleted references available without guessing a replacement. Legacy references remain readable.
- Desktop reserves a narrow discussion index independently of selection and popover state. Clicking a thread locates it and opens its existing conversation without sending a message or rebuilding the canvas.
- Implementation is split between the canvas/schema and host/index, with independent review. Verification and installation are pending; no completion is claimed in this entry yet.
