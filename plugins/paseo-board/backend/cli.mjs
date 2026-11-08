import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, loadApp, readJson } from './files.mjs';
import { initializeApp } from './scaffold.mjs';
import { backup, migrate, restore } from './storage.mjs';
import { startApp } from './server.mjs';
import { createSshPlan, runSsh } from './ssh.mjs';

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!/^--[a-z-]+$/.test(args[index]) || args[index + 1] === undefined || args[index + 1].startsWith('--') || result[args[index].slice(2)] !== undefined) throw new Error('Options require one explicit value and may not repeat');
    result[args[index].slice(2)] = args[index + 1];
  }
  return result;
}

export async function main(args) {
  try {
    const [command, ...remaining] = args;
    if (!command || command === 'help') { console.log('board-app init|start|status|stop|migrate|backup|restore --dir <app>\nboard-app ssh plan --dir <app> --host <alias> --root <absolute-path> --out <plan.json>\nboard-app ssh deploy|start|status|logs|stop|migrate|backup --plan <plan.json> [--confirm <digest>]'); return; }
    if (command === 'ssh') { const [operation, ...rest] = remaining, opts = options(rest); const result = operation === 'plan' ? await createSshPlan(opts) : await runSsh(operation, opts); console.log(JSON.stringify(result)); return; }
    const opts = options(remaining), directory = path.resolve(opts.dir || '.');
    if (command === 'init') { console.log(JSON.stringify(await initializeApp(directory, opts.id))); return; }
    const envFile = path.join(directory, '.env');
    if (await exists(envFile)) process.loadEnvFile(envFile);
    const app = await loadApp(directory);
    let result;
    if (command === 'start' || command === 'run') {
      const instance = await startApp(app);
      console.log(JSON.stringify({ status: 'listening', id: app.owner.id, host: app.config.host, port: instance.port, deploymentId: instance.deploymentId }));
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void instance.close().catch(error => { console.error(error.message); process.exitCode = 1; }); });
      return;
    }
    if (command === 'migrate') result = await migrate(app);
    else if (command === 'backup') { if (!opts.out) throw new Error('backup requires --out'); result = await backup(app, path.resolve(opts.out)); }
    else if (command === 'restore') { if (!opts.from) throw new Error('restore requires --from'); result = await restore(app, path.resolve(opts.from), opts.confirm); }
    else if (command === 'status' || command === 'stop') {
      const file = path.join(app.dataDir, 'server.json');
      if (!(await exists(file))) { result = { status: 'stopped' }; }
      else {
        const state = await readJson(file), url = `http://${state.host?.includes(':') ? '[::1]' : '127.0.0.1'}:${state.port}`;
        const health = await fetch(`${url}/_board/health`, { signal: AbortSignal.timeout(3000) }).then(response => response.json());
        if (health.instanceId !== state.instanceId || health.id !== app.owner.id) throw new Error('Running process identity does not match the owned server record');
        if (command === 'stop') { const response = await fetch(`${url}/_board/shutdown`, { method: 'POST', headers: { 'x-board-control': state.controlToken }, signal: AbortSignal.timeout(3000) }); if (response.status !== 202) throw new Error('Server rejected shutdown'); }
        result = { ...health, status: command === 'stop' ? 'stopping' : 'running' };
      }
    } else throw new Error(`Unknown command: ${command}`);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = 1; }
}
