import path from 'node:path';
import { CompanionImportError } from './types';

/** Cindy botSkillStore.ts import preflight, without the Electron persistence owner. */
export function validateBotSkillFiles(slug: string,
  files: readonly { name: string; bytes: Buffer; executable: boolean; interpreterLink?: string }[]): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new CompanionImportError('INVALID_PACKAGE');
  const entrypoint = files.find(file => file.name === 'SKILL.md');
  if (!entrypoint?.bytes.length) throw new CompanionImportError('INVALID_PACKAGE');
  for (const file of files) {
    if (file.name.includes('\\') || file.name.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(file.name))
      throw new CompanionImportError('INVALID_PACKAGE');
    // Native bundled packages never contain environment/interpreter links.
    if (file.interpreterLink) throw new CompanionImportError('INVALID_PACKAGE');
  }
}
