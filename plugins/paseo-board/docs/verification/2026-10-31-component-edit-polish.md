# Component editing feedback fixes — verification

## Revision and delivery scope

Runtime `6bbc490e6f48b5bf2d6e7c8d38195ca31090d3bd` passed clean integrated checks and was installed in the retained local directory `~/.paseo/local-plugins/paseo-board/dev` on the primary Paseo 0.14.0 daemon. Work remains on `sw/board-interaction-next` and [draft PR #4](https://github.com/CM-BF/open-paseo-plugins/pull/4). Local testing is authorized; a main push or merge still requires explicit user approval.

Private evidence lives under `~/.paseo/verification/paseo-board/component-edit-polish-20261031/`. The clean receipt is `combined-1793483192137930000/receipt.json`, installation is `install-1793483336954-8dc2f4.json`, and native readbacks and observations are collected in `native-acceptance.json`. The final documentation commit and feature-branch publication result are recorded separately. Machine identifiers, Board content and screenshots containing unrelated UI are not published here.

## Problems addressed

- A definite anonymous-source refusal lost its domain code when wrapped as a generic host error. The client therefore treated it as an unknown save outcome and kept editing locked. `board.edit` now returns typed, event-scoped applied/rejected results for known pre-commit refusals. Generic host errors, worker exits and I/O failures remain unknown; they retry the same immutable event, base and payload.
- An anonymous destination contained a live value inside a uniquely identified descendant. Parsed source matching now allows that descendant's live content when its identity and structure remain unchanged, while retaining guards on anonymous text, outer attributes, containment and duplicate identities. Copies still use authoritative saved markup.
- `all: initial !important` overrode ordinary inline hover geometry. The corrected overlay has a target-aligned rendered rectangle. Earlier label-only assertions did not establish this visual behavior.
- The inspector is now a compact toolbar with optional hierarchy/actions. Dragging shows a static content copy and insertion line. Move/copy proposals show an isolated layout preview before Save, with original/preview comparison and cancellation.

## Fresh clean-archive checks

All 14 commands ran against the exact clean archive and exited successfully; their log hashes match the receipt. No previous browser or Hermes result was reused.

| Check | Result and scope |
| --- | --- |
| TypeScript | Passed. |
| Full source suite | 298 tests across 22 files passed. |
| BoardView browser suite | 38 checks passed. |
| Dashboard browser scope | 9 checks passed. |
| Component-edit host browser scope | 12 checks passed. |
| Canvas browser suite | 66 checks passed. |
| Clean worker/client rebuilds | Both byte-identical to committed assets. |
| Hermes compatibility | Passed. |
| Production-only host packaging | Actual manifest preparation, compiler and evaluator passed. |
| Packaged worker processes | Two independent Helper-as-Node children; real IPC edits, typed outcomes and exact retry passed. |
| Diff validation and cleanup | Passed; isolated build and packaging directories removed. |

The browser suites execute 125 PASS rows with 115 distinct labels: the five title checks repeat across the three BoardView scopes. They use real Chromium and production BoardView/runtime with adapted Paseo transport/native primitives. They are separate from the installed native app walkthrough below.

The host edit scope checks known rejection recovery, retained text, generic `handler_error` uncertainty, unchanged retry requests, remount behavior and compact Save controls. The canvas scope exercises live and cold anonymous-footer edits through the actual server preparer, along with the existing SVG, marker, capture, theme, incremental-data and conflict regressions.

Visual assertions measure the hover outline at 390 by 120 pixels, exactly aligned with its target, and the collapsed toolbar at approximately 338 by 57 pixels. Drag checks verify a visible content copy without scripts and a destination insertion line. Static preview checks retain authored layout styling, reveal the inserted component on both nested scroll axes, and leave original DOM, input values and scroll unchanged. Separate actual BoardView checks at 1200 by 900 and 900 by 740 verify no overlap between the green result and the 340-pixel Save card.

A focused Chromium trace verifies that clicking the preview focuses its viewport, wheel scrolling changes only the copy, Tab reaches the toolbar then host controls, and Escape returns to the original view. Hidden heavy content is skipped; visible excess text, attributes and bitmap cost are bounded. An independent preview/commit comparison on the saved fixture found matching geometry and inspected layout styles; it does not establish pixel identity for arbitrary custom components.

## Artifacts and packaged processes

| Asset | SHA-256 |
| --- | --- |
| `server/assets/store-worker.txt` | `267fd6699a9183745294bf45985eaead174c90b2dedf4324773b5173734bbcc2` |
| `client/hermes-bundle.js` | `dbeed0dd2748678b676aecd50fece82d170f279239758de245ef5752e78dae8e` |

The production packaging probe uses the installed Paseo compiler/evaluator and Helper binary in explicit Node mode, reporting Node 24.20.0. Manifest preparation installs locked production dependencies only. The compiled client entry is 395,992 bytes; the compiled server entry is 2,440,031 bytes. These sizes describe host-compiled entries, not the two source assets above.

Real worker IPC commits guarded text, move and copy operations. The packaged user-edit wrapper validates applied/rejected results: the dynamic anonymous destination succeeds, its exact retry adds no second move, and a definite identity refusal adds no revision. This probe tests the packaged wrapper and workers; the native Save below exercises the installed authenticated UI/RPC route. Closing the isolated pool reaps both children and releases its own lease.

## Authorized local installation

The installer verified the passed receipt and source, backed up the previous plugin/data/settings/runtime, then synchronized all 119 tracked files into the retained installation. Backup: `~/.paseo/backups/paseo-board-component-edit-polish-1793483336954-8dc2f4/`. The original installation source is recorded there for restoration; no old user data was restored during this update.

A single Board-plugin disable/enable cycle loaded the verified revision. All four existing Boards retained their canvas, title, saved state and feed hashes across installation. Exactly two worker children started from the verified artifact. The shared daemon was not restarted, and unrelated plugins were not reloaded. The old in-memory pending edit disappeared during the plugin reload and was not automatically resent; native acceptance below uses a newly proposed edit rather than claiming recovery of that old request.

## Native desktop acceptance

The actual installed app was exercised on the user's retained interaction test Board through native controls and authenticated host Save. No agent, project or workspace was created.

1. Command+Shift click showed a visible blue component outline. The hierarchy control selected the whole original article, and the compact toolbar left its content visible.
2. Command+X retained the source. Selecting the anonymous footer and pasting showed the intended destination and a green reflow preview above the compact Save controls. The original/preview toggle made the proposed layout comparable with the existing one.
3. Cancel removed the proposal. Public readback confirmed exact preservation of the canvas, saved state and interactions.
4. Repeating the proposal and using host Save moved the original article from its existing component container into the anonymous footer. Board revision advanced from 44 to 45 and canvas revision from 5 to 6; the in-page runtime marker stayed unchanged during Save. Reopening produced a new runtime marker and retained the committed placement.
5. A second native cut/paste proposal placed the article back at the end of its original container. Its green preview showed the intended restored layout. Save advanced Board revision to 46 and canvas revision to 7. Reopening again retained the restored placement, saved draft, counter value, selected tab and open details state.

The final Board has the original layout, three discussions and no pending proposal. No agent message was sent. Public readback confirms that the materialized authored HTML equals the baseline byte-for-byte; base HTML, data, document version, saved state, interactions and decisions are unchanged. The four existing patches remain an exact prefix followed by the two successful test moves. Acceptance did not roll back history or replace the canvas with a backup.

Native screenshots and accessibility observations remain in the coordinating conversation; no standalone native screenshot file is claimed. The native automation tool rejected coordinate dragging with `windowNotFoundAtPosition` before dispatching input. This round therefore verifies native modifier-click, preview comparison, cut/paste, cancellation, save and cold persistence. Hover-only behavior, drag ghosts and Tab/arrow hierarchy switching are covered by the separately passed Chromium tests, not claimed as successful native gestures here.

## Retained failures and corrections

- An early host task exited unsuccessfully without diagnostic stdout; its task record remains retained. Later host and final clean source checks passed, and the empty output is not treated as proof of a specific failure cause.
- A browser fixture attempted to finish an edit after its pending promise had already been completed. The fixture was corrected to track the active edit; no product success was inferred from the failed run.
- One placement-preview run timed out before the expected clone appeared. Diagnostic instrumentation and mutation-record cleanup preceded later passing runs, but the exact cause of that earlier timeout was not established. The original failure remains retained without an unsupported causal claim.
- A newly added HTML fixture initially had an invalid JavaScript string. It failed before runtime execution and was corrected before the browser regression ran.
- Preview Tab tests exposed a freeze rule that also disabled the preview scroll viewport. The rule now applies only to copied content. Trusted click focus, wheel isolation and the complete Tab/Escape path are verified by the focused trace and final suite.

## Boundaries

- The placement preview is a bounded, inert static copy. It does not execute copied scripts, custom-element constructors or controls. Dynamic/custom content can use labeled placeholders; unsupported or excessive content is reported rather than represented as an exact complete rendering.
- Copy construction is limited to 2,400 nodes, a checked 180 ms work budget and 1,500,000 accumulated JavaScript string characters, with separate bitmap limits. The character budget is not a byte measurement or a universal wall-clock latency guarantee.
- Known edit refusals unlock cancellation; generic transport, worker and I/O failures remain uncertain. An uncertain request survives BoardView remount within the current host JavaScript session, not a full app/page restart. Committed server receipts remain durable independently.
- Runtime-created or structurally divergent targets can still be refused. The relaxed anonymous guard is limited to uniquely identified descendants with unchanged structure; it does not permit arbitrary anonymous text or containment changes.
- Structural copies do not duplicate closures, attached listeners or library state, and do not rewrite CSS ID selectors. The clipboard is internal to the live Board frame; no system clipboard, cross-Board transfer or undo API is added.
- Anonymous markers follow the same live node during a move, but cold recovery cannot prove a moved positional anchor from the existing journal. It retains the frozen reference or a verified ancestor rather than guessing; stable authored IDs retain guarded recovery.
- Browsers without state-preserving `moveBefore` use an ordinary same-document move with focused-input/caret restoration; embedded media/frame state can reset on that fallback.
- No physical-mobile, Windows/Linux, remote-machine update, native fault injection or native held-drag-key acceptance is claimed. Main remains unchanged until the user authorizes merging the feature PR.
