# One-click publication to an existing GitHub Pages site

Runtime `626a2b0b3b63358e118bb1c14b6fea0b5daf55f5` passed clean verification, was installed on the primary Paseo 0.14.0 daemon, and completed an actual publication to the user's selected GitHub Pages repository. One explicit continuation click resumed the existing frozen request. The server completed PR creation, merge, deployment and live-file verification despite a full Web UI navigation/reload after acceptance, without another publication or merge click.

Those delivery checks remain valid, but the first visual acceptance was incomplete: it checked the initial viewport and missed failures inside a collapsed experiment area. The user subsequently reported missing experiment results and a blank curve. The authored-content/data correction and its separate acceptance are recorded below; deployment success alone was not sufficient to accept this particular page.

The destination already served a branch-based Pages site. The previous implementation refused it because it expected control of the whole Pages workflow. The new path adds the fixed release under `boards/<release-hash>/` and preserves the source branch, source directory, site configuration and unrelated content. The website merge was explicitly authorized; the plugin repository remains on its feature branch and draft PR.

## Pinned verification

All 20 commands in the final clean-archive run passed, including TypeScript, 371 source tests in 29 files, clean dependency installation, Hermes evaluation, both generated-artifact rebuilds and actual production Helper packaging. The clean build directory was removed afterward.

| Real Chromium group | Passed checks |
| --- | ---: |
| Existing BoardView interaction | 38 |
| Dashboard synchronization | 9 |
| Component editing | 12 |
| Durable contextual drafts | 14 |
| Single-row toolbar | 3 |
| Isolated Modal drawers and creation | 3 |
| Native Modal fallback adapter | 2 |
| Standalone release viewer | 6 |
| Publication host UI | 12 |
| Complete canvas regression | 76 |

These are 175 executed browser checks, including repeated scenarios across scopes. The host fixtures adapt Paseo transport and UI primitives; their GitHub transport is an adapter, not the real remote publication described below.

| Committed artifact | SHA-256, identical after clean rebuild |
| --- | --- |
| `server/assets/store-worker.txt` | `123700f887485d5113e794eb90cf348cc8e988b0e4ffb86e9a908da6d145add5` |
| `client/hermes-bundle.js` | `1357c2ee39d16986935c33bf8a7b1c8fc77552e2a24abfa971d57ab01b0c5fb5` |

The production-only preparation and real installed compiler/Helper checks exercised two worker children, durable component operations, materialized publication copy/export and ZIP generation. Their isolated pool shutdown and lease cleanup passed. They did not access GitHub.

## New behavior covered

- One explicit publish request durably binds its event, release, artifact hash, account and repository before automatic preparation, merge and deployment verification. The server continues across panel closure and page loss, stops its idle polling, and limits automatic continuation to its authorization window. Old prepare-only jobs stay inert until an explicit continuation action.
- Publication UI tests cover the complete automatic path after a full reload; immutable retries after uncertain acceptance; persistence failure before dispatch; reuse of an existing live request; ongoing tracking of an authorized unknown result; late-result isolation after changing versions; and clearing obsolete publication controls when the newly selected preview fails.
- Existing branch-based sites use their actual source branch and root or `/docs` directory. Checks refuse an occupied release directory, non-directory parent, changed source configuration, extra PR changes or modified frozen files. The PR's exact head, parent, complete tree and public blobs are checked before merge. Real pending/failed checks remain blocking; an empty combined-status result is distinguished from an actual pending check.
- Deployment verification matches the merged commit and checks every frozen public file at its exact subdirectory. CDN propagation does not become a false success. Shutdown tests synchronize at a real transport operation boundary, proving that a pending preparation can finish while the next merge step remains stopped until resumed.
- Existing static-viewer checks continue to cover full-document initialization, local forms, visitor state isolation and blocked same-origin/cross-origin self-navigation. Exported files retain the fixed release's chosen data and exclude the private Board discussion/runtime bridge.

## Installation

The first installation attempt stopped before replacing source because another Board-associated agent was active. A background monitor waited for sustained inactivity, and the installer rechecked the complete current inventory and activity immediately before mutation.

The successful attempt backed up source, data, settings and runtime, then installed all 157 tracked files from the verified runtime at the retained stable plugin location. All five current Boards retained their titles, canvases, saved state and feed records. Exactly two live workers used the verified artifact. The primary daemon and its worker retained their process identities; no daemon restart, data rollback or settings rollback occurred. A second live pool shutdown cycle was not exercised; shutdown/reaping evidence comes from the isolated Helper check.

## Actual publication and independent verification

The real `app.paseo.sh` interface connected to the primary daemon and installed runtime. The existing fixed release and intended repository were selected, the public preview was confirmed, and the existing request received one explicit “一键继续发布” click. A full page navigation/reload followed acceptance. The daemon completed PR creation, merge and deployment verification without a second publish or merge action. The exact request, PR, merge commit, public URL and timestamps are retained in private evidence; no user Board title or private screenshot is committed here.

At `2026-11-01T19:56:54Z`, a separate read-only verification passed against GitHub and the public site. It did not rely only on the plugin's `live` status:

- The actual PR was merged, with its head, base and merge commit matching the frozen job.
- The merged change set consisted of exactly the four public release files in the dedicated directory. Each file's Git blob hash, type and `100644` mode matched the frozen UTF-8 bytes, and those files still matched on the current target branch.
- All 58 pre-existing repository files retained their Git type, mode and blob identities. The Pages source, build type, URL, custom-domain setting and HTTPS/public settings remained unchanged.
- The expected release URL was independently derived from the standard GitHub Pages URL and frozen release directory. Redirects were refused. All four files returned HTTP 200 and exactly matched their frozen bytes: `index.html` (182,365 bytes), `NOTICE` (414), `LICENSE-APACHE-2.0` (11,358) and `release.json` (1,916).
- The original homepage and one existing published subpage also remained byte-identical over HTTP. This is a two-URL public comparison; preservation of the complete old source tree is established separately by the 58 Git file identities.

After the full reload, the actual release panel restored the selected live job and its published-page link. The panel and initial hosted viewport were visually checked at 1440×900 and 420×860. This established real primary-daemon UI behavior and first-screen rendering, but the collapsed experiment/curve controls were not opened or exercised. The generic Chromium fixture regressions did not cover this particular authored document and could not establish that its hidden interactions worked. Native App acceptance is not claimed.

## Follow-up: missing public data and authored cold-start order

The user's report was reproduced on the original public release and on a local cold start of the same exported bytes. The fixed release contained an empty public-data object, so its experiment renderer had no `realtimeDemo` records and displayed its six-ready default instead of saved results. The export had published exactly the selected data; the publication preparation had omitted the data needed by this page.

The curve had a separate authored initialization dependency. In the final materialized HTML, the four-point enhancement ran before the original curve initializer. It read unset coordinates as zero, then replaced nodes that the later initializer expected to update. The reproduced release had four `(0, 0)` points, a degenerate path and a null-node `setAttribute` exception. Reordering those author scripts in a private probe restored distinct points and animation without that exception. This was not a CDN or deployment-byte mismatch.

An independent editable publication Board was prepared with the corrected author-script order and only the audited `realtimeDemo` data. Its labels identify final saved records and local historical replay, rather than implying that the fixed website receives new backend events. The plugin exporter, viewer implementation and installed runtime were not changed for this correction. The existing working Board and first immutable release were not edited by the publication-copy repair.

Nine checks passed in private Chromium against the repaired authored source and explicit public data: visible nonzero curve geometry and four distinct points; animation; trusted Pause; trusted control-point drag with visitor-state persistence; full reload retaining the drag and pause state; Reset; the expected four successful/two failed final results with four metric rows and 21 saved updates over 64 seconds; trusted historical slider input; and replay Play/Pause plus return to final results. The run recorded no browser errors. Its fixture release identity differs from the subsequently created real release; the actual-release audit independently confirms that the real release contains the exact reviewed authored HTML and audited public-data object.

The repaired real release was submitted through one explicit publish action in the installed Web UI and completed its own automatic PR, merge and deployment. Independent remote/Git/HTTP verification passed at `2026-11-01T20:07:32Z`. Its merged PR added exactly four frozen public files, with matching Git blobs, regular-file modes and HTTP bytes. All 62 files present before this second publication, including the first immutable release, were preserved. The Pages configuration remained unchanged; the homepage, existing subpage and first release's index were also byte-identical over HTTP. This is a three-URL public preservation check, alongside the complete prior Git-file comparison.

A fresh private Chromium session then opened the actual new public URL and passed ten checks with no browser errors. It repeated all nine corrected behavior checks against the live release: four visible distinct curve points, nonzero geometry, moving animation, trusted Pause, trusted control-point drag and saved visitor state, full reload preserving the drag/pause state, Reset, the expected final records, a trusted historical slider and replay Play/Pause/return-to-final controls. The final records contained four successes, two failures, four metric rows and 21 updates spanning 64 seconds. The tenth check resized to 420 pixels and confirmed visible curve geometry, the same result counts and a reachable enabled replay slider. These interactions changed only that fresh browser's visitor state; they did not edit the working Board or GitHub files.

The new live receipts match the real repaired release and artifact identities, rather than borrowing the local fixture's result. Their exact URL, PR, merge commit and file hashes remain in private evidence. The initial omission and original limited screenshots remain recorded even though the corrected release now passes its actual hidden-interaction checks.

## Private evidence and limits

The following paths are relative to the private `pages-one-click-20261101/` verification directory:

| Evidence | Relative path |
| --- | --- |
| Final clean run and per-command log hashes | `combined-1793562416144533000/receipt.json` |
| Pinned integration and unchanged plugin main | `integration.json` |
| Installation stopped before mutation | `install-1793562631617-1ad768.json` |
| Successful backup/install and preserved inventory | `install-1793562801997-e1c4f4.json` |
| Remote repository and public-page baselines | `repository-before.json`, `public-before.json` |
| Frozen artifact and pre-publication content inspection | `release-original.json`, `public-content-review.txt` |
| Original request and completed job | `actual-ui-before-job.json`, `actual-live-job.json` |
| Independent remote/Git/HTTP verification | `verify-public.py`, `live-public-verification.json` |
| Actual Web UI acceptance and screenshot hashes | `actual-web-acceptance.json` |
| Single-click acceptance and restored live panel | `actual-ui-publish-accepted-compact.png`, `actual-ui-live-desktop.png`, `actual-ui-live-compact.png` |
| Actual hosted desktop/compact rendering | `actual-public-desktop.png`, `actual-public-compact.png` |

Follow-up repair evidence is relative to the separate private `render-repair-20261101/` directory:

| Evidence | Relative path |
| --- | --- |
| Original live/local failure and script-order probe | `probe-result.json` |
| Nine repaired local browser checks | `fixed-browser-receipt.json` |
| Exact reviewed inputs in the newly created real release | `actual-release-audit.json` |
| Passed new remote/Git/HTTP verification and prior-site preservation | `live-public-verification.json` |
| Ten passed actual live hidden-interaction and compact-geometry checks | `live-fixed-browser-receipt.json` |

The authored HTML, selected data, private screenshots and Board identifiers remain outside the repository. The original first-screen screenshots and their receipt are retained as limited evidence, not rewritten as full-page functional acceptance.

Original source/UI review receipts and failed logs remain alongside the final evidence. An early UI typecheck ran before the new server contract was ready. The initial runner-shutdown assertion assumed an asynchronous operation had started after one timer flush; the corrected fixture waits for the real tree-write boundary and preserves the no-later-merge assertion. Neither failure was hidden by increasing a timeout or weakening the immutable-request checks.

This actual publication covers one existing standard-domain, branch-based Pages site using the repository root. `/docs`, non-default branches, newly created repositories, workflow-based sites, remote policy failures and recovery fault injection remain source/adapter test coverage rather than additional real deployments. Custom-domain live verification is still unsupported. The fixed release restarts authored code from materialized source; it does not transfer a running JavaScript heap or private agent access. This run does not establish native App or physical-mobile behavior, and a full UI reload is not a daemon-process restart test.

Plugin feature-branch publication and the final documentation-only installed-file comparison are owned by the coordinator. The user-authorized website merge does not grant permission to merge the plugin's main branch.
