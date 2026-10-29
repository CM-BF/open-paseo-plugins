import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CompanionStore } from './store';
import { CompanionService } from './service';
import { CompanionError } from './errors';
import type { GroupDriver, GroupLane } from './group-driver';
import type { Paseo } from './runtime';

const roots: string[] = [], services: CompanionService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function barrier() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function setup(count = 2) {
  const root = await mkdtemp(join(tmpdir(), 'cindy-history-')); roots.push(root);
  const store = new CompanionStore(root); await store.load(); const ids = ['cindy'];
  for (let i = 1; i < count; i++) ids.push((await store.create({ name: `Partner${i}`, identitySource: `SOUL_${i}` })).id);
  const calls: Array<{ lane: GroupLane; prompt: string }> = [];
  const driver: GroupDriver = {
    ensure: vi.fn(async lane => {
      const saved = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
      const lanes = [...Object.values(saved.groups).flatMap((group: any) => Object.values(group.lanes)), ...Object.values(saved.groupThreads ?? {}).flatMap((thread: any) => Object.values(thread.execution.lanes))] as GroupLane[];
      expect(lanes.some(value => value.agentId === lane.agentId)).toBe(true);
      return { workspaceId: `workspace-${lane.agentId}` };
    }),
    reply: vi.fn(async (lane, input) => {
      calls.push({ lane, prompt: input.prompt });
      await input.recordDispatch?.({ ...lane.dispatch!, phase: 'dispatching' });
      await input.recordDispatch?.({ ...lane.dispatch!, phase: 'accepted', turnId: `turn-${input.messageId}` });
      await input.recordDispatch?.({ ...lane.dispatch!, phase: 'completed', turnId: `turn-${input.messageId}` });
      return `Answer ${lane.botId}`;
    }), stop: vi.fn(async () => {}), archive: vi.fn(async () => {}), configure: vi.fn(async () => {}),
  };
  const service = new CompanionService(store, { groupDriver: () => driver }); services.push(service);
  service.runtime.setMcpFactory(async (id, scope) => ({ type: 'http', url: `http://fixture.invalid/${id}`, scope }));
  const paseo = { providers: { waitForReady: async () => ({ entries: [{ provider: 'codex', status: 'ready', modes: [{ id: 'auto' }], models: [{ id: 'fixture-model', isDefault: true }] }] }) } } as unknown as Paseo;
  const group = await service.groups.create(paseo, { operationId: 'create', name: 'Team', botIds: ids, replyMode: 'mentioned' });
  const send = async (text: string, clientMessageId = randomUUID()) => (await service.groups.send(paseo, group.group.id, { text, clientMessageId })).message;
  return { root, store, service, driver, calls, paseo, ids, id: group.group.id, send };
}
async function finished(t: Awaited<ReturnType<typeof setup>>, rootId?: string) {
  await vi.waitFor(async () => {
    const round = rootId ? (await t.service.groupHistory.thread(t.paseo, t.id, { rootId })).round : (await t.service.groups.get(t.paseo, t.id)).group.round;
    expect(round?.status).toBe('completed');
  }, { timeout: 3000 });
}

it('freezes server-read quotes, rejects forged/cross-room sources and keeps quoted @names inert', async () => {
  const t = await setup();
  vi.mocked(t.driver.reply).mockResolvedValueOnce('A quote containing @Partner1 is data');
  await t.send('@Cindy original'); await finished(t);
  const source = (await t.service.groups.get(t.paseo, t.id)).messages.find(message => message.authorKind === 'bot')!;
  const input = { text: 'Reply to this', clientMessageId: 'quote-1', quote: { messageId: source.id } };
  const [a, b] = await Promise.all([t.service.groupHistory.send(t.paseo, t.id, input), t.service.groupHistory.send(t.paseo, t.id, input)]);
  expect(a.message.id).toBe(b.message.id); expect(a.message.quote).toMatchObject({ authorName: 'Cindy', excerpt: source.content });
  expect(a.message.mentions?.botIds).toEqual(['cindy']); await finished(t);
  expect(t.driver.reply).toHaveBeenCalledTimes(2);
  await t.store.transaction(state => { const group = state.groups![t.id]!; group.messages.find(message => message.id === source.id)!.deleted = true; group.botIds = [t.ids[1]!]; });
  const replay = await t.service.groupHistory.send(t.paseo, t.id, input);
  expect(replay.message.id).toBe(a.message.id); expect(replay.message.quote?.originalDeleted).toBe(true);
  await expect(t.service.groupHistory.send(t.paseo, t.id, { ...input, clientMessageId: 'new' })).rejects.toMatchObject({ code: 'QUOTE_UNAVAILABLE' });
  await expect(t.service.groupHistory.send(t.paseo, t.id, { ...input, quote: { messageId: randomUUID() } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(t.service.groupHistory.send(t.paseo, t.id, { ...input, quote: { messageId: source.id, excerpt: 'forged' } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  const other = await t.service.groups.create(t.paseo, { operationId: 'other', name: 'Other', botIds: t.ids, replyMode: 'mentioned' });
  await expect(t.service.groupHistory.send(t.paseo, other.group.id, { ...input, clientMessageId: 'cross' })).rejects.toMatchObject({ code: 'QUOTE_UNAVAILABLE' });
});

it('persists independent topics and stable per-bot native lanes with only root and own-thread context', async () => {
  const t = await setup(); await t.send('MAIN_SECRET'); const a = await t.send('ROOT_A'), b = await t.send('ROOT_B');
  const input = { rootId: a.id, text: '@Cindy FIRST_THREAD_SECRET', clientMessageId: 'a' };
  const [first, replay] = await Promise.all([t.service.groupHistory.reply(t.paseo, t.id, input), t.service.groupHistory.reply(t.paseo, t.id, input)]);
  expect(first.message.id).toBe(replay.message.id); await finished(t, a.id);
  await t.service.groupHistory.reply(t.paseo, t.id, { rootId: a.id, text: '@Cindy second', clientMessageId: 'a2' }); await finished(t, a.id);
  await t.service.groupHistory.reply(t.paseo, t.id, { rootId: b.id, text: '@Cindy other topic', clientMessageId: 'b' }); await finished(t, b.id);
  expect(t.calls[0]!.lane.agentId).toBe(t.calls[1]!.lane.agentId); expect(t.calls[2]!.lane.agentId).not.toBe(t.calls[0]!.lane.agentId);
  expect(t.calls[0]!.lane).toMatchObject({ groupId: t.id, threadRootId: a.id, scope: 'thread' });
  expect(t.calls[0]!.lane.sessionScope).toBeUndefined(); expect(t.calls[0]!.lane.config.mcpServers).toMatchObject({ cindy_memory: { url: 'http://fixture.invalid/cindy' } });
  expect(t.calls[1]!.prompt).toContain('FIRST_THREAD_SECRET'); expect(t.calls[2]!.prompt).toContain('ROOT_B');
  for (const call of t.calls) expect(call.prompt).not.toContain('MAIN_SECRET');
  expect(t.calls[2]!.prompt).not.toContain('ROOT_A'); expect(t.calls[2]!.prompt).not.toContain('FIRST_THREAD_SECRET');
  const main = await t.service.groups.get(t.paseo, t.id); expect(main.messages).toHaveLength(3); expect(main.group.round).toBeNull();
  expect((await t.service.groups.list(t.paseo)).groups).toHaveLength(1);
  const saved = await new CompanionStore(t.root).snapshot(); expect(Object.values(saved.groupThreads!)).toHaveLength(2);
  expect(Object.values(saved.groupThreads!).find(thread => thread.rootId === a.id)?.following).toBe(false);
  const internalId = Object.keys(saved.groupThreads!)[0]!;
  expect(await t.service.invoke({ op: 'groups.get', args: { groupId: internalId } }, t.paseo)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
});

it('shares a verified reply once without dispatch, projects live source and persists ACK replay across reopen', async () => {
  const t = await setup(), root = await t.send('Root');
  const reply = await t.service.groupHistory.reply(t.paseo, t.id, { rootId: root.id, text: '@Partner1 text in a reply', clientMessageId: 'reply' }); await finished(t, root.id);
  const calls = vi.mocked(t.driver.reply).mock.calls.length;
  const input = { rootId: root.id, messageId: reply.message.id, operationId: 'share' };
  const a = await t.service.groupHistory.share(t.paseo, t.id, input);
  expect(await t.service.groupHistory.share(t.paseo, t.id, input)).toEqual(a);
  expect(await t.service.groupHistory.share(t.paseo, t.id, { ...input, operationId: 'again' })).toMatchObject({ messageId: a.messageId, alreadyShared: true });
  expect(t.driver.reply).toHaveBeenCalledTimes(calls); expect((await t.service.groups.get(t.paseo, t.id)).messages).toHaveLength(2);
  const history = await t.service.groupHistory.get(t.paseo, t.id, {});
  expect(history.messages.find(message => message.id === a.messageId)?.threadShare).toMatchObject({ status: 'available', authorName: 'You', sharedByAuthor: true });
  await expect(t.service.groupHistory.send(t.paseo, t.id, { text: 'quote card', clientMessageId: 'card', quote: { messageId: a.messageId } })).rejects.toMatchObject({ code: 'QUOTE_UNAVAILABLE' });
  await t.store.transaction(state => { Object.values(state.groupThreads!)[0]!.execution.messages.find(message => message.id === reply.message.id)!.content = 'EDITED SOURCE'; });
  expect((await t.service.groupHistory.get(t.paseo, t.id, {})).messages.find(message => message.id === a.messageId)?.threadShare?.content).toBe('EDITED SOURCE');
  await t.store.transaction(state => { Object.values(state.groupThreads!)[0]!.execution.messages.find(message => message.id === reply.message.id)!.deleted = true; });
  expect((await t.service.groupHistory.get(t.paseo, t.id, {})).messages.find(message => message.id === a.messageId)?.threadShare?.status).toBe('unavailable');
  await t.service.close();
  const service = new CompanionService(new CompanionStore(t.root), { groupDriver: () => t.driver }); services.push(service);
  expect(await service.groupHistory.share(t.paseo, t.id, input)).toEqual(a);
  expect(t.driver.reply).toHaveBeenCalledTimes(calls);
});

it('pages topics without clearing unread on old pages and persists explicit following/monotonic read state', async () => {
  const t = await setup(), root = await t.send('Root');
  await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id });
  await t.store.transaction(state => { const thread = Object.values(state.groupThreads!)[0]!;
    for (let sequence = 1; sequence <= 55; sequence++) thread.execution.messages.push({ id: randomUUID(), sequence, authorKind: 'bot', authorBotId: 'cindy', authorName: 'Cindy', content: `reply ${sequence}`, kind: 'message', createdAt: sequence, threadRootId: root.id });
  });
  const latest = await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id });
  expect(latest).toMatchObject({ following: false, hasMore: true, readBefore: null }); expect(latest.replies).toHaveLength(50); expect(latest.root.threadUnread?.count).toBe(55);
  const old = await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id, beforeSequence: 6, markRead: true });
  expect(old.replies).toHaveLength(5); expect(old.root.threadUnread?.count).toBe(55);
  const read = await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id, markRead: true });
  expect(read.readBefore).toBeNull(); expect(read.root.threadUnread?.count).toBe(0);
  const on = await t.service.groupHistory.follow(t.paseo, t.id, { rootId: root.id, following: true, operationId: 'on' });
  await t.service.groupHistory.follow(t.paseo, t.id, { rootId: root.id, following: false, operationId: 'off' });
  expect(await t.service.groupHistory.follow(t.paseo, t.id, { rootId: root.id, following: true, operationId: 'on' })).toEqual(on);
  await expect(t.service.groupHistory.follow(t.paseo, t.id, { rootId: root.id, following: false, operationId: 'on' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const saved = Object.values((await new CompanionStore(t.root).snapshot()).groupThreads!)[0]!; expect(saved.readSequence).toBe(55); expect(saved.following).toBe(false);
});

it('persists reactions by host actor and replays old mutations without undoing newer choices', async () => {
  const t = await setup(), root = await t.send('Root');
  const input = { messageId: root.id, emoji: '👍', present: true, operationId: 'add' };
  const a = await t.service.groupHistory.react(t.id, input);
  await t.service.groupHistory.react(t.id, { ...input, present: false, operationId: 'remove' });
  expect(await t.service.groupHistory.react(t.id, input)).toEqual(a);
  expect((await t.service.groupHistory.reactors(t.id, input)).reactors).toEqual([]);
  await expect(t.service.groupHistory.react(t.id, { ...input, emoji: '🔥' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(t.service.groupHistory.react(t.id, { ...input, emoji: '__proto__', operationId: 'bad' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  expect((await t.service.groupHistory.reactors(t.id, { ...input, emoji: 'toString' })).reactors).toEqual([]);
  expect(await t.service.invoke({ op: 'groups.history.react', args: { groupId: t.id, ...input, actorId: 'another-owner' } }, t.paseo)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  await t.service.groupHistory.react(t.id, { ...input, operationId: 'add-new' });
  const result = await t.service.groupHistory.reactors(t.id, input); expect(result.reactors).toEqual([{ actorId: 'local-host-owner', name: 'You', isSelf: true, formerMember: false }]);
  const history = await t.service.groupHistory.get(t.paseo, t.id, {}); expect(history.groupId).toBe(t.id); expect(history.messages[0]!.reactions).toEqual([{ emoji: '👍', count: 1, me: true }]);
  expect(Object.values((await new CompanionStore(t.root).snapshot()).groupHistory!)[0]!.reactions[root.id]!.emojis['👍']).toHaveLength(1);
});

it('rejects cross-group/root/action scope and unsupported attachment snapshots', async () => {
  const t = await setup(), root = await t.send('Root'), otherRoot = await t.send('Other root');
  const other = await t.service.groups.create(t.paseo, { operationId: 'other', name: 'Other', botIds: t.ids });
  await expect(t.service.groupHistory.thread(t.paseo, other.group.id, { rootId: root.id })).rejects.toMatchObject({ code: 'THREAD_ROOT_UNAVAILABLE' });
  await expect(t.service.groupHistory.get(t.paseo, other.group.id, { messageIds: [root.id] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(t.service.groupHistory.reply(t.paseo, t.id, { rootId: root.id, text: 'x', clientMessageId: 'a', attachments: [] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  const result = await t.service.groupHistory.reply(t.paseo, t.id, { rootId: root.id, text: '@Cindy x', clientMessageId: 'b' }); await finished(t, root.id);
  await expect(t.service.groupHistory.action(t.paseo, t.id, { rootId: otherRoot.id, roundId: result.round!.id, operationId: 'stop' }, 'stop')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(t.service.groupHistory.share(t.paseo, t.id, { rootId: otherRoot.id, messageId: result.message.id, operationId: 'wrong' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(t.service.groupHistory.share(t.paseo, t.id, { rootId: root.id, messageId: 'constructor', operationId: 'prototype' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(t.service.groupHistory.get(t.paseo, t.id, { messageIds: Array(501).fill(root.id) })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
});

it('blocks membership and deletion during a topic native turn and includes topic lanes in cleanup', async () => {
  const t = await setup(), root = await t.send('Root'), entered = barrier(), release = barrier();
  const original = vi.mocked(t.driver.reply).getMockImplementation()!;
  vi.mocked(t.driver.reply).mockImplementationOnce(async (lane, input) => { entered.resolve(); await release.promise; return original(lane, input); });
  await t.service.groupHistory.reply(t.paseo, t.id, { rootId: root.id, text: '@Cindy work', clientMessageId: 'work' }); await entered.promise;
  const group = (await t.service.groups.get(t.paseo, t.id)).group;
  await expect(t.service.groups.update(t.paseo, t.id, { expectedRevision: group.revision, botIds: t.ids }, true)).rejects.toMatchObject({ code: 'GROUP_BUSY' });
  await expect(t.service.groups.remove(t.paseo, t.id, group.revision)).rejects.toMatchObject({ code: 'GROUP_BUSY' });
  release.resolve(); await finished(t, root.id);
  const third = (await t.store.create({ name: 'Third' })).id;
  await t.service.groups.update(t.paseo, t.id, { expectedRevision: group.revision, botIds: [t.ids[1], third] }, true);
  expect(t.driver.archive).toHaveBeenCalledWith(expect.objectContaining({ threadRootId: root.id, botId: 'cindy', retired: true }));
});

it('keeps unknown topic admission fenced through reopen and never infers completion from idle', async () => {
  const t = await setup(), root = await t.send('Root');
  vi.mocked(t.driver.reply).mockImplementationOnce(async (lane, input) => { await input.recordDispatch?.({ ...lane.dispatch!, phase: 'dispatching' }); throw Object.assign(new Error('lost ACK'), { dispatchOutcome: 'unknown' }); });
  vi.mocked(t.driver.stop).mockRejectedValue(new CompanionError('ADMISSION_OUTCOME_UNKNOWN', 'Unknown dispatch'));
  await t.service.groupHistory.reply(t.paseo, t.id, { rootId: root.id, text: '@Cindy uncertain', clientMessageId: 'unknown' });
  await vi.waitFor(async () => expect((await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id })).round).toMatchObject({ status: 'unknown', code: 'ADMISSION_OUTCOME_UNKNOWN' }));
  await t.service.close(); const service = new CompanionService(new CompanionStore(t.root), { groupDriver: () => t.driver }); services.push(service);
  const recovered = await service.groupHistory.thread(t.paseo, t.id, { rootId: root.id }); expect(recovered.round).toMatchObject({ status: 'unknown', code: 'ADMISSION_OUTCOME_UNKNOWN' });
  await expect(service.groupHistory.reply(t.paseo, t.id, { rootId: root.id, text: '@Cindy retry', clientMessageId: 'new' })).rejects.toMatchObject({ code: 'GROUP_BUSY' });
  expect(t.driver.reply).toHaveBeenCalledTimes(1);
});

it('drains an accepted history write on close and rejects later RPC admission', async () => {
  const t = await setup(), root = await t.send('Root'), entered = barrier(), release = barrier();
  const held = t.store.transaction(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  const write = t.service.invoke({ op: 'groups.history.react', args: { groupId: t.id, messageId: root.id, emoji: '👍', present: true, operationId: 'accepted' } }, t.paseo);
  const close = t.service.close();
  expect(await t.service.invoke({ op: 'groups.history.get', args: { groupId: t.id } }, t.paseo)).toMatchObject({ ok: false, code: 'PLUGIN_CLOSED' });
  release.resolve(); await held; expect(await write).toMatchObject({ ok: true }); await close;
  expect((await new CompanionStore(t.root).snapshot()).groupHistory![t.id]!.reactions[root.id]!.emojis['👍']).toHaveLength(1);
});

it('continues one persisted topic round once and does not let an old Stop receipt cancel a newer turn', async () => {
  const t = await setup(6), root = await t.send('Root');
  const first = await t.service.groupHistory.reply(t.paseo, t.id, { rootId: root.id, text: '@all discuss', clientMessageId: 'all' });
  await vi.waitFor(async () => expect((await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id })).round?.status).toBe('waiting'));
  expect(t.driver.reply).toHaveBeenCalledTimes(5);
  const input = { rootId: root.id, roundId: first.round!.id, operationId: 'continue' };
  await Promise.all([t.service.groupHistory.action(t.paseo, t.id, input, 'continue'), t.service.groupHistory.action(t.paseo, t.id, input, 'continue')]);
  await finished(t, root.id); expect(t.driver.reply).toHaveBeenCalledTimes(6);
  await t.service.groupHistory.action(t.paseo, t.id, input, 'continue'); expect(t.driver.reply).toHaveBeenCalledTimes(6);
  const oldStop = { ...input, operationId: 'old-stop' };
  await t.service.groupHistory.action(t.paseo, t.id, oldStop, 'stop');
  const entered = barrier(), release = barrier(), original = vi.mocked(t.driver.reply).getMockImplementation()!;
  vi.mocked(t.driver.reply).mockImplementationOnce(async (lane, request) => { entered.resolve(); await release.promise; return original(lane, request); });
  const second = await t.service.groupHistory.reply(t.paseo, t.id, { rootId: root.id, text: '@Cindy later turn', clientMessageId: 'later' }); await entered.promise;
  const stopCount = vi.mocked(t.driver.stop).mock.calls.length;
  expect((await t.service.groupHistory.action(t.paseo, t.id, oldStop, 'stop')).round.id).toBe(first.round!.id);
  expect((await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id })).round).toMatchObject({ id: second.round!.id, status: 'running' });
  expect(t.driver.stop).toHaveBeenCalledTimes(stopCount);
  await expect(t.service.groupHistory.action(t.paseo, t.id, { ...oldStop, roundId: second.round!.id }, 'stop')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  release.resolve(); await finished(t, root.id);
});

it('preserves deleted-root history and committed reply replay while allowing Stop but rejecting new sends', async () => {
  const t = await setup(), root = await t.send('Root'), entered = barrier(), release = barrier();
  const original = vi.mocked(t.driver.reply).getMockImplementation()!;
  vi.mocked(t.driver.reply).mockImplementationOnce(async (lane, request) => { entered.resolve(); await release.promise; return original(lane, request); });
  const input = { rootId: root.id, text: '@Cindy running', clientMessageId: 'one' };
  const receipt = await t.service.groupHistory.reply(t.paseo, t.id, input); await entered.promise;
  await t.store.transaction(state => { state.groups![t.id]!.messages.find(message => message.id === root.id)!.deleted = true; });
  const history = await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id }); expect(history.root).toMatchObject({ deleted: true, content: '' });
  expect((await t.service.groupHistory.reply(t.paseo, t.id, input)).message.id).toBe(receipt.message.id);
  await expect(t.service.groupHistory.reply(t.paseo, t.id, { ...input, clientMessageId: 'new' })).rejects.toMatchObject({ code: 'THREAD_ROOT_UNAVAILABLE' });
  await t.service.groupHistory.action(t.paseo, t.id, { rootId: root.id, roundId: receipt.round!.id, operationId: 'stop' }, 'stop');
  release.resolve(); await vi.waitFor(async () => expect((await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id })).round?.status).toBe('stopped'));
});

it('keeps provider-unavailable topic admission definitely unsent rather than inventing an answer or unknown execution', async () => {
  const t = await setup(), root = await t.send('Root');
  vi.mocked(t.driver.reply).mockImplementationOnce(async (lane, request) => {
    await request.recordDispatch?.({ ...lane.dispatch!, phase: 'not-sent', code: 'PROVIDER_ADMISSION_UNAVAILABLE' });
    throw new CompanionError('PROVIDER_ADMISSION_UNAVAILABLE', 'Provider lacks atomic admission');
  });
  await t.service.groupHistory.reply(t.paseo, t.id, { rootId: root.id, text: '@Cindy blocked', clientMessageId: 'blocked' });
  await vi.waitFor(async () => expect((await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id })).round).toMatchObject({ status: 'failed', code: 'PROVIDER_ADMISSION_UNAVAILABLE' }));
  const history = await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id }); expect(history.replies.some(message => message.authorKind === 'bot')).toBe(false);
  const thread = Object.values((await new CompanionStore(t.root).snapshot()).groupThreads!)[0]!;
  expect(Object.values(thread.execution.lanes)[0]!.dispatch?.phase).toBe('not-sent');
});

it('pages full Chinese main messages by bytes and bounds topic summaries to the requested roots', async () => {
  const t = await setup(), root = await t.send('Root');
  await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id });
  const body = '中文正文'.repeat(4000), ids: string[] = [];
  await t.store.transaction(state => {
    const group = state.groups![t.id]!, template = Object.values(state.groupThreads!)[0]!;
    for (let n = 0; n < 100; n++) {
      const id = randomUUID(); ids.push(id);
      group.messages.push({ id, sequence: n + 2, kind: 'message', authorKind: 'bot', authorBotId: 'cindy', authorName: 'Cindy', content: body, createdAt: n });
      const topic = structuredClone(template); topic.id = randomUUID(); topic.rootId = id; topic.execution.id = topic.id;
      topic.execution.threadContext = { groupId: t.id, rootId: id, root: structuredClone(group.messages.at(-1)!) };
      topic.execution.messages = [{ ...group.messages.at(-1)!, id: randomUUID(), sequence: 1, threadRootId: id }];
      state.groupThreads![topic.id] = topic;
    }
  });
  // The real GroupChat first loads groups.get, before asking for rich projections.
  const raw = new Map<string, string>(); let rawBefore: number | undefined;
  do {
    const page = await t.service.groups.get(t.paseo, t.id, rawBefore === undefined ? {} : { beforeSequence: rawBefore });
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(1_700_000);
    for (const message of page.messages) { expect(raw.has(message.id)).toBe(false); raw.set(message.id, message.content); }
    if (!page.hasOlder) break;
    expect(page.messages.length).toBeGreaterThan(0);
    const next = page.messages[0]!.sequence;
    if (rawBefore !== undefined) expect(next).toBeLessThan(rawBefore);
    rawBefore = next;
  } while (true);
  expect(raw.size).toBe(101); for (const id of ids) expect(raw.get(id)).toBe(body);
  const empty = await t.service.groupHistory.get(t.paseo, t.id, { messageIds: [] });
  expect(empty.messages).toEqual([]); expect(empty.threads).toEqual([]);
  const single = await t.service.groupHistory.get(t.paseo, t.id, { messageIds: [ids[0]] });
  expect(single.messages.map(message => message.id)).toEqual([ids[0]]); expect(single.threads).toHaveLength(1);
  expect(single.messages[0]!.content).toBe(body); expect(single.threads[0]!.rootText.length).toBeLessThanOrEqual(280);
  const found = new Map<string, string>(); let beforeSequence: number | undefined, pages = 0;
  do {
    const page = await t.service.groupHistory.get(t.paseo, t.id, { messageIds: ids, ...(beforeSequence === undefined ? {} : { beforeSequence }) });
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(1_700_000);
    expect(page.threads.every(thread => page.messages.some(message => message.id === thread.rootId))).toBe(true);
    for (const message of page.messages) { expect(found.has(message.id)).toBe(false); found.set(message.id, message.content); }
    if (page.nextBeforeSequence === null) break;
    expect(page.nextBeforeSequence).toBe(page.messages[0]!.sequence);
    if (beforeSequence !== undefined) expect(page.nextBeforeSequence).toBeLessThan(beforeSequence);
    beforeSequence = page.nextBeforeSequence;
    expect(++pages).toBeLessThan(100);
  } while (true);
  expect(pages).toBeGreaterThan(1); expect(found.size).toBe(100);
  for (const id of ids) expect(found.get(id)).toBe(body);
});

it('keeps complete topic bodies across byte pages, exposes page shares, and commits read only for a valid response', async () => {
  const t = await setup(), root = await t.send('Root');
  await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id });
  const body = '中文正文'.repeat(4000);
  await t.store.transaction(state => {
    const thread = Object.values(state.groupThreads!)[0]!;
    for (let sequence = 1; sequence <= 50; sequence++) {
      const id = randomUUID();
      thread.execution.messages.push({ id, sequence, authorKind: 'bot', authorBotId: 'cindy', authorName: 'Cindy', content: body, kind: 'message', createdAt: sequence, threadRootId: root.id });
      thread.shares[id] = `main-${sequence}`;
    }
  });
  let page = await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id, markRead: true });
  expect(page.readBefore).toBeNull(); expect(page.root.threadUnread?.count).toBe(0);
  expect(page.replies.length).toBeLessThan(50); expect(page.hasMore).toBe(true);
  const seen = new Set<string>();
  while (true) {
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(1_700_000);
    expect(Object.keys(page.sharedReplies).sort()).toEqual(page.replies.map(message => message.id).sort());
    for (const message of page.replies) { expect(seen.has(message.id)).toBe(false); seen.add(message.id); expect(message.content).toBe(body); }
    if (page.nextBeforeSequence === null) break;
    page = await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id, beforeSequence: page.nextBeforeSequence, markRead: true });
  }
  expect(seen.size).toBe(50);
  expect(Object.values((await new CompanionStore(t.root).snapshot()).groupThreads!)[0]!.readSequence).toBe(50);
});

it('rolls back markRead when even one required projection cannot fit the response', async () => {
  const t = await setup(), root = await t.send('Root');
  await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id });
  await t.store.transaction(state => {
    const thread = Object.values(state.groupThreads!)[0]!;
    thread.execution.messages.push({ id: randomUUID(), sequence: 1, kind: 'message', authorKind: 'bot', authorBotId: 'cindy', authorName: 'Cindy', content: 'Unread', createdAt: 1, threadRootId: root.id });
    // Simulate a malformed/legacy stored projection; never trim it into fake success.
    state.groups![t.id]!.messages.find(message => message.id === root.id)!.content = '中'.repeat(600000);
  });
  const previous = await new CompanionStore(t.root).snapshot();
  await expect(t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id, markRead: true })).rejects.toMatchObject({ code: 'HISTORY_WINDOW_TOO_LARGE' });
  const after = await new CompanionStore(t.root).snapshot();
  expect(Object.values(after.groupThreads!)[0]!.readSequence).toBeNull(); expect(after.historyRevision).toBe(previous.historyRevision);
});

it('reconciles the same Stop operation after its ACK was lost and native stopping first remained unknown', async () => {
  const t = await setup(), root = await t.send('Root'), entered = barrier(), release = barrier();
  vi.mocked(t.driver.reply).mockImplementationOnce(async (lane, request) => {
    await request.recordDispatch?.({ ...lane.dispatch!, phase: 'accepted', turnId: 'owned-turn' });
    entered.resolve(); await release.promise; return 'Ignored after Stop';
  });
  vi.mocked(t.driver.stop).mockRejectedValueOnce(new CompanionError('STOP_NOT_CONFIRMED', 'Lost exact-cancel acknowledgement'));
  const first = await t.service.groupHistory.reply(t.paseo, t.id, { rootId: root.id, text: '@Cindy work', clientMessageId: 'work' }); await entered.promise;
  const stop = { rootId: root.id, roundId: first.round!.id, operationId: 'same-stop-after-ack-loss' };
  await t.service.groupHistory.action(t.paseo, t.id, stop, 'stop'); // Its response never reached the caller.
  release.resolve();
  await vi.waitFor(async () => expect((await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id })).round?.status).toBe('unknown'));
  expect(t.driver.stop).toHaveBeenCalledTimes(1);
  // Control recovery must remain reachable even if unrelated stored projection metadata is invalid.
  await t.store.transaction(state => { state.groups![t.id]!.description = '中'.repeat(600000); });
  await expect(t.service.groups.get(t.paseo, t.id, { limit: 1 })).rejects.toMatchObject({ code: 'HISTORY_WINDOW_TOO_LARGE' });
  await t.service.groupHistory.action(t.paseo, t.id, stop, 'stop');
  await vi.waitFor(async () => expect((await t.service.groupHistory.thread(t.paseo, t.id, { rootId: root.id })).round?.status).toBe('stopped'));
  expect(t.driver.stop).toHaveBeenCalledTimes(2); expect(t.driver.reply).toHaveBeenCalledTimes(1);
  const stoppedLanes = vi.mocked(t.driver.stop).mock.calls.map(([lane]) => lane);
  expect(stoppedLanes[0]!.dispatch).toEqual(stoppedLanes[1]!.dispatch);
  await t.service.groupHistory.action(t.paseo, t.id, stop, 'stop');
  expect(t.driver.stop).toHaveBeenCalledTimes(2);
});
