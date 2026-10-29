# Upstream Watch

See [OVERVIEW.md](OVERVIEW.md) for use and [PROGRESS.md](PROGRESS.md) for actual verification.

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

Run `npm ci`, `npm run typecheck`, `npm test`. Unit tests inject network/agent effects. Runtime targets Paseo 0.12.0. Notifications are durable in-app lists and sidebar counters; 0.12 exposes no generic plugin push sender. First version supports GitHub. Native Git/npm installation-source updates remain with Paseo's updater.
