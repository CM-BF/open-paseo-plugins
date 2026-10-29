import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { webDependencyAliases, assertSingleWebRuntime } from '../../scripts/web-bundle-policy.mjs';
const web = new URL('..', import.meta.url).pathname, plugin = path.dirname(web.replace(/\/$/, '')), renderer = path.join(plugin, 'vendor/renderer');
const aliases = JSON.parse(await fs.readFile(new URL('../aliases.json', import.meta.url), 'utf8'));

test('all real settings, preset and group surface modules link against one web runtime without server asset imports', async () => {
  const packageAliases = {
    '@cindy/maker-shared/model-route': path.join(plugin, 'vendor/shared/upstream/modelRoute.ts'),
    '@cindy/maker-shared': path.join(plugin, 'vendor/shared/upstream/scheduleInterval.ts'),
    '@cindy/maker-scheduler/cron': path.join(plugin, 'vendor/shared/upstream/cron.ts'),
    '@paseo/frame-storage': path.join(web, 'frame-storage.ts'),
  };
  const result = await build({ entryPoints: [path.join(web, 'app.tsx')], absWorkingDir: plugin,
    alias: webDependencyAliases(web), bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', metafile: true,
    nodePaths: [path.join(web, 'node_modules')], loader: { '.css': 'empty', '.png': 'dataurl', '.jpg': 'dataurl' },
    plugins: [{ name: 'real-surface-seams', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (packageAliases[args.path]) return { path: packageAliases[args.path] };
        if (args.path.startsWith('@cindy-assets/')) return { path: path.join(web, 'assets', args.path.slice(14)) };
        const absolute = args.path.startsWith('@/') ? path.join(renderer, args.path.slice(2)) : args.path.startsWith('.') ? path.resolve(args.resolveDir, args.path) : null;
        if (absolute?.startsWith(renderer + path.sep)) {
          const key = path.relative(renderer, absolute).replace(/\.(tsx?|js)$/, '');
          if (aliases[key]) return { path: path.join(web, 'adapters', aliases[key]) };
        }
        if (args.path.startsWith('@/')) return builder.resolve(absolute, { resolveDir: args.resolveDir, kind: args.kind });
      });
    } }],
  });
  assertSingleWebRuntime(result.metafile, plugin, web, ['react', 'react-dom', 'react-router', 'react-router-dom']);
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.some(value => value.endsWith('BotMarketDialog.tsx')));
  assert.ok(inputs.some(value => value.endsWith('BotGroupCreateDialog.tsx')));
  assert.ok(inputs.some(value => value.endsWith('BotRosterView.tsx')));
  assert.ok(inputs.some(value => value.endsWith('group-chat.tsx')));
  assert.ok(inputs.some(value => value.endsWith('adapters/bot-capability-settings.tsx')));
  assert.ok(inputs.some(value => value.endsWith('personal-skills.ts')));
  assert.equal(inputs.some(value => value.includes('server/presets') || value.includes('font-assets')), false);
});
