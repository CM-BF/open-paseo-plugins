# Draft recovery, compact toolbar and fixed website publishing

Runtime `2d041185647095781c9ef6dc71ffd432592253ed` passed the final clean verification and is installed on the primary Paseo 0.14.0 daemon. The real desktop and compact Web UI successfully opened publishing, created and reopened a local fixed snapshot, and recovered a typed contextual draft across a full page reload. No real publication repository, PR, merge or public Pages deployment was created during verification.

The user requested durable contextual message drafts, one header row with shortcut help, and generic static export plus GitHub Pages. The release is a fixed version that preserves local page interaction while excluding private conversation and agent controls. The working Board and an optional separately editable publication copy remain independent of a frozen release.

## Final pinned verification

All 20 verification commands ran successfully from a clean archive of the exact runtime commit. TypeScript and all 361 source tests in 29 files passed. The browser groups below use real Chromium; host fixtures adapt Paseo transport and UI primitives, and their counts include repeated scenarios across scopes.

| Browser group | Passed checks |
| --- | ---: |
| Existing BoardView interaction | 38 |
| Dashboard synchronization | 9 |
| Component editing | 12 |
| Durable contextual drafts | 14 |
| Single-row toolbar | 3 |
| Isolated Modal drawers and creation | 3 |
| Native Modal fallback adapter | 2 |
| Standalone release viewer | 6 |
| Publication host UI | 9 |
| Complete canvas regression | 76 |

The 172 browser check executions are not a claim of 172 unique native-device scenarios. Hermes evaluation, clean dependency installation, both artifact rebuilds and production Helper packaging also passed. The clean build directory was removed after verification.

| Committed artifact | SHA-256, identical after clean rebuild |
| --- | --- |
| `server/assets/store-worker.txt` | `5fbcb028fd438824d1d3e580370f8cf22742bb2273abfa07debcda85f72fa78c` |
| `client/hermes-bundle.js` | `c02cac6ece7651ffeb78f03ae214f09cfa0aee9893395b79c00c75aed47021cb` |

The actual installed Paseo compiler/evaluator and Electron-as-Node Helper accepted the production-only prepared source and unchanged assets. Two real worker children performed durable component edits, created an editable copy, exported the final authored snapshot and generated a real ZIP. Closing the isolated pool reaped both children and released its own lease. No GitHub access was used by that packaging fixture.

## Behavior covered

- Durable drafts retain text, frozen references and PNGs across a complete page reload and disconnected initial Board reads. Tests cover host/Board isolation, concurrent revisions, exact uncertain sends, receipt-before-RPC-error reconciliation, corrupt records, quota failures and late receipts that must not overwrite newer text. A storage failure blocks sending or leaving while retaining copyable input.
- Toolbar checks at 1024, 420 and 320 pixels retain one 48px header, reachable menus, rename and IME behavior, and the original canvas instance and geometry.
- Publication UI checks use the real static repository and editable-copy core with adapted GitHub/Paseo transport. They cover explicit public data, invalid-input refusal, immutable snapshots, an actual browser ZIP download, account/repository selection, exact-head merge, deployment status, reload recovery of a lost preparation request, storage failure before preparation and late-response isolation.
- Registered RPC tests refuse stale-source export and missing release evidence before GitHub actions. Existing fixed releases remain available when the working Board is unavailable. Copy tests preserve current materialized content and independent edits while clearing discussion/control state and replaying the original copy receipt.
- Standalone viewer checks preserve full-document root/body attributes, initialization before head scripts, local form handlers, visitor state at root and subpaths, and the nested host preview. Authored same-origin and cross-origin self-navigation both produced zero requests at independent receivers and explicit browser CSP refusals. An earlier same-origin request was reproduced before removing `'self'` from the outer frame policy; its failure evidence is retained.
- DOM materialization and ZIP work use the existing bounded worker pool for installed host RPCs. Worker tests cover queue/byte limits, retry of pure work, another partition remaining available and coordinator responsiveness during a 1.56 MB source computation. The standalone local CLI remains independent of that pool.

## Real-host correction and retained failures

The first installed build, `b77a3ff`, passed the inline host fixture but crashed the real compact publication panel with `Board theme is missing`. Paseo's compact/native sheet renders content outside the plugin subtree and bridges only SDK-owned contexts. The plugin's custom color provider was outside that boundary.

The correction puts the existing captured `ColorContext` inside four `Modal.Content` boundaries: publishing, Board drawers, new Board and the native toolbar fallback. It keeps strict missing-theme detection and existing component lifecycle behavior. A genuine independent-root fixture reproduces the frozen old-source crash. Corrected drawer, creation, publication and fallback checks pass; changing the host theme while a modal is open updates its colors without replacing the root or losing input, draft or focus.

The earlier clean `1405853` attempt stopped at a host right-click timeout after remount. Diagnostic runs did not reproduce its cause. The fixture now waits for a restored marker, verifies its reference behavior and checks the actual authored hit target before starting a new composer. No production behavior was changed for that fixture issue. Original failures remain retained; the final commit passed a new full clean run.

## Installation and actual daemon checks

Installation backed up the retained stable source/data/settings/runtime paths, then installed all 157 tracked plugin files from the verified runtime. All five current Boards retained their titles, canvas, saved state and feed records. Exactly two live workers use the verified worker artifact. The primary daemon and daemon-worker PIDs remained unchanged. There was no daemon restart, data/settings rollback or main-branch mutation.

A separate read-only probe checked the completed installation receipt, 16 critical source/artifact hashes, the primary daemon identity and the same plugin pool coordinator before and after the calls. The installed `board.pages.accounts` discovered one existing login through the daemon's inherited GitHub CLI environment. `board.release.list` for the retained fixture and `board.pages.list` returned successfully. At probe time the fixture had no releases or publication jobs. The probe created no Board, release, job, repository or deployment, and retained no tokens or raw authentication output.

## Actual Web UI acceptance

The final run used `app.paseo.sh` connected to the primary local daemon and installed `2d04118`, not the host fixture. At 1440 and 420px widths, the header remained 48px and shortcut help was accessible. The corrected compact publication panel opened normally with public data defaulting to `{}`.

A local fixture snapshot was generated with empty public data, rendered in both desktop and compact previews, and reopened from the saved local release list. The panel also read the existing GitHub login through the actual daemon. No public confirmation, remote upload, repository creation, PR, merge or Pages deployment was attempted. Live copy and ZIP download were not exercised; the packaged Helper and adapted UI tests cover those paths.

A genuinely typed follow-up was present before a complete page reload and recovered with the exact text and its existing component reference afterward. Distinct page `timeOrigin` values (`1793492261091` and `1793492394856.1`) confirm a fresh page runtime. This scenario had no PNG, so it does not claim live PNG recovery. Only that owned test draft was discarded; no message was sent, and the fixture remained at Board revision 74, canvas revision 10 and five interactions. The owned test browser was closed.

The opaque local preview showed the expected visitor-storage warning because it cannot persist browser state in that context. Standalone hosted visitor-state persistence is verified separately by the release-browser scenarios. The sole temporary fixture snapshot was checked by its ID, title, hash and private provenance, and had no Pages job references. It was moved byte-for-byte into private `live-fixture-release.json` evidence. A final actual-daemon probe confirmed zero fixture releases and zero publication jobs, with Board revision 74, canvas revision 10 and five interactions still unchanged.


## Evidence and limits

Private evidence is under `~/.paseo/verification/paseo-board/durable-drafts-20261031/`:

- Final clean verification: `combined-1793492032747371000/receipt.json`.
- Installation: `install-1793492223496-a54232.json`.
- Installed read-only RPC probe: `postinstall-publication-1793492251507-ce8216.json`; final post-cleanup probe: `postinstall-publication-1793492443618-112512.json`.
- Actual final Web UI acceptance: `live-final-acceptance.json`. Private screenshots are `live-fixed-release-panel.png`, `live-fixed-preview-compact.png`, `live-toolbar-desktop.png`, `live-fixed-preview-desktop.png` and `live-final-draft-recovered.png`.
- Earlier slice receipts and retained failure logs include draft/toolbar, publication host, static viewer, worker and independent-review evidence. The Modal failure and correction evidence is in the sibling `modal-context-20261031/` directory.

The source/data backup is `~/.paseo/backups/paseo-board-publishing-modal-1793492223496-a54232/`. Its recovery instructions preserve current user data; restoring an old data snapshot is not part of routine source rollback.

Native desktop App CUA returned `cgWindowNotFound` in this round. Actual Web UI checks against the primary daemon are distinct from that unavailable native App path and from adapted browser fixtures. The screenshot run hid and restored the sidebar through its existing handler; that is not evidence of trusted keyboard shortcut dispatch. PNG recovery, offline/quota faults and uncertain-send retries are covered by the 14 adapted host scenarios, not the final live follow-up. Physical mobile/offline-native acceptance is not claimed. Desktop/web drafts belong to the current client profile and do not synchronize across devices; the current native-mobile SDK does not provide the required offline storage service.

GitHub state-machine verification uses a local transport. Real account discovery is verified, but repository permissions, organization Actions policies and an actual Pages deployment still need a user-selected publication target. Static export restarts authored code from materialized source, not its live JavaScript heap; unsupported assets are refused, and scripts that rely on historical execution order need review in the fixed preview.

Delivery remains on the feature branch and draft PR #4. This runtime installation and verification do not authorize merging main.
