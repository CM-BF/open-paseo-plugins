import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { CompanionStore } from '../store';
import { PresetImports } from './import';
import { readNativeBotPackage } from './catalog';
import { verifyPackagedSkills } from './skills';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cindy-preset-import-')); roots.push(root);
  const store = new CompanionStore(root); await store.load(); return store;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('original preset invitation', () => {
  it('persists a complete invitation once, preserves all skill bytes and keeps routines disabled without creating a host agent', async () => {
    const store = await fixture(); const importer = new PresetImports(store);
    const pkg = await readNativeBotPackage('engineer-bot');
    const input = { ...pkg.identity, locale: 'en' };
    const [first, second] = await Promise.all([importer.invite(input), importer.invite(input)]);
    expect(first).toEqual(second); expect(first.status).toBe('complete'); expect(first.saved).toBe(true);
    const state = await store.snapshot(); const profile = await store.get(first.botId);
    expect(profile.name).toBe(pkg.localized.en.name);
    expect(profile.identitySource).toBe(pkg.snapshot.items.find(item => item.role === 'identity')!.text!.trim());
    expect(profile.skills).toHaveLength(3);
    expect(Object.keys(state.bindings)).toHaveLength(0); expect(Object.keys(state.routines)).toHaveLength(0);
    const drafts = Object.values(state.presetRoutineDrafts ?? {});
    expect(drafts).toHaveLength(1); expect(drafts[0]!.data.enabled).toBe(false);
    for (const item of pkg.snapshot.items.filter(item => item.files)) for (const file of item.files!)
      expect(await readFile(join(profile.homeDir, 'skills', item.view.name, file.name))).toEqual(file.bytes);
    const verified = await verifyPackagedSkills(store, profile);
    expect(verified.supportedSkillIds).toHaveLength(3); expect(verified.systemPromptSuffix).toContain('SKILL.md');
    expect((await importer.list()).find(entry => entry.packageId === pkg.identity.packageId)?.installation?.botId).toBe(first.botId);
    const restored = new PresetImports(new CompanionStore(store.root));
    expect(await restored.status(first.requestId)).toEqual(first);
    await store.update(profile.id, { identitySource: 'Owner-edited identity' });
    const retried = await importer.invite({ ...input, locale: 'ja' });
    expect(retried.botId).toBe(first.botId); expect((await store.get(first.botId)).identitySource).toBe('Owner-edited identity');
    await expect(importer.invite({ ...input, packageHash: '0'.repeat(64) })).rejects.toThrow('changed');
  });

  it('keeps conflicting owner content, exposes partial receipt, retries only the failed item and rejects changed installed skill bytes', async () => {
    const store = await fixture(); const pkg = await readNativeBotPackage('engineer-bot');
    const skill = pkg.snapshot.items.find(item => item.files)!;
    const originalCreate = store.create.bind(store); let blocked = '';
    store.create = async input => {
      const profile = await originalCreate(input);
      blocked = join(profile.homeDir, 'skills', skill.view.name, skill.files![0]!.name);
      await mkdir(dirname(blocked), { recursive: true }); await writeFile(blocked, 'Owner content'); return profile;
    };
    const importer = new PresetImports(store);
    const first = await importer.invite({ ...pkg.identity });
    expect(first.status).toBe('needs-attention'); expect(first.saved).toBe(true);
    expect(first.checks.find(check => check.entryId === skill.view.id)?.status).toBe('needs-attention');
    expect(await readFile(blocked, 'utf8')).toBe('Owner content');
    await rm(blocked);
    const retried = await new PresetImports(store).invite({ ...pkg.identity });
    expect(retried.status).toBe('complete'); expect(retried.botId).toBe(first.botId);
    expect(Object.values((await store.snapshot()).presetRoutineDrafts ?? {})).toHaveLength(1);
    await writeFile(blocked, 'Changed after installation');
    await expect(verifyPackagedSkills(store, await store.get(first.botId))).rejects.toThrow('changed');
  });
});
