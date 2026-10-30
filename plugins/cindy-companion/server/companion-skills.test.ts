import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, stat, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CompanionStore } from './store';
import { CompanionSkills } from './companion-skills';
import type { CompanionSkillMutation } from '../shared/companion-skills';

const observation = vi.hoisted(() => ({ silent: false, reverse: false }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: (...args: Parameters<typeof actual.watch>) => observation.silent
    ? { close() {}, on() { return this; } }
    : actual.watch(...args) };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, opendir: async (...args: Parameters<typeof actual.opendir>) => {
    const directory = await actual.opendir(...args);
    if (!observation.reverse || !/(?:^|\/)(?:skills|disabled-skills)$/.test(String(args[0]))) return directory;
    // Small fixture only: simulate a different OS enumeration order.
    const entries: import('node:fs').Dirent[] = []; for await (const entry of directory) entries.push(entry);
    return { async *[Symbol.asyncIterator]() { yield* entries.reverse(); } };
  } };
});

let root: string, store: CompanionStore, library: CompanionSkills;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cindy-skill-adapter-'));
  store = new CompanionStore(root); await store.load(); library = new CompanionSkills(store);
});
afterEach(async () => { observation.silent = false; observation.reverse = false; vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const create = (operationId = 'save-1'): Extract<CompanionSkillMutation, { kind: 'save' }> => ({ kind: 'save', operationId, slug: 'research',
  name: '资料研究', description: '需要检索资料时使用', body: 'Read references/source.md, then check the facts.', expectedRevision: null });
const operationPath = (id: string, botId = 'cindy') => join(root, 'skill-operations', botId, `${createHash('sha256').update(id).digest('hex')}.json`);
const skillFile = (enabled = true) => join(root, 'bots', 'cindy', enabled ? 'skills' : 'disabled-skills', 'research', 'SKILL.md');
function failCompletedReceipt(instance = library) {
  const target = instance as unknown as { atomic(path: string, value: string, beforePublish?: () => Promise<void>): Promise<void> };
  const original = target.atomic.bind(instance);
  return vi.spyOn(target, 'atomic').mockImplementation(async (path, value, beforePublish) => {
    if (path.includes('skill-operations') && path.endsWith('.json') && JSON.parse(value).phase === 'completed') throw new Error('lost receipt write');
    return original(path, value, beforePublish);
  });
}
test('saves original native metadata with a durable receipt, independently of actual native loading', async () => {
  const receipt = await library.mutate('cindy', create());
  expect(receipt.runtime).toEqual({ status: 'pending', reason: 'native-loading-unverified' });
  const doc = await library.read('cindy', 'research');
  expect(doc).toMatchObject({ name: '资料研究', revision: receipt.revision, enabled: true });
  expect(doc?.source).toContain('name: "research"\n');
  expect(doc?.source).toContain('  displayName: "资料研究"');
  const projection = await library.projection('cindy');
  expect(projection.skills[0].filePath).toBe(skillFile());
  expect(JSON.parse(await readFile(join(projection.pluginRoot, '.claude-plugin/plugin.json'), 'utf8')).name).toBe('cindy-bot-cindy');
  expect(await library.query('cindy', { query: '研究' })).toMatchObject({ total: 1, skills: [{ slug: 'research' }] });
  expect((await library.query('cindy')).skills[0]).not.toHaveProperty('filePath');
});
test('catalog continuations are bound to one index build and reject intervening changes', async () => {
  const saved = await library.mutate('cindy', create());
  await library.mutate('cindy', { ...create('second'), slug: 'second', name: 'Second' });
  const first = await library.query('cindy', { limit: 1 });
  expect(first.nextOffset).toBe(1);
  const next = await library.query('cindy', { offset: first.nextOffset, limit: 1, expectedRevision: first.revision });
  expect(next.revision).toBe(first.revision);
  expect(new Set([...first.skills, ...next.skills].map(skill => skill.slug)).size).toBe(2);
  await library.mutate('cindy', { kind: 'enabled', operationId: 'change-between-pages', slug: 'research', enabled: false, expectedRevision: saved.revision! });
  await expect(library.query('cindy', { offset: 1, limit: 1, expectedRevision: first.revision })).rejects.toMatchObject({ code: 'SKILL_CATALOG_CHANGED' });
  const fresh = await library.query('cindy', { limit: 1 });
  expect(fresh.revision).not.toBe(first.revision);
  expect((await library.query('cindy', { offset: fresh.nextOffset, limit: 1, expectedRevision: fresh.revision })).total).toBe(2);
});
test('native snapshots preserve cache epochs and classify only bounded selected local IDs', async () => {
  const saved = await library.mutate('cindy', create());
  await store.update('cindy', { skills: ['research', 'foreign', 'remote/skill'] });
  const digest = vi.spyOn(library as unknown as { digest(...args: unknown[]): Promise<unknown> }, 'digest');
  const first = await library.nativeSnapshot('cindy'), second = await library.nativeSnapshot('cindy');
  expect(first).toMatchObject({ enabledCount: 1, mounts: [{ directory: join(root, 'bots/cindy') }], localSkillIds: ['research'] });
  expect(first.token).toBe(second.token); expect(digest).not.toHaveBeenCalled(); digest.mockRestore();
  await library.mutate('cindy', { kind: 'enabled', operationId: 'disable-native', slug: 'research', enabled: false, expectedRevision: saved.revision! });
  const disabled = await library.nativeSnapshot('cindy');
  expect(disabled).toMatchObject({ enabledCount: 0, mounts: [], localSkillIds: ['research'] });
  expect(disabled.token).not.toBe(first.token);
});
test('an external body edit changes the native source epoch even when no watch event arrives', async () => {
  observation.silent = true;
  await library.mutate('cindy', create());
  const first = await library.nativeSnapshot('cindy');
  const source = await readFile(skillFile(), 'utf8');
  const digest = vi.spyOn(library as unknown as { digest(...args: unknown[]): Promise<unknown> }, 'digest');
  await writeFile(skillFile(), source + '\nExternal body correction.\n');
  const updated = await library.nativeSnapshot('cindy');
  expect(updated.token).not.toBe(first.token);
  expect((await library.nativeSnapshot('cindy')).token).toBe(updated.token);
  expect(digest).not.toHaveBeenCalled();
  expect(await readFile(skillFile(), 'utf8')).toBe(source + '\nExternal body correction.\n');
});
test('silent watcher metadata distinguishes disabled catalogs and ignores unrelated resource edits', async () => {
  observation.silent = true;
  const saved = await library.mutate('cindy', create());
  const native = await library.nativeSnapshot('cindy');
  await mkdir(join(skillFile(), '../references'), { recursive: true });
  await writeFile(join(skillFile(), '../references/source.md'), 'Resource update only');
  expect((await library.nativeSnapshot('cindy')).token).toBe(native.token);
  await library.mutate('cindy', { kind: 'enabled', operationId: 'disable-for-query', slug: 'research', enabled: false, expectedRevision: saved.revision! });
  const disabledNative = await library.nativeSnapshot('cindy'), before = await library.query('cindy');
  const source = await readFile(skillFile(false), 'utf8');
  await writeFile(skillFile(false), source.replace('资料研究', '新的研究'));
  const changed = await library.query('cindy', { query: '新的研究' });
  expect(changed.revision).not.toBe(before.revision);
  expect(changed.total).toBe(1);
  expect((await library.query('cindy')).revision).toBe(changed.revision);
  expect((await library.nativeSnapshot('cindy')).token).toBe(disabledNative.token);
});
test('silent watcher detects same-size body edits with restored mtime and entrypoint removal', async () => {
  observation.silent = true;
  await library.mutate('cindy', create());
  await utimes(skillFile(), 1_700_000_000, 1_700_000_000);
  const first = await library.nativeSnapshot('cindy'), before = await stat(skillFile(), { bigint: true });
  const source = await readFile(skillFile(), 'utf8');
  await writeFile(skillFile(), source.replace('Read references', 'Scan references'));
  await utimes(skillFile(), 1_700_000_000, 1_700_000_000);
  const after = await stat(skillFile(), { bigint: true });
  expect(after.size).toBe(before.size); expect(after.mtimeNs).toBe(before.mtimeNs); expect(after.ctimeNs).not.toBe(before.ctimeNs);
  const edited = await library.nativeSnapshot('cindy'); expect(edited.token).not.toBe(first.token);
  await rm(skillFile());
  const removed = await library.nativeSnapshot('cindy');
  expect(removed.enabledCount).toBe(0); expect(removed.mounts).toEqual([]); expect(removed.token).not.toBe(edited.token);
});
test('source epochs remain stable when filesystem enumeration order changes', async () => {
  observation.silent = true;
  await library.mutate('cindy', create());
  await library.mutate('cindy', { ...create('second'), slug: 'second', name: 'Second' });
  const first = await library.nativeSnapshot('cindy'), catalog = await library.query('cindy');
  observation.reverse = true;
  expect((await library.nativeSnapshot('cindy')).token).toBe(first.token);
  expect((await library.query('cindy')).revision).toBe(catalog.revision);
});
test('receipt replay after a later edit neither overwrites it nor changes the original result', async () => {
  const first = await library.mutate('cindy', create());
  const source = (await library.read('cindy', 'research'))!.source + '\nLater human edit\n';
  const edited = await library.mutate('cindy', { kind: 'source', operationId: 'edit', slug: 'research', source, expectedRevision: first.revision });
  expect(await new CompanionSkills(new CompanionStore(root)).mutate('cindy', create())).toEqual(first);
  expect((await library.read('cindy', 'research'))?.revision).toBe(edited.revision);
  await expect(library.mutate('cindy', { ...create(), body: 'different' } as CompanionSkillMutation)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
test('lost save receipt reconciles exact published bytes after reopening without rewriting', async () => {
  const fault = failCompletedReceipt();
  await expect(library.mutate('cindy', create())).rejects.toThrow('lost receipt'); fault.mockRestore();
  const source = await readFile(skillFile(), 'utf8'); const before = await stat(skillFile());
  const receipt = await new CompanionSkills(new CompanionStore(root)).mutate('cindy', create());
  expect(receipt.revision).toBe((await library.read('cindy', 'research'))?.revision);
  expect(await readFile(skillFile(), 'utf8')).toBe(source);
  expect((await stat(skillFile())).mtimeMs).toBe(before.mtimeMs);
});
test('uncertain save cannot overwrite an intervening hand edit', async () => {
  const fault = failCompletedReceipt();
  await expect(library.mutate('cindy', create())).rejects.toThrow('lost receipt'); fault.mockRestore();
  await writeFile(skillFile(), 'Human replacement after the lost save receipt');
  await expect(new CompanionSkills(store).mutate('cindy', create())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(await readFile(skillFile(), 'utf8')).toBe('Human replacement after the lost save receipt');
});
test('only one concurrent editor can replace the version it read', async () => {
  const first = await library.mutate('cindy', create());
  const edits = await Promise.allSettled(['one', 'two'].map((body, n) => new CompanionSkills(store).mutate('cindy', {
    ...create(`edit-${n}`), body, expectedRevision: first.revision,
  } as CompanionSkillMutation)));
  expect(edits.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(edits.filter(r => r.status === 'rejected')).toHaveLength(1);
});
test('disabling moves the complete resource directory and removes it from native projection', async () => {
  const first = await library.mutate('cindy', create());
  const script = join(root, 'bots/cindy/skills/research/scripts/check.sh'); await mkdir(join(script, '..'), { recursive: true });
  await writeFile(script, '#!/bin/sh\necho fixture\n', { mode: 0o700 });
  const disabled = await library.mutate('cindy', { kind: 'enabled', operationId: 'disable', slug: 'research', enabled: false, expectedRevision: first.revision! });
  expect(disabled.enabled).toBe(false); expect((await library.projection('cindy')).skills).toEqual([]);
  const moved = join(root, 'bots/cindy/disabled-skills/research/scripts/check.sh');
  expect(await readFile(moved, 'utf8')).toContain('echo fixture'); expect((await stat(moved)).mode & 0o700).toBe(0o700);
  expect((await library.query('cindy')).skills[0]).toMatchObject({ slug: 'research', enabled: false });
  await library.mutate('cindy', { kind: 'enabled', operationId: 'enable', slug: 'research', enabled: true, expectedRevision: disabled.revision! });
  expect(await readFile(script, 'utf8')).toContain('echo fixture');
});
test('a lost deletion receipt verifies its renamed directory and never deletes a replacement', async () => {
  const first = await library.mutate('cindy', create());
  const input = { kind: 'delete' as const, operationId: 'delete', slug: 'research', expectedRevision: first.revision! };
  const fault = failCompletedReceipt(); await expect(library.mutate('cindy', input)).rejects.toThrow('lost receipt'); fault.mockRestore();
  expect(await library.read('cindy', 'research')).toBeNull();
  expect((await new CompanionSkills(store).mutate('cindy', input)).revision).toBeNull();
  const replacement = await library.mutate('cindy', create('replacement'));
  expect((await library.mutate('cindy', input)).revision).toBeNull();
  expect((await library.read('cindy', 'research'))?.revision).toBe(replacement.revision);
  expect(await readdir(join(root, 'skill-operations/cindy'))).not.toContain(`${createHash('sha256').update('delete').digest('hex')}.json.deleted`);
});
test('deletion recovery rejects changed trash instead of claiming it verified', async () => {
  const first = await library.mutate('cindy', create());
  const input = { kind: 'delete' as const, operationId: 'delete', slug: 'research', expectedRevision: first.revision! };
  const fault = failCompletedReceipt(); await expect(library.mutate('cindy', input)).rejects.toThrow('lost receipt'); fault.mockRestore();
  await writeFile(join(`${operationPath('delete')}.deleted`, 'SKILL.md'), 'changed trash');
  await expect(library.mutate('cindy', input)).rejects.toMatchObject({ code: 'SKILL_OPERATION_UNKNOWN' });
});
test('symlink entrypoints and generated catalog directories are rejected before upstream access', async () => {
  await mkdir(join(root, 'bots/cindy/skills/research'), { recursive: true });
  const foreign = join(root, 'foreign'); await writeFile(foreign, 'outside skill'); await symlink(foreign, skillFile());
  await expect(library.read('cindy', 'research')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  await expect(library.query('cindy')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  await rm(skillFile()); await mkdir(join(root, 'foreign-dir')); await symlink(join(root, 'foreign-dir'), join(root, 'bots/cindy/.runtime-skills'));
  await expect(library.projection('cindy')).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  expect(await readFile(foreign, 'utf8')).toBe('outside skill');
});
test('pending profile deletion and missing owners cannot access or mutate another shelf', async () => {
  await library.mutate('cindy', create());
  await expect(library.read('../cindy', 'research')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(library.query('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await store.transaction(state => { state.profileDeletions = { cindy: { requestedAt: Date.now() } }; });
  await expect(library.mutate('cindy', create())).rejects.toMatchObject({ code: 'COMPANION_DELETING' });
  await expect(library.query('cindy')).rejects.toMatchObject({ code: 'COMPANION_DELETING' });
});
test('large original headers remain searchable, disableable and untouched despite editor transport limits', async () => {
  const source = `---\nname: research\ndescription: ${'中'.repeat(400_000)} searchable-tail\n---\nUse references/source.md\n`;
  await mkdir(join(root, 'bots/cindy/skills/research'), { recursive: true }); await writeFile(skillFile(), source);
  await expect(library.read('cindy', 'research')).rejects.toMatchObject({ code: 'SKILL_EDITOR_TOO_LARGE' });
  expect((await library.query('cindy', { query: 'searchable-tail' })).total).toBe(1);
  expect((await library.projection('cindy')).skills[0].name).toBe('personal-skill-library');
  const metadata = await library.inspect('cindy', 'research');
  expect(metadata).toMatchObject({ editable: false, bytes: Buffer.byteLength(source), enabled: true });
  await library.mutate('cindy', { kind: 'enabled', operationId: 'large-disable', slug: 'research', enabled: false,
    expectedRevision: metadata!.revision });
  expect(await readFile(skillFile(false), 'utf8')).toBe(source);
});
test.each(['source', 'enabled', 'delete'] as const)('a hand edit across final %s authorization is preserved', async kind => {
  const first = await library.mutate('cindy', create());
  const common = { operationId: 'barrier', slug: 'research', expectedRevision: first.revision! };
  const input: CompanionSkillMutation = kind === 'source' ? { ...common, kind, source: 'Prepared replacement' }
    : kind === 'enabled' ? { ...common, kind, enabled: false } : { ...common, kind };
  let checks = 0;
  await expect(library.mutate('cindy', input, async () => {
    if (++checks === 3) await writeFile(skillFile(), 'Hand edit while native authorization was in flight');
  })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect(await readFile(skillFile(), 'utf8')).toBe('Hand edit while native authorization was in flight');
});
test('read/query/inspect do not migrate legacy files or rewrite the state journal', async () => {
  const source = '---\nname: Research\ndescription: desc\nupdatedAt: old\n---\nbody';
  await mkdir(join(root, 'bots/cindy/skills/research'), { recursive: true }); await writeFile(skillFile(), source);
  const before = await readFile(join(root, 'state.json'), 'utf8');
  await library.query('cindy'); await library.read('cindy', 'research'); await library.inspect('cindy', 'research');
  expect(await readFile(skillFile(), 'utf8')).toBe(source);
  expect(await readFile(join(root, 'state.json'), 'utf8')).toBe(before);
});
test('the original body bound and mandatory revision are enforced before any mutation receipt', async () => {
  await expect(library.mutate('cindy', { ...create(), body: 'x'.repeat(65537) } as CompanionSkillMutation)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  await expect(library.mutate('cindy', { ...create(), expectedRevision: undefined } as unknown as CompanionSkillMutation)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  expect(await library.read('cindy', 'research')).toBeNull();
});
