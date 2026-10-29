import { useSnapshot, snapshot, updateProfile, subscribe } from '../state';
import { invoke } from '../bridge';
import type { CompanionProfile, CompanionCapabilities } from '../../shared/contracts';
export type BotProfile = CompanionProfile;
export type BotCapabilities = CompanionCapabilities;
export type BotProfileUpdatePatch = Partial<CompanionProfile> & { capabilityBaseline?: unknown; expectedAvatar?: string };
const EMPTY: CompanionProfile[] = [];
export function useBotProfiles() { return useSnapshot()?.profiles ?? EMPTY; }
export function canonicalBotSessionId(bot: CompanionProfile) { return bot.canonicalSessionId ?? null; }
export const updateBotProfile = updateProfile;
export const retryBotInvitation = (botId: string) => invoke('profile.retryInvitation', { botId });
export const subscribeBotGlobalModel = subscribe;
export function getEffectiveBotModelChain() { return snapshot()?.bot.capabilities.modelChainOverride ?? snapshot()?.defaultModelChain ?? []; }
