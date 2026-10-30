import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BOT_PACKAGE_IDS, applyNativeLocale, readNativeBotPackage } from './catalog';
import { PRESET_PACKAGE_FILES } from './packages.generated';
import { localizedBotMarketEntry } from '../../shared/presets';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
describe('original bundled preset packages', () => {
  it('reads complete source packages and keeps exact avatar, skill resources, references and disabled routines', async () => {
    let skillCount = 0, routineCount = 0;
    for (const id of BOT_PACKAGE_IDS) {
      const pkg = await readNativeBotPackage(id);
      const prefix = `${id}/${pkg.identity.packageVersion}/`;
      const manifest = JSON.parse(Buffer.from(PRESET_PACKAGE_FILES[prefix + 'manifest.json']!, 'base64').toString());
      expect(pkg.snapshot.items.find(item => item.role === 'identity')?.text).toBe(manifest.profile.identitySource);
      expect(pkg.entry.avatar).toBe(`data:image/webp;base64,${PRESET_PACKAGE_FILES[prefix + 'assets/avatar.webp']}`);
      for (const skill of pkg.snapshot.items.filter(item => item.view.category === 'skills')) {
        skillCount++;
        const source = manifest.skills.find((value: { slug: string }) => value.slug === skill.view.name);
        const expected = [source.bodyPath, ...source.resources, ...source.scripts];
        expect(skill.files?.length).toBe(expected.length);
        for (const file of skill.files!) {
          const relative = `skills/${skill.view.name}/${file.name}`;
          expect(expected).toContain(relative);
          expect(digest(file.bytes)).toBe(manifest.integrity.files[relative]);
        }
      }
      expect(pkg.snapshot.items.filter(item => item.view.category === 'memory')).toHaveLength(manifest.knowledge.length);
      for (const item of pkg.snapshot.items.filter(item => item.automation)) {
        routineCount++;
        expect(item.automation?.input?.enabled).toBe(false);
        expect(item.automation?.input?.prompt).toBe(manifest.routines.find((routine: { id: string }) => routine.id === item.automation?.sourceId).prompt);
      }
    }
    expect(skillCount).toBe(30); expect(routineCount).toBe(18);
  });

  it('localizes names and starter choices without changing authored identity, file bytes or package identity', async () => {
    const pkg = await readNativeBotPackage('engineer-bot');
    const before = pkg.snapshot.items.find(item => item.role === 'identity')!.text;
    const hash = pkg.identity.packageHash;
    const copy = localizedBotMarketEntry(pkg.entry, 'en-US');
    applyNativeLocale(pkg, 'en-US');
    expect(pkg.snapshot.source.name).toBe(copy.name);
    expect(pkg.snapshot.nativePackage?.opening?.welcome).toBe(copy.welcome);
    expect(pkg.snapshot.nativePackage?.opening?.starterOptions).toEqual(pkg.localized.en.starterOptions);
    expect(pkg.snapshot.items.find(item => item.role === 'identity')!.text).toBe(before);
    expect(pkg.identity.packageHash).toBe(hash);
    expect(localizedBotMarketEntry(pkg.entry, 'zh-CN').name).toBe(pkg.entry.name);
  });

  it('contains only inventory-verified source bytes and rejects unknown package paths', async () => {
    const inventory = JSON.parse(await readFile(fileURLToPath(new URL('./upstream-files.json', import.meta.url)), 'utf8')) as Array<{ destination: string; sha256: string }>;
    const sourceFiles = inventory.filter(item => item.destination.startsWith('server/presets/packages/'));
    expect(Object.keys(PRESET_PACKAGE_FILES)).toHaveLength(sourceFiles.length);
    for (const file of sourceFiles) {
      const relative = file.destination.slice('server/presets/packages/'.length);
      expect(digest(Buffer.from(PRESET_PACKAGE_FILES[relative]!, 'base64'))).toBe(file.sha256);
    }
    await expect(readNativeBotPackage('../engineer-bot')).rejects.toThrow('INVALID_PACKAGE');
    await expect(readNativeBotPackage('https://example.com/catalog')).rejects.toThrow('INVALID_PACKAGE');
  });
});
