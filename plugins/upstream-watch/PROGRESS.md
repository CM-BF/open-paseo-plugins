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
- [x] Register Cindy once, using adopted baseline `118767c987f518286ae10a506a54287c3dc2a560`.
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

## Live Cindy registration and review

On 2026-10-29, the enhanced plugin was installed on the existing 0.13.2 daemon from a retained development checkout, with a complete source/state/settings backup. All five prior watches were retained byte-for-byte during replacement. Cindy was registered exactly once with the 28-feature inventory, the adopted baseline above, and explicitly enabled daily automatic recommendation-only reviews. The first actual comparison reached upstream `5f0b5f42b46969c3ac21b0cd798a07e36b46e8fd` and created one native Codex review with a read-only sandbox, bound to local revision `80061c4fec6895ce9baba403a38a6c58671bd95a`. This review is not an implementation task and does not advance the baseline.

The first answer incorrectly stopped at unrelated uncommitted development changes. The same review session was continued with a clarified fixed-Git-blob reading contract; no second review agent was created. Future prompts now explicitly read `localRevision` with `git show`, continue when the working tree or current HEAD differs, and never reset, stash, clean, or check out the development tree. Final report quality and live deduplication remain to be verified. The prompt change passed TypeScript and 33 focused task/review tests. Private deployment and report evidence remains under the host's verification directory, outside Git.

The new recommendation UI has not passed visual acceptance: the computer-use surface cannot locate the visible native main window, and the official web client direct connection times out. This does not invalidate the separately verified RPC scan but remains an explicit UI gap.

### Fixed-source evidence preparation

The live rescan/reload check passed with six watches (five retained plus Cindy), 28 feature records, a 24-hour interval and no duplicate review for the same scope. The resulting report was inspected and **did not pass recommendation acceptance**: its sandbox could read the fixed local commit but could not retrieve the upstream head through web search, so all 28 features remained unverified. The presence of that report is not recorded as a completed semantic review.

Added an owned bare Git source cache prepared before native review creation, plus immutable source metadata in the task journal. Cached baseline/head commits are verified and read without checkout or source execution. Post-fetch admission rechecks enablement, frozen scope and current workspace placement; local HEAD may change, but the fixed local commit must remain readable. Legacy review journals recover source metadata only under the original scope key. Preparation failure starts no native agent. An independent review caught workspace movement during fetching and the old-journal bypass; both are now covered by the preparation boundary. TypeScript and 47 focused tests pass, including actual temporary Git fetch/blob/diff checks and delayed-scope revocation. The real Cindy cache and a substantive final report still require verification.

On 2026-10-29, source revision `39170743c3b5a58b52fb34ba68a344777aab898d` passed clean production dependency installation, the shipped Paseo compiler and Hermes. An initial network fetch failed before any agent creation; a controlled retry obtained both exact public commits and verified their commit/tree objects. The original failure's transport detail was unavailable, so no specific root cause is asserted. The retained checkout was reloaded on the main 0.13.2 daemon after fresh owned-agent idle checks and source/state backups. All six watches, the 28-feature inventory, 24-hour interval and unchanged adopted baseline were verified; the five unrelated watches remained byte-for-byte unchanged.

The normal automatic-review path created one new read-only agent for the expanded evidence scope. Its single native input exactly matched the frozen prompt plus prepared source metadata, and its final answer belonged to the same successfully completed native turn. The resulting 10,038-character report cited actual pinned upstream changes. Its full 28-feature parity assessment **did not pass acceptance**: most rows still relied on the local progress ledger, and some inferred work-in-progress capabilities as present in the fixed commit or moved requested missing features outside scope. Strengthened the review instructions to require per-ID production-code evidence, exact local-commit references, bounded absence searches, separate runtime acceptance, and preservation of requested scope. This prompt revision still needs a new real report; the previous result is retained as partial evidence, not overwritten or labeled complete. Private reports and backups remain outside Git. Actual UI acceptance remains open.
