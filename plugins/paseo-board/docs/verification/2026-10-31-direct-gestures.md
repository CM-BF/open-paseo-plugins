# Selected-component direct gestures — verification

Verified runtime: `9670dc9789fe9e06ff74a917480aa9a830d0c412`, branch `sw/board-interaction-next`, Paseo daemon 0.14.0. Delivery is a backed-up local test installation and draft PR #4. Main remains at `9bd750cb82d7ce6f8337b5c8555c75efd998a947`; merging requires the user's explicit approval.

## Behavior and evidence

After selecting a component, right-clicking its contents opens a blank composer referencing the entire selected component. The screenshot and frozen selector, binding target, ancestor information and document/canvas revisions remain associated with that reference. The service prompt identifies the entire component and requires a current authored-source read before editing; the binding fingerprint is location evidence, not a canvas write condition. Sending remains an explicit user action.

An ordinary press inside the selected parent preserves that parent. Moving at least 6 CSS pixels starts the existing structural drag, component ghost, insertion indicator and destination hierarchy controls. Dropping shows the existing cancellable layout preview before host Save. Double-clicking actual words resolves the precise direct Text node, including a trailing run after inline markup, and places the caret at its original geometry. Inputs and other native editors retain their normal behavior. The compact toolbar remains an alternative, and modifier-assisted selection can deliberately choose a child.

Five focused real-Chromium checks and the complete 76-check canvas suite passed on the final runtime hash. The new checks cover:

- Whole selected-parent reference when right-clicking a child, exact rectangle and PNG dimensions, held screenshot with frozen revisions, and no automatic message dispatch.
- Source identity change, genuine iframe blur and trusted pointer cancellation without a staged edit or mutation.
- Below/above-threshold drag, visible ghost, Tab destination ancestry, original DOM retained until Save, cancel, and committed movement of the same live node.
- Exact trailing/nested text-run double-click, nonzero aligned text-range geometry, in-place typing and cancellation, with authored double-click handlers suppressed for this selected-component action.
- Native input selection/typing, ordinary unselected text behavior and synthetic gestures that cannot open a host composer or stage edits.

Two service cases, with and without PNG, verify the actual SDK send arguments, separately attached image, persisted interaction/journal reload and immutable retry after the current document changes. Retargeting an existing intent is rejected. These tests use the service SDK adapter; they do not claim native agent delivery acceptance.

## Clean fixed-source verification

Receipt: `direct-gestures-20261031/combined-1793487502513311000/receipt.json` in the local verification store.

| Check | Result |
| --- | --- |
| TypeScript | Passed |
| Source tests | 300 in 22 files |
| Full BoardView host | 38 checks |
| Dashboard host scope | 9 checks |
| Component-edit host scope | 12 checks |
| Canvas Chromium | 76 checks |
| Hermes | Passed |
| Clean worker and client builds | Byte-identical to committed artifacts |
| Actual production manifest preparation/compiler/evaluator | Passed |
| Production Helper pool | Two independent children, guarded text/move/copy IPC, durable retry and shutdown cleanup passed |

The browser scopes execute 135 checks in total, including repeated title checks across host scopes. Browser transport/native primitives are adapted fixtures, not the installed desktop app.

Worker SHA-256: `267fd6699a9183745294bf45985eaead174c90b2dedf4324773b5173734bbcc2`.

Client SHA-256: `a5c3228c5ab99df9998122001b7e12cd6341f249690e9bb62f4996cfa7a1e2f3`.

## Installation and native limit

Installation receipt: `direct-gestures-20261031/install-1793487652660-3baa09.json`. The exact 121 tracked runtime files were installed at the stable local plugin directory after backing up source, settings, runtime and data. The complete current five-Board inventory and saved state were preserved. Exactly two live pool children were observed. The shared daemon was not restarted and no data rollback was attempted. Plugin startup reached ready; the same pre-existing oversized historical Codex thread resume error appeared before and after this installation.

**Native gesture acceptance is unavailable.** The first app-selection attempt timed out. Selecting by full application path then exposed the correct local-host accessibility window. The attempted existing Board-tab action was rejected because the user changed the app; the required state refresh timed out. No native gesture, save/cancel/reopen operation or screenshot was completed. No canvas mutation was attempted through native UI. The installed build is available for user testing, but the automated checks above do not replace this missing acceptance.

Native limitation receipt: `direct-gestures-20261031/native-acceptance.json`. Older native walkthroughs belong to their original revisions and are not reused as acceptance of these gestures.

## Review, retained failures and boundaries

Independent review has no open findings. It found that oversized component identity generation could throw at a direct body press or the toolbar drag entry; both entries now catch and display the failure, and a failed press clears its gesture state.

Two focused fixture failures were retained: one incorrectly expected an authored double-click counter to be zero after its own synthetic event had invoked that authored handler; the assertion now captures the baseline immediately before the trusted gesture. Another tried to start a new drag after pointer cancellation had correctly exited selection mode; the fixture now explicitly reselects. The complete canvas and clean-archive runs passed after these setup corrections.

Direct text entry requires a hit on a supported actual Text node; it does not guess from padding or graphics. Existing component identity and preview budgets remain in force. Active drag identity checks are covered functionally, without a new large-document performance benchmark. Existing copy/runtime-state, anonymous cold marker recovery, complex SVG fidelity and uncertain-save persistence limits remain described in [component editing](../component-editing.md).
