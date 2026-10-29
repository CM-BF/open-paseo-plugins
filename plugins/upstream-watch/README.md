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

Checks use read-only GitHub REST endpoints, preferring existing `gh` authentication, otherwise anonymous public access. No model calls are used. Errors retain prior successful evidence; truncated comparisons and rewritten histories explicitly require review. Only fresh explicit acknowledgement advances an existing baseline.

Update tasks use a selected existing workspace and provider/model with native permission defaults. Frozen prompts bind repository/base/head and local scope. Persisted task identities and native creation keys merge repeated clicks and preserve uncertain requests across reload. Inspect existing agents before explicitly retrying uncertain creation. Agent completion does not alter a baseline.

Recommendation-only watches add an editable core-feature inventory. The Cindy preset tracks the official `makecindy/cindy` repository from adopted commit `118767c987f518286ae10a506a54287c3dc2a560`, across the whole repository. Choose the actual local plugin development directory before saving. Each feature records literal upstream paths, local evidence paths, a declared adoption status and notes. The preset is a conservative starting assessment, not an independently verified parity claim.

The existing daily scheduler persists each comparison; the feature report derives from that observation and the saved inventory. It shows pinned baseline/head source links, changed and renamed paths, unclassified changes and incomplete evidence. Missing/partial features and the last check time remain visible even without a new diff. A path match is a review candidate, not proof of a semantic change; an unchanged path does not prove complete local implementation. Errors retain previous evidence and explicitly mark the new scan as incomplete. No second scheduler, automatic model run or automatic implementation is introduced.

**开建议 agent** asks a selected native agent to inspect the exact upstream revisions and actual local source, verify the feature matrix, and propose prioritized ports with source/line evidence. The prompt authorizes reads and recommendations only; it forbids code/config changes, implementation agents, installation, publishing and baseline advancement. Codex review agents also receive `sandbox_mode: read-only`; other providers keep their native permission settings, so this is a task boundary rather than a universal tool sandbox. The baseline can still be advanced only through the user's explicit acknowledgement action.

RPC compatibility: `watch.save` accepts optional `review: { mode: "recommend-only", features: [{ id, title, upstreamPaths, localPaths, adoption, notes }] }`. Adoption values are `adopted`, `partial`, `missing`, `out-of-scope`; paths are relative to the upstream repository or local target respectively. `overview.get` returns derived `reviews` alongside existing watches/settings/tasks. `agent.launch` keeps its input and freezes the selected mode and inventory in the prompt; review launches can inspect a missing-feature backlog without a new upstream diff. Task journals default old records to `intent: "adapt"`; task deduplication is by watch, head and intent. Explicit retries reuse the original frozen request, even if the watch was edited later. A task's existence is not a completed recommendation or a migration result.

Run `npm ci`, `npm run typecheck`, `npm test`. Unit tests inject network/agent effects. The declared minimum is Paseo 0.12.0; current runtime verification is recorded separately in PROGRESS. Notifications are durable in-app lists and sidebar counters; GitHub is the supported source. Native Git/npm installation-source updates remain with Paseo's updater.
