import { z } from 'zod';

const id = z.string().min(1).max(2048).refine(value => value.trim().length > 0);
/** Native source identities only. Timeline positions are hints, never message identities. */
export const dmMessageReferenceSchema = z.object({
  role: z.enum(['user', 'assistant']),
  providerMessageId: id.optional(),
  clientMessageId: id.optional(),
  turnId: id.optional(),
}).strict().refine(value => Boolean(value.providerMessageId || value.clientMessageId));
export const dmMessageSourceSchema = z.object({
  agentId: id,
  reference: dmMessageReferenceSchema,
  position: z.object({ epoch: id, seq: z.number().int().nonnegative() }).strict().optional(),
}).strict();
export type DmMessageReference = z.infer<typeof dmMessageReferenceSchema>;
export type DmMessageSource = z.infer<typeof dmMessageSourceSchema>;

export interface DmSourceSnapshot {
  botId: string;
  source: DmMessageSource;
  text: string;
  createdAt: string;
  /** These fields are not exposed by the current native timeline contract. */
  evidence: { projection: 'unmerged-native-message'; provenance: 'unavailable'; attachments: 'unavailable'; sealed: 'unavailable' };
}
export type DmSourceResult =
  | { status: 'available'; snapshot: DmSourceSnapshot }
  | { status: 'not-found' }
  | { status: 'limit'; reason: 'history-window' | 'message-size' }
  | { status: 'unavailable'; reason: 'history-error' | 'history-changed' | 'active-message' | 'invalid-page' }
  | { status: 'unsupported'; reason: 'native-history' | 'merged-message' };

/** Preserve opaque IDs verbatim; a colon in a native client ID is valid. */
export function dmMessageKey(source: DmMessageSource): string {
  const { reference } = dmMessageSourceSchema.parse(source);
  return JSON.stringify([source.agentId, reference.role, reference.providerMessageId ?? null,
    reference.clientMessageId ?? null, reference.turnId ?? null]);
}
