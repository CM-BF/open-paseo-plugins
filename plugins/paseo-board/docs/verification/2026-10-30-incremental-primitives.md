# Incremental primitives verification

The implementation at `d2f8b45e78d2a5dff518b0d5a080048c5226a0b3` was backed up and installed in the retained `~/.paseo/local-plugins/paseo-board/dev` directory on the existing primary Paseo 0.14.0 daemon. All 86 tracked files matched, generated producer/CLI/MCP/skill assets were checked, and the three original Boards retained their canvas and saved state. No daemon or unrelated plugin restart occurred.

## Delivered behavior

- Capability-negotiated, session-versioned host-to-frame deltas carry changed JSON paths, verified array tails and newly appended HTML patches. Incorrect or missing bases request complete recovery without rebuilding the iframe. Older frames retain full-snapshot compatibility.
- Watches compare affected paths, including ancestor/descendant relationships. Equal theme values cause no CSS rewrites or theme-change events. Optional `schedule: 'frame'` coalesces display callbacks; default callbacks remain synchronous.
- Optional records feeds accept arbitrary JSON batches in sequence. Exact retries replay the original durable ACK. Capacity rejects the entire overflowing batch, without silently evicting accepted records. Reopening retains compatible history and fences old generations; manual edits stop stale writers.
- Optional `createLatestWriter` retains one immutable submitted value and one replaceable volatile staged value. Each offer is committed, superseded or cancelled; unresolved writes require explicit matching retry. It does not coalesce records or milestones.

Agents keep arbitrary HTML, JavaScript, data semantics, chart libraries and layouts. No fixed component model or automatic optimization of authored rendering is introduced.

## Verification

| Layer | Evidence |
| --- | --- |
| Integrated source | TypeScript and 228 tests in 15 files passed |
| Real Chromium | 50 canvas and 29 BoardView scenarios passed |
| Build | Client build, static/Hermes evaluation, clean archive install and byte-identical rebuild passed |
| Actual producer processes | Seven checks passed for records/latest coexistence, coalescing, restart, exact replay, capacity, generation fencing and manual edits |
| Fresh real MCP owner | Three grouped checks passed in two turns; exact tool arguments/results and independent persisted state checked |
| Native Paseo | Records changed from 3 to 5 while input/focus and document boots remained stable; right-click question reached the same owner and its latest-data answer appeared |

The built bundle SHA-256 is `23988df3b214ae49fd13dba8135fc4e133f8758fb892446e40804dfd412fb53f`. The integrated source was verified on Node 24.20.0. Native input retained its exact text, watch callbacks changed from 1 to 2, document boots stayed at 1, and quiet append left unread locations at zero. The native question required actual `board_read(view: "inspect")`; the same owner returned all five records, sequence 3 and the exact previously unseen final nonce through `board_respond`.

Two failed live-fixture attempts remain as evidence. The first harness incorrectly required raw MCP `isError` in a provider-normalized timeline: actual canonical calls were failed with the correct structured refusal and unchanged records. The corrected parser requires failed status and exact error code/message/details, with 11 offline positive/negative checks. The second inexpensive model mistyped a random value in an expected rejected batch; exact argument validation correctly rejected the test. Only rejected probe values were shortened for the final fresh run; exact argument, ACK, complete data and unseen-nonce checks remained. Both failed owners and the successful owner were archived separately; no existing owner was archived.

## Measured scope and limits

A representative browser fixture transferred 2,048,909 bytes as complete data versus 343 bytes for one scalar delta and 395 bytes for a verified appended tail. These are message sizes, not chart frame rate, end-to-end latency or persistence throughput.

Upstream polling, host-side delta calculation, atomic whole-Board persistence and legacy full-data callbacks still involve broader work. Record arrays are bounded: defaults are 10,000 records / 1,000,000 serialized UTF-8 bytes; configured source caps are 50,000 / 1,500,000. Global canvas/envelope limits may reject sooner. External history is appropriate beyond these limits. Display coalescing may skip frames; it must not remove accepted records.

Lost-response recovery is fault-injected in source tests, not injected into the live daemon. Native desktop acceptance is separate from the isolated renderer's compact/two-theme and protocol checks. Smaller transport messages do not prove arbitrary authored code draws incrementally.

## Fixture cleanup and release

After acceptance, four exact fixture Boards were backed up and quarantined, and only their service-journal entries were removed while the Board plugin was stopped. The plugin was then enabled and verified running again. Public SDK operations archived the three exact fixture workspaces; their on-disk evidence remains available. The original three Boards retained their canvas and saved-state hashes, the existing owner was preserved, and primary daemon/worker process IDs were unchanged. No other plugin was changed and no older user-data snapshot was restored.

The publication checkpoint contains the tested runtime at `d2f8b45` plus documentation. The bounded release operation verifies installed tracked bytes, records the push result and independently confirms the exact GitHub main commit. Its private release receipt is the authority for publication success; this document records the completed acceptance and cleanup, not a predicted push outcome.

Private evidence lives under `~/.paseo/verification/paseo-board/incremental-primitives-20261030/`: combined source/build logs, install receipt, actual producer receipt, canonical MCP traces, parser regressions, native observations, finalization and release receipts. Screenshots and user content are not included in the public repository.
