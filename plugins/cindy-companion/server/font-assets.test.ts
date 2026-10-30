import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFontChunk } from './font-assets';
import { FONT_CHUNK_BYTES, FONT_MANIFEST, type FontWeightName } from '../shared/font-manifest';
import { CompanionService } from './service';
import { CompanionStore } from './store';
import type { Paseo } from './runtime';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it.each(Object.keys(FONT_MANIFEST) as FontWeightName[])('reconstructs the unchanged official %s TTF from bounded independent chunks', async font => {
  const chunks: Buffer[] = []; let offset: number | null = 0;
  while (offset !== null) {
    const chunk = readFontChunk({ font, offset });
    expect(chunk).toMatchObject({ font, offset, sha256: FONT_MANIFEST[font].sha256, totalBytes: FONT_MANIFEST[font].size });
    expect(Buffer.byteLength(JSON.stringify({ ok: true, value: chunk }))).toBeLessThan(2 * 1024 * 1024);
    const decoded = Buffer.from(chunk.data, 'base64');
    expect(decoded.byteLength).toBe(Math.min(FONT_CHUNK_BYTES, chunk.totalBytes - offset));
    expect(chunk.nextOffset).toBe(offset + decoded.byteLength < chunk.totalBytes ? offset + decoded.byteLength : null);
    chunks.push(decoded); offset = chunk.nextOffset;
  }
  const reconstructed = Buffer.concat(chunks);
  const original = await readFile(join(process.cwd(), 'web/assets/fonts', `HarmonyOS_SansSC_${font}.ttf`));
  expect(reconstructed.equals(original)).toBe(true);
  expect(createHash('sha256').update(reconstructed).digest('hex')).toBe(FONT_MANIFEST[font].sha256);
});

it('rejects unknown fonts, prototype names, paths, user sizes and invalid byte ranges', () => {
  for (const args of [
    { font: '__proto__', offset: 0 }, { font: 'constructor', offset: 0 }, { font: '../Regular', offset: 0 },
    { font: 'Regular', offset: -1 }, { font: 'Regular', offset: 1 }, { font: 'Regular', offset: 0.5 },
    { font: 'Regular', offset: '0' }, { font: 'Regular', offset: NaN }, { font: 'Regular', offset: Infinity },
    { font: 'Regular', offset: Number.MAX_SAFE_INTEGER + 1 }, { font: 'Regular', offset: FONT_MANIFEST.Regular.size },
    { font: 'Regular', offset: Math.ceil(FONT_MANIFEST.Regular.size / FONT_CHUNK_BYTES) * FONT_CHUNK_BYTES },
    { font: 'Regular', offset: 0, path: '/etc/passwd' }, { font: 'Regular', offset: 0, size: 1 },
  ]) expect(() => readFontChunk(args)).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
});

it('uses normal RPC admission and completes an accepted read before close returns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cindy-font-test-')); directories.push(root);
  const service = new CompanionService(new CompanionStore(root)); const paseo = {} as Paseo;
  const accepted = service.invoke({ op: 'assets.fontChunk', args: { font: 'Regular', offset: 0 } }, paseo);
  const cleanup = service.close();
  await expect(accepted).resolves.toMatchObject({ ok: true, value: { font: 'Regular', offset: 0, nextOffset: FONT_CHUNK_BYTES } });
  await cleanup;
  expect(await service.invoke({ op: 'assets.fontChunk', args: { font: 'Regular', offset: 0 } }, paseo)).toMatchObject({ ok: false, code: 'PLUGIN_CLOSED' });
  expect(await readFile(join(root, 'state.json')).then(() => true, () => false)).toBe(false);
});
