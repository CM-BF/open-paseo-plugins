# Enterprise GitHub publishing verification — 2026-11-08

The publisher now supports company GitHub accounts and Pages without requiring a github.com login. This supersedes the [earlier public-only account diagnostic](2026-11-08-github-accounts.md), whose exact historical results remain retained.

## Behavior and compatibility

Account discovery accepts host-qualified identities and an optional hostname filter. The selected host remains part of repository lookup, immutable client outbox, CLI input, server journal and token lookup. Public GitHub, GitHub Enterprise Cloud `*.ghe.com`, and GitHub Enterprise Server use their corresponding REST endpoints. No global active-account switch is made. Existing records without a host retain github.com behavior; old journal records without a publication mode retain their original workflow semantics.

New GHES sites use branch-based Pages publication rather than an unsupported public Pages deployment Action. Existing branch-based sites preserve their source configuration and receive a versioned directory. Hostnames, account/repository paths and CLI flags are validated. Preparation, exact PR head verification, merge and recovery retain the original immutable target.

Deployment URLs come from the authenticated target GitHub API, including internal/custom HTTPS domains. Website byte verification receives no GitHub token and does not follow a login redirect. A completed build behind company login can show **打开网页（内容待核验）**; only matching frozen public files qualify as `live`. Company Pages policy, authentication, TLS trust and network access are still required.

## Exact source identities

| Role | Commit | Scope |
| --- | --- | --- |
| Main-based PR runtime candidate | `3b54f481c71b4b1fddd3b89a98d5535d9e210bb4` | Enterprise changes for draft PR #13 |
| Original unchanged source-test execution | `dd7e3935df9b98967dea6c0cabf704b938d457a1` | Source/type results inherited only after exact Git blob/mode comparison |
| Local composition/pill baseline | `2c48ceabf46b271859156eb116c77b338c3a83be` | Existing newer local features preserved |
| Integrated and installed delivery | `31c4a271fafdb830a9281c8e7faf78537b6e900b` | Enterprise plus composition/pill, built and tested separately |

The integrated release retains its correct Paseo-host `useBoardRpc` binding, managed-embed export boundary and existing ZIP download receipt checks. It rebuilds client and worker assets from the integrated source; the main-based bundle is not copied over the newer local client. The two trees are deliberately different, and PR verification is not a claim of whole-tree identity with the installation.

## Verification

| Check | Main-based candidate | Integrated delivery |
| --- | --- | --- |
| TypeScript | Passed, inherited with unchanged inputs | Passed, newly run |
| Source tests | **515 tests / 37 files**, inherited | **582 tests / 41 files**, newly run |
| Publication host browser | **15 checks** | **15 checks** |
| Static release browser | **8 checks** | **8 checks** |
| Existing Board host | Not rerun for this candidate receipt | **38 checks** |
| Core Board reopening | Not rerun for this candidate receipt | **9 checks** |
| Composition host | Not present in this main-based tree | **12 checks** |
| Clean client/worker rebuild | Byte-identical | Byte-identical |
| Hermes using actual Paseo Helper | Passed | Passed |
| Production-only Helper compilation/evaluation and worker lifecycle | Separate earlier module evidence | Passed with two actual worker processes |

Publication browser checks exercise actual static/copy logic with adapted GitHub and Paseo transport. They cover host-qualified account/repository selection, old-record recovery, immutable retries and SSO deployment links, but they do not contact or publish to a real company GitHub server. Composition tests use adapted public transport, not a newly run cross-network daemon test.

The integrated production check uses actual signed Paseo Helper Node 24.20.0, the production-only dependency tree and installed compiler/evaluator. It verifies both worker children, IPC, editing, copying, export/ZIP and owned process cleanup. Development source tests use available Node 23.11.0, outside Vitest's declared supported engine range. The earlier attempt to run Vitest inside the signed Helper failed on Rollup native-module Team ID loading; it remains a failed test-environment attempt, not a successful Helper source-test run.

A real checksum-verified gh 2.92.0 binary was exercised through the actual Helper with a fresh configuration directory. Earlier evidence reproduced the exit-zero empty-login issue, and the Enterprise candidate checks its discovery behavior without changing authentication. macOS keyring access remains shared despite the isolated configuration. This does not reproduce the work computer's actual Enterprise-only login.

The main-based source/type results were executed at `dd7e3935` and inherited at `3b54f481` only because product, source-test and dependency blobs/modes were identical. Only the release-host harness and documentation differed. The earlier two browser failures are retained: one inspected account controls before rendering; the next returned a React DOM node through the serializing test bridge. The final harness waits for rendered/enabled controls and returns a Boolean. It retains the exact dual-host assertions. Product behavior was not changed to satisfy those test corrections.

## Installed state and local desktop acceptance

After sustained idle checks, backup installation placed the exact integrated delivery at `~/.paseo/local-plugins/paseo-board/dev`. All **215 tracked files** matched the commit. All **14 existing Boards** retained their complete content envelopes apart from the explicitly allowed background extraction checkpoint fields; the receipt records no checkpoint changes in this run. Existing dependencies stayed in place.

The Board plugin was reloaded exactly once. The old pool exited, two verified workers became ready, and the plugin remained running at the retained path with no startup errors. Primary daemon 0.14.0 identity and both daemon process IDs were unchanged. The installer did not restart the daemon, restore old data, send agent messages, access the work computer or publish externally. Main remained at `7058d4b4266f23bb90e14da2268ec5ae31fd99d5`.

Actual native Paseo desktop acceptance used `cua_repl` on an existing Demo. It generated and retained one local offline release with `publicData={}`, then visibly read **CM-BF · github.com** twice: with a blank host filter and with explicit `github.com`. The inspected screenshot showed the hostname input, host-qualified account and Enterprise-support text. **一键发布** remained disabled; no repository was selected, publication consent/action clicked, external request to publish made, or agent message sent. The panel was closed and the original conversation restored.

The Demo remained at revision 13 with identical authored content. An initial raw-file comparison differed because only `extraction.cursor` and `extraction.lastCheckedAt` had advanced; that precheck is retained separately rather than described as exact raw-file equality. All four existing Pages journals stayed byte-identical, no new publication job appeared, original releases remained unchanged, and all 215 installed files still matched the delivery commit. The one new local release is explicitly retained, not reported as cleaned up.

Screenshots were visually inspected in the CUA tool output; no standalone screenshot artifact was saved. This is native desktop acceptance only, not a new compact/mobile test. Only a github.com account is configured locally. Actual company-server repository creation, PR merge, Pages deployment, SSO access and the work computer remain unverified and were not accessed.

## Evidence and delivery boundary

Private evidence is retained under `~/.paseo/verification/paseo-board/gh-accounts-20261108/`:

- `enterprise-clean-1794129490434309000/receipt.json`: final main-based result, inherited source provenance and command/log hashes.
- `enterprise-clean-1794129261492862000/receipt.json` and `enterprise-clean-1794129437360064000/receipt.json`: original failed browser runs.
- `enterprise-delivery-1794129654385963000/receipt.json`: integrated clean-source and browser results, source/build hashes.
- `enterprise-delivery-1794129654385963000/production-packaging/receipt.json`: actual Helper compilation and two-worker receipt.
- `install-enterprise-1794129958558-f90461.json`: exact installation, Board preservation, reload and daemon checks.
- `actual-enterprise-ui-receipt.json`: native-desktop account-entry observations, retained local release and post-check invariants.
- `actual-enterprise-ui-file-precheck.json`: original raw-file mismatch before identifying the two background extraction checkpoint changes.
- Backup: `~/.paseo/backups/paseo-board-enterprise-1794129958558-f90461`.

Draft [PR #13](https://github.com/CM-BF/open-paseo-plugins/pull/13) targets main. Its final documentation commit and remote-head verification are recorded separately; local installation does not merge that PR or update the work computer.

The dynamic backend and native external-comment inbox remain design proposals. The intended primitive is ordinary agent-owned application code with arbitrary storage/schema/migration logic and reusable SSH deployment/data-lifecycle scaffolding. SSH controls deployment; visitors need a reachable HTTP(S) service. Native comments would enter a persistent inbox, with receiving, agent triage, applying changes and public replies separately authorized. This implementation neither runs such a backend nor delivers external comments to an agent.
