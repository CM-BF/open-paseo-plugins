import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const web = new URL('..', import.meta.url).pathname;
const bundled = await build({
  stdin: { contents: `export { observeGroup } from './adapters/group-store';
    export { observeGroupPlans } from './adapters/group-plans';
    export { observeHistory } from './group-history-store';
    export { observeTask } from '../shared/task-observer';`, resolveDir: web },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
  plugins: [{ name: 'rpc-boundary', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)bridge$/ }, () => ({ path: 'bridge', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
      `export const invoke=()=>{throw new Error('Inject the fixture request')};export const post=()=>{};export class BridgeError extends Error{}` }));
  } }],
});

function browserRealm() {
  const context = vm.createContext({ require: createRequire(import.meta.url), module: { exports: {} }, console });
  context.exports = context.module.exports;
  vm.runInContext(`
    const scheduled = new Map(); let sequence = 0;
    globalThis.__timerState = { scheduled, clears: 0, fire() {
      const [id, callback] = scheduled.entries().next().value;
      scheduled.delete(id); callback();
    }};
    // Browser Window timers reject arbitrary object receivers. Node timers do not.
    globalThis.setTimeout = function(callback) {
      'use strict'; if (this !== globalThis) throw new TypeError('Illegal invocation');
      scheduled.set(++sequence, callback); return sequence;
    };
    globalThis.clearTimeout = function(id) {
      'use strict'; if (this !== globalThis) throw new TypeError('Illegal invocation');
      __timerState.clears++; scheduled.delete(id);
    };
  `, context);
  vm.runInContext(bundled.outputFiles[0].text, context);
  return { context, api: context.module.exports, timers: context.__timerState };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const name of ['observeGroup', 'observeGroupPlans', 'observeHistory', 'observeTask']) {
  test(`${name} default timers preserve the browser receiver through poll, refresh and disposal`, async () => {
    const { context, api, timers } = browserRealm();
    assert.throws(() => vm.runInContext('({set:setTimeout}).set(()=>{},0)', context), /Illegal invocation/);
    assert.throws(() => vm.runInContext('({clear:clearTimeout}).clear(1)', context), /Illegal invocation/);
    let reads = 0;
    const read = async () => { reads++; return { revision: reads }; };
    const fail = error => { throw error; };
    const observer = name === 'observeHistory' ? api[name](read, () => {}, fail)
      : name === 'observeTask' ? api[name]({ botId: 'b', taskId: 't', parentAgentId: 'p' }, read, () => {})
      : api[name]('g', () => {}, fail, read);
    await flush();
    assert.equal(reads, 1); assert.equal(timers.scheduled.size, 1);
    vm.runInContext('__timerState.fire()', context); await flush();
    assert.equal(reads, 2); assert.equal(timers.scheduled.size, 1);
    observer.refresh(); await flush();
    assert.equal(reads, 3); assert.equal(timers.scheduled.size, 1);
    assert.ok(timers.clears >= 1);
    observer.dispose();
    assert.equal(timers.scheduled.size, 0);
    observer.refresh(); await flush();
    assert.equal(reads, 3); assert.equal(timers.scheduled.size, 0);
  });
}
