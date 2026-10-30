import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanionStore } from '../store';
import { PresetImports } from './import';
import { PresetOpenings } from './opening';
import { readNativeBotPackage } from './catalog';
import type { Paseo } from '../runtime';
import { CompanionService } from '../service';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cindy-opening-')); roots.push(root);
  const store = new CompanionStore(root); const pkg = await readNativeBotPackage('engineer-bot');
  const receipt = await new PresetImports(store).invite({ ...pkg.identity, locale: 'en' });
  const profile = await store.get(receipt.botId); const agentId = 'native-preset';
  const cwd = join(profile.homeDir, 'workspace');
  await store.transaction(state => {
    state.bindings[profile.id] = { agentId, cwd, phase: 'ready' } as never;
    state.profiles[profile.id]!.sessions = [{ id: agentId, title: profile.name, kind: 'chat', role: 'canonical', status: 'active', updatedAt: Date.now(), profileVersion: 1 }];
  });
  const entries: Array<{ item: Record<string, unknown> }> = [];
  let appendCalls = 0; const sent: Array<{ text: string; messageId: string }> = [];
  const options = { appendAckLost: false, sendAckLost: false, recordSend: true, historyError: false };
  const agent = { cwd, status: 'idle', activeTurn: null, archivedAt: null,
    refresh: async () => true,
    archive: async () => { agent.archivedAt = 'archived' as never; },
    send: async (text: string, input: { messageId: string; activeTurnBehavior: string }) => {
      expect(input.activeTurnBehavior).toBe('steer'); sent.push({ text, messageId: input.messageId });
      if (options.recordSend) entries.push({ item: { type: 'user_message', text, clientMessageId: input.messageId } });
      if (options.sendAckLost) throw new Error('ACK lost');
    },
    timeline: { refetch: async () => ({ entries: structuredClone(entries), hasOlder: false, ...(options.historyError ? { error: 'offline' } : {}) }),
      append: async (item: Record<string, unknown>) => {
        appendCalls++; entries.push({ item: { ...item, pluginId: 'cindy-companion' } });
        if (options.appendAckLost) throw new Error('ACK lost');
      } },
  };
  const paseo = { agents: { ref: () => agent } } as unknown as Paseo;
  return { root, store, profile, agentId, entries, sent, agent, paseo, options, appendCalls: () => appendCalls,
    openings: new PresetOpenings(store), choice: (await store.snapshot()).presetImports![receipt.requestId]!.opening!.starterOptions![0]! };
}

it('publishes one authored greeting without a model turn; concurrent choices and restart send once', async () => {
  const f = await fixture();
  await Promise.all([f.openings.ensure(f.paseo, f.profile.id, f.agentId), f.openings.ensure(f.paseo, f.profile.id, f.agentId)]);
  expect(f.appendCalls()).toBe(1); expect(f.sent).toHaveLength(0);
  expect(await f.openings.status(f.paseo, f.profile.id, f.agentId)).toEqual({ available: true, selected: false, uncertain: false });
  await Promise.all([f.openings.choose(f.paseo, f.profile.id, f.agentId, f.choice), f.openings.choose(f.paseo, f.profile.id, f.agentId, f.choice)]);
  expect(f.sent).toHaveLength(1); expect(f.sent[0]!.text).toBe(f.choice);
  const restored = new PresetOpenings(new CompanionStore(f.root));
  expect(await restored.choose(f.paseo, f.profile.id, f.agentId, f.choice)).toEqual({ available: false, selected: true, uncertain: false });
  expect(f.sent).toHaveLength(1);
  await f.store.deleteProfile(f.profile.id, f.profile.name);
  const state = await f.store.snapshot(); expect(state.presetOpenings?.[f.agentId]).toBeUndefined();
  expect(state.deletedProfiles?.[f.profile.id]?.presetOpenings).toHaveLength(1);
  await expect(f.openings.status(f.paseo, f.profile.id, f.agentId)).rejects.toThrow('active teammate');
});

it('suppresses late greeting and options after any owner message, and refuses unreadable history', async () => {
  const f = await fixture(); f.options.historyError = true;
  await expect(f.openings.ensure(f.paseo, f.profile.id, f.agentId)).rejects.toThrow('history');
  expect(f.appendCalls()).toBe(0);
  f.options.historyError = false; f.entries.push({ item: { type: 'user_message', text: 'Hello already' } });
  await f.openings.ensure(f.paseo, f.profile.id, f.agentId);
  expect(f.appendCalls()).toBe(0);
  await expect(f.openings.choose(f.paseo, f.profile.id, f.agentId, f.choice)).rejects.toThrow('already started');
  expect(f.sent).toHaveLength(0);
});

it('reconciles a lost append ACK but does not mistake a persisted user attempt for accepted starter delivery', async () => {
  const f = await fixture(); f.options.appendAckLost = true;
  await expect(f.openings.ensure(f.paseo, f.profile.id, f.agentId)).rejects.toThrow('ACK lost');
  const restored = new PresetOpenings(new CompanionStore(f.root));
  await restored.ensure(f.paseo, f.profile.id, f.agentId); expect(f.appendCalls()).toBe(1);
  f.options.sendAckLost = true;
  expect((await restored.choose(f.paseo, f.profile.id, f.agentId, f.choice)).uncertain).toBe(true);
  expect(await restored.status(f.paseo, f.profile.id, f.agentId)).toEqual({ available: false, selected: false, uncertain: true });
  await restored.choose(f.paseo, f.profile.id, f.agentId, f.choice); expect(f.sent).toHaveLength(1);
});

it('never replays an unknown starter send and rejects foreign choices or stale bindings', async () => {
  const f = await fixture(); await f.openings.ensure(f.paseo, f.profile.id, f.agentId);
  await expect(f.openings.choose(f.paseo, f.profile.id, f.agentId, 'Foreign text')).rejects.toThrow('Unknown starter');
  f.options.sendAckLost = true; f.options.recordSend = false;
  expect((await f.openings.choose(f.paseo, f.profile.id, f.agentId, f.choice)).uncertain).toBe(true);
  const restored = new PresetOpenings(new CompanionStore(f.root));
  expect((await restored.choose(f.paseo, f.profile.id, f.agentId, f.choice)).uncertain).toBe(true);
  expect(f.sent).toHaveLength(1);
  await expect(restored.status(f.paseo, f.profile.id, 'foreign-agent')).rejects.toThrow('active teammate');
});

it('serializes native starter dispatch with deletion and rejects a late callback after deletion admission', async () => {
  const f = await fixture(); await f.openings.ensure(f.paseo, f.profile.id, f.agentId);
  const service = new CompanionService(f.store);
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  f.agent.archive = async () => { enter(); await barrier; f.agent.archivedAt = 'archived' as never; };
  const deletion = service.invoke({ op: 'lifecycle.run', args: { botId: f.profile.id, action: 'delete', confirmName: f.profile.name, keepTaskHistory: true, worktreeDisposition: 'retain' } }, f.paseo);
  await entered;
  const late = service.invoke({ op: 'preset.opening.choose', args: { botId: f.profile.id, agentId: f.agentId, option: f.choice } }, f.paseo);
  release();
  expect((await deletion).ok).toBe(true);
  expect(await late).toMatchObject({ ok: false, code: 'OPENING_UNAVAILABLE' });
  expect(f.sent).toHaveLength(0);
  await service.close();
});
