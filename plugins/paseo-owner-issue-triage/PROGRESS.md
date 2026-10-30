# Owner issue triage progress

## Goal

A standalone Paseo plugin that discovers GitHub issues authored by the authenticated owner in an explicit repository allowlist, then records automatic analysis in a Paseo agent and a local queue. GitHub remains read-only. No merges, comments, labels, closing, or publishing.

## Design and decisions

- Use `gh api --hostname github.com` and the existing GitHub CLI credentials. Pin the verified numeric `/user.id` at setup; revalidate before scans. The issue author's numeric API ID is authoritative. Never use body claims, display names, or login matching for authorization.
- Exclude PRs before fetching comments or queuing. Only owner-authored comments enter the input and its content fingerprint. Issue text is evidence for analysis, never permission to execute instructions or expand scope.
- Deterministic timer scanning and persistent local state require no model for empty scans. A single serialized dispatcher starts workers only for a new trusted content fingerprint or explicit retry. Atomic state and durable reservations survive reload; reconcile worker identity before retrying any uncertain dispatch.
- Historical intake defaults to discovery without launching workers; backfill is explicit. A local claimed/excluded list protects issues already being handled elsewhere (the current installation will claim repository issue #3).
- Worker settings are configurable and validated against actual provider capabilities. The requested default is Codex GPT-6-Astra, ultra, full-access, service_tier=priority. Triage prompts request analysis only.
- Native React Native screen and sidebar: discovered, queued, analyzing, completed, failed, claimed; scan health, last scan, next retry, settings, retry, issue and agent links.
- Plugin lifecycle owns timers and a daemon SDK connection; disposal stops timers and closes only its connection. Never restart the daemon or modify unrelated plugins.
- All source, dependencies, build scripts, tests, and documentation stay under this plugin directory. Publication uses a self-contained client build.

## Tasks

- [x] Read repository rules and current plugin/publishing documentation; inspect live daemon and GitHub identity.
- [x] Implement strict GitHub intake and content fingerprints, persistent state, scan and worker lifecycle.
- [x] Implement observable native UI, configuration, manual intake/retry, and task links.
- [x] Add regression coverage for identity spoofing, others' issues/comments, PR exclusion, edits/restarts/concurrency, and API backoff.
- [x] Run typecheck/tests/build, install on main daemon, verify running/logs.
- [x] Verify genuine Web UI at desktop and compact widths, including fixture workflow and cleanup.
- [x] Complete README/overview, source/restoration notes, and final verification artifacts.

## Verification log

- 2026-10-29: Main daemon reachable; home `~/.paseo`, listen `127.0.0.1:6767`, verified primary host, daemon 0.13.2. Target plugin is not configured; no original installation or data to replace.
- 2026-10-29: `gh api user` verified intended owner numeric ID 35030752. Repository open list contains issue #3 and PRs #1/#2. No GitHub mutation performed.
- 2026-10-29: Public plugin index, reference, and publishing docs fetched successfully via curl. No separate live-testing/publish skill is installed in the local skill catalogs; repository live-testing instructions apply.

- 2026-10-29: Node 24.20.0 / npm 11.19.0 clean `npm ci --ignore-scripts`, typecheck, 108 unit tests, and Hermes client build passed. Node 23 / npm 10 dependency resolution failed with `edgesOut`; the supported LTS/npm 11 combination succeeded. Tests use explicit fixtures and are not live-daemon acceptance.
- 2026-10-29: Real read-only GitHub module smoke passed: verified owner, repository issue list, PR exclusion, issue #3 snapshot and SHA-256 fingerprint. No GitHub mutation or issue worker launch.
- 2026-10-29: Installed and reloaded exact plugin ID on main daemon 0.13.2; status running with the development plugin path, no startup errors. Initial state paused, no models launched.
- 2026-10-29: Built-in browser tab creation timed out; dedicated headless Chrome (port 9347, LocalNetworkAccessChecks disabled) opened real app.paseo.sh. Plugin route matches the verified primary host (exact ID retained privately), screen shows version 0.1.0. Saved allowlist and verified identity through UI; scan found only issue #3, no PRs.

## Known issues and next step

Core implementation, live UI verification, cleanup and stable installation are complete. Publication review found a reserved-retry issue-state refresh gap; its focused fix and regression verification are being integrated before publication.

## Review fixes

- Pause remains available during GitHub authentication errors/outages. Reserved retries respect pause, account identity, closed/unavailable issues and API Retry-After.
- Deleted/inaccessible tracked issues fail individually without blocking new intake. Manual retry clears the unavailable flag after actual access is restored.
- A queued edit reverting to the completed fingerprint is coalesced; unchanged reopened issues show their completed state without relaunch.
- Missing dedup ledger fields are rejected even in valid JSON. Real write failure latches intake off until reload; no in-memory-only reservation can launch. A serialized acquisition guard prevents racing stale-lock recovery, and every operation checks writer ownership.
- These paths have dedicated regression tests in tests/service-edge.test.ts. The development checkout is a temporary worktree; final installed source must be moved to a stable path or explicitly disclosed before cleanup.

- 2026-10-29: Adversarial review fixes validated: typecheck, 119 tests across four files, and client build pass on Node 24.20.0/npm 11.19.0. Coverage includes the 11 additional failure/recovery cases above.
- 2026-10-29: Real Web UI configured pinned owner/allowlist, claimed #3, and enabled default Astra/ultra/priority/full-access settings after capability validation. Local diagnostic created one real GPT-6-Luna/low worker, completed in 3 seconds with valid docs/P3 result and no tools. The native agent link opened its actual prompt, result, and model controls. Plugin and browser reload retained the same result/agent identity. No production GitHub issue worker was launched.
- Screenshots captured at exact 1440×900 and 420×860 viewport sizes with the real app, except the native agent baseline/first diagnostic desktop at Chrome's 1440×813 content viewport. `scripts/capture-ui.mjs` keeps emulation and screenshot in one CDP session to avoid Chrome's minimum window width. Sidebar is closed to exclude unrelated conversations.

- 2026-10-29: Diagnostic cleanup passed in both surfaces: plugin record removed, native agent archived, dedicated test workspace archived. SDK label query confirms exactly one fixture agent total, zero active, no duplicate across reloads. Only claimed #3 remains in production intake, with no run.
- 2026-10-29: Backed up source metadata and data under `~/.paseo/plugin-backups/paseo-owner-issue-triage/2026-10-29-before-stable-install/`. Paseo 0.13.2 requires removing this runtime registration before changing sources; removed/reinstalled only this plugin. Stable path `~/.paseo/local-plugins/paseo-owner-issue-triage` is running, with clean startup logs and all state preserved. Clean dependencies were installed at the stable path; no dependency on the worktree remains.
- 2026-10-29: Final real Web UI refresh on the same server confirms enabled 180-second polling, owner numeric identity, repository allowlist, #3 claim and zero diagnostic records. Desktop/compact final intake screenshots updated. Dedicated Chrome/profile cleaned. No unrelated plugin, user project, or daemon configuration changed.

## Delivery

- Runtime defaults: `codex/gpt-6-astra`, `ultra`, `full-access`, `service_tier=priority`; verified against actual provider capabilities. Fixture used `gpt-6-luna/low` only.
- Use the **本人 issues** sidebar entry. The installed scope is `cm-bf/open-paseo-plugins`, historical backfill 0, polling enabled every 180 seconds. #3 is explicitly claimed and excluded.
- [Verification report](docs/verification/2026-10-29-live.md) contains screenshot links and recovery/source notes. No original installation existed before this task.
- Work remains on `sw/paseo-owner-issue-triage`; no push or main merge performed. The coordinating agent owns integration.
