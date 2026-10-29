import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { webDependencyAliases, assertSingleWebRuntime } from '../../scripts/web-bundle-policy.mjs';

const web = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const plugin = path.dirname(web);
const require = createRequire(import.meta.url);

test('original vendor Switch hooks and Radix render with the same React instance as ReactDOM', async () => {
  const bundle = await build({
    absWorkingDir: plugin, bundle: true, write: false, platform: 'node', format: 'cjs',
    jsx: 'automatic', metafile: true, alias: webDependencyAliases(web), nodePaths: [path.join(web, 'node_modules')],
    loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
    stdin: { resolveDir: web, sourcefile: 'vendor-render.tsx', loader: 'tsx', contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { Switch } from '../vendor/renderer/components/ui/switch';
      export const markup = renderToStaticMarkup(<Switch checked aria-label="Use memory" />);
    ` },
    plugins: [{ name: 'vendor-alias', setup(builder) {
      builder.onResolve({ filter: /^@\// }, args => ({ path: path.join(plugin, 'vendor/renderer', `${args.path.slice(2)}.ts`) }));
    } }],
  });
  assertSingleWebRuntime(bundle.metafile, plugin, web, ['react', 'react-dom']);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
  assert.match(module.exports.markup, /role="switch"/);
  assert.match(module.exports.markup, /aria-checked="true"/);
  assert.match(module.exports.markup, /aria-label="Use memory"/);
});

test('bundle guard rejects a second React installation or an unpinned renderer/router', () => {
  for (const name of ['react', 'react-dom', 'react-router', 'react-router-dom']) {
    const meta = { inputs: { [`web/node_modules/${name}/index.js`]: {}, [`node_modules/${name}/index.js`]: {} } };
    assert.throws(() => assertSingleWebRuntime(meta, plugin, web), /must use one web installation/);
  }
});
