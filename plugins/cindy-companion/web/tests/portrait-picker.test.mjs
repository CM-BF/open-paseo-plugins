import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const web = new URL('..', import.meta.url).pathname;
const mocks = {
  popover: `import {createElement} from 'react';const component=name=>({children,...props})=>createElement(name,props,children);export const Root=component('popover-root'),Trigger=component('popover-trigger'),Portal=component('popover-portal'),Content=component('popover-content');`,
  translation: `export const useTranslation=()=>({t:(key,args)=>args?.number ? 'Portrait '+args.number : key});`,
  button: `import {createElement} from 'react';export const Button=({children,...props})=>createElement('button',props,children);`,
  tooltip: `export const Tip=({children})=>children;`,
  confirm: `export const ConfirmDialog=()=>null;`,
  crop: `export const AvatarCropEditor=()=>null;`,
  geometry: `export const initialAvatarCrop=()=>({});`,
  image: `export const loadAvatarSource=()=>{};export const exportAvatarCrop=()=>{};`,
  artwork: `export default 'data:image/png;base64,fixture';`,
};
const result = await build({
  entryPoints: [web + '/../vendor/renderer/features/bots/BotPortraitPicker.tsx'],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'lucide-react'],
  plugins: [{ name: 'portrait-platform-boundary', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => {
      const key = path === '@radix-ui/react-popover' ? 'popover' : path === 'react-i18next' ? 'translation'
        : path.endsWith('/button') ? 'button' : path.endsWith('/tooltip') ? 'tooltip'
        : path.endsWith('/confirm-dialog') ? 'confirm' : path.endsWith('/AvatarCropEditor') ? 'crop'
        : path.endsWith('/avatarCropGeometry') ? 'geometry' : path.endsWith('/avatarCropImage') ? 'image'
        : path.endsWith('.png') ? 'artwork' : null;
      if (key) return { path: key, namespace: 'mock' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: mocks[path] }));
  } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { BotPortraitPicker } = module.exports;

test('actual portrait menu scrolls within Radix available height and preserves its authored geometry', async () => {
  let renderer;
  await act(async () => { renderer = create(React.createElement(BotPortraitPicker, { onChange() {} })); });
  try {
    act(() => renderer.root.findByType('popover-root').props.onOpenChange(true));
    assert.equal(renderer.root.findByType('popover-root').props.open, true);
    const content = renderer.root.findByType('popover-content');
    assert.deepEqual([content.props.align, content.props.sideOffset, content.props.collisionPadding], ['start', 12, 16]);
    const grid = content.findAllByType('div').find(node => node.props.className?.includes('grid-cols-4'));
    assert.equal(grid.props.className, 'grid grid-cols-4 gap-2 min-[400px]:grid-cols-6');
    assert.equal(grid.findAllByType('button').length, 18);
    assert.equal(grid.findAllByType('button').at(-1).props['aria-label'], 'bots.guided.upload');
    const css = await postcss([tailwindcss({
      content: [{ raw: content.props.className, extension: 'html' }], corePlugins: { preflight: false },
    })]).process('@tailwind utilities;', { from: undefined });
    const declarations = new Map();
    css.root.walkDecls(decl => declarations.set(decl.prop, decl.value));
    assert.equal(declarations.get('max-height'), 'var(--radix-popover-content-available-height)');
    assert.equal(declarations.get('overflow-y'), 'auto');
    assert.equal(declarations.get('width'), '360px');
    assert.equal(declarations.get('max-width'), 'calc(100vw - 32px)');
    assert.equal(declarations.has('height'), false);
  } finally { act(() => renderer.unmount()); }
});
