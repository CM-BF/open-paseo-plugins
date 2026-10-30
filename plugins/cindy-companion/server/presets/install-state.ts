import type { BotPackageIdentity, BotPackageOpening } from '../../shared/presets';
import type { CompanionImportResult } from '../../shared/vendor/presetImport';
import type { Routine } from '../vendor/scheduler/routines';

export interface PresetRoutineDraft { botId: string; data: Routine }
export interface PresetInstalledFile { path: string; sha256: string; skillId: string }
/** Private durable receipt: retry uses the same profile and item destinations. */
export interface SavedPresetReceipt extends BotPackageIdentity {
  locale?: string;
  result: CompanionImportResult;
  files: PresetInstalledFile[];
  routineIds: Record<string, string>;
  opening?: BotPackageOpening;
  createdAt: number;
}
