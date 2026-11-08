import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { acquireLock, digest, exists, noSymlinks, readJson, requireStopped, writeJson } from './files.mjs';

export function openDatabase(file, options = {}) {
  const db = new DatabaseSync(file, options);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
  if (!options.readOnly) db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL');
  return db;
}

function checkMigration(sql, name) {
  // Transaction control and connection-changing statements cannot escape the outer transaction.
  let tokens = '';
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('--', i)) { while (i < sql.length && sql[i] !== '\n') i++; tokens += ' '; }
    else if (sql.startsWith('/*', i)) { i += 2; while (i < sql.length && !sql.startsWith('*/', i)) i++; i++; tokens += ' '; }
    else if (['\'', '"', '`', '['].includes(sql[i])) {
      const end = sql[i] === '[' ? ']' : sql[i]; i++;
      while (i < sql.length) { if (sql[i] === end) { if (end !== ']' && sql[i + 1] === end) i += 2; else break; } else i++; }
      tokens += ' ';
    } else tokens += sql[i];
  }
  if (/\b(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|ATTACH|DETACH|VACUUM|PRAGMA)\b/i.test(tokens)) throw new Error(`Migration ${name} contains transaction or connection control; use plain transactional DDL/DML`);
}

export async function migrateUnlocked(app) {
  const directory = path.join(app.root, 'migrations');
  const files = (await fs.readdir(directory)).filter(name => /^\d{3,}[-_][\w-]+\.sql$/.test(name)).sort();
  const migrations = [];
  for (const name of files) { const file = await noSymlinks(path.join(directory, name)); const sql = await fs.readFile(file, 'utf8'); checkMigration(sql, name); migrations.push({ name, sql, sha: digest(sql) }); }
  const db = openDatabase(app.database);
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('CREATE TABLE IF NOT EXISTS _board_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
    const history = () => db.prepare('SELECT name, sha256, applied_at FROM _board_migrations ORDER BY name').all();
    const schema = () => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name='_board_migrations' ORDER BY type,name").all();
    const previous = history();
    const historySchema = JSON.stringify(schema());
    for (const row of previous) if (migrations.find(m => m.name === row.name)?.sha !== row.sha256) throw new Error(`Applied migration changed or disappeared: ${row.name}`);
    const applied = [];
    for (const migration of migrations) {
      if (previous.some(row => row.name === migration.name)) continue;
      if (previous.length && migration.name <= previous.at(-1).name) throw new Error(`Migration must follow existing history: ${migration.name}`);
      const recorded = JSON.stringify(history());
      db.exec(migration.sql);
      if (JSON.stringify(history()) !== recorded || JSON.stringify(schema()) !== historySchema) throw new Error('A migration changed the protected migration history');
      db.prepare('INSERT INTO _board_migrations VALUES (?, ?, ?)').run(migration.name, migration.sha, new Date().toISOString());
      applied.push(migration.name);
    }
    db.exec('COMMIT');
    return { applied };
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}

export async function migrate(app) {
  const unlock = await acquireLock(app, 'operation');
  try { await requireStopped(app); return await migrateUnlocked(app); } finally { await unlock(); }
}

function integrity(file) {
  const db = openDatabase(file, { readOnly: true });
  try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('SQLite integrity check failed'); }
  finally { db.close(); }
}

function commentSequence(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='_board_comments'").get()) return 0;
  return Math.max(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='_board_comments'").get()?.seq || 0, db.prepare('SELECT max(seq) AS seq FROM _board_comments').get()?.seq || 0);
}

export async function backupUnlocked(app, destination) {
  if (!(await exists(app.database))) throw new Error('No database exists; run migrate first');
  const target = await noSymlinks(destination);
  if (await exists(target) || await exists(`${target}.json`)) throw new Error('Backup destination already exists');
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.partial`;
  const db = openDatabase(app.database, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(temporary);
    await fs.chmod(temporary, 0o600);
    const durable = await fs.open(temporary, 'r+'); try { await durable.sync(); } finally { await durable.close(); }
    integrity(temporary);
    const sha256 = digest(await fs.readFile(temporary));
    await fs.rename(temporary, target);
    const identityFile = path.join(app.dataDir, 'identity.json');
    const identity = await exists(identityFile) ? await readJson(await noSymlinks(identityFile)) : null;
    await writeJson(`${target}.json`, { version: 1, id: app.owner.id, owner: app.owner.owner, ...(identity ? { deploymentId: identity.deploymentId } : {}), commentHighWater: commentSequence(db), createdAt: new Date().toISOString(), sha256 });
    return { file: target, sha256 };
  } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  finally { db.close(); }
}

export async function backup(app, destination) {
  const unlock = await acquireLock(app, 'operation');
  try { return await backupUnlocked(app, destination); } finally { await unlock(); }
}

export async function restore(app, source, expectedSha) {
  const unlock = await acquireLock(app, 'operation');
  try {
    await requireStopped(app);
    await noSymlinks(source);
    const bytes = await fs.readFile(source), meta = await readJson(await noSymlinks(`${source}.json`));
    if (!expectedSha || digest(bytes) !== expectedSha || meta.sha256 !== expectedSha || meta.id !== app.owner.id || meta.owner !== app.owner.owner) throw new Error('Backup identity/digest mismatch; pass --confirm with the reviewed backup SHA-256');
    integrity(source);
    const identityFile = await noSymlinks(path.join(app.dataDir, 'identity.json'));
    if (meta.deploymentId && !/^[\da-f-]{36}$/.test(meta.deploymentId)) throw new Error('Backup has an invalid deployment identity');
    const oldIdentity = await exists(identityFile) ? await readJson(identityFile) : null;
    if (meta.deploymentId && oldIdentity && oldIdentity.deploymentId !== meta.deploymentId) throw new Error('Backup belongs to another deployment identity');
    const safety = await exists(app.database) ? await backupUnlocked(app, path.join(app.dataDir, 'backups', `before-restore-${Date.now()}.sqlite`)) : null;
    const replacement = `${app.database}.${process.pid}.restore`;
    await fs.writeFile(replacement, bytes, { flag: 'wx', mode: 0o600 });
    const durable = await fs.open(replacement, 'r+'); try { await durable.sync(); } finally { await durable.close(); }
    // No scaffold server is running. Checkpoint and close the old connection before replacing its file.
    let highWater = Math.max(meta.commentHighWater || 0, oldIdentity?.commentHighWater || 0);
    const hadDatabase = await exists(app.database);
    if (hadDatabase) { const db = openDatabase(app.database); try { highWater = Math.max(highWater, commentSequence(db)); if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy) throw new Error('Another SQLite connection is active; stop all database users before restore'); } finally { db.close(); } }
    // Preserve the stream high-water before replacing the database, including across an interrupted restore.
    const deploymentId = oldIdentity && hadDatabase ? oldIdentity.deploymentId : randomUUID();
    const identityTemporary = `${identityFile}.${process.pid}.restore`;
    await fs.writeFile(identityTemporary, JSON.stringify({ deploymentId, owner: app.owner.owner, commentHighWater: highWater }), { flag: 'wx', mode: 0o600 });
    const identityHandle = await fs.open(identityTemporary, 'r+'); try { await identityHandle.sync(); } finally { await identityHandle.close(); }
    await fs.rename(identityTemporary, identityFile);
    const directoryHandle = await fs.open(app.dataDir, 'r'); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    for (const suffix of ['-wal', '-shm']) { await noSymlinks(`${app.database}${suffix}`); await fs.rm(`${app.database}${suffix}`, { force: true }); }
    await fs.rename(replacement, app.database);
    return { restored: app.database, sha256: expectedSha, safetyBackup: safety, deploymentId, newCommentSourceRequired: deploymentId !== meta.deploymentId, commentHighWater: highWater };
  } finally { await unlock(); }
}
