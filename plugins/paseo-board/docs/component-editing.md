# Direct component editing

This change extends the existing component inspector into an editing surface. The user can select an existing element, move it into another container, copy its structure, or edit text. Agent-authored HTML, CSS, scripts and existing publishing APIs remain available without a required component model.

Implementation and acceptance are in progress. This document describes the intended contract; it is not a test receipt.

## Interaction

- Hold Command+Shift on macOS, or Control+Shift on Windows/Linux, to preview the component under the pointer. Click to select it. Editable inputs keep their normal keyboard and selection behavior.
- The inspector shows the element's actual ancestors and children. Its move handle starts a structural drag. A target outline and insertion indicator show the destination; Tab/Shift+Tab change its containment level, and direction keys change the insertion position.
- Cut records a pending move without removing the source. Selecting a destination and pasting prepares the move. Copy/paste prepares a structural duplicate. The clipboard is internal to the current Board; it does not read or write the operating-system clipboard.
- Text editing preserves element structure. Leaf text and, where supported, individual direct text nodes can be changed without replacing sibling controls or inline markup. Escape cancels the draft.
- Drop, paste and text editing prepare a change. A compact host-owned Save/Cancel surface commits it; an authored iframe can propose an edit but cannot grant itself persistent write authority. This is the normal editing commit, not an agent-message or modal permission flow.

## Durable edits

The host freezes the displayed canvas base, operation and event identity. The authenticated user RPC runs through the same bounded worker pool and durable transaction machinery as other Board writes. A concurrent canvas change rejects the old base; it never silently adopts a fresh revision and overwrites the intervening change. An uncertain acknowledgement retries the exact original request.

Additive move, copy and text patches are replayed by both the authored-source reader and the live frame. A move relocates the existing DOM node rather than serializing and recreating it. Unrelated inputs, listeners and runtime state remain in place. Text changes carry an expected previous value. Root replacement, containment cycles and ambiguous targets are refused before committing.

Source and destination identities must resolve reliably in the persisted authored document. Unique authored IDs provide a stable target; anonymous elements need stronger structural evidence. Text changes in a live counter are not used as the identity of its whole containing component. A node created solely by script cannot be represented as an authored-source edit automatically; the UI reports this limitation instead of claiming a durable change. Its author can still change it with code or data.

Copying duplicates structure and remaps internal IDs/references. It does not duplicate JavaScript closures, attached event listeners, or arbitrary library instance state, and does not rerun copied scripts. External CSS selectors tied to the original ID may require author adaptation. Moving an existing component and duplicating its application behavior are different operations.

## Verification plan

Source checks cover revision conflicts, immutable retries, worker routing, invalid selectors, containment cycles, structural identity, mixed text, copied references and authored-source replay. Chromium checks cover held-modifier hover/click, normal inputs, drag cancellation and hierarchy choices, cut/paste, copy, text commit/cancel, listener/input preservation, host-only save authority, stale scopes and uncertain acknowledgements.

Final delivery also requires reproducible worker/client builds, packaged Helper startup, a backed-up local installation, and native testing on the retained interaction test Board. Only the existing feature PR is updated. Main remains unchanged until the user explicitly authorizes merging.
