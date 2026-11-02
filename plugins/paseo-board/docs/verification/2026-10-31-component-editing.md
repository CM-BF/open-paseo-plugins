# Component editing — verification

## Verified revision and delivery scope

Runtime `b5d1e0ecb2be9bc88927f5b8d844fc9ae4577e79` passed clean integrated checks and was installed for native desktop testing on the existing primary Paseo 0.14.0 daemon. The implementation stays on `sw/board-interaction-next` and [draft PR #4](https://github.com/CM-BF/open-paseo-plugins/pull/4). Local installation permission does not authorize a main push or merge; those still require the user's explicit approval.

The private clean receipt is `combined-1793477345053995000/receipt.json`; installation is recorded in `install-1793477493211-a58ebf.json`. Receipt names permit evidence lookup without publishing machine-specific paths, credentials, Board identifiers or canvas contents. The final feature-branch release receipt records its documentation commit and remote outcome separately.

## Fresh clean-archive checks

Every check below ran against a clean archive of the exact runtime revision. No earlier browser or Hermes result was reused. All 14 command logs have matching receipt SHA-256 values and exit code 0.

| Check | Result and scope |
| --- | --- |
| TypeScript | Passed. |
| Full source suite | 288 tests across 21 files passed. |
| BoardView browser suite | 38 checks passed. |
| Dashboard browser scope | 9 checks passed. |
| Component-edit host browser scope | 10 checks passed. |
| Canvas browser suite | 64 checks passed. |
| Clean worker/client rebuilds | Both byte-identical to committed assets. |
| Hermes compatibility | Static clean and Hermes OK. |
| Production-only host packaging | Actual Paseo manifest preparation, compiler and evaluator passed. |
| Packaged worker processes | Two independent Helper-as-Node children; real IPC edits and durable exact retry passed. |
| Diff validation and cleanup | Passed; isolated build and packaging directories removed. |

The five title checks run in all three BoardView scopes. Thus the browser logs contain 121 executed PASS rows but 111 distinct PASS labels; the per-suite counts above do not imply 121 independent scenarios.

The source suite includes 15 component-edit protocol tests, 7 component-edit writer tests and 11 real-process worker-pool tests. Coverage includes stale canvas bases, immutable retries, structural/anonymous identity guards, mixed text, invalid containment, copied ID/reference isolation, authored-source replay and worker fault handling.

The component-edit host scope ran explicitly with `BOARD_HOST_TEST_SCOPE=component-edit`; ordinary full-host execution does not include it. It proves that wrong-window/scope proposals and cancellation cannot write, only host Save commits, title-only changes preserve proposals, changed canvases reject stale saves, uncertain saves retry unchanged after BoardView remount, and an open message draft retains text and focus.

The canvas suite covers held-modifier hover before click, normal input behavior, delayed cut, copy without eager DOM changes, actual-node moves preserving listeners/input/caret/runtime, direct text runs preserving sibling markup, drag ancestry/placement through keydown and keyup, and copied script/handler suppression. Its SVG regression sends browser-captured identities through the actual server preparer, then checks authoritative SVG/foreignObject geometry live and after cold patch replay. Existing marker, screenshot, theme, incremental-data and conflict regressions also pass.

These suites use real Chromium and production BoardView/runtime with adapted Paseo transport/native primitives. They are distinct from the installed desktop walkthrough below.

## Artifact and packaged-process identity

| Asset | SHA-256 |
| --- | --- |
| `server/assets/store-worker.txt` | `aef14b60360a5fcb84bdc18b076b694daaa8d65543ab16b1ab36c35d43a835ab` |
| `client/hermes-bundle.js` | `36e0415795f8637be9eec295117a85581fef54a35edf40fbd7da676ca68f719d` |

The clean rebuild and packaged Helper probe use these same hashes. The worker contains the actual dependency license inventory, including nested package versions, while retaining original vendored source bytes.

The packaging probe uses the installed Paseo compiler/evaluator and production Helper binary with `ELECTRON_RUN_AS_NODE=1`, reporting Node 24.20.0. Actual manifest preparation installs locked production dependencies only. The compiled client is 368,485 bytes; the server is 2,431,718 bytes. The generated worker commits guarded text, move and copy operations through real IPC and replays the exact copy receipt without duplication or pool growth. Closing the isolated pool reaps both children and releases its owned lease; the isolated directory is removed.

## Authorized local installation

The installer verifies the passed receipt and exact source before replacing the retained installation. The previous plugin, data/settings and generated runtime are backed up. All 116 tracked installed files match the tested revision. A single Board-plugin disable/enable cycle replaces the runtime; the daemon and daemon-worker process identities are preserved, with no daemon restart or older user-data restoration.

All four existing Boards retain their canvas, title, saved state and feed hashes across installation. The new live pool has exactly two worker children using the verified artifact, with private data/runtime/lease permissions. An unchanged compact check is 17 business-JSON bytes, excluding transport framing. No second shutdown cycle is performed on the live pool; reaping/lease-release verification comes from the isolated packaged-Helper probe.

## Native desktop acceptance

The actual installed Paseo desktop app was exercised on the retained interaction test Board, through normal controls and authenticated host Save actions. No new agent or workspace was created.

- Command+Shift click selected a component and displayed its actual ancestor/child hierarchy.
- The inspector edited one anonymous direct paragraph text run. Host Save committed it, while the sibling paragraph and surrounding markup stayed intact.
- Command+C and Command+V prepared and saved a structural article copy. The original remained, and the copy included the latest authored text.
- Command+X kept the source in place. Pasting into an ancestor container prepared a move; cancelling preserved the original placement. Repeating and saving moved the original article from a nested group to the selected tab panel.
- Dragging the actual inspector handle to a visible target produced the host move proposal. Cancelling that proposal left the committed layout unchanged.
- The existing input draft, counter and random in-page runtime marker stayed unchanged through the committed edits. The original increment button still worked afterward, confirming its handler remained live.
- Returning to the Board index and reopening restored the edited text, copy and moved article, plus the saved input, incremented counter, selected tab and open details. A new runtime marker appeared on this actual remount, as expected.
- Public readback showed exactly three semantic patches—text, copy and move—at canvas revision 4/document version 1. The original base HTML and the two existing interactions were unchanged; no new agent message was sent.

The test Board is retained for the user. Native screenshots/accessibility observations remain in the coordinating conversation, with private before/after public readback. No unrelated host/sidebar content is published. The automation tool could exercise native modifier-click and drag proposals but could not hold drag hierarchy keys during the native gesture; hover-only previews and Tab/arrow drag switching are therefore claimed only from the separately passed Chromium checks.

## Retained failures and corrections

- Early typechecks found incomplete result typing and LinkeDOM element typing in new code/fixtures. The final clean typecheck and source suite pass.
- Drag previews disappeared on Tab/arrow key release because shortcut cleanup cleared the active drag overlay. Cleanup now distinguishes held-shortcut preview from active drag preview; regression checks include keydown and keyup.
- A host fixture used an outdated hand-written identity algorithm. It now uses the production helper; the original failed host log remains retained.
- SVG child copying required source-context fragment parsing instead of an HTML template. Browser/server SVG tag spelling also differed. The final parser preserves SVG/foreignObject integration, and normalized edit identities are verified against the actual server preparer with live and cold replay.
- The first added SVG destination-click test timed out because the inspector overlapped the target near the fixture's bottom edge. The fixture gained scroll space and an actual hit-target assertion. The failed run remains retained; no product timeout was increased.

## Boundaries

- The component clipboard belongs to the current live Board frame. No operating-system HTML import, cross-Board clipboard or undo API is claimed.
- Structural copies do not duplicate JavaScript closures, attached listeners or library state. Copied scripts/inline handlers do not run. CSS ID selectors, including those in copied style elements, are not rewritten and may need author changes.
- Runtime-created or structurally divergent elements cannot automatically become durable authored-source edits. Anonymous elements require bounded exact authored markup; dynamic anonymous content can conservatively refuse editing.
- Direct-edit structural identities are bounded to 2,000 elements, anonymous markup guards to 240,000 characters and text changes to 24,000 characters. These are editing limits, not restrictions on arbitrary Board authoring.
- Live anonymous markers follow their original DOM node when moved. After reopening, the existing journal cannot prove relocation of an old positional anchor, so cold recovery retains the frozen reference or a verified ancestor rather than guessing. Stable authored IDs retain guarded recovery.
- Uncertain save requests survive BoardView navigation/remount within the current host JavaScript session, not a full app/page restart. Server commits and their idempotency receipts are durable separately.
- Browsers without state-preserving `moveBefore` use ordinary same-document movement with focused-input/caret restoration. Embedded media/frame state may reset on that fallback.
- No physical-mobile, Windows/Linux, remote-device update or native fault-injection acceptance is claimed. Browser error/retry/concurrency checks and isolated packaged-process recovery remain separately labelled evidence.
