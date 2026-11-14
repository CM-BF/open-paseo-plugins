import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { digest, exists, noSymlinks, readJson, writeJson } from './files.mjs';

/** An HTTP error. `code` is a stable reason for clients; `retryAfter` (seconds) becomes a Retry-After header. */
export function httpError(status, message, code, extra = {}) { return Object.assign(new Error(message), { status, ...(code ? { code } : {}), ...extra }); }
const invalid = message => httpError(400, message, 'invalid_input');

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const COMMENT_LIMITS = Object.freeze({
  requestsPerIpMinute: 300, postPerIpMinute: 10, postPerIpHour: 60, postPerVisitorMinute: 5, postPerVisitorHour: 30,
  postGlobalMinute: 120, postGlobalHour: 1000, postPerPageDay: 500, minePerVisitorMinute: 12, minePerIpMinute: 600, maxStoredBytes: 268_435_456,
});
const DEFAULT_TRUSTED_PROXIES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const LIMITER_KEYS = 50_000, EXPORT_CHARS = 90_000, MINE_THREADS = 30, MINE_REPLIES = 20, MINE_CHARS = 500_000, REPLIES_PER_COMMENT = 20, REPLIES_TOTAL = 200_000;
const intentPattern = /^[A-Za-z0-9._:-]{8,128}$/, visitorPattern = /^[a-f0-9]{64}$/, releasePattern = /^release-[a-f0-9]{64}$/, externalIdPattern = /^[\da-f-]{36}$/;
const controlCharacter = /[\u0000-\u001f\u007f]/, replyControlCharacter = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Schema: the runtime owns _board_comments, _board_comment_replies and _board_runtime_meta.

const COMMENTS_V1 = `CREATE TABLE IF NOT EXISTS _board_comments (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT UNIQUE NOT NULL,
    intent_key TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL,
    text TEXT NOT NULL, author_name TEXT, page_url TEXT, anchor_json TEXT, created_at TEXT NOT NULL
  ) STRICT`;
const storedBytes = row => `length(CAST(${row}text AS BLOB)) + COALESCE(length(CAST(${row}author_name AS BLOB)), 0) + COALESCE(length(CAST(${row}page_url AS BLOB)), 0) + COALESCE(length(CAST(${row}anchor_json AS BLOB)), 0)`;
const COMMENTS_V2 = `
CREATE INDEX IF NOT EXISTS _board_comments_visitor ON _board_comments (visitor_hash, page_key, seq);
CREATE INDEX IF NOT EXISTS _board_comments_page ON _board_comments (page_key, created_at);
CREATE TABLE IF NOT EXISTS _board_comment_replies (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  reply_id TEXT UNIQUE NOT NULL,
  comment_seq INTEGER NOT NULL REFERENCES _board_comments(seq),
  intent_key TEXT UNIQUE NOT NULL,
  payload_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('owner','agent')),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS _board_comment_replies_comment ON _board_comment_replies (comment_seq, seq);
INSERT INTO _board_runtime_meta(key, value) VALUES ('export_ack','0') ON CONFLICT(key) DO NOTHING;
INSERT INTO _board_runtime_meta(key, value) VALUES ('comments_bytes', (SELECT CAST(COALESCE(SUM(${storedBytes('')}), 0) AS TEXT) FROM _board_comments)) ON CONFLICT(key) DO NOTHING;
CREATE TRIGGER IF NOT EXISTS _board_comments_bytes AFTER INSERT ON _board_comments BEGIN
  UPDATE _board_runtime_meta SET value = CAST(CAST(value AS INTEGER) + ${storedBytes('NEW.')} AS TEXT) WHERE key = 'comments_bytes';
END;
INSERT INTO _board_runtime_meta(key, value) VALUES ('comments_schema','2') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`;

/** Loads the durable deployment identity and brings the comment tables to schema 2 in one transaction. */
export async function initializeComments(app, db) {
  const file = await noSymlinks(path.join(app.dataDir, 'identity.json'));
  if (!(await exists(file))) await writeJson(file, { deploymentId: randomUUID(), owner: app.owner.owner });
  const identity = await readJson(file);
  if (identity.owner !== app.owner.owner || !/^[\da-f-]{36}$/.test(identity.deploymentId)) throw new Error('Invalid durable deployment identity');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`${COMMENTS_V1}; CREATE TABLE IF NOT EXISTS _board_runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
    if (Number.isSafeInteger(identity.commentHighWater) && identity.commentHighWater > 0) {
      const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='_board_comments'").get();
      if (!sequence) db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES ('_board_comments',?)").run(identity.commentHighWater);
      else if (sequence.seq < identity.commentHighWater) db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='_board_comments'").run(identity.commentHighWater);
    }
    const marker = db.prepare("SELECT value FROM _board_runtime_meta WHERE key='comments_schema'").get()?.value ?? '1';
    if (!/^[1-9]\d{0,8}$/.test(marker)) throw new Error(`Invalid comments_schema marker: ${JSON.stringify(marker)}`);
    if (+marker > 2) throw new Error("This database was upgraded by a newer Board runtime; update this app's runtime before starting.");
    if (+marker === 1) {
      const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('_board_comments')").all().map(row => row.name));
      if (!columns.has('visitor_hash')) db.exec('ALTER TABLE _board_comments ADD COLUMN visitor_hash TEXT');
      if (!columns.has('page_key')) db.exec('ALTER TABLE _board_comments ADD COLUMN page_key TEXT');
      db.exec(COMMENTS_V2);
    }
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  return identity.deploymentId;
}

// ---------------------------------------------------------------------------
// Configuration (board-app.json "comments"). Invalid values refuse start.

export function commentSettings(config) {
  const comments = isObject(config.comments) ? config.comments : {};
  const proxies = comments.trustedProxies ?? DEFAULT_TRUSTED_PROXIES;
  if (!Array.isArray(proxies) || proxies.length > 16 || proxies.some(entry => typeof entry !== 'string' || !isIP(entry))) throw new Error('comments.trustedProxies must list at most 16 exact IP addresses (no ranges or host names)');
  const limits = comments.limits ?? {};
  if (!isObject(limits)) throw new Error('comments.limits must be an object');
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(COMMENT_LIMITS, key)) throw new Error(`Unknown comments.limits key: ${key}`);
    if (!Number.isSafeInteger(value) || value < 1 || value > COMMENT_LIMITS[key] * 10) throw new Error(`comments.limits.${key} must be a positive integer of at most ${COMMENT_LIMITS[key] * 10}`);
  }
  return { enabled: Boolean(comments.enabled), trusted: new Set(proxies.map(exactAddress)), limits: Object.freeze({ ...COMMENT_LIMITS, ...limits }) };
}

// ---------------------------------------------------------------------------
// Client addresses. Forwarded headers count only when the socket peer is a trusted proxy.

function ipv6Groups(address) {
  let text = address.toLowerCase();
  const embedded = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (embedded) { const [a, b, c, d] = embedded.slice(2).map(Number); text = `${embedded[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`; }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...new Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.map(group => parseInt(group, 16));
}

/** Parses an IP literal; IPv4-mapped IPv6 becomes IPv4. Returns null for anything else. */
function parseAddress(raw) {
  if (typeof raw !== 'string') return null;
  const address = raw.split('%')[0], version = isIP(address);
  if (version === 4) return { version, address };
  if (version !== 6) return null;
  const groups = ipv6Groups(address);
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) return { version: 4, address: [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.') };
  return { version, groups };
}
function exactAddress(raw) { const parsed = parseAddress(raw); return !parsed ? null : parsed.version === 4 ? parsed.address : parsed.groups.map(group => group.toString(16)).join(':'); }

/** Rate-limit key: an IPv4 address as is, an IPv6 address by its /64 prefix. */
export function addressKey(raw) { const parsed = parseAddress(raw); return !parsed ? null : parsed.version === 4 ? parsed.address : `${parsed.groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`; }

function forwardedAddress(entry) {
  let value = entry.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) value = bracketed[1];
  else if (/^[\d.]+:\d{1,5}$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
  return parseAddress(value) ? value : null;
}

/**
 * The visitor's address and how it was found: "socket" (no forwarded header), "forwarded" (from a trusted
 * proxy) or "proxied-unconfigured" (forwarded headers from an untrusted peer, which are ignored).
 */
export function resolveClient(request, trusted) {
  const peer = request.socket?.remoteAddress ?? '';
  const header = name => { const value = request.headers[name]; return typeof value === 'string' && value.trim() ? value : null; };
  const forwardedFor = header('x-forwarded-for'), realIp = header('x-real-ip'), proxied = forwardedFor !== null || realIp !== null;
  if (!trusted.has(exactAddress(peer))) return { address: peer, mode: proxied ? 'proxied-unconfigured' : 'socket' };
  if (!proxied) return { address: peer, mode: 'socket' };
  let address = peer;
  if (forwardedFor !== null) {
    // Right to left: the first address no trusted proxy vouches for. A malformed entry stops the walk.
    for (const entry of forwardedFor.split(',').reverse()) {
      const candidate = forwardedAddress(entry);
      if (candidate === null) break;
      address = candidate;
      if (!trusted.has(exactAddress(candidate))) break;
    }
  } else address = forwardedAddress(realIp) ?? peer;
  return { address, mode: 'forwarded' };
}

// ---------------------------------------------------------------------------
// Rate limits: fixed one-minute and one-hour windows in memory. IP and global maps never evict and refuse
// new keys when full; visitor maps evict their oldest windows.

class Windows {
  constructor(size, limit, evict) { this.size = size; this.limit = limit; this.evict = evict; this.entries = new Map(); }
  retryAfter(time) { return Math.max(1, Math.ceil(((Math.floor(time / this.size) + 1) * this.size - time) / 1000)); }
  refusal(key, time, maxKeys) {
    const entry = this.entries.get(key);
    if (entry?.window === Math.floor(time / this.size)) return entry.count >= this.limit ? this.retryAfter(time) : 0;
    if (!this.evict && !entry && this.entries.size >= maxKeys) return 60;
    return 0;
  }
  hit(key, time, maxKeys) {
    const window = Math.floor(time / this.size), entry = this.entries.get(key);
    if (entry?.window === window) { entry.count++; return; }
    this.entries.delete(key);
    if (this.evict) while (this.entries.size >= maxKeys) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, { window, count: 1 });
  }
  sweep(time) { const window = Math.floor(time / this.size); for (const [key, entry] of this.entries) if (entry.window < window) this.entries.delete(key); }
}

export function createCommentLimiter(limits, { now = Date.now, maxKeys = LIMITER_KEYS } = {}) {
  const windows = {
    requests: new Windows(MINUTE, limits.requestsPerIpMinute, false),
    postIpMinute: new Windows(MINUTE, limits.postPerIpMinute, false), postIpHour: new Windows(HOUR, limits.postPerIpHour, false),
    postGlobalMinute: new Windows(MINUTE, limits.postGlobalMinute, false), postGlobalHour: new Windows(HOUR, limits.postGlobalHour, false),
    postVisitorMinute: new Windows(MINUTE, limits.postPerVisitorMinute, true), postVisitorHour: new Windows(HOUR, limits.postPerVisitorHour, true),
    mineIp: new Windows(MINUTE, limits.minePerIpMinute, false), mineVisitor: new Windows(MINUTE, limits.minePerVisitorMinute, true),
  };
  let swept = Math.floor(now() / MINUTE);
  const clock = () => {
    const time = now(), minute = Math.floor(time / MINUTE);
    if (minute !== swept) { swept = minute; for (const item of Object.values(windows)) item.sweep(time); }
    return time;
  };
  const check = (pairs, time) => {
    for (const [item, key] of pairs) {
      const retryAfter = item.refusal(key, time, maxKeys);
      if (retryAfter) throw httpError(429, 'Too many comment requests; try again later', 'rate_limited', { retryAfter });
    }
  };
  const hit = (pairs, time) => { for (const [item, key] of pairs) item.hit(key, time, maxKeys); };
  const enforce = pairs => { const time = clock(); check(pairs, time); hit(pairs, time); };
  // IP and global windows come first, so a visitor window exists only after the IP checks pass.
  const post = (ip, visitor) => [[windows.postIpMinute, ip], [windows.postIpHour, ip], [windows.postGlobalMinute, '*'], [windows.postGlobalHour, '*'],
    ...(visitor ? [[windows.postVisitorMinute, visitor], [windows.postVisitorHour, visitor]] : [])];
  return {
    windows,
    request: ip => enforce([[windows.requests, ip]]),
    checkPost: (ip, visitor) => check(post(ip, visitor), clock()),
    commitPost: (ip, visitor) => hit(post(ip, visitor), clock()),
    mine: (ip, visitor) => enforce([[windows.mineIp, ip], [windows.mineVisitor, visitor]]),
  };
}

// ---------------------------------------------------------------------------
// Normalization rules (DESIGN §11.5). POST refuses what they reject; export omits it.

function nameRule(value) {
  if (typeof value !== 'string' || value.length > 160 || controlCharacter.test(value)) return { error: 'authorName must be text of at most 160 characters without control characters' };
  return { value: value.trim() || undefined };
}
function urlRule(value) {
  try {
    if (typeof value !== 'string' || value.length > 2000) throw new Error();
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.length > 2000) throw new Error();
    return { value: url.href };
  } catch { return { error: 'pageUrl must be an HTTP(S) URL of at most 2000 characters without credentials' }; }
}
const pageKeyOf = href => { const url = new URL(href); return url.origin + url.pathname.replace(/\/index\.html$/, '/'); };

/** Returns why an anchor is invalid (DESIGN §4.1, including end − start === quote.length), or null. */
export function anchorProblem(anchor) {
  if (!isObject(anchor)) return 'anchor must be an object';
  const text = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max;
  const offset = value => Number.isInteger(value) && value >= 0 && value <= 10_000_000;
  for (const [key, value] of Object.entries(anchor)) {
    const valid = key === 'label' ? text(value, 0, 200) : key === 'selector' ? text(value, 0, 500) : key === 'quote' ? text(value, 1, 1000)
      : key === 'prefix' || key === 'suffix' ? text(value, 0, 64) : key === 'start' || key === 'end' ? offset(value)
      : key === 'releaseId' ? typeof value === 'string' && releasePattern.test(value) : null;
    if (valid === null) return `Unknown anchor key: ${key}`;
    if (!valid) return `Invalid anchor.${key}`;
  }
  if (('start' in anchor) !== ('end' in anchor)) return 'anchor.start and anchor.end must appear together';
  if ('start' in anchor) {
    if (!('quote' in anchor)) return 'anchor offsets require anchor.quote';
    if (!(anchor.start < anchor.end) || anchor.end - anchor.start !== anchor.quote.length) return 'anchor.end - anchor.start must equal the quote length';
  }
  if (JSON.stringify(anchor).length > 2000) return 'anchor must serialize to at most 2000 characters';
  return null;
}

/** Validates and normalizes a visitor comment body; throws 400 invalid_input. Visitor posts allow 2000 characters. */
export function normalizeCommentInput(body, { visitor = false } = {}) {
  if (!isObject(body) || Object.keys(body).some(key => !['text', 'authorName', 'pageUrl', 'anchor'].includes(key))) throw invalid('Expected text, optional authorName, pageUrl and anchor');
  const max = visitor ? 2000 : 8000, text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > max) throw invalid(`Comment text must contain 1–${max} characters`);
  const input = { text };
  if (body.authorName !== undefined) { const name = nameRule(body.authorName); if (name.error) throw invalid(name.error); if (name.value) input.authorName = name.value; }
  if (body.pageUrl !== undefined) { const url = urlRule(body.pageUrl); if (url.error) throw invalid(url.error); input.pageUrl = url.value; }
  if (body.anchor !== undefined) { const problem = anchorProblem(body.anchor); if (problem) throw invalid(problem); input.anchor = body.anchor; }
  return input;
}

/** The 4b94741 payload shape, so an intent stored by the previous runtime still replays. */
function legacyInput(body) {
  return { text: body.text.trim(), ...(body.authorName ? { authorName: body.authorName } : {}), ...(body.pageUrl ? { pageUrl: body.pageUrl } : {}), ...(body.anchor ? { anchor: body.anchor } : {}) };
}

/** A stored row under the same rules: trimmed text; invalid optional fields are omitted. */
function storedComment(row) {
  const comment = { externalId: row.external_id, text: String(row.text).trim(), createdAt: row.created_at };
  if (row.author_name !== null) { const name = nameRule(row.author_name); if (name.value) comment.authorName = name.value; }
  if (row.page_url !== null) { const url = urlRule(row.page_url); if (!url.error) comment.pageUrl = url.value; }
  if (row.anchor_json !== null) {
    let anchor; try { anchor = JSON.parse(row.anchor_json); } catch {}
    if (anchor !== undefined && anchorProblem(anchor) === null) comment.anchor = anchor;
  }
  return comment;
}
function legacyAnchor(anchor) {
  const entries = Object.entries(anchor).filter(([key]) => key === 'label' || key === 'selector');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

// ---------------------------------------------------------------------------
// Routes under /_board/comments.

export function createComments({ app, db, deploymentId, settings, now = Date.now, maxKeys }) {
  const { enabled, trusted, limits } = settings;
  const appKey = digest(`board-app-key\0${app.owner.owner}`).slice(0, 16);
  const limiter = createCommentLimiter(limits, { now, maxKeys });
  const client = request => resolveClient(request, trusted);
  const ipOf = request => addressKey(client(request).address) ?? 'unknown';
  const isPath = pathname => pathname === '/_board/comments' || pathname.startsWith('/_board/comments/');
  const sql = {
    byIntent: db.prepare('SELECT * FROM _board_comments WHERE intent_key = ?'),
    byExternalId: db.prepare('SELECT seq FROM _board_comments WHERE external_id = ?'),
    page: db.prepare('SELECT * FROM _board_comments WHERE seq > ? ORDER BY seq LIMIT ?'),
    pageToday: db.prepare('SELECT count(*) AS n FROM _board_comments WHERE page_key = ? AND created_at >= ?'),
    maxSeq: db.prepare('SELECT max(seq) AS seq FROM _board_comments'),
    insert: db.prepare('INSERT INTO _board_comments (external_id,intent_key,payload_hash,text,author_name,page_url,anchor_json,created_at,visitor_hash,page_key) VALUES (?,?,?,?,?,?,?,?,?,?)'),
    mine: db.prepare('SELECT * FROM _board_comments WHERE visitor_hash = ? ORDER BY seq DESC LIMIT ?'),
    minePage: db.prepare('SELECT * FROM _board_comments WHERE visitor_hash = ? AND page_key = ? ORDER BY seq DESC LIMIT ?'),
    replies: db.prepare('SELECT reply_id, text, author_kind, created_at FROM _board_comment_replies WHERE comment_seq = ? ORDER BY seq LIMIT ?'),
    replyByIntent: db.prepare('SELECT r.*, c.external_id FROM _board_comment_replies r JOIN _board_comments c ON c.seq = r.comment_seq WHERE r.intent_key = ?'),
    replyCount: db.prepare('SELECT count(*) AS n FROM _board_comment_replies WHERE comment_seq = ?'),
    replyTotal: db.prepare('SELECT count(*) AS n FROM _board_comment_replies'),
    insertReply: db.prepare('INSERT INTO _board_comment_replies (reply_id,comment_seq,intent_key,payload_hash,text,author_kind,created_at) VALUES (?,?,?,?,?,?,?)'),
    meta: db.prepare('SELECT value FROM _board_runtime_meta WHERE key = ?'),
    acknowledge: db.prepare("UPDATE _board_runtime_meta SET value = ? WHERE key = 'export_ack' AND CAST(value AS INTEGER) < ?"),
  };
  const metaNumber = key => Number(sql.meta.get(key)?.value ?? 0);

  async function body(readJson) {
    try { return await readJson(); }
    catch (error) { if (error.status && !error.code) error.code = { 400: 'invalid_input', 413: 'payload_too_large', 415: 'unsupported_media_type' }[error.status]; throw error; }
  }
  function intentKey(request) {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !intentPattern.test(key)) throw invalid('Provide an Idempotency-Key of 8–128 ASCII letters, digits, dots, underscores, colons or hyphens');
    return key;
  }
  function visitorHash(request, required) {
    const secret = request.headers['x-board-visitor'];
    if (secret === undefined && !required) return null;
    if (typeof secret !== 'string' || !visitorPattern.test(secret)) throw httpError(400, 'X-Board-Visitor must be 64 lowercase hexadecimal characters', 'visitor_invalid');
    return digest(`board-visitor:v1:${secret}`);
  }
  function owner(request) {
    const token = process.env.BOARD_INBOX_EXPORT_TOKEN;
    if (!token || token.length < 32) throw httpError(404, 'Comment export is disabled', 'export_disabled');
    const supplied = Buffer.from(request.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw httpError(401, 'A valid comment-export token is required', 'unauthorized');
  }

  async function create({ request, readJson, json }, ip) {
    const key = intentKey(request), visitor = visitorHash(request, false);
    const raw = await body(readJson), input = normalizeCommentInput(raw, { visitor: visitor !== null }), hash = digest(JSON.stringify(input));
    const previous = sql.byIntent.get(key);
    if (previous) {
      const samePayload = previous.payload_hash === hash || previous.payload_hash === digest(JSON.stringify(legacyInput(raw)));
      if (!samePayload || (previous.visitor_hash ?? null) !== visitor) throw httpError(409, 'Idempotency-Key already belongs to a different comment', 'idempotency_conflict');
      json(200, { deploymentId, comment: storedComment(previous), replayed: true }); return;
    }
    limiter.checkPost(ip, visitor);
    const time = now(), pageKey = input.pageUrl ? pageKeyOf(input.pageUrl) : null;
    if (pageKey !== null) {
      const day = Math.floor(time / DAY) * DAY;
      if (sql.pageToday.get(pageKey, new Date(day).toISOString()).n >= limits.postPerPageDay) throw httpError(429, 'This page received too many comments today; try again tomorrow', 'rate_limited', { retryAfter: Math.max(1, Math.ceil((day + DAY - time) / 1000)) });
    }
    const anchorJson = input.anchor ? JSON.stringify(input.anchor) : null;
    const bytes = Buffer.byteLength(input.text) + Buffer.byteLength(input.authorName ?? '') + Buffer.byteLength(input.pageUrl ?? '') + Buffer.byteLength(anchorJson ?? '');
    if (metaNumber('comments_bytes') + bytes > limits.maxStoredBytes) throw httpError(507, 'Comment storage is full', 'storage_full');
    limiter.commitPost(ip, visitor);
    const externalId = randomUUID(), createdAt = new Date(time).toISOString();
    sql.insert.run(externalId, key, hash, input.text, input.authorName ?? null, input.pageUrl ?? null, anchorJson, createdAt, visitor, pageKey);
    json(201, { deploymentId, comment: { externalId, ...input, createdAt }, replayed: false });
  }

  function exportPage({ request, url, json }) {
    owner(request);
    const cursor = url.searchParams.get('cursor') ?? '0', limitValue = url.searchParams.get('limit') ?? '50';
    if (!/^(0|[1-9]\d{0,14})$/.test(cursor) || !/^\d{1,3}$/.test(limitValue) || +limitValue < 1 || +limitValue > 100) throw invalid('Invalid cursor or limit');
    const v2 = url.searchParams.get('format') === '2';
    // The cursor a plugin sends is what it has committed: it acknowledges those comments as received.
    const acknowledged = Math.min(+cursor, sql.maxSeq.get().seq ?? 0);
    sql.acknowledge.run(String(acknowledged), acknowledged);
    const comments = []; let characters = 0, nextCursor = cursor;
    for (const row of sql.page.all(+cursor, +limitValue)) {
      const comment = storedComment(row);
      const item = v2 ? { ...comment, ...(row.visitor_hash ? { visitorTag: digest(`tag\0${row.visitor_hash}`).slice(0, 12) } : {}) }
        : (({ anchor, ...rest }) => { const legacy = anchor && legacyAnchor(anchor); return legacy ? { ...rest, anchor: legacy } : rest; })(comment);
      const size = JSON.stringify(item).length;
      if (comments.length && characters + size > EXPORT_CHARS) break;
      comments.push(item); characters += size; nextCursor = String(row.seq);
    }
    json(200, v2 ? { deploymentId, format: 2, cursor, nextCursor, comments } : { deploymentId, cursor, nextCursor, comments });
  }

  function mine({ request, url, json }, ip) {
    const visitor = visitorHash(request, true), page = url.searchParams.get('page');
    let pageKey = null;
    if (page !== null) { const parsed = urlRule(page); if (parsed.error) throw invalid('page must be an HTTP(S) URL of at most 2000 characters without credentials'); pageKey = pageKeyOf(parsed.value); }
    limiter.mine(ip, visitor);
    const acknowledged = metaNumber('export_ack');
    const rows = pageKey === null ? sql.mine.all(visitor, MINE_THREADS) : sql.minePage.all(visitor, pageKey, MINE_THREADS);
    const threads = []; let characters = 0;
    for (const row of rows) {
      const comment = storedComment(row);
      const replies = sql.replies.all(row.seq, MINE_REPLIES).map(reply => ({ id: reply.reply_id, text: reply.text, authorKind: reply.author_kind, createdAt: reply.created_at }));
      const thread = {
        id: comment.externalId, text: comment.text, ...(comment.authorName ? { authorName: comment.authorName } : {}), createdAt: comment.createdAt,
        ...(comment.pageUrl ? { pageUrl: comment.pageUrl } : {}), ...(comment.anchor ? { anchor: comment.anchor } : {}),
        status: replies.length ? 'replied' : row.seq <= acknowledged ? 'received' : 'sent', replies,
      };
      const size = JSON.stringify(thread).length;
      if (threads.length && characters + size > MINE_CHARS) break;
      threads.push(thread); characters += size;
    }
    json(200, { deploymentId, threads });
  }

  async function reply({ request, readJson, json }, externalId) {
    if (request.headers.origin !== undefined) throw httpError(403, 'Owner replies are not accepted from browsers', 'browser_forbidden');
    owner(request);
    if (!externalIdPattern.test(externalId)) throw httpError(404, 'Unknown comment', 'comment_not_found');
    const key = intentKey(request), raw = await body(readJson);
    if (!isObject(raw) || Object.keys(raw).some(name => !['text', 'authorKind'].includes(name))) throw invalid('Expected text and optional authorKind');
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!text || text.length > 2000 || replyControlCharacter.test(text)) throw invalid('Reply text must be 1–2000 characters of plain text');
    const authorKind = raw.authorKind ?? 'owner';
    if (authorKind !== 'owner' && authorKind !== 'agent') throw invalid('authorKind must be owner or agent');
    const hash = digest(JSON.stringify({ comment: externalId, text, authorKind }));
    const project = row => ({ replyId: row.reply_id, commentExternalId: row.external_id, text: row.text, authorKind: row.author_kind, createdAt: row.created_at, idempotencyKey: row.intent_key });
    const previous = sql.replyByIntent.get(key);
    if (previous) {
      if (previous.payload_hash !== hash) throw httpError(409, 'Idempotency-Key already belongs to a different reply', 'idempotency_conflict');
      json(200, { deploymentId, replayed: true, reply: project(previous) }); return;
    }
    const comment = sql.byExternalId.get(externalId);
    if (!comment) throw httpError(404, 'Unknown comment', 'comment_not_found');
    if (sql.replyCount.get(comment.seq).n >= REPLIES_PER_COMMENT) throw httpError(409, `A comment can have at most ${REPLIES_PER_COMMENT} replies`, 'reply_limit');
    if (sql.replyTotal.get().n >= REPLIES_TOTAL) throw httpError(507, 'Reply storage is full', 'storage_full');
    const row = { reply_id: randomUUID(), external_id: externalId, text, author_kind: authorKind, created_at: new Date(now()).toISOString(), intent_key: key };
    sql.insertReply.run(row.reply_id, comment.seq, key, hash, text, authorKind, row.created_at);
    json(201, { deploymentId, replayed: false, reply: project(row) });
  }

  /** Counts a CORS preflight to a comment route toward the per-IP ceiling. */
  function preflight(request, pathname) { if (enabled && isPath(pathname)) limiter.request(ipOf(request)); }

  async function route(context) {
    const { request, response, url } = context, { pathname } = url, method = request.method;
    if (!isPath(pathname)) return false;
    if (request.headers.origin) response.setHeader('access-control-expose-headers', 'Retry-After');
    if (!enabled) throw httpError(404, 'Comments are disabled', 'comments_disabled');
    const replies = /^\/_board\/comments\/([^/]+)\/replies$/.exec(pathname);
    // Owner routes authenticate with the host-held token and skip every visitor limit.
    if (pathname === '/_board/comments' && method === 'GET') { exportPage(context); return true; }
    if (replies) { if (method !== 'POST') throw httpError(405, 'Use POST', 'method_not_allowed'); await reply(context, replies[1]); return true; }
    const ip = ipOf(request);
    limiter.request(ip);
    if (pathname === '/_board/comments') { if (method !== 'POST') throw httpError(405, 'Use GET or POST', 'method_not_allowed'); await create(context, ip); return true; }
    if (pathname === '/_board/comments/mine') { if (method !== 'GET') throw httpError(405, 'Use GET', 'method_not_allowed'); mine(context, ip); return true; }
    throw httpError(404, 'Not found', 'not_found');
  }

  return { appKey, enabled, limiter, client, preflight, route };
}
