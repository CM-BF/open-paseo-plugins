import type { CompanionProfile } from '../shared/contracts';
import type { Paseo } from './runtime';
import { throwIpcError } from './errors';

export interface NativeSkillsSnapshot {
  profile: CompanionProfile;
  /** Cache/source epoch, not a content hash or evidence that a model read a body. */
  token: string;
  mounts: Array<{ directory: string }>;
  enabledCount: number;
  /** Only selected profile.skills IDs owned by the enabled or disabled personal shelves. */
  localSkillIds: string[];
}
export interface NativeSkillsIntent {
  token: string;
  enabledCount: number;
  mounts: Array<{ directory: string }>;
}
export const NATIVE_SKILLS_METADATA = '__cindyNativeSkills';
export function supportsNativeSkills(paseo: Paseo): boolean {
  const agents = paseo.agents as (Paseo['agents'] & { supportsNativeSkillMounts?: () => boolean }) | undefined;
  return typeof agents?.supportsNativeSkillMounts === 'function' && agents.supportsNativeSkillMounts() === true;
}
export function nativeSkillsIntent(snapshot: NativeSkillsSnapshot): NativeSkillsIntent {
  if (typeof snapshot.token !== 'string' || !snapshot.token || !Number.isSafeInteger(snapshot.enabledCount) || snapshot.enabledCount < 0
    || !Array.isArray(snapshot.mounts) || snapshot.mounts.some(mount => !mount || typeof mount.directory !== 'string' || !mount.directory))
    throwIpcError('NATIVE_SKILLS_SNAPSHOT_INVALID', 'The personal skill projection has no valid source epoch');
  if(snapshot.enabledCount && !snapshot.mounts.length) throwIpcError('NATIVE_SKILLS_SNAPSHOT_INVALID','Enabled skills have no native projection');
  return { token: snapshot.token, enabledCount: snapshot.enabledCount,
    mounts: snapshot.enabledCount ? structuredClone(snapshot.mounts) : [] };
}
export function skillsIntentFromConfig(config: Record<string, unknown>): NativeSkillsIntent | undefined {
  return config[NATIVE_SKILLS_METADATA] as NativeSkillsIntent | undefined;
}
/** Internal source epochs never cross the public native configuration schema. */
export function nativeConfigOnly(config: Record<string, unknown>): Record<string, unknown> {
  const { [NATIVE_SKILLS_METADATA]: _metadata, ...native } = config;
  return native;
}
export function assertNativeSkillsSupport(paseo: Paseo, config: Record<string, unknown>): void {
  if (Object.hasOwn(config, 'skillMounts') && !supportsNativeSkills(paseo))
    throwIpcError('NATIVE_SKILL_MOUNTS_UNSUPPORTED', 'This connected host SDK cannot apply native personal skills; the configuration was not sent');
}
export function withNativeSkills(config: Record<string, unknown>, snapshot: NativeSkillsSnapshot): Record<string, unknown> {
  const intent = nativeSkillsIntent(snapshot);
  return { ...config, skillMounts: intent.mounts, [NATIVE_SKILLS_METADATA]: intent };
}
