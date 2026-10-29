import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompanionProfile } from '../../shared/contracts';
import type { CompanionStore } from '../store';
import { CompanionError } from '../errors';

/** Only a complete, byte-verified bundled skill is allowed through the runtime adapter. */
export async function verifyPackagedSkills(store: CompanionStore, profile: CompanionProfile) {
  const state = await store.snapshot();
  const receipts = Object.values(state.presetImports ?? {}).filter(receipt => receipt.result.botId === profile.id);
  const supported = new Map<string, string>();
  for (const receipt of receipts) {
    for (const check of receipt.result.checks) {
      if (!check.entryId.startsWith('skill-') || !['copied', 'verified'].includes(check.status)) continue;
      const id = check.entryId.slice(6);
      const files = receipt.files.filter(file => file.skillId === id);
      if (!files.some(file => file.path === `skills/${id}/SKILL.md`)) continue;
      for (const file of files) {
        if (!file.path.startsWith(`skills/${id}/`) || file.path.split('/').some(part => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..'))
          throw new CompanionError('PRESET_SKILL_CHANGED', 'The installed skill receipt contains an invalid path');
        const path = join(profile.homeDir, file.path); await store.safePath(path);
        const bytes = await readFile(path);
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
          throw new CompanionError('PRESET_SKILL_CHANGED', `The imported skill ${id} changed; review it before running`);
      }
      supported.set(id, join(profile.homeDir, 'skills', id, 'SKILL.md'));
    }
  }
  const selected = profile.skills.filter(id => supported.has(id));
  return { supportedSkillIds: [...supported.keys()], ...(selected.length ? {
    systemPromptSuffix: `This teammate has these locally installed Cindy skills. Read the selected skill's SKILL.md before applying it; referenced scripts and resources are relative to that file. Do not execute a skill merely because it is installed. Follow the current user request and native permission rules.\n${selected.map(id => `- ${id}: ${JSON.stringify(supported.get(id))}`).join('\n')}`,
  } : {}) };
}
