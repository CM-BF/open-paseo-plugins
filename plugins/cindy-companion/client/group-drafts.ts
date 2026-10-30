import type { GroupComposerDraft, GroupDraftSnapshot } from '../shared/group-drafts';

type Entry = GroupDraftSnapshot & { sequence: number };
const drafts = new Map<string, Entry>();
/** Scope comes from the mounted frame, never from caller-supplied host identity. */
export function groupDraftRequest(scope: { host: { id: string }; view?: string; groupId?: string }, op: string, args: Record<string, unknown>): GroupDraftSnapshot {
  if (scope.view !== 'group' || !scope.groupId || args.groupId !== scope.groupId) throw new Error('This draft belongs to another group.');
  if (args.rootId !== undefined && (typeof args.rootId !== 'string' || !args.rootId || args.rootId.length > 256)) throw new Error('Invalid topic draft identity.');
  const key = JSON.stringify([scope.host.id, scope.groupId, args.rootId ?? null]);
  const old = drafts.get(key) ?? { generation: 0, sequence: 0, draft: null };
  if (op === 'paseo.groupDrafts.get') {
    const entry = { ...old, generation: old.generation + 1, sequence: 0 };
    drafts.set(key, entry); return { generation: entry.generation, draft: entry.draft };
  }
  if (args.generation !== old.generation) throw new Error('This draft was opened in another view. Reopen it before saving.');
  if (op === 'paseo.groupDrafts.discard') {
    const entry = { generation: old.generation + 1, sequence: 0, draft: null };
    drafts.set(key, entry); return entry;
  }
  if (op !== 'paseo.groupDrafts.save') throw new Error('Unknown draft operation.');
  if (!Number.isSafeInteger(args.sequence) || (args.sequence as number) <= old.sequence) return { generation: old.generation, draft: old.draft };
  const value = args.draft as GroupComposerDraft | null;
  if (!value || typeof value !== 'object' || typeof value.text !== 'string' || value.text.length > 16000 ||
    !Array.isArray(value.trackedMentions) || value.trackedMentions.length > 100 || typeof value.division !== 'boolean' ||
    !Array.isArray(value.attachments) || value.attachments.length > 20 || JSON.stringify(value).length > 200000) throw new Error('Invalid draft.');
  if (value.attachments.some(file => !file || typeof file.mediaId !== 'string' || !file.mediaId || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 100 * 1024 * 1024 || !['image', 'pdf', 'text', 'office', 'file'].includes(file.category) || Object.keys(file).some(key => !['mediaId', 'name', 'mimeType', 'size', 'sha256', 'category'].includes(key)))) throw new Error('Only completed attachment uploads can be kept in drafts.');
  if (value.pendingEdit && (!value.pendingEdit.clientMessageId || typeof value.pendingEdit.clientMessageId !== 'string' || value.pendingEdit.clientMessageId.length > 200 || !value.pendingEdit.operationId || typeof value.pendingEdit.operationId !== 'string' || value.pendingEdit.operationId.length > 200)) throw new Error('Invalid pending outbox edit.');
  const entry = { generation: old.generation, sequence: args.sequence as number, draft: JSON.parse(JSON.stringify(value)) as GroupComposerDraft };
  drafts.set(key, entry); return { generation: entry.generation, draft: entry.draft };
}
