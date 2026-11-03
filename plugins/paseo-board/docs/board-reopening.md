# Reopening Boards and restoring reading position

Desktop/web entries remember the selected Board when returning to an agent, workspace or Boards screen. Selection is scoped by host and entry, including the workspace and agent where applicable. An explicit **Boards** back action remembers the list instead. A direct link to a particular Board takes precedence, and a delayed host tab-state echo cannot undo a newer selection.

Reading position belongs to the host and Board, with the canvas document version attached. Reopening restores both document scroll axes, up to 32 identified nested scrolling areas, and the follow-updates preference. A visible content anchor helps retain the reading place when layout changes. Another host cannot inherit a position merely because its Board ID matches.

Restoration waits for startup and ordered patch replay, then applies once when the frame is visible and its geometry is ready. Missing or ambiguous nested targets are skipped. A genuine pointer, wheel or keyboard action cancels a pending restore so it cannot later pull the user away. A replacement document never receives the previous document's position. A saved position takes priority over the initial unread jump and does not itself mark updates seen; first visits and later explicit update navigation retain their usual behavior.

## Loading and fresh content

When the host's QueryClient still retains the Board, reopening can display that cached content before a required server read finishes. Inactive changes invalidate the affected Board without immediately downloading every inactive Board. Returning then reconciles current content; ordinary patches and data updates keep the displayed frame. Same-revision attention changes and a new server epoch also refresh correctly, while late responses from the previous epoch cannot replace newer authoritative content.

A recovered connection retries an affected failed read even when the event cursor has not changed, including when the old request fails after reconnection. Healthy unchanged checks do not repeatedly download the full Board. This is an in-memory content cache, not a durable offline copy of all Boards. A fresh application process or evicted cache still needs the server content.

## Local persistence and departure

Accepted position reports update local memory immediately. Ordinary position writes are coalesced on a 500ms browser-storage cadence; entry choices and follow-preference changes flush promptly. Page hiding and the last view's unmount also flush pending hints. These hints are separate from message drafts, authored `board.saveState()` values and publication requests.

Rapid switching can remove an iframe before its last position report is delivered. After authenticating the live frame's ready event, the host establishes a session-specific MessageChannel. An eligible departing frame can finish a persistence-only handoff for at most 250ms. A newer visit to the same host/Board revokes that old authority, and an old host's channel cannot write another host's position. Null-source window messages are not accepted as proof of frame identity.

The optional hint store is bounded to 64 records and 512KiB; older hints can be evicted. Browser-storage refusal falls back to current-process memory and does not block opening a Board. Clearing site data, changing browser/profile or losing that memory can remove recovery hints. Full-app native-mobile persistence is not claimed.

Reopening may create a new iframe and rerun authored initialization. This feature does not preserve an arbitrary JavaScript heap, animation phase or unsaved authored input across that replacement. Authors should use the [state API](../README.md#agent-interface) for controls that need explicit persistence. [Contextual message drafts](message-drafts.md) retain their separate recovery rules.

## Verification boundary

The current candidate passed TypeScript and frame-contract checks, nine canvas-view browser groups, nine reopening groups, and all 38 existing host checks. Separate focused runs passed eight unchanged-cursor reconnect cases and two old-port retirement cases. The browser fixtures use the real BoardHome, BoardView, query cache and sandbox runtime, with Paseo transport and native UI primitives adapted; they are not primary-daemon or native-app acceptance.

The held-read scenario verified that cached content became ready and restored both root and nested scroll positions before any held read completed, then reconciled fresh content without replacing that new frame. It also recorded that the prior iframe was actually destroyed. First-ready and restoration timings are reported separately and are not a general latency guarantee. Installation and actual primary-daemon Web acceptance for this candidate remain pending; see [PROGRESS.md](../PROGRESS.md) for subsequent delivery evidence.
