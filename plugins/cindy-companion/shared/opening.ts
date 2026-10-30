import { z } from 'zod';

export const OPENING_KIND = 'preset-opening';
export const openingSchema = z.object({
  botId: z.string().min(1).max(100), name: z.string().max(200),
  greeting: z.string().max(16000), options: z.array(z.string().max(200)).max(4),
});
export type OpeningData = z.infer<typeof openingSchema>;
export interface OpeningStatus { available: boolean; selected: boolean; uncertain: boolean }
