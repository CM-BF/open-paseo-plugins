import { z } from 'zod';
import { dmMessageSourceSchema } from './dm-conversation';

export const DM_QUOTE_CONTEXT_ID = 'cindy-dm-quote';

/** Selection contains native source identity only; display text is resolved by the daemon. */
export const dmQuoteSelectionSchema = z.object({ source: dmMessageSourceSchema }).strict();
export type DmQuoteSelection = z.infer<typeof dmQuoteSelectionSchema>;

export const dmQuoteDisplaySchema = z.discriminatedUnion('status', [
  z.object({ version: z.literal(1), status: z.literal('available'), botId: z.string().min(1),
    source: dmMessageSourceSchema, excerpt: z.string().max(280),
    evidence: z.object({ projection: z.literal('unmerged-native-message'), provenance: z.literal('unavailable'),
      attachments: z.literal('unavailable'), sealed: z.literal('unavailable') }).strict(),
  }).strict(),
  z.object({ version: z.literal(1), status: z.literal('not-found'), source: dmMessageSourceSchema }).strict(),
]);
export type DmQuoteDisplay = z.infer<typeof dmQuoteDisplaySchema>;

/** Prepared data only. The host owns durable preparation, visible/wire separation and sending. */
export interface DmPreparedQuote {
  modelContext: string;
  displayData: DmQuoteDisplay;
}
