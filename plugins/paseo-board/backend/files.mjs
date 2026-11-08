import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ownerFile = '.board-app-owner.json';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
export const exists = async file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
export async function writeJson(file, value) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
}

export async function noSymlinks(file) {
  const resolved = path.resolve(file);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlink is not allowed: ${current}`); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return resolved;
}

export async function claimDirectory(directory, owner) {
  await noSymlinks(directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const marker = path.join(directory, ownerFile);
  await noSymlinks(marker);
  if (await exists(marker)) {
    const actual = await readJson(marker);
    if (actual.id !== owner.id || actual.owner !== owner.owner) throw new Error(`Directory belongs to another app: ${directory}`);
  } else {
    if ((await fs.readdir(directory)).length) throw new Error(`Refusing unowned nonempty directory: ${directory}`);
    await writeJson(marker, owner);
  }
}

export function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || value.split('/').some(x => x === '..' || !x)) throw new Error(`Expected a relative file path: ${value}`);
  return value;
}

export async function loadApp(directory, { createData = true } = {}) {
  const root = await noSymlinks(directory);
  await noSymlinks(path.join(root, ownerFile));
  await noSymlinks(path.join(root, 'board-app.json'));
  const owner = await readJson(path.join(root, ownerFile));
  const config = await readJson(path.join(root, 'board-app.json'));
  if (config.version !== 1 || !/^[a-z][a-z0-9-]{0,62}$/.test(config.id) || owner.id !== config.id || !/^[\da-f-]{36}$/.test(owner.owner)) throw new Error('Invalid app identity or configuration');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535 || !['127.0.0.1', '0.0.0.0', '::1', '::'].includes(config.host)) throw new Error('Listen host must be 127.0.0.1, 0.0.0.0, ::1 or ::; use a proxy for other addresses');
  if (!Array.isArray(config.origins) || config.origins.some(origin => { try { const url = new URL(origin); return !['https:', 'http:'].includes(url.protocol) || url.origin !== origin || url.username || url.password; } catch { return true; } })) throw new Error('origins must contain exact HTTP(S) origins; wildcards and null origins are not allowed');
  if (typeof config.dataDir !== 'string' || !config.dataDir) throw new Error('dataDir must explicitly locate a durable directory');
  const dataDir = await noSymlinks(path.resolve(root, process.env.BOARD_APP_DATA_DIR || config.dataDir));
  if (dataDir === root || dataDir.startsWith(`${root}${path.sep}`)) throw new Error('Durable data must be outside the source directory');
  if (createData) await claimDirectory(dataDir, owner);
  const database = path.join(dataDir, 'app.sqlite');
  await noSymlinks(database);
  const entry = path.join(root, relativeFile(config.entry));
  await noSymlinks(entry);
  return { root, owner, config, dataDir, database, entry };
}

export async function acquireLock(app, name) {
  const file = path.join(app.dataDir, `${name}.lock`);
  await noSymlinks(file);
  const token = randomUUID();
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`${name} is locked; inspect ${file}. Never remove a lock while its owner is running.`); throw error; }
  await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
  await handle.close();
  return async () => { if ((await readJson(file)).token !== token) throw new Error('Operation lock ownership changed'); await fs.unlink(file); };
}

export async function requireStopped(app) {
  if (await exists(path.join(app.dataDir, 'runtime.lock'))) throw new Error('Stop this app before migration or restore; runtime.lock is present');
}
