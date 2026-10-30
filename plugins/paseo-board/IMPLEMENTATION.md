# Implementation and validation

User authorized implementation and autonomous design decisions. The product definition remains in DESIGN.md: a persistent, fully interactive visualize whose freely authored canvas is the main conversation surface. Contextual questions, discussion forks and agent decision provenance are built-in mechanisms; task content and presentation remain unrestricted.

Plugin directory: `plugins/paseo-board`. The original locally tested source is commit `4fc08fc`; publication changes and fresh-checkout verification are recorded in `PROGRESS.md`.

The plugin is installed and running on Paseo daemon 0.13.2 as paseo-board, from a copied source snapshot at ~/.paseo/local-plugins/paseo-board/dev. Only this new plugin was reloaded; no daemon restart or unrelated plugin reload was required. Desktop is the complete interactive runtime. The user explicitly permits a mobile compatibility interface without reducing desktop functionality.

## Implemented

- Persistent free HTML/CSS/JS canvas, open JSON data updates, local patches, serializable interaction state and explicit whole-document replacement.
- Native Boards navigation, contextual selection and request preview, forks with independent conversation context and direct edits to the shared Board, continued replies and optional forwarding of a selected reply to the owner.
- Separate saved, delivered, processing, answered and applied receipts. Applying a change requires concrete result references; a completed turn alone is insufficient.
- Explicit agent decisions, conservative inferred candidates with original excerpts, and observed changes to declared inputs. User requirements and hidden reasoning are not collected as agent decisions.
- One validated storage service behind typed RPC, agent MCP tools and the standalone CLI. Existing async-shell scripts can emit facts without waking an agent; there is no second task supervisor.
- Durable intent records, optimistic revisions, immutable retry IDs, owner-scoped agent access, ordered delivery, history recovery and explicit uncertain outcomes.

## Earlier automated verification

| Check | Result |
| --- | --- |
| Combined source tests | All 55 passed (5 test files). |
| TypeScript check | Passed |
| Actual Chrome + React canvas integration | 25 groups passed, including the contextual-action follow-up |
| Independent service recovery/concurrency review | 9 tests passed in an independent source-snapshot review |
| Hermes compatibility | Clean build and evaluation reported OK |

The automated coverage includes persistence/restart, revision conflicts, duplicate events, state-write ordering, DOM/control preservation, patch execution and replay, selection capture, frame-message validation, real CLI and stdio MCP child processes, contextual fork payloads and decision provenance. Paseo SDK effects in offline service tests use a fake SDK; those tests do not contact the live daemon.

The final service review verified the repaired failure cases: saved-intent/journal gaps, duplicated replies after interrupted cursor commits, overlapping projected timeline messages, a missed terminal event after restart, a failed partial answer incorrectly completed by a later turn, decision leakage between boards owned by the same agent, returning a later corrected reply, owner reassignment during sending, and FIFO delivery when a new request arrives during turn settlement. These cases are covered by the repository's regression tests.

Empty history reads no longer mutate board revisions. Extraction coverage metadata persists without advancing the content revision, adding history events or changing the board's updatedAt; actual new decisions still create normal revisions. This prevents ongoing message checks from causing content-write conflicts. Replies are reconstructed from source sequence intervals rather than blindly concatenating cumulative snapshots. Missing completion evidence remains explicitly unknown while later requests can proceed.

## Real runtime verification

Initial native desktop verification used actual Paseo via CUA:

- The Boards sidebar and full-screen free canvas opened; scripts and animation rendered.
- A generated ask opened the native preview, and cancelling sent no message.
- A dedicated fixture agent created a test Board through newly injected MCP tools.
- A fixture UI request produced a local interactive addition and an applied receipt referencing #addition. The fixture input value survived; the added button toggled a real reply.
- A contextual discussion fork was submitted from the actual board interface.

After the communication fixes were installed and reloaded, actual backend/runtime verification completed the remaining communication loop:

- The discussion fork's later reply was captured once, with the exact expected wording rather than repeated cumulative prefixes.
- Returning that selected later reply reached the owner and produced an applied result referencing #latest-reply-note.
- A real async-shell task emitted to the board while the root agent was idle. Repeating the same event did not apply another change.

The persistent development Board's initial canvas source is examples/development.html. Initial tests exposed defects in revision churn and cumulative reply handling; the fixes above and the subsequent runtime checks supersede those earlier failures. No general migration of replies already duplicated by the initial test runtime is claimed. Real agent and interaction identifiers remain in private local verification records.

Both fixture agents are archived. Test boards and delivery records were backed up under ~/.paseo/backups/paseo-board-20261028-final before removal. The development demonstration board was recreated through the public CLI with the final interactive canvas, verified delivery status and four explicit agent decisions. The final live check confirmed content revision 2 with two history entries while extraction metadata continued updating, proving the new separation on the installed runtime. No user interactions or unrelated boards were included in cleanup; the plugin is running and its logs show no errors.

## Remaining limitations and verification boundary

- A follow-up native desktop check on the final installed runtime opened the user-facing conversation canvas and verified rendering, animation pause/resume, persisted state, contextual request preview and cancellation. The earlier cgWindowNotFound condition no longer blocked this walkthrough. The real fork/reply/return checks remain those recorded above.
- Mobile has compatibility summaries, decisions and discussion rather than the complete desktop canvas. The no-DOM fallback import and Hermes checks passed; no physical phone test is claimed.
- Paseo 0.13.2 lacks atomic idle-only enqueue. The service checks busy state and owner identity immediately before sending, uses explicit steer behavior and durable ordering, but a narrow SDK check/send race remains. A lost send acknowledgement is not blindly retried; an idle snapshot alone never establishes successful completion.
- Decision extraction is deliberately bounded and conservative. It cannot recover unexpressed internal choices, and observed changes cover only inputs selected for tracking. Ambiguous messages from an owner with multiple boards are not copied to every project.
- Revision-only reads may retain older lastCheckedAt, cursor and coverage-note metadata until a content change or a full read. This is conservative last-known coverage, not live extraction progress. Actual recorded decisions still advance the revision and appear through ordinary polling.
- Desktop updates use revision-aware polling rather than a custom host push channel. Data and local patches preserve the existing frame; full-document replacement intentionally rebuilds it and relies on explicitly saved state where needed.
- Local CLI access trusts the operating-system user. Agent bindings scope Board tools, but do not sandbox an otherwise unrestricted shell running as that same user.
- HTML remains in the restricted frame runtime. External resources follow the renderer's allowed network policy; unavailable resources and failed capture cannot be treated as complete visual context. The current per-board store and shared delivery journal each enforce a 64 MiB limit rather than silently deleting history.

The original delivery was installed from feat/paseo-board; subsequent public repository commits are recorded in PROGRESS.md. The original workspace and other plugin installations remain unchanged.

## First user-facing conversation canvas

The user requested moving subsequent discussion to the Board. The existing board identity and four decisions were retained; its title is now “我们在这里继续” and the authored source is examples/conversation.html. The page includes an adjustable curve, a location for the next response and a free-form message entry bound to the current owner. Explicit element anchors avoid reusing an unrelated old selection. Changes should normally patch the relevant area and retain the neighboring controls and draft. The native preview test was canceled without sending any test message.

## Contextual actions on the desktop canvas

Option/Alt + left drag temporarily selects a region; release opens a menu beside the selection. Normal right-click selects its point, or reuses a same-version text/region selection containing that point. The menu offers question, change and fork, each opening a blank host-owned composer with focus. This original modal workflow is superseded by the in-place conversation changes recorded below. Esc dismisses selection, native editors retain their context menu, and Shift + right-click bypasses the Board menu.

Selection owns a versioned interaction lease through capture and opening the composer. Local updates and whole-document replacement wait, late cancelled screenshots cannot publish anchors, and screenshot jobs serialize temporary canvas prototype hooks. Dragging out of the iframe and releasing over the host cancels the unfinished gesture; completed references remain available to the original toolbar. The ordinary curve controls and draft state remain independent.

Browser checks use an isolated Chrome profile and local fixture. They cover the gestures, all three composer actions, no automatic send, ordinary drag/input behavior, editor and Shift bypasses, cancellation during delayed capture, data/patch/document deferral, first input after iframe focus changes, cross-frame release, and the original host toolbar. Independent review also checked screenshot replacement, hook restoration and rejection of stale frame messages. Physical-phone behavior is outside this verification.

The final copied runtime passed Hermes evaluation and was enabled without restarting the daemon. Native Paseo checks verified the in-canvas right-click menu, a blank focused change composer, and the original top question button retaining the selected point. Both previews were cancelled; no test intent was created. The final reload and reply/guide patches preserved the latest pre-reload curve, speed and draft exactly. The request is applied on the development Board with concrete code and canvas references. Backups are under ~/.paseo/backups/paseo-board-context-actions-20261029-014059 (final reload) and the earlier 013738 directory.

## Issue #3 — in-place conversations

The reference row now keeps a constant height. Its contents and selection hints change without inserting layout above the canvas. Question, change and fork inputs live in a host-owned popover beside the pointer; Enter sends, Shift+Enter adds a newline and IME composition is guarded. No modal is opened for entering a question. The overview, history and decision lists remain optional navigation.

Durable interactions are projected into an isolated marker layer. Replies and returns share their root marker, whose latest status updates independently of the canvas and does not restart its JavaScript. Markers stay at their original coordinates when their frozen anchor is stale, with an accessible label, tooltip and discussion warning. They are excluded from reference screenshots. Opening a marker reveals its questions, statuses, answers and follow-up actions locally.

Forks inherit the source session's public mode, model, reasoning and feature values. Forks can directly publish revision-checked changes, record their decisions and emit updates to the same Board when fulfilling the user's request. They cannot change its owner or another agent's interaction receipt. The scoped respond operation stores text and a separate optional free HTML canvas on the assigned interaction for local explanations. Its response revision supports conflict checking and retry deduplication. Explicit responses are not overwritten by automatic timeline collection. Stream terminal events and late canonical transcript refreshes repair a race in which a finished fork could previously lose its final answer.

Verification for these changes is recorded separately in PROGRESS.md; earlier counts above describe the earlier runtime.

## Direct input and shared-canvas forks

The earlier three-action menu is removed. Right-click and completed ordinary text or Option/Alt region selection immediately open one focused input beside the pointer. Enter targets the main conversation. Command/Control+Enter reuses the selected side agent, creating one if none exists; adding Option/Alt explicitly creates and selects a new side agent. The composer also selects earlier associated forks. Thread context is independent from the delivery destination. Shift+Enter inserts a newline, IME confirmation does not send, and clicking outside dismisses without a close button. Failed sends preserve their original route and immutable intent for retry.

Forks separate conversation context while sharing the Board's mutation surface. They fulfill requested edits directly; returning to the owner is an optional legacy operation. Already-fulfilled queued intents settle durably without being redelivered or blocking the next request. Markers use 18px translucent dots within 26px hit targets, brighten on focus/hover/selection and animate only pending work, with reduced-motion support.
