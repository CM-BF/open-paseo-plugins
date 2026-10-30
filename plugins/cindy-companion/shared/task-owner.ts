import { z } from 'zod';

export const taskOwnerSchema = z.object({ owner: z.object({
  botId: z.string().min(1).max(100), name: z.string().max(200), avatar: z.string().max(2_000_000), avatarColor: z.string().max(100),
  taskId: z.string().min(1).max(100), responsibility: z.enum(['owned', 'released']), canonicalSessionId: z.string().max(100).optional(),
}).strict().nullable() }).strict();
export type TaskOwner = NonNullable<z.infer<typeof taskOwnerSchema>['owner']>;
