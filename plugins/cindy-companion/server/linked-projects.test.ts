import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { CompanionStore } from './store';
import { CompanionProjects, linkedProjectId, registeredProjects } from './linked-projects';
import type { Paseo } from './runtime';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cindy-project-links-')); roots.push(root);
  const store = new CompanionStore(join(root, 'data')); await store.load();
  const dirs = [join(root, 'repo'), join(root, 'worktree-one'), join(root, 'worktree-two')];
  await Promise.all(dirs.map(path => mkdir(path)));
  const project = { projectId: 'p', projectRootPath: dirs[0], projectDisplayName: 'Repo', projectCustomName: 'Named repo' };
  const pages = [[{ id: 'w1', workspaceDirectory: dirs[1], projectRootPath: dirs[0], projectId: 'p', name: 'one' }],
    [{ id: 'w2', workspaceDirectory: dirs[2], projectRootPath: dirs[0], projectId: 'p', name: 'two' }]];
  const list = vi.fn(async (options: any) => ({ entries: options.page.cursor ? pages[1] : pages[0],
    pageInfo: { hasMore: !options.page.cursor, nextCursor: options.page.cursor ? null : 'page-two' } }));
  const api = { projects: { list: vi.fn(async () => ({ projects: [project] })) }, workspaces: { list, open: vi.fn(), create: vi.fn() } };
  return { root, store, dirs, pages, api, paseo: api as unknown as Paseo, projects: new CompanionProjects(store), file: join(store.root, 'bots/cindy/workbench.json') };
}
test('reads every native page without creating workspaces; links individual directories and preserves legacy judgments across reopen', async () => {
  const f = await fixture();
  const tasks = { 'idea:review-link': { title: 'Read source', verdict: 'idea', next: null, project: f.dirs[0], updatedAt: '2026-01-01T00:00:00Z' } };
  await writeFile(f.file, JSON.stringify({ directories: [], tasks }));
  const stateBefore = await readFile(join(f.store.root, 'state.json'));
  let value = await f.projects.list('cindy', f.paseo);
  expect(value.projects.map(item => item.path)).toEqual(f.dirs);
  expect(new Set(value.projects.map(item => item.id)).size).toBe(3);
  expect(value.projects[0].name).toBe('Named repo');
  for (const path of f.dirs) value = await f.projects.set('cindy', f.paseo, { projectId: linkedProjectId({ path }), linked: true, expectedRevision: value.revision });
  const reopened = new CompanionProjects(new CompanionStore(f.store.root));
  value = await reopened.list('cindy', f.paseo);
  expect(value.projects.filter(item => item.linked)).toHaveLength(3);
  value = await reopened.set('cindy', f.paseo, { projectId: linkedProjectId({ path: f.dirs[1] }), linked: false, expectedRevision: value.revision });
  expect(value.projects.filter(item => item.linked).map(item => item.path)).toEqual([f.dirs[0], f.dirs[2]]);
  expect(JSON.parse(await readFile(f.file, 'utf8')).tasks).toEqual(tasks);
  expect(await readFile(join(f.store.root, 'state.json'))).toEqual(stateBefore);
  expect(f.api.workspaces.open).not.toHaveBeenCalled(); expect(f.api.workspaces.create).not.toHaveBeenCalled();
  expect(f.api.workspaces.list).toHaveBeenCalledWith({ includeBackground: true, page: { limit: 200, cursor: 'page-two' } });
});
test('stale editors and lost-response retries cannot reverse a later opposite intent', async () => {
  const f = await fixture(), before = await f.projects.list('cindy', f.paseo), projectId = before.projects[0].id;
  const saved = await f.projects.set('cindy', f.paseo, { projectId, linked: true, expectedRevision: before.revision });
  await f.projects.set('cindy', f.paseo, { projectId, linked: false, expectedRevision: saved.revision });
  await expect(f.projects.set('cindy', f.paseo, { projectId, linked: true, expectedRevision: before.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  expect((await f.projects.list('cindy', f.paseo)).projects[0].linked).toBe(false);
});
test('only one concurrent editor can save the revision it read', async () => {
  const f = await fixture(), before = await f.projects.list('cindy', f.paseo);
  const outcomes = await Promise.allSettled(before.projects.slice(0, 2).map(item => f.projects.set('cindy', f.paseo, { projectId: item.id, linked: true, expectedRevision: before.revision })));
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect((await f.projects.list('cindy', f.paseo)).projects.filter(item => item.linked)).toHaveLength(1);
});
test('missing and remote associations remain removable and remote paths are never treated as local', async () => {
  const f = await fixture(), missing = join(f.root, 'missing'), remote = { path: f.dirs[0], addedAt: 'old', deviceId: 'another-computer' };
  await writeFile(f.file, JSON.stringify({ directories: [remote, { path: missing, addedAt: 'old' }], tasks: {} }));
  let value = await f.projects.list('cindy', f.paseo);
  expect(value.projects.find(item => item.deviceId)).toMatchObject({ linked: true, available: false });
  expect(value.projects.find(item => item.path === missing)).toMatchObject({ linked: true, available: false });
  value = await f.projects.set('cindy', f.paseo, { projectId: linkedProjectId(remote), linked: false, expectedRevision: value.revision });
  expect(value.projects.some(item => item.deviceId)).toBe(false);
  expect(value.projects.find(item => item.path === f.dirs[0])).toMatchObject({ linked: false, available: true });
});
test('catalog excludes missing and background workspace choices and distinguishes colliding directory names', async () => {
  const f = await fixture(), one = join(f.root, 'a/same'), two = join(f.root, 'b/same');
  await mkdir(one, { recursive: true }); await mkdir(two, { recursive: true });
  f.api.projects.list.mockResolvedValue({ projects: [{ ...await f.api.projects.list().then(result => result.projects[0]), projectRootPath: join(f.root, 'missing') }] });
  f.api.workspaces.list.mockResolvedValue({ entries: [one, two].map((path, i) => ({ id: String(i), workspaceDirectory: path, projectRootPath: path, projectId: 'p', name: 'same' })).concat([
    { id: 'hidden', workspaceDirectory: f.dirs[1], projectRootPath: f.dirs[0], projectId: 'p', name: 'hidden', background: true } as any]), pageInfo: { hasMore: false, nextCursor: null } });
  const value = await f.projects.list('cindy', f.paseo);
  expect(value.projects.map(item => item.name)).toEqual(['a/same', 'b/same']);
});
test('corrupt workbench and unsafe symlink reject without replacing saved data', async () => {
  const f = await fixture(); await writeFile(f.file, '{broken');
  await expect(f.projects.list('cindy', f.paseo)).rejects.toThrow(); expect(await readFile(f.file, 'utf8')).toBe('{broken');
  await rm(f.file); const outside = join(f.root, 'outside.json'); await writeFile(outside, '{"directories":[],"tasks":{}}'); await symlink(outside, f.file);
  await expect(f.projects.list('cindy', f.paseo)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  expect(await readFile(outside, 'utf8')).toBe('{"directories":[],"tasks":{}}');
});
test('project rows created by background workspaces do not expose their root as a candidate', async () => {
  const f = await fixture();
  const original = (await f.api.projects.list()).projects[0];
  f.api.projects.list.mockResolvedValue({ projects: [original, { ...original, projectId: 'background-project', projectRootPath: f.dirs[2] }] });
  f.api.workspaces.list.mockResolvedValue({ entries: [
    { id: 'background', projectId: 'background-project', projectRootPath: f.dirs[2], workspaceDirectory: f.dirs[2], name: 'hidden', background: true } as any,
  ], pageInfo: { hasMore: false, nextCursor: null } });
  expect((await f.projects.list('cindy', f.paseo)).projects.map(item => item.path)).toEqual([f.dirs[0]]);
  // Existing explicit links remain visible and removable even after the workspace becomes background.
  await writeFile(f.file, JSON.stringify({ directories: [{ path: f.dirs[2], addedAt: 'old' }], tasks: {} }));
  expect((await f.projects.list('cindy', f.paseo)).projects.find(item => item.path === f.dirs[2])).toMatchObject({ linked: true, available: true });
});
test('inactive/deleting companions and arbitrary client paths cannot obtain a new association', async () => {
  const f = await fixture(), value = await f.projects.list('cindy', f.paseo), input = { projectId: value.projects[0].id, linked: true, expectedRevision: value.revision };
  await expect(f.projects.set('cindy', f.paseo, { ...input, projectId: '/arbitrary/path' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await f.store.transaction(state => { state.profiles.cindy.status = 'paused'; });
  await expect(f.projects.set('cindy', f.paseo, input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  await f.store.transaction(state => { state.profiles.cindy.status = 'active'; state.profileDeletions = { cindy: {} as any }; });
  await expect(f.projects.list('cindy', f.paseo)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await readFile(f.file).then(() => true, () => false)).toBe(false);
});
test('a 51st association fails while existing remote entries remain intact', async () => {
  const f = await fixture(), directories = Array.from({ length: 50 }, (_, i) => ({ path: `remote/${i}`, deviceId: 'remote', addedAt: 'old' }));
  await writeFile(f.file, JSON.stringify({ directories, tasks: {} }));
  const value = await f.projects.list('cindy', f.paseo);
  await expect(f.projects.set('cindy', f.paseo, { projectId: linkedProjectId({ path: f.dirs[0] }), linked: true, expectedRevision: value.revision })).rejects.toThrow('PROJECT_LIMIT');
  expect(JSON.parse(await readFile(f.file, 'utf8')).directories).toEqual(directories);
});
test('catalog failure, repeated cursors and excessive bytes fail explicitly rather than returning partial success', async () => {
  const f = await fixture(); f.api.workspaces.list.mockRejectedValueOnce(new Error('offline'));
  await expect(f.projects.list('cindy', f.paseo)).rejects.toThrow('offline');
  f.api.workspaces.list.mockResolvedValue({ entries: [], pageInfo: { hasMore: true, nextCursor: 'same-page' } });
  await expect(registeredProjects(f.paseo)).rejects.toMatchObject({ code: 'PROJECT_CATALOG_INCOMPLETE' });
  f.api.projects.list.mockResolvedValue({ projects: [{ projectId: 'p', projectRootPath: f.dirs[0], projectDisplayName: 'huge', projectCustomName: 'x'.repeat(600000) }] });
  await expect(registeredProjects(f.paseo)).rejects.toMatchObject({ code: 'PROJECT_CATALOG_TOO_LARGE' });
});
