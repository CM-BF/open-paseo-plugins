# Source-position text editing verification — 2026-10-31

## Result and scope

Runtime `f1e85f2fa053f20a015c08fb993d93f028793343` passed clean automated verification and was installed on the primary local Paseo 0.14.0 daemon. Native UI acceptance for this iteration was unavailable. No native save, cancel or reopen result is claimed for the new text editor.

The user requested editing directly over the original words. This change replaces the separate text-entry window with a source-aligned editing layer, retains the existing semantic text patch and host Save contract, and removes the second text input from the ordinary Save card. Agent-authored HTML/CSS/JS and existing publishing behavior remain available without a component schema.

Work stays on `sw/board-interaction-next` and [draft PR #4](https://github.com/CM-BF/open-paseo-plugins/pull/4). Main remains at `9bd750c`; installation and successful tests do not authorize a merge. The final documentation/PR publication receipt is separate from the runtime verification below.

## Clean pinned verification

All checks below ran against a clean archive of the fixed runtime. The clean tree was removed after verification.

| Check | Result |
| --- | --- |
| TypeScript | Passed |
| Source suite | 298 tests in 22 files passed |
| Full Board host browser suite | 38 checks passed |
| Dashboard browser suite | 9 checks passed |
| Component-edit host browser suite | 12 checks passed |
| Canvas browser suite | 71 checks passed |
| Clean worker and client rebuilds | Both byte-identical |
| Hermes | Passed |
| Production Helper compiler/evaluator and pool | Passed with exactly two independent workers |
| Diff check | Passed |

The browser scopes total 130 executed checks, including repeated title checks across host suites. They use real Chromium and the actual client/runtime with adapted fixture transport. They are not a native installed-daemon walkthrough.

The production-only preparation and actual installed compiler accepted both runtime entries. Production Electron Helper in Node mode started two workers, exercised persisted guarded text/move/copy edits, exact receipt replay and typed refusal handling, then reaped the children and released the isolated ownership lease. These packaging checks did not use the user's Board data.

| Artifact | SHA-256 |
| --- | --- |
| `server/assets/store-worker.txt` | `267fd6699a9183745294bf45985eaead174c90b2dedf4324773b5173734bbcc2` |
| `client/hermes-bundle.js` | `69507219550957c192377673ec66827d1715527f94957369dae87a3f6d0a9042` |
| Clean verification receipt | `a12b5d8e9c46ac8c7ccadf648b1c92278a33af2a8ebd94b99ba6342a46678414` |

Private evidence directory: `~/.paseo/verification/paseo-board/inline-text-20261031/`. The fixed-source receipt is `combined-1793485740902263000/receipt.json`; its result entries identify the individual logs. Public documentation omits Board contents and private session identifiers.

## Behavior covered

- The initial editable text range matches the original rendered range, typography, padding and multiline wrapping. Ordinary inline spans, linked text and button captions retain their baseline. Scrolling or resizing does not replace the editor or lose its draft.
- Original nodes, mixed inline markup, listeners and live input values remain unchanged before Save. The source Text node, child index, original value, structural identity and canvas base are frozen; same-text replacement does not silently redirect an edit.
- A copied inline parent's neighboring content can change without changing the selected node. The editor detects that case, withdraws the misleading preview and retains a read-only draft. A separate targeted long-parent recovery probe, outside the 71-check canvas suite, verifies that the active draft starts within the recovery viewport, its wheel scrolling does not move the original Board, the complete draft can be selected, and cancellation preserves original node/HTML/scroll state.
- IME composition protects completion and Escape. Real input probes cover ordinary spaces versus explicit nonbreaking spaces, native undo/redo, consecutive Enter presses and intentional trailing newlines. The implementation retains plain-text paste and blocks formatting/drop actions from introducing rich markup; these tests did not exercise the operating-system clipboard.
- Copied hyperlinks and form targets are neutralized. Draft input, keyboard and focus events are isolated from authored handlers. Normal authored controls remain native outside editing mode.
- A changed canvas or source refuses stale submission. Pending and uncertain edits preserve the exact request. Confirmed refusals preserve a copyable draft and allow cancellation. The normal host Save surface has no second text field.
- Simple SVG text keeps the authored SVG target through semantic save and cold replay. This is not a claim of complete SVG typography fidelity.

Targeted evidence retained alongside the final clean suite includes `inline-focused-complete.log`, `recovery-scroll-probe.json`, whitespace/newline/undo probe receipts and `review-ready.json`. The final clean suite covers the runtime after the narrow recovery-scroll correction; earlier intermediate passes are not substituted for it.

## Local installation

The successful installation receipt is `install-1793485901671-9bf792.json` (SHA-256 `03cebc11f41ed14f139f96d6d17845678e7b95eafc3aa9f118c4582200556cc1`). It records the exact verified source, all 120 tracked plugin files, persisted-state comparisons and the real worker lifecycle.

The retained installation path is `~/.paseo/local-plugins/paseo-board/dev`. Backup: `~/.paseo/backups/paseo-board-inline-text-1793485901671-9bf792`. The backup includes the previous source/runtime and state needed for explicit recovery; no older Board data was restored during this installation.

All five Boards present at installation and their saved state were preserved. Fresh activity/inventory checks preceded the plugin-only replacement, exactly two worker children were verified afterward, and the shared daemon was not restarted. The first attempt had stopped before mutation because its expected inventory had only four Boards and a fifth Board had appeared. The successful attempt refreshed the inventory and backed up the current five-Board state instead of discarding the new Board.

The plugin inventory reported `running`. No new compilation or startup error was observed. During the plugin-only stop/start, one `agent.turn_ended` lifecycle hook logged `Plugin stopped: paseo-board`; the plugin subsequently logged `Plugin ready`. A pre-existing Codex history-resume error about output exceeding 134,217,728 bytes appeared again after startup and also predates this installation. The logs are therefore not described as empty or entirely error-free; that earlier history issue is outside this editor change.

## Native acceptance unavailable

The private native receipt `native-acceptance.json` records `status: unavailable`. CUA inventory showed Paseo running but exposed no usable window or browser. Selecting the app by `sh.paseo.desktop` and by its complete application path both returned `cgWindowNotFound`; `launch_app` was unavailable in that environment. No input was dispatched for this iteration's native save, cancel or reopen checks, and no native acceptance screenshot was captured.

The build is installed for user testing, with clean browser, worker and installation evidence as described above. Prior native walkthroughs in the component-editing and feedback-fix reports remain historical records for their stated commits. They do not establish native acceptance of this runtime.

## Retained failures and corrections

- `browser-first.log` caught a wider initial text range: `plaintext-only` changed collapsed whitespace behavior despite matching font styles. The editor now preserves untouched wrapping and applies controlled editable whitespace handling.
- `browser-second.log` caught an ordinary trailing space becoming a nonbreaking space. The corrected input path preserves ordinary spaces and explicit NBSP independently, including undo/redo and real line breaks; it does not globally replace NBSP characters.
- `browser-third.log` encountered a missing fixture target during a click; `browser-fourth.log` timed out waiting for the appended fixture while the previous editing/selection lifecycle was still active. The fixture lifecycle was corrected, and the final pinned suite reran the real assertions.
- An integration monitor timed out waiting for the final review receipt. That monitor did not install or mutate source/data; the completed review and matching hashes were required before the successful clean run.
- The first installation preflight stopped on the newly changed Board inventory before source or data mutation. A fresh inventory and backup preceded the successful installation.

These retained failures are distinct from the environmental native-window limitation. The final clean and installation receipts report successful completion after their respective corrections.

## Remaining limits

Edits affect one direct text run at a time. A changed run must be completed or cancelled before switching runs. Rich formatting and simultaneous changes to multiple runs are outside this change. The isolated draft can grow or wrap locally, but does not reflow the entire original page before Save.

Visual copies have node, time and byte budgets. Large formatting contexts and unsupported structures may conservatively refuse direct editing. Complex SVG transforms, text paths, multi-position tspans, gradient/pattern paint and arbitrary layered backgrounds are not claimed to match an editable overlay exactly.

An uncertain host save survives Board-view remount within the current host JavaScript session, not a full application restart. Its committed server receipt is independently durable. No cross-device, physical-mobile or native UI acceptance of this iteration is claimed.
