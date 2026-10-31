# SVG screenshot validation and failure diagnostics

## Problem and correction

A selected region containing an unchanged SVG path could fail screenshot generation. The capture planner retained the browser's computed `d` value, while the clone library supplied an equivalent serialized path string to the validation callback. Comparing those two representations incorrectly reported a style mutation. Fractional font sizes had a similar normalization boundary.

The vendor callback now supplies the original computed value separately from its serialized output. Validation compares the original value with the frozen plan; clone output retains the existing serialization behavior. Actual CSSOM path changes, layout/content changes, cancellation, timeouts and complexity bounds remain enforced.

Capture failures now carry one of six bounded reason categories with the existing selection ID and frozen anchor. The host shows a specific Chinese explanation. Arbitrary error text is not transported. Existing guards prevent cancelled or late captures from changing a newer draft or an already submitted/retried reference.

## Verification

- Integrated source `9b211100d91ce965294c9024ab6d252f77aa6801`: TypeScript, 228 source tests in 15 files, 31 host-browser scenarios and 50 canvas-browser scenarios passed.
- Client build and Hermes compatibility passed. A clean archive with `npm ci --ignore-scripts` produced a byte-identical bundle: SHA-256 `3a4574253e7be28670df3978e1ba3c446faf83d1fc95221bd7e2a8fa46abf4e1`.
- SVG regression covers attribute paths, pattern/defs paths, CSS paths and fractional fonts. The SVG-only geometry crop had zero differing pixels against the native Chromium screenshot. A real CSSOM-only path change after freezing still rejected the capture.
- Existing clipping, scrolling, overlays, fresh Canvas/WebGL, complexity, cancellation and unrelated-animation checks passed. Local 32-section measurements were about 210 ms for the small crop and 790 ms for the large crop; these single runs are not a statistical benchmark.
- Replaying the saved failing authored document, ordered patches and saved state produced a PNG in about 1.95 seconds with no renderer errors. This is an isolated renderer result, not native Paseo latency.
- Runtime `8289c8ddfc3da322ace6eedb7681ecd8d223bdda` was backed up and installed in the retained directory on the existing primary Paseo 0.14.0 daemon. All 87 tracked files matched. The three original Boards retained their canvas and saved state, and daemon/worker process IDs were unchanged.
- Native Paseo acceptance opened the retained development Board after installation. Right-clicking the existing sketch and selecting its full region each displayed a correct PNG preview and the attached-screenshot confirmation. Both blank composers were closed with Escape; no test message was sent. Persisted canvas and user state still exactly matched the installation checkpoint.

## Evidence and limits

Private evidence root: `~/.paseo/verification/paseo-board/capture-pending-20261030/`.

- Original failure: `reproduction-result.json` and its retained replay harness.
- Fixed renderer: `fixed-result.json`, `fixed-capture.png`, `fixed-native.png`, `style-fix-geometry.json`, `style-fix-performance.json`.
- Combined checks: `combined-1793415531134749000/receipt.json` and individual logs.
- Installation and backup provenance: `install-1793415615427-22c048.json`.
- Native observation: `native-after-observation.json`; screenshots were inspected through CUA in the task transcript. Private Board content and screenshots are not committed.

Native behavior was observed, not precisely timed. Failure-category/cancellation fault injection belongs to isolated Chromium tests. No new agent tool or server API was introduced, so this change did not create a new daemon MCP fixture. The historical user interaction had geometry but no image bytes; it was not rewritten with a later screenshot. The unrelated direct-manipulation canvas remains a local prototype, not a generic editor capability.

Authorized main publication is the remaining release step; its exact commit and installed-file comparison are recorded in the private `release-final.json` receipt.
