# Latest-state ingress and responsive selection

Approved scope: make arbitrary task data easier to deliver to arbitrary interactive HTML, and remove screenshot latency from the conversation entry path. This is not a workflow engine, experiment schema, or component framework.

## Data boundary

The existing store remains authoritative. A feed names one JSON Pointer and a source identity; the server tracks its generation and accepted sequence. `feed.set(value)` publishes an arbitrary latest JSON value. The producer helper retains one pending operation before sending it, retries that exact identity after uncertainty, and resumes it after restart. It does not fabricate a new sequence when acknowledgement is uncertain. Overlapping active paths conflict; explicit source replacement fences the old generation. A normal conditional edit to that same data path also invalidates a producer's old expectation.

Quiet is the default attention policy: the data persists and reaches the canvas without adding a navigation/highlight item for every progress tick. A meaningful milestone may request attention at actual rendering selectors. Existing publish/emit behavior is unchanged. Async-shell still owns process waiting and lifecycle; feed does not start or restart tasks, parse arbitrary logs, or wake agents.

`board.watch(path, render)` invokes an initial render and subsequent callbacks only when that selected value changes. It returns an unsubscribe function. Renderers receive isolated values and an existence flag, distinguishing missing data from JSON null. Legacy whole-data subscriptions remain compatible. Transport snapshots are still whole snapshots: this change reduces renderer work, not every serialization or store operation. High-frequency telemetry and append-only event history are outside this first version.

## Inspection boundary

`board_read` with `view:"inspect"` returns compact persistent status, bounded requested JSON paths, selected/recent interactions, source metadata and recent update locations. It omits historical PNGs and full HTML. An explicitly requested selector is statically replayed; values too large for the compact budget are explicitly omitted, and text excerpts are labelled truncated. Default full reads remain compatible and are still needed for complete edit context.

Neither form of read proves that arbitrary browser JavaScript rendered correctly. Live DOM, Canvas pixels and rendering exceptions require browser verification; stored success must not be described as observed visual success.

## Selection boundary

The host composer opens with the frozen text/geometry/version before the screenshot completes. The user may type and explicitly send without waiting for pixels. A late screenshot can only supplement the same still-unsent selection generation. Sending freezes its payload and destination, including any failed-send retry. Closing, canceling or selecting again prevents stale completion from reopening input or attaching another selection's image. IME, keyboard routing and original revision guarantees remain intact.

Capture optimization must reduce DOM/style work and bound uninterrupted main-thread work. DOM reads cannot run in a Web Worker; wrapping a synchronous clone in a Promise does not move it off-thread. A geometry-aware capture must preserve layout, ancestor backgrounds and visible overlays. When a complex scene cannot be captured within the budget, retain its text/geometry and explicitly report missing pixels; do not quietly present incomplete pixels as an exact screenshot. No native screenshot API or static-image cache is assumed without verifying host support and freshness.

## Acceptance

1. Concurrent producers retain separate paths; duplicate, stale-generation, stale-sequence and manual same-path conflicts cannot roll back accepted state.
2. Lost acknowledgement and helper restart retry exactly one saved pending operation; bounded failure stays visible.
3. Watches avoid unrelated renders and preserve controls; compact inspection is measurably smaller and keeps existing authorization.
4. A held screenshot cannot delay focused input, typing or sending; stale completion cannot alter sent requests or retries.
5. Measure baseline/optimized long documents, small/large selections and longest UI block. Verify cropping/overlays and cancellation, not only total duration.
6. Source and isolated Chromium checks precede installation on the primary daemon, fresh real MCP/producer acceptance and actual native UI inspection. Keep their evidence scopes distinct. Back up plugin data/source, preserve existing Boards, clean exact fixtures and publish main only after checks.
