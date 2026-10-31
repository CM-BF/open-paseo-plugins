# Board interaction refinements — verification

## Final verified revision and authorized local installation

Revision `724653feb6314c853b3894c514569c0fe5a22344` passed the final verification and was installed on the existing local Paseo 0.14.0 daemon after the user separately authorized local installation/testing. The changes remain on the feature branch for PR review. This local authorization did not authorize a main push or merge; neither was performed by this installation.

The private final verification receipt is `resumed-1793474912698076000/receipt.json`; the installation receipt is `install-1793474977332-4a8a0c.json`. Receipt names are provided for evidence lookup without publishing machine-specific paths, credentials, Board identifiers, titles or canvas contents.

| Check | Result and scope |
| --- | --- |
| TypeScript | Passed again at the final revision. |
| Full source tests | 263 passed across 19 files, including all 10 real subprocess pool tests. |
| BoardView browser integration | 38 passed, including the strengthened main-frame remount readiness check. |
| Dashboard/browser naming and synchronization | 9 passed; work state and transport state remain separate, idle probes are cursor-only, and changed dashboard summaries do not read full Boards. |
| Canvas browser integration | 57 passed, including component containment, hidden markers and explicit reveal/navigation. |
| Hermes compatibility | Passed. |
| Clean archive and dependency installation | Passed; both generated assets rebuilt byte-for-byte identically to their committed Git blobs. |
| Installed Helper/compiler packaging | Five grouped checks passed using isolated storage and two real child processes; both children exited and the isolated directory was removed. |
| Diff validation | Passed; the clean-build directory was removed after success. |

The four browser/Hermes results were originally executed at `d50a0eaaf3830cdf0453ee781a8be9d819a18316` in `combined-1793474644502619000/receipt.json`. Their individual logs all passed, although that earlier overall receipt failed its worker artifact comparison. The resumed verification reused only those four results after comparing Git modes/blobs: client sources, shared runtime/contracts and browser fixtures were unchanged, and the only intervening changes were the worker build script, generated worker and progress documentation. Each log was copied into the new receipt directory with its source log, original verified revision and matching SHA-256 recorded. TypeScript, every source test, clean builds and production packaging ran again at the final revision.

### Final artifact identities

| Input | SHA-256 |
| --- | --- |
| `server/assets/store-worker.txt` | `deebc2e98809aef857e88794a1870d2e97a41fa2513aada919560d9b4c08299f` |
| `server/store-pool.ts` | `8f88c43ae460b4397afe182b8a960b678aeb3c7f7df56b56ab71a126ecd0d8e8` |
| `client/hermes-bundle.js` | `0fc3a3a5d3d4d17085f4ed9b923bfefe368e1869380d1c84471007dd66430547` |

The final isolated packaging run used the installed compiler/evaluator and production Helper in Node mode, reported Node 24.20.0, and compiled 328,409 client bytes and 1,730,768 server bytes. Actual manifest preparation installed only production dependencies. Worker creation, IPC persistence/rename/read, exact embedded artifact identity, child reaping and lease release all passed against the final hashes above.

### Live installation evidence and remaining acceptance

The installer checked the passed receipt and exact production blobs before changing the retained local installation. It backed up the previous source, persisted Board data and runtime assets, refreshed agent/persisted-work gates immediately before disabling only the Board plugin, and then installed the pinned revision. All 109 tracked plugin files matched their committed bytes. All three existing Boards retained their titles, canvases, saved user state and feed records; no older data was restored.

The enabled plugin started one isolated coordinator with exactly two worker children. Materialized worker bytes matched the verified artifact; worker and lease files were mode `0600`, and data/runtime directories were `0700`. The actual `board.check` RPC returned an unchanged result in a 17-byte JSON payload. The existing daemon and its worker retained their process identities; no daemon restart occurred.

The main-environment installation performed one disable/enable cycle. A second live pool shutdown/restart was deliberately omitted; shutdown/reaping evidence comes from the final isolated packaged-Helper test. The installer has no public atomic idle/producer lock, so its fresh activity gates reduce but cannot eliminate a producer-start race. Once new code might have accepted writes, its failure path preserves current source/data for reconciliation instead of automatically downgrading or restoring a backup.

Native UI acceptance is **pending** at this documentation checkpoint. Browser fixture evidence adapts Paseo transport/native primitives and does not establish native interaction behavior, physical-mobile acceptance, or compatibility with automatic updates on another computer. The companion host event implementation remains separate; the installed Board can use compact checks on the current host without that companion update.

### Retained integration failures

- Earlier host runs exposed fixture assumptions about marker navigation and readiness. A response visual emits the same ready message type as the main canvas. Remount verification now requires a new main iframe DOM identity and its matching window/session receipt, and verifies that response readiness does not advance the main receipt. The original failed logs remain retained; the final 38-check run includes the stronger condition.
- The earlier clean worker differed in 99 generated source-comment blocks because linked development dependencies produced different module provenance paths. The build now resolves those labels relative to the plugin while preserving symlinks. The final archive rebuilt the committed worker and client byte-for-byte; no weaker artifact comparison was introduced.

## Earlier production packaging checkpoint (isolated)

This earlier checkpoint is retained as historical evidence. Its artifact identities are superseded by the final revision and installation above.

The installed Paseo 0.14.0 compiler, manifest preparation runner and bundle evaluator were exercised against an isolated copy of the plugin. The copy initially had no `node_modules`; the manifest ran its actual `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` command. `linkedom` resolved inside that copy, while TypeScript, esbuild, the plugin development SDK and Zod were absent from its production dependency tree.

The real client/server entry points compiled, the server bundle evaluated to its contribution function, and `compileDirectoryPlugin` accepted the prepared directory. Output sizes were 328,205 bytes for the client and 1,735,116 bytes for the server. The preparation/compilation steps did not alter either committed asset in the copied tree.

A temporary probe entry, added only to the isolated copy after validation of the real entry points, imported the production `BoardStorePool`. The same installed compiler and evaluator built and executed that probe. It initialized exactly two distinct child processes, both separate from the coordinator, and materialized the embedded worker text byte-for-byte into its digest-named `.cjs` file. Actual IPC created two fixture Boards, renamed one and read the persisted result without increasing the process count. Closing the pool reaped both children (`ESRCH`) and removed its ownership lease. The entire isolated directory was then removed.

Read-only process inspection established that this host's production plugin processes run through `Paseo Helper.app/Contents/MacOS/Paseo Helper`, rather than the main desktop application executable or a separately installed Node binary. The successful isolated verification used that same Helper with `ELECTRON_RUN_AS_NODE=1` assigned explicitly at the shell execution boundary. It ran Node 24.20.0; the Helper reports Electron 44.2.0. Each actual child command used that Helper, `--max-old-space-size=384`, and the generated worker file. This checks the Electron Node execution path used by this host's plugin workers.

### Artifact identity and subsequent source changes

The successful receipt is bound to these exact inputs:

| Input | SHA-256 |
| --- | --- |
| `server/assets/store-worker.txt` | `d9fee729029ecb63710dac389975edbd017939a5c4bf613f165b2a3d28e7f0e5` |
| `server/store-pool.ts` | `8f88c43ae460b4397afe182b8a960b678aeb3c7f7df56b56ab71a126ecd0d8e8` |
| `client/hermes-bundle.js` | `370d22055324ab0f417a54da3f54d0ddb635c7138b4b3a927c22e607d203660e` |

At source inspection commit `88d73e9b3c807f2e36a1f5841593f92eb1f29feb`, both the worker asset and pool source in HEAD and the working tree matched the tested hashes. The tested client asset matched the working tree but had not yet been committed. A separate read-only rebuild from the then-current sources produced worker hash `ed52990186cdb96e5ec113f7a5583d76693c8668aa67f3c3a3a7cb5b2a046234`: later compact-check contract changes had not yet been incorporated into the committed worker asset. The diff contained the compact-change response schema, compact request flag and `board.check` contract. The coordinating integration must rebuild the worker and rerun packaging against its final artifact; the earlier receipt is not evidence that an untested replacement artifact passed.

### Retained startup failure and limits

The first background launch (`task-4d3b1301f0cd`) used the main application executable with an `argv` launch and environment overrides. It entered the desktop CLI and rejected the verification script path as an unknown command before that script executed. The prior dependency-installation investigation had seen the same wrong-mode symptom. The successful retry (`task-8acfa79a2a80`) used the actual production Helper and explicit shell-boundary Node-mode assignment, with a preflight reporting `process.execPath`, Node version and the effective variable. This was a launcher-mode failure, not a worker/compiler result; the runner's internal environment handling was not independently diagnosed.

Private evidence is retained in `component-worker-packaging-20261031`: `verify.mjs`, `receipt.json`, `preparation.json` and the read-only fresh-worker comparison. The two async-shell task logs retain the failed and successful launch output. No credentials or user Board contents were used.

These earlier checks used the real installed compiler and evaluator plus real child processes, but the coordinator and storage were isolated fixtures. They did not install or reload a plugin, connect to the live daemon, exercise live daemon RPC/agent hooks, establish native UI acceptance, or cover a complete remote Git update on another computer. Final artifact and local installation evidence are recorded separately above.
