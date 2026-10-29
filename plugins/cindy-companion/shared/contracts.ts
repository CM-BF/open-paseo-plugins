import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import type { BotSettingsResult } from './vendor/botRemoteSettings';
import type { BotModelRoute } from './vendor/botModelChain';
export type { BotSettingsResult, BotSettingsOp } from './vendor/botRemoteSettings';

export interface CompanionCapabilities {
  model: string; providerId?: string | null; effort: string; fastMode: boolean | 'ultrafast';
  harness: 'claude' | 'codex' | 'pi'; modelChain: BotModelRoute[];
  modelChainOverride?: BotModelRoute[] | null; taskModelOverride?: BotModelRoute | null;
  skillMode: 'inherit' | 'allowlist'; skillsExcluded: string[];
  toolsetMode: 'inherit' | 'allowlist'; toolsets: string[];
  mcpMode: 'inherit' | 'allowlist'; mcpServers: string[];
  memory: boolean; permissions: 'ask' | 'auto' | 'trusted';
  inputHandoff?: boolean; allowSchedulerFollow?: boolean;
  [key: string]: unknown;
}
export interface CompanionSession {
  id: string; title: string; kind: string; updatedAt: number;
  status: 'active' | 'archived' | 'deleted'; role: 'canonical' | 'history' | 'routine';
  profileVersion?: number;
}
export interface CompanionProfile {
  id: string; name: string; description: string; identitySource: string; userContextSource: string;
  avatar: string; avatarColor: string; enabled: boolean; status: 'active' | 'paused' | 'archived';
  currentVersion: number; skills: string[]; capabilities: CompanionCapabilities;
  canonicalSessionId?: string; canonicalWorkspaceId?: string; homeDir: string; createdAt: number; sessions: CompanionSession[];
  lastMessagePreview?: string; lastMessageAt?: number; lastMessageRole?: string;
}
export interface RuntimeState {
  agentId: string | null; workspaceId: string | null; desiredVersion: number; appliedVersion: number | null;
  state: 'not-created' | 'creating' | 'ready' | 'pending' | 'unknown' | 'error';
  code?: string; message?: string; active?: boolean;
  configuredModel: BotModelRoute | null; appliedModel: BotModelRoute | null;
}
export interface CompanionHome { name: string; local: true; transferSupported: false; directory: string }
export interface BootstrapData {
  bot: CompanionProfile; profiles: CompanionProfile[];
  caps: { version: number; ops: string[] };
  models: unknown; home: CompanionHome; runtime: RuntimeState;
}
export type InvokeInput = { op: string; args: Record<string, unknown> };
export const resultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
]);
export const invokeRpc = defineRpc({
  name: 'settings.invoke',
  input: z.object({ op: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()).default({}) }),
  output: resultSchema,
});
export const bootstrapRpc = defineRpc({ name: 'companions.bootstrap', input: z.object({ botId: z.string().optional() }), output: resultSchema });
export type InvokeResult<T = unknown> = BotSettingsResult<T>;
