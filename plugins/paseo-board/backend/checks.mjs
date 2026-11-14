import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeApp } from './scaffold.mjs';
import { loadApp, readJson, digest, exists } from './files.mjs';
import { migrate, openDatabase, backup, restore } from './storage.mjs';
import { startApp } from './server.mjs';
import { addressKey, anchorProblem, COMMENT_LIMITS, commentSettings, createCommentLimiter, normalizeCommentInput, resolveClient } from './comments.mjs';
import { createSshPlan, validatedPlan, shellQuote, runSsh, controllerCommand } from './ssh.mjs';
import { mountComments } from './visitor.mjs';
import { createLive } from './live.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
async function fixture(t, change = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'board-app-check-'));
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await fs.rm(directory, { recursive: true, force: true }); });
  const root = path.join(directory, 'app'); await initializeApp(root, 'test-app');
  const config = await readJson(path.join(root, 'board-app.json'));
  await fs.writeFile(path.join(root, 'board-app.json'), JSON.stringify({ ...config, port: 0, ...change }));
  const app = await loadApp(root); app.testCleanup = cleanup;
  return { directory, root, app, cleanup };
}
async function startTracked(app) { const instance = await startApp(app); app.testCleanup.push(instance.close); return instance; }
/** Starts the app again after board-app.json changed on disk, sharing the test's cleanup. */
async function reloadTracked(app) { const next = await loadApp(app.root); next.testCleanup = app.testCleanup; return startTracked(next); }

test('init yields a standalone editable backend, refuses existing contents and keeps durable data outside source', async t => {
  const { directory, root, app } = await fixture(t);
  assert.equal(app.dataDir, path.join(directory, 'app-data'));
  await assert.rejects(initializeApp(root, 'test-app'), /empty directory/);
  await fs.writeFile(path.join(root, 'routes.mjs'), 'export function route({json,url}) { if(url.pathname!=="/my-own-api")return false; json(200,{custom:true}); return true; }');
  const server = await startTracked(app);
  const response = await fetch(`http://127.0.0.1:${server.port}/my-own-api`);
  assert.deepEqual(await response.json(), { custom: true });
  await assert.rejects(migrate(app), /Stop this app/);
});

test('all pending migration DDL and history roll back on error; immutable history cannot be rewritten', async t => {
  const { app, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'migrations/002-broken.sql'), 'CREATE TABLE partial (id INTEGER); INSERT INTO missing_table VALUES (1);');
  await assert.rejects(migrate(app), /missing_table/);
  let db = openDatabase(app.database);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('records','partial','_board_migrations')").get().n, 0); db.close();
  await fs.unlink(path.join(root, 'migrations/002-broken.sql'));
  assert.deepEqual((await migrate(app)).applied, ['001-records.sql']);
  await fs.appendFile(path.join(root, 'migrations/001-records.sql'), '\n-- changed');
  await assert.rejects(migrate(app), /Applied migration changed/);
  await fs.writeFile(path.join(root, 'migrations/003-escape.sql'), 'COMMIT; CREATE TABLE escaped (id INTEGER);');
  await assert.rejects(migrate(app), /transaction or connection control/);
  await fs.writeFile(path.join(root, 'migrations/003-escape.sql'), "SELECT '--'; COMMIT; CREATE TABLE escaped (id INTEGER);");
  await assert.rejects(migrate(app), /transaction or connection control/);
});

test('online SQLite backup includes committed WAL; restore verifies digest, preserves safety copy and rejects running apps', async t => {
  const { app, directory } = await fixture(t);
  await migrate(app);
  const writer = openDatabase(app.database); t.after(() => { try { writer.close(); } catch {} });
  writer.exec('PRAGMA wal_autocheckpoint=0'); writer.prepare('INSERT INTO records VALUES (?, ?, ?)').run('saved', 'in WAL', '2026-11-08');
  assert.ok((await fs.stat(`${app.database}-wal`)).size > 0);
  const saved = await backup(app, path.join(directory, 'snapshot.sqlite'));
  const check = openDatabase(saved.file, { readOnly: true }); assert.equal(check.prepare('SELECT title FROM records').get().title, 'in WAL'); check.close();
  writer.prepare('INSERT INTO records VALUES (?, ?, ?)').run('later', 'later row', '2026-11-09'); writer.close();
  const server = await startApp(app);
  await assert.rejects(restore(app, saved.file, saved.sha256), /Stop this app/); await server.close();
  await assert.rejects(restore(app, saved.file, 'wrong'), /identity\/digest/);
  const result = await restore(app, saved.file, saved.sha256); assert.ok(result.safetyBackup);
  const restored = openDatabase(app.database); assert.equal(restored.prepare('SELECT count(*) AS n FROM records').get().n, 1); restored.close();
  await assert.rejects(backup(app, saved.file), /already exists/);
});

test('migration SQL cannot erase or rewrite the framework history while recording itself as successful', async t => {
  const { app, root } = await fixture(t); await migrate(app);
  await fs.writeFile(path.join(root, 'migrations/002-clear-history.sql'), 'DELETE FROM _board_migrations; CREATE TABLE second(id INTEGER);');
  await assert.rejects(migrate(app), /protected migration history/);
  const db = openDatabase(app.database);
  assert.deepEqual(db.prepare('SELECT name FROM _board_migrations').all().map(row => row.name), ['001-records.sql']);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='second'").get().n, 0); db.close();
  await fs.writeFile(path.join(root, 'migrations/002-clear-history.sql'), "UPDATE _board_migrations SET applied_at='forged';");
  await assert.rejects(migrate(app), /protected migration history/);
});

test('HTTP exact origins and public config separate public content from server secrets', async t => {
  const { app, root } = await fixture(t, { origins: ['https://pages.example.internal'], public: { apiBase: 'https://api.example.internal' } });
  await fs.writeFile(path.join(root, '.env'), 'SERVER_SECRET=not-for-visitors');
  const server = await startTracked(app); const base = `http://127.0.0.1:${server.port}`;
  const denied = await fetch(`${base}/api/records`, { headers: { origin: 'https://evil.example' } }); assert.equal(denied.status, 403);
  const preflight = await fetch(`${base}/api/records`, { method: 'OPTIONS', headers: { origin: 'https://pages.example.internal' } }); assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://pages.example.internal');
  assert.deepEqual(await fetch(`${base}/public-config.json`).then(r => r.json()), { apiBase: 'https://api.example.internal' });
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/_board/comments`)).status, 404);
  assert.equal((await fetch(`${base}/_board/shutdown`, { method: 'POST' })).status, 403);
  const post = await fetch(`${base}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Editable schema example' }) }); assert.equal(post.status, 201);
  assert.equal((await fetch(`${base}/api/records`).then(r => r.json())).records.length, 1);
});

test('native comment export is explicit, idempotent, bounded and durable across restart with stable deployment identity', async t => {
  const original = process.env.BOARD_INBOX_EXPORT_TOKEN;
  t.after(() => { if (original === undefined) delete process.env.BOARD_INBOX_EXPORT_TOKEN; else process.env.BOARD_INBOX_EXPORT_TOKEN = original; });
  delete process.env.BOARD_INBOX_EXPORT_TOKEN;
  const { app, directory } = await fixture(t, { comments: { enabled: true } });
  let server = await startTracked(app);
  let base = `http://127.0.0.1:${server.port}`;
  const input = { text: 'An external comment', authorName: 'Self-reported author', pageUrl: 'https://pages.example/internal', anchor: { selector: '#chart', label: 'Chart' } };
  const post = (key, body) => fetch(`${base}/_board/comments`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/_board/comments`)).status, 404);
  const first = await post('first-intent', input).then(r => r.json());
  const replay = await post('first-intent', input).then(r => r.json()); assert.deepEqual(replay.comment, first.comment); assert.equal(replay.replayed, true);
  assert.equal((await post('first-intent', { text: 'Changed body' })).status, 409);
  assert.equal((await post('overlong-intent', { text: 'x'.repeat(8001) })).status, 400);
  assert.equal((await post('bad-anchor-intent', { text: 'x', anchor: { secret: 'x' } })).status, 400);
  await post('second-intent', { text: 'Second comment' });
  process.env.BOARD_INBOX_EXPORT_TOKEN = 'e'.repeat(48);
  assert.equal((await fetch(`${base}/_board/comments`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const headers = { authorization: `Bearer ${process.env.BOARD_INBOX_EXPORT_TOKEN}` };
  const firstPage = await fetch(`${base}/_board/comments?cursor=0&limit=1`, { headers }).then(r => r.json()); assert.equal(firstPage.comments.length, 1); assert.deepEqual(firstPage.comments[0], first.comment);
  const deployment = server.deploymentId; await server.close(); server = await startTracked(app); base = `http://127.0.0.1:${server.port}`;
  assert.equal(server.deploymentId, deployment);
  const second = await fetch(`${base}/_board/comments?cursor=${firstPage.nextCursor}&limit=1`, { headers }).then(r => r.json()); assert.equal(second.comments[0].text, 'Second comment');
  assert.equal((await post('first-intent', input).then(r => r.json())).comment.externalId, first.comment.externalId);
  const empty = await fetch(`${base}/_board/comments?cursor=${second.nextCursor}`, { headers }).then(r => r.json()); assert.equal(empty.nextCursor, second.nextCursor); assert.deepEqual(empty.comments, []);
  const saved = await backup(app, path.join(directory, 'comments.sqlite'));
  await post('third-intent', { text: 'Seen before restore' }); await server.close();
  const sameStream = await restore(app, saved.file, saved.sha256); assert.equal(sameStream.newCommentSourceRequired, false);
  server = await startTracked(app); base = `http://127.0.0.1:${server.port}`;
  await post('after-restore-intent', { text: 'New after restore' });
  const afterRestore = await fetch(`${base}/_board/comments?cursor=3`, { headers }).then(r => r.json());
  assert.equal(afterRestore.comments[0].text, 'New after restore'); assert.equal(afterRestore.deploymentId, deployment);
  await server.close();
  await fs.unlink(path.join(app.dataDir, 'identity.json'));
  const coldRestore = await restore(app, saved.file, saved.sha256); assert.equal(coldRestore.newCommentSourceRequired, true);
  server = await startTracked(app); assert.notEqual(server.deploymentId, deployment);
});

test('SSH plan binds exact source and target, excludes private files and quotes shell arguments', async t => {
  const { root, directory } = await fixture(t);
  const file = path.join(directory, 'plan.json');
  await assert.rejects(createSshPlan({ dir: root, host: '-oProxyCommand=bad', root: '/srv/apps/example', out: file }), /SSH config alias/);
  const plan = await createSshPlan({ dir: root, host: 'example', root: '/srv/apps/example', out: file });
  assert.ok(plan.files.some(row => row.path === 'routes.mjs')); assert.ok(!plan.files.some(row => row.path.startsWith('.env')));
  assert.equal((await validatedPlan(file)).sha256, plan.sha256);
  assert.equal(shellQuote("a'$(touch /tmp/no)"), "'a'\\''$(touch /tmp/no)'");
  await fs.appendFile(path.join(root, 'routes.mjs'), '\n// source changed');
  await assert.rejects(validatedPlan(file), /Source files changed/);
  const config = await readJson(path.join(root, 'board-app.json')); config.deployFiles.push('.env'); await fs.writeFile(path.join(root, '.env'), 'SECRET=private'); await fs.writeFile(path.join(root, 'board-app.json'), JSON.stringify(config));
  await assert.rejects(createSshPlan({ dir: root, host: 'example', root: '/srv/apps/example', out: path.join(directory, 'private-plan.json') }), /Private\/runtime file/);
});

test('optional visitor form retries one frozen intent after lost acknowledgement and DOM remount, creating one real comment', async t => {
  const { parseHTML } = await import('linkedom');
  const { app, root } = await fixture(t, { comments: { enabled: true } });
  assert.ok(await exists(path.join(root, 'public/board-comments.js')));
  const server = await startTracked(app);
  const { window, document } = parseHTML('<html><body><main id="comments"></main></body></html>');
  const storage = new Map(); window.sessionStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const originalFetch = globalThis.fetch; let loseAcknowledgement = true;
  globalThis.fetch = async (...args) => { const response = await originalFetch(...args); if (loseAcknowledgement) { loseAcknowledgement = false; await response.text(); throw new Error('simulated lost acknowledgement'); } return response; };
  t.after(() => { globalThis.fetch = originalFetch; });
  const target = document.querySelector('#comments'), settings = { apiBase: `http://127.0.0.1:${server.port}`, pageUrl: 'https://pages.example/app', anchor: { selector: '#chart' } };
  let widget = mountComments(target, settings);
  assert.equal(widget.form.querySelector('p').textContent, '评论会发给页面作者，可能由作者的 AI 助手处理。姓名为自报。');
  widget.form.querySelector('textarea').value = 'A visitor requests a chart change'; widget.form.querySelector('input').value = 'A self-reported visitor';
  const settled = async predicate => { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Visitor form did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  widget.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settled(() => widget.form.querySelector('[role=status]').textContent.includes('尚未确认送达'));
  const stored = [...storage.values()][0]; assert.ok(stored); assert.equal(widget.form.querySelector('textarea').readOnly, true);
  widget.destroy(); widget = mountComments(target, settings);
  assert.equal(widget.form.querySelector('button').textContent, '重试这条评论');
  widget.form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settled(() => widget.form.querySelector('[role=status]').textContent.includes('已进入内部收件箱'));
  assert.equal(storage.size, 0); assert.equal(server.db.prepare('SELECT count(*) AS n FROM _board_comments').get().n, 1);
  assert.equal(server.db.prepare('SELECT text FROM _board_comments').get().text, 'A visitor requests a chart change');
  widget.destroy(); assert.equal(target.children.length, 0);
});

test('visitor request and storage adapters retain one intent through a published-style bridge and state remount', async t => {
  const { parseHTML } = await import('linkedom');
  const { app } = await fixture(t, { comments: { enabled: true } });
  const server = await startTracked(app);
  const { document, window } = parseHTML('<html><body><main id="comments"></main></body></html>');
  let state = { unrelated: 'keep this visitor setting' }, nativeStorageCalls = 0;
  window.sessionStorage = { getItem() { nativeStorageCalls++; throw new Error('Opaque iframe storage unavailable'); } };
  const board = { getState: () => structuredClone(state), saveState: value => { state = structuredClone(value); } };
  const storage = {
    getItem(key) { return board.getState().commentIntents?.[key] ?? null; },
    setItem(key, value) { const current = board.getState(); board.saveState({ ...current, commentIntents: { ...current.commentIntents, [key]: value } }); },
    removeItem(key) { const current = board.getState(), intents = { ...current.commentIntents }; delete intents[key]; board.saveState({ ...current, commentIntents: intents }); },
  };
  const calls = [], fetchHttp = globalThis.fetch; let loseAcknowledgement = true;
  globalThis.fetch = () => { throw new Error('Direct fetch must not be used by this bridge-backed form'); };
  t.after(() => { globalThis.fetch = fetchHttp; });
  const request = async (url, options) => {
    calls.push({ url, ...structuredClone(options) }); const response = await fetchHttp(url, options), result = await response.json();
    if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('Bridge acknowledgement lost'); }
    return { status: response.status, ok: response.ok, json: async () => result };
  };
  const settings = { apiBase: `http://127.0.0.1:${server.port}`, pageUrl: 'https://pages.example/published', storage, request };
  const target = document.querySelector('#comments'); let widget = mountComments(target, settings);
  widget.form.querySelector('textarea').value = 'From a published Board';
  const settled = async predicate => { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Visitor bridge did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  widget.form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settled(() => widget.form.querySelector('[role=status]').textContent.includes('尚未确认送达'));
  const frozen = structuredClone(state.commentIntents); assert.equal(Object.keys(frozen).length, 1);
  widget.destroy(); widget = mountComments(target, settings);
  assert.equal(widget.form.querySelector('textarea').value, 'From a published Board');
  widget.form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settled(() => widget.form.querySelector('[role=status]').textContent.includes('已进入内部收件箱'));
  assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(state, { unrelated: 'keep this visitor setting', commentIntents: {} });
  assert.equal(nativeStorageCalls, 0); assert.equal(server.db.prepare('SELECT count(*) AS n FROM _board_comments').get().n, 1);
  widget.destroy();
});

test('SSH execution requires review confirmation and passes strict flags and verified files without a real remote connection', async t => {
  const { root, directory } = await fixture(t);
  const bin = path.join(directory, 'bin'), capture = path.join(directory, 'ssh.json'); await fs.mkdir(bin);
  const fake = path.join(bin, 'ssh');
  const fakeScript = path.join(bin, 'fake.cjs');
  await fs.writeFile(fakeScript, "const fs=require('node:fs');let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{fs.writeFileSync(process.env.BOARD_TEST_CAPTURE,JSON.stringify({argv:process.argv.slice(2),payload:JSON.parse(body)}));console.log('verified-fake-ssh')});");
  await fs.writeFile(fake, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeScript)} "$@"\n`, { mode: 0o700 });
  const previousPath = process.env.PATH, previousCapture = process.env.BOARD_TEST_CAPTURE;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`; process.env.BOARD_TEST_CAPTURE = capture;
  try {
    const planFile = path.join(directory, 'plan.json'), plan = await createSshPlan({ dir: root, host: 'internal-alias', root: '/srv/owned/app', out: planFile });
    await assert.rejects(runSsh('deploy', { plan: planFile }, { executable: fake }), /Mutation requires/); assert.equal(await exists(capture), false);
    await runSsh('deploy', { plan: planFile, confirm: plan.sha256 }, { executable: fake });
    const sent = await readJson(capture); assert.deepEqual(sent.argv.slice(0, 8), ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '--', 'internal-alias']);
    assert.equal(sent.argv[8], controllerCommand('node', await fs.readFile(path.join(here, 'remote.mjs'), 'utf8')));
    assert.ok(sent.payload.files.length); assert.ok(sent.payload.files.every(row => digest(Buffer.from(row.content, 'base64')) === row.sha256));
    assert.equal(sent.payload.files.some(row => row.path.startsWith('.env')), false);
    await fs.appendFile(path.join(root, 'routes.mjs'), '\n// work continues after deployment');
    await runSsh('status', { plan: planFile }, { executable: fake });
    await runSsh('stop', { plan: planFile, confirm: plan.sha256 }, { executable: fake });
    assert.equal((await readJson(capture)).payload.operation, 'stop');
    await assert.rejects(runSsh('deploy', { plan: planFile, confirm: plan.sha256 }, { executable: fake }), /Source files changed/);
  } finally { process.env.PATH = previousPath; if (previousCapture === undefined) delete process.env.BOARD_TEST_CAPTURE; else process.env.BOARD_TEST_CAPTURE = previousCapture; }
});

test('the actual generated SSH command preserves controller source and stdin through POSIX, Zsh and Fish login shells', async t => {
  const run = (shell, flags, source, input) => new Promise((resolve, reject) => {
    const child = spawn(shell, [...flags, '-c', controllerCommand(process.execPath, source)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
  const difficultText = 'single\' double" backslash\\ dollar$(echo MUST_NOT_EXECUTE) `echo MUST_NOT_EXECUTE`\n中文';
  const source = `import { createHash } from 'node:crypto';\nlet input = ''; for await (const chunk of process.stdin) input += chunk;\nconst value = ${JSON.stringify(difficultText)};\nconsole.log(JSON.stringify({value, input:JSON.parse(input), hash:createHash('sha256').update(value).digest('hex')}));\n`;
  const actualController = await fs.readFile(path.join(here, 'remote.mjs'), 'utf8');
  const shells = [['/bin/sh', []], ['/bin/zsh', ['-f']], ['/opt/homebrew/bin/fish', ['--no-config']], ['/usr/bin/fish', ['--no-config']]];
  for (const [shell, flags] of shells) {
    if (!(await exists(shell))) continue;
    await t.test(shell, async () => {
      const result = await run(shell, flags, source, JSON.stringify({ transport: 'stdin remains separate', quote: difficultText }));
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { value: difficultText, input: { transport: 'stdin remains separate', quote: difficultText }, hash: digest(difficultText) });
      const actual = await run(shell, flags, actualController, '{}');
      assert.equal(actual.code, 1); assert.equal(actual.stdout, '');
      assert.deepEqual(JSON.parse(actual.stderr), { status: 'failed-reconcile-before-retry', error: 'Invalid deployment request' });
    });
  }
});

function control(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, 'remote.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk); child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(payload));
  });
}

test('the local CLI status/stop can control an app bound to IPv6 loopback', async t => {
  const { app, root } = await fixture(t, { host: '::1' });
  const server = await startTracked(app);
  const run = command => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'board-app.mjs'), command, '--dir', root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk); child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  let result = await run('status'); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'running');
  result = await run('stop'); assert.equal(result.code, 0, result.stderr); await server.close();
});

test('real remote controller on local isolated root deploys, preserves data/identity, backs up and stops only its owned service', async t => {
  const { root, directory, app, cleanup } = await fixture(t, { comments: { enabled: true } });
  const planFile = path.join(directory, 'deploy.json'); await createSshPlan({ dir: root, host: 'unused-no-ssh', root: path.join(directory, 'remote'), out: planFile });
  const plan = await validatedPlan(planFile);
  const payload = { operation: 'deploy', root: plan.remoteRoot, appId: app.owner.id, owner: app.owner.owner, release: plan.sha256, node: process.execPath, files: await Promise.all(plan.files.map(async row => ({ ...row, content: (await fs.readFile(path.join(root, row.path))).toString('base64') }))) };
  let cleanupPayload = payload;
  cleanup.push(async () => { const result = await control({ ...cleanupPayload, files: [], operation: 'stop' }); assert.equal(result.code, 0, result.stderr); });
  let result = await control(payload); assert.equal(result.code, 0, `${result.stderr}\n${await fs.readFile(path.join(payload.root, 'shared/app.log'), 'utf8').catch(() => 'No app log')}`);
  const receipt = JSON.parse(result.stdout), port = receipt.health.port, deploymentId = receipt.health.deploymentId;
  const url = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${url}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Survives deploy' }) })).status, 201);
  result = await control({ ...payload, files: [], operation: 'backup' }); assert.equal(result.code, 0, result.stderr); assert.ok(JSON.parse(result.stdout).sha256);
  result = await control({ ...payload, files: [], operation: 'stop', owner: '00000000-0000-0000-0000-000000000000' }); assert.equal(result.code, 1); assert.match(result.stderr, /owner mismatch/); assert.equal((await fetch(`${url}/_board/health`)).status, 200);
  await fs.appendFile(path.join(root, 'routes.mjs'), '\n// version two');
  const secondPlanFile = path.join(directory, 'deploy2.json'); await createSshPlan({ dir: root, host: 'unused-no-ssh', root: payload.root, out: secondPlanFile }); const second = await validatedPlan(secondPlanFile);
  const next = { ...payload, release: second.sha256, files: await Promise.all(second.files.map(async row => ({ ...row, content: (await fs.readFile(path.join(root, row.path))).toString('base64') }))) };
  cleanupPayload = next;
  result = await control(next); assert.equal(result.code, 0, result.stderr); const updated = JSON.parse(result.stdout); assert.equal(updated.health.deploymentId, deploymentId); assert.ok(updated.previousBackup);
  assert.equal((await fetch(`http://127.0.0.1:${updated.health.port}/api/records`).then(r => r.json())).records[0].title, 'Survives deploy');
  result = await control({ ...next, operation: 'stop', files: [] }); assert.equal(result.code, 0, result.stderr);
  assert.equal(await exists(path.join(payload.root, 'shared/data/runtime.lock')), false);
  result = await control({ ...next, operation: 'start', files: [] }); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).health.deploymentId, deploymentId);
  result = await control({ ...payload, operation: 'stop', files: [] }); assert.equal(result.code, 1); assert.match(result.stderr, /current release plan/);
  result = await control({ ...next, operation: 'stop', files: [] }); assert.equal(result.code, 0, result.stderr);
  assert.equal((await fs.readdir(path.join(payload.root, 'releases'))).filter(x => !x.endsWith('.partial')).length, 2);
  await fs.writeFile(path.join(root, 'routes.mjs'), 'throw new Error("Deliberately broken new release");');
  await fs.writeFile(path.join(root, 'migrations/002-upgrade.sql'), 'CREATE TABLE upgrade_survives_failure (id INTEGER);');
  const brokenPlanFile = path.join(directory, 'broken.json'); await createSshPlan({ dir: root, host: 'unused-no-ssh', root: payload.root, out: brokenPlanFile }); const broken = await validatedPlan(brokenPlanFile);
  result = await control({ ...next, release: broken.sha256, files: await Promise.all(broken.files.map(async row => ({ ...row, content: (await fs.readFile(path.join(root, row.path))).toString('base64') }))) });
  assert.equal(result.code, 1); assert.match(result.stderr, /exited with code/);
  assert.equal((await readJson(path.join(payload.root, 'current.json'))).release, next.release);
  assert.ok(await exists(path.join(payload.root, 'releases', broken.sha256)));
  const preserved = openDatabase(path.join(payload.root, 'shared/data/app.sqlite')); assert.ok(preserved.prepare("SELECT 1 FROM sqlite_master WHERE name='upgrade_survives_failure'").get()); preserved.close();
  assert.equal(await exists(path.join(payload.root, 'shared/data/runtime.lock')), false);
});

const LIVE = { token: 'l'.repeat(48), channel: `c${'a'.repeat(32)}`, other: `c${'b'.repeat(32)}`, digest: 'd'.repeat(64), changed: 'e'.repeat(64), page: 'https://pages.example.internal' };
const liveHeaders = { authorization: `Bearer ${LIVE.token}`, 'content-type': 'application/json' };
function setLiveToken(t, value = LIVE.token) {
  const original = process.env.BOARD_LIVE_WRITE_TOKEN;
  t.after(() => { if (original === undefined) delete process.env.BOARD_LIVE_WRITE_TOKEN; else process.env.BOARD_LIVE_WRITE_TOKEN = original; });
  if (value === null) delete process.env.BOARD_LIVE_WRITE_TOKEN; else process.env.BOARD_LIVE_WRITE_TOKEN = value;
}
const livePut = (base, channel, deploymentId, seq, digest, value, headers = liveHeaders) => fetch(`${base}/_board/live/${channel}`, { method: 'PUT', headers, body: JSON.stringify({ deploymentId, seq, digest, ...(value === undefined ? {} : { value }) }) });
const liveDelete = (base, channel, seq, headers = liveHeaders) => fetch(`${base}/_board/live/${channel}?seq=${seq}`, { method: 'DELETE', headers });
const liveGet = (base, channel, query = '', headers = {}) => fetch(`${base}/_board/live/${channel}${query}`, { headers });
const boardLive = response => Object.fromEntries(response.headers.get('board-live').split(', ').map(part => part.split('=')));

/** Calls the live module directly so time, file and SQLite access can be observed. */
async function liveDirect(t, change) {
  setLiveToken(t);
  const made = await fixture(t, change), clock = { now: 1_800_000_000_000 }, deploymentId = '11111111-1111-4111-8111-111111111111';
  return { ...made, clock, deploymentId, open: () => createLive(made.app, deploymentId, { now: () => clock.now }) };
}
async function directCall(live, { method = 'GET', pathname, headers = {}, body }) {
  const result = { status: 0, headers: {}, payload: undefined, data: undefined, bodyReads: 0 };
  const response = {
    setHeader(name, value) { result.headers[name.toLowerCase()] = String(value); },
    writeHead(status, values = {}) { result.status = status; for (const [name, value] of Object.entries(values)) result.headers[name.toLowerCase()] = String(value); },
    end(payload) { result.payload = payload; },
  };
  const json = (status, data) => { response.writeHead(status, { 'cache-control': 'no-store' }); result.data = data; response.end(JSON.stringify(data)); };
  const db = new Proxy({}, { get() { throw new Error('SQLite must not be touched'); } });
  const context = { request: { method, headers }, response, url: new URL(pathname, 'http://board-app.invalid'), db, json, readJson: async () => { result.bodyReads++; return body; } };
  try { if (!(await live.route(context))) result.status = 404; } catch (error) { result.status = error.status || 500; result.error = error.message; }
  return result;
}
const directPut = (live, deploymentId, seq, digest, value, channel = LIVE.channel) => directCall(live, { method: 'PUT', pathname: `/_board/live/${channel}`, headers: liveHeaders, body: { deploymentId, seq, digest, ...(value === undefined ? {} : { value }) } });

test('without a valid write token every live route is absent and nothing is created', async t => {
  for (const value of [null, 'too-short', `${'x'.repeat(40)}\n`, 'x'.repeat(513)]) {
    await t.test(String(value).slice(0, 12), async s => {
      setLiveToken(s, value);
      const { app, cleanup } = await fixture(s);
      const server = await startApp(app); cleanup.push(server.close);
      const base = `http://127.0.0.1:${server.port}`;
      assert.equal((await fetch(`${base}/_board/health`).then(r => r.json())).live, 0);
      assert.equal((await liveGet(base, LIVE.channel)).status, 404);
      assert.equal((await livePut(base, LIVE.channel, server.deploymentId, 1, LIVE.digest, { '/a': 1 })).status, 404);
      assert.equal((await liveDelete(base, LIVE.channel, 1)).status, 404);
      assert.equal(await exists(path.join(app.dataDir, 'live')), false);
    });
  }
});

test('live GET answers 204 on the current version, 200 otherwise, with the exact poll and CORS headers', async t => {
  setLiveToken(t);
  const { app } = await fixture(t, { origins: [LIVE.page] });
  const server = await startTracked(app), base = `http://127.0.0.1:${server.port}`, version = `${server.deploymentId.slice(0, 8)}.7`;
  assert.equal((await fetch(`${base}/_board/health`).then(r => r.json())).live, 1);
  const unknown = await liveGet(base, LIVE.channel, '', { origin: LIVE.page });
  assert.equal(unknown.status, 404); assert.equal(unknown.headers.get('access-control-expose-headers'), 'Board-Live, Retry-After');
  const put = await livePut(base, LIVE.channel, server.deploymentId, 7, LIVE.digest, { '/live/x': 1 });
  assert.equal(put.status, 200); assert.deepEqual(await put.json(), { deploymentId: server.deploymentId, seq: 7, version });
  const full = await liveGet(base, LIVE.channel, '', { origin: LIVE.page });
  assert.equal(full.status, 200);
  const document = await full.json();
  assert.deepEqual({ ...document, at: 'checked' }, { v: version, seq: 7, at: 'checked', values: { '/live/x': 1 } }); assert.ok(Date.parse(document.at));
  assert.equal(full.headers.get('access-control-allow-origin'), LIVE.page);
  assert.equal(full.headers.get('access-control-expose-headers'), 'Board-Live, Retry-After');
  assert.equal(full.headers.get('cache-control'), 'public, max-age=1'); assert.equal(full.headers.get('vary'), 'Origin, Accept-Encoding');
  assert.deepEqual(boardLive(full), { f: '1', p: '5' });
  const unchanged = await liveGet(base, LIVE.channel, `?v=${version}`, { origin: LIVE.page });
  assert.equal(unchanged.status, 204); assert.equal(await unchanged.text(), '');
  assert.equal(unchanged.headers.get('vary'), 'Origin'); assert.equal(unchanged.headers.get('access-control-expose-headers'), 'Board-Live, Retry-After');
  assert.deepEqual(boardLive(unchanged), { f: '1', p: '5' });
  for (const query of ['?v=other.1', '?v=', `?v=${version}x`]) assert.equal((await liveGet(base, LIVE.channel, query)).status, 200);
  assert.equal((await liveGet(base, 'not-a-channel')).status, 404);
  assert.equal((await fetch(`${base}/_board/live/${LIVE.channel}`, { method: 'POST' })).status, 405);
  assert.equal((await liveGet(base, LIVE.channel, '', { origin: 'https://evil.example' })).status, 403);
});

test('live GET serves the buffer built at write time as gzip only when the client accepts it', async t => {
  setLiveToken(t);
  const { gunzipSync } = await import('node:zlib'), http = await import('node:http');
  const { app } = await fixture(t);
  const server = await startTracked(app), value = { '/text': 'compressible '.repeat(400) };
  assert.equal((await livePut(`http://127.0.0.1:${server.port}`, LIVE.channel, server.deploymentId, 1, LIVE.digest, value)).status, 200);
  const raw = encoding => new Promise((resolve, reject) => {
    http.get({ port: server.port, path: `/_board/live/${LIVE.channel}`, headers: encoding ? { 'accept-encoding': encoding } : {} }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const zipped = await raw('br, gzip'), plain = await raw('gzip;q=0'), none = await raw();
  assert.equal(zipped.headers['content-encoding'], 'gzip'); assert.ok(zipped.body.length < plain.body.length);
  assert.deepEqual(JSON.parse(gunzipSync(zipped.body)).values, value);
  assert.equal(plain.headers['content-encoding'], undefined); assert.deepEqual(JSON.parse(plain.body).values, value);
  assert.equal(none.headers['content-encoding'], undefined);
});

test('live writes refuse browsers and bad tokens before reading any body', async t => {
  const { open, deploymentId } = await liveDirect(t), live = await open();
  const pathname = `/_board/live/${LIVE.channel}`, body = { deploymentId, seq: 1, digest: LIVE.digest, value: {} };
  for (const method of ['PUT', 'DELETE']) {
    const query = method === 'DELETE' ? '?seq=1' : '';
    const fromBrowser = await directCall(live, { method, pathname: pathname + query, headers: { ...liveHeaders, origin: LIVE.page }, body });
    assert.equal(fromBrowser.status, 403); assert.equal(fromBrowser.bodyReads, 0);
    for (const authorization of [undefined, 'Bearer wrong', `Bearer ${LIVE.token}x`]) {
      const denied = await directCall(live, { method, pathname: pathname + query, headers: authorization ? { authorization } : {}, body });
      assert.equal(denied.status, 401); assert.equal(denied.bodyReads, 0);
    }
  }
  const absent = await directCall(live, { pathname });
  assert.equal(absent.status, 404);
});

test('a real write over HTTP with a browser Origin is refused and stores nothing', async t => {
  setLiveToken(t);
  const { app } = await fixture(t, { origins: [LIVE.page] });
  const server = await startTracked(app), base = `http://127.0.0.1:${server.port}`;
  assert.equal((await livePut(base, LIVE.channel, server.deploymentId, 1, LIVE.digest, { '/a': 1 }, { ...liveHeaders, origin: LIVE.page })).status, 403);
  assert.equal((await liveDelete(base, LIVE.channel, 1, { ...liveHeaders, origin: LIVE.page })).status, 403);
  assert.equal((await livePut(base, LIVE.channel, server.deploymentId, 1, LIVE.digest, { '/a': 1 }, { 'content-type': 'application/json', authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await liveGet(base, LIVE.channel)).status, 404);
  assert.deepEqual(await fs.readdir(path.join(app.dataDir, 'live')), []);
});

test('live polls and heartbeats touch neither files nor SQLite', async t => {
  const { open, deploymentId, clock, app } = await liveDirect(t), live = await open();
  assert.equal((await directPut(live, deploymentId, 1, LIVE.digest, { '/a': 1 })).status, 200);
  const version = `${deploymentId.slice(0, 8)}.1`, spies = ['open', 'readFile', 'writeFile', 'rename', 'stat', 'lstat', 'readdir'].map(name => t.mock.method(fs, name));
  const untouched = () => assert.equal(spies.reduce((total, spy) => total + spy.mock.callCount(), 0), 0);
  assert.equal((await directCall(live, { pathname: `/_board/live/${LIVE.channel}?v=${version}` })).status, 204); untouched();
  assert.equal((await directCall(live, { pathname: `/_board/live/${LIVE.channel}` })).status, 200); untouched();
  clock.now += 10000;
  const before = (await fs.readFile(path.join(app.dataDir, 'live', `${LIVE.channel}.json`), 'utf8')); t.mock.restoreAll();
  const spiesAgain = ['open', 'readFile', 'writeFile', 'rename', 'stat'].map(name => t.mock.method(fs, name));
  const heartbeat = await directPut(live, deploymentId, 1, LIVE.digest);
  assert.equal(heartbeat.status, 200); assert.equal(spiesAgain.reduce((total, spy) => total + spy.mock.callCount(), 0), 0); t.mock.restoreAll();
  assert.equal(await fs.readFile(path.join(app.dataDir, 'live', `${LIVE.channel}.json`), 'utf8'), before);
});

test('live write rules: replay, conflicts, staleness, need_value and foreign deployments', async t => {
  const { open, deploymentId, clock, app } = await liveDirect(t), live = await open(), file = path.join(app.dataDir, 'live', `${LIVE.channel}.json`);
  assert.deepEqual((await directPut(live, deploymentId, 5, LIVE.digest)).data, { error: 'need_value' });
  assert.equal(await exists(file), false);
  assert.equal((await directPut(live, deploymentId, 5, LIVE.digest, { '/a': 1 })).status, 200);
  const stored = await fs.readFile(file, 'utf8');
  const replay = await directPut(live, deploymentId, 5, LIVE.digest, { '/a': 1 }); assert.equal(replay.status, 200); assert.equal(replay.data.seq, 5);
  assert.equal((await directPut(live, deploymentId, 5, LIVE.digest)).status, 200);
  const conflict = await directPut(live, deploymentId, 5, LIVE.changed, { '/a': 2 }); assert.equal(conflict.status, 409); assert.equal(conflict.data.error, 'digest_conflict');
  const stale = await directPut(live, deploymentId, 4, LIVE.changed, { '/a': 2 }); assert.equal(stale.status, 409); assert.deepEqual(stale.data, { error: 'stale_seq', currentSeq: 5 });
  assert.deepEqual((await directPut(live, deploymentId, 6, LIVE.changed)).data, { error: 'need_value' });
  const foreign = await directPut(live, '22222222-2222-4222-8222-222222222222', 9, LIVE.changed, { '/a': 3 }); assert.equal(foreign.status, 409); assert.equal(foreign.data.error, 'deployment_mismatch');
  assert.equal(await fs.readFile(file, 'utf8'), stored);
  clock.now += 1000;
  assert.equal((await directPut(live, deploymentId, 6, LIVE.changed, { '/a': 2 })).status, 200);
  const updated = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual({ ...updated, at: 'ok' }, { version: 1, deploymentId, channelId: LIVE.channel, seq: 6, digest: LIVE.changed, at: 'ok', values: { '/a': 2 } });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('concurrent live writes for one channel apply in order and never regress', async t => {
  const { open, deploymentId, clock } = await liveDirect(t), live = await open();
  const results = await Promise.all([3, 1, 2].map(seq => directPut(live, deploymentId, seq, `${seq}`.repeat(64), { '/a': seq })));
  clock.now += 1000;
  assert.deepEqual(results.map(result => result.status), [200, 409, 409]);
  const current = await directCall(live, { pathname: `/_board/live/${LIVE.channel}` });
  assert.equal(JSON.parse(current.payload).seq, 3);
});

test('live value limits: paths, pointer syntax, depth, size, channel count and write rate', async t => {
  const { open, deploymentId, clock } = await liveDirect(t), live = await open();
  const manyKeys = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`/k${index}`, 1]));
  let deep = 1; for (let index = 0; index < 64; index++) deep = [deep];
  for (const value of [manyKeys, { 'no-slash': 1 }, { '/a~': 1 }, { '/__proto__/x': 1 }, { [`/${'a'.repeat(500)}`]: 1 }, { '/deep': deep }, [1], null]) assert.equal((await directPut(live, deploymentId, 1, LIVE.digest, value)).status, 400);
  let allowed = 1; for (let index = 0; index < 62; index++) allowed = [allowed];
  assert.equal((await directPut(live, deploymentId, 1, LIVE.digest, { '/deep': allowed })).status, 200);
  for (const body of [{ deploymentId, seq: 0, digest: LIVE.digest }, { deploymentId, seq: 1.5, digest: LIVE.digest }, { deploymentId, seq: 2, digest: 'short' }, { deploymentId, seq: 2, digest: LIVE.digest, extra: 1 }, 'text']) assert.equal((await directCall(live, { method: 'PUT', pathname: `/_board/live/${LIVE.channel}`, headers: liveHeaders, body })).status, 400);
  clock.now += 1000;
  assert.equal((await directPut(live, deploymentId, 2, LIVE.digest, { '/big': 'x'.repeat(60000) })).status, 413);
  assert.equal((await directPut(live, deploymentId, 2, LIVE.digest, { '/big': 'x'.repeat(59000) })).status, 200);
  clock.now += 1000;
  for (let seq = 3; seq <= 6; seq++) assert.equal((await directPut(live, deploymentId, seq, LIVE.digest, { '/a': seq })).status, 200);
  const limited = await directPut(live, deploymentId, 7, LIVE.digest, { '/a': 7 });
  assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '1');
  assert.equal((await directPut(live, deploymentId, 6, LIVE.digest)).status, 200, 'heartbeats are not rate limited');
  clock.now += 1000;
  assert.equal((await directPut(live, deploymentId, 7, LIVE.digest, { '/a': 7 })).status, 200);
});

test('live channel limit counts only active channels and never blocks a clear', async t => {
  const { open, deploymentId, app } = await liveDirect(t), live = await open();
  const id = index => `c${index.toString(16).padStart(32, '0')}`;
  for (let index = 0; index < 256; index++) assert.equal((await directPut(live, deploymentId, 1, LIVE.digest, { '/a': 1 }, id(index))).status, 200);
  const refused = await directPut(live, deploymentId, 1, LIVE.digest, { '/a': 1 }, id(256));
  assert.equal(refused.status, 507); assert.equal(await exists(path.join(app.dataDir, 'live', `${id(256)}.json`)), false);
  assert.equal((await directPut(live, deploymentId, 2, LIVE.changed, { '/a': 2 }, id(0))).status, 200, 'an existing channel keeps updating at the limit');
  const unknown = await directCall(live, { method: 'DELETE', pathname: `/_board/live/${id(300)}?seq=4`, headers: liveHeaders });
  assert.equal(unknown.status, 200); assert.equal(unknown.data.seq, 4);
  assert.equal((await directCall(live, { method: 'DELETE', pathname: `/_board/live/${id(1)}?seq=2`, headers: liveHeaders })).status, 200);
  assert.equal((await directPut(live, deploymentId, 1, LIVE.digest, { '/a': 1 }, id(256))).status, 200, 'a tombstone frees its slot');
});

test('live read budget returns 429 with a readable Retry-After and weighs bodies by size', async t => {
  const { open, deploymentId, clock } = await liveDirect(t, { origins: [LIVE.page] }), live = await open();
  assert.equal((await directPut(live, deploymentId, 1, LIVE.digest, { '/big': 'x'.repeat(59000) })).status, 200);
  const version = `${deploymentId.slice(0, 8)}.1`, pathname = `/_board/live/${LIVE.channel}`, origin = { origin: LIVE.page };
  clock.now = Math.ceil(clock.now / 1000) * 1000 + 1000;
  let served = 0, limited;
  while (!limited) { const result = await directCall(live, { pathname, headers: origin }); if (result.status === 429) limited = result; else served++; assert.ok(served < 400); }
  assert.ok(served >= 300 && served < 330, `served ${served}`);
  assert.equal(limited.data.error, 'Too many requests'); assert.match(limited.headers['retry-after'], /^[1-9]\d*$/);
  assert.equal(limited.headers['access-control-expose-headers'], 'Board-Live, Retry-After'); assert.equal(limited.headers['cache-control'], 'no-store');
  clock.now += 1000;
  let count = 0;
  for (; count < 5000; count++) assert.equal((await directCall(live, { pathname: `${pathname}?v=${version}` })).status, 204);
  assert.equal((await directCall(live, { pathname: `${pathname}?v=${version}` })).status, 429);
  assert.equal((await directPut(live, deploymentId, 1, LIVE.digest)).status, 200, 'authenticated writes are exempt from the read budget');
});

test('live poll interval follows load between 5 and 60 seconds', async t => {
  const { open, deploymentId, clock } = await liveDirect(t), live = await open();
  assert.equal((await directPut(live, deploymentId, 1, LIVE.digest, { '/a': 1 })).status, 200);
  const version = `${deploymentId.slice(0, 8)}.1`, poll = () => directCall(live, { pathname: `/_board/live/${LIVE.channel}?v=${version}` });
  const window = async rps => { for (let index = 0; index < rps * 10; index++) { await poll(); clock.now += 1000 / rps; } clock.now += 1; return (await poll()).headers['board-live']; };
  assert.match(await window(10), /p=5$/);
  assert.match(await window(800), /p=2[01]$/);
  assert.match(await window(200), /p=2[0-2]$/);
  assert.match(await window(4000), /p=60$/);
  assert.match(await window(1), /p=5$/);
});

test('live freshness: leases expire, and a restarted backend reports the grace value until 45 s', async t => {
  const { open, deploymentId, clock } = await liveDirect(t);
  let live = await open();
  assert.equal((await directPut(live, deploymentId, 1, LIVE.digest, { '/a': 1 })).status, 200);
  const fresh = async () => (await directCall(live, { pathname: `/_board/live/${LIVE.channel}` })).headers['board-live'];
  assert.match(await fresh(), /^f=1,/);
  clock.now += 119000; assert.match(await fresh(), /^f=1,/);
  clock.now += 1000; assert.match(await fresh(), /^f=0,/);
  assert.equal((await directPut(live, deploymentId, 1, LIVE.digest)).status, 200, 'heartbeat renews the lease');
  assert.match(await fresh(), /^f=1,/);
  live = await open();
  assert.match(await fresh(), /^f=g,/);
  clock.now += 44000; assert.match(await fresh(), /^f=g,/);
  clock.now += 1000; assert.match(await fresh(), /^f=0,/, 'an offline publisher reads as stale once the grace ends');
  assert.equal((await directPut(live, deploymentId, 1, LIVE.digest)).status, 200);
  assert.match(await fresh(), /^f=1,/);
});

test('live DELETE is idempotent, always clears, fences late writes and survives restart; re-enable continues above it', async t => {
  const { open, deploymentId, clock, app } = await liveDirect(t);
  let live = await open();
  const pathname = `/_board/live/${LIVE.channel}`, del = seq => directCall(live, { method: 'DELETE', pathname: `${pathname}?seq=${seq}`, headers: liveHeaders });
  assert.equal((await directPut(live, deploymentId, 5, LIVE.digest, { '/a': 'public' })).status, 200);
  const first = await del(6); assert.equal(first.status, 200); assert.deepEqual(first.data, { deploymentId, seq: 6, cleared: true });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(app.dataDir, 'live', `${LIVE.channel}.json`), 'utf8')).cleared, true);
  assert.equal((await fs.readFile(path.join(app.dataDir, 'live', `${LIVE.channel}.json`), 'utf8')).includes('public'), false);
  assert.equal((await del(6)).data.seq, 6, 'replayed clear is idempotent');
  assert.equal((await del(2)).data.seq, 6, 'a lower clear keeps the higher fence');
  const gone = await directCall(live, { pathname }); assert.equal(gone.status, 410); assert.equal(gone.headers['board-live'], undefined);
  const late = await directPut(live, deploymentId, 6, LIVE.digest, { '/a': 'late' }); assert.equal(late.status, 410); assert.equal(late.data.currentSeq, 6);
  assert.equal((await directPut(live, deploymentId, 5, LIVE.digest)).status, 410);
  assert.deepEqual((await directPut(live, deploymentId, 7, LIVE.digest)).data, { error: 'need_value' });
  live = await open();
  assert.equal((await directCall(live, { pathname })).status, 410, 'tombstone survives restart');
  assert.equal((await directPut(live, deploymentId, 6, LIVE.digest, { '/a': 'late' })).status, 410);
  clock.now += 1000;
  assert.equal((await directPut(live, deploymentId, 7, LIVE.changed, { '/a': 'again' })).status, 200);
  const resumed = await directCall(live, { pathname }); assert.equal(resumed.status, 200); assert.deepEqual(JSON.parse(resumed.payload).values, { '/a': 'again' });
  assert.equal((await del(3)).data.seq, 7, 'a low clear still clears the current document');
  assert.equal((await directCall(live, { pathname })).status, 410);
  assert.equal((await directCall(live, { method: 'DELETE', pathname: `${pathname}?seq=0`, headers: liveHeaders })).status, 400);
});

test('malformed files under live/ are skipped and logged, foreign deployments deleted, startup continues', async t => {
  const { open, deploymentId, app } = await liveDirect(t), directory = path.join(app.dataDir, 'live');
  await fs.mkdir(directory, { recursive: true });
  const id = letter => `c${letter.repeat(32)}`, write = (letter, text) => fs.writeFile(path.join(directory, `${id(letter)}.json`), text);
  const good = { version: 1, deploymentId, channelId: id('1'), seq: 3, digest: LIVE.digest, at: '2026-11-10T00:00:00.000Z', values: { '/a': 1 } };
  await write('1', JSON.stringify(good));
  await write('2', '{not json');
  await write('3', JSON.stringify({ ...good, channelId: id('3'), values: { 'no-slash': 1 } }));
  await write('4', JSON.stringify({ ...good, channelId: id('5') }));
  await write('6', JSON.stringify({ ...good, channelId: id('6'), deploymentId: '33333333-3333-4333-8333-333333333333' }));
  await write('7', 'x'.repeat(200000));
  await fs.writeFile(path.join(directory, `${id('8')}.json.1.1.tmp`), 'partial');
  await fs.writeFile(path.join(directory, 'notes.txt'), 'operator note');
  await fs.mkdir(path.join(directory, `${id('9')}.json`));
  await fs.symlink(path.join(directory, `${id('1')}.json`), path.join(directory, `${id('a')}.json`));
  const log = t.mock.method(console, 'error', () => {});
  const live = await open(); t.mock.restoreAll();
  const logged = log.mock.calls.map(call => call.arguments.join(' ')).join('\n');
  for (const name of ['2', '3', '4', '7', '9', 'a']) assert.match(logged, new RegExp(`${id(name)}\\.json`));
  assert.match(logged, /notes\.txt/);
  const status = letter => directCall(live, { pathname: `/_board/live/${id(letter)}` }).then(result => result.status);
  assert.equal(await status('1'), 200);
  for (const letter of ['2', '3', '4', '6', '7', '9', 'a']) assert.equal(await status(letter), 404);
  assert.equal(await exists(path.join(directory, `${id('6')}.json`)), false, 'foreign deployment deleted');
  assert.equal(await exists(path.join(directory, `${id('8')}.json.1.1.tmp`)), false, 'interrupted temporary removed');
  assert.equal(await exists(path.join(directory, `${id('2')}.json`)), true, 'malformed files are kept for the operator');
});

test('restore does not resurrect a cleared document, and a cold restore discards the stale public copy', async t => {
  setLiveToken(t);
  const { app, directory } = await fixture(t);
  await migrate(app);
  let server = await startTracked(app), base = `http://127.0.0.1:${server.port}`;
  const deployment = server.deploymentId;
  assert.equal((await livePut(base, LIVE.channel, deployment, 1, LIVE.digest, { '/a': 1 })).status, 200);
  assert.equal((await livePut(base, LIVE.other, deployment, 1, LIVE.digest, { '/b': 1 })).status, 200);
  const saved = await backup(app, path.join(directory, 'live.sqlite'));
  assert.equal((await liveDelete(base, LIVE.channel, 2)).status, 200);
  await server.close();
  const restored = await restore(app, saved.file, saved.sha256); assert.equal(restored.deploymentId, deployment);
  server = await startTracked(app); base = `http://127.0.0.1:${server.port}`;
  assert.equal(server.deploymentId, deployment);
  assert.equal((await liveGet(base, LIVE.channel)).status, 410, 'restore keeps the clear');
  assert.equal((await liveGet(base, LIVE.other)).status, 200, 'restore keeps other public documents');
  await server.close();
  await fs.unlink(path.join(app.dataDir, 'identity.json'));
  const cold = await restore(app, saved.file, saved.sha256); assert.notEqual(cold.deploymentId, deployment);
  server = await startTracked(app); base = `http://127.0.0.1:${server.port}`;
  assert.notEqual(server.deploymentId, deployment);
  assert.equal((await liveGet(base, LIVE.other)).status, 404, 'a cold restore has no public copy');
  assert.deepEqual(await fs.readdir(path.join(app.dataDir, 'live')), []);
  const mismatch = await livePut(base, LIVE.other, deployment, 2, LIVE.digest, { '/b': 1 }); assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).error, 'deployment_mismatch');
});

test('the write token reaches no file, response, or log, and a backend restart keeps documents', async t => {
  setLiveToken(t);
  const { app } = await fixture(t);
  const log = t.mock.method(console, 'error', () => {});
  let server = await startTracked(app), base = `http://127.0.0.1:${server.port}`;
  const responses = [];
  const record = async response => { responses.push(`${response.status}\n${JSON.stringify([...response.headers])}\n${await response.text()}`); };
  await record(await livePut(base, LIVE.channel, server.deploymentId, 1, LIVE.digest, { '/a': 1 }));
  await record(await livePut(base, LIVE.channel, server.deploymentId, 1, LIVE.changed, { '/a': 2 }));
  await record(await livePut(base, LIVE.channel, server.deploymentId, 0, LIVE.digest));
  await record(await livePut(base, LIVE.channel, server.deploymentId, 1, LIVE.digest, { '/a': 1 }, { 'content-type': 'application/json', authorization: `Bearer ${LIVE.token}x` }));
  await record(await liveGet(base, LIVE.channel));
  await record(await fetch(`${base}/_board/health`));
  await record(await fetch(`${base}/public-config.json`));
  const collect = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).filter(entry => !entry.name.startsWith('app.sqlite')).map(async entry => entry.isDirectory() ? collect(path.join(directory, entry.name)) : fs.readFile(path.join(directory, entry.name), 'utf8')))).flat();
  const disk = await collect(app.dataDir);
  assert.ok(disk.some(text => text.includes('/a')));
  assert.equal([...responses, ...disk, ...log.mock.calls.map(call => call.arguments.join(' '))].some(text => text.includes(LIVE.token)), false);
  const health = await fetch(`${base}/_board/health`).then(r => r.json()); assert.equal(health.live, 1); assert.equal(Object.keys(health).length, 8);
  const deployment = server.deploymentId; await server.close();
  server = await startTracked(app); base = `http://127.0.0.1:${server.port}`;
  assert.equal(server.deploymentId, deployment);
  const after = await liveGet(base, LIVE.channel); assert.equal(after.status, 200); assert.deepEqual((await after.json()).values, { '/a': 1 }); assert.equal(boardLive(after).f, 'g');
  assert.equal((await livePut(base, LIVE.channel, deployment, 1, LIVE.digest)).status, 200);
  assert.equal(boardLive(await liveGet(base, LIVE.channel)).f, '1');
});

test('the real deploy keeps a live document and identity across a new release', async t => {
  setLiveToken(t, null);
  const { root, directory, app, cleanup } = await fixture(t);
  const release = async name => { const file = path.join(directory, `${name}.json`); await createSshPlan({ dir: root, host: 'unused-no-ssh', root: path.join(directory, 'remote'), out: file }); const plan = await validatedPlan(file); return { operation: 'deploy', root: plan.remoteRoot, appId: app.owner.id, owner: app.owner.owner, release: plan.sha256, node: process.execPath, files: await Promise.all(plan.files.map(async row => ({ ...row, content: (await fs.readFile(path.join(root, row.path))).toString('base64') }))) }; };
  let current = await release('one');
  cleanup.push(async () => { const result = await control({ ...current, files: [], operation: 'stop' }); assert.equal(result.code, 0, result.stderr); });
  let result = await control(current); assert.equal(result.code, 0, result.stderr);
  const off = JSON.parse(result.stdout).health; assert.equal(off.live, 0); assert.equal((await liveGet(`http://127.0.0.1:${off.port}`, LIVE.channel)).status, 404);
  await fs.writeFile(path.join(current.root, 'shared/.env'), `BOARD_LIVE_WRITE_TOKEN=${LIVE.token}\n`, { mode: 0o600 });
  await fs.appendFile(path.join(root, 'routes.mjs'), '\n// version two');
  current = await release('two');
  result = await control(current); assert.equal(result.code, 0, result.stderr);
  const on = JSON.parse(result.stdout).health; assert.equal(on.live, 1);
  assert.equal((await livePut(`http://127.0.0.1:${on.port}`, LIVE.channel, on.deploymentId, 1, LIVE.digest, { '/a': 'kept' })).status, 200);
  await fs.appendFile(path.join(root, 'routes.mjs'), '\n// version three');
  current = await release('three');
  result = await control(current); assert.equal(result.code, 0, result.stderr);
  const redeployed = JSON.parse(result.stdout).health; assert.equal(redeployed.deploymentId, on.deploymentId);
  const kept = await liveGet(`http://127.0.0.1:${redeployed.port}`, LIVE.channel);
  assert.equal(kept.status, 200); assert.deepEqual((await kept.json()).values, { '/a': 'kept' }); assert.equal(boardLive(kept).f, 'g');
  assert.equal(await exists(path.join(current.root, 'shared/data/live', `${LIVE.channel}.json`)), true);
});

test('update-runtime refreshes only .board/runtime through the installed launcher and claims nothing', async t => {
  const { root, app } = await fixture(t);
  const cli = (entry, args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk); child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
  const runtime = path.join(root, '.board/runtime');
  const own = await cli(path.join(root, 'board-app.mjs'), ['update-runtime', '--dir', root]);
  assert.equal(own.code, 1); assert.match(own.stderr, /paseo-board-app update-runtime/);
  await fs.writeFile(path.join(runtime, 'server.mjs'), '// an older runtime'); await fs.rm(path.join(runtime, 'live.mjs'));
  await fs.writeFile(path.join(root, 'routes.mjs'), 'export const route = () => false; // the owner\'s own code');
  await fs.writeFile(path.join(root, 'migrations/002-owner.sql'), 'CREATE TABLE owner_data (id INTEGER);');
  await fs.rm(app.dataDir, { recursive: true });
  const tree = async directory => Object.fromEntries((await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(async entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return file.startsWith(runtime) ? [] : Object.entries(await tree(file));
    return [[path.relative(root, file), await fs.readFile(file, 'utf8')]];
  }))).flat());
  const before = await tree(root);
  const updated = await cli(path.join(here, '../scripts/board-app.mjs'), ['update-runtime', '--dir', root]);
  assert.equal(updated.code, 0, updated.stderr); assert.equal(JSON.parse(updated.stdout).status, 'updated');
  assert.ok(JSON.parse(updated.stdout).files.includes('live.mjs'));
  for (const name of JSON.parse(updated.stdout).files) assert.equal(await fs.readFile(path.join(runtime, name), 'utf8'), await fs.readFile(path.join(here, name), 'utf8'));
  assert.deepEqual((await fs.readdir(runtime)).filter(name => name.includes('.update')), []);
  assert.deepEqual(await tree(root), before);
  assert.equal(await exists(app.dataDir), false, 'update-runtime must not create or claim the data directory');
  const refused = await cli(path.join(here, '../scripts/board-app.mjs'), ['update-runtime', '--dir', path.join(root, 'migrations')]);
  assert.equal(refused.code, 1);
  const help = await cli(path.join(here, '../scripts/board-app.mjs'), ['help']); assert.match(help.stdout, /update-runtime/);
});

test('init documents the live token only as a server-side placeholder and ships the live module', async t => {
  const { root } = await fixture(t);
  const example = await fs.readFile(path.join(root, '.env.example'), 'utf8');
  assert.match(example, /^# BOARD_LIVE_WRITE_TOKEN=$/m);
  assert.match(await fs.readFile(path.join(root, 'README.md'), 'utf8'), /BOARD_LIVE_WRITE_TOKEN[\s\S]*paseo-board-app update-runtime/);
  assert.ok(await exists(path.join(root, '.board/runtime/live.mjs')));
  const asset = JSON.parse(await fs.readFile(path.join(here, '../server/assets/app-runtime.txt'), 'utf8'));
  for (const name of ['backend/live.mjs', 'backend/server.mjs', 'backend/cli.mjs', 'backend/scaffold.mjs']) assert.equal(asset.files[name], await fs.readFile(path.join(here, '..', name), 'utf8'));
});

// ---------------------------------------------------------------------------
// Visitor comment threads (page comments, DESIGN §4.5 and §11.5/§11.10).

const expandFixture = value => typeof value === 'string' ? value.replace(/<<repeat:(.):(\d+)>>/gu, (_, character, count) => character.repeat(Number(count)))
  : Array.isArray(value) ? value.map(expandFixture) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandFixture(item)])) : value;
const CONTRACT = expandFixture(JSON.parse(await fs.readFile(path.join(here, '../scripts/fixtures/page-comments-contract.json'), 'utf8')));
const COMMENT = { token: 'x'.repeat(48), page: 'https://cm-bf.github.io', a: 'a'.repeat(64), b: 'b'.repeat(64), c: 'c'.repeat(64) };
const RELAXED = { requestsPerIpMinute: 3000, postPerIpMinute: 100, postPerIpHour: 600, postPerVisitorMinute: 50, postPerVisitorHour: 300 };
const OLD_COMMENTS_DDL = `CREATE TABLE IF NOT EXISTS _board_comments (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT UNIQUE NOT NULL,
    intent_key TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL,
    text TEXT NOT NULL, author_name TEXT, page_url TEXT, anchor_json TEXT, created_at TEXT NOT NULL
  ) STRICT`;
const OLD_INSERT = 'INSERT INTO _board_comments (external_id,intent_key,payload_hash,text,author_name,page_url,anchor_json,created_at) VALUES (?,?,?,?,?,?,?,?)';
const oldProject = row => ({ externalId: row.external_id, text: row.text, createdAt: row.created_at, ...(row.author_name ? { authorName: row.author_name } : {}), ...(row.page_url ? { pageUrl: row.page_url } : {}), ...(row.anchor_json ? { anchor: JSON.parse(row.anchor_json) } : {}) });
const ownerHeaders = { authorization: `Bearer ${COMMENT.token}` };
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

function setExportToken(t, value = COMMENT.token) {
  const original = process.env.BOARD_INBOX_EXPORT_TOKEN;
  t.after(() => { if (original === undefined) delete process.env.BOARD_INBOX_EXPORT_TOKEN; else process.env.BOARD_INBOX_EXPORT_TOKEN = original; });
  if (value === null) delete process.env.BOARD_INBOX_EXPORT_TOKEN; else process.env.BOARD_INBOX_EXPORT_TOKEN = value;
}
async function commentApp(t, comments = {}, change = {}) {
  setExportToken(t);
  const made = await fixture(t, { origins: [COMMENT.page], comments: { enabled: true, ...comments }, ...change });
  const server = await startTracked(made.app);
  return { ...made, server, base: `http://127.0.0.1:${server.port}` };
}
const sendComment = (base, key, body, headers = {}) => fetch(`${base}/_board/comments`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...headers }, body: JSON.stringify(body) });
const exported = (base, query = '') => fetch(`${base}/_board/comments${query}`, { headers: ownerHeaders }).then(async response => { assert.equal(response.status, 200); return response.json(); });
const mineOf = (base, secret, query = '', headers = {}) => fetch(`${base}/_board/comments/mine${query}`, { headers: { ...(secret ? { 'x-board-visitor': secret } : {}), ...headers } });
const replyTo = (base, id, key, body, headers = ownerHeaders) => fetch(`${base}/_board/comments/${id}/replies`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}), ...headers }, body: JSON.stringify(body) });
const from = address => ({ 'x-forwarded-for': address });
const tagOf = secret => digest(`tag\0${digest(`board-visitor:v1:${secret}`)}`).slice(0, 12);
async function failure(response, status, code) { assert.equal(response.status, status); const body = await response.json(); assert.equal(body.code, code, JSON.stringify(body)); assert.equal(typeof body.error, 'string'); return response; }
async function legacyPageSchema() {
  // The plugin's export page schema at 4b94741, copied literally: old plugins must keep parsing v1.
  const { z } = await import('zod');
  const IdSchema = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.:-]+$/), TimestampSchema = z.string().datetime();
  const InboxExternalCommentSchema = z.object({
    externalId: z.string().min(1).max(200),
    text: z.string().trim().min(1).max(8_000),
    authorName: z.string().trim().min(1).max(160).optional(),
    createdAt: TimestampSchema,
    pageUrl: z.string().max(2_000).url().refine(value => /^https?:\/\//.test(value), 'Comment page URL must use HTTP or HTTPS').optional(),
    anchor: z.object({ label: z.string().max(200).optional(), selector: z.string().max(500).optional() }).strict().optional(),
  }).strict();
  return z.object({ deploymentId: IdSchema, cursor: z.string().min(1).max(500), nextCursor: z.string().min(1).max(500), comments: z.array(InboxExternalCommentSchema).max(100) }).strict();
}

test('page-comment contract fixture: accepted posts store and export exactly, rejected posts return their code', async t => {
  const { base } = await commentApp(t, { limits: RELAXED });
  const header = visitor => visitor === true ? { 'x-board-visitor': CONTRACT.visitorSecret } : typeof visitor === 'string' ? { 'x-board-visitor': visitor } : {};
  const accepted = [];
  for (const [index, item] of CONTRACT.post.accepted.entries()) {
    const response = await sendComment(base, `fixture-accepted-${index}`, item.body, header(item.visitor));
    assert.equal(response.status, 201, item.name);
    const { comment, replayed } = await response.json();
    assert.equal(replayed, false); assert.match(comment.externalId, uuid); assert.ok(Date.parse(comment.createdAt), item.name);
    assert.deepEqual(comment, { ...item.stored, externalId: comment.externalId, createdAt: comment.createdAt }, item.name);
    accepted.push({ item, comment });
  }
  for (const [index, item] of CONTRACT.post.rejected.entries()) await failure(await sendComment(base, `fixture-rejected-${index}`, item.body, header(item.visitor)), 400, item.code);
  const v2 = await exported(base, '?cursor=0&limit=100&format=2'), v1 = await exported(base, '?cursor=0&limit=100');
  assert.equal(v2.format, 2); assert.equal(v2.comments.length, accepted.length); assert.equal(v1.comments.length, accepted.length);
  for (const [index, { item, comment }] of accepted.entries()) {
    assert.deepEqual(v2.comments[index], { ...comment, ...(item.visitor === true ? { visitorTag: tagOf(CONTRACT.visitorSecret) } : {}) }, item.name);
    const { anchor, ...rest } = comment, legacy = anchor && Object.fromEntries(Object.entries(anchor).filter(([key]) => key === 'label' || key === 'selector'));
    assert.deepEqual(v1.comments[index], legacy && Object.keys(legacy).length ? { ...rest, anchor: legacy } : rest, item.name);
  }
  (await legacyPageSchema()).parse(v1);
});

test('the comment validator is exported for shared anchor checks and matches the POST rules', () => {
  assert.equal(anchorProblem({ label: 'L', selector: '#a', quote: 'ab', prefix: '', suffix: 'x', start: 4, end: 6, releaseId: CONTRACT.releaseId }), null);
  for (const anchor of [null, [], 'x', { quote: 'ab', start: 0, end: 3 }, { start: 0, end: 1 }, { quote: 'a', end: 1 }, { quote: 'a', start: 1, end: 1 }, { quote: 'a', start: 0.5, end: 1.5 }, { quote: 'a', start: 9_999_999, end: 10_000_001 }, { selector: 1 }, { label: 'l'.repeat(201) }, { quote: 'q'.repeat(1001) }, { suffix: 's'.repeat(65) }, { releaseId: 'release-0' }, { __proto__: null, other: 1 }])
    assert.equal(typeof anchorProblem(anchor), 'string', JSON.stringify(anchor));
  assert.deepEqual(normalizeCommentInput({ text: ' 好 ', authorName: '　', pageUrl: 'https:example.com' }), { text: '好', pageUrl: 'https://example.com/' });
  assert.throws(() => normalizeCommentInput({ text: 'x'.repeat(2001) }, { visitor: true }), error => error.status === 400 && error.code === 'invalid_input');
  assert.equal(normalizeCommentInput({ text: 'x'.repeat(2001) }).text.length, 2001);
});

test('rows stored before this runtime or by raw SQL export normalized, and v1 keeps the old bytes and schema', async t => {
  const { base, server } = await commentApp(t);
  const at = '2026-11-01T00:00:00.000Z', id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const insert = (n, text, author, page, anchor) => server.db.prepare(OLD_INSERT).run(id(n), `raw-intent-${n}`, 'x', text, author, page, anchor, at);
  insert(1, 'Old shape', 'Visitor', 'https://pages.example/report', '{"selector":"#chart","label":"Chart"}');
  insert(2, '  hi ', ' 小王　', 'HTTPS://Example.COM/p', '{}');
  insert(3, 'blank name', '   ', 'ftp://example.com/', 'not json');
  insert(4, 'bad fields', 'a\u0007', 'https://u:p@example.com/', '{"quote":"","x":1}');
  insert(5, 'rich only', null, null, `{"quote":"ab","start":0,"end":2,"releaseId":"${CONTRACT.releaseId}"}`);
  const v1 = await exported(base, '?cursor=0&limit=100'), v2 = await exported(base, '?cursor=0&limit=100&format=2');
  const old = oldProject(server.db.prepare('SELECT * FROM _board_comments WHERE seq = 1').get());
  assert.equal(JSON.stringify(v1.comments[0]), JSON.stringify(old), 'an old-shaped row exports byte for byte');
  assert.deepEqual(v1.comments.slice(1), [
    { externalId: id(2), text: 'hi', createdAt: at, authorName: '小王', pageUrl: 'https://example.com/p' },
    { externalId: id(3), text: 'blank name', createdAt: at },
    { externalId: id(4), text: 'bad fields', createdAt: at },
    { externalId: id(5), text: 'rich only', createdAt: at },
  ]);
  assert.deepEqual(v2.comments.slice(1).map(row => row.anchor), [{}, undefined, undefined, { quote: 'ab', start: 0, end: 2, releaseId: CONTRACT.releaseId }]);
  assert.equal(v2.comments.some(row => 'visitorTag' in row), false);
  assert.deepEqual((await legacyPageSchema()).parse(v1), v1);
});

test('schema migration: a 4b94741 database gains visitor threads once, newer schemas refuse, and the old SQL keeps working', async t => {
  setExportToken(t);
  const { app } = await fixture(t, { comments: { enabled: true } });
  let db = openDatabase(app.database);
  db.exec(OLD_COMMENTS_DDL);
  db.prepare(OLD_INSERT).run('00000000-0000-4000-8000-000000000001', 'old-intent-1', 'x', 'Before the upgrade', ' Old Name ', 'https://pages.example/old', '{"selector":"#x"}', '2026-11-01T00:00:00.000Z');
  db.close();
  let server = await startTracked(app), base = `http://127.0.0.1:${server.port}`;
  const meta = () => Object.fromEntries(server.db.prepare('SELECT key, value FROM _board_runtime_meta').all().map(row => [row.key, row.value]));
  const oldBytes = Buffer.byteLength('Before the upgrade') + Buffer.byteLength(' Old Name ') + Buffer.byteLength('https://pages.example/old') + Buffer.byteLength('{"selector":"#x"}');
  assert.deepEqual(meta(), { comments_schema: '2', export_ack: '0', comments_bytes: String(oldBytes) });
  assert.deepEqual(server.db.prepare("SELECT name FROM pragma_table_info('_board_comments') WHERE name IN ('visitor_hash','page_key') ORDER BY name").all().map(row => row.name), ['page_key', 'visitor_hash']);
  assert.ok(server.db.prepare("SELECT 1 FROM sqlite_master WHERE name='_board_comment_replies'").get());
  const expected = { externalId: '00000000-0000-4000-8000-000000000001', text: 'Before the upgrade', createdAt: '2026-11-01T00:00:00.000Z', authorName: 'Old Name', pageUrl: 'https://pages.example/old', anchor: { selector: '#x' } };
  assert.deepEqual((await exported(base, '?cursor=0')).comments, [expected]);
  assert.deepEqual((await exported(base, '?cursor=0&format=2')).comments, [expected]);
  assert.deepEqual((await mineOf(base, COMMENT.a).then(r => r.json())).threads, [], 'rows without a visitor never appear in mine');
  assert.equal((await sendComment(base, 'after-upgrade', { text: 'After', pageUrl: 'https://pages.example/old' }, { 'x-board-visitor': COMMENT.a })).status, 201);
  assert.equal(meta().comments_bytes, String(oldBytes + Buffer.byteLength('After') + Buffer.byteLength('https://pages.example/old')));
  server.db.exec('DROP INDEX _board_comments_page');
  await server.close();
  server = await startTracked(app);
  assert.equal(server.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='_board_comments_page'").get().n, 0, 'the migration ran once');
  assert.equal(meta().comments_schema, '2');
  await server.close();
  // The previous runtime only issues CREATE TABLE IF NOT EXISTS and inserts named columns.
  db = openDatabase(app.database);
  db.exec(OLD_COMMENTS_DDL);
  db.prepare(OLD_INSERT).run('00000000-0000-4000-8000-000000000003', 'old-intent-3', 'x', 'From a rolled-back runtime', null, null, null, '2026-11-02T00:00:00.000Z');
  assert.deepEqual(db.prepare('SELECT * FROM _board_comments ORDER BY seq').all().map(oldProject).map(row => row.text), ['Before the upgrade', 'After', 'From a rolled-back runtime']);
  db.prepare("UPDATE _board_runtime_meta SET value = '3' WHERE key = 'comments_schema'").run();
  db.close();
  await assert.rejects(startApp(app), /upgraded by a newer Board runtime; update this app's runtime/);
  db = openDatabase(app.database); db.prepare("UPDATE _board_runtime_meta SET value = '2' WHERE key = 'comments_schema'").run(); db.close();
  server = await startTracked(app); base = `http://127.0.0.1:${server.port}`;
  assert.equal((await exported(base, '?cursor=2')).comments[0].text, 'From a rolled-back runtime');
  assert.equal(meta().comments_bytes, String(oldBytes + Buffer.byteLength('After') + Buffer.byteLength('https://pages.example/old') + Buffer.byteLength('From a rolled-back runtime')), 'the byte count also follows inserts from the old runtime');
});

test('visitor threads: mine lists only the caller\'s comments per page, newest first, with public status and replies', async t => {
  const { base, server } = await commentApp(t, { limits: RELAXED });
  const page1 = `${COMMENT.page}/pages/boards/s1/`, page2 = `${COMMENT.page}/pages/boards/s2/`;
  const post = async (key, secret, text, pageUrl) => { const response = await sendComment(base, key, { text, ...(pageUrl ? { pageUrl } : {}) }, secret ? { 'x-board-visitor': secret } : {}); assert.equal(response.status, 201); return (await response.json()).comment; };
  const a1 = await post('visitor-a-1', COMMENT.a, 'A first', page1), a2 = await post('visitor-a-2', COMMENT.a, 'A second', `${page1}index.html`), a3 = await post('visitor-a-3', COMMENT.a, 'A other page', page2);
  await post('visitor-b-1', COMMENT.b, 'B first', page1); await post('anonymous-1', null, 'Anonymous', page1);
  const threads = async (secret, query = '') => { const response = await mineOf(base, secret, query); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); const body = await response.json(); assert.equal(body.deploymentId, server.deploymentId); return body.threads; };
  assert.deepEqual((await threads(COMMENT.a)).map(thread => thread.text), ['A other page', 'A second', 'A first']);
  assert.deepEqual((await threads(COMMENT.a, `?page=${encodeURIComponent(page1)}`)).map(thread => thread.text), ['A second', 'A first']);
  assert.deepEqual((await threads(COMMENT.a, `?page=${encodeURIComponent(`${page1}index.html`)}`)).map(thread => thread.text), ['A second', 'A first']);
  assert.deepEqual((await threads(COMMENT.b)).map(thread => thread.text), ['B first']);
  assert.deepEqual(await threads(COMMENT.c), []);
  assert.deepEqual((await threads(COMMENT.a))[2], { id: a1.externalId, text: 'A first', createdAt: a1.createdAt, pageUrl: page1, status: 'sent', replies: [] });
  const first = await exported(base, '?cursor=0&limit=100&format=2');
  assert.deepEqual((await threads(COMMENT.a)).map(thread => thread.status), ['sent', 'sent', 'sent'], 'fetching is not acknowledging');
  await exported(base, `?cursor=${first.comments[1].externalId === a2.externalId ? 2 : 0}&format=2`);
  assert.deepEqual((await threads(COMMENT.a)).map(thread => thread.status), ['sent', 'received', 'received'], 'the committed cursor acknowledges');
  await exported(base, '?cursor=999999');
  assert.deepEqual((await threads(COMMENT.a)).map(thread => thread.status), ['received', 'received', 'received']);
  assert.equal(server.db.prepare("SELECT value FROM _board_runtime_meta WHERE key='export_ack'").get().value, '5', 'acknowledgement never passes the newest comment');
  assert.equal((await replyTo(base, a3.externalId, 'ir-reply-1', { text: '谢谢！', authorKind: 'agent' })).status, 201);
  const [replied] = await threads(COMMENT.a);
  assert.equal(replied.status, 'replied'); assert.equal(replied.replies.length, 1);
  assert.deepEqual(Object.keys(replied.replies[0]), ['id', 'text', 'authorKind', 'createdAt']); assert.equal(replied.replies[0].text, '谢谢！'); assert.equal(replied.replies[0].authorKind, 'agent'); assert.match(replied.replies[0].id, uuid);
  await failure(await mineOf(base, null), 400, 'visitor_invalid');
  await failure(await mineOf(base, 'A'.repeat(64)), 400, 'visitor_invalid');
  await failure(await mineOf(base, COMMENT.a, '?page=ftp%3A%2F%2Fexample.com%2F'), 400, 'invalid_input');
  await failure(await fetch(`${base}/_board/comments/mine`, { method: 'POST', headers: { 'x-board-visitor': COMMENT.a } }), 405, 'method_not_allowed');
  await failure(await fetch(`${base}/_board/comments/other`), 404, 'not_found');
  for (let index = 0; index < 32; index++) await post(`visitor-c-${index}`, COMMENT.c, `C ${index}`, page2);
  const many = await threads(COMMENT.c);
  assert.equal(many.length, 30); assert.equal(many[0].text, 'C 31'); assert.equal(many[29].text, 'C 2');
  const target = many[0].id;
  for (let index = 0; index < 20; index++) assert.equal((await replyTo(base, target, `ir-many-${index}`, { text: `reply ${index}` })).status, 201);
  await failure(await replyTo(base, target, 'ir-many-20', { text: 'one too many' }), 409, 'reply_limit');
  assert.deepEqual((await threads(COMMENT.c))[0].replies.map(reply => reply.text), Array.from({ length: 20 }, (_, index) => `reply ${index}`));
  const everything = [await mineOf(base, COMMENT.a).then(r => r.text()), JSON.stringify(await exported(base, '?cursor=0&limit=100')), JSON.stringify(await exported(base, '?cursor=0&limit=100&format=2'))].join('\n');
  for (const secret of [COMMENT.a, COMMENT.b, COMMENT.c]) { assert.equal(everything.includes(secret), false); assert.equal(everything.includes(digest(`board-visitor:v1:${secret}`)), false); }
});

test('owner replies need the host-held token, refuse browsers, replay exactly and keep their bounds', async t => {
  const { base, server, app } = await commentApp(t);
  const comment = (await (await sendComment(base, 'visitor-intent', { text: 'Question' }, { 'x-board-visitor': COMMENT.a })).json()).comment, id = comment.externalId;
  await failure(await replyTo(base, id, 'ir-browser', { text: 'x' }, { ...ownerHeaders, origin: COMMENT.page }), 403, 'browser_forbidden');
  assert.equal((await replyTo(base, id, 'ir-browser', { text: 'x' }, { ...ownerHeaders, origin: 'https://evil.example' })).status, 403);
  await failure(await replyTo(base, id, 'ir-wrong', { text: 'x' }, { authorization: 'Bearer wrong' }), 401, 'unauthorized');
  await failure(await replyTo(base, id, 'ir-none', { text: 'x' }, {}), 401, 'unauthorized');
  delete process.env.BOARD_INBOX_EXPORT_TOKEN;
  await failure(await replyTo(base, id, 'ir-off', { text: 'x' }), 404, 'export_disabled');
  process.env.BOARD_INBOX_EXPORT_TOKEN = 'short';
  await failure(await replyTo(base, id, 'ir-off', { text: 'x' }), 404, 'export_disabled');
  process.env.BOARD_INBOX_EXPORT_TOKEN = COMMENT.token;
  await failure(await replyTo(base, 'not-a-comment-id', 'ir-bad-id', { text: 'x' }), 404, 'comment_not_found');
  await failure(await replyTo(base, '00000000-0000-4000-8000-000000000000', 'ir-unknown', { text: 'x' }), 404, 'comment_not_found');
  await failure(await replyTo(base, id, null, { text: 'x' }), 400, 'invalid_input');
  for (const body of [{}, { text: '' }, { text: ' \n ' }, { text: 'x'.repeat(2001) }, { text: 'a\rb' }, { text: 'a\u0000' }, { text: 'a\u007f' }, { text: 'x', extra: 1 }, { text: 'x', authorKind: 'bot' }, { text: 5 }, []])
    await failure(await replyTo(base, id, 'ir-invalid', body), 400, 'invalid_input');
  const first = await replyTo(base, id, 'ir-first', { text: '  第一行\n\t第二行  ' });
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.deepEqual(Object.keys(created), ['deploymentId', 'replayed', 'reply']); assert.equal(created.deploymentId, server.deploymentId); assert.equal(created.replayed, false);
  assert.deepEqual({ ...created.reply, replyId: 'id', createdAt: 'at' }, { replyId: 'id', commentExternalId: id, text: '第一行\n\t第二行', authorKind: 'owner', createdAt: 'at', idempotencyKey: 'ir-first' });
  const replay = await replyTo(base, id, 'ir-first', { text: '第一行\n\t第二行' });
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), { ...created, replayed: true });
  await failure(await replyTo(base, id, 'ir-first', { text: 'different' }), 409, 'idempotency_conflict');
  await failure(await replyTo(base, id, 'ir-first', { text: '第一行\n\t第二行', authorKind: 'agent' }), 409, 'idempotency_conflict');
  const other = (await (await sendComment(base, 'visitor-intent-2', { text: 'Another' })).json()).comment.externalId;
  await failure(await replyTo(base, other, 'ir-first', { text: '第一行\n\t第二行' }), 409, 'idempotency_conflict');
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM _board_comment_replies').get().n, 1);
  await server.close();
  const disabled = await fs.readFile(path.join(app.root, 'board-app.json'), 'utf8').then(JSON.parse);
  await fs.writeFile(path.join(app.root, 'board-app.json'), JSON.stringify({ ...disabled, comments: { enabled: false } }));
  const off = await reloadTracked(app), offBase = `http://127.0.0.1:${off.port}`;
  await failure(await replyTo(offBase, id, 'ir-disabled', { text: 'x' }), 404, 'comments_disabled');
  await failure(await mineOf(offBase, COMMENT.a), 404, 'comments_disabled');
  await failure(await fetch(`${offBase}/_board/comments`, { headers: ownerHeaders }), 404, 'comments_disabled');
});

test('export pages stay within 90,000 characters, always carry one row, and v2 adds only visitor tags', async t => {
  const { base, server } = await commentApp(t, { limits: RELAXED });
  for (let index = 0; index < 14; index++) assert.equal((await sendComment(base, `long-row-${index}`, { text: `${index}`.padEnd(8000, 'x') })).status, 201);
  for (const query of ['?cursor=0&limit=100', '?cursor=0&limit=100&format=2']) {
    const page = await exported(base, query), size = page.comments.reduce((total, row) => total + JSON.stringify(row).length, 0);
    assert.ok(size <= 90_000 && size + 8100 > 90_000, `${query}: ${size}`); assert.equal(page.nextCursor, String(page.comments.length));
    const rest = await exported(base, `${query.replace('cursor=0', `cursor=${page.nextCursor}`)}`);
    assert.equal(page.comments.length + rest.comments.length, 14); assert.equal(rest.nextCursor, '14');
  }
  server.db.prepare(OLD_INSERT).run('00000000-0000-4000-8000-0000000000ff', 'huge-raw-row', 'x', 'h'.repeat(100_000), null, null, null, '2026-11-01T00:00:00.000Z');
  const huge = await exported(base, '?cursor=14&limit=100');
  assert.equal(huge.comments.length, 1); assert.equal(huge.nextCursor, '15');
  for (const [key, secret] of [['tagged-a-1', COMMENT.a], ['tagged-a-2', COMMENT.a], ['tagged-b-1', COMMENT.b]]) assert.equal((await sendComment(base, key, { text: key }, { 'x-board-visitor': secret })).status, 201);
  const v2 = await exported(base, '?cursor=15&format=2');
  assert.deepEqual(Object.keys(v2), ['deploymentId', 'format', 'cursor', 'nextCursor', 'comments']);
  const tags = v2.comments.map(row => row.visitorTag);
  assert.match(tags[0], /^[a-f0-9]{12}$/); assert.equal(tags[0], tags[1]); assert.notEqual(tags[0], tags[2]); assert.equal(tags[0], tagOf(COMMENT.a));
  assert.deepEqual(Object.keys(await exported(base, '?cursor=15&format=1')), ['deploymentId', 'cursor', 'nextCursor', 'comments']);
  await failure(await fetch(`${base}/_board/comments?cursor=-1`, { headers: ownerHeaders }), 400, 'invalid_input');
  await failure(await fetch(`${base}/_board/comments?limit=101`, { headers: ownerHeaders }), 400, 'invalid_input');
  await failure(await fetch(`${base}/_board/comments`, { headers: { authorization: 'Bearer wrong' } }), 401, 'unauthorized');
});

test('visitor post replays: the same payload and visitor replay, anything else conflicts, and old intents still replay', async t => {
  const { base, server } = await commentApp(t);
  const body = { text: 'Hello', anchor: { selector: '#a', quote: 'b' } };
  const first = await sendComment(base, 'replay-intent', body, { 'x-board-visitor': COMMENT.a });
  assert.equal(first.status, 201);
  const original = (await first.json()).comment;
  const replay = await sendComment(base, 'replay-intent', { anchor: { selector: '#a', quote: 'b' }, text: ' Hello ' }, { 'x-board-visitor': COMMENT.a });
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), { deploymentId: server.deploymentId, comment: original, replayed: true });
  await failure(await sendComment(base, 'replay-intent', body, { 'x-board-visitor': COMMENT.b }), 409, 'idempotency_conflict');
  await failure(await sendComment(base, 'replay-intent', body), 409, 'idempotency_conflict');
  await failure(await sendComment(base, 'replay-intent', { ...body, text: 'Changed' }, { 'x-board-visitor': COMMENT.a }), 409, 'idempotency_conflict');
  await failure(await sendComment(base, 'no', body), 400, 'invalid_input');
  await failure(await fetch(`${base}/_board/comments`, { method: 'POST', headers: { 'content-type': 'text/plain', 'idempotency-key': 'plain-intent' }, body: 'x' }), 415, 'unsupported_media_type');
  await failure(await fetch(`${base}/_board/comments`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'broken-json' }, body: '{' }), 400, 'invalid_input');
  // An intent stored by the 4b94741 runtime hashed the untrimmed name and the raw URL.
  const legacy = { text: 'Legacy', authorName: ' Ann ', pageUrl: 'https://pages.example' };
  server.db.prepare(OLD_INSERT).run('00000000-0000-4000-8000-000000000042', 'legacy-intent', digest(JSON.stringify(legacy)), 'Legacy', ' Ann ', 'https://pages.example', null, '2026-11-01T00:00:00.000Z');
  const old = await sendComment(base, 'legacy-intent', legacy);
  assert.equal(old.status, 200); assert.deepEqual((await old.json()).comment, { externalId: '00000000-0000-4000-8000-000000000042', text: 'Legacy', createdAt: '2026-11-01T00:00:00.000Z', authorName: 'Ann', pageUrl: 'https://pages.example/' });
});

test('comment rate limits per IP, visitor, everyone, page and stored bytes answer 429 or 507 with Retry-After; replays are exempt', async t => {
  await t.test('per IP and per visitor', async s => {
    const { base } = await commentApp(s, { limits: { postPerIpMinute: 2, postPerVisitorMinute: 2 } });
    assert.equal((await sendComment(base, 'ip-one-1', { text: '1' }, from('198.51.100.1'))).status, 201);
    assert.equal((await sendComment(base, 'ip-one-2', { text: '2' }, from('198.51.100.1'))).status, 201);
    const limited = await failure(await sendComment(base, 'ip-one-3', { text: '3' }, { ...from('198.51.100.1'), origin: COMMENT.page }), 429, 'rate_limited');
    assert.ok(+limited.headers.get('retry-after') >= 1 && +limited.headers.get('retry-after') <= 60); assert.equal(limited.headers.get('access-control-expose-headers'), 'Retry-After');
    assert.equal((await sendComment(base, 'ip-one-1', { text: '1' }, from('198.51.100.1'))).status, 200, 'a replay is not a new post');
    assert.equal((await sendComment(base, 'visitor-1', { text: 'v' }, { ...from('198.51.100.2'), 'x-board-visitor': COMMENT.a })).status, 201);
    assert.equal((await sendComment(base, 'visitor-2', { text: 'v' }, { ...from('198.51.100.3'), 'x-board-visitor': COMMENT.a })).status, 201);
    await failure(await sendComment(base, 'visitor-3', { text: 'v' }, { ...from('198.51.100.4'), 'x-board-visitor': COMMENT.a }), 429, 'rate_limited');
    assert.equal((await sendComment(base, 'visitor-4', { text: 'v' }, from('198.51.100.4'))).status, 201, 'a refused post spends nothing');
    assert.equal((await sendComment(base, 'visitor-5', { text: 'v' }, { ...from('198.51.100.4'), 'x-board-visitor': COMMENT.b })).status, 201);
  });
  await t.test('per IP per hour', async s => {
    const { base } = await commentApp(s, { limits: { postPerIpHour: 2 } });
    for (const key of ['hourly-1', 'hourly-2']) assert.equal((await sendComment(base, key, { text: key })).status, 201);
    const limited = await failure(await sendComment(base, 'hourly-3', { text: 'x' }), 429, 'rate_limited');
    assert.ok(+limited.headers.get('retry-after') >= 1 && +limited.headers.get('retry-after') <= 3600);
  });
  await t.test('everyone', async s => {
    const { base } = await commentApp(s, { limits: { postGlobalMinute: 3 } });
    for (const n of [1, 2, 3]) assert.equal((await sendComment(base, `global-${n}`, { text: 'g' }, from(`203.0.113.${n}`))).status, 201);
    await failure(await sendComment(base, 'global-4', { text: 'g' }, from('203.0.113.4')), 429, 'rate_limited');
  });
  await t.test('per page per day', async s => {
    const { base } = await commentApp(s, { limits: { postPerPageDay: 2 } });
    const page = `${COMMENT.page}/pages/boards/s9/`;
    assert.equal((await sendComment(base, 'per-page-1', { text: 'p', pageUrl: page })).status, 201);
    assert.equal((await sendComment(base, 'per-page-2', { text: 'p', pageUrl: `${page}index.html?x=1#y` })).status, 201);
    const limited = await failure(await sendComment(base, 'per-page-3', { text: 'p', pageUrl: page }), 429, 'rate_limited');
    assert.ok(+limited.headers.get('retry-after') >= 1 && +limited.headers.get('retry-after') <= 86400);
    assert.equal((await sendComment(base, 'per-page-4', { text: 'p', pageUrl: `${COMMENT.page}/pages/boards/s8/` })).status, 201);
    assert.equal((await sendComment(base, 'per-page-5', { text: 'no page' })).status, 201);
  });
  await t.test('stored bytes', async s => {
    const { base, server } = await commentApp(s, { limits: { maxStoredBytes: 300 } });
    assert.equal((await sendComment(base, 'stored-bytes-1', { text: '字'.repeat(60), authorName: 'ab' })).status, 201);
    assert.equal(server.db.prepare("SELECT value FROM _board_runtime_meta WHERE key='comments_bytes'").get().value, '182');
    await failure(await sendComment(base, 'stored-bytes-2', { text: 'x'.repeat(119) }), 507, 'storage_full');
    assert.equal((await sendComment(base, 'stored-bytes-3', { text: 'x'.repeat(118) })).status, 201);
    await failure(await sendComment(base, 'stored-bytes-4', { text: 'x' }), 507, 'storage_full');
  });
  await t.test('mine per visitor and per IP', async s => {
    const { base } = await commentApp(s, { limits: { minePerVisitorMinute: 2, minePerIpMinute: 3 } });
    for (let index = 0; index < 2; index++) assert.equal((await mineOf(base, COMMENT.a, '', from('198.51.100.7'))).status, 200);
    await failure(await mineOf(base, COMMENT.a, '', from('198.51.100.8')), 429, 'rate_limited');
    assert.equal((await mineOf(base, COMMENT.b, '', from('198.51.100.9'))).status, 200);
    assert.equal((await mineOf(base, COMMENT.c, '', from('198.51.100.9'))).status, 200);
    assert.equal((await mineOf(base, COMMENT.c, '', from('198.51.100.9'))).status, 200);
    await failure(await mineOf(base, 'd'.repeat(64), '', from('198.51.100.9')), 429, 'rate_limited');
  });
  await t.test('every comment request per IP, including replays, mine and preflight; owner routes are exempt', async s => {
    const { base } = await commentApp(s, { limits: { requestsPerIpMinute: 4 } });
    const ip = from('192.0.2.50');
    assert.equal((await sendComment(base, 'ceiling-1', { text: 'c' }, ip)).status, 201);
    assert.equal((await sendComment(base, 'ceiling-1', { text: 'c' }, ip)).status, 200);
    assert.equal((await mineOf(base, COMMENT.a, '', ip)).status, 200);
    assert.equal((await fetch(`${base}/_board/comments`, { method: 'OPTIONS', headers: { ...ip, origin: COMMENT.page, 'access-control-request-method': 'POST' } })).status, 204);
    await failure(await sendComment(base, 'ceiling-1', { text: 'c' }, ip), 429, 'rate_limited');
    await failure(await fetch(`${base}/_board/comments/mine`, { method: 'OPTIONS', headers: { ...ip, origin: COMMENT.page } }), 429, 'rate_limited');
    assert.equal((await fetch(`${base}/_board/comments?cursor=0`, { headers: { ...ip, ...ownerHeaders } })).status, 200);
    assert.equal((await mineOf(base, COMMENT.a, '', from('192.0.2.51'))).status, 200);
  });
});

test('client addresses: forwarded headers count only from trusted proxies, right-most untrusted first, IPv6 by /64', async t => {
  const trusted = commentSettings({ comments: {} }).trusted, request = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
  assert.deepEqual(resolveClient(request('127.0.0.1'), trusted), { address: '127.0.0.1', mode: 'socket' });
  assert.deepEqual(resolveClient(request('127.0.0.1', from('203.0.113.9, 198.51.100.1')), trusted), { address: '198.51.100.1', mode: 'forwarded' });
  assert.deepEqual(resolveClient(request('::ffff:127.0.0.1', from('203.0.113.9, 198.51.100.1, 127.0.0.1')), trusted), { address: '198.51.100.1', mode: 'forwarded' });
  assert.deepEqual(resolveClient(request('::1', from('[2001:db8::5]:443, 198.51.100.1:8080')), trusted), { address: '198.51.100.1', mode: 'forwarded' });
  assert.deepEqual(resolveClient(request('127.0.0.1', from('198.51.100.1, unknown')), trusted), { address: '127.0.0.1', mode: 'forwarded' });
  assert.deepEqual(resolveClient(request('127.0.0.1', from('127.0.0.1')), trusted), { address: '127.0.0.1', mode: 'forwarded' });
  assert.deepEqual(resolveClient(request('127.0.0.1', { 'x-real-ip': '198.51.100.2' }), trusted), { address: '198.51.100.2', mode: 'forwarded' });
  assert.deepEqual(resolveClient(request('192.0.2.10', from('198.51.100.1')), trusted), { address: '192.0.2.10', mode: 'proxied-unconfigured' });
  assert.deepEqual(resolveClient(request('192.0.2.10', { 'x-real-ip': '198.51.100.1' }), trusted), { address: '192.0.2.10', mode: 'proxied-unconfigured' });
  assert.deepEqual(resolveClient(request('192.0.2.10', from('198.51.100.1')), commentSettings({ comments: { trustedProxies: ['192.0.2.10'] } }).trusted), { address: '198.51.100.1', mode: 'forwarded' });
  assert.equal(addressKey('2001:db8:1:2:3:4:5:6'), addressKey('2001:DB8:1:2:ffff::1'));
  assert.notEqual(addressKey('2001:db8:1:2::1'), addressKey('2001:db8:1:3::1'));
  for (const mapped of ['::ffff:198.51.100.4', '::ffff:c633:6404', '0:0:0:0:0:ffff:198.51.100.4']) assert.equal(addressKey(mapped), '198.51.100.4');
  assert.equal(addressKey('not an address'), null);
  const proxied = await commentApp(t, { trustedProxies: ['192.0.2.200'], limits: { postPerIpMinute: 1 } });
  const health = async (base, headers = {}) => (await fetch(`${base}/_board/health`, { headers }).then(r => r.json())).clientIp;
  assert.equal(await health(proxied.base), 'socket');
  assert.equal(await health(proxied.base, from('198.51.100.1')), 'proxied-unconfigured');
  assert.equal((await sendComment(proxied.base, 'spoofed-1', { text: 's' }, from('198.51.100.1'))).status, 201);
  await failure(await sendComment(proxied.base, 'spoofed-2', { text: 's' }, from('198.51.100.2')), 429, 'rate_limited');
  const local = await commentApp(t, { limits: { postPerIpMinute: 1 } });
  assert.equal(await health(local.base, { 'x-real-ip': '198.51.100.1' }), 'forwarded');
  assert.equal((await sendComment(local.base, 'ipv6-key-1', { text: '6' }, from('2001:db8:aa:bb::1'))).status, 201);
  await failure(await sendComment(local.base, 'ipv6-key-2', { text: '6' }, from('2001:db8:aa:bb:ffff::2')), 429, 'rate_limited');
  assert.equal((await sendComment(local.base, 'ipv6-key-3', { text: '6' }, from('2001:db8:aa:bc::1'))).status, 201);
});

test('the comment limiter fails closed when an IP map is full and creates visitor windows only after the IP checks pass', () => {
  const clock = { now: 1_800_000_000_000 }, limiter = createCommentLimiter({ ...COMMENT_LIMITS, postPerIpMinute: 1 }, { now: () => clock.now, maxKeys: 3 });
  const refused = (call, retryAfter) => assert.throws(call, error => error.status === 429 && error.code === 'rate_limited' && (retryAfter === undefined || error.retryAfter === retryAfter));
  for (const ip of ['a', 'b', 'c']) limiter.request(ip);
  refused(() => limiter.request('d'), 60);
  limiter.request('a');
  assert.equal(limiter.windows.requests.entries.size, 3);
  limiter.checkPost('a', 'visitor-1'); limiter.commitPost('a', 'visitor-1');
  refused(() => limiter.checkPost('a', 'visitor-2'));
  assert.deepEqual([...limiter.windows.postVisitorMinute.entries.keys()], ['visitor-1'], 'no window for a refused visitor');
  for (const ip of ['b', 'c']) { limiter.checkPost(ip, `visitor-${ip}`); limiter.commitPost(ip, `visitor-${ip}`); }
  refused(() => limiter.checkPost('d', 'visitor-d'), 60);
  assert.equal(limiter.windows.postVisitorMinute.entries.has('visitor-d'), false);
  for (const visitor of ['e', 'f', 'g']) limiter.mine('a', visitor);
  assert.deepEqual([...limiter.windows.mineVisitor.entries.keys()], ['e', 'f', 'g']);
  limiter.mine('a', 'h');
  assert.deepEqual([...limiter.windows.mineVisitor.entries.keys()], ['f', 'g', 'h'], 'visitor maps evict their oldest window');
  clock.now += 60_000;
  limiter.request('d');
  assert.deepEqual([...limiter.windows.requests.entries.keys()], ['d'], 'expired windows are swept each minute');
  const hourly = createCommentLimiter({ ...COMMENT_LIMITS, postPerIpHour: 1 }, { now: () => 1_800_000_000_000 + 30 * 60_000 });
  hourly.commitPost('a', null);
  refused(() => hourly.checkPost('a', null), Math.ceil((Math.ceil((1_800_000_000_000 + 30 * 60_000) / 3_600_000) * 3_600_000 - (1_800_000_000_000 + 30 * 60_000)) / 1000));
});

test('comment settings in board-app.json are validated before start', async t => {
  const bad = [{ trustedProxies: '127.0.0.1' }, { trustedProxies: ['10.0.0.0/8'] }, { trustedProxies: ['proxy.example'] }, { trustedProxies: [1] }, { trustedProxies: Array.from({ length: 17 }, (_, index) => `192.0.2.${index}`) },
    { limits: [] }, { limits: { postPerIpMinute: 0 } }, { limits: { postPerIpMinute: 101 } }, { limits: { postPerIpMinute: 1.5 } }, { limits: { postPerIpMinute: '5' } }, { limits: { perIpMinute: 5 } }, { limits: { maxStoredBytes: 2_684_354_561 } }];
  for (const comments of bad) assert.throws(() => commentSettings({ comments }), /comments\.(trustedProxies|limits)/, JSON.stringify(comments));
  assert.deepEqual(commentSettings({ comments: { limits: { postPerIpMinute: 100, maxStoredBytes: 2_684_354_560 } } }).limits, { ...COMMENT_LIMITS, postPerIpMinute: 100, maxStoredBytes: 2_684_354_560 });
  assert.equal(commentSettings({}).enabled, false);
  const { app, root } = await fixture(t, { comments: { enabled: true, trustedProxies: ['10.0.0.0/8'] } });
  await assert.rejects(startApp(app), /comments\.trustedProxies/);
  assert.equal(await exists(path.join(app.dataDir, 'runtime.lock')), false);
  const config = JSON.parse(await fs.readFile(path.join(root, 'board-app.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'board-app.json'), JSON.stringify({ ...config, comments: { enabled: true, trustedProxies: ['10.0.0.1', 'fd00::1'], limits: { postPerIpMinute: 20 } } }));
  await reloadTracked(app);
});

test('health reports appKey, comment support and the client address mode; appKey survives restart and update-runtime', async t => {
  const { app, root } = await fixture(t);
  let server = await startTracked(app), base = `http://127.0.0.1:${server.port}`;
  const health = await fetch(`${base}/_board/health`).then(r => r.json());
  assert.deepEqual(Object.keys(health), ['status', 'id', 'appKey', 'deploymentId', 'instanceId', 'live', 'comments', 'clientIp']);
  assert.equal(health.appKey, digest(`board-app-key\0${app.owner.owner}`).slice(0, 16)); assert.match(health.appKey, /^[a-f0-9]{16}$/);
  assert.equal(health.comments, 0); assert.equal(health.clientIp, 'socket');
  await server.close();
  const update = await new Promise((resolve, reject) => { const child = spawn(process.execPath, [path.join(here, '../scripts/board-app.mjs'), 'update-runtime', '--dir', root], { stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; child.stderr.on('data', chunk => stderr += chunk); child.once('error', reject); child.once('close', code => resolve({ code, stderr })); });
  assert.equal(update.code, 0, update.stderr);
  const config = JSON.parse(await fs.readFile(path.join(root, 'board-app.json'), 'utf8'));
  await fs.writeFile(path.join(root, 'board-app.json'), JSON.stringify({ ...config, comments: { enabled: true } }));
  server = await reloadTracked(app); base = `http://127.0.0.1:${server.port}`;
  const again = await fetch(`${base}/_board/health`).then(r => r.json());
  assert.equal(again.appKey, health.appKey); assert.equal(again.comments, 2); assert.equal(again.deploymentId, health.deploymentId);
  assert.equal(again.clientIp, 'socket');
  const other = await fixture(t), otherServer = await startTracked(other.app);
  assert.notEqual((await fetch(`http://127.0.0.1:${otherServer.port}/_board/health`).then(r => r.json())).appKey, health.appKey);
});

test('CORS for visitor comments: preflight allows X-Board-Visitor, Retry-After is exposed, and private-network access is never granted', async t => {
  const { base } = await commentApp(t);
  const seen = [];
  const call = async (url, options = {}) => { const response = await fetch(url, options); seen.push(response); return response; };
  const preflight = await call(`${base}/_board/comments`, { method: 'OPTIONS', headers: { origin: COMMENT.page, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, idempotency-key, x-board-visitor', 'access-control-request-private-network': 'true' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), COMMENT.page);
  assert.deepEqual(preflight.headers.get('access-control-allow-headers').split(', '), ['Content-Type', 'Idempotency-Key', 'Authorization', 'X-Board-Visitor']);
  const minePreflight = await call(`${base}/_board/comments/mine?page=x`, { method: 'OPTIONS', headers: { origin: COMMENT.page, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-board-visitor', 'access-control-request-private-network': 'true' } });
  assert.equal(minePreflight.status, 204);
  const posted = await call(`${base}/_board/comments`, { method: 'POST', headers: { origin: COMMENT.page, 'content-type': 'application/json', 'idempotency-key': 'cors-intent', 'x-board-visitor': COMMENT.a }, body: JSON.stringify({ text: 'From the page' }) });
  assert.equal(posted.status, 201); assert.equal(posted.headers.get('access-control-allow-origin'), COMMENT.page); assert.equal(posted.headers.get('access-control-expose-headers'), 'Retry-After'); assert.equal(posted.headers.get('vary'), 'Origin');
  const listed = await call(`${base}/_board/comments/mine`, { headers: { origin: COMMENT.page, 'x-board-visitor': COMMENT.a } });
  assert.equal(listed.status, 200); assert.equal(listed.headers.get('access-control-expose-headers'), 'Retry-After');
  assert.equal((await call(`${base}/_board/health`, { headers: { origin: COMMENT.page, 'access-control-request-private-network': 'true' } })).status, 200);
  const evil = await call(`${base}/_board/comments`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'idempotency-key': 'cors-evil' }, body: JSON.stringify({ text: 'x' }) });
  assert.equal(evil.status, 403); assert.equal(evil.headers.get('access-control-allow-origin'), null);
  for (const response of seen) assert.equal([...response.headers.keys()].some(name => name.includes('private-network')), false);
});

test('visitor threads and replies survive backup and same-directory restore', async t => {
  const { app, directory, base, server } = await commentApp(t);
  const id = (await (await sendComment(base, 'kept-intent', { text: 'Kept' }, { 'x-board-visitor': COMMENT.a })).json()).comment.externalId;
  assert.equal((await replyTo(base, id, 'ir-kept-reply', { text: 'Kept reply', authorKind: 'agent' })).status, 201);
  const saved = await backup(app, path.join(directory, 'threads.sqlite'));
  assert.equal((await replyTo(base, id, 'ir-after-backup', { text: 'After backup' })).status, 201);
  await server.close();
  await restore(app, saved.file, saved.sha256);
  const restored = await startTracked(app), restoredBase = `http://127.0.0.1:${restored.port}`;
  const [thread] = (await mineOf(restoredBase, COMMENT.a).then(r => r.json())).threads;
  assert.deepEqual(thread.replies.map(reply => [reply.text, reply.authorKind]), [['Kept reply', 'agent']]);
  assert.equal(restored.db.prepare("SELECT value FROM _board_runtime_meta WHERE key='comments_schema'").get().value, '2');
});

test('an app whose runtime predates visitor threads migrates on its first start after update-runtime', async t => {
  setExportToken(t);
  const { root, app } = await fixture(t, { comments: { enabled: true } });
  const runtime = path.join(root, '.board/runtime');
  await fs.writeFile(path.join(runtime, 'comments.mjs'), '// an older runtime');
  const db = openDatabase(app.database);
  db.exec(OLD_COMMENTS_DDL); db.prepare(OLD_INSERT).run('00000000-0000-4000-8000-000000000007', 'pre-update', 'x', 'Kept across the update', null, null, '{"label":"L"}', '2026-11-01T00:00:00.000Z');
  db.close();
  const updated = await new Promise((resolve, reject) => { const child = spawn(process.execPath, [path.join(here, '../scripts/board-app.mjs'), 'update-runtime', '--dir', root], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk); child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
  assert.equal(updated.code, 0, updated.stderr); assert.deepEqual(JSON.parse(updated.stdout).files, ['cli.mjs', 'files.mjs', 'storage.mjs', 'comments.mjs', 'live.mjs', 'server.mjs', 'scaffold.mjs', 'ssh.mjs', 'remote.mjs', 'visitor.mjs']);
  assert.equal(await fs.readFile(path.join(runtime, 'comments.mjs'), 'utf8'), await fs.readFile(path.join(here, 'comments.mjs'), 'utf8'));
  const copied = await import(pathToFileURL(path.join(runtime, 'server.mjs')).href), copiedFiles = await import(pathToFileURL(path.join(runtime, 'files.mjs')).href);
  const server = await copied.startApp(await copiedFiles.loadApp(root)); app.testCleanup.push(server.close);
  const base = `http://127.0.0.1:${server.port}`;
  assert.equal((await fetch(`${base}/_board/health`).then(r => r.json())).comments, 2);
  assert.equal(server.db.prepare("SELECT value FROM _board_runtime_meta WHERE key='comments_schema'").get().value, '2');
  assert.deepEqual((await exported(base, '?cursor=0&format=2')).comments.map(row => [row.text, row.anchor]), [['Kept across the update', { label: 'L' }]]);
  assert.equal((await sendComment(base, 'post-update', { text: 'New thread' }, { 'x-board-visitor': COMMENT.a })).status, 201);
});

test('the scaffold documents owner replies, visitor threads and trusted proxies, and ships the comment runtime', async t => {
  const { root } = await fixture(t);
  assert.match(await fs.readFile(path.join(root, '.env.example'), 'utf8'), /^# Set a random 32\+ character token for the owner-controlled Board pull and owner replies\.\n# BOARD_INBOX_EXPORT_TOKEN=$/m);
  const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes("Comments never change this app. Replies are posted only by the Board owner's host with BOARD_INBOX_EXPORT_TOKEN. Visitors can list only their own comments and replies with an anonymous secret stored in their browser. Behind a reverse proxy on another machine, list the proxy's address in comments.trustedProxies."));
  assert.equal(readme.includes('posts a public reply'), false);
  const asset = JSON.parse(await fs.readFile(path.join(here, '../server/assets/app-runtime.txt'), 'utf8'));
  for (const name of ['backend/comments.mjs', 'backend/visitor.mjs']) assert.equal(asset.files[name], await fs.readFile(path.join(here, '..', name), 'utf8'));
});
