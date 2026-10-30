import { invoke, post } from '../bridge';
import type { BotMarketApi } from '../../shared/presets';

export const presetApi: BotMarketApi = {
  list: () => invoke('paseo.presets.list'),
  invite: input => invoke('paseo.presets.invite', input),
  status: requestId => invoke('paseo.presets.status', { requestId }),
};

export async function openPresetCompanion(botId: string, stillCurrent: () => boolean = () => true) {
  const result = await invoke<{ agentId: string }>('paseo.conversation.ensure', { botId });
  if (!stillCurrent()) return;
  post('profile-changed', { botId });
  post('navigate-agent', { agentId: result.agentId });
}
