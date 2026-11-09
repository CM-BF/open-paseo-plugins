# Comment keyboard shortcuts

The current input stages on Enter, sends only itself to the selected Side on Alt/Option+Enter, and forces a new Side on Alt/Option+Shift+Enter. Cmd/Ctrl+Enter sends the current comment together with the pending queue to main; the main button uses that same behavior. Shift+Enter remains a newline, IME confirmation is ignored, and a held key does not repeat an action.

A combined send persists the current comment and takes a fresh ordered revision snapshot before the existing cross-tab lock. It creates one immutable outbox and one RPC. Storage failure preserves both current and earlier comments, and the existing exact-revision cleanup and retry rules remain intact. Side shortcuts do not drain the queue.

Discussion follow-ups retain their original thread: Enter saves a follow-up draft. Cmd/Ctrl+Enter sends it only when the separate queue is empty; a nonempty queue gets an explicit notice instead of losing the thread or issuing multiple sends. An uncertain send retries only its original payload and destination.

Validation on the separate `sw/board-comment-shortcuts` branch from installed delivery `31c4a27`:

- TypeScript; 584 source tests in 42 files.
- 13 batch browser checks; 38 existing-host checks; durable-draft host checks.
- 7 focused authored-comment checks and 118 full canvas checks.
- Client rebuild; Hermes validation launched through the real Paseo Helper.

Private evidence is under `$PASEO_HOME/verification/paseo-board/comment-shortcuts-20261108/` (`PASEO_HOME` defaults to `~/.paseo`). `final-verification.json` records logs, hashes, product-file hashes and original failed provenance. The first expanded batch test stopped after a full reload reset its adapted transport to held; one correct Side RPC remained pending. Restoring accept mode after that reload fixed the test; product source and the other passed checks were unchanged.

The host/browser suites exercise production components with adapted Paseo transport. These isolated-branch checks did not install the change or verify primary-daemon UI, work-computer, physical-phone or real-agent delivery behavior. The later integration and local installation are recorded in [app-backends verification](2026-11-08-app-backends.md); real shortcut UI acceptance remains pending. Main is unchanged.
