import type { DmMessageReference, DmSourceResult } from '../shared/dm-conversation';
import { dmMessageSourceSchema } from '../shared/dm-conversation';
import type { CompanionStore, SavedState } from './store';
import type { Paseo } from './runtime';
import { HISTORY_BYTES } from './history-page';
import { throwIpcError } from './errors';

type Agent = ReturnType<Paseo['agents']['ref']>;
type Page = Awaited<ReturnType<Agent['timeline']['refetch']>>;
type Entry = Page['entries'][number];
type Cursor = NonNullable<Page['startCursor']>;
const MAX_PAGES = 8;
const PAGE_SIZE = 200;
function checkOpen(signal?: AbortSignal) {
  if (signal?.aborted) throwIpcError('DM_SOURCE_CLOSED', 'The message source view was closed');
}

/** This first read seam deliberately does not grant topic creation, quote sending or tool rights. */
function canonicalOwner(state: SavedState, agentId: string) {
  const owners = Object.entries(state.bindings).filter(([, binding]) => binding.agentId === agentId);
  if (owners.length !== 1) throwIpcError('DM_SOURCE_NOT_OWNED', 'This is not an owned teammate conversation');
  const [botId, binding] = owners[0]!, profile = state.profiles[botId];
  if (!profile?.enabled || profile.status !== 'active' || state.profileDeletions?.[botId] || binding.phase !== 'ready')
    throwIpcError('DM_SOURCE_REVOKED', 'This teammate conversation is no longer available');
  return { botId, agentId, cwd: binding.cwd, workspaceId: binding.workspaceId, operationId: binding.operationId };
}
function matches(entry: Entry, reference: DmMessageReference): boolean {
  const item = entry.item;
  if (item.type !== 'user_message' && item.type !== 'assistant_message') return false;
  return item.type === `${reference.role}_message`
    && (reference.providerMessageId === undefined || item.messageId === reference.providerMessageId)
    && (reference.clientMessageId === undefined || (item.type === 'user_message' && item.clientMessageId === reference.clientMessageId))
    && (reference.turnId === undefined || entry.turnId === reference.turnId);
}
function referenceOf(entry: Entry): DmMessageReference {
  const item = entry.item;
  if (item.type !== 'user_message' && item.type !== 'assistant_message') throwIpcError('DM_SOURCE_INVALID', 'Not a conversation message');
  return { role: item.type === 'user_message' ? 'user' : 'assistant',
    ...(item.messageId ? { providerMessageId: item.messageId } : {}),
    ...(item.type === 'user_message' && item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}),
    ...(entry.turnId ? { turnId: entry.turnId } : {}) };
}

export class DmMessageSources {
  constructor(private readonly store: Pick<CompanionStore, 'snapshot'>) {}

  async read(paseo: Paseo, input: unknown, signal?: AbortSignal): Promise<DmSourceResult> {
    const result = await this.readOnce(paseo, input, signal);
    checkOpen(signal);
    return result;
  }
  private async readOnce(paseo: Paseo, input: unknown, signal?: AbortSignal): Promise<DmSourceResult> {
    checkOpen(signal);
    const source = dmMessageSourceSchema.parse(input), owner = canonicalOwner(await this.store.snapshot(), source.agentId);
    const agent = paseo.agents.ref(source.agentId);
    const check = async () => {
      checkOpen(signal);
      if (!await agent.refresh() || agent.archivedAt || agent.cwd !== owner.cwd || agent.workspaceId !== (owner.workspaceId ?? null))
        throwIpcError('DM_SOURCE_REVOKED', 'The native conversation no longer matches its teammate');
      checkOpen(signal);
      if (JSON.stringify(canonicalOwner(await this.store.snapshot(), source.agentId)) !== JSON.stringify(owner))
        throwIpcError('DM_SOURCE_REVOKED', 'The teammate conversation binding changed');
      checkOpen(signal);
    };
    await check();
    if (typeof agent.timeline?.refetch !== 'function') return { status: 'unsupported', reason: 'native-history' };
    let cursor: Cursor | undefined, epoch: string | undefined;
    const seen = new Set<string>();
    // Ignore UI positions. The host returns projected history even for the legacy canonical option.
    // Only an explicitly unmerged native message can be used as a source through this read seam.
    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
      checkOpen(signal);
      let page: Page;
      try { page = await agent.timeline.refetch({ projection: 'projected', limit: PAGE_SIZE,
        ...(cursor ? { cursor, direction: 'before' as const } : {}) }); }
      catch { await check(); return { status: 'unavailable', reason: 'history-error' }; }
      await check();
      if (page.error) return { status: 'unavailable', reason: 'history-error' };
      if (page.agentId !== source.agentId || !['canonical', 'projected'].includes(page.projection) || !page.epoch)
        return { status: 'unavailable', reason: 'invalid-page' };
      if (page.gap || page.staleCursor || (cursor && page.reset)) return { status: 'unavailable', reason: 'history-changed' };
      if (epoch !== undefined && epoch !== page.epoch) return { status: 'unavailable', reason: 'history-changed' };
      epoch = page.epoch;
      const found = page.entries.filter(entry => matches(entry, source.reference));
      // More than one matching row cannot establish one exact native source.
      if (found.length > 1) return { status: 'unavailable', reason: 'invalid-page' };
      const entry = found[0];
      if (entry) {
        if (entry.collapsed.length || entry.seqStart !== entry.seqEnd || entry.sourceSeqRanges.length !== 1
          || entry.sourceSeqRanges[0]!.startSeq !== entry.seqStart || entry.sourceSeqRanges[0]!.endSeq !== entry.seqEnd)
          return { status: 'unsupported', reason: 'merged-message' };
        const item = entry.item;
        if (item.type !== 'user_message' && item.type !== 'assistant_message') throwIpcError('DM_SOURCE_INVALID', 'Invalid source');
        // Missing turn identity is not evidence that an older message is still streaming.
        if (item.type === 'assistant_message' && entry.turnId && agent.activeTurn?.turnId === entry.turnId)
          return { status: 'unavailable', reason: 'active-message' };
        // A replacement between historical lookup and delivery invalidates the old snapshot.
        checkOpen(signal);
        let probe: Page;
        try { probe = await agent.timeline.refetch({ projection: 'projected', limit: 1 }); }
        catch { await check(); return { status: 'unavailable', reason: 'history-error' }; }
        await check();
        if (probe.error) return { status: 'unavailable', reason: 'history-error' };
        if (probe.agentId !== source.agentId || !['canonical', 'projected'].includes(probe.projection)) return { status: 'unavailable', reason: 'invalid-page' };
        if (probe.epoch !== epoch || probe.gap || probe.staleCursor) return { status: 'unavailable', reason: 'history-changed' };
        if (item.type === 'assistant_message' && entry.turnId && agent.activeTurn?.turnId === entry.turnId)
          return { status: 'unavailable', reason: 'active-message' };
        const result: DmSourceResult = { status: 'available', snapshot: { botId: owner.botId,
          source: { agentId: source.agentId, reference: referenceOf(entry), position: { epoch, seq: entry.seqStart } },
          text: item.text, createdAt: entry.timestamp,
          evidence: { projection: 'unmerged-native-message', provenance: 'unavailable', attachments: 'unavailable', sealed: 'unavailable' } } };
        return Buffer.byteLength(JSON.stringify(result), 'utf8') <= HISTORY_BYTES ? result : { status: 'limit', reason: 'message-size' };
      }
      if (!page.hasOlder) return { status: 'not-found' };
      const next = page.startCursor;
      if (!next || next.epoch !== epoch || (cursor && next.seq >= cursor.seq) || seen.has(JSON.stringify(next)))
        return { status: 'unavailable', reason: 'invalid-page' };
      seen.add(JSON.stringify(next)); cursor = next;
    }
    return { status: 'limit', reason: 'history-window' };
  }
}
