// A loopback stand-in for a paseo-board-app comment backend (DESIGN.md §4.5, §11.5, §11.10, §11.16),
// faithful to the page <-> backend HTTP contract: exact-origin CORS, health with appKey, POST with
// idempotency and the shared normalization rules, and the visitor's own threads. Test controls add
// replies, acknowledge comments and inject failures. It never listens beyond 127.0.0.1.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = value => createHash('sha256').update(value).digest('hex');
export const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'page-comments-contract.json');
const expand = value => typeof value === 'string' ? value.replace(/<<repeat:(.):(\d+)>>/gu, (_, c, n) => c.repeat(Number(n)))
  : Array.isArray(value) ? value.map(expand) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)])) : value;
/** The shared contract fixture with every <<repeat:C:N>> expanded. */
export const loadContractFixture = () => expand(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));
export const appKeyFor = owner => sha256('board-app-key\0' + owner).slice(0, 16);

class InputError extends Error { constructor(code, message) { super(message); this.code = code; } }
const invalid = message => { throw new InputError('invalid_input', message); };
const ANCHOR_KEYS = ['label', 'selector', 'quote', 'prefix', 'suffix', 'start', 'end', 'releaseId'];
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const normalizePageUrl = value => {
  if (typeof value !== 'string' || value.length > 2000) invalid('pageUrl must be an HTTP(S) URL');
  let url; try { url = new URL(value); } catch { invalid('pageUrl must be an HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000) invalid('pageUrl must be an HTTP(S) URL without credentials');
  return url.href;
};
export const pageKeyOf = href => { const url = new URL(href); return url.origin + url.pathname.replace(/\/index\.html$/, '/'); };
/** DESIGN §11.5 backend POST rules: one rule set, pinned by the shared fixture. */
export function normalizeCommentInput(body, { visitor }) {
  if (!isObject(body) || Object.keys(body).some(key => !['text', 'authorName', 'pageUrl', 'anchor'].includes(key))) invalid('Unexpected comment fields');
  if (typeof body.text !== 'string') invalid('text is required');
  const text = body.text.trim();
  if (!text || text.length > (visitor ? 2000 : 8000)) invalid(`text must be 1-${visitor ? 2000 : 8000} characters`);
  const comment = { text };
  if (body.authorName !== undefined) {
    if (typeof body.authorName !== 'string' || /[\u0000-\u001f\u007f]/.test(body.authorName)) invalid('authorName must be plain text');
    const name = body.authorName.trim(); if (name.length > 160) invalid('authorName is too long');
    if (name) comment.authorName = name;
  }
  if (body.pageUrl !== undefined) comment.pageUrl = normalizePageUrl(body.pageUrl);
  if (body.anchor !== undefined) {
    const a = body.anchor;
    if (!isObject(a) || Object.keys(a).some(key => !ANCHOR_KEYS.includes(key))) invalid('Invalid anchor');
    const text = (key, min, max) => { if (a[key] !== undefined && (typeof a[key] !== 'string' || a[key].length < min || a[key].length > max)) invalid(`Invalid anchor ${key}`); };
    text('label', 0, 200); text('selector', 0, 500); text('quote', 1, 1000); text('prefix', 0, 64); text('suffix', 0, 64);
    if (a.releaseId !== undefined && (typeof a.releaseId !== 'string' || !/^release-[a-f0-9]{64}$/.test(a.releaseId))) invalid('Invalid anchor releaseId');
    if (a.start !== undefined || a.end !== undefined) {
      const int = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;
      if (!int(a.start) || !int(a.end) || a.start >= a.end || a.quote === undefined || a.end - a.start !== a.quote.length) invalid('Invalid anchor offsets');
    }
    if (JSON.stringify(a).length > 2000) invalid('Anchor is too large');
    comment.anchor = a;
  }
  return comment;
}

/**
 * options: allowedOrigins (exact), prefix ('' or '/api'), owner (app owner name), state (share another fake's data).
 * Returned controls: requests, comments, addReply, acknowledge, failNext, setHealth, close.
 */
export async function createFakeCommentsBackend(options = {}) {
  const prefix = options.prefix ?? '', allowed = new Set(options.allowedOrigins ?? []);
  const state = options.state ?? { comments: [], intents: new Map(), seq: 0 };
  const deploymentId = randomUUID(), instanceId = randomUUID();
  let health = { status: 'ok', id: options.appId ?? 'fake-comments', appKey: appKeyFor(options.owner ?? 'fake-owner'), deploymentId, instanceId, live: 1, comments: 2, publicThreads: 1, clientIp: 'socket' };
  const requests = [], failures = [];
  const json = (response, status, body, headers = {}) => { if (response.lose) { response.socket.destroy(); return; } response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); response.end(body === undefined ? '' : JSON.stringify(body)); };
  const error = (response, status, code, message, headers) => json(response, status, { error: message, code }, headers);
  const visitorHash = secret => sha256('board-visitor:v1:' + secret);
  const threadOf = row => ({ id: row.externalId, text: row.text, ...(row.authorName ? { authorName: row.authorName } : {}), createdAt: row.createdAt, ...(row.pageUrl ? { pageUrl: row.pageUrl } : {}), ...(row.anchor ? { anchor: row.anchor } : {}),
    status: row.replies.length ? 'replied' : row.acknowledged ? 'received' : 'sent', replies: row.replies.slice(0, 20).map(({ id, text, authorKind, createdAt }) => ({ id, text, authorKind, createdAt })) });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fake'), origin = request.headers.origin;
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const entry = { at: Date.now(), method: request.method, path: url.pathname, search: url.search, headers: { ...request.headers }, body };
    requests.push(entry);
    // Scripted failures apply to the next matching non-preflight request, after CORS so the browser sees the status.
    const index = request.method === 'OPTIONS' ? -1 : failures.findIndex(item => item.method === request.method && url.pathname.endsWith(item.suffix));
    const scripted = index === -1 ? null : failures.splice(index, 1)[0];
    if (scripted?.kind === 'drop') { entry.injected = 'drop'; request.socket.destroy(); return; }
    if (origin !== undefined && !allowed.has(origin)) { error(response, 403, 'origin_forbidden', 'Origin is not allowed'); return; }
    if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); response.setHeader('Access-Control-Expose-Headers', 'Retry-After'); }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, Authorization, X-Board-Visitor', 'Access-Control-Max-Age': '600' }).end(); return;
    }
    if (scripted?.kind === 'lost') { entry.injected = 'lost'; response.lose = true; }
    else if (scripted) { entry.injected = scripted.status; error(response, scripted.status, scripted.code, scripted.message, scripted.headers); return; }
    if (!url.pathname.startsWith(prefix + '/_board/')) { error(response, 404, 'not_found', 'Not found'); return; }
    const path = url.pathname.slice(prefix.length);
    if (path === '/_board/health' && request.method === 'GET') { json(response, 200, health); return; }
    const visitorHeader = request.headers['x-board-visitor'];
    if (path === '/_board/comments' && request.method === 'POST') {
      if (visitorHeader !== undefined && !/^[a-f0-9]{64}$/.test(visitorHeader)) { error(response, 400, 'visitor_invalid', 'Invalid visitor'); return; }
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) { error(response, 400, 'invalid_input', 'Idempotency-Key is required'); return; }
      let input; try { input = JSON.parse(body); } catch { error(response, 400, 'invalid_input', 'Invalid JSON'); return; }
      let comment; try { comment = normalizeCommentInput(input, { visitor: visitorHeader !== undefined }); } catch (failed) { error(response, 400, failed.code ?? 'invalid_input', failed.message); return; }
      const payloadHash = sha256(JSON.stringify(input)), hash = visitorHeader ? visitorHash(visitorHeader) : null, previous = state.intents.get(key);
      if (previous) {
        if (previous.payloadHash !== payloadHash || previous.visitorHash !== hash) { error(response, 409, 'idempotency_conflict', 'Idempotency-Key was used for another comment'); return; }
        json(response, 200, { deploymentId, replayed: true, comment: previous.comment }); return;
      }
      const row = { seq: ++state.seq, externalId: randomUUID(), ...comment, createdAt: new Date(Date.now() + state.seq).toISOString(), visitorHash: hash, pageKey: comment.pageUrl ? pageKeyOf(comment.pageUrl) : null, replies: [], acknowledged: false };
      state.comments.push(row);
      const stored = { externalId: row.externalId, text: row.text, ...(row.authorName ? { authorName: row.authorName } : {}), ...(row.pageUrl ? { pageUrl: row.pageUrl } : {}), ...(row.anchor ? { anchor: row.anchor } : {}), createdAt: row.createdAt };
      state.intents.set(key, { payloadHash, visitorHash: hash, comment: stored });
      json(response, 201, { deploymentId, replayed: false, comment: stored }); return;
    }
    if (path === '/_board/comments/mine' && request.method === 'GET') {
      if (typeof visitorHeader !== 'string' || !/^[a-f0-9]{64}$/.test(visitorHeader)) { error(response, 400, 'visitor_invalid', 'Invalid visitor'); return; }
      let pageKey = null;
      if (url.searchParams.has('page')) { try { pageKey = pageKeyOf(normalizePageUrl(url.searchParams.get('page'))); } catch { error(response, 400, 'invalid_input', 'Invalid page'); return; } }
      const hash = visitorHash(visitorHeader);
      const threads = state.comments.filter(row => row.visitorHash === hash && (pageKey === null || row.pageKey === pageKey)).sort((a, b) => b.seq - a.seq).slice(0, 30).map(threadOf);
      json(response, 200, { deploymentId, threads }); return;
    }
    error(response, 404, 'not_found', 'Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const find = id => { const row = state.comments.find(item => item.externalId === id); if (!row) throw new Error('Unknown fake comment ' + id); return row; };
  return {
    origin, apiBase: origin + prefix, deploymentId, state, requests,
    get health() { return health; },
    setHealth: patch => { health = { ...health, ...patch }; for (const [key, value] of Object.entries(patch)) if (value === undefined) delete health[key]; },
    allowOrigin: value => allowed.add(value),
    comments: () => state.comments.map(row => ({ ...row })),
    addReply: (id, text, authorKind = 'agent') => { const row = find(id); row.replies.push({ id: randomUUID(), text, authorKind, createdAt: new Date().toISOString() }); },
    acknowledge: id => { find(id).acknowledged = true; },
    /**
     * method + path suffix. {status}: answer with that HTTP status and headers. 'drop': close the socket before
     * handling (fetch TypeError). 'lost': handle the request, then close the socket instead of answering.
     */
    failNext: (method, suffix, kind = { status: 500 }) => {
      if (kind === 'drop' || kind === 'lost') failures.push({ method, suffix, kind });
      else failures.push({ method, suffix, kind: 'status', status: kind.status, code: kind.code ?? (kind.status === 429 ? 'rate_limited' : 'server_error'), message: kind.message ?? 'Injected failure', headers: kind.headers ?? {} });
    },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }),
  };
}
