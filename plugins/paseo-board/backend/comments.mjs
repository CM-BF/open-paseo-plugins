import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { digest, exists, noSymlinks, readJson, writeJson } from './files.mjs';

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }

export async function initializeComments(app, db) {
  const file = await noSymlinks(path.join(app.dataDir, 'identity.json'));
  if (!(await exists(file))) await writeJson(file, { deploymentId: randomUUID(), owner: app.owner.owner });
  const identity = await readJson(file);
  if (identity.owner !== app.owner.owner || !/^[\da-f-]{36}$/.test(identity.deploymentId)) throw new Error('Invalid durable deployment identity');
  db.exec(`CREATE TABLE IF NOT EXISTS _board_comments (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT UNIQUE NOT NULL,
    intent_key TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL,
    text TEXT NOT NULL, author_name TEXT, page_url TEXT, anchor_json TEXT, created_at TEXT NOT NULL
  ) STRICT`);
  if (Number.isSafeInteger(identity.commentHighWater) && identity.commentHighWater > 0) {
    const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='_board_comments'").get();
    if (!sequence) db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES ('_board_comments',?)").run(identity.commentHighWater);
    else if (sequence.seq < identity.commentHighWater) db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='_board_comments'").run(identity.commentHighWater);
  }
  return identity.deploymentId;
}

function commentInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['text', 'authorName', 'pageUrl', 'anchor'].includes(key))) throw httpError(400, 'Expected text, optional authorName, pageUrl and anchor');
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000) throw httpError(400, 'Comment text must contain 1–8000 characters');
  if (body.authorName !== undefined && (typeof body.authorName !== 'string' || body.authorName.length > 160)) throw httpError(400, 'authorName must contain at most 160 characters');
  if (body.pageUrl !== undefined) {
    try { const url = new URL(body.pageUrl); if (typeof body.pageUrl !== 'string' || body.pageUrl.length > 2000 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
    catch { throw httpError(400, 'pageUrl must be an HTTP(S) URL without credentials'); }
  }
  if (body.anchor !== undefined && (!body.anchor || typeof body.anchor !== 'object' || Array.isArray(body.anchor) || Object.keys(body.anchor).some(key => !['label', 'selector'].includes(key)) || Object.entries(body.anchor).some(([key, value]) => typeof value !== 'string' || value.length > (key === 'label' ? 200 : 500)))) throw httpError(400, 'Invalid comment anchor');
  return { text: body.text.trim(), ...(body.authorName ? { authorName: body.authorName } : {}), ...(body.pageUrl ? { pageUrl: body.pageUrl } : {}), ...(body.anchor ? { anchor: body.anchor } : {}) };
}

const project = row => ({ externalId: row.external_id, text: row.text, createdAt: row.created_at, ...(row.author_name ? { authorName: row.author_name } : {}), ...(row.page_url ? { pageUrl: row.page_url } : {}), ...(row.anchor_json ? { anchor: JSON.parse(row.anchor_json) } : {}) });

export async function commentsRoute(context) {
  const { request, url, db, readJson: body, json, config, deploymentId } = context;
  if (url.pathname !== '/_board/comments') return false;
  if (!config.comments?.enabled) throw httpError(404, 'Comments are disabled');
  if (request.method === 'POST') {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw httpError(400, 'Provide an Idempotency-Key of 8–128 ASCII letters, digits, dots, underscores, colons or hyphens');
    const input = commentInput(await body()), hash = digest(JSON.stringify(input));
    const previous = db.prepare('SELECT * FROM _board_comments WHERE intent_key = ?').get(key);
    if (previous) { if (previous.payload_hash !== hash) throw httpError(409, 'Idempotency-Key already belongs to a different comment'); json(200, { deploymentId, comment: project(previous), replayed: true }); return true; }
    const externalId = randomUUID(), createdAt = new Date().toISOString();
    db.prepare('INSERT INTO _board_comments (external_id,intent_key,payload_hash,text,author_name,page_url,anchor_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run(externalId, key, hash, input.text, input.authorName ?? null, input.pageUrl ?? null, input.anchor ? JSON.stringify(input.anchor) : null, createdAt);
    json(201, { deploymentId, comment: { externalId, ...input, createdAt }, replayed: false });
    return true;
  }
  if (request.method === 'GET') {
    const token = process.env.BOARD_INBOX_EXPORT_TOKEN;
    if (!token || token.length < 32) throw httpError(404, 'Comment export is disabled');
    const supplied = Buffer.from(request.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw httpError(401, 'A valid comment-export token is required');
    const cursor = url.searchParams.get('cursor') ?? '0', limitValue = url.searchParams.get('limit') ?? '50';
    if (!/^(0|[1-9]\d{0,14})$/.test(cursor) || !/^\d{1,3}$/.test(limitValue) || +limitValue < 1 || +limitValue > 100) throw httpError(400, 'Invalid cursor or limit');
    const rows = db.prepare('SELECT * FROM _board_comments WHERE seq > ? ORDER BY seq LIMIT ?').all(+cursor, +limitValue);
    json(200, { deploymentId, cursor, nextCursor: rows.length ? String(rows.at(-1).seq) : cursor, comments: rows.map(project) });
    return true;
  }
  throw httpError(405, 'Use GET or POST');
}
