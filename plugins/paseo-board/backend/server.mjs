import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { acquireLock, exists, noSymlinks, writeJson } from './files.mjs';
import { migrateUnlocked, openDatabase } from './storage.mjs';
import { commentsRoute, httpError, initializeComments } from './comments.mjs';
import { createLive } from './live.mjs';

async function readBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw httpError(415, 'Use application/json');
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 65536) throw httpError(413, 'Request body exceeds 64 KiB'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'Invalid JSON body'); }
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

async function staticFile(app, url, response) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw httpError(400, 'Invalid path'); }
  if (pathname.includes('\0') || pathname.split('/').some(part => part === '..' || part.startsWith('.'))) throw httpError(404, 'Not found');
  const directory = path.join(app.root, 'public'), file = path.resolve(directory, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(`${directory}${path.sep}`)) throw httpError(404, 'Not found');
  await noSymlinks(file);
  if (!(await exists(file)) || !(await fs.stat(file)).isFile()) return false;
  response.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
  response.end(await fs.readFile(file)); return true;
}

export async function startApp(app) {
  const unlock = await acquireLock(app, 'operation');
  let releaseRuntime, db, server;
  try {
    releaseRuntime = await acquireLock(app, 'runtime');
    await migrateUnlocked(app);
    db = openDatabase(app.database);
    const deploymentId = await initializeComments(app, db);
    const live = await createLive(app, deploymentId);
    const { route } = await import(pathToFileURL(app.entry).href);
    const { createStorage } = await import(pathToFileURL(path.join(app.root, 'storage.mjs')).href);
    const storage = await createStorage(db);
    if (typeof route !== 'function') throw new Error('entry must export async function route(context)');
    const instanceId = randomUUID(), controlToken = randomUUID();
    let closePromise;
    const close = () => closePromise ??= (async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); db.close(); await fs.rm(path.join(app.dataDir, 'server.json'), { force: true }); await releaseRuntime(); })();
    server = http.createServer(async (request, response) => {
      const json = (status, data) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(data)); };
      try {
        const url = new URL(request.url, 'http://board-app.invalid');
        const origin = request.headers.origin;
        if (origin && !app.config.origins.includes(origin)) throw httpError(403, 'Origin is not allowed');
        if (origin) { response.setHeader('access-control-allow-origin', origin); response.setHeader('vary', 'Origin'); }
        if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'Content-Type, Idempotency-Key, Authorization', 'access-control-max-age': '600' }); response.end(); return; }
        if (url.pathname === '/_board/health' && request.method === 'GET') { json(200, { status: 'ok', id: app.owner.id, deploymentId, instanceId, live: live.enabled ? 1 : 0 }); return; }
        if (url.pathname === '/_board/shutdown' && request.method === 'POST') {
          const supplied = Buffer.from(request.headers['x-board-control'] || ''), expected = Buffer.from(controlToken);
          if (origin || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw httpError(403, 'Control denied');
          json(202, { stopping: true }); void close(); return;
        }
        if (url.pathname === '/public-config.json' && request.method === 'GET') { json(200, app.config.public ?? {}); return; }
        const context = { request, response, url, db, storage, config: app.config, deploymentId, readJson: () => readBody(request), json };
        if (await commentsRoute(context)) return;
        if (await live.route(context)) return;
        if (url.pathname.startsWith('/_board/')) throw httpError(404, 'Not found');
        if (await route(context)) return;
        if (request.method === 'GET' && await staticFile(app, url, response)) return;
        throw httpError(404, 'Not found');
      } catch (error) { if (!response.headersSent) json(error.status || 500, { error: error.status ? error.message : 'Internal server error' }); else response.destroy(); if (!error.status) console.error('Application request failed:', error.message); }
    });
    server.requestTimeout = 30000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(app.config.port, app.config.host, resolve); });
    const address = server.address();
    const state = { pid: process.pid, instanceId, controlToken, host: app.config.host, port: address.port, startedAt: new Date().toISOString() };
    await fs.rm(path.join(app.dataDir, 'server.json'), { force: true });
    await writeJson(path.join(app.dataDir, 'server.json'), state);
    return { server, db, close, port: address.port, deploymentId, instanceId };
  } catch (error) { if (server?.listening) await new Promise(resolve => server.close(resolve)); db?.close(); await releaseRuntime?.(); throw error; }
  finally { await unlock(); }
}
