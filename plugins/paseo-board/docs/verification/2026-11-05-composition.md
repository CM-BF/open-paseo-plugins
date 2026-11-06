# Composable Board verification

The feature is developed on `sw/board-composition` from main `7058d4b`. Commit `9ba11dcdc397e7f27ba814723adab824a4efdb72` is installed on the local primary daemon. Main remains unchanged. Three dedicated Boards were created for actual Web acceptance; no test agent or message was created. The implementation and examples are plugin-only.

## Evidence completed

The fixed source snapshot `candidate-1793942448523469000` passed TypeScript, 516 source tests in 38 files, 8 opaque-frame mechanism checks, 19 production CanvasFrame checks and 11 production BoardView checks. Private receipts and logs reside under `~/.paseo/verification/paseo-board/composition-20261105/`.

The host checks use the production source selector, BoardView, cache and CanvasFrame against two adapted public host-service installations. Native input verifies distinct equal-ID sources, parent/source comment routing, shared source queues, source-owned edit review, preserved controls through resize/reorder, independent reading positions, same-slot replacement, source recreation/reselection, read-only previews and host retirement without fallback. They do not use two real daemons or deliver messages to live agents.

The immediate single-comment acknowledgement path now compares the frozen intent, source identity, route, payload and anchor before clearing a draft or resolving an authored request as submitted. `single-receipt-guard-host-v2.log` passes 12 BoardView checks: missing identity, different identity and changed text all retain the original durable draft and unresolved authored request; native retries use the identical original payload, and only the exact final receipt clears it. The first new test run remains failed because it looked for the initial Send label after the UI correctly switched to Retry; no product assertion was relaxed.

Independent frame probing (`final-frame-isolation-review.json`) intentionally lets a sibling under the same authored parent race the public locator. Winning placement is possible; source authority is not acquired. Host navigation destroys the old attacker script and creates an opaque source document. Source DOM, location, secret and private ports remain unavailable; forged source calls fail even with the exact session and after replacing the same WindowProxy. A genuine source Comment still routes to the correct source. This is bounded mechanism evidence, not protection against a parent changing its own layout or removing children.

## First clean committed run

Commit `7dd32535` includes rebuilt worker/client assets. `combined-1793943018205633000` passed 25 steps: TypeScript, 521 source tests in 38 files, 8/19/12 composition checks, existing host/reopening/drafts/queue/authored-comment paths and static release browser checks. It stopped at the release-host ZIP assertion, which waited a fixed 150ms after the native click and saw no completed ZIP despite a recorded download RPC. The original receipt remains failed.

The separate `release-download-diagnosis` probe uses the real ReleasePanel, ZIP core and browser download implementation with a deliberate 400ms loopback response delay. The old 150ms check observed an empty directory; later native download events completed the same GUID and the resulting 55,612-byte ZIP matched every frozen file. This proves the fixed delay can misclassify successful asynchronous downloads, not which stage delayed the uninstrumented original run. The test-only correction waits for the matching browser completion event and retains cancellation/timeout failures and exact byte assertions. All 12 default release-host checks passed with this correction; product blobs remain unchanged. Passed evidence may be carried forward only after confirming unchanged product and test inputs; execution provenance remains explicit. The pending clean-archive continuation will inherit 19 unchanged checks and execute 18 steps afresh, including release-host, the remaining browser regressions, artifact identity and real Helper packaging.

## Completed clean verification and local installation

The continuation `combined-1793943570831241000/receipt.json` passed all 37 recorded steps for `9ba11dc`: 19 results retain their original execution on `7dd32535`, with exact receipt/log hashes and unchanged-input checks; 18 steps executed afresh, including the corrected release host, full canvas and capture regressions, clean artifact comparison, Hermes and actual Paseo Helper packaging. The committed suite contains 521 source tests in 38 files and 8/19/12 composition mechanism/frame/host checks. The regenerated worker and client artifacts match their committed bytes. Packaging started and exercised two real Helper worker children in its isolated test directory and cleaned them up.

Installation `install-1793943866262-f7885e.json` backed up source, Board data, runtime and settings after sustained idle checks, installed all 210 tracked files, preserved the original seven Board IDs/content, and verified two workers plus bridge readiness. The primary daemon was not restarted. The backup remains under `~/.paseo/backups/paseo-board-composition-1793943866262-f7885e`.

## Actual primary-daemon Web acceptance

`actual-web-preparation/actual-web-attempt-2.json` passed six functional checks through `app.paseo.sh` connected to the local primary daemon (`srv_BSheQn5lzdEE`, version 0.14.0). It inherits only the already completed source-selector check from attempt 1, bound to that failed receipt's exact hash; the other five checks executed in attempt 2. The dedicated parent and two sources have prefix `plugin-test-composition-20261105-9ba11dc-`.

- The native source selector saves the two exact source creation identities and renders four authored slots.
- Native authored reorder and resize preserve all child heaps, input values and listeners.
- A single source data update reaches both copies of A while source B remains unchanged.
- Full page reload restores authored layout and the two independent positions for source A.
- At 420px, the preview remains read-only under a native click and Tab.
- Removing a slot preserves its source Board and the remaining interactive instance.

Attempt 1 remains failed at its first child text entry. Its click helper lacked a trusted child-input/focus observation after the newly rendered opaque iframe; it did not prove an input gesture reached the child. Attempt 2 first observes native hover, then one press/release and the child's trusted click and focused input before inserting text. It reuses the exact three Boards and original grants without repeating creation or the selector mutation. Wide and compact screenshots are retained with hashes in the receipt.

Those screenshots exposed an independent theme defect: embedded header/status CSS used nonexistent foreground/border tokens. The narrow correction replaces three occurrences with the emitted `--host-ink` and `--host-line` variables; layout is unchanged. `theme-token-focused/receipt.json` retains the original dark-palette failure (foreground `rgb(51, 51, 51)` on dark background), then passes 20 production CanvasFrame checks in each of light and dark palettes, including real closed-shadow computed colors. TypeScript and diff checks also pass. The successor clean verification, installation and final actual-theme inspection are still separate pending steps.

## Failures retained and corrections

`task-5da391b51f19` reached its preparation deadline without snapshotting, testing, committing or installing. It is not a failed product test. The later candidate waited only for completed handoffs and then tested one fixed snapshot.

`host-final-1793941040808188000` failed after nine checks because the third display's saved position became zero. One genuine teardown sample was corrected with a disposal timestamp cutoff on the bounded final view handoff. A second reset still occurred before remount, without changed geometry or JavaScript scrolling. Native wheel input reproduced it. An independent opaque-parent/blob-child probe reproduced it without Board, React or cache: after a state-preserving iframe move, the next child layout update following user scrolling restored the move-time offset. Refreshing marker/component layout after parent movement and before user scrolling prevented that reset. Production tests retain exact independent positions and observe stability after the native scroll; there is no compensating scroll timer. A redundant pointer-events write was also guarded to avoid a self-triggering observer loop.

A same-slot DOM replacement now receives a new controller/session, while its durable position key remains stable. Delayed state, edit and comment writes carry source creation identity into the store lock. Drafts, batches and delivery recovery preserve that identity rather than adopting a replacement Board. Final independent review also reproduced three historical-extraction races before fixing them: a held history page for the same or a different owner, and a prepared decision waiting across Board recreation. Decisions and extraction checkpoints now check the originally captured identity inside the store lock, before receipt replay. The related 122 store/service tests and typecheck passed; the final committed suite must include these corrections and the immediate acknowledgement guard.

## Limits and next stages

Full clean verification and same-host actual Web functional acceptance are complete for `9ba11dc`. The three dedicated fixture Boards remain present pending the theme successor and guarded cleanup. Only the local MacBook host has been observed; no real two-host or physical mobile acceptance is claimed. Cross-host evidence above uses the production components with adapted public services, not a second real daemon.

Composition requires compatible connected Board installations in the current app realm. There are at most eight active managed embeds and one level. Preview is current persisted content rendered read-only, not historical captured pixels. Unsupported historical snapshot IDs, parent screenshots intersecting an embed and static exports of managed embeds fail explicitly. Source observations disclose bounded history and cached timing. All-clients-closed federation and screen-owning-host-offline persistence are outside this version.
