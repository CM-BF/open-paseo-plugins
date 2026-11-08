# GitHub account discovery: 2026-11-08

## Problem and change

GitHub CLI JSON authentication status may exit successfully without a usable github.com account. The previous implementation filtered such entries and returned an empty list, leaving **读取 GitHub 账号** without an explanation. An Enterprise-only login is not a github.com Pages publishing account.

The repair clears inherited `GH_HOST` and token overrides, queries github.com first and accepts only successful, nonempty public identities. If none exist, it displays the public-host limitation and `gh auth login --hostname github.com` instruction for the Board daemon's host. One optional three-second diagnostic may add successfully authenticated other hostnames; diagnostic failure cannot suppress the main instruction. Valid public accounts never wait for Enterprise authentication. Legacy text output remains supported. Publication still retrieves a token for the explicitly selected hostname and user, without changing global authentication.

## Evidence at source review

- TypeScript and 49 focused account/publishing tests passed. New cases exercise the actual `execFile` boundary through a mock, including zero-exit failures, empty login, malformed output, legacy stderr, wrong-host identities, timeout handling and private-output exclusion.
- Independent review passed after correcting a candidate that initially queried every host before returning a healthy public account. That candidate could be delayed by an unreachable Enterprise host; the final version short-circuits public success.
- An official checksum-verified gh 2.92.0 binary reproduced an exit-zero empty-login entry when `GH_HOST=github.com` was set. Its configuration directory was isolated, but macOS keyring access was not. No authentication or credential mutation was performed.
- The local system gh is 2.73.0 and requires the legacy text path. The reporter's work computer and Enterprise endpoint have not been accessed.

## Completed verification and installation

- A clean archive passed TypeScript, all **484 tests in 36 files**, and **12 publication-host checks**. The host suite adapts GitHub/Paseo transport and does not publish externally.
- Under the actual Paseo Helper (Node 24.20.0), the same real gh 2.92.0 probe returned an empty account list through the original implementation and the explicit login instruction through the fixed implementation. Both use a fresh configuration directory with the shared-keyring limitation above.
- The first attempt to run Vitest directly in the signed Helper failed before tests because macOS refused to load Rollup's native module with a different Team ID. Development tests instead ran on the available Node 23.11.0; this is outside Vitest's declared supported engine range. The original failure remains retained. Helper product-module execution and development test execution are separate evidence.
- Backup installation changed only the repaired server file over the existing composition/pill baseline. All 14 existing Boards and the other 212 tracked files were preserved, with both store workers ready and the daemon identity unchanged.
- In the actual desktop app, an existing test Board's existing release was opened, **读取 GitHub 账号** was clicked and the authenticated local account became visibly selectable. The coordinator inspected the screenshot, closed the panel and returned to the previously selected Demo. No release, repository, public site, agent message or credential was created or changed. This local success path does not claim to reproduce the reporter's Enterprise-only environment in the actual UI.
- Before publication, test fixture hostnames were changed to a reserved example domain. The runtime file is byte-identical to the fully tested and installed source; the focused account/publishing suite is checked again for that fixture-only edit. Private execution receipts retain the original fixed-source identity rather than relabeling historical runs with the final documentation commit.

## Delivery scope

Only the server account transport and its tests change. Dependency tracing confirms that this module is absent from both checked-in worker and client bundle inputs, so those artifacts do not need rebuilding. The primary local installation already contains newer composition/pill work: delivery must preserve that tree and overlay only the repaired server file. A mixed installation is described as baseline-plus-one-file, not as identical to the main-based fix branch. No main merge, public site publication or work-computer installation is implied.
