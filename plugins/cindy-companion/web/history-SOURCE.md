# Group history UI source and adaptation

This slice is based on makecindy/cindy commit
`118767c987f518286ae10a506a54287c3dc2a560`, under the repository's Apache-2.0
code license already included in this plugin. No new avatar, font, private user
history, or catalog data is included. Original source hashes and individual
changes are recorded in `history-upstream-files.json`.

Original files are retained byte-for-byte for `BotGroupQuote`,
`BotGroupThreadViews`, `BotGroupThreadHint`, `ThreadPanel`,
`useThreadPanelResize`, `ChatReplyIcon`, and `chatChrome`. The original
`ChatReactionButton` replaces its Electron roster call with the scoped Paseo
RPC adapter; its rendering and account-generation guards remain. The
`BubbleHoverToolbar` function is extracted unchanged with minimal imports.
Only two DOM identity constants are extracted from `shareConversationImage`;
image export is not included or claimed.

`group-history-actions.tsx` adapts the compact quote/topic/reaction/more markup
from `MessageActionBar` and `ChatServerControls`. `group-history-message.tsx`
keeps the previously extracted group bubbles and adds the original quote,
topic preview, shared-reply label/card, and reactions. `group-history-thread.tsx`
uses the original panel/resize components and the `ChatThreadPanel` /
`BotGroupComposer` thread layout, replacing Electron/Chat Server operations
with the contracts in `shared/group-history.ts`. Its independent Stop and
native-session entry preserve the existing Paseo exact-turn recovery boundary.

The host is authoritative for roots, quoted text, share sources, history
revisions, read/follow state, reaction actors, and execution status. No renderer
fallback fabricates a successful mutation or an empty successful history. Lost
acknowledgements retain the same intent identity. Thread reply + share is a
two-stage operation: a failed share can be retried without resending the reply.

Not completed by this slice: user file uploads, durable composer outbox,
multi-person cloud membership/synchronization, share-as-image export, and
private-chat native host slots. Thread drafts and retry identities survive
closing/reopening the panel in the same frame, but are not advertised as
durable across iframe/process reload. The fixed original thread composer
itself has no attachment, quote, or work-plan menu. Browser clipboard denial
is shown explicitly. These remain tracked work, not exclusions from the
requested full parity goal.

Verification here is focused React component/protocol testing and the plugin
TypeScript check. Full bundle generation, production host compilation,
installation, real RPC integration and visual comparison remain separate
integration gates owned by the main agent.

The review follow-up adds transport pagination without changing the original
bubbles: each response is budgeted against actual UTF-8 JSON bytes, full
message bodies remain intact, and `nextBeforeSequence` identifies the next
page. Main visible-ID reads drain every page before publishing a complete
projection; topic earlier-history controls follow the returned cursor.
Topic previews/summaries carry bounded excerpts and only roots in the returned
window; reply-to-main links are scoped to each page and merged in the panel.
Read-cursor writes validate the complete response inside the transaction, so
an oversized/invalid projection cannot clear unread state. Retrying a Stop
with the same intent can reconcile the same unknown round, while completed
or superseded rounds cannot affect later native turns.

The ordinary `groups.get` first/older page uses the same byte budget, so the
rich projection is not preceded by an oversized raw-message response. Native
control recovery calls the existing initialization fence directly; it is not
blocked by a history presentation size check. Extremely large pending-round
or cleanup metadata is still returned in full or explicitly rejected, not
silently shortened. Queue-metadata pagination and a complete thread pending
queue view remain tracked work; this slice does not claim those are complete.
