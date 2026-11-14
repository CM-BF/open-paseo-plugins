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
  if (!isObject(body) || Object.keys(body).some(key => !['text', 'authorName', 'pageUrl', 'anchor', 'visibility', 'parentId'].includes(key))) invalid('Unexpected comment fields');
  // Public threads (public-threads §5.2.3): the same rules as backend/threads.mjs publicInputProblem.
  if (body.visibility !== undefined || body.parentId !== undefined) {
    if (body.visibility !== 'public') invalid('visibility must be "public"');
    if (body.parentId !== undefined && (typeof body.parentId !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(body.parentId))) invalid('parentId must be a comment ID');
    if (visitor) {
      if (typeof body.pageUrl !== 'string') invalid('Public comments need pageUrl');
      if (typeof body.authorName === 'string' && /作者|AI\s*助手|访客|·|\p{Cf}/u.test(body.authorName.trim())) invalid('Public names may not imitate labels');
      if (!isObject(body.anchor) || typeof body.anchor.releaseId !== 'string') invalid('Public comments need anchor.releaseId');
      if (body.parentId !== undefined ? Object.keys(body.anchor).some(key => key !== 'releaseId') : typeof body.anchor.quote !== 'string') invalid('Invalid public anchor');
    }
  }
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
  if (body.visibility !== undefined) comment.visibility = body.visibility;
  if (body.parentId !== undefined) comment.parentId = body.parentId;
  return comment;
}

/**
 * options: allowedOrigins (exact), prefix ('' or '/api'), owner (app owner name), state (share another fake's data).
 * Returned controls: requests, comments, addReply, acknowledge, failNext, setHealth, close.
 */
export async function createFakeCommentsBackend(options = {}) {
  const prefix = options.prefix ?? '', allowed = new Set(options.allowedOrigins ?? []);
  const state = options.state ?? { comments: [], intents: new Map(), seq: 0 };
  // Public threads: per-page versions for the ETag, owner replies by target, pauses; `listingDelayMs` slows the listing.
  state.pages ??= new Map(); state.ownerReplies ??= [];
  const bumpPage = pageKey => { const page = state.pages.get(pageKey) ?? { version: 0, paused: false }; page.version++; state.pages.set(pageKey, page); };
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
    if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); response.setHeader('Access-Control-Expose-Headers', 'Retry-After, ETag'); }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, Authorization, X-Board-Visitor, If-None-Match', 'Access-Control-Max-Age': '600' }).end(); return;
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
      if (comment.visibility && !hash) { error(response, 400, 'visitor_invalid', 'Public comments need X-Board-Visitor'); return; }
      const pageKey = comment.pageUrl ? pageKeyOf(comment.pageUrl) : null;
      if (comment.visibility) {
        if (state.pages.get(pageKey)?.paused) { error(response, 403, 'public_paused', 'Paused'); return; }
        if (comment.parentId) {
          const parent = state.comments.find(item => item.externalId === comment.parentId);
          if (!parent || parent.visibility !== 'public' || parent.parentId || parent.hidden || parent.pageKey !== pageKey) { error(response, 404, 'comment_not_found', 'Unknown comment'); return; }
          if (parent.resolved) { error(response, 409, 'thread_resolved', 'Resolved'); return; }
          if (state.comments.filter(item => item.parentId === parent.externalId && !item.hidden).length >= (options.repliesPerThread ?? 40)) { error(response, 409, 'thread_full', 'Full'); return; }
        }
      }
      const row = { seq: ++state.seq, externalId: randomUUID(), ...comment, createdAt: new Date(Date.now() + state.seq).toISOString(), visitorHash: hash, pageKey, replies: [], acknowledged: false, hidden: false, resolved: false, tag: hash && pageKey ? sha256(pageKey + '\0' + hash).slice(0, 12) : null };
      state.comments.push(row);
      if (comment.visibility) bumpPage(pageKey);
      const stored = { externalId: row.externalId, text: row.text, ...(row.authorName ? { authorName: row.authorName } : {}), ...(row.pageUrl ? { pageUrl: row.pageUrl } : {}), ...(row.anchor ? { anchor: row.anchor } : {}), ...(row.visibility ? { visibility: row.visibility } : {}), ...(row.parentId ? { parentId: row.parentId } : {}), createdAt: row.createdAt, ...(row.visibility ? { tag: row.tag } : {}) };
      state.intents.set(key, { payloadHash, visitorHash: hash, comment: stored });
      json(response, 201, { deploymentId, replayed: false, comment: stored }); return;
    }
    if (path === '/_board/comments/mine' && request.method === 'GET') {
      if (typeof visitorHeader !== 'string' || !/^[a-f0-9]{64}$/.test(visitorHeader)) { error(response, 400, 'visitor_invalid', 'Invalid visitor'); return; }
      let pageKey = null;
      if (url.searchParams.has('page')) { try { pageKey = pageKeyOf(normalizePageUrl(url.searchParams.get('page'))); } catch { error(response, 400, 'invalid_input', 'Invalid page'); return; } }
      const hash = visitorHash(visitorHeader);
      const threads = state.comments.filter(row => row.visitorHash === hash && !row.parentId && (pageKey === null || row.pageKey === pageKey)).sort((a, b) => b.seq - a.seq).slice(0, 30).map(row => ({ ...threadOf(row), ...(row.visibility ? { visibility: 'public' } : {}) }));
      json(response, 200, { deploymentId, threads }); return;
    }
    if (path === '/_board/comments/public' && request.method === 'GET') {
      let pageKey; try { pageKey = pageKeyOf(normalizePageUrl(url.searchParams.get('page'))); } catch { error(response, 400, 'invalid_input', 'Invalid page'); return; }
      if (options.publicOff || !/^release-[a-f0-9]{64}$/.test(url.searchParams.get('release') ?? '')) { error(response, 404, 'public_disabled', 'Public comments are off'); return; }
      const page = state.pages.get(pageKey) ?? { version: 0, paused: false }, tag = `"p1.fake.${page.version}"`;
      if (options.listingDelayMs) await new Promise(resolve => setTimeout(resolve, options.listingDelayMs));
      if (request.headers['if-none-match'] === tag) { response.writeHead(304, { ETag: tag, 'Cache-Control': 'no-store' }).end(); return; }
      const roots = state.comments.filter(row => row.visibility === 'public' && !row.parentId && !row.hidden && row.pageKey === pageKey).sort((a, b) => Number(a.resolved) - Number(b.resolved) || b.seq - a.seq);
      const visitor = row => ({ id: row.externalId, by: 'visitor', tag: row.tag, ...(row.authorName ? { name: row.authorName } : {}), text: row.text, createdAt: row.createdAt });
      const threads = roots.slice(0, 100).map(root => {
        const children = state.comments.filter(row => row.parentId === root.externalId && !row.hidden);
        const owners = state.ownerReplies.filter(reply => reply.target === root.externalId || children.some(child => child.externalId === reply.target));
        const messages = [...children.map(row => ({ at: row.createdAt, order: 0, seq: row.seq, value: visitor(row) })), ...owners.map(reply => ({ at: reply.createdAt, order: 1, seq: reply.seq, value: { id: reply.id, by: reply.by, text: reply.text, createdAt: reply.createdAt, ...(reply.target !== root.externalId ? { replyTo: reply.target } : {}) } }))]
          .sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order || a.seq - b.seq).map(item => item.value);
        const anchor = root.anchor ? Object.fromEntries(Object.entries(root.anchor).filter(([key]) => ['selector', 'quote', 'prefix', 'suffix', 'start', 'end'].includes(key))) : undefined;
        return { ...visitor(root), resolved: root.resolved, ...(anchor ? { anchor } : {}), replies: messages.slice(-60), omitted: Math.max(0, messages.length - 60) };
      });
      json(response, 200, { format: 1, appKey: health.appKey, deploymentId, page: pageKey, version: page.version, paused: page.paused, total: roots.length, truncated: roots.length > threads.length, threads }, { ETag: tag }); return;
    }
    const withdraw = /^\/_board\/comments\/([^/]+)\/withdraw$/.exec(path);
    if (withdraw && request.method === 'POST') {
      const row = state.comments.find(item => item.externalId === withdraw[1]);
      if (!row || row.visibility !== 'public' || typeof visitorHeader !== 'string' || row.visitorHash !== visitorHash(visitorHeader)) { error(response, 404, 'comment_not_found', 'Unknown comment'); return; }
      if (!row.withdrawn) { row.hidden = true; row.withdrawn = true; bumpPage(row.pageKey); }
      json(response, 200, { deploymentId, externalId: row.externalId, withdrawn: true }); return;
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
    /** Public threads: an owner or assistant reply to a thread or to a visitor reply. */
    publicReply: (target, text, by = 'owner') => { const row = find(target); state.ownerReplies.push({ id: randomUUID(), seq: ++state.seq, target, text, by, createdAt: new Date(Date.now() + state.seq).toISOString() }); bumpPage(row.pageKey); },
    publicState: (id, change) => { const row = find(id); Object.assign(row, change); bumpPage(row.pageKey); },
    setPaused: (pageUrl, paused) => { const pageKey = pageKeyOf(pageUrl), page = state.pages.get(pageKey) ?? { version: 0, paused: false }; page.paused = paused; state.pages.set(pageKey, page); bumpPage(pageKey); },
    publicRows: () => state.comments.filter(row => row.visibility === 'public').map(row => ({ ...row })),
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
