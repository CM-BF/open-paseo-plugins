# Grouped comments

## Interaction

Add comments at several canvas positions with **加入待发送**. Open **更多 → 草稿** to review the pending list, edit text, remove a comment or submit all comments together. Keep the existing Board theme and ordinary single-send shortcuts.

Only explicitly queued comments join the group. Authored `board.ask` buttons can queue fresh comments too: their Promise resolves with `status: "queued"` once local persistence succeeds. That result does not claim agent submission or completion. Existing discussion replies and questions about an agent's response canvas retain their context through the single-send path.

Each entry retains a stable comment ID, text, captured Board/canvas revisions, location, binding when available and its PNG when capture succeeded. A still-pending capture can be omitted explicitly, preserving text and location. The list survives a page reload in desktop/web local storage, scoped to the host and Board. Native compatibility views without that storage do not claim durable grouped sending.

## One delivery, several locations

Sending freezes the complete ordered comment list, the chosen main/Side destination and one immutable intent before RPC. All comments reach one agent invocation as one set of modification requests. Images have explicit attachment numbers; comments without images consume no attachment number. Each comment remains independently locatable on the canvas while the discussion rail contains one group.

The group has one delivery and completion status. The agent is asked to address every numbered item and explain unresolved items; saving one canvas edit does not itself establish that every item is complete. Following up continues the group discussion. The follow-up retains one bounded snapshot of the original numbered comments and locations, so “comment 2” keeps its meaning across later replies. Identical PNGs share an attachment number; prior comments remain context rather than new requests to repeat.

For a Board task, visual explanations, diagrams and requested changes belong on the existing shared main canvas by default, starting with the first reply. The agent reads that Board and uses `board_publish`, then records the interaction result and gives a short conversational acknowledgement. A `board_respond` HTML response is a separate discussion canvas; it does not update the main Board. Use that separate canvas or an in-chat visual when the user explicitly requests it. Plain text explanations can remain in the assigned discussion, and unrelated chat does not become a Board task automatically.

## Persistence and limits

A group contains at most 20 comments, 24,000 combined comment characters and 6,000,000 combined PNG base64 characters. Existing per-image and Board-history limits remain in force. Local storage can be smaller than those payload caps; an unsuccessful save prevents submission and retains the draft instead of silently dropping screenshots.

Unknown responses keep the original intent, contents and route. Reopening does not automatically send. An explicit retry reuses that immutable request. A matching receipt retires only the captured draft revisions; later edits and new drafts survive. First-time preparation uses browser Web Locks so the same staged revisions cannot be claimed by two new batches. It verifies the exact ordered draft revisions shown when Send all was clicked; additions, edits or removals while waiting stop the send and ask for another review. Without Web Locks, new grouped sending is refused and direct single sending remains available; retrying an already saved intent still uses its original request.

## Authored comment anchors

`board.ask({prompt, anchor: element})` and `{prompt, anchor: {target: element}}` convert a connected authored element to plain location metadata. Existing plain anchors are validated and projected through their documented fields. The API never forwards an HTMLElement across `postMessage`; invalid location data returns a rejected Promise and leaves no pending ask timer.

## Verification status

The candidate on `sw/board-batch-comments` passed TypeScript and 463 source tests, plus 7 authored-comment and 11 grouped-comment browser checks. The earlier 14 draft and 38 host checks remain valid for the same product bytes. These use real browser input and the runtime/BoardView with adapted Paseo transport and host boundaries; they are not actual daemon or agent-behavior acceptance. See [the progress record](../PROGRESS.md) for exact receipts and retained failures. Fixed-commit full-suite checks, generated artifacts, packaging, installation and primary-daemon acceptance remain pending. The installed plugin and main have not changed for this feature, and the reporter's work computer has not been upgraded or verified.
