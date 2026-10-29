import { byteHistoryPage } from './history-page';
/** Local host adaptation of Cindy chatServer.ts quote/thread/read/follow/share/reaction contracts.
 * Upstream 118767c: server-read source identity and immutable operation receipts remain authoritative.
 * This host has one owner. It does not invent cloud actors or cross-account synchronization.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { GroupMessage } from '../shared/groups';
import type { GroupHistoryMessage, GroupHistorySnapshot, GroupThreadSnapshot } from '../shared/group-history';
import type { BotGroupThreadSummary, ChatReactor } from '../shared/vendor/botGroupChat';
import { botGroupQuoteExcerpt } from '../shared/vendor/botGroupQuote';
import { CompanionGroups, type SavedGroup } from './groups';
import { CompanionStore, type SavedState } from './store';
import type { Paseo } from './runtime';
import { string, throwIpcError } from './errors';

interface MutationReceipt { fingerprint: string; value: unknown }
export interface SavedGroupHistory {
  receipts: Record<string, MutationReceipt>;
  reactions: Record<string, { revision: number; emojis: Record<string, ChatReactor[]> }>;
}
export interface SavedGroupThread {
  id: string; groupId: string; rootId: string; execution: SavedGroup;
  readSequence: number | null; following: boolean;
  shares: Record<string, string>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revision = (state: SavedState) => state.historyRevision ?? 0;
const owner: ChatReactor = { actorId: 'local-host-owner', name: 'You', isSelf: true, formerMember: false };
function groupOf(state: SavedState, groupId: string, writing = false): SavedGroup {
  const group = state.groups?.[groupId];
  if (!group || group.deletedAt) throwIpcError('NOT_FOUND', 'Group not found');
  if (writing && group.mutation) throwIpcError('GROUP_BUSY', 'Group deletion is awaiting cleanup');
  return group;
}
function threadOf(state: SavedState, groupId: string, rootId: string): SavedGroupThread | undefined {
  return Object.values(state.groupThreads ?? {}).find(thread => thread.groupId === groupId && thread.rootId === rootId);
}
function rootOf(group: SavedGroup, rootId: string, allowDeleted = false): GroupMessage {
  const root = group.messages.find(message => message.id === rootId);
  if (!root || (!allowDeleted && root.deleted) || root.kind !== 'message' || root.authorKind === 'system' || root.threadRootId || root.threadShareRef)
    throwIpcError('THREAD_ROOT_UNAVAILABLE', 'This main-group message cannot open a topic');
  return root;
}
function messageOf(state: SavedState, groupId: string, messageId: string): GroupMessage {
  const group = groupOf(state, groupId);
  const message = group.messages.find(message => message.id === messageId) ?? Object.values(state.groupThreads ?? {})
    .filter(thread => thread.groupId === groupId).flatMap(thread => thread.execution.messages).find(message => message.id === messageId);
  if (!message) throwIpcError('NOT_FOUND', 'Message is not in this group');
  return message;
}
function spoken(thread: SavedGroupThread): GroupMessage[] { return thread.execution.messages.filter(message => message.kind === 'message' && !message.deleted); }
function unread(thread: SavedGroupThread) {
  const messages = spoken(thread).filter(message => message.authorKind !== 'user' && message.sequence > (thread.readSequence ?? 0));
  return { count: messages.length, mentioned: messages.some(message => Boolean(message.mentions?.all)), ...(messages.length ? { latest: messages.at(-1)!.sequence } : {}) };
}
function currentRound(group: SavedGroup) { return (group.activeRoundId ? group.rounds.find(round => round.id === group.activeRoundId) : group.rounds.at(-1)) ?? null; }
function beforeSequence(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throwIpcError('INVALID_PARAMS', 'Invalid history cursor');
  return Number(value);
}
function project(state: SavedState, groupId: string, message: GroupMessage): GroupHistoryMessage {
  const value: GroupHistoryMessage = { ...message, historyRevision: revision(state), isSelf: message.authorKind === 'user' };
  if (message.deleted) value.content = '';
  const reaction = state.groupHistory?.[groupId]?.reactions[message.id];
  value.reactions = Object.entries(reaction?.emojis ?? {}).filter(([, actors]) => actors.length)
    .map(([emoji, actors]) => ({ emoji, count: actors.length, me: actors.some(actor => actor.actorId === owner.actorId) }));
  value.reactionRevision = reaction?.revision ?? 0;
  if (message.quote) {
    const source = state.groups![groupId]!.messages.find(candidate => candidate.id === message.quote!.messageId);
    value.quote = { ...message.quote, ...(!source || source.deleted ? { originalDeleted: true } : {}) };
  }
  const thread = !message.threadRootId ? threadOf(state, groupId, message.id) : undefined;
  if (thread) {
    const replies = spoken(thread);
    const preview = (reply: GroupMessage) => ({ id: reply.id, authorKind: reply.authorKind, authorBotId: reply.authorBotId ?? null,
      authorName: reply.authorName, isSelf: reply.authorKind === 'user', text: botGroupQuoteExcerpt(reply.content), attachments: [], createdAt: reply.createdAt });
    const authors = new Map<string, GroupMessage>();
    for (const reply of replies) { const key = reply.authorKind === 'user' ? owner.actorId : reply.authorBotId ?? reply.authorName; authors.delete(key); authors.set(key, reply); }
    value.replyCount = replies.length; value.threadUnread = unread(thread);
    value.threadPreview = { replies: replies.slice(-2).map(preview), responders: [...authors.values()].slice(-3).map(preview) };
  }
  if (message.threadShareRef) {
    const ref = message.threadShareRef;
    const source = threadOf(state, groupId, ref.rootId)?.execution.messages.find(reply => reply.id === ref.messageId && reply.threadRootId === ref.rootId);
    const available = Boolean(source && !source.deleted && source.kind === 'message' && source.authorKind !== 'system');
    value.threadShare = { messageId: ref.messageId, threadRootId: ref.rootId, status: available ? 'available' : 'unavailable',
      authorKind: source?.authorKind ?? 'user', authorBotId: source?.authorBotId ?? null, authorName: source?.authorName ?? '',
      sharedByAuthor: source?.authorKind === 'user', content: available ? source!.content : '', attachments: [],
      createdAt: source?.createdAt ?? null, edited: false, version: revision(state) };
  }
  return value;
}
function quoteSources(state: SavedState, groupId: string, messages: GroupHistoryMessage[]): GroupHistoryMessage[] {
  const ids = new Set(messages.flatMap(message => message.quote ? [message.quote.messageId] : []));
  return state.groups![groupId]!.messages.filter(message => ids.has(message.id)).map(message => project(state, groupId, message));
}
function summary(state: SavedState, thread: SavedGroupThread): BotGroupThreadSummary {
  const root = state.groups![thread.groupId]!.messages.find(message => message.id === thread.rootId);
  const replies = spoken(thread), last = replies.at(-1);
  return { rootId: thread.rootId, rootAuthorName: root?.authorName ?? '', rootAuthorBotId: root?.authorBotId ?? null,
    rootText: root && !root.deleted ? botGroupQuoteExcerpt(root.content) : '', replyCount: replies.length, unread: unread(thread), following: thread.following,
    lastReply: last ? { authorName: last.authorName, text: botGroupQuoteExcerpt(last.content), createdAt: last.createdAt } : null };
}

/** Mutations are accepted and receipted in the same atomic store transaction. Native jobs stay in CompanionGroups. */
export class CompanionGroupHistory {
  constructor(private readonly store: CompanionStore, private readonly groups: CompanionGroups) {}
  private async ensureThread(paseo: Paseo, groupId: string, rootId: string, allowExistingDeletedRoot = false): Promise<SavedGroupThread> {
    // Run the same recovery fence before a new topic request can enter a native lane.
    await this.groups.ensureRecovered(paseo);
    const snapshot = await this.store.snapshot(); const group = groupOf(snapshot, groupId);
    const existing = threadOf(snapshot, groupId, rootId);
    rootOf(group, rootId, allowExistingDeletedRoot && Boolean(existing)); if (existing) return existing;
    return this.store.transaction(state => {
      const group = groupOf(state, groupId, true), root = rootOf(group, rootId);
      const previous = threadOf(state, groupId, rootId); if (previous) return previous;
      const id = randomUUID(), now = Date.now();
      const thread: SavedGroupThread = { id, groupId, rootId, readSequence: null, following: false, shares: {}, execution: {
        id, name: group.name, description: group.description, botIds: [...group.botIds], replyMode: group.replyMode,
        revision: 1, createdAt: now, updatedAt: now, messages: [], rounds: [], lanes: {}, receipts: {}, continueKeys: {},
        threadContext: { groupId, rootId, root: structuredClone(root) },
      } };
      (state.groupThreads ??= {})[id] = thread; return thread;
    });
  }
  async get(paseo: Paseo, groupId: string, args: Record<string, unknown>): Promise<GroupHistorySnapshot> {
    await this.groups.ensureRecovered(paseo);
    if (args.messageIds !== undefined && (!Array.isArray(args.messageIds) || args.messageIds.length > 500)) throwIpcError('INVALID_PARAMS', 'At most 500 message IDs may be requested');
    const ids = new Set((args.messageIds as unknown[] | undefined ?? []).map(id => string(id, 'messageId', 100)));
    const state = await this.store.snapshot(), group = groupOf(state, groupId);
    for (const id of ids) if (!group.messages.some(message => message.id === id)) throwIpcError('NOT_FOUND', 'A requested main-group message is unavailable');
    const before = beforeSequence(args.beforeSequence);
    const candidates = group.messages.filter(message => (args.messageIds === undefined || ids.has(message.id)) && (before === undefined || message.sequence < before));
    return byteHistoryPage(candidates, args.messageIds === undefined ? 100 : 500, (page, nextBeforeSequence) => {
      const messages = page.map(message => project(state, groupId, message)), roots = new Set(page.map(message => message.id));
      return { groupId, revision: revision(state), messages, quoteSources: quoteSources(state, groupId, messages), nextBeforeSequence,
        threads: Object.values(state.groupThreads ?? {}).filter(thread => thread.groupId === groupId && roots.has(thread.rootId)).map(thread => summary(state, thread)) };
    });
  }
  async send(paseo: Paseo, groupId: string, args: Record<string, unknown>) {
    if (args.quote === undefined) throwIpcError('INVALID_PARAMS', 'A quoted source message is required');
    if (args.attachments !== undefined || args.threadRootId !== undefined || args.threadShareRef !== undefined)
      throwIpcError('UNSUPPORTED', 'Quoted sends currently accept text and mentions only');
    const receipt = await this.groups.send(paseo, groupId, args), state = await this.store.snapshot();
    return { ...receipt, message: project(state, groupId, receipt.message) };
  }
  async thread(paseo: Paseo, groupId: string, args: Record<string, unknown>): Promise<GroupThreadSnapshot> {
    const rootId = string(args.rootId, 'rootId', 100), before = beforeSequence(args.beforeSequence);
    if (args.markRead !== undefined && typeof args.markRead !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid read marker');
    const found = await this.ensureThread(paseo, groupId, rootId, true);
    const read = (state: SavedState): GroupThreadSnapshot => {
      const group = groupOf(state, groupId, Boolean(args.markRead) && before === undefined), thread = state.groupThreads![found.id]!;
      const root = rootOf(group, rootId, true), readBefore = thread.readSequence;
      const candidates = thread.execution.messages.filter(message => before === undefined || message.sequence < Number(before));
      if (args.markRead && before === undefined) thread.readSequence = Math.max(thread.readSequence ?? 0, thread.execution.messages.at(-1)?.sequence ?? 0);
      const round = currentRound(thread.execution);
      // Projection/byte validation runs inside the same transaction as markRead.
      // A failure throws before persist, retaining the old unread cursor.
      return byteHistoryPage(candidates, 50, (page, nextBeforeSequence) => {
        const replies = page.map(message => project(state, groupId, message)), replyIds = new Set(page.map(message => message.id));
        return { groupId, rootId, revision: revision(state), root: project(state, groupId, root), replies, quoteSources: quoteSources(state, groupId, replies),
          hasMore: nextBeforeSequence !== null, nextBeforeSequence, readBefore, following: thread.following, round,
          pendingReplies: thread.execution.rounds.filter(candidate => candidate.id !== round?.id && ['queued', 'waiting'].includes(candidate.status)),
          sharedReplies: Object.fromEntries(Object.entries(thread.shares).filter(([reply]) => replyIds.has(reply)).map(([reply, messageId]) => [reply, { messageId, bySelf: true }])) };
      });
    };
    return args.markRead && before === undefined ? this.store.transaction(read) : read(await this.store.snapshot());
  }

  async reply(paseo: Paseo, groupId: string, args: Record<string, unknown>) {
    if (args.quote !== undefined || args.attachments !== undefined) throwIpcError('INVALID_PARAMS', 'Topic replies accept text and mentions only');
    const rootId = string(args.rootId, 'rootId', 100), snapshot = await this.store.snapshot(); groupOf(snapshot, groupId, true);
    const previous = threadOf(snapshot, groupId, rootId);
    const key = hash(string(args.clientMessageId, 'clientMessageId', 200));
    // A committed message remains replayable after its root becomes unavailable. New messages do not.
    const thread = previous?.execution.receipts[key] ? previous : await this.ensureThread(paseo, groupId, rootId);
    const receipt = await this.groups.send(paseo, thread.id, args), state = await this.store.snapshot();
    return { ...receipt, message: project(state, groupId, receipt.message) };
  }
  private async replay<T>(groupId: string, operationId: unknown, intent: unknown): Promise<{ value: T } | null> {
    const state = await this.store.snapshot(); groupOf(state, groupId, true);
    const receipt = state.groupHistory?.[groupId]?.receipts[hash(string(operationId, 'operationId', 200))];
    if (!receipt) return null;
    if (receipt.fingerprint !== hash(intent)) throwIpcError('IDEMPOTENCY_CONFLICT', 'Operation ID belongs to different history content');
    return { value: receipt.value as T };
  }
  private mutate<T>(groupId: string, operationId: unknown, intent: unknown, action: (state: SavedState) => T): Promise<T> {
    const key = hash(string(operationId, 'operationId', 200)), fingerprint = hash(intent);
    return this.store.transaction(state => {
      groupOf(state, groupId, true);
      const history = (state.groupHistory ??= {})[groupId] ??= { receipts: {}, reactions: {} };
      const receipt = history.receipts[key];
      if (receipt) { if (receipt.fingerprint !== fingerprint) throwIpcError('IDEMPOTENCY_CONFLICT', 'Operation ID belongs to different history content'); return receipt.value as T; }
      const value = action(state); history.receipts[key] = { fingerprint, value }; return value;
    });
  }
  async follow(paseo: Paseo, groupId: string, args: Record<string, unknown>) {
    const rootId = string(args.rootId, 'rootId', 100);
    if (typeof args.following !== 'boolean') throwIpcError('INVALID_PARAMS', 'Following must be true or false');
    const following = args.following;
    const replay = await this.replay<{ following: boolean; revision: number }>(groupId, args.operationId, ['follow', rootId, following]);
    if (replay) return replay.value;
    const thread = await this.ensureThread(paseo, groupId, rootId);
    return this.mutate(groupId, args.operationId, ['follow', rootId, following], state => {
      rootOf(groupOf(state, groupId), rootId); state.groupThreads![thread.id]!.following = following;
      return { following, revision: revision(state) };
    });
  }
  async share(paseo: Paseo, groupId: string, args: Record<string, unknown>) {
    const rootId = string(args.rootId, 'rootId', 100), messageId = string(args.messageId, 'messageId', 100);
    const replay = await this.replay<{ messageId: string; alreadyShared: boolean; revision: number }>(groupId, args.operationId, ['share', rootId, messageId]);
    if (replay) return replay.value;
    const thread = await this.ensureThread(paseo, groupId, rootId);
    return this.mutate(groupId, args.operationId, ['share', rootId, messageId], state => {
      const current = state.groupThreads![thread.id]!, group = groupOf(state, groupId, true);
      if (Object.hasOwn(current.shares, messageId)) return { messageId: current.shares[messageId]!, alreadyShared: true, revision: revision(state) };
      const source = current.execution.messages.find(message => message.id === messageId && message.threadRootId === rootId);
      if (!source || source.deleted || source.kind !== 'message' || source.authorKind === 'system') throwIpcError('NOT_FOUND', 'The topic reply is unavailable');
      const id = randomUUID(), now = Date.now();
      group.messages.push({ id, sequence: (group.messages.at(-1)?.sequence ?? 0) + 1, createdAt: now, authorKind: 'user', authorName: 'You', kind: 'message',
        content: `↪ ${source.authorName}: ${botGroupQuoteExcerpt(source.content)}`, threadShareRef: { rootId, messageId }, mentions: { all: false, botIds: [] } });
      group.updatedAt = now; current.shares[messageId] = id;
      return { messageId: id, alreadyShared: false, revision: revision(state) };
    });
  }
  async react(groupId: string, args: Record<string, unknown>) {
    const messageId = string(args.messageId, 'messageId', 100), emoji = string(args.emoji, 'emoji', 64);
    if (/\s|[\u0000-\u001f\u007f]/u.test(emoji) || ['__proto__', 'constructor', 'prototype'].includes(emoji) || typeof args.present !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid reaction');
    const present = args.present;
    return this.mutate(groupId, args.operationId, ['react', messageId, emoji, present], state => {
      const message = messageOf(state, groupId, messageId);
      if (message.deleted || message.kind !== 'message' || message.authorKind === 'system') throwIpcError('NOT_FOUND', 'This message cannot receive reactions');
      const reaction = state.groupHistory![groupId]!.reactions[messageId] ??= { revision: 0, emojis: {} };
      const actors = (Object.hasOwn(reaction.emojis, emoji) ? reaction.emojis[emoji]! : []).filter(actor => actor.actorId !== owner.actorId);
      if (present) actors.push({ ...owner });
      reaction.emojis[emoji] = actors; reaction.revision = revision(state);
      return { accepted: true as const, revision: revision(state) };
    });
  }
  async reactors(groupId: string, args: Record<string, unknown>) {
    const messageId = string(args.messageId, 'messageId', 100), emoji = string(args.emoji, 'emoji', 64), state = await this.store.snapshot();
    messageOf(state, groupId, messageId);
    const emojis = state.groupHistory?.[groupId]?.reactions[messageId]?.emojis;
    return { reactors: emojis && Object.hasOwn(emojis, emoji) ? emojis[emoji]! : [], revision: revision(state) };
  }
  async action(paseo: Paseo, groupId: string, args: Record<string, unknown>, action: 'stop' | 'continue') {
    const rootId = string(args.rootId, 'rootId', 100), roundId = string(args.roundId, 'roundId', 100), operationId = string(args.operationId, 'operationId', 200);
    const thread = await this.ensureThread(paseo, groupId, rootId, action === 'stop');
    if (!thread.execution.rounds.some(round => round.id === roundId)) throwIpcError('NOT_FOUND', 'This round does not belong to this topic');
    return action === 'stop' ? this.groups.stop(paseo, thread.id, roundId, operationId) : this.groups.continue(paseo, thread.id, { roundId, operationId });
  }
}
