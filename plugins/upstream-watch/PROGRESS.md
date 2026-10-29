# Upstream Watch

## Goal and existing behavior

Track GitHub forks, reference projects and selected features behind local Paseo plugins. Keep an explicit adopted baseline, run periodic read-only comparisons, and open user-requested adaptation tasks. Native installation-source updates remain Paseo’s responsibility.

- Checks run daily by default without model calls. Failures and truncated/rewritten comparisons remain visible.
- Only explicit acknowledgement advances a baseline. Creating or finishing an agent does not.
- Agent requests persist frozen base/head, target and native idempotency key. Uncertain creation is not blindly repeated.
- Data is stored in `$PASEO_HOME/upstream-watch/`; unrelated plugins and tracks are not modified.

## Existing verification

The imported implementation is the deployed source revision `26e8658d0261377ecef0d08bdb6b8d862bd8a034`, originally tested on Paseo 0.12.0 on 2026-10-24. Its existing record reports 81 offline behavior tests and a real dedicated GitHub fixture: comparison, workspace/provider selection, native agent creation, explicit acknowledgement, settings persistence, desktop and compact UI, and cleanup. These are historical results, not a new run of this branch. Private screenshots and machine-specific runtime evidence are intentionally excluded from this public import.

On 2026-10-29, the main daemon is Paseo 0.13.2 and the deployed plugin remains running at the imported revision. Five existing tracks are present. No state changes or reload occurred during source import.

## Current work

- [x] Import the deployed implementation into an isolated `sw/` branch without changing its installation.
- [x] Add a persisted core-feature inventory and recommendation-only review workflow.
- [ ] Register Cindy once, using adopted baseline `118767c987f518286ae10a506a54287c3dc2a560`.
- [ ] Verify type checking, relevant behavior tests and real scan/recommendation output; preserve existing tracks.
- [ ] Record deployment source, backup, cleanup and draft PR.

Actual UI acceptance of the new review workflow remains pending until tested against the running plugin. Source checks and RPC results alone do not establish visual acceptance.

## Recommendation-only workflow

The optional review inventory extends existing watches; older state and task journals remain readable. The existing scheduler persists comparisons. Optional per-watch automatic review starts a read-only model task only when the scope fingerprint changes; older watches default to off. Reports retain declared adoption and missing-feature candidates without a diff, match both sides of renames, and distinguish incomplete evidence from no path change. All source links pin the adopted baseline or observed head. Unclassified files remain candidates for new core features.

Explicit review agents receive frozen inventory, source revisions and a read-only task. Their intent is separate from adaptation tasks at the same head. Review identity additionally binds local Git HEAD and the feature inventory; retries retain the original request and never reuse a previous implementation task as a recommendation task. Codex adds a read-only file sandbox. Other providers retain native permission settings. No automatic baseline advancement or implementation is added.

2026-10-29 offline validation: TypeScript passes; all 118 behavior tests pass. Added coverage includes old schemas/journals, intent separation, frozen retry payloads, no-diff backlog, scheduled inventory persistence, renamed paths, path boundaries, unclassified changes, unknown/truncated/diverged/failed comparisons, and input bounds. Production installation and visual acceptance are not implied by these checks.

The Cindy inventory now mirrors all 28 rows of the companion CORE_FEATURES matrix. Every upstream path was checked against the pinned Git tree and every local evidence path exists. Generic input supports up to 40 bounded feature records. Added automatic-review tests cover no-diff initial backlog, restart deduplication, new head/inventory/local revision, opt-out/global pause, unresolved creation, active/permission-waiting previous review, preflight edit/delete/pause/disposal, and local revision failure. Local client tests cover exact home, reconnect identity, disposal and local-only endpoints. A separate read-only smoke check connected to the existing 0.13.2 host, read provider availability, reused the connection and confirmed disposal rejects reuse; it started no agent or daemon.

## Hermes-compatible published client

The first clean production check evaluated successfully in Hermes but still contained block-scoped bindings. Added an explicit esbuild/Babel client build and committed generated entry; source remains index.client.tsx. Rebuild with npm run build:client after client/shared edits. The lowered bundle passes the shipped compiler static syntax audit and Hermes evaluation; typecheck passes.
