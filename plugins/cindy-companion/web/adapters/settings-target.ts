import { useEffect, useState } from 'react';
import type { BotSettingsTarget } from '../../vendor/renderer/features/bots/botSettingsTarget';
import { invoke, post, BridgeError } from '../bridge';
import { adoptProfile, snapshot, subscribe, supports, updateProfile, useSnapshot } from '../state';
import { useBotProfiles } from './bot-store';
import { providerRows } from './catalog';
import { toast } from '../../vendor/renderer/lib/toast';
import { createRoutineRefresh } from './routine-refresh';
const request = <T = any>(op: string, args: Record<string, unknown> = {}): Promise<T> => invoke<T>(op, args);
const routineRefresh = createRoutineRefresh(request);
export const onRoutinesChanged = routineRefresh.subscribe;
const routineChanged = routineRefresh.changed;
async function mutation<T = any>(op: string, args: Record<string, unknown>): Promise<T> {
  try { return await request<T>(op,args); }
  catch(error) { toast.error(error instanceof Error?error.message:String(error)); throw error; }
}
async function profileResult(op: string, args: Record<string, unknown>) {
  const value = await request(op, args);
  if (value === null) return null;
  return adoptProfile(value.profile ? value : { profile: value });
}
const target: BotSettingsTarget = {
  kind: 'local', online: true,
  pages: new Set(['profile','personality','memory','model','voice','capabilities','channels','routines','history','advanced']),
  profile: {
    update: updateProfile as any,
    chooseAvatar: (botId, avatarImageBase64) => profileResult('profile.chooseAvatar', { botId, avatarImageBase64 }) as any,
    retryInvitation: async botId => { await profileResult('profile.retryInvitation', { botId }); },
  },
  lifecycle: { run: async body => {
    const result = await request('lifecycle.run', body as any);
    if (result.profile) adoptProfile(result);
    else if (body.action !== 'delete') await profileResult('profile.get', { botId: body.botId });
    post('profile-changed', {botId:body.botId});
    return result;
  } },
  useDefaultModelChain: () => useSnapshot()?.defaultModelChain ?? [],
  useHiddenVendors: () => {
    const state = useSnapshot();
    const available = new Set(providerRows(state?.models).map(item => item.vendor));
    return (['cc','codex','pi'] as const).filter(vendor => !available.has(vendor));
  },
  useRoster: useBotProfiles,
  memory: {
    list: (botId: string, query?: string) => request('memory.list', { botId, query }),
    read: (botId: string, filename: string) => request('memory.read', { botId, filename }),
    update: (body: Record<string, unknown>) => request('memory.update', body),
    delete: (body: Record<string, unknown>) => request('memory.delete', body),
  } as any,
  history: { search: body => request('history.search', body) },
  capabilities: {
    async load(bot) {
      const result = await request('capabilities.catalog', { botId: bot.id });
      if (result.entries) return {
        ...result.entries,
        skill: [...(result.personal ?? []).map((item: any) => ({ id: `personal:${item.slug}`, name: item.name, available: item.enabled !== false, personal: true })), ...(result.entries.skill ?? [])],
      };
      return result;
    },
    watch: (_bot, refresh) => subscribe(refresh),
  },
  channels: { im: null, canEnterCredentials: false, wechat: null, x: null },
  voice: {
    models: () => request('voice.models'),
    voices: selection => request('voice.voices', { selection }),
    preference: botId => request('voice.preference', { botId }),
    setPreference: (botId, selection, sentencePlayback) => request('voice.setPreference', { botId, selection, sentencePlayback }),
  },
  get routineModels() { return supports('routines.saveWithModel'); },
  get routineSessionModes() { return supports('routines.saveWithSessionMode'); },
  routines: {
    list: async botId => routineRefresh.track('routines.list', { botId }, await request('routines.list', { botId })),
    save: async (botId, input, id) => {
      const op = supports('routines.saveWithSessionMode') ? 'routines.saveWithSessionMode' : supports('routines.saveWithModel') ? 'routines.saveWithModel' : 'routines.save';
      const result = await mutation(op, { botId, input, id }); routineChanged(); return result;
    },
    remove: async (botId, id) => { await mutation('routines.remove', { botId, id }); routineChanged(); },
    runNow: async (botId, id) => {
      // One id per explicit action; the bridge never retries a native run itself.
      const operationId = crypto.randomUUID();
      try {
        const result = await mutation('routines.runNow', { botId, id, operationId });
        routineRefresh.accepted(botId, id, result);
        return result;
      } finally { routineChanged(); }
    },
    history: async (botId, id) => routineRefresh.track('routines.history', { botId, id }, await request('routines.history', { botId, id })),
    sources: () => request('routines.sources'),
    onChanged: onRoutinesChanged,
  },
  autonomy: {
    useSettings() {
      const [value, setValue] = useState<any>(null);
      useEffect(() => {
        if (!supports('autonomy.get')) return;
        let alive = true;
        void request('autonomy.get').then(next => { if (alive) setValue(next); }).catch(() => { /* page keeps its existing load-failure state */ });
        return () => { alive = false; };
      }, []);
      return value;
    },
    setSchedulerBotId: async schedulerBotId => { await request('autonomy.set', { schedulerBotId }); routineChanged(); },
    reset: async () => { await request('autonomy.reset'); routineChanged(); },
  },
};
export const useBotSettingsTarget = () => target;
export function unavailable(operation: string): never { throw new BridgeError('UNSUPPORTED', `This host does not support ${operation}.`); }
export function currentBotId() { const id=snapshot()?.bot.id; if (!id) throw new Error('Companion not loaded'); return id; }
