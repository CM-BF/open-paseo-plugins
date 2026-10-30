import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectCompanionSkillMounts } from './companion-skills-projection';
import { iterateBotSkillRuntimeSummaries } from './vendor/skills/botSkillRuntimeSource';
import type { BotSkillSummary } from './vendor/skills/botSkillStore';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'cindy-skill-mount-projection-')); roots.push(home);
  const root = join(home, 'bots', 'cindy'); await mkdir(root, { recursive: true });
  const add = async (slug: string, entry = 'SKILL.md', disabled = false) => {
    const dir = join(root, disabled ? 'disabled-skills' : 'skills', slug); await mkdir(dir, { recursive: true });
    const file = join(dir, entry), source = `---\nname: ${slug}\ndescription: Use the ${slug} workflow\n---\nRead references/original.txt and run scripts/check.sh\n`;
    await writeFile(file, source); return { dir, file, source };
  };
  const project = () => projectCompanionSkillMounts(root, iterateBotSkillRuntimeSummaries(home, 'cindy'));
  const catalog = async () => (await readFile(join(root, '.runtime-skills/catalog.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as BotSkillSummary);
  return { home, root, add, project, catalog };
}
it('projects a small lowercase skill through the original discovery entrypoint while preserving resources', async () => {
  const f = await fixture(), original = await f.add('lowercase', 'skill.md');
  await mkdir(join(original.dir, 'references')); await writeFile(join(original.dir, 'references/original.txt'), 'unchanged reference');
  await mkdir(join(original.dir, 'scripts')); await writeFile(join(original.dir, 'scripts/check.sh'), '#!/bin/sh\nprintf original\n', { mode: 0o700 });
  const filesBefore = await readdir(original.dir), scriptMode = (await stat(join(original.dir, 'scripts/check.sh'))).mode;
  const projection = await f.project();
  expect(projection.pluginRoot).toBe(join(f.root, '.runtime-skills'));
  expect(projection.skills.map(skill => skill.name)).toEqual(['personal-skill-library']);
  expect((await readdir(projection.skills[0]!.path)).includes('SKILL.md')).toBe(true);
  expect(await f.catalog()).toMatchObject([{ slug: 'lowercase', filePath: original.file, bodyStartLine: 5 }]);
  expect(await readFile(projection.skills[0]!.filePath, 'utf8')).toContain('Resolve all relative resource/script paths against the directory containing that original file');
  expect(await readFile(original.file, 'utf8')).toBe(original.source);
  expect(await readdir(original.dir)).toEqual(filesBefore);
  expect(await readFile(join(original.dir, 'references/original.txt'), 'utf8')).toBe('unchanged reference');
  expect(await readFile(join(original.dir, 'scripts/check.sh'), 'utf8')).toBe('#!/bin/sh\nprintf original\n');
  expect((await stat(join(original.dir, 'scripts/check.sh'))).mode).toBe(scriptMode);
});
it('keeps mixed-case small libraries complete and excludes disabled source paths', async () => {
  const f = await fixture(), lower = await f.add('lower', 'skill.md'), upper = await f.add('upper');
  const disabled = await f.add('disabled', 'skill.md', true);
  const projection = await f.project(), catalog = await f.catalog();
  expect(projection.skills.map(skill => skill.name)).toEqual(['personal-skill-library']);
  expect(new Set(catalog.map(skill => skill.filePath))).toEqual(new Set([lower.file, upper.file]));
  expect(await readFile(disabled.file, 'utf8')).toBe(disabled.source);
  expect(await readFile(upper.file, 'utf8')).toBe(upper.source);
});
it('retains direct native mounts for an ordinary uppercase small shelf', async () => {
  const f = await fixture(), original = await f.add('direct'); const projection = await f.project();
  expect(projection.pluginRoot).toBe(f.root);
  expect(projection.skills).toMatchObject([{ name: 'direct', filePath: original.file, path: original.dir }]);
  expect(await readFile(original.file, 'utf8')).toBe(original.source);
});
it('uses the real filename when an iterator reports the uppercase alias of a lowercase entrypoint', async () => {
  const f = await fixture(), original = await f.add('case-alias', 'skill.md');
  const summaries: BotSkillSummary[] = [];
  for await (const skill of iterateBotSkillRuntimeSummaries(f.home, 'cindy')) summaries.push({ ...skill, filePath: join(skill.dirPath, 'SKILL.md') });
  const projection = await projectCompanionSkillMounts(f.root, summaries);
  expect(projection.pluginRoot).toBe(join(f.root, '.runtime-skills'));
  expect(await f.catalog()).toMatchObject([{ filePath: original.file }]);
  expect(await readdir(original.dir)).toEqual(['skill.md']);
});
it('creates a real empty skills root and never returns a stale discovery mount after disabling the last skill', async () => {
  const f = await fixture();
  expect(await f.project()).toEqual({ pluginRoot: f.root, skills: [] });
  expect((await stat(join(f.root, 'skills'))).isDirectory()).toBe(true);
  const original = await f.add('previous', 'skill.md'); const old = await f.project();
  await mkdir(join(f.root, 'disabled-skills')); await rename(original.dir, join(f.root, 'disabled-skills/previous'));
  expect(await f.project()).toEqual({ pluginRoot: f.root, skills: [] });
  expect(await readFile(join(f.root, '.runtime-skills/catalog.jsonl'), 'utf8')).toBe('');
  expect(await readFile(old.skills[0]!.filePath, 'utf8')).toContain('personal-skill-library');
  expect(await readFile(join(f.root, 'disabled-skills/previous/skill.md'), 'utf8')).toBe(original.source);
});
it('does not pass an explicitly disabled summary to the original projector', async () => {
  const f = await fixture(), original = await f.add('disabled', 'skill.md', true);
  const skill: BotSkillSummary = { slug: 'disabled', name: 'disabled', description: 'disabled', updatedAt: '',
    dirPath: original.dir, filePath: original.file, frontmatterBytes: 40, bodyStartLine: 5, enabled: false };
  expect(await projectCompanionSkillMounts(f.root, [skill])).toEqual({ pluginRoot: f.root, skills: [] });
});
it('rejects a symbolic-link shelf before native projection can enumerate it', async () => {
  const f = await fixture(), outside = join(f.home, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.root, 'skills'));
  await expect(f.project()).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  expect(await readdir(outside)).toEqual([]);
});
