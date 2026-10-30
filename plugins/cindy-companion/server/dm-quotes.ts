import { dmQuoteSelectionSchema, type DmPreparedQuote } from '../shared/dm-quotes';
import { chatReplyQuoteExcerpt } from '../shared/vendor/chatReplyQuote';
import { DmMessageSources } from './dm-message-source';
import { string, throwIpcError } from './errors';
import type { Paseo } from './runtime';
import { buildReplyQuoteNote } from './vendor/dm/chatReplyQuoteNote';

/** Canonical-conversation text quotes. This module neither sends nor changes instructions. */
export class DmQuotes {
  constructor(private readonly sources: DmMessageSources) {}

  async prepare(paseo: Paseo, targetAgentId: string, selection: unknown, signal?: AbortSignal): Promise<DmPreparedQuote> {
    const target = string(targetAgentId, 'target agent', 2048);
    const { source } = dmQuoteSelectionSchema.parse(selection);
    if (source.agentId !== target)
      throwIpcError('DM_QUOTE_DIFFERENT_CONVERSATION', 'A quote must belong to the conversation receiving this message');
    const result = await this.sources.read(paseo, source, signal);
    if (result.status === 'not-found') return {
      modelContext: buildReplyQuoteNote({ author: 'owner', text: null, available: false }),
      displayData: { version: 1, status: 'not-found', source },
    };
    if (result.status !== 'available')
      throwIpcError(`DM_QUOTE_SOURCE_${result.status.toUpperCase()}`, `The quoted message could not be prepared: ${result.reason}`);
    const { snapshot } = result;
    // Cindy's original database reader trims the message parts before the note builder.
    const text = snapshot.text.trim();
    // Native history does not expose original attachment names. Do not turn unknown names
    // into an assertion that an attachment-only source has no content or was deleted.
    if (!text)
      throwIpcError('DM_QUOTE_ATTACHMENT_METADATA_UNAVAILABLE', 'This source has no quotable text and original attachment names are unavailable');
    return {
      modelContext: buildReplyQuoteNote({
        author: snapshot.source.reference.role === 'user' ? 'owner' : 'companion', text,
      }),
      displayData: { version: 1, status: 'available', botId: snapshot.botId, source: snapshot.source,
        excerpt: chatReplyQuoteExcerpt(text), evidence: snapshot.evidence },
    };
  }
}
