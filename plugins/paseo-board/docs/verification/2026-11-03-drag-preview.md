# Pointer insertion and animated drag preview — November 3, 2026

## Delivery and behavior

Runtime `8a8f428eea574f70cf6c3ca08c09f8febf45aa91` is installed locally. Dragging a selected container to a sibling edge or gap now offers before/after insertion; container centers retain nesting. An inert copy shows siblings making room while the original nodes remain unchanged until host Save. Cancel leaves the source intact. Existing hierarchy and placement keys remain available.

**••• → 拖动让位动画** controls movement in that preview. Turning it off keeps the static placeholder and insertion line; reduced-motion also suppresses animation. The preference belongs only to the current canvas frame and is not persisted across a rebuilt frame or reload. Preview and unsupported-layout limits are documented in [component editing](../component-editing.md#pointer-insertion-and-drag-preview).

Work remains on `sw/board-drag-preview`. PR #8 for reopening remains unmerged. [Draft PR #9](https://github.com/CM-BF/open-paseo-plugins/pull/9) is stacked on `sw/board-resume-speed`. Neither PR is merged by this delivery. Main was unchanged by installation and cleanup.

## Fixed-source verification

Private evidence is under `~/.paseo/verification/paseo-board/drag-preview-20261103/`.

`combined-1793737304673201000/receipt.json` pins the installed commit and records **26 commands, all exit 0**. These include archive/extraction and clean dependency installation, TypeScript, **430 source tests in 33 files**, existing host and reopening suites, dashboard, component editing, durable drafts, toolbar/modal, static release, capture regressions, clean artifact builds, Hermes, real production Helper packaging and whitespace checks.

The complete canvas suite passed **111 checks**, including the 13 focused drag checks previously pinned in `focused-1793736248131070000/receipt.json`. Component-edit host passed 13 checks; static release passed 8. Coverage includes direct-body and vertical gaps, flex and grid placement, central nesting, Tab/Shift+Tab order, rendered animation positions, reduced-motion in the actual iframe, identity replacement, bounded refusal, 420px layout and cold replay. A target with 2,131 descendants must clear the prior accepted target; keyboard input and release cannot revive it.

Both clean artifacts reproduced exactly:

| Artifact | SHA-256 |
| --- | --- |
| `client/hermes-bundle.js` | `0ff91b2c42a60006a9dbab1ceb1149a6e7d07b447e4e2abe3c72b822fb3aaf7d` |
| `server/assets/store-worker.txt` | `8da5ef3d45e779eca8f2f75792a8f89ba9cb0d75986760257c8f1c8f637f8eee` |
| Drag runtime source | `c99b683b7162d5ab74b41eae7ffb563acc45f30f00703a5fec82285277ca01c0` |

The retirement regression constructs consumer-time retirement deterministically: a genuine native MessagePort event begins dispatch while its old frame exists; an earlier test observer replaces the frame synchronously before the unchanged production consumer. Same-scope replacement removes/closes the old consumer; cross-host retirement can update only its old scope. It uses no synthetic payload, redispatch or manual production callback. This proves the consumer boundary, not that dispatch started after frame removal. The product runtime was unchanged by this test-only correction.

## Installation and actual Web acceptance

The primary daemon is Paseo `0.14.0` at `127.0.0.1:6767`; the stable installation is `~/.paseo/local-plugins/paseo-board/dev`. The prior source, data and settings backup is `~/.paseo/backups/paseo-board-drag-preview-1793737660019-67a757`. Restore the prior plugin source only after the same idle and backup checks; live user data was not rolled back.

`install-1793737660019-67a757.json` records a backed-up installation of the exact commit with **179 tracked files byte-identical**, preserved original seven Boards, running workers and no daemon restart.

`actual-web-attempt-2.json` passed **five checks** on Chrome's real Web application connected to the primary local daemon:

1. Native body drag into a sibling gap shows displacement; Cancel preserves the exact canvas and live state.
2. Vertical gap drag and real host Save retain original nodes, input, listener and heap.
3. Flex gap drag and real host Save retain those same properties.
4. Animation-off drag at a 420px desktop viewport retains static placement preview and saves the intended order.
5. A complete compact Web reload restores both saved orders and working authored controls.

The dedicated fixture journal contains exactly three moves: A after B in the vertical column, Flex A after Flex B, then C after B in the compact column. Final orders are B/C/A and Flex B/A/C. Canvas revision advances from 1 to 4. Baseline and cancelled readbacks are deeply identical; no cancel write occurred. Base HTML, data, authored state, discussions and decision records remain unchanged. No agent message was sent and nothing was publicly published.

`actual-web-audit.json` independently verifies the journal, protected fields, all six readback hashes and installed files. Readback hashes cover the compact `JSON.stringify` representation, not pretty-printed file bytes. Native evidence consists of acknowledged CDP mouse commands, exact pre-down target/owning-frame hits, and proposals accepted by the product's trusted-event-only input path. Authored capture listeners cannot observe events stopped earlier by the product, so those listeners are not claimed as drag evidence.

The script was fixed at SHA-256 `3de39547467db9959ad4b88650c9a2785f865c1b2d2b531fc5851073e846d361`. The original acceptance receipt remains unchanged.

## Retained failures and evidence limits

Earlier failures remain in their original receipts and logs:

- The initial test document lacked its evaluation responder, causing a harness timeout before drag assertions. The repaired harness reproduced the old append behavior.
- Candidate testing exposed real central-nesting and ancestor-order bugs. Independent review found an identity-budget exception could retain an old drop target. These were corrected before the final verified runtime.
- Reduced-motion initially targeted only the top page instead of the opaque canvas iframe; the test setup was corrected.
- The old retirement test delivered its second position before retirement. A 40ms scheduling attempt also failed to construct a late event. The deterministic native consumer-boundary test above replaces that timing assumption; the unsuccessful traces remain retained.
- The first actual Web attempt failed before dragging or saving because a serialized callback omitted its Board ID argument. The failed script and receipt are preserved; the corrected run reused the still-unmodified dedicated fixture.
- The first `vertical-held` screenshot, taken for cancellation preview, was overwritten by the later Save-preview image using the same filename. Its original bytes are unavailable. **13 of 14 screenshot records** match the existing files; **all 12 unique final files** match their final recorded hashes. The duplicate compact-saved entry has identical bytes. Cancellation remains independently established by equal baseline/cancel readbacks, live-state assertions and zero writes. The audit records this limitation without rewriting the acceptance receipt or rerunning the test.

These results are source-browser and actual primary-daemon **Chrome Web** acceptance. They do not claim native desktop-app UI or physical-phone testing. A 420px desktop viewport is not a phone. Arbitrary authored input values are preserved across the tested live moves, not promised across a new document instance on reload.

## Cleanup

`cleanup-drag-fixture-receipt.json` records sustained idle checks, a backup and removal of only the dedicated temporary Board. The original seven Boards remain, with business content unchanged; an unrelated background inspection checkpoint that advanced before the stop is separately recorded. The plugin and two workers are running. Main and daemon identity remain unchanged; no source rollback, agent/workspace mutation or daemon restart occurred.

`actual-web-drag-cleanup-receipt.json` then independently read the actual global Boards page: all original seven Boards were visible and the temporary Board was absent. Cleanup created no canvas mutation or agent message.
