# Incremental delivery and optional producer primitives

The accepted design keeps agent-authored HTML, JavaScript, data schemas and rendering libraries free. The plugin handles reliable delivery and avoids redundant work. It does not choose charts, own component lifecycles, force iframe isolation, or automatically improve an author's rendering algorithm.

## Scope

This implementation targets the host-to-canvas boundary, theme notifications, optional rendering cadence, optional latest-state producer coalescing and bounded ordered record ingestion. RPC polling and atomic whole-envelope storage remain. Measurements must distinguish wire payload, comparison work, callback count, browser drawing and persistence cost; no end-to-end streaming or universal latency claim follows from a smaller iframe message.

## Compatible frame updates

The iframe advertises its delta capability. Older loaded runtimes continue to receive complete snapshots. New runtimes receive a session-scoped transport version and an exact base (document version, Board revision and canvas revision). Same-document messages carry changed data paths, newly appended HTML patches and changed state/theme. Append-only arrays may carry their verified tail instead of the retained prefix. Removal, parent replacement and arbitrary JSON retain existing semantics.

A mismatched base, malformed operation or missing version requests a full recovery snapshot. Recovery must preserve the live iframe and JavaScript heap. Full document replacement retains its existing explicit reset semantics. No agent-supplied sequence or DOM component schema is added to authoring tools.

Capture/selection can hold displayed content while transport continues. The received baseline must remain separate from the displayed snapshot; later deltas must not mutate the frozen selection, lose queued HTML patches, or move the original reference. Exact duplicates and old versions are inert. Session/window checks apply to recovery messages too.

Path watches retain their initial synchronous callback and default synchronous updates. Only changed paths and their ancestors/descendants need comparison. Optional `board.watch(path, render, { schedule: 'frame' })` keeps the initial callback, then coalesces display work to the latest value per animation frame. Unsubscribe cancels pending work. This is display cadence, not an event log; accepted record history belongs in data or an explicit external history store.

Theme tokens and scheme are compared by value. Unchanged themes cause no CSS rewrite or theme event; a real change still updates authored consumers. Rendering decisions stay with the author.

## Ordered records

`createFeed({ ...config, mode: 'records', capacity: { maxRecords, maxBytes } })` explicitly selects record semantics. `feed.append(records, policy)` uses the same writer binding, generation, sequence, durable journal and immutable ACK replay as latest-state feeds. Normal `createFeed` / `set` remains latest-state behavior.

Each record is arbitrary JSON; the source path contains an ordinary retained array. Appending is atomic and ordered. An exact retry cannot double the batch. Manual same-path edits cause a conflict, and a superseded generation cannot resume writing. Reopening preserves compatible prior records rather than clearing them.

The initial default capacity is 10,000 records / 1,000,000 UTF-8 serialized-array bytes, with caps of 50,000 / 1,500,000; a batch holds 1–1,000 records and at most 256,000 bytes. Overall Board limits still apply. Capacity rejection occurs before mutation and reports limits/counts. No accepted record is silently evicted. External artifacts remain appropriate for histories that outgrow this bounded store.

## Optional latest-state coalescing

`createLatestWriter(feed, { delayMs })` is a separate helper for latest-state feeds. It retains one immutable submitted write and at most one replaceable staged value. It never handles record append or silently drops milestones.

`offer(value)` returns a disposition: committed with a real durable ACK, superseded before submission, or cancelled before submission. A staged value is volatile until submitted through the feed's existing durable journal. `flush`/`drain` waits for actual durable completion and exposes errors. Unknown writes remain fixed until exact retry; no later value overtakes them, and no generation is reopened automatically. The existing raw feed interface remains available when the helper is idle.

These contracts are implemented in the generated SDK, skill and README. The installed-runtime acceptance and its remaining limits are recorded in [verification](verification/2026-10-30-incremental-primitives.md).

## Required evidence

- Pure protocol tests for immutable deltas, unsafe paths, incorrect bases, append prefix changes and version recovery.
- Real renderer/host checks for unchanged-theme silence, real theme changes, selective watches, frame scheduling/cancellation, selection-held deltas, retained controls, document changes and recovery without remount.
- Measured full-vs-delta payload and callback counts on a representative large retained dataset; chart drawing time reported separately.
- Feed/store/producer tests for append duplicates, restart, unknown ACK, capacity, cross-writer/generation fencing and manual conflicts.
- Latest helper tests for frozen inputs, supersession, one-inflight/one-staged bounds, error/retry, drain and disposal races.
- Integrated typecheck, source and browser regressions, clean bundle/Hermes validation, actual installed producer/agent transport and native UI where available.
- Existing Board data/state backed up and preserved; only owned fixtures cleaned; no unrelated plugin or daemon restart.
