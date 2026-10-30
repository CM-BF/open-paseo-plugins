import { randomUUID } from 'node:crypto';
import { botOpeningGreeting } from '../../shared/presets';
import { OPENING_KIND, openingSchema, type OpeningData, type OpeningStatus } from '../../shared/opening';
import type { CompanionStore } from '../store';
import type { Paseo } from '../runtime';
import { string, throwIpcError } from '../errors';

export interface SavedPresetOpening {
  botId: string; agentId: string; itemId: string; data: OpeningData;
  status: 'pending' | 'appended' | 'suppressed';
  choice?: { option: string; messageId: string; status: 'pending' | 'accepted' | 'unknown' };
}
type Agent = ReturnType<Paseo['agents']['ref']>;

/** Package-authored greeting; never starts a model until the owner chooses an option. */
export class PresetOpenings {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly store: CompanionStore) {}
  private serial<T>(agentId: string, action: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(agentId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(agentId, next);
    void next.finally(() => { if (this.locks.get(agentId) === next) this.locks.delete(agentId); }).catch(() => {});
    return next;
  }
  private async agent(paseo: Paseo, botId: string, agentId: string): Promise<Agent> {
    const state = await this.store.snapshot(); const profile = state.profiles[botId];
    const binding = state.bindings[botId];
    if (!profile || !profile.enabled || profile.status !== 'active' || !binding || binding.agentId !== agentId || binding.phase !== 'ready')
      throwIpcError('OPENING_UNAVAILABLE', 'This opening no longer belongs to an active teammate conversation');
    const agent = paseo.agents.ref(agentId);
    if (!await agent.refresh() || agent.archivedAt || agent.cwd !== binding.cwd)
      throwIpcError('OPENING_UNAVAILABLE', 'This teammate conversation is unavailable');
    return agent;
  }
  private async history(agent: Agent, saved?: SavedPresetOpening) {
    let hasUser = false; let found = false;
    let cursor: unknown;
    for (let pageNo = 0; pageNo < 50; pageNo++) {
      const page = await agent.timeline.refetch({ limit: 200, projection: 'canonical', ...(cursor ? { cursor: cursor as never, direction: 'before' as const } : {}) });
      if (page.error) throwIpcError('HISTORY_UNAVAILABLE', 'Cannot verify this conversation history');
      for (const entry of page.entries) {
        const item = entry.item;
        if (item.type === 'user_message') {
          hasUser = true;
        }
        if (item.type === 'plugin' && item.pluginId === 'cindy-companion' && item.id === saved?.itemId) found = true;
      }
      if (!page.hasOlder) return { hasUser, found };
      if (!page.startCursor) break;
      cursor = page.startCursor;
    }
    throwIpcError('HISTORY_UNAVAILABLE', 'Cannot establish the start of this conversation');
  }
  async ensure(paseo: Paseo, botId: string, agentId: string) {
    return this.serial(agentId, async () => {
      const state = await this.store.snapshot();
      let saved = state.presetOpenings?.[agentId];
      if (saved?.status === 'appended' || saved?.status === 'suppressed') return;
      const receipt = Object.values(state.presetImports ?? {}).find(value => value.result.botId === botId && value.opening);
      if (!receipt?.opening) return;
      const agent = await this.agent(paseo, botId, agentId);
      const history = await this.history(agent, saved);
      if (!saved) {
        saved = { botId, agentId, itemId: `preset-opening:${receipt.result.requestId}`, status: 'pending',
          data: openingSchema.parse({ botId, name: state.profiles[botId]!.name,
            greeting: botOpeningGreeting(receipt.opening.welcome), options: receipt.opening.starterOptions ?? [] }) };
        const intent = saved;
        saved = await this.store.transaction(draft => {
          if (!draft.profiles[botId]) throwIpcError('OPENING_UNAVAILABLE', 'Teammate was removed');
          return (draft.presetOpenings ??= {})[agentId] ?? (draft.presetOpenings[agentId] = intent);
        });
      }
      if (history.hasUser || history.found) {
        await this.store.transaction(draft => { const current = draft.presetOpenings?.[agentId]; if (current) current.status = history.found ? 'appended' : 'suppressed'; });
        return;
      }
      // The public timeline contract replaces a row with this same plugin-local id.
      // The persisted intent also lets a lost append ACK reconcile before retrying.
      await agent.timeline.append({ type: 'plugin', id: saved.itemId, kind: OPENING_KIND, version: 1, data: saved.data });
      await this.store.transaction(draft => { const current = draft.presetOpenings?.[agentId]; if (current) current.status = 'appended'; });
    });
  }
  private async observe(paseo: Paseo, botId: string, agentId: string): Promise<{ status: OpeningStatus; saved: SavedPresetOpening; agent: Agent }> {
    const agent = await this.agent(paseo, botId, agentId);
    const saved = (await this.store.snapshot()).presetOpenings?.[agentId];
    if (!saved || saved.botId !== botId) throwIpcError('OPENING_UNAVAILABLE', 'No package opening is available');
    const history = await this.history(agent, saved);
    // Native history retains rejected human attempts too. A matching user row
    // cannot promote a lost send ACK to accepted; only the actual ACK does that.
    return { saved, agent, status: { available: saved.status === 'appended' && history.found && !history.hasUser && !saved.choice && !agent.activeTurn && agent.status !== 'running' && agent.status !== 'initializing',
      selected: saved.choice?.status === 'accepted', uncertain: Boolean(saved.choice && saved.choice.status !== 'accepted') } };
  }
  status(paseo: Paseo, botId: string, agentId: string) { return this.serial(agentId, async () => (await this.observe(paseo, botId, agentId)).status); }
  choose(paseo: Paseo, botId: string, agentId: string, option: unknown) {
    const text = string(option, 'starter choice', 800);
    return this.serial(agentId, async () => {
      const { saved, agent, status } = await this.observe(paseo, botId, agentId);
      if (saved.choice) {
        if (saved.choice.option !== text) throwIpcError('OPENING_ALREADY_USED', 'A starter choice was already selected');
        return status;
      }
      if (!status.available) throwIpcError('OPENING_ALREADY_USED', 'The conversation has already started');
      if (!saved.data.options.includes(text)) throwIpcError('INVALID_PARAMS', 'Unknown starter choice');
      const choice: NonNullable<SavedPresetOpening['choice']> = { option: text, messageId: `cindy-starter-${randomUUID()}`, status: 'pending' };
      await this.store.transaction(state => {
        const current = state.presetOpenings?.[agentId];
        if (!current || !state.profiles[botId]) throwIpcError('OPENING_UNAVAILABLE', 'Teammate was removed');
        current.choice = choice;
      });
      try {
        await agent.send(text, { messageId: choice.messageId, activeTurnBehavior: 'steer' });
        await this.store.transaction(state => { const current = state.presetOpenings?.[agentId]; if (current?.choice?.messageId === choice.messageId) current.choice.status = 'accepted'; });
        return { available: false, selected: true, uncertain: false };
      } catch {
        await this.store.transaction(state => { const current = state.presetOpenings?.[agentId]; if (current?.choice?.messageId === choice.messageId) current.choice.status = 'unknown'; });
        // A send ACK can be lost after acceptance. Never send again or infer
        // acceptance solely from a persisted user-message attempt.
        return { available: false, selected: false, uncertain: true };
      }
    });
  }
}
