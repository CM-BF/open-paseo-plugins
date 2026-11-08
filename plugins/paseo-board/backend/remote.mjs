// Self-contained SSH controller. Transferred as reviewed code and executed only after explicit confirmation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
const exists = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function plainPath(file) {
  let current = '/';
  for (const part of path.resolve(file).split('/').filter(Boolean)) { current = path.join(current, part); try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlink refused: ${current}`); } catch (error) { if (error.code === 'ENOENT') break; throw error; } }
}

async function waitFor(check, seconds = 10) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Owned process did not reach the expected state; inspect logs and locks before retry');
}

async function run(request) {
  const { root, appId, owner, release, node, operation } = request;
  if (!/^\/[\s\S]+/.test(root) || root.split('/').length < 4 || root.split('/').some(x => x === '..' || x === '.') || !/^[a-z][a-z0-9-]{0,62}$/.test(appId) || !/^[a-f0-9-]{36}$/.test(owner) || !/^[a-f0-9]{64}$/.test(release)) throw new Error('Invalid deployment request');
  await plainPath(root);
  const marker = path.join(root, '.board-deploy-owner.json');
  await plainPath(marker);
  if (!(await exists(marker))) {
    if (operation !== 'deploy') throw new Error('No owned deployment exists');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if ((await fs.readdir(root)).length) throw new Error('Refusing an unowned nonempty remote directory');
    await fs.writeFile(marker, JSON.stringify({ appId, owner }), { flag: 'wx', mode: 0o600 });
  }
  const identity = await json(marker);
  if (identity.appId !== appId || identity.owner !== owner) throw new Error('Remote app owner mismatch');
  const shared = path.join(root, 'shared'), data = path.join(shared, 'data');
  const pointer = path.join(root, 'current.json'), log = path.join(shared, 'app.log');
  await plainPath(pointer); await plainPath(log);
  await plainPath(shared);
  if (operation === 'logs') { if (!(await exists(log))) return { logs: '' }; await plainPath(log); const handle = await fs.open(log, 'r'); try { const stat = await handle.stat(), buffer = Buffer.alloc(Math.min(stat.size, 32768)); await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length)); return { logs: buffer.toString('utf8') }; } finally { await handle.close(); } }
  const stateFile = path.join(data, 'server.json'), runtimeLock = path.join(data, 'runtime.lock');
  async function health() {
    if (!(await exists(stateFile))) return { status: 'stopped' };
    await plainPath(stateFile);
    const state = await json(stateFile);
    const result = await fetch(`http://${state.host?.includes(':') ? '[::1]' : '127.0.0.1'}:${state.port}/_board/health`, { signal: AbortSignal.timeout(2000) }).then(response => response.json());
    if (result.instanceId !== state.instanceId || result.id !== appId) throw new Error('Process identity mismatch; no process was signalled');
    return { ...result, status: 'running', port: state.port };
  }
  if (operation === 'status') return await health();
  await fs.mkdir(shared, { recursive: true, mode: 0o700 });
  const lockFile = path.join(root, 'deploy.lock'); await plainPath(lockFile); const lock = await fs.open(lockFile, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, operation, release })); await lock.close();
  try {
    async function stop() {
      if (!(await exists(stateFile))) { if (await exists(runtimeLock)) throw new Error('Runtime lock exists without a server record; reconcile before continuing'); return; }
      await health(); const state = await json(stateFile);
      const response = await fetch(`http://${state.host?.includes(':') ? '[::1]' : '127.0.0.1'}:${state.port}/_board/shutdown`, { method: 'POST', headers: { 'x-board-control': state.controlToken }, signal: AbortSignal.timeout(3000) });
      if (response.status !== 202) throw new Error('Owned server refused shutdown');
      await waitFor(async () => !(await exists(runtimeLock)) && !(await exists(stateFile)));
    }
    if (operation === 'stop') { if (await exists(pointer) && (await json(pointer)).release !== release) throw new Error('Use the current release plan to stop the app'); await stop(); return { status: 'stopped' }; }
    let releaseDir;
    if (operation === 'deploy') {
      const releases = path.join(root, 'releases'); await plainPath(releases); await fs.mkdir(releases, { recursive: true, mode: 0o700 });
      releaseDir = path.join(releases, release);
      if (await exists(releaseDir)) throw new Error('Release already exists; inspect status and create a fresh reviewed plan for a new deployment');
      const staging = `${releaseDir}.partial`; await fs.mkdir(staging, { mode: 0o700 });
      let total = 0;
      if (!Array.isArray(request.files) || request.files.length > 1000) throw new Error('Invalid file inventory');
      for (const file of request.files) {
        if (!file.path || path.isAbsolute(file.path) || file.path.includes('\\') || file.path.split('/').some(x => !x || x === '..' || /^\.env(?:\.|$)/.test(x))) throw new Error('Invalid deployment path');
        const bytes = Buffer.from(file.content, 'base64'); total += bytes.length;
        if (total > 20 * 1024 * 1024 || bytes.length !== file.bytes || sha(bytes) !== file.sha256) throw new Error('Deployment file digest/size mismatch');
        const target = path.join(staging, file.path); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
      }
      await fs.rename(staging, releaseDir);
    } else {
      const current = await json(pointer);
      if (current.release !== release) throw new Error('Plan does not identify the current remote release; use its exact current plan');
      if (!/^[a-f0-9]{64}$/.test(current.release)) throw new Error('Invalid current release pointer');
      releaseDir = path.join(root, 'releases', current.release); await plainPath(releaseDir);
    }
    const envFile = path.join(shared, '.env');
    if (await exists(envFile)) { await plainPath(envFile); process.loadEnvFile(envFile); }
    process.env.BOARD_APP_DATA_DIR = data;
    const { loadApp } = await import(pathToFileURL(path.join(releaseDir, '.board/runtime/files.mjs')));
    const { migrate, backup } = await import(pathToFileURL(path.join(releaseDir, '.board/runtime/storage.mjs')));
    const app = await loadApp(releaseDir);
    if (app.owner.id !== appId || app.owner.owner !== owner) throw new Error('Uploaded app identity mismatch');
    const backupFile = path.join(shared, 'backups', `${Date.now()}-${release.slice(0, 12)}.sqlite`);
    if (operation === 'backup') return await backup(app, backupFile);
    if (operation === 'migrate') { if (await exists(runtimeLock)) throw new Error('Stop the remote app before migration'); return await migrate(app); }
    if (!['deploy', 'start'].includes(operation)) throw new Error('Unknown operation');
    if (operation === 'start' && await exists(runtimeLock)) return await health();
    if (operation === 'deploy') await stop();
    const previousBackup = operation === 'deploy' && await exists(app.database) ? await backup(app, backupFile) : null;
    await migrate(app);
    const output = await fs.open(log, 'a', 0o600);
    let child;
    try { child = spawn(node, [path.join(releaseDir, 'board-app.mjs'), 'start', '--dir', releaseDir], { cwd: releaseDir, detached: true, stdio: ['ignore', output.fd, output.fd], env: { ...process.env, BOARD_APP_DATA_DIR: data } }); }
    finally { await output.close(); }
    let startupError; child.once('error', error => { startupError = error; }); child.once('exit', code => { startupError = new Error(`New application exited with code ${code}; inspect the retained application log`); }); child.unref();
    await waitFor(async () => { if (startupError) throw startupError; if (!(await exists(stateFile))) return false; const status = await health(); return status.status === 'running'; });
    const temporary = `${pointer}.next`; await fs.writeFile(temporary, JSON.stringify({ release, previousBackup }), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, pointer);
    return { status: 'deployed', release, previousBackup, health: await health() };
  } finally { await fs.unlink(lockFile); }
}

let input = '';
try {
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 30 * 1024 * 1024) throw new Error('Deployment input too large'); }
  console.log(JSON.stringify(await run(JSON.parse(input))));
} catch (error) { console.error(JSON.stringify({ status: 'failed-reconcile-before-retry', error: error.message })); process.exitCode = 1; }
