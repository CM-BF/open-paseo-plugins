import { createHmac, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/**
 * Public comment threads (schema 3, public-threads DESIGN §5.2 as amended by §12).
 *
 * A comment is public only when it was posted with `visibility: "public"`; its visibility never changes later.
 * Visitor replies are ordinary comment rows with `parent_seq`. The owner hides, shows, resolves and reopens rows;
 * a visitor may withdraw their own public row. Public posting and reading need a release the owner registered
 * (`_board_public_releases`) and a page origin in `config.origins`. Hidden rows are never served publicly.
 */

export const PUBLIC_LIMITS = Object.freeze({
  listPerIpMinute: 600, visitorRepliesPerThread: 40, publicPostsPerPageDay: 100, publicPostsGlobalHour: 150, publicRootsPerVisitorPageDay: 10,
});
const LIST_THREADS = 100, LIST_MESSAGES = 60, LIST_BYTES = 400_000, OWNER_REPLIES_PER_THREAD = 20, RELEASES = 1_000;
const MODERATION_THREADS = 100, MODERATION_REPLIES = 100, MODERATION_CHARS = 900_000;
const CACHE_ENTRIES = 64, CACHE_BYTES = 16 * 1024 * 1024;
const DAY = 86_400_000;
const releasePattern = /^release-[a-f0-9]{64}$/, externalIdPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/, tagPattern = /^[a-f0-9]{12}$/;
/** Names other visitors read next to a comment: no owner or assistant wording, no label punctuation, no invisible formatting. */
const forbiddenPublicName = /作者|AI\s*助手|访客|·|\p{Cf}/u;
/** The anchor selectors the page runtime itself produces: body, one escaped id, or a structural path of at most 12 steps. */
const publicSelector = /^(?:body|#(?:[A-Za-z0-9_\-\u0080-￿]|\\[0-9a-fA-F]{1,6} |\\[^0-9a-fA-F\r\n\f])+|body(?: > [A-Za-z][A-Za-z0-9-]*:nth-of-type\([1-9]\d{0,4}\)){1,12})$/;

// ---------------------------------------------------------------------------
// Schema 3: every existing row stays private, a visible open root; replies stay attached.

export function migrateToV3(db) {
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('_board_comments')").all().map(row => row.name));
  for (const [name, type] of [['visibility', 'TEXT'], ['parent_seq', 'INTEGER'], ['hidden', 'INTEGER NOT NULL DEFAULT 0'], ['hidden_by', 'TEXT'], ['resolved', 'INTEGER NOT NULL DEFAULT 0'], ['state_at', 'TEXT'], ['public_tag', 'TEXT']])
    if (!columns.has(name)) db.exec(`ALTER TABLE _board_comments ADD COLUMN ${name} ${type}`);
  db.exec(`
CREATE INDEX IF NOT EXISTS _board_comments_public ON _board_comments (page_key, visibility, parent_seq, seq);
CREATE INDEX IF NOT EXISTS _board_comments_parent ON _board_comments (parent_seq, seq);
CREATE TABLE IF NOT EXISTS _board_comment_pages (page_key TEXT PRIMARY KEY, version INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE IF NOT EXISTS _board_public_releases (release_id TEXT PRIMARY KEY, created_at TEXT NOT NULL) STRICT;`);
  db.prepare("INSERT INTO _board_runtime_meta(key, value) VALUES ('public_tag_key', ?) ON CONFLICT(key) DO NOTHING").run(randomBytes(32).toString('hex'));
  db.prepare("INSERT INTO _board_runtime_meta(key, value) VALUES ('comments_schema','3') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
}

/** board-app.json `comments.publicThreads`: absent means allowed (public comments exist only when a registered release asks). */
export function publicThreadsSetting(comments) {
  const value = comments.publicThreads ?? true;
  if (typeof value !== 'boolean') throw new Error('comments.publicThreads must be true or false');
  return value;
}

/** The public part of the POST rules; `input` already holds text, authorName, pageUrl and anchor. Returns an error text or null. */
export function publicInputProblem(body, input, visitor) {
  if (body.visibility === undefined && body.parentId === undefined) return null;
  if (body.visibility !== 'public') return 'visibility must be "public"';
  if (body.parentId !== undefined && (typeof body.parentId !== 'string' || !externalIdPattern.test(body.parentId))) return 'parentId must be a comment ID';
  if (!visitor) return null; // the caller answers visitor_invalid
  if (!input.pageUrl) return 'Public comments need pageUrl';
  if (input.authorName !== undefined && forbiddenPublicName.test(input.authorName)) return 'authorName of a public comment may not contain 作者, AI 助手, 访客, · or invisible formatting characters';
  const anchor = input.anchor;
  if (!anchor || typeof anchor.releaseId !== 'string') return 'Public comments need anchor.releaseId';
  if (body.parentId !== undefined) { if (Object.keys(anchor).some(key => key !== 'releaseId')) return 'A public reply anchor may contain only releaseId'; return null; }
  if (typeof anchor.quote !== 'string') return 'A public comment needs anchor.quote';
  if (anchor.selector !== undefined && !publicSelector.test(anchor.selector)) return 'anchor.selector of a public comment must be body, an id or a structural path';
  return null;
}
export const isPublicSelector = selector => publicSelector.test(selector);

class Lru {
  constructor() { this.map = new Map(); this.bytes = 0; }
  get(key) { const entry = this.map.get(key); if (entry) { this.map.delete(key); this.map.set(key, entry); } return entry; }
  set(key, entry) {
    const size = entry.body.length + (entry.gzip?.length ?? 0);
    if (size > CACHE_BYTES) return;
    if (this.map.has(key)) { this.bytes -= this.map.get(key).size; this.map.delete(key); }
    this.map.set(key, { ...entry, size }); this.bytes += size;
    while (this.map.size > CACHE_ENTRIES || this.bytes > CACHE_BYTES) { const [oldest, value] = this.map.entries().next().value; this.map.delete(oldest); this.bytes -= value.size; }
  }
}

/**
 * Route helpers for comments.mjs. `tools` comes from createComments: httpError, invalid, owner, visitorHash,
 * urlRule, pageKeyOf, storedComment, limiter, ipOf, body.
 */
export function createPublicThreads({ app, db, deploymentId, appKey, enabled, publicThreads, limits, now, tools }) {
  const { httpError, invalid, urlRule, pageKeyOf } = tools;
  const epoch = randomBytes(4).toString('hex');
  const tagKey = db.prepare("SELECT value FROM _board_runtime_meta WHERE key = 'public_tag_key'").get()?.value;
  if (!/^[a-f0-9]{64}$/.test(tagKey ?? '')) throw new Error('The public comment tag key is missing; restart to complete the schema upgrade');
  const sql = {
    byExternal: db.prepare('SELECT * FROM _board_comments WHERE external_id = ?'),
    bySeq: db.prepare('SELECT * FROM _board_comments WHERE seq = ?'),
    version: db.prepare('SELECT version, paused FROM _board_comment_pages WHERE page_key = ?'),
    bump: db.prepare('INSERT INTO _board_comment_pages(page_key, version, paused) VALUES (?, 1, 0) ON CONFLICT(page_key) DO UPDATE SET version = version + 1'),
    pause: db.prepare('INSERT INTO _board_comment_pages(page_key, version, paused) VALUES (?, 1, ?) ON CONFLICT(page_key) DO UPDATE SET version = version + 1, paused = excluded.paused'),
    pages: db.prepare('SELECT page_key, version, paused FROM _board_comment_pages ORDER BY page_key LIMIT 500'),
    insert: db.prepare('INSERT INTO _board_comments (external_id,intent_key,payload_hash,text,author_name,page_url,anchor_json,created_at,visitor_hash,page_key,visibility,parent_seq,public_tag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'),
    visibleReplies: db.prepare("SELECT count(*) AS n FROM _board_comments WHERE parent_seq = ? AND hidden = 0"),
    rootsToday: db.prepare("SELECT count(*) AS n FROM _board_comments WHERE page_key = ? AND visitor_hash = ? AND visibility = 'public' AND parent_seq IS NULL AND created_at >= ?"),
    publicToday: db.prepare("SELECT count(*) AS n FROM _board_comments WHERE page_key = ? AND visibility = 'public' AND hidden = 0 AND created_at >= ?"),
    roots: db.prepare("SELECT * FROM _board_comments WHERE page_key = ? AND visibility = 'public' AND parent_seq IS NULL AND hidden = 0 ORDER BY resolved ASC, seq DESC LIMIT ?"),
    rootCount: db.prepare("SELECT count(*) AS n FROM _board_comments WHERE page_key = ? AND visibility = 'public' AND parent_seq IS NULL AND hidden = 0"),
    children: db.prepare('SELECT * FROM _board_comments WHERE parent_seq = ? ORDER BY seq'),
    ownerReplies: db.prepare('SELECT seq, reply_id, comment_seq, text, author_kind, created_at FROM _board_comment_replies WHERE comment_seq = ? ORDER BY seq'),
    threadOwnerReplies: db.prepare('SELECT count(*) AS n FROM _board_comment_replies WHERE comment_seq = ? OR comment_seq IN (SELECT seq FROM _board_comments WHERE parent_seq = ?)'),
    setState: db.prepare('UPDATE _board_comments SET hidden = ?, hidden_by = ?, resolved = ?, state_at = ? WHERE seq = ?'),
    moderationRoots: db.prepare("SELECT * FROM _board_comments WHERE visibility = 'public' AND parent_seq IS NULL AND (? IS NULL OR page_key = ?) ORDER BY seq DESC LIMIT ?"),
    moderationCount: db.prepare("SELECT count(*) AS n FROM _board_comments WHERE visibility = 'public' AND parent_seq IS NULL AND (? IS NULL OR page_key = ?)"),
    byTag: db.prepare("SELECT seq, hidden, hidden_by, resolved FROM _board_comments WHERE page_key = ? AND visibility = 'public' AND public_tag = ?"),
    release: db.prepare('SELECT release_id FROM _board_public_releases WHERE release_id = ?'),
    releases: db.prepare('SELECT release_id FROM _board_public_releases ORDER BY created_at, release_id'),
    releaseCount: db.prepare('SELECT count(*) AS n FROM _board_public_releases'),
    register: db.prepare('INSERT INTO _board_public_releases(release_id, created_at) VALUES (?, ?) ON CONFLICT(release_id) DO NOTHING'),
    unregister: db.prepare('DELETE FROM _board_public_releases WHERE release_id = ?'),
  };
  const cache = new Lru();
  const stats = { listingBuilds: 0 };
  const tagOf = (pageKey, visitorHash) => createHmac('sha256', tagKey).update(`${pageKey}\0${visitorHash}`).digest('hex').slice(0, 12);
  const transaction = work => { db.exec('BEGIN IMMEDIATE'); try { const value = work(); db.exec('COMMIT'); return value; } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } };
  const versionOf = pageKey => sql.version.get(pageKey) ?? { version: 0, paused: 0 };
  const etagOf = version => `"p1.${epoch}.${version}"`;
  const registered = releaseId => typeof releaseId === 'string' && releasePattern.test(releaseId) && Boolean(sql.release.get(releaseId));
  const originAllowed = pageUrl => { try { return app.config.origins.includes(new URL(pageUrl).origin); } catch { return false; } };
  const parseAnchor = json => { if (json === null) return undefined; try { return JSON.parse(json); } catch { return undefined; } };
  const publicAnchor = anchor => { if (!anchor || typeof anchor.quote !== 'string') return undefined; const out = {}; for (const key of ['selector', 'quote', 'prefix', 'suffix', 'start', 'end']) if (anchor[key] !== undefined) out[key] = anchor[key]; return out; };
  const nameOf = row => { const name = typeof row.author_name === 'string' ? row.author_name.trim() : ''; return name && !forbiddenPublicName.test(name) && name.length <= 160 ? name : undefined; };
  const isWithdrawn = row => row.hidden_by === 'author';
  const ownerPage = pageKey => { if (pageKey === null) return null; const parsed = urlRule(pageKey); if (parsed.error) throw invalid('page must be an HTTP(S) URL'); return pageKeyOf(parsed.value); };

  /** Visitor and owner messages of one thread in time order (visitor before owner at the same instant). */
  function messagesOf(root, { includeHidden }) {
    const rows = sql.children.all(root.seq).filter(row => includeHidden || row.hidden === 0);
    const byKind = { visitor: 0, owner: 1, agent: 1 }, messages = [];
    for (const row of rows) messages.push({ order: [row.created_at, 0, row.seq], row, kind: 'visitor' });
    for (const target of [root, ...rows]) for (const reply of sql.ownerReplies.all(target.seq)) messages.push({ order: [reply.created_at, byKind[reply.author_kind] ?? 1, reply.seq], reply, target, kind: reply.author_kind === 'agent' ? 'agent' : 'owner' });
    messages.sort((a, b) => a.order[0] < b.order[0] ? -1 : a.order[0] > b.order[0] ? 1 : a.order[1] - b.order[1] || a.order[2] - b.order[2]);
    return messages;
  }
  function publicMessage(message, root) {
    if (message.kind === 'visitor') { const row = message.row, name = nameOf(row); return { id: row.external_id, by: 'visitor', tag: row.public_tag, ...(name ? { name } : {}), text: row.text, createdAt: row.created_at }; }
    const { reply, target } = message;
    return { id: reply.reply_id, by: message.kind, text: reply.text, createdAt: reply.created_at, ...(target.seq !== root.seq ? { replyTo: target.external_id } : {}) };
  }

  function buildListing(pageKey, version, paused) {
    stats.listingBuilds++;
    const threads = []; let bytes = 0;
    for (const root of sql.roots.all(pageKey, LIST_THREADS)) {
      const messages = messagesOf(root, { includeHidden: false }), kept = messages.slice(-LIST_MESSAGES), name = nameOf(root), anchor = publicAnchor(parseAnchor(root.anchor_json));
      const thread = { id: root.external_id, by: 'visitor', tag: root.public_tag, ...(name ? { name } : {}), text: root.text, createdAt: root.created_at, resolved: root.resolved === 1, ...(anchor ? { anchor } : {}), replies: kept.map(message => publicMessage(message, root)), omitted: messages.length - kept.length };
      const size = Buffer.byteLength(JSON.stringify(thread));
      if (threads.length && bytes + size > LIST_BYTES) break;
      threads.push(thread); bytes += size;
    }
    const total = sql.rootCount.get(pageKey).n;
    return Buffer.from(JSON.stringify({ format: 1, appKey, deploymentId, page: pageKey, version, paused: paused === 1, total, truncated: total > threads.length, threads }));
  }

  function bump(pageKey) { sql.bump.run(pageKey); }

  // -------------------------------------------------------------------------
  // Visitor POST (called from comments.mjs `create` after normalization, the replay check and the shared IP/visitor windows).

  /** Validates a public root or reply against the database. Returns the parent row for replies. */
  function admitPost(input, body, visitor) {
    if (!publicThreads) throw httpError(403, 'Public comments are turned off for this backend', 'public_disabled');
    if (!registered(input.anchor?.releaseId) || !originAllowed(input.pageUrl)) throw httpError(403, 'Public comments are not enabled for this page', 'public_not_allowed');
    const pageKey = pageKeyOf(input.pageUrl), page = versionOf(pageKey);
    if (page.paused === 1) throw httpError(403, 'The owner paused new public comments on this page', 'public_paused');
    let parent = null;
    if (body.parentId !== undefined) {
      parent = sql.byExternal.get(body.parentId);
      // Missing, hidden, withdrawn, private, nested and other-page parents look the same: nothing is revealed.
      if (!parent || parent.visibility !== 'public' || parent.parent_seq !== null || parent.hidden !== 0 || parent.page_key !== pageKey) throw httpError(404, 'Unknown comment', 'comment_not_found');
      if (parent.resolved === 1) throw httpError(409, 'The owner resolved this thread', 'thread_resolved');
      if (sql.visibleReplies.get(parent.seq).n >= limits.visitorRepliesPerThread) throw httpError(409, `A thread can have at most ${limits.visitorRepliesPerThread} visitor replies`, 'thread_full');
    }
    const time = now(), day = Math.floor(time / DAY) * DAY, since = new Date(day).toISOString(), untilTomorrow = Math.max(1, Math.ceil((day + DAY - time) / 1000));
    if (!parent && sql.rootsToday.get(pageKey, visitor, since).n >= limits.publicRootsPerVisitorPageDay) throw httpError(429, 'You started too many public discussions on this page today', 'rate_limited', { retryAfter: untilTomorrow });
    if (sql.publicToday.get(pageKey, since).n >= limits.publicPostsPerPageDay) throw httpError(429, 'This page received too many public comments today; try again tomorrow', 'rate_limited', { retryAfter: untilTomorrow });
    tools.limiter.checkPublic();
    return { pageKey, parent };
  }
  /** Inserts the row and bumps the page version in one transaction; returns the public tag. */
  function insertPost({ externalId, key, hash, input, anchorJson, createdAt, visitor, pageKey, parent }) {
    const tag = tagOf(pageKey, visitor);
    transaction(() => {
      sql.insert.run(externalId, key, hash, input.text, input.authorName ?? null, input.pageUrl, anchorJson, createdAt, visitor, pageKey, 'public', parent ? parent.seq : null, tag);
      bump(pageKey);
    });
    tools.limiter.commitPublic();
    return tag;
  }
  /** The 201/200 body of a public row (replays included): the input as stored plus its page tag. */
  function postedComment(row) {
    const parent = row.parent_seq === null ? null : sql.bySeq.get(row.parent_seq);
    return { ...tools.storedComment(row), visibility: 'public', ...(parent ? { parentId: parent.external_id } : {}), tag: row.public_tag };
  }

  // -------------------------------------------------------------------------
  // Routes.

  function listing({ request, response, url }) {
    tools.limiter.list(tools.ipOf(request));
    if (!publicThreads) throw httpError(404, 'Public comments are turned off for this backend', 'public_disabled');
    const page = url.searchParams.get('page'), release = url.searchParams.get('release');
    const parsed = page === null ? { error: true } : urlRule(page);
    if (parsed.error) throw invalid('page must be an HTTP(S) URL of at most 2000 characters without credentials');
    if (!registered(release)) throw httpError(404, 'Public comments are not enabled for this release', 'public_disabled');
    const pageKey = pageKeyOf(parsed.value), { version, paused } = versionOf(pageKey), etag = etagOf(version);
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', etag, vary: 'Origin, Accept-Encoding' };
    if (request.headers['if-none-match'] === etag) { response.writeHead(304, { etag, 'cache-control': 'no-store', vary: 'Origin, Accept-Encoding' }); response.end(); return; }
    const key = `${pageKey}\0${version}`;
    let entry = cache.get(key);
    if (!entry) { const body = buildListing(pageKey, version, paused); entry = { body, gzip: body.length > 1024 ? gzipSync(body) : null }; cache.set(key, entry); }
    const gzip = entry.gzip && /\bgzip\b/i.test(String(request.headers['accept-encoding'] ?? ''));
    response.writeHead(200, { ...headers, ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
    response.end(gzip ? entry.gzip : entry.body);
  }

  async function state({ request, readJson, json }, externalId) {
    if (request.headers.origin !== undefined) throw httpError(403, 'Owner changes are not accepted from browsers', 'browser_forbidden');
    tools.owner(request);
    if (!externalIdPattern.test(externalId)) throw httpError(404, 'Unknown comment', 'comment_not_found');
    const row = sql.byExternal.get(externalId);
    if (!row) throw httpError(404, 'Unknown comment', 'comment_not_found');
    const raw = await tools.body(readJson);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length || Object.keys(raw).some(key => !['hidden', 'resolved'].includes(key)) || Object.values(raw).some(value => typeof value !== 'boolean')) throw invalid('Expected {hidden?: boolean, resolved?: boolean}');
    if (row.visibility !== 'public') throw httpError(409, 'This comment is not public', 'not_public');
    if (raw.resolved !== undefined && row.parent_seq !== null) throw invalid('Only a thread can be resolved');
    if (raw.hidden === false && isWithdrawn(row)) throw httpError(409, 'The visitor withdrew this comment', 'withdrawn');
    const hidden = raw.hidden === undefined ? row.hidden : raw.hidden ? 1 : 0, resolved = raw.resolved === undefined ? row.resolved : raw.resolved ? 1 : 0;
    const hiddenBy = hidden ? (row.hidden ? row.hidden_by : 'owner') : null;
    const changed = hidden !== row.hidden || resolved !== row.resolved, at = new Date(now()).toISOString();
    if (changed) transaction(() => { sql.setState.run(hidden, hiddenBy, resolved, at, row.seq); bump(row.page_key); });
    json(200, { deploymentId, state: { externalId, hidden: hidden === 1, resolved: resolved === 1, withdrawn: hiddenBy === 'author', updatedAt: changed ? at : row.state_at ?? row.created_at }, changed });
  }

  async function withdraw({ request, json }, externalId, ip) {
    const visitor = tools.visitorHash(request, true);
    const row = externalIdPattern.test(externalId) ? sql.byExternal.get(externalId) : undefined;
    if (!row || row.visibility !== 'public' || row.visitor_hash !== visitor) throw httpError(404, 'Unknown comment', 'comment_not_found');
    if (!isWithdrawn(row)) {
      tools.limiter.checkPost(ip, visitor);
      tools.limiter.commitPost(ip, visitor);
      const at = new Date(now()).toISOString();
      transaction(() => { sql.setState.run(1, 'author', row.resolved, at, row.seq); bump(row.page_key); });
    }
    json(200, { deploymentId, externalId, withdrawn: true });
  }

  async function releases({ request, json, readJson }, releaseId, method) {
    if (request.headers.origin !== undefined) throw httpError(403, 'Owner changes are not accepted from browsers', 'browser_forbidden');
    tools.owner(request);
    if (!releasePattern.test(releaseId)) throw invalid('Expected a release ID');
    if (method === 'PUT') {
      const raw = await tools.body(readJson);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length) throw invalid('Expected an empty JSON object');
      if (!sql.release.get(releaseId) && sql.releaseCount.get().n >= RELEASES) throw httpError(409, `At most ${RELEASES} public releases can be registered`, 'release_limit');
      const changed = sql.register.run(releaseId, new Date(now()).toISOString()).changes > 0;
      json(200, { deploymentId, releaseId, registered: true, changed }); return;
    }
    if (method === 'DELETE') { const changed = sql.unregister.run(releaseId).changes > 0; json(200, { deploymentId, releaseId, registered: false, changed }); return; }
    throw httpError(405, 'Use PUT or DELETE', 'method_not_allowed');
  }

  function moderation({ request, url, json }) {
    if (request.headers.origin !== undefined) throw httpError(403, 'Owner reads are not accepted from browsers', 'browser_forbidden');
    tools.owner(request);
    const pageKey = ownerPage(url.searchParams.get('page'));
    const threads = []; let characters = 0;
    for (const root of sql.moderationRoots.all(pageKey, pageKey, MODERATION_THREADS)) {
      const messages = messagesOf(root, { includeHidden: true }), kept = messages.slice(-MODERATION_REPLIES), name = nameOf(root);
      const replies = kept.map(message => {
        if (message.kind !== 'visitor') return publicMessage(message, root);
        const row = message.row, rowName = nameOf(row);
        return { id: row.external_id, by: 'visitor', tag: row.public_tag, ...(rowName ? { name: rowName } : {}), text: row.text, createdAt: row.created_at, hidden: row.hidden === 1, ...(isWithdrawn(row) ? { withdrawn: true } : {}) };
      });
      const anchor = publicAnchor(parseAnchor(root.anchor_json));
      const thread = { id: root.external_id, page: root.page_key, tag: root.public_tag, ...(name ? { name } : {}), text: root.text, createdAt: root.created_at, hidden: root.hidden === 1, ...(isWithdrawn(root) ? { withdrawn: true } : {}), resolved: root.resolved === 1, ...(anchor ? { anchor } : {}), replies, omitted: messages.length - kept.length };
      const size = JSON.stringify(thread).length;
      if (threads.length && characters + size > MODERATION_CHARS) break;
      threads.push(thread); characters += size;
    }
    const total = sql.moderationCount.get(pageKey, pageKey).n;
    json(200, { deploymentId, publicThreads, pages: sql.pages.all().map(page => ({ page: page.page_key, version: page.version, paused: page.paused === 1 })), releases: sql.releases.all().map(row => row.release_id), total, truncated: total > threads.length, threads });
  }

  async function ownerBody(request, readJson, keys) {
    if (request.headers.origin !== undefined) throw httpError(403, 'Owner changes are not accepted from browsers', 'browser_forbidden');
    tools.owner(request);
    const raw = await tools.body(readJson);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) throw invalid(`Expected ${keys.join(', ')}`);
    return raw;
  }
  async function pause({ request, readJson, json }) {
    const raw = await ownerBody(request, readJson, ['page', 'paused']);
    if (typeof raw.paused !== 'boolean' || typeof raw.page !== 'string') throw invalid('Expected {page, paused}');
    const pageKey = ownerPage(raw.page), before = versionOf(pageKey).paused === 1, changed = before !== raw.paused;
    if (changed) sql.pause.run(pageKey, raw.paused ? 1 : 0);
    json(200, { deploymentId, page: pageKey, paused: raw.paused, changed });
  }
  async function hideVisitor({ request, readJson, json }) {
    const raw = await ownerBody(request, readJson, ['page', 'tag', 'hidden']);
    if (typeof raw.page !== 'string' || typeof raw.tag !== 'string' || !tagPattern.test(raw.tag) || raw.hidden !== undefined && typeof raw.hidden !== 'boolean') throw invalid('Expected {page, tag, hidden?}');
    const pageKey = ownerPage(raw.page), hide = raw.hidden !== false, at = new Date(now()).toISOString();
    let changed = 0;
    transaction(() => {
      for (const row of sql.byTag.all(pageKey, raw.tag)) {
        if (hide && row.hidden === 0) { sql.setState.run(1, 'owner', row.resolved, at, row.seq); changed++; }
        else if (!hide && row.hidden === 1 && row.hidden_by === 'owner') { sql.setState.run(0, null, row.resolved, at, row.seq); changed++; }
      }
      if (changed) bump(pageKey);
    });
    json(200, { deploymentId, page: pageKey, tag: raw.tag, hidden: hide, changed });
  }

  // -------------------------------------------------------------------------
  // Hooks for owner replies, export and mine.

  /** Owner replies count per thread (root plus its visitor replies); a public target bumps its page version. */
  function ownerReplyTarget(row) {
    const rootSeq = row.parent_seq ?? row.seq;
    return { count: sql.threadOwnerReplies.get(rootSeq, rootSeq).n, limit: OWNER_REPLIES_PER_THREAD, bump: row.visibility === 'public' ? () => bump(row.page_key) : null };
  }
  /** Export extension (threads=1): public fields only where they apply. */
  function exportExtras(row) {
    if (row.visibility !== 'public') return {};
    const parent = row.parent_seq === null ? null : sql.bySeq.get(row.parent_seq);
    return { visibility: 'public', ...(parent ? { parentId: parent.external_id } : {}), ...(row.public_tag ? { publicTag: row.public_tag } : {}), ...(row.hidden ? { hidden: true } : {}), ...(isWithdrawn(row) ? { withdrawn: true } : {}), ...(row.resolved ? { resolved: true } : {}) };
  }

  return { enabled: enabled && publicThreads, stats, epoch, admitPost, insertPost, postedComment, listing, state, withdraw, releases, moderation, pause, hideVisitor, ownerReplyTarget, exportExtras };
}
