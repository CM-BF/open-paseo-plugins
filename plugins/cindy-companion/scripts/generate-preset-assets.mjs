import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Package material stays server-side; the client receives only catalog projections. */
export async function generatePresetAssets(plugin = path.dirname(path.dirname(fileURLToPath(import.meta.url)))) {
  const root = path.join(plugin, 'server/presets/packages');
  const inventory = JSON.parse(await fs.readFile(path.join(plugin, 'server/presets/upstream-files.json'), 'utf8'));
  const expected = new Map(inventory.filter(item => item.destination.startsWith('server/presets/packages/'))
    .map(item => [item.destination.slice('server/presets/packages/'.length), item.sha256]));
  const files = {};
  async function walk(directory, prefix = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('Preset packages cannot contain links');
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${relative}/`);
      else {
        const bytes = await fs.readFile(path.join(directory, entry.name));
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        if (expected.get(relative) !== hash) throw new Error(`Preset source differs from pinned inventory: ${relative}`);
        files[relative] = bytes.toString('base64');
      }
    }
  }
  await walk(root);
  if (Object.keys(files).length !== expected.size) throw new Error('Preset package inventory is incomplete');
  const output = '// Generated from the exact pinned Cindy package bytes. Do not edit.\nexport const PRESET_PACKAGE_FILES: Readonly<Record<string, string>> = Object.freeze(' + JSON.stringify(files) + ');\n';
  const target = path.join(plugin, 'server/presets/packages.generated.ts');
  if (await fs.readFile(target, 'utf8').catch(() => '') !== output) await fs.writeFile(target, output);
  return { files: expected.size, bytes: Buffer.byteLength(output) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await generatePresetAssets());
