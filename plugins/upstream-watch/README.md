# Upstream Watch

See [OVERVIEW.md](OVERVIEW.md) for use and [PROGRESS.md](PROGRESS.md) for actual verification.

For a local checkout, run `npm ci --omit=dev --ignore-scripts` in this plugin directory before `paseo plugin install /absolute/path/to/plugins/upstream-watch`. Managed Git installation runs the manifest's dependency preparation automatically. Development uses `npm ci` without `--omit=dev`.

`UPSTREAM.json` beside a plugin manifest declares reference relationships:

```json
{
  "version": 1,
  "sources": [{
    "repository": "https://github.com/owner/repo",
    "commit": "0000000000000000000000000000000000000000",
    "relationship": "feature",
    "paths": ["src/feature"],
    "notes": "What was adopted and which local behavior must be preserved."
  }]
}
```

The SHA is a placeholder. Use the actual adopted full commit, or omit `commit` to start tracking at the next successful check. Optional `ref` selects a branch/tag; absent means default branch. Paths are literal repository-relative files or directory prefixes, including descendants; no glob syntax. `relationship` is `fork`, `reference` or `feature`. Single-record `{repository, commit}` and nested `SOURCE.json` provenance also become candidates.

**发现来源** scans installed plugins and optionally a development checkout's `plugins/<id>/` directories. Confirm each candidate's editable target, adopted baseline and scope. Managed installation snapshots are not inferred as development targets. Discovery does not register candidates automatically or execute repository scripts.

Data lives under `$PASEO_HOME/upstream-watch/` (default `~/.paseo/upstream-watch/`): `state.json` contains watch settings, baselines and observations; `tasks.json` contains immutable prompts and native creation keys. Both use serialized atomic replacement. Malformed files are preserved and block writes for inspection. The store assumes one plugin process on one daemon.

Checks use read-only GitHub REST endpoints, preferring existing `gh` authentication, otherwise anonymous public access. The GitHub comparison itself uses no model calls. Errors retain prior successful evidence; truncated comparisons and rewritten histories explicitly require review. Only fresh explicit acknowledgement advances an existing baseline.

Update tasks use a selected existing workspace and provider/model with native permission defaults. Reviews inherit the selected model's native reasoning default; the plugin does not silently lower it for a particular model. Frozen prompts bind repository/base/head and local scope. Persisted task identities and native creation keys merge repeated clicks and preserve uncertain requests across reload. Inspect existing agents before explicitly retrying uncertain creation. Agent completion does not alter a baseline.

Recommendation-only watches add an editable core-feature inventory. The Cindy preset tracks the official `makecindy/cindy` repository from adopted commit `118767c987f518286ae10a506a54287c3dc2a560`, across the whole repository. Choose the actual local plugin development directory before saving. Each feature records literal upstream paths, local evidence paths, a declared adoption status and notes. The preset is a conservative starting assessment, not an independently verified parity claim.

The existing daily scheduler persists each comparison; the feature report derives from that observation and the saved inventory. It shows pinned baseline/head source links, changed and renamed paths, unclassified changes and incomplete evidence. Missing/partial features and the last check time remain visible even without a new diff. A path match is a review candidate, not proof of a semantic change; an unchanged path does not prove complete local implementation. Errors retain previous evidence and explicitly mark the new scan as incomplete. There is no second scheduler or automatic implementation. Optional `autoReview` reuses this check-completion path to create a read-only native review when its scope changes. Existing watches default to off.

**开建议 agent**, or an enabled automatic review, asks a selected native agent to inspect the exact upstream revisions and actual local source, verify the feature matrix, and propose prioritized ports with source/line evidence. The prompt authorizes reads and recommendations only; it forbids code/config changes, all child agents, installation, publishing and baseline advancement. Codex review agents also receive `sandbox_mode: read-only`; other providers keep their native permission settings, so this is a task boundary rather than a universal tool sandbox. The baseline can still be advanced only through the user's explicit acknowledgement action.

RPC compatibility: `watch.save` accepts optional `review: { mode: "recommend-only", autoReview: false, features: [{ id, title, upstreamPaths, localPaths, adoption, notes }] }`. Adoption values are `adopted`, `partial`, `missing`, `out-of-scope`; paths are relative to the upstream repository or local target respectively. `overview.get` returns derived `reviews` alongside existing watches/settings/tasks. `agent.launch` keeps its input and freezes the selected mode and inventory in the prompt; review launches can inspect a missing-feature backlog without a new upstream diff. Task journals default old records to `intent: "adapt"`; adaptation task deduplication is by watch/head/intent. Review deduplication additionally fingerprints the baseline, upstream head, local Git HEAD, target, feature inventory, notes, paths and the selected workspace/model. Changes to the local Git commit or inventory can produce a fresh review at the same upstream head. Uncommitted local edits are not a separate revision; the review must disclose them. Explicit retries reuse the original frozen request, even if the watch was edited later. A task's existence is not a completed recommendation or a migration result.

Run `npm ci`, `npm run typecheck`, `npm test`. Unit tests inject network/agent effects. The declared minimum is Paseo 0.13.2; current runtime verification is recorded separately in PROGRESS. Notifications are durable in-app lists and sidebar counters; GitHub is the supported source. Native Git/npm installation-source updates remain with Paseo's updater.

Automatic reviews require an existing containing workspace, a selected provider/model and a local target with a Git commit. A previous running/permission-waiting review defers new scopes; preparing or uncertain creation is never automatically resent. The persisted task links to its native conversation, where the completed recommendation lives; a created task is not labeled a completed report. A missing workspace, local revision or connection is visible as a review preparation error without erasing the successful GitHub observation.

The scheduler owns a public Node SDK connection to the existing local daemon, so it works without an open plugin page. It resolves that daemon through `paseo daemon status --home <PASEO_HOME> --json`, checks the returned home and server identity, allows only local socket/interface endpoints, and closes its connection on disposal. The CLI comes from the standard macOS app path or PATH; `PASEO_CLI_PATH` can select an explicit executable. It never starts or restarts a daemon.

Before creating a recommendation agent, the plugin prepares the exact upstream baseline and head in an owned bare Git cache under `$PASEO_HOME/upstream-watch/sources/`. It fetches fixed commits from the normalized GitHub HTTPS repository, verifies commit/tree objects and retains revision refs. No upstream checkout, hooks, submodules or source code are executed. The cache requires Git and access to the repository over HTTPS; it does not open an interactive credentials prompt. A fetch failure is a visible preparation failure and starts no agent. REST comparison authentication and Git source access are separate checks.

The review reads these cached objects and the fixed local commit with `git show`; ongoing uncommitted work or a newer local HEAD is disclosed separately. Source preparation rechecks the watch, global automatic-review setting, exact scope fingerprint, current native workspace placement and the fixed local commit before native agent creation. Older review journals recover cache metadata only if their entire original scope still matches. Cache objects are retained as evidence; review completion does not delete them or advance the adopted baseline.

Each review must distinguish source coverage from real runtime acceptance. Every inventory ID requires upstream production-code evidence and fixed-local-code evidence, or an explicit bounded search/insufficient-evidence result. Progress documents and declared adoption are leads, not implementation proof. Missing host or cloud capabilities remain gaps in the requested scope; a recommendation to defer work does not remove that feature. A completed native answer still needs evidence review and is not an automatic parity certificate.
