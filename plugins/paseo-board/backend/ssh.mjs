import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { digest, loadApp, noSymlinks, readJson, relativeFile, writeJson } from './files.mjs';

export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const deniedName = name => /^(\.env(?:\..*)?|\.ssh|\.git|node_modules|.*\.(?:pem|key|p12|pfx|sqlite(?:-wal|-shm)?))$/i.test(name) || /^(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/i.test(name);

export async function deploymentFiles(root, entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('deployFiles must explicitly list files or directories');
  const files = new Map(); let bytes = 0;
  async function collect(relative) {
    relativeFile(relative);
    if (relative.split('/').some(deniedName)) throw new Error(`Private/runtime file cannot be deployed: ${relative}`);
    const full = await noSymlinks(path.join(root, relative)), stat = await fs.lstat(full);
    if (stat.isDirectory()) { for (const name of (await fs.readdir(full)).sort()) await collect(`${relative}/${name}`); return; }
    if (!stat.isFile()) throw new Error(`Only regular source files may deploy: ${relative}`);
    const contents = await fs.readFile(full);
    if (!files.has(relative)) bytes += contents.length;
    if (files.size >= 1000 || bytes > 20 * 1024 * 1024) throw new Error('Deployment exceeds 1000 files or 20 MiB');
    files.set(relative, { path: relative, sha256: digest(contents), bytes: contents.length });
  }
  for (const entry of entries) await collect(entry);
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function validateTarget(plan) {
  if (typeof plan.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,200}$/.test(plan.host)) throw new Error('Use a literal SSH config alias or user@hostname, without options');
  if (typeof plan.remoteRoot !== 'string' || !/^\/(?:[^\0\n\r/]+\/)*[^\0\n\r/]+$/.test(plan.remoteRoot) || plan.remoteRoot.split('/').some(x => x === '.' || x === '..') || plan.remoteRoot.split('/').length < 4) throw new Error('Remote root must be an explicit absolute app directory, below a parent directory');
  if (typeof plan.node !== 'string' || !(plan.node === 'node' || /^\/[A-Za-z0-9_./ -]+$/.test(plan.node))) throw new Error('node must be node or an absolute executable path');
}

export async function createSshPlan(opts) {
  if (!opts.out) throw new Error('ssh plan requires --out');
  const app = await loadApp(opts.dir || '.', { createData: false });
  const remoteSource = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'remote.mjs'), 'utf8');
  const plan = { version: 1, appId: app.owner.id, owner: app.owner.owner, sourceRoot: app.root, host: opts.host, remoteRoot: opts.root, node: opts.node || 'node', files: await deploymentFiles(app.root, app.config.deployFiles), controllerSha256: digest(remoteSource), operations: ['upload-reviewed-files', 'verify-owner', 'stop-owned-app', 'backup-existing-database', 'transactional-migrate', 'start-and-check-health'], excluded: ['.env', 'private keys', 'data', 'backups'], infrastructure: 'Node >=22.13; SSH known_hosts; TLS/reverse proxy and reboot supervision are configured separately' };
  validateTarget(plan);
  const sha256 = digest(JSON.stringify(plan));
  await writeJson(path.resolve(opts.out), { ...plan, sha256 });
  return { plan: path.resolve(opts.out), sha256, files: plan.files, host: plan.host, remoteRoot: plan.remoteRoot, operations: plan.operations };
}

export async function validatedPlan(file, { requireSource = true } = {}) {
  const { sha256, ...plan } = await readJson(file);
  if (plan.version !== 1 || digest(JSON.stringify(plan)) !== sha256) throw new Error('Plan digest is invalid');
  validateTarget(plan);
  if (requireSource) {
    const app = await loadApp(plan.sourceRoot, { createData: false });
    if (app.owner.owner !== plan.owner || app.owner.id !== plan.appId) throw new Error('Source app identity changed');
    const files = await deploymentFiles(app.root, app.config.deployFiles);
    if (JSON.stringify(files) !== JSON.stringify(plan.files)) throw new Error('Source files changed after review; generate and review a new plan');
  }
  // Operational commands use this installed controller, never executable text supplied by a plan file.
  const controller = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'remote.mjs'), 'utf8');
  if (requireSource && digest(controller) !== plan.controllerSha256) throw new Error('Deployment controller changed after review');
  return { ...plan, sha256, controller };
}

export async function runSsh(operation, opts, { executable = 'ssh' } = {}) {
  if (!['deploy', 'start', 'status', 'logs', 'stop', 'migrate', 'backup'].includes(operation)) throw new Error('Unknown SSH operation');
  if (!opts.plan) throw new Error('SSH operation requires --plan');
  const plan = await validatedPlan(opts.plan, { requireSource: operation === 'deploy' });
  if (!['status', 'logs'].includes(operation) && opts.confirm !== plan.sha256) throw new Error('Mutation requires --confirm with the reviewed plan digest');
  const files = operation === 'deploy' ? await Promise.all(plan.files.map(async file => {
    const bytes = await fs.readFile(path.join(plan.sourceRoot, file.path));
    if (digest(bytes) !== file.sha256) throw new Error('Source changed while packaging');
    return { ...file, content: bytes.toString('base64') };
  })) : [];
  const payload = { operation, root: plan.remoteRoot, appId: plan.appId, owner: plan.owner, release: plan.sha256, node: plan.node, files };
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '--', plan.host, `${shellQuote(plan.node)} --input-type=module -e ${shellQuote(plan.controller)}`];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', total = 0;
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('SSH operation timed out; reconcile the remote state before retrying')); }, 120000);
    const collect = (kind, chunk) => { total += chunk.length; if (total > 1024 * 1024) { child.kill('SIGTERM'); return reject(new Error('SSH output exceeded limit')); } if (kind === 'stdout') stdout += chunk; else stderr += chunk; };
    child.stdout.on('data', chunk => collect('stdout', chunk)); child.stderr.on('data', chunk => collect('stderr', chunk));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`SSH operation exited ${code}: ${stderr.slice(-4000) || stdout.slice(-4000)}. Reconcile before retrying.`)); });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(payload));
  });
  return { operation, host: plan.host, remoteRoot: plan.remoteRoot, output: String(output).trim() };
}
