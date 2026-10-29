import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { ReviewSourceCache, preparedSourceInstructions, type GitReader } from '../server/review-source';
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'upstream-source-')); roots.push(root);
  const source = join(root, 'source'); await mkdir(source);
  const run = async (args: string[]) => (await exec('git', args)).stdout.trim();
  await run(['init', source]);
  await writeFile(join(source, 'feature.txt'), 'baseline\n');
  await run(['-C', source, 'add', '.']);
  const commit = async () => { await run(['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']); return run(['-C', source, 'rev-parse', 'HEAD']); };
  const baseline = await commit();
  await writeFile(join(source, 'feature.txt'), 'head with added feature\n'); await run(['-C', source, 'add', '.']); const head = await commit();
  let fetches = 0;
  const calls: string[][] = [];
  const transport: GitReader = async args => {
    calls.push([...args]);
    const rewritten = args.map(value => value === 'https://github.com/example/upstream.git' ? source : value);
    if (args.includes('fetch')) fetches++;
    return run(rewritten);
  };
  return { root, source, baseline, head, run, transport, calls, fetches: () => fetches };
}
it('fetches and verifies both exact Git objects once, remains bare, and preserves them across reuse', async () => {
  const f = await fixture(), cache = new ReviewSourceCache(join(f.root, 'cache'), f.transport);
  const input = { repository: 'example/upstream', baseline: f.baseline };
  const [one, two] = await Promise.all([cache.prepare(input, f.head), cache.prepare(input, f.head)]);
  expect(one).toEqual(two); expect(f.fetches()).toBe(2);
  expect(await f.run(['--git-dir', one.gitDir, 'show', `${f.baseline}:feature.txt`])).toBe('baseline');
  expect(await f.run(['--git-dir', one.gitDir, 'show', `${f.head}:feature.txt`])).toBe('head with added feature');
  expect(await f.run(['--git-dir', one.gitDir, 'rev-parse', '--is-bare-repository'])).toBe('true');
  expect(await f.run(['--git-dir', one.gitDir, 'diff', '--name-only', f.baseline, f.head])).toBe('feature.txt');
  expect(f.calls.some(args => args.includes('checkout'))).toBe(false);
  const reopened = new ReviewSourceCache(join(f.root, 'cache'), f.transport);
  expect(await reopened.prepare(input, f.head)).toEqual(one); expect(f.fetches()).toBe(2);
  await expect(readFile(join(one.gitDir, 'feature.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(preparedSourceInstructions(one)).toContain(one.gitDir);
  await cache.close(); await reopened.close();
});
it('does not publish a source witness when fetching or object verification fails', async () => {
  const f = await fixture();
  const cache = new ReviewSourceCache(join(f.root, 'cache'), args => args.includes('fetch') ? Promise.reject(new Error('offline')) : f.transport(args));
  await expect(cache.prepare({ repository: 'example/upstream', baseline: f.baseline }, f.head)).rejects.toThrow('未启动建议 agent');
  const bad = new ReviewSourceCache(join(f.root, 'wrong'), async args => args.includes('cat-file') ? 'blob' : f.transport(args));
  await expect(bad.prepare({ repository: 'example/upstream', baseline: f.baseline }, f.head)).rejects.toThrow('not the requested commit');
  await cache.close(); await bad.close();
});
it('rejects untrusted repository syntax, a redirected cache root, and preparation after close', async () => {
  const f = await fixture(); const linked = join(f.root, 'linked'); await symlink(f.source, linked);
  const cache = new ReviewSourceCache(linked, f.transport);
  expect(() => cache.prepare({ repository: 'https://evil.invalid/repo', baseline: f.baseline }, f.head)).toThrow();
  await expect(cache.prepare({ repository: 'example/upstream', baseline: f.baseline }, f.head)).rejects.toThrow('owned directory');
  expect(f.calls).toEqual([]);
  await cache.close();
  await expect(cache.prepare({ repository: 'example/upstream', baseline: f.baseline }, f.head)).rejects.toThrow('closed');
});
