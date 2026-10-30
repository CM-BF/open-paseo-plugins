import { lstat, mkdir, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BotSkillSummary } from './vendor/skills/botSkillStore';
import { projectBotSkillMounts } from './vendor/skills/botSkillRuntimeProjection';
import { throwIpcError } from './errors';

async function exactEntrypoint(skill: BotSkillSummary): Promise<'SKILL.md' | 'skill.md'> {
  let lowercase = false;
  // stat('SKILL.md') also finds skill.md on a case-insensitive filesystem.
  // Inspect real directory entries without retaining a potentially large tree.
  const entries = await opendir(skill.dirPath, { bufferSize: 32 });
  for await (const entry of entries) {
    if (entry.name !== 'SKILL.md' && entry.name !== 'skill.md') continue;
    if (!entry.isFile()) throwIpcError('UNSAFE_PATH', 'Skill entrypoint is not a regular file');
    if (entry.name === 'SKILL.md') return 'SKILL.md';
    lowercase = true;
  }
  if (!lowercase) throwIpcError('PRECONDITION_FAILED', 'Skill entrypoint changed during projection');
  return 'skill.md';
}

/**
 * Run under the companion ownership lock after the usual source/generated-path
 * checks. The upstream projector and original skill/resource bytes stay intact.
 */
export async function projectCompanionSkillMounts(
  root: string,
  skills: Iterable<BotSkillSummary> | AsyncIterable<BotSkillSummary>,
): ReturnType<typeof projectBotSkillMounts> {
  if (!(await lstat(root)).isDirectory()) throwIpcError('UNSAFE_PATH', 'Skill root is not a real directory');
  const directory = join(root, 'skills');
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  if (!(await lstat(directory)).isDirectory()) throwIpcError('UNSAFE_PATH', 'Skill shelf is not a real directory');

  async function* compatibleSkills(): AsyncGenerator<BotSkillSummary> {
    for await (const skill of skills) {
      if (skill.enabled === false) continue;
      // Native mount validation requires the exact uppercase entrypoint. Use the
      // original discovery Skill rather than rename/copy the author's resource tree.
      const entrypoint = await exactEntrypoint(skill);
      yield entrypoint === 'skill.md'
        ? { ...skill, filePath: join(skill.dirPath, entrypoint), requiresDiscovery: true }
        : skill;
    }
  }
  // For an empty shelf the upstream result points at root with skills:[], even
  // when an older discovery directory remains. Never mount that stale directory.
  return projectBotSkillMounts(root, compatibleSkills());
}
