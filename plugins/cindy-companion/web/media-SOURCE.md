# Group attachments, composer drafts and outbox

This adapted slice uses makecindy/cindy commit
`118767c987f518286ae10a506a54287c3dc2a560`. Code remains under the upstream
Apache-2.0 license already distributed in the plugin. `media-upstream-files.json`
records each original source SHA and the extraction boundaries. It introduces no
fonts, portraits, prompts, private conversations, or other non-code assets.

The original 56px attachment tray, file-card dimensions, message image/file order,
loading placeholders, document preview geometry, outbox bubble/failure controls,
and composer placement are retained. `file-type-tile.tsx` changes only its shared
import. Existing original `chatChrome` and `lightboxGestures` are reused. This is
an extracted browser slice, not a copy of Electron's file/cache/network runtime.

Files and pasted/dropped images use opaque host-owned uploads, fixed 393216-byte
chunks, SHA-256 sealing and whole-file verification before exposing a downloaded
Blob. Three uploads/downloads run at most concurrently. Limits remain 20 files,
100 MiB each; empty files are rejected by the original production rule. Upload
and cancel ACK loss retain the same identities. A close requested through the
plugin waits for pending cancellation and draft save; cancellation failure stays
visible. Browser/host forced removal cannot preserve unfinished File objects.

The parent app holds unsent drafts in a process-only Map keyed by host, group
and optional topic, with discard generation and monotonically ordered saves.
Text, tracked mentions, quote/work tag, completed immutable attachment metadata,
and retry identities survive iframe replacement within that app process. They
are not claimed to survive app restart. Topic replies stay text-only, as in the
original composer. This supersedes the earlier same-frame-only draft boundary
in history-SOURCE.md.

Main-group Send hands the exact immutable input to durable `groups.outbox` before
clearing the composer. Accepted queueing is distinct from native execution.
Lost enqueue ACKs are reconciled by exact client message ID, not by the latest
history page. A confirmed missing receipt can only replay the same original
enqueue identity. Failed-entry editing uses the server's atomic edit/retain
operation before restoring attachment references; an unknown entry cannot be
edited as a new dispatch. The parent draft Map records the exact edit operation
before that transfer starts. If its ACK is lost, a recovery action survives frame
replacement and replays that same edit receipt; a polled discarded row alone
does not confirm the transfer. Completed metadata restored from a draft retains
its real upload ID, so removing it also releases its staging reference.
Paging and polling preserve old pending receipts and
never roll back higher revisions. Division/quote/plan-note semantics remain in
the host's actual reception service, not a second frontend send implementation.

Native image/file model input is not connected in this wave. Its explicit
ATTACHMENT_INPUT_UNAVAILABLE state says attachments are saved in the group but
have not been delivered to the teammate's model. This is not complete model
attachment parity. Other remaining original functions include image annotation,
full image/OS context menus, native system file opening/location, editor syntax
modes, and multi-person cloud media synchronization. Download and safe browser
image/video/plain-text/Markdown viewing are implemented; none of these gaps is
removed from the requested full Cindy scope.

Validation is focused actual React component/bridge testing, byte/hash and ACK
recovery tests, and plugin TypeScript. Full final bundle generation, installed
host compilation, real attachment RPC/provider execution and visual comparison
remain separate integration gates. No generated settings HTML is updated here.
