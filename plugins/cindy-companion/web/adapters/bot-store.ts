import { useSnapshot, snapshot, updateProfile, subscribe, refreshProfiles } from '../state';
import { invoke, post } from '../bridge';
import type { CompanionProfile, CompanionCapabilities } from '../../shared/contracts';
import type { BotModelRoute } from '../../shared/vendor/botModelChain';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '../../vendor/renderer/contexts/dataOwnerGeneration';
export type BotProfile = CompanionProfile;
export type BotCapabilities = CompanionCapabilities;
export type BotProfileUpdatePatch = Partial<CompanionProfile> & { capabilityBaseline?: unknown; expectedAvatar?: string };
const EMPTY: CompanionProfile[] = [];
export function useBotProfiles() { return useSnapshot()?.profiles ?? EMPTY; }
export function canonicalBotSessionId(bot: CompanionProfile) { return bot.canonicalSessionId ?? null; }
export const updateBotProfile = updateProfile;
export const retryBotInvitation = (botId: string) => invoke('profile.retryInvitation', { botId });
export const subscribeBotGlobalModel = subscribe;
export function getEffectiveBotModelChain() { return snapshot()?.defaultModelChain ?? []; }
export const ensureBotProfilesLoaded = refreshProfiles;

export class BotModelSelectionRequiredError extends Error {}
let creation: { owner: string | null; signature: string; operationId: string } | null = null;
/** The profile and avatar/model are committed in one host transaction. A lost ACK reuses the intent. */
export async function addBotProfileAndWait(input: {
  name: string; description: string; avatarImageBase64?: string; capabilities?: { modelChainOverride?: BotModelRoute[]; modelChain?: BotModelRoute[]; [key: string]: unknown }; prepareInvitation?: boolean;
}): Promise<CompanionProfile> {
  const owner = getDataOwnerGeneration();
  const routes = input.capabilities?.modelChainOverride;
  if (!routes?.length && !getEffectiveBotModelChain().length) throw new BotModelSelectionRequiredError();
  const fields = { name: input.name, description: input.description,
    ...(input.avatarImageBase64 ? { avatarImageBase64: input.avatarImageBase64 } : {}),
    ...(routes ? { capabilities: { modelChainOverride: routes.slice(0, 1) } } : {}) };
  const signature = JSON.stringify(fields);
  if (creation?.owner !== owner.dataOwnerId || creation.signature !== signature) creation = { owner: owner.dataOwnerId, signature, operationId: crypto.randomUUID() };
  const { profile } = await invoke<{ profile: CompanionProfile }>('profile.create', { ...fields, operationId: creation.operationId });
  if (!isDataOwnerGenerationCurrent(owner)) throw new Error('The selected host changed.');
  if (!profile?.id) throw new Error('The host did not return the created teammate.');
  post('profile-changed', { botId: profile.id });
  return profile;
}
