// The export page schema of the 4b94741 plugin, copied literally (server/inbox-sync.ts PageSchema with
// shared/inbox.ts InboxExternalCommentSchema and shared/contracts.ts IdSchema at that commit).
// An old plugin parses a new runtime's v1 export with exactly this; tests use it to prove compatibility.
import { z } from 'zod';

const IdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.:-]+$/);
const TimestampSchema = z.string().datetime();
const LegacyExternalCommentSchema = z.object({
  externalId: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(8_000),
  authorName: z.string().trim().min(1).max(160).optional(),
  createdAt: TimestampSchema,
  pageUrl: z.string().max(2_000).url().refine(value => /^https?:\/\//.test(value), 'Comment page URL must use HTTP or HTTPS').optional(),
  anchor: z.object({ label: z.string().max(200).optional(), selector: z.string().max(500).optional() }).strict().optional(),
}).strict();
export const LegacyInboxPageSchema = z.object({ deploymentId: IdSchema, cursor: z.string().min(1).max(500), nextCursor: z.string().min(1).max(500), comments: z.array(LegacyExternalCommentSchema).max(100) }).strict();
