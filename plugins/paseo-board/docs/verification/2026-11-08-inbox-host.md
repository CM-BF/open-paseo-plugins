# Comment inbox host browser verification

Command: `BOARD_HOST_TEST_SCOPE=inbox node scripts/board-host-test.mjs`.

Seven checks passed using the production Board view, toolbar, isolated modal, inbox panel, connection editor, query layer and canvas in a private Chromium profile. The inbox transport is an explicit fixture; this is not a real daemon, deployed backend, agent-delivery or company-network acceptance result. The fixture makes no remote requests and sends no agent messages.

Verified:

- More → Comment inbox opens with agent reading and triage disabled. The modal receives the required theme and transport context.
- External markup remains literal text, including author and location fields. Human internal labels/status/notes can be edited without granting agent access or exposing a public-reply action.
- Policy changes serialize while a request is held. Revoking read also revokes triage, with no agent delivery.
- Failed source configuration preserves the exact pending request and retries its event and connection precondition unchanged.
- A stale source editor cannot overwrite another window's connection; a failed sync can recover and show imported comments.
- A configuration with an unknown outcome remains pending and can be reconciled using its original event through the human interface.
- At 420 px, native scrolling reaches source controls and an expanded triage editor. Closing the modal preserves the original canvas iframe, heap token, authored input and click listener.

The final run is `$PASEO_HOME/verification/paseo-board/inbox-host-20261108/run-1794179579843340000/receipt.json` (`PASEO_HOME` defaults to `~/.paseo`). Its log SHA-256 is `753a745dd8f19868d7c6058da53d8e533ab3660c915edbf32086b42be0c9575a`. Both `sources-420.png` and `comments-420.png` were visually reviewed. Exact test and inbox product source hashes in that receipt matched the files at handoff.

Two earlier failed runs remain under the same verification directory: `run-1794179436733349000` and `run-1794179549289361000`. The fixture's nested scroll containers left lower controls clipped after generic `scrollIntoView`. The continuation uses trusted native wheel input, verifies every clipping ancestor and the actual hit target, and still uses the original strict host click assertion. It also verifies native select-all before replacing text, including existing values. No product code changed to make these checks pass.

## Installed primary-daemon acceptance

The separate actual acceptance in [app-backends verification](2026-11-08-app-backends.md) uses the installed plugin, one real loopback backend, one dedicated Board and the original three native agent permission phases. A Chrome visitor form submitted exactly one additional comment. Through CUA, the connected native Paseo interface enabled the existing source, imported exactly that comment, displayed both comments as literal text, and separately enabled read then triage. Closing the inbox preserved the authored canvas input.

At an actual 420×860 responsive viewport, keyboard focus scrolled the second comment's internal editor and its status/cancel controls into view; cancelling made no triage change. The UI then revoked read (also triage) and disabled the source. Final readback found inbox revision 13, both permissions false, one disabled source, the two exact comments, the unchanged original internal triage object and the unchanged three-message native timeline. Expanded native read/triage tool results and their final reports received visual review.

Evidence is under `$PASEO_HOME/verification/paseo-board/app-backends-20261108/actual-20261109T001023602Z-664a5e4b9e/`: `ui-unlocked/root-ui-review.json`, its hashed screenshots, `readonly-final-1794207715566-a1ae2c.json` and `readonly-final-invariants-1794207715566-a1ae2c.json`. The independent `app.paseo.sh` direct connection failed with code 1006; these successful Board observations are from the connected native Paseo WebView. No work host, physical mobile device, public reply or automatic agent wake is claimed. The dedicated fixture was later backed up and removed; see the app-backends verification.
