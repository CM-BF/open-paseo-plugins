import { expect, it, vi } from 'vitest';
import { NativeGroupDriver, type GroupLane } from './group-driver';
import type { Paseo } from './runtime';

function fake() {
  const listeners = new Set<() => void>(); const streamListeners = new Set<(event: any) => void>();
  const entries: any[] = []; let snapshot: any = { status: 'idle', cwd: '/owned/group/workspace', pendingPermissions: [], activeTurn: null };
  const timelineUnsubscribe = vi.fn(() => streamListeners.clear());
  const agent = {
    id: 'a', get cwd() { return snapshot.cwd; }, get archivedAt() { return snapshot.archivedAt; },
    get status() { return snapshot.status; }, get activeTurn() { return snapshot.activeTurn; },
    get pendingPermissions() { return snapshot.pendingPermissions; }, workspaceId: 'w',
    refresh: vi.fn(async () => ({ agent: snapshot })),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    send: vi.fn(async (_text: string, options: { messageId: string }) => {
      entries.push({ item: { type: 'user_message', text: 'request', clientMessageId: options.messageId } });
      snapshot.status = 'running'; snapshot.activeTurn = { id: 'turn' }; for (const fn of listeners) fn();
      for (const fn of streamListeners) fn({ event: { type: 'turn_started', turnId: 'turn', provider: 'codex' } });
    }),
    timeline: { subscribe: (fn: (event: any) => void) => { streamListeners.add(fn); return Object.assign(timelineUnsubscribe, { ready: Promise.resolve() }); },
      refetch: vi.fn(async () => ({ entries, error: null, hasOlder: false })) },
    interrupt: vi.fn(async () => { snapshot.status = 'idle'; snapshot.activeTurn = null; for (const fn of listeners) fn(); }),
    archive: vi.fn(async () => { snapshot.archivedAt = 'now'; }),
  };
  const paseo = { agents: { ref: vi.fn(() => agent), create: vi.fn(async () => agent) } } as unknown as Paseo;
  const lane: GroupLane = { agentId: 'a', operationId: 'op', groupId: 'g', roundId: 'r', botId: 'cindy', cwd: snapshot.cwd, title: 'group', config: {}, phase: 'ready' };
  const update = (patch: object) => { snapshot = { ...snapshot, ...patch }; for (const fn of listeners) fn(); };
  const complete = (text = 'final answer') => { entries.push({ turnId: 'turn', item: { type: 'assistant_message', text: 'progress' } }, { turnId: 'turn', item: { type: 'assistant_message', text } }); update({ status: 'idle', activeTurn: null }); for (const fn of streamListeners) fn({ event: { type: 'turn_completed', turnId: 'turn', provider: 'codex' } }); };
  return { driver: new NativeGroupDriver(paseo), lane, agent, entries, update, complete, listeners, timelineUnsubscribe, streamListeners };
}
it('uses an established public timeline observation and binds the final reply to the exact clientMessageId', async () => {
  const f = fake(); const signal = new AbortController();
  const reply = f.driver.reply(f.lane, { prompt: 'question', messageId: 'm1', signal: signal.signal, permission: () => {} });
  await vi.waitFor(() => expect(f.agent.send).toHaveBeenCalled()); f.complete();
  expect(await reply).toBe('final answer'); expect(f.listeners.size).toBe(0); expect(f.timelineUnsubscribe).toHaveBeenCalledOnce();
});
it('does not attribute a reply after an unrelated user input to the accepted group request', async () => {
  const f = fake();
  const reply = f.driver.reply(f.lane, { prompt: 'question', messageId: 'm1', signal: new AbortController().signal, permission: () => {} });
  const rejection = expect(reply).rejects.toMatchObject({ code: 'REPLY_NOT_CONFIRMED' });
  await vi.waitFor(() => expect(f.agent.send).toHaveBeenCalled());
  f.entries.push({ item: { type: 'user_message', clientMessageId: 'foreign', text: 'other user request' } }); f.complete(); await rejection;
});
it('does not mistake the stale idle snapshot after send acknowledgement for turn completion', async () => {
  const f = fake(); let done = false;
  f.agent.send.mockImplementation(async (_text, options) => { f.entries.push({ item: { type: 'user_message', clientMessageId: options.messageId, text: 'request' } }); });
  const result = f.driver.reply(f.lane, { prompt: 'question', messageId: 'm1', signal: new AbortController().signal, permission: () => {} }).then(value => { done = true; return value; });
  await vi.waitFor(() => expect(f.agent.refresh).toHaveBeenCalledTimes(2));
  expect(done).toBe(false); expect(f.agent.timeline.refetch).not.toHaveBeenCalled();
  for (const fn of f.streamListeners) fn({ event: { type: 'turn_started', turnId: 'turn', provider: 'codex' } });
  f.complete(); expect(await result).toBe('final answer');
});
it('requires the observed turn to complete successfully even when an assistant message and idle snapshot exist', async () => {
  const f = fake();
  const result = f.driver.reply(f.lane, { prompt: 'question', messageId: 'm1', signal: new AbortController().signal, permission: () => {} });
  const rejected = expect(result).rejects.toMatchObject({ code: 'RUNTIME_ERROR' });
  await vi.waitFor(() => expect(f.agent.send).toHaveBeenCalled());
  f.entries.push({ turnId: 'turn', item: { type: 'assistant_message', text: 'partial output' } }); f.update({ status: 'idle', activeTurn: null });
  for (const fn of f.streamListeners) fn({ event: { type: 'turn_failed', turnId: 'turn', provider: 'codex', error: 'native failed' } });
  await rejected;
});
it('keeps the same turn pending during permission and settles after the native response, without dispatching again', async () => {
  const f = fake(); const permission = vi.fn(); let done = false;
  const reply = f.driver.reply(f.lane, { prompt: 'question', messageId: 'm1', signal: new AbortController().signal, permission }).then(value => { done = true; return value; });
  await vi.waitFor(() => expect(f.agent.send).toHaveBeenCalled()); f.update({ pendingPermissions: [{ id: 'p' }] });
  await Promise.resolve(); expect(done).toBe(false); expect(permission).toHaveBeenCalledWith(true);
  f.update({ pendingPermissions: [] }); f.complete(); expect(await reply).toBe('final answer');
  expect(permission).toHaveBeenCalledWith(false); expect(f.agent.send).toHaveBeenCalledOnce();
});
it('cancellation removes listeners and prevents a late completion from returning a result', async () => {
  const f = fake(); const controller = new AbortController();
  const reply = f.driver.reply(f.lane, { prompt: 'question', messageId: 'm1', signal: controller.signal, permission: () => {} });
  const rejection = expect(reply).rejects.toMatchObject({ code: 'GROUP_STOPPED' });
  await vi.waitFor(() => expect(f.agent.send).toHaveBeenCalled()); controller.abort(); await rejection;
  f.complete(); expect(f.listeners.size).toBe(0); expect(f.timelineUnsubscribe).toHaveBeenCalledOnce();
});
it('interrupts only the owned native lane and confirms it stopped before archive', async () => {
  const f = fake(); f.update({ status: 'running', activeTurn: { id: 'turn' } });
  await f.driver.stop(f.lane); expect(f.agent.interrupt).toHaveBeenCalledOnce(); expect(f.agent.archive).not.toHaveBeenCalled();
  await f.driver.archive(f.lane); expect(f.agent.archive).toHaveBeenCalledOnce();
  f.update({ cwd: '/somebody-else' }); await expect(f.driver.stop(f.lane)).rejects.toMatchObject({ code: 'GROUP_LANE_MISMATCH' });
  expect(f.agent.interrupt).toHaveBeenCalledOnce();
});
