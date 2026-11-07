# Board composer pill verification

Runtime commit `8d76e1f4d670a05061df9f8a8cfeb429e6b1a010` adds a native **Board** shortcut beside an agent's composer. It opens the existing `agent-board` panel for the exact workspace and agent, using that plugin installation's host. The branch is `sw/board-composer-pill`, based on composition delivery `129c672a4650804f4d82d488b7b61580d0470ef8`; its intended PR base is `sw/board-composition` ([PR #11](https://github.com/CM-BF/open-paseo-plugins/pull/11)). This change is installed locally and is not merged into main.

## Behavior and scope

One owned agent-directory subscription registers one pill for each non-archived agent with a workspace. Repeated snapshots retain existing registrations; workspace changes, archive/removal, cleanup and terminal subscription errors revoke old actions. A late bootstrap cannot recreate pills after cleanup. Separate host installations retain separate controllers and navigation closures.

The shortcut reuses existing Board entry memory. First use opens the workspace's Board list; later visits restore the Board selected through that agent panel. Explicit Back preserves the list choice. Global, workspace and agent entries keep their existing independent selection scopes. The shortcut does not add a Board-count RPC, create Boards, authorize sources or send agent messages.

Only the client controller, client entry, generated client bundle, focused tests and documentation changed. Server code, shared contracts, the worker artifact, dependency manifests and build scripts are unchanged from `129c672`.

## Fresh clean-source checks

Private evidence root: `~/.paseo/verification/paseo-board/composer-pill-20261106/`.

`verification-1794022226684420000/receipt.json` records the exact committed archive and fresh locked dependency installation. All recorded commands exited successfully:

| Check | Result |
| --- | --- |
| TypeScript | Passed |
| Complete source suite | 530 tests in 39 files passed |
| Pill lifecycle/navigation subset | Nine tests, included in the complete source suite |
| Existing Board host suite | 38 browser checks passed |
| Core reopening suite | Nine browser checks passed |
| Clean client rebuild | Byte-identical to the committed generated bundle |
| Hermes compatibility | Static check and Hermes passed; runner launched through the real Paseo Helper with `ELECTRON_RUN_AS_NODE=1` |
| Git whitespace check | Passed |

The pill tests cover eligible agents, explicit navigation, repeated/reconnect snapshots, workspace changes, archive/removal, stale callbacks, idempotent cleanup, late bootstrap, equal IDs across two host clients, synchronous initial subscription errors, bootstrap rejection and missing composer-pill capability.

The initial shared development dependency directory lacked the newly locked MCP SDK. This was an environment limitation; fresh `npm ci` supplied the declared dependency and the full typecheck/source run passed. No dependency declaration was changed for the pill.

The existing-host and reopening suites execute production Board components against adapted Paseo host services. They are not actual primary-daemon UI checks. The generated `client/hermes-bundle.js` SHA-256 is `af34c788fc121409ef035d5aeb607cf9cfb9b92f0dcd2b37537dc4539da1b876`.

This narrow client change did not rerun the complete composition browser suite or the production Helper worker/copy/export/ZIP suite. Those server and worker inputs remain unchanged; their earlier verification is recorded in [composition verification](2026-11-05-composition.md). The fresh Helper-launched Hermes check is not represented as a new execution of that packaging suite.

## Local installation

`install-1794022292614-8f1945.json` records installation on the primary Paseo **0.14.0** daemon into the existing stable path `~/.paseo/local-plugins/paseo-board/dev`.

The installer captured the current inventory, checked sustained idle and content stability, backed up runtime and Board data, and replaced all **212 tracked files of the runtime commit**. It preserved all **14 Boards** present at installation, including the persistent composition demo Boards; it did not assume the older seven-Board inventory. Exact IDs and content hashes remain in the private receipt rather than this public report.

The plugin was disabled and enabled for the update. The old pool stopped and the installed plugin returned to `running` with two worker children and no startup error sequences. The daemon supervisor and worker PIDs, host identity and version were identical before and after. No daemon restart or data rollback was attempted. The main branch remains `7058d4b4266f23bb90e14da2268ec5ae31fd99d5`.

Backup: `~/.paseo/backups/paseo-board-composer-pill-1794022292614-8f1945/`, containing separate runtime and data backups. Installation checks are not an atomic lock against unrelated producers; the receipt records the final activity/content gates and that limitation.

## Installed desktop UI acceptance

The real local Paseo desktop composer displayed one **Board** pill alongside the other composer actions. A native click opened the correct workspace/agent `agent-board` panel and restored its previously selected Board. From that panel, Back opened the workspace list, and selecting the existing composition Demo rendered its nested Boards. Closing the Board tab with the desktop close-tab shortcut, returning to the original agent, and clicking the pill again recreated the Board tab directly on the same Demo.

These actions used native computer controls. The visible composer screenshot and accessibility observations were reviewed in the task conversation; no standalone screenshot file was exported. No test Board, agent or message was created. Existing demo contents were not edited for this check.

A separate Chrome tab reached the real `app.paseo.sh` welcome page, but its direct connection to `localhost:6767` failed with transport close code 1006. The tab was closed; browser security settings were not changed. This is an incomplete Web check, not a passed one. Compact Web layout, full-page Web reload, a second agent's live navigation, physical phones and the work computer were not newly verified. Equal-ID host isolation remains covered by the focused controller tests; this pill change did not repeat the earlier dual-daemon composition acceptance.

## Receipt identities

| Private receipt | SHA-256 |
| --- | --- |
| `verification-1794022226684420000/receipt.json` | `ebd6f0afdbf10ecd354bd28504e9d7990a9aa2eda8bcf9c8283d954b512393d9` |
| `install-1794022292614-8f1945.json` | `f36076b03976fd67c8a6e5acf0a974f44d3572751ab77dbd0c5fa955f3624b22` |

The private `native-ui-acceptance.json` records the manual desktop observations and the separate Web connection limitation. Publication adds documentation only after the tested runtime commit; main is not a publication target.
