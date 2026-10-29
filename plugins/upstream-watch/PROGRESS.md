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

The optional review inventory extends existing watches; older state and task journals remain readable. The existing scheduler persists comparisons and never starts model jobs. Reports retain declared adoption and missing-feature candidates without a diff, match both sides of renames, and distinguish incomplete evidence from no path change. All source links pin the adopted baseline or observed head. Unclassified files remain candidates for new core features.

Explicit review agents receive frozen inventory, source revisions and a read-only task. Their intent is separate from adaptation tasks at the same head; retries retain the original request and never reuse a previous implementation task as a recommendation task. Codex adds a read-only file sandbox. Other providers retain native permission settings. No automatic baseline advancement or implementation is added.

2026-10-29 offline validation: TypeScript passes; all 97 behavior tests pass. Added coverage includes old schemas/journals, intent separation, frozen retry payloads, no-diff backlog, scheduled inventory persistence, renamed paths, path boundaries, unclassified changes, unknown/truncated/diverged/failed comparisons, and input bounds. Production installation and visual acceptance are not implied by these checks.
