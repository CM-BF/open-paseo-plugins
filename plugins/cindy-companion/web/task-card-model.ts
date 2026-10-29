export type { CompanionTaskCardView } from '../shared/task-card';
export interface CompanionTaskCardActions {
  open(): void;
  stop(): Promise<void>;
  resume?(): Promise<void>;
  note(text: string): Promise<{ delivery: 'queued' | 'sent' | 'unknown' }>;
  openFile(path: string): Promise<void>;
}
