# Hidden animation capture verification — 2026-10-30

The reported selection failed because an SVG animation inside closed details retained nonzero layout boxes. The capture planner included those hidden descendants and rejected their animation as a selected-content mutation. The same saved document, project tab, fold state, viewport and selection reproduced the failure; the previous direct-tab acceptance did not exercise that paint state.

## Change

Capture planning distinguishes suppressed subtrees from layout boxes. Closed-details content, display:none descendants and content-visibility:hidden descendants no longer invalidate unrelated selected pixels. The first summary, the content-visibility container itself, display:contents descendants and visibility overrides remain protected. Visible SVG/CSS rendering references retain their hidden dependencies recursively. Navigation hrefs, data attributes and unused custom properties do not create paint dependencies. Allowed outside mutations still trigger a final visible normal/pseudo-style check, retaining rejection of indirect :has() effects, geometry changes and revealed content.

Capture cancellation, selection identity, immutable send/retry payloads and the early composer remain unchanged. The fix does not pause arbitrary author JavaScript.

## Evidence before integration

- Independent source review and 15 paint/dependency boundary probes passed; no new blocker in the scoped fix.
- Actual BoardView test wrapper: 33 real Chromium scenarios passed, including right-click/region selection with closed-details and hidden-tab animation, real PNG arrival, continuing rAF, retained text/focus/caret/frozen anchor, zero sends, and real visible-content mutation rejection.
- Canvas browser integration: 50 scenarios passed. TypeScript, capture geometry/pixel, nested scrolling, fresh Canvas/WebGL, complexity and cancellation checks passed.
- Saved-user-document replay returned a PNG in 121 ms at the original viewport/scroll/fold state, with no browser/runtime errors. This is isolated Chrome timing, not native latency.
- Local single-run 8/32-section measurements: small crops 151/207 ms, large crops 759/851 ms; large-fixture longest tasks 77/81 ms. These are not statistically controlled performance claims.

## Retained failures and limits

Original failure evidence and all unsuccessful test runs are retained privately. New geometry fixtures initially mixed their paint-scope assertions with known font-size normalization differences. Inspected diffs isolated the text; geometric assertions now use colored shapes with stricter tolerances, while dedicated font/SVG-path tests remain. A host region fixture initially started on a native input; it now proves a non-editor hit target before the trusted Alt-drag, preserving native editing semantics.

A separate pre-existing html-to-image limitation remains: SVG use-instance inherited fill can be flattened to the referenced source computed default. Independent baseline/candidate native/capture PNG pairs were byte-identical, proving no new regression. Explicit-source-fill and actually visible gradient fixtures validate dependency retention, but do not fix or claim complete SVG-use inheritance fidelity. DOM reconstruction remains best effort for arbitrary browser painting. Genuine changes to selected visible content can still refuse a screenshot.

## Delivery

- Integrated source `dda6726` passed TypeScript and 228 tests in 15 files, 33 host and 50 canvas Chromium scenarios, client build and Hermes. A clean archive rebuilt the identical bundle: SHA-256 `05374df4222dc2d74995a81a55ca55179eec6371d328e367ee17b9c5f195ab9e`.
- Backed up and installed `5fbd58e261e196a57ee431cf56f6e4b6de001def` into the retained `~/.paseo/local-plugins/paseo-board/dev` directory on the primary Paseo 0.14.0 daemon. All 88 tracked files matched, the original three Boards retained their canvases and saved state, and daemon/worker identity stayed unchanged. Only this plugin was cycled. Source-only recovery instructions and the separate data backup were retained; no old user data was restored.
- Native Paseo acceptance reopened the actual development Board in the project tab, with play closed and realtime open. A region gesture at the displayed document origin (64, 390), approximately 884×298 CSS pixels, produced an actual matching PNG covering the folded summaries and realtime header, with the attached-screenshot confirmation. Right-click on the realtime header also produced the matching PNG. Inputs were focused, cancelled without sending, and references cleared. The canvas and saved state still exactly matched the stopped-install checkpoint.
- The native Board scrolled on reopening to an unread update. The document region/fold state above were verified from the displayed coordinates and pixels; exact original viewport/scroll replay is separately covered by isolated Chrome. Native screenshots were observed in the CUA transcript; this report does not claim a saved native screenshot file, precise native timing, injected native faults or live hidden-animation instrumentation.
- No fixture agent, Board or workspace was created for this client-only fix. Authorized main publication and exact remote/install confirmation use the bounded release job; its outcome is recorded in the private release receipt after the push.

Private evidence is under `~/.paseo/verification/paseo-board/capture-change-20261030/`: `runtime-delivery.json`, `host-delivery.json`, `audit-delivery.json`, `combined-latest.json`, `install-1793416623317-3b874b.json`, `native-after-observation.json` and the eventual `release-final.json`. Backup: `~/.paseo/backups/paseo-board-capture-hidden-fix-1793416623317-3b874b/`. User HTML, saved state and images are not committed to the public repository.
