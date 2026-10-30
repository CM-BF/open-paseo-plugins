/** Public import projection. Source paths, credentials and configuration stay on the owning host. */
export type CompanionImportSourceKind = 'hermes' | 'openclaw';
export type CompanionImportCategory = 'personality' | 'memory' | 'skills' | 'bots' | 'connections' | 'automations';
export type CompanionImportBotPlatform = 'telegram' | 'discord' | 'feishu' | 'wecom' | 'dingtalk';

export interface CompanionImportSource {
  id: string;
  kind: CompanionImportSourceKind;
  name: string;
}

export interface CompanionImportEntry {
  id: string;
  category: CompanionImportCategory;
  name: string;
  description?: string;
  selected: boolean;
  /** Source was paused: importing it must never enable it. */
  enabled?: boolean;
  dependsOn?: string[];
  /** Alternative entries that supply different values for the same variable. */
  exclusiveWith?: string[];
  /** An explicit compatibility problem, never silently discarded configuration. */
  issues?: string[];
  /** `bots` only: messaging platform of the source bot. */
  platform?: CompanionImportBotPlatform;
  /** `bots` only: inferred owner id on that platform; alternatives differ only by owner. */
  owner?: string;
}

export interface CompanionImportPreview {
  id: string;
  source: CompanionImportSource;
  name: string;
  avatarImageBase64?: string;
  entries: CompanionImportEntry[];
  /** Host understands compact immutable preview-index ranges. */
  selectionRanges?: true;
  /** Host accepts bounded selection uploads through the existing import action. */
  selectionChunks?: true;
}

export interface CompanionImportSelection {
  previewId: string;
  /** Stable across retries and remote reconnects. */
  requestId: string;
  name: string;
  avatarImageBase64?: string;
  entryIds: string[];
  /** Inclusive preview-index ranges, only when advertised; mutually exclusive with entryIds. */
  entryRanges?: Array<[number, number]>;
  takeover: boolean;
  /** Save first; connection checks and source handover continue from the teammate chat. */
  deferSetup?: boolean;
}

export type CompanionImportSubmission = CompanionImportSelection | {
  selectionChunk: { id: string; offset: number; total: number; text: string };
};
// Even worst-case JSON escaping stays below the existing 64 KiB action budget.
export const COMPANION_IMPORT_SELECTION_CHUNK_LENGTH = 8 * 1024;
export function* companionImportSubmissions(selection: CompanionImportSelection, chunked = false): Generator<CompanionImportSubmission> {
  if (!chunked) { yield selection; return; }
  const text = JSON.stringify(selection);
  if (text.length <= COMPANION_IMPORT_SELECTION_CHUNK_LENGTH) { yield selection; return; }
  for (let offset = 0; offset < text.length; offset += COMPANION_IMPORT_SELECTION_CHUNK_LENGTH) {
    yield { selectionChunk: { id: selection.requestId, offset, total: text.length, text: text.slice(offset, offset + COMPANION_IMPORT_SELECTION_CHUNK_LENGTH) } };
  }
}

export interface CompanionImportCheck {
  entryId: string;
  status: 'copied' | 'verified' | 'needs-attention' | 'taken-over' | 'paused';
  message?: string;
  /** Fully written parts before an item failure; absent for old receipts. */
  progress?: { saved: number; total: number };
}

export interface CompanionImportResult {
  requestId: string;
  botId: string;
  canonicalSessionId?: string;
  status: 'running' | 'complete' | 'needs-attention';
  checks: CompanionImportCheck[];
  /** The companion and selected content have finished their save pass. */
  saved?: boolean;
  /** Saved definitions/content, independently of later authorization and activation. */
  savedEntryIds?: string[];
}

