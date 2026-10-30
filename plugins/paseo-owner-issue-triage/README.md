# Owner issue triage

A standalone Paseo plugin that automatically analyzes **only issues authored by your verified GitHub account**, within an explicit repository allowlist. It runs quietly between discoveries and keeps a durable queue, results, and links to real Paseo analysis agents.

## Install

Requires Paseo 0.13.2 or later, GitHub CLI `gh` already authenticated to `github.com`, and an available Paseo agent provider. Development and installation preparation are verified with Node 24 LTS and npm 11. No new GitHub token is requested or stored by this plugin.

From this plugin directory:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build:client
paseo plugin install "$PWD" --id paseo-owner-issue-triage
```

The manifest's Git preparation commands install the locked dependencies and build the Hermes-compatible client, entirely within this directory. React and React DOM use matching versions. Keep a local installation in a stable directory, not a disposable worktree. After source changes, rebuild the client and run `paseo plugin reload paseo-owner-issue-triage`; do not restart the daemon.

## Set up

1. Open **本人 issues** in the sidebar. Add repositories as `owner/repository`, one per line, then save. The server binds the authenticated account's numeric `GET /user.id`.
2. Scan while paused to inspect existing issues. Historical issues default to **discovered**, with no model launch. Mark work already in progress as **人工接管**; claims survive reload and suppress later edits too.
3. Review the worker settings, then enable listening. The requested defaults are `codex/gpt-6-astra`, `ultra`, `full-access`, and `{"service_tier":"priority"}` (Fast). Models, modes, reasoning levels and feature values are validated against the current daemon before dispatch; unsupported choices fail visibly without fallback.
4. New owner issues and changed owner content queue automatically. Use **开始 triage** for discovered history, **手动重试** for failed analyses, and **打开分析 agent** to inspect the real task. Pausing prevents new GitHub dispatch; already-running analysis can finish. Claiming a running issue stops its worker.

The default scan interval is 180 seconds. Backfill is explicit: set a window from 1–365 days to queue discovered open issues created within that window, or manually select individual issues. Returning the window to zero does not cancel jobs already queued. Removing a repository stops its active workers and prevents further dispatch. **立即扫描** respects API backoff.

## What triage does

Each result contains category, P0–P3 priority, affected plugins, summary, confidence, and suggested next steps. The worker analyzes the supplied evidence only; it is instructed not to use tools or implement changes. GitHub access in the plugin is GET-only: no comments, labels, closing, merging, or publishing. Any later implementation is a separate user-directed task in the linked agent.

Statuses are discovered, queued, analyzing, completed, failed, manually claimed, and closed. Errors and API reset times remain visible. If an issue is deleted or inaccessible, that item fails without blocking the rest of the repository. Authentication changing to another numeric user ID fails closed; restore the bound account to resume. Pausing remains available even during a GitHub outage.

## Identity, persistence, and lifecycle

- API numeric IDs authorize intake; login names, body text, and self-reported identity never do. Pull requests are excluded before comment retrieval. Other authors' issues cannot create workers, and other authors' comments never enter worker input or content fingerprints.
- Fingerprints include title, body, and owner comment IDs/bodies. Timestamps and unrelated comments do not trigger a run. Known open issues are revisited so owner comment edits can be detected even if GitHub's issue timestamp does not move. Multiple edits during a run coalesce into one follow-up; a queued edit reverting to the last completed fingerprint needs no new run.
- A serialized dispatcher, single-writer lock, atomic/fsynced state, preallocated agent IDs, and idempotent create keys prevent concurrent and restart duplicates. A durable message receipt is written before send. Uncertain delivery is never blindly resent; manual retry first stops the old worker.
- State is kept in `$PASEO_HOME/plugin-data/paseo-owner-issue-triage/` (normally `~/.paseo/plugin-data/paseo-owner-issue-triage/`). It contains configuration, verified owner, queue, claims, worker receipts, and up to ten prior runs per issue. Issue identity records are retained for deduplication. Corrupt/incomplete state or write failure halts intake instead of silently resetting it.
- The plugin owns its timer and a server-side loopback SDK connection, so a restart does not need someone to open the UI. Cleanup closes only these resources. Existing agent identities are reconciled after reload. No daemon restart, schedule, or unrelated plugin change is required.
- Scan failures use exponential backoff up to one hour and honor longer GitHub `Retry-After`/rate-reset hints. Each `gh` request has a 30-second timeout and 8 MiB response limit. Pagination is bounded at 100 pages and fails rather than accepting truncated scans.

## Data and permissions

`gh` uses its existing local authentication. The plugin never prints credentials or copies them into prompts. It reads only allowlisted GitHub issue data and the authenticated account ID/login. State and diagnostic workspace stay on the daemon host. The issue title/body and owner comments **are sent to the chosen agent provider for analysis**; this is not a local-only model pipeline. Long bodies/comments are bounded in prompts and marked as truncated.

Analysis instructions constrain task scope; `full-access` is the user's selected provider permission mode, not a security sandbox. You can choose a more restricted available mode. All issue content is treated as untrusted evidence, and attempted worker tool calls are treated as failed analysis. The plugin does not grant issue content permission to expand its task.

## Verification and recovery

**本地诊断** runs a fixed, clearly labeled local fixture through a real low-cost worker (`gpt-6-luna / low` on the tested host). It never creates or mutates a GitHub issue. **清理测试 agent 与记录** stops/archives fixture agents and removes their queue records. This verifies real daemon/model/UI wiring; unit tests separately exercise spoofing, PRs, comments, retries, limits, persistence, and concurrency. It is not a claim that a synthetic issue was fetched from GitHub.

See [PROGRESS.md](PROGRESS.md) for verified scenarios and [verification notes](docs/verification/2026-10-29-live.md) for the genuine Web UI evidence and limits.

Before replacing an installation, record `paseo plugin ls paseo-owner-issue-triage --json` and back up its data directory. To change sources on Paseo 0.13.2, first remove this plugin registration with `paseo plugin remove paseo-owner-issue-triage`, then install the prior source using `paseo plugin install <original-source> --id paseo-owner-issue-triage`. Removal preserves the plugin data; do not remove its data directory. A first installation has no original source; disable or remove this plugin if desired. Removal preserves local state. Never delete state to clear an error: that removes deduplication history. Repair/restore the original state and reload instead.
