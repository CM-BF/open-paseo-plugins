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

The final run is `/Users/citrine/.paseo/verification/paseo-board/inbox-host-20261108/run-1794179579843340000/receipt.json`. Its log SHA-256 is `753a745dd8f19868d7c6058da53d8e533ab3660c915edbf32086b42be0c9575a`. Both `sources-420.png` and `comments-420.png` were visually reviewed. Exact test and inbox product source hashes in that receipt matched the files at handoff.

Two earlier failed runs remain under the same verification directory: `run-1794179436733349000` and `run-1794179549289361000`. The fixture's nested scroll containers left lower controls clipped after generic `scrollIntoView`. The continuation uses trusted native wheel input, verifies every clipping ancestor and the actual hit target, and still uses the original strict host click assertion. It also verifies native select-all before replacing text, including existing values. No product code changed to make these checks pass.
