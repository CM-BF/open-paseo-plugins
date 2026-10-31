# Contextual message drafts

Desktop/web message drafts are stored in the current client's browser storage, separately for each connected host and Board. They include the text, frozen component/selection reference and available PNG, source discussion, composer position and any uncertain send's immutable intent ID and route. They are not part of shared Board data, agent prompts or publication exports until the user explicitly sends a message.

Closing the input with Escape, an outside click or **收起** keeps the draft. **草稿 N** reopens the collection; starting at another location creates another draft. **丢弃草稿** explicitly removes one draft. A successful server acknowledgement removes only its matching draft. A full page reload restores the most recently open draft; tucked-away drafts remain in the collection. Nothing sends automatically after recovery.

If a send response was lost, recovery compares the exact frozen payload with the Board's persisted interaction. A matching receipt opens the existing discussion without another send. Otherwise **重试原发送** retains the original intent and route. Editing its text creates a separate draft while keeping the uncertain original request available. A later receipt clears that original without replacing the new input.

Persistence is synchronous on each input change, before an RPC is sent, with a separate frozen reference record so the PNG is not serialized or rewritten for each character. Concurrent windows retain competing draft branches instead of silently overwriting one another. A store failure preserves the previous saved revision and the current in-memory input, shows an error and blocks desktop sending until the exact retry payload can be stored. An unavailable Board connection still allows local draft viewing and editing; reconnecting does not send it.

## Boundaries

- Storage belongs to this client/browser profile and origin. It does not synchronize drafts to another device, another browser or another host. Clearing application/site data removes local drafts. The plugin does not evict live drafts on a timer.
- Browser quotas and storage permissions apply. An error means the latest input is not yet safely stored; users can keep the page open, copy the text or discard an unneeded saved draft to free space. Removing a draft releases unreferenced screenshot storage. Damaged records remain untouched and are reported.
- A screenshot still being generated cannot be recovered after its frame is destroyed. The text and original selection survive with an omitted-image state; a new frame cannot impersonate the cancelled capture lease.
- This covers the message composer, not the separate component-edit Save transaction. The latter retains its existing session-scoped uncertain-save behavior.
- The current plugin SDK exposes no offline persistence service to Hermes/native mobile views. Those compatibility views report unavailable local persistence and retain their existing sending path; full-app native-mobile draft recovery is not claimed. Desktop/web runs the browser adapter.

## Verification status

Storage unit checks cover corruption, quota failures, exact scoped references, repeated text changes without PNG writes, concurrent windows, stale revisions and deletion races. Full-page browser recovery and integration acceptance are tracked separately in the current verification report and `PROGRESS.md`; implementation presence alone is not a passed native-client check.
