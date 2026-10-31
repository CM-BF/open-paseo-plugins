# Inline naming and dashboard status fixture

The change is prepared on a feature branch for PR review. No live plugin installation, daemon reload, main-branch publication, or other-machine compatibility result is claimed.

## Behavior

- The pencil beside a Board title opens an in-place input containing the selected current name. Enter saves, Escape cancels, and IME confirmation does not submit. Empty or overlong titles are rejected.
- Rename uses a title-field comparison and a durable event receipt. Unrelated canvas updates do not reject the rename. Competing title changes require explicit acknowledgement, failed requests retain the draft, and uncertain responses retry the exact event ID and payload.
- Renaming changes Board metadata while preserving the canvas document version, content, saved user state and live iframe instance.
- The dashboard shows processing, attention and idle status independently from unread updates. Status and title events update their affected row without periodic list or Board reads.
- A missing or failed event transport is surfaced as a synchronization error. The browser fixture installs an explicit test transport; it does not prove support in the installed Paseo host.

## Executed checks

On 2026-10-31:

- `npm test -- server/store.test.ts`: 36 tests passed, including three new tests for metadata-only rename, competing writers and receipt replay, and invalid names. These use temporary data directories.
- `BOARD_HOST_TEST_SCOPE=rename npm run test:host`: five actual React/Chromium fixture scenarios passed. They cover focus and selection, Escape and empty input, IME, pending duplicate suppression, retained drafts, concurrent title changes, uncertain-response retry, and unchanged canvas/control state.
- `BOARD_HOST_TEST_SCOPE=dashboard npm run test:host`: the same five scenarios plus incremental status/title rendering passed. The sixth scenario checks processing → attention → idle, an unchanged unrelated row, independent unread badges, no full reads during event delivery, and no periodic reads over the removed four-second refresh interval.

The fixture adapts Paseo RPC/event transport and React Native primitives while running the real Board components, query hooks and sandbox runtime. It is isolated browser evidence, not real-daemon UI acceptance. Combined typecheck, full browser regression, client build and process-pool verification belong to the integration checkpoint.

An initial dashboard test returned a DOM node through the debugging protocol and failed serialization (`Object reference chain is too long`). The test now stores that node in the page and returns a primitive; no product behavior was changed for that harness failure.
