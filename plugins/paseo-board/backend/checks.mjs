import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeApp } from './scaffold.mjs';
import { loadApp, readJson, digest, exists } from './files.mjs';
import { migrate, openDatabase, backup, restore } from './storage.mjs';
import { startApp } from './server.mjs';
import { createSshPlan, validatedPlan, shellQuote, runSsh, controllerCommand } from './ssh.mjs';
import { mountComments } from './visitor.mjs';

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
