# Board interaction refinements — verification

## Production worker packaging and process startup (isolated)

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

Private evidence is retained under `~/.paseo/verification/paseo-board/component-worker-packaging-20261031/`: `verify.mjs`, `receipt.json`, `preparation.json` and the read-only fresh-worker comparison. The two async-shell task logs retain the failed and successful launch output. No credentials or user Board contents were used.

These checks use the real installed compiler and evaluator plus real child processes, but the coordinator and storage are isolated fixtures. They do not install or reload a plugin, connect to the live daemon, exercise live daemon RPC/agent hooks, establish native UI acceptance, or cover a complete remote Git update on another computer. No main push or merge was performed. Final integrated artifacts require their own receipt.
