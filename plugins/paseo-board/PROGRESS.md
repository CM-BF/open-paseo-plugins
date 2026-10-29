# Paseo Board publication and verification

## Goal

Provide a persistent, fully interactive, task-independent conversation canvas for humans and agents. The agent freely authors HTML/CSS/JS; the plugin supplies durable identity, incremental updates, selection, contextual questions/forks and records of meaningful default decisions. Desktop capability is primary; mobile has a compatibility view.

## Decisions

- Keep the free canvas as the main surface, with no required task schema or component catalog, so better models can create richer interactions.
- Reuse attributed renderer assets as local copies because no stable cross-plugin renderer interface is available. Reuse async-shell through its public CLI rather than building another supervisor.
- Use revisioned patches and separate operational checkpoints to preserve controls and avoid false content-update conflicts.
- Separate message delivery from application: an applied receipt needs concrete result references.
- Keep contextual selection and actions near the pointer. Selection holds its displayed version, and the host owns the final message composer.
- Publish only tracked plugin content from local source commit `4fc08fc`, then make build tooling self-contained and remove private machine/session identifiers from public documentation.

## Subtasks

| Task | Status |
| --- | --- |
| Storage, revisions, durability and delivery | Complete; source tests and real fixture flow verified |
| Free canvas, local patches and saved controls | Complete; browser and native desktop checks verified |
| Questions, forks, selected-reply return and default decisions | Complete; documented source and live fixture checks |
| Option/Alt selection and right-click actions | Complete; 25 browser scenarios and native desktop checks |
| Self-contained public build and fresh checkout validation | Complete; clean dependency install and source checks passed |
| Direct publication to remote main | Authorized by user; this change targets main |

## Verification records

### 2026-10-29 — original local source `4fc08fc`

- Daemon: Paseo 0.13.2, primary local daemon. Installed source: retained directory `~/.paseo/local-plugins/paseo-board/dev`. No daemon restart or unrelated plugin reload.
- TypeScript check passed; 55 source tests across five files passed; isolated real Chrome + React integration passed 25 scenarios; Hermes compatibility build/evaluation passed.
- Actual native Paseo UI verified the right-click menu, blank focused change composer, original toolbar preserving the selected point, cancellation without a new intent, and Board reply patches appearing live. The final reload preserved the latest curve, speed and draft.
- Earlier real fixtures verified newly injected tools, local updates, a discussion fork's later reply, returning that selected reply to the owner, and an actual async-shell event while the owner stayed idle. Duplicate events were inert. These are previous recorded checks, not rerun publication checks.
- Backup locations: `~/.paseo/backups/paseo-board-context-actions-20261029-014059` and `~/.paseo/backups/paseo-board-context-actions-20261029-013738`. Private identities and state are not included in this repository.
- Screenshot paths: no persistent screenshots were retained for the final contextual-action walkthrough. Native UI observations are recorded in local session history; no screenshots or mock results are represented as production evidence here.

### 2026-10-29 — publication preparation

- Exported tracked plugin files from `4fc08fc` into a separate checkout based on public main. The daemon continues using its retained local runtime.
- Public documentation removes private filesystem/session identifiers while preserving copyright and license attribution.
- Added a local `scripts/build-client.mjs` with explicit Babel dependencies, so the public plugin builds without tools from the developer's other checkout. Pinned ReactDOM to React's exact version.
- Clean installation, TypeScript, 55 source tests, standalone client build, 25 real Chrome integration scenarios and Hermes evaluation passed in the publication checkout.
- A clean dependency audit identified old test-only dependencies. Vitest was updated to 4.1.12 and Vite pinned to 7.3.7; clean installation, TypeScript and all 55 tests passed again with Node 22.23.4 and npm 11.21.1. The resulting dependency audit reports zero vulnerabilities.
- npm 10 hit an Arborist peer-resolution error while generating the newer test dependency graph; npm 11 generated the lock normally. No force or legacy-peer-deps bypass was used. The README specifies the verified toolchain.
- Public main's Git history is the publication record. The private development checkout records the verified remote commit after push.

## Known boundaries and next steps

- Physical phone behavior and a fresh narrow-width native walkthrough have not been verified; no mobile parity is claimed.
- Source and fixture tests do not replace the real native desktop checks recorded above.
- Decision extraction is conservative and cannot recover unstated private reasoning. A send with uncertain acknowledgement is not blindly retried; the SDK still has a narrow idle-check/send race.
- Future changes should rerun the documented checks and update this ledger; preserve the native runtime's retained directory when cleaning publication checkouts. See `IMPLEMENTATION.md` for detailed behavior and limitations.
