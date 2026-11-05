# Board reopening verification — 2026-11-02

Runtime commit `e4261c5679a2f0615bfa600da15aff6a74a21755` passed clean-source verification, was installed on the primary local host, and passed seven actual Web UI checks. Returning to an agent recovered its selected Board and document/nested reading position. The observed cached return issued no `board.read` request. Iframes still rebuilt; this delivery does not preserve arbitrary authored JavaScript state across remounts.

Guarded cleanup and independent actual-Web inventory verification passed after functional acceptance. The two test Boards were removed with backups, both idle child-free test agents and their dedicated workspace were archived, and the original seven Boards remain intact. Feature-branch publication and any subsequent merge are separate delivery steps.

## Fixed source and installation

The clean run archived the exact commit, installed locked dependencies into the isolated tree and passed all 26 recorded commands. Every command log matches its recorded SHA-256. The source suite passed **430 tests in 33 files**.

| Verification scope | Passed result |
| --- | --- |
| TypeScript and source tests | Typecheck; 430 tests |
| Reopening host paths | 9 core, 8 reconnect, 2 departure-channel checks |
| View runtime | 9 canvas-view groups |
| Existing host behavior | 38 host, 9 dashboard, 13 component-edit, 14 durable-draft checks |
| Toolbar and isolated modals | 3 toolbar, 3 modal, 2 native-fallback adapter checks |
| Publication and canvas regressions | 8 static-release, 12 release-host, 98 canvas-browser checks |
| Capture regressions | Focused sticky/shadow native-pixel comparisons and existing capture suite |
| Packaging | Byte-identical worker/client rebuilds, Hermes, real production Helper and two workers |

The 26 commands include archive/extraction/install/build and consistency steps; the browser totals above are grouped executions, with overlapping coverage, not a count of unique native-device scenarios. Host browser fixtures adapt Paseo transport and native UI primitives. Production packaging separately used the installed compiler and actual Electron Helper, including worker IPC, edit/layout replay, copy/export/ZIP and pool cleanup in isolated storage.

Installation backed up and replaced **176 tracked files** at the stable plugin path. All **seven pre-existing Boards** retained their titles, canvas, saved state and feeds. The old pool stopped and released its lease, and exactly two verified worker children started from the pinned worker artifact. The daemon identities remained unchanged; no daemon restart, settings rollback or old-data restore occurred. The installer refreshed activity checks immediately before its single plugin-only stop/start. It does not claim an atomic public lock against all concurrent work.

## Actual primary-host Web acceptance

A private Chrome profile connected to the primary daemon. One dedicated workspace, two idle agents without an initial prompt, and two self-contained Boards supplied the fixtures. The browser used actual agent tabs and the exact registered local `/board` command. It sent **zero agent messages**; the final audit found both agents idle with no user messages and both Board revisions unchanged. Board source/ownership/discussions were compared with the saved fixture baselines. No external publication was performed.

The seven successful checks were:

1. Cold open and trusted document/nested wheel input produced matching real view reports and scoped browser-storage records.
2. Native A → B → A switching recovered each agent's selected Board and its independent reading position.
3. An additional 125px native scroll immediately followed by switching recovered the latest position, without waiting for a save acknowledgement before departure.
4. Closing and reopening the Board tab recovered the selection and both root and nested scroll axes.
5. A full Web page reload recovered the selection and reading position.
6. Explicit **Boards** back navigation retained the index after reopening; selecting the Board again recovered its position.
7. A 420px desktop viewport transition and another full reload retained the exact reading position in the visible compact frame.

The tested root position was `(550, 725)` and the nested log position `(210, 355)` after the quick-scroll case. Both remained within the existing 2px assertion tolerance. The compact transition really recreated the frame; the test waited for both the exact position and the current session's `view-restored` acknowledgement. It did not require a nonexistent same-document transition or add a fixed delay.

The private observer authenticated the current iframe's native ready message before observing its original MessagePort. Its passive listener ran after the production listener, and saved-view assertions separately read the actual host/Board-scoped local-storage record. DOM movement alone was insufficient. Screenshots were clipped to the fixture Board; screenshots, menu DOM, agent identities and Board identities remain private.

### Observed timing and network boundary

| Final actual-Web observation | Measurement |
| --- | --- |
| Cold selection to first ready | 664ms |
| Return to first ready | 433ms |
| Return to completed reading-position restoration | 653ms |
| `board.read` requests/responses during measured cached return | 0 requests, 0 response bytes |
| Frame rebuilt during that return | Yes |

These are one run's observations, rounded from the receipt. The intervals include native click targeting/stability checks and different entry paths: cold timing starts at an already-open index; return timing includes reopening the agent's panel. They are **not an apples-to-apples cold/warm benchmark**, a general speedup claim or a latency guarantee. Zero bytes refers only to the observed `board.read` response traffic during that interval, not all host traffic. Fresh full-page loads still performed server reads.

The adapted held-read test provides a separate cache check: cached content became ready and restored root/nested positions before a delayed server read completed, then reconciled fresh content without replacing that new frame. This distinguishes avoiding a content download from retaining the old frame.

## Recovery and isolation coverage

Entry selection is host/surface/workspace/agent scoped; reading position is host/Board scoped and document-version checked. The bounded local store contains at most 64 records and 512KiB, with at most 32 inner scrollers per view. It contains navigation hints rather than a second full Board copy, message drafts, PNGs or authored `userState`.

Focused source/browser checks cover explicit Back, stale tab-state echoes, storage refusal with an in-memory fallback, lower-revision authoritative reads after an epoch reset, rejection of late old-epoch responses, unchanged-cursor reconnects with and without cached content, and a reconnect that occurs before the old read finally rejects. Healthy unchanged checks do not become a full-read loop.

Saved positions take priority over initial unread navigation. New-document replacement discards the old document's position and pending navigation. Real pointer/wheel/keyboard activity can cancel restoration; snapshot application merely pauses new automatic navigation and does not invalidate a successful focus receipt. Authenticated departure reports have a 250ms limit and are revoked by a newer visit to the same host/Board. Equal Board IDs on different hosts retain separate positions.

## Retained failures and corrections

Development evidence retains the initial delayed-module startup/journal failure, low-revision epoch replacement failure, failed-read reconnect ordering gap and duplicate focus request during snapshot application. The fixes were tested again in the pinned clean run. A prior worker-pool timeout is retained; the final complete suite passed without claiming that the isolated earlier rerun established its cause.

The quick-switch trace showed that native scrolling completed before unmount, but its queued window message arrived afterward with a null source. A small independent Chrome probe confirmed that browser behavior. The final implementation transfers a dedicated MessageChannel after the normal authenticated ready/restore handshake; it does not weaken window-source validation. A bounded final persistence sink handles eligible late reports without changing the new view.

Four actual-Web attempts are also preserved:

- **Attempt 1:** Escape at the start of a slash command intentionally cleared the composer. The test stopped before Enter. Native Tab completion replaced this incorrect harness assumption.
- **Attempts 2 and 3:** The test incorrectly required every fuzzy suggestion to be `/board`. The bounded diagnostic showed five suggestions and a selected `/board` detail card. The corrected proof checks the single exact focusable `/board` row and the selected detail card, then verifies the completed text, closed menu and focused input before Enter.
- **Attempt 4:** Six checks passed, then the test assumed a compact transition retained the iframe and inspected its new zero-position document too early. Distinct frame tokens/time origins proved reconstruction. The final script awaits exact geometry plus current-session acknowledgement and retains the strict coordinates.

These entry/viewport harness corrections did not change the installed runtime. All four receipts, their executed scripts and approvals remain preserved. All recorded attempts had zero agent messages.

## Limits and cleanup

Native desktop App automation, physical mobile devices and remote Linux installation were not accepted in this round. A narrow desktop browser viewport is not physical-mobile testing. Network/epoch failures were injected only in deterministic fixtures, not into the live daemon.

The actual run observed new iframe identities on returns, tab reopen and compact transition. Ordinary authored input was empty after replacement, as expected without an authored persistence handler. No claim is made that arbitrary inputs, live heaps, animation phases or running authored processes survive those rebuilds. Draft-message recovery and authored `board.saveState()` remain separate mechanisms.

Cleanup required sustained inactivity, fresh checks immediately before one plugin-only stop/start, and complete Board-envelope comparison. Only the exact two unchanged fixture files were backed up and atomically moved. The remaining files stayed byte-identical while stopped; after startup only validated extraction checkpoints could differ. Public archive APIs confirmed both idle agents had no children or messages before archiving them and their exact directory workspace. The directory and backups remain as private evidence. The installed source stayed byte-identical, two verified workers resumed, and daemon identities remained unchanged. A separate fresh Web profile rendered all seven original Board entries and no removed fixture. The private browser processes/profiles closed; no existing Board was restored from an older backup.

## Private evidence locations

Evidence is retained beneath `~/.paseo/verification/paseo-board/reopen-20261102/`:

- `combined-1793680512281923000/receipt.json` and its 26 hashed logs: exact-source verification.
- `install-1793680883456-23a681.json`: installation, preserved inventory, artifact and pool checks.
- `actual-web-receipt.json`: the final seven-check actual-Web result and bounded transport measurements.
- `actual-web-attempt-1/` through `actual-web-attempt-4/`: immutable failed receipts, scripts and approvals.
- `final-review.json`, candidate and diagnostic receipts: source review and failure provenance.
- `cleanup-actual-web-receipt.json`: exact fixture cleanup, public archive receipts, full remaining Board envelopes and unchanged installed runtime.
- `actual-web-cleanup-receipt.json`: independent actual-Web inventory reconciliation.
- `actual-web-desktop-board.png`, `actual-web-compact-board.png` and `cleanup-board-index.png`: private visual evidence.

Private files and screenshots are not included in the public repository. This document reports only the relevant outcomes and limits.
