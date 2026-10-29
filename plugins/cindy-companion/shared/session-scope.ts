import { z } from 'zod';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
/** Issued by the host configuration path, never supplied as a tool argument. */
export const sessionScopeSchema = z.object({
  agentId: identifier,
  role: z.enum(['canonical', 'group', 'plan', 'routine', 'task']),
  groupId: identifier.optional(),
  planId: identifier.optional(),
  routineId: identifier.optional(),
  taskId: identifier.optional(),
}).strict();
export type SessionScope = Readonly<z.infer<typeof sessionScopeSchema>>;
