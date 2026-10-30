import type { RuntimeState } from './contracts';

/** Native loading is reported separately from saving the original SKILL.md. */
export interface CompanionSkillDocument {
  slug: string;
  name: string;
  description: string;
  body: string;
  updatedAt: string;
  enabled: boolean;
  source: string;
  revision: string;
}
export interface CompanionSkillMetadata {
  slug: string;
  enabled: boolean;
  revision: string;
  bytes: number;
  editable: boolean;
}
export type CompanionSkillMutation =
  | { kind: 'save'; operationId: string; slug?: string; name: string; description: string; body: string; expectedRevision: string | null }
  | { kind: 'source'; operationId: string; slug: string; source: string; expectedRevision: string | null }
  | { kind: 'enabled'; operationId: string; slug: string; enabled: boolean; expectedRevision: string }
  | { kind: 'delete'; operationId: string; slug: string; expectedRevision: string };
export interface CompanionSkillReceipt {
  operationId: string;
  slug: string;
  kind: CompanionSkillMutation['kind'];
  revision: string | null;
  enabled: boolean | null;
  /** Saving does not assert that an existing provider session has reloaded. */
  runtime: { status: 'pending'; reason: 'native-loading-unverified' };
}
export interface CompanionSkillMutationResult extends CompanionSkillReceipt {
  /** Current application attempt; intentionally separate from the immutable stored receipt. */
  application: RuntimeState | { state: 'pending'; code: string; message: string };
}
