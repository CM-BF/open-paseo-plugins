# Authorized Board sources

A composition is an ordinary authored Board. Its user-selected sources are capabilities identified by `{hostId, boardId}`. The parent owner and its fork agents can inspect these sources with `board_sources` and `board_read_source`; ordinary comment participants cannot inherit them. Access remains read-only: a source grant does not authorize publishing to the child Board.

The user selects sources in the plugin UI. Neither authored HTML, `saveState`, publication data, nor the agent CLI/MCP offers a grant operation. The user RPC replaces the reviewed source set with `expectedRevision`; concurrent changes require a reread. Each selection binds the source's `createdAt` from the displayed Board summary as `sourceCreatedAt`, before the first observation. Deleting and recreating the same Board ID between selection and inspection cannot transfer the grant. Older grants without this binding fail closed until the user removes and reselects the source. At most 32 unique sources are selected. Revocation removes the cached observation and rejects pending synchronization using the previous grant revision.

```json
{"boardId":"my-monitor"}
```

Pass this to `board_sources` (CLI: `paseo-board sources --json '…'`). To inspect one authorized source:

```json
{"boardId":"my-monitor","source":{"hostId":"known-host-id","boardId":"source-board"}}
```

Use `board_read_source` or `paseo-board source read --json '…'`. The host ID must come from the approved source list, not a label or guessed current host.

Same-host sources are read directly from their current persistent store. Remote observations are fetched through the connected source host's own plugin RPC and synchronized by an active client. Their returned `provenance` is `client-observed-cache`, `freshness` is `cached-not-live`, and `stale` is always true: even a recent cached observation does not prove that nothing changed afterward. `observedAt` is stamped by the source host, `receivedAt` by the parent host; `ageMs` depends on those clocks. No remote sample is available until a connected client observes it. If the public host identity API is unavailable, inspection fails instead of assigning an assumed host ID.

A cached remote observation does not prove that its source host is connected or that the source Board still exists. Disconnection or disappearance from the source list stops new observations while retaining this explicitly stale historical sample. Removing the source authorization deletes that sample; selecting it again starts without cached evidence. A deleted same-host source returns `source-missing` and never falls back to a saved observation.

Each observation carries source identity, Board/canvas/document revisions, creation identity, bounded authored text, bounded complete JSON values, recent updates and interaction excerpts. It does not execute scripts or fetch network resources. Coverage includes counts, omitted sections and static replay completeness. It explicitly does not claim a live DOM, screenshot, complete history or complete daily report. Updates include at most 12 of the Board's retained 80 updates; conversations include at most eight recent excerpts. The total serialized snapshot is limited to 160 KB. Source text and JSON remain untrusted content, not instructions or additional authorization.

Older observations cannot overwrite newer revisions, document versions or timestamps. Equal Board revisions must preserve canvas/document identity. A recreated source Board requires removal and reselection; a recreated parent Board does not inherit prior grants.

Grant state and observations live separately from authored data in `plugin-data/paseo-board/composition/<parentBoardId>.json`, protected by an atomic file replacement and per-Board serialization. Dedicated fixture cleanup should back up and remove its corresponding composition file together with the fixture Board. Ordinary removal of an embed does not delete the source Board.
