import { useSyncExternalStore } from 'react';
import type { BootstrapData, CompanionProfile, RuntimeState } from '../shared/contracts';
import { invoke, post } from './bridge';
import type { BotModelRoute } from '../shared/vendor/botModelChain';
import { toast } from '../vendor/renderer/lib/toast';
import { i18n } from './adapters/i18n';
export type { BootstrapData, CompanionProfile, RuntimeState };
export type SettingsState = BootstrapData & { defaultModelChain: BotModelRoute[] };
let state: SettingsState | null = null;
let runtimeNotice: string | null = null;
function announceRuntime(runtime: RuntimeState, saved = false) {
  if (runtimeNotice) { toast.dismiss(runtimeNotice); runtimeNotice = null; }
  const zh = i18n.language === 'zh-CN';
  if (runtime.state === 'pending' || runtime.state === 'unknown' || runtime.state === 'error') {
    const prefix = saved ? (zh ? '已保存。' : 'Saved. ') : '';
    const message = runtime.message || (zh ? '当前会话尚未应用这份设置；下次创建或重载伙伴后生效。' : 'The current session has not applied these settings. They apply when the companion is created or reloaded.');
    runtimeNotice = toast.warning(prefix + message, { duration: 10000 });
  }
}
const listeners = new Set<() => void>();
export const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const snapshot = () => state;
export const useSnapshot = () => useSyncExternalStore(subscribe, snapshot, snapshot);
export function setBootstrap(next: SettingsState) {
  if (!next?.bot?.id || !Array.isArray(next.profiles) || !next.caps || !Array.isArray(next.caps.ops)) throw new Error('Invalid companion bootstrap response');
  state = next; listeners.forEach(fn => fn()); announceRuntime(next.runtime);
}
export function adoptProfile(result: { profile: CompanionProfile; runtime?: RuntimeState }) {
  if (!state || !result?.profile?.id) throw new Error('The host returned an invalid profile.');
  const profile = result.profile;
  state = { ...state, bot: profile.id === state.bot.id ? profile : state.bot, profiles: state.profiles.map(item => item.id === profile.id ? profile : item), runtime: result.runtime ?? state.runtime };
  listeners.forEach(fn => fn());
  post('profile-changed', { botId: profile.id });
  if (result.runtime) announceRuntime(result.runtime, true);
  return profile;
}
export function supports(op: string) { return state?.caps.ops.includes(op) === true; }
export async function refreshProfiles() {
  const previous = state;
  const result = await invoke<{ profiles: CompanionProfile[] }>('profile.list');
  if (!state || state !== previous) return;
  state = { ...state, profiles: result.profiles, bot: result.profiles.find(profile => profile.id === state!.bot.id) ?? state.bot };
  listeners.forEach(fn => fn());
  post('profile-changed');
}
export async function updateProfile(botId: string, patch: Record<string, unknown>) {
  return adoptProfile(await invoke('profile.update', { botId, patch }));
}
