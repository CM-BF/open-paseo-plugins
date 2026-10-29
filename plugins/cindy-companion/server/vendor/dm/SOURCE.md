# Private conversation background notes

Source: `makecindy/cindy` at `118767c987f518286ae10a506a54287c3dc2a560`.
`SOURCE.json` records each original blob, source hash, extracted-function hash and local file hash.

`buildBotDmThreadContextNote` and `buildReplyQuoteNote` are extracted without changing their function bodies. The original 4,000-character bounds are retained. Database imports and the Cindy-specific database readers are excluded: Paseo must resolve native message identities through its owned conversation boundary.

These builders are not yet attached to a native send. Their presence does not provide wire-only context, accepted-input quote metadata, source provenance, attachment metadata, or topic creation. In particular, a displayed or cached UI excerpt must never be supplied as authoritative source text. Unknown history or a bounded-search miss must not be converted to the builder's unavailable/deleted-source branch.

The adjacent `dm-message-source.ts` is a Paseo adapter. It reads fresh native history for a durably owned canonical conversation, verifies every supplied native ID and rechecks ownership after awaited reads. Paseo's current handler returns `projected` even when `canonical` was requested: only rows explicitly showing no collapsed kinds and exactly one source sequence are accepted. Merged text is unsupported, never silently treated as an original message. It reports the current public timeline's missing provenance, attachment and sealed-message evidence explicitly. It returns no topic-creation or tool authorization, sends no model input and writes no profile or native state. Topic sessions, source-backed sending, read positions and the original side panel remain separate integration work.
