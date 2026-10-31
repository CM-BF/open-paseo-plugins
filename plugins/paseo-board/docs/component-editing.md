# Direct component editing

This change extends the existing component inspector into an editing surface. The user can select an existing element, move it into another container, copy its structure, or edit text. Agent-authored HTML, CSS, scripts and existing publishing APIs remain available without a required component model.

Implementation, clean integrated verification and native desktop acceptance are complete in the PR branch. The verified build is installed locally for testing. [Verification and limits](verification/2026-10-31-component-editing.md) record the tested revision and distinguish native observations from isolated browser checks. Main remains unchanged pending explicit merge approval.

## Interaction

- Hold Command+Shift on macOS, or Control+Shift on Windows/Linux, to preview the component under the pointer. Click to select it. Editable inputs keep their normal keyboard and selection behavior.
- The inspector shows the element's actual ancestors and children. Its move handle starts a structural drag. A target outline and insertion indicator show the destination; Tab/Shift+Tab change its containment level, and direction keys change the insertion position.
- Cut records a pending move without removing the source. Selecting a destination and pasting prepares the move. Copy/paste prepares a structural duplicate. The clipboard is internal to the current Board; it does not read or write the operating-system clipboard.
- Text editing changes an individual direct text node without replacing sibling controls or inline markup. The editor offers the component's text runs separately. Escape cancels the draft; Command/Control+Enter prepares it for the host Save control.
- Drop, paste and text editing prepare a change. A compact host-owned Save/Cancel surface commits it; an authored iframe can propose an edit but cannot grant itself persistent write authority. This is the normal editing commit, not an agent-message or modal permission flow.

## Durable edits

The host freezes the displayed canvas base, operation and event identity. The authenticated user RPC runs through the same bounded worker pool and durable transaction machinery as other Board writes. A concurrent canvas change rejects the old base; it never silently adopts a fresh revision and overwrites the intervening change. An uncertain acknowledgement retries the exact original request.

An uncertain save survives Board-view navigation/remount within the current host JavaScript session. It is not a disk-backed outbox across a complete app/page restart; restarting does not automatically resend it. The server's committed edit and receipt are durable independently.

Additive move, copy and text patches are replayed by both the authored-source reader and the live frame. A move relocates the existing DOM node rather than serializing and recreating it. Unrelated inputs, listeners and runtime state remain in place. Text changes carry an expected previous value. Root replacement, containment cycles and ambiguous targets are refused before committing.

Source and destination identities must resolve reliably in the persisted authored document. Unique authored IDs provide a stable target; anonymous elements need stronger structural evidence. Text changes in a live counter are not used as the identity of its whole containing component. A node created solely by script cannot be represented as an authored-source edit automatically; the UI reports this limitation instead of claiming a durable change. Its author can still change it with code or data.

Structural signatures include actual parent relationships, tag/ID, role, name and type, with a 2,000-element bound. Anonymous elements additionally require their serialized authored markup to match (up to 240,000 characters), so an inserted sibling cannot redirect a positional selector onto a different same-shaped element. These are bounds on direct editing, not on what agents may author.

Copying duplicates structure and remaps internal IDs/references. It does not duplicate JavaScript closures, attached event listeners, or arbitrary library instance state, and does not rerun copied scripts. CSS ID selectors are not rewritten, whether they come from an external stylesheet or a `<style>` element inside the copied component. A selector such as `#original-card .value` continues to target the original ID, so the copy may need author changes to preserve that styling. Moving an existing component and duplicating its application behavior are different operations.

A marker on an anonymous component follows that same live DOM node when the component moves within the current frame. After reopening the Board, that in-memory identity is gone. The existing patch journal does not provide enough revision evidence to prove that an old positional selector identifies the moved component, so cold recovery keeps the original frozen reference and reports an unavailable location or a verified ancestor rather than guessing. The captured anchor is never rewritten to suggest a new location. Unique authored IDs can continue to recover through the existing identity checks. This release does not migrate journal revisions or claim durable marker relocation for anonymous components.

Moves use the browser's state-preserving move operation when available, with an ordinary same-document move fallback that restores focused inputs and their caret. Older browsers may reset some embedded media/frame state on that fallback even though the element and its listeners are retained.

## Verification

The final clean source suite passed 288 tests in 21 files. Chromium passed 38 full host, 9 dashboard, 10 component-edit host and 64 canvas checks. These cover revision conflicts, immutable retries, worker routing, invalid selectors, containment cycles, structural identity, mixed text, copied references and authored-source replay; plus held-modifier hover/click, normal inputs, drag cancellation and hierarchy choices, cut/paste, copy, text commit/cancel, listener/input preservation, host-only save authority, stale scopes and uncertain acknowledgements.

Worker/client clean builds were byte-identical, Hermes passed, and the actual production Helper ran two workers with durable text/move/copy IPC and exact retry. A backed-up local installation preserved all four existing Boards. The native desktop walkthrough verified selection, text save, copy, delayed cut with cancel/save, a drag proposal and cancellation, preserved controls/runtime, and reopened persistence. Hover-only previews and drag hierarchy keys were verified in Chromium, not through the native automation tool. The existing feature PR remains the delivery route; main requires the user's explicit merge approval.
