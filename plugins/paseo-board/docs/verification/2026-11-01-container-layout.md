# Container layout verification

Runtime `cfecb224a2786eaa46837a03a3009f68e26e6d8c` passed clean verification, was installed on the primary Paseo 0.14.0 daemon, and passed actual Web UI acceptance for contents folding, bounded scrolling, grouped folding and restoration. The feature remains on the review branch; plugin main is unchanged.

The [layout controls](../container-layout.md) extend existing selected-component editing. Users preview a draft, adjust its height by input or drag, and commit through the host Save/Cancel card. The same bounded semantic operation validates authored source, transforms live nodes and replays a static publication. Viewing state is separate from authored layout.

## Clean pinned verification

All 20 commands passed from a clean Git archive, including dependency installation, TypeScript, 390 source tests in 31 files, both artifact rebuilds, Hermes evaluation and actual production Helper packaging. The temporary clean build tree was removed.

| Chromium scope | Passed checks |
| --- | ---: |
| Existing BoardView interaction | 38 |
| Dashboard synchronization | 9 |
| Component-edit host review | 13 |
| Durable contextual drafts | 14 |
| Single-row toolbar | 3 |
| Isolated Modal drawers and creation | 3 |
| Native Modal fallback adapter | 2 |
| Standalone release viewer | 7 |
| Publication host UI | 12 |
| Complete canvas regression, including 13 layout checks | 89 |

This is 190 browser check executions, with repeated scenarios across scopes. Host fixtures adapt Paseo transport and UI primitives; the native Modal fallback is a browser adapter. These results are not 190 native-device tests or additional remote GitHub publications.

| Committed artifact | SHA-256, identical after clean rebuild |
| --- | --- |
| `server/assets/store-worker.txt` | `8b9868d015c667ff0ad65c9e589cb305ea407c63038afb27dfd925cf649d2034` |
| `client/hermes-bundle.js` | `ace67a6349cbe7fc33c320cd4b1851bde3ef5c455d8bacf5cde89061e8360b84` |

Production-only preparation used the installed compiler and actual production Helper. Exactly two worker children handled real IPC, including guarded text/move/copy, a bounded layout commit, materialized replay and an identical layout retry without another patch. The same packaged path created an editable copy and fixed export/ZIP without GitHub access. Closing the isolated pool reaped both children and released its ownership lease.

## Layout coverage and boundaries

The source and real-browser checks cover:

- Trusted selection, preview, resize drag and Save/Cancel; inert preview copies; original heading/child order, input, caret, listener and runtime identity; exact restoration of owned styles.
- Heading-free summaries, containers with authored height/min-height, nested folds and scrolling, repeated configuration and cold journal replay.
- Grid/flex placement and desktop-to-420px bounds, including content-box and border-box zero bases and the common zero-percent flex shorthand.
- Explicit refusal for unsupported native details, table/control and SVG structures; stale same-ID replacement; genuine hierarchy selection without invoking author click handlers.
- Refusal to dismantle managed summaries, bodies, headings or other structural slots; permitted complete-group movement followed by restoration, and permitted ordinary content movement through contents bodies.
- Author-only and stale whole-state saves preserving current disclosure preferences alongside author state. Static exports omit private source viewing state, start an independent visitor state and retain visitor folds through reload.

The operation uses a bounded computed placement snapshot. It does not reconstruct arbitrary stylesheet child selectors or every responsive rule. Preview remains necessary for complex author layouts. An existing managed subtree must be restored before copying. Layout supports ordinary HTML containers; an author may select an ordinary inner container when its surrounding special content model is unsupported.

## Primary-daemon installation

The installer backed up the previous source, state, settings and runtime, rechecked current activity, and installed all 165 tracked files from the verified revision. All seven current Boards retained their titles, canvas, saved state and feeds. Exactly two live worker children used the expected artifact.

The primary daemon and its daemon-worker process identities were unchanged. No daemon restart or data/settings rollback occurred. A second shutdown/restart cycle on the main environment was omitted; worker reaping and lease-release acceptance comes from the separate isolated production Helper check.

## Actual Web UI acceptance

A private Chrome session opened the real `app.paseo.sh` application and connected to the primary daemon. An exact temporary section in a dedicated existing test Board bounded all layout operations. Selection and editing used trusted browser input, and Save/Cancel used the actual host review card; the driver did not call `board.edit` in place of UI actions.

Four checks passed before a compact observation failed:

1. Contents mode with a 180px height produced an actual preview; Cancel left source HTML, nodes, input and listener unchanged.
2. Real host Save committed the layout while retaining original nodes, typed input, runtime token and the working click listener.
3. Native disclosure open/close and a trusted wheel worked. The observed content scroll reached 220px, and the closed state was persisted.
4. A complete app-page reload reconstructed the saved layout and retained its closed state. Opening it exposed a working original author listener.

That run then completed the real host Save of a titled group with a 200px scrolling body and passed live identity assertions. It stopped at the next compact measurement, which reported an iframe viewport width of zero and a group width of 2px. The failed receipt and screenshots remain retained. They do not establish the precise mechanism of that transition.

The continuation used the exact saved group, bound its observations to the visible iframe owner, and required matching nonzero viewport geometry before inspecting it. No product change was made. It passed three additional checks: cold loading the saved group and its listener, compact geometry/native disclosure, and real host Restore. It did not replay already-successful saves.

At a 420×860 app viewport, the main canvas was 368px wide and the group was 310px wide, from x=29 to x=339, with a 200px scrolling body. Resizing back to 1440×900 preserved the same frame and document token. Both transitions retained the typed input. Restore removed the managed shell at the original position while retaining current nodes, input, heap and listener.

The final receipt has an unchanged interaction hash, zero agent messages sent and no exceptions in the final fixture frame. Screenshots of the actual host and canvas are private. This is actual main-daemon Web UI acceptance, not native App or physical-mobile acceptance.

Live Save/Restore retention and complete reload recovery are separate claims. A full reload reconstructs author code and restores saved layout/viewing state; these checks do not claim persistence of arbitrary unsaved author inputs or transfer of the old JavaScript heap.

## Retained failures and evidence

Early candidate failures exposed an unrepresentable JSON Schema field, missing managed identity parity/title handling, a dropped restoration marker in inert previews and flex basis/inset errors. Later review found structural transfer and reserved viewing-state boundaries. Those implementation issues were repaired before the pinned clean run.

Native select popup keys also failed in a blank independent headless Chrome page despite correct focus and no cancelled default action. The browser test uses verified native typeahead and observes trusted input/change at the exact select, including the non-composed change event. A separate harness failure tried to serialize a React iframe as a return value; the driver now returns a serializable observation. These test corrections did not relax the layout assertions.

The live automation also retained its initial connection-entry and iframe-focus failures. A successful host Save preceded the focus failure; subsequent evidence records the explicit continuation. The later compact/restore continuation resumes the saved group without repeating its successful saves. None of these retained attempts is presented as a single uninterrupted passing run.

Evidence below is relative to `~/.paseo/verification/paseo-board/container-controls-20261101/`:

| Evidence | Relative path |
| --- | --- |
| Pinned clean commands, hashes, artifacts and production Helper | `combined-1793571152180138000/receipt.json` |
| Backup installation, full inventory and daemon identity | `install-1793571417777-668d8e.json` |
| Final boundary candidate | `candidate-1793571047033043000/receipt.json` |
| Four passed live checks, successful group Save and retained compact failure | `actual-web-compact-failed/actual-web-receipt.json`, `actual-web-compact-failed/actual-web-test.mjs` |
| Three continued live checks and measured responsive transitions | `actual-web-receipt.json` |
| Earlier live driver failures | `actual-web-connect-entry-failed.json`, `actual-web-host-focus-failed.json` |
| Guarded source/state cleanup and readback | `actual-fixture-cleanup-receipt.json` |

The temporary section was removed through the public, version-guarded path. Persistent readback confirms that the final materialized authored HTML is byte-identical to the pre-test source; base HTML, shared data, original patch journal and interactions are preserved. Only the test fold key was removed from viewing state, leaving an empty reserved namespace and preserving the original author state. A fresh actual Web page also confirmed that the temporary section and managed wrapper were absent; `actual-web-cleanup-receipt.json` records that read-only observation.

Test HTML, private screenshots, Board identifiers and user data are not committed with this report. No new external publication of this layout was performed. Standalone layout export and visitor-state behavior are clean Chromium coverage; the earlier actual Pages publication has its own [verification record](2026-11-01-one-click-pages.md). Runtime code remained unchanged during the actual Web UI observation fixes. Documentation-only installed-file synchronization and draft PR #4 publication are recorded in the final release receipt; no plugin main merge is authorized by these checks.
