import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { compressSettingsHtml } from '../../scripts/compress-settings.mjs';

function environment({ failWrite = false, supported = true } = {}) {
  const messages = [], keys = new Set(); let written = null;
  const nodes = new Map([['loading', {}], ['close-loading', {}]]);
  const body = { children: [], replaceChildren(...children) { this.children = children; for (const child of children) if (child.id) nodes.set(child.id, child); } };
  const document = { body, getElementById: id => nodes.get(id), createElement: tag => ({ tag }),
    open() { nodes.clear(); }, write(html) { if (failWrite) throw new Error('write failed'); written = html; }, close() {} };
  const window = { parent: { postMessage: value => messages.push(value) },
    addEventListener: (_type, fn) => keys.add(fn), removeEventListener: (_type, fn) => keys.delete(fn) };
  return { messages, keys, nodes, body, written: () => written, context: vm.createContext({
    document, window, DecompressionStream: supported ? DecompressionStream : undefined, Response, Blob, Uint8Array, atob,
  }) };
}
const script = html => /<script>([\s\S]*)<\/script>/.exec(html)[1];

test('native DecompressionStream restores exact UTF-8 and removes loading close handlers before original app takes over', async () => {
  const original = '<!doctype html><html><body>你好 🌸<script>window.original=true;</script></body></html>';
  const env = environment();
  const oldClose = env.nodes.get('close-loading');
  const running = vm.runInContext(script(compressSettingsHtml(original)), env.context);
  let prevented = false;
  for (const key of env.keys) key({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(env.messages[0].type, 'close');
  await running;
  assert.equal(env.written(), original); assert.equal(env.keys.size, 0);
  const count = env.messages.length; oldClose.onclick(); assert.equal(env.messages.length, count);
  assert.equal(env.messages.some(message => message.type === 'ready'), false);
});

test('a missing decompressor or write failure leaves a visible error and a working loading-only Close', async () => {
  for (const options of [{ supported: false }, { failWrite: true }]) {
    const env = environment(options);
    await vm.runInContext(script(compressSettingsHtml('<html>original</html>')), env.context);
    assert.match(env.nodes.get('loading').textContent, /Could not load Cindy settings/);
    const close = env.nodes.get('close-loading') ?? env.body.children[0]; close.onclick();
    assert.equal(env.messages.at(-1).type, 'close'); assert.equal(env.keys.size, 1);
  }
});
