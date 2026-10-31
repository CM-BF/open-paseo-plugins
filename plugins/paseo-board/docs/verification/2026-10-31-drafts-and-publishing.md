# Draft recovery, compact toolbar and fixed website publishing

Status: source integration in progress. These changes are not yet installed on the primary daemon. No real GitHub repository, PR, merge or public deployment was created during verification.

The user requested durable contextual message drafts, one header row with shortcut help, and generic static export plus GitHub Pages. The publishing target is a fixed version that preserves local page interaction while excluding private conversation and agent controls.

## Completed source and browser evidence

- Durable message storage covers separate host/Board scopes, frozen references and PNGs, concurrent revisions, exact uncertain sends, corrupt records and storage quota failures.
- Fourteen real Chromium draft checks pass, including full page loss, disconnected initial Board reads, receipt-before-RPC-error reconciliation, late receipts that must not replace new text, and refusal to send or leave the Board when the latest payload cannot be stored.
- Three toolbar viewport checks pass at 1024, 420 and 320 pixels. The header is always 48 pixels high; menus, rename and IME remain reachable, with no canvas remount or geometry shift. All 38 preceding host interaction checks also pass.
- Nine publishing UI checks pass through the actual ReleasePanel, static repository and editable-copy core. They cover explicit public data, invalid-input refusal, immutable snapshots, real browser ZIP download, account/repository selection, exact-head merge requests, automatic deployment status, full-page recovery of a lost preparation request, storage failure before preparation, late-response isolation and compact access. GitHub and Paseo transports are explicitly adapted in this fixture.
- Three registered host-RPC checks pass: stale source cannot export; an existing frozen release remains available after its working Board becomes unavailable; missing release evidence blocks GitHub preparation, merge and refresh.
- Copy tests cover current materialized source, independent editable content, empty private discussion/control state and durable replay that preserves later manual edits.

Six standalone export browser checks pass, including full-document root attributes, head initialization, local forms, visitor state and a forbidden navigation that produced no request at an independent receiver. Twenty-eight worker/copy/export tests pass after routing DOM materialization and ZIP encoding through the existing two-process pool; the coordinator timer responded in 18 ms during a 1.56 MB source computation. Final independent review is still being completed. Final clean-archive checks, client/worker artifact reproduction, production Helper execution, local installation and native client verification will be recorded after they actually run.

## Evidence and limits

Persistent local evidence: `~/.paseo/verification/paseo-board/durable-drafts-20261031/`. Receipts retain source hashes, logs and original failed attempts. The draft/toolbar receipt is `tests-ready.json`; release UI uses `release-host-ready.json`; standalone viewer uses `release-browser-ready.json`.

- The real Chromium host fixture adapts Paseo transport and UI primitives. It proves those integration paths, not native desktop acceptance or a live-daemon UI flow.
- GitHub state-machine tests use a local transport. Real account permissions, organization Actions rules and an actual public Pages deployment require a user-selected target; none has been chosen for this verification.
- Desktop/web drafts belong to the current client profile and do not synchronize across devices. Current native-mobile APIs do not provide the required offline storage service.
- Static export restarts authored code from final source, not from its live JavaScript heap. Unsupported remote/local resources are refused; the preview must be checked for scripts that depend on historical execution order.
- Installation, when complete, must preserve the entire current Board inventory and saved state, retain a source/data backup, and leave the daemon and main branch unchanged. Draft PR #4 is the delivery branch; this report is not merge authorization.
