// Public comment threads (schema 3): real HTTP and SQLite in temporary directories (public-threads DESIGN §9.3, §12).
// Imported by checks.mjs, so `node --test backend/checks.mjs` runs these too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initializeApp } from './scaffold.mjs';
import { loadApp, readJson, digest } from './files.mjs';
import { openDatabase } from './storage.mjs';
import { startApp } from './server.mjs';
import { COMMENT_LIMITS, commentSettings } from './comments.mjs';
import { forbiddenPublicName, isPublicSelector } from './threads.mjs';
import { LegacyInboxPageSchema } from '../scripts/fixtures/legacy-inbox-page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const expand = (value, parent) => typeof value === 'string' ? value.replace(/<<repeat:(.):(\d+)>>/gu, (_, c, n) => c.repeat(Number(n))).replace(/<<parent>>/g, parent ?? '<<parent>>')
  : Array.isArray(value) ? value.map(item => expand(item, parent)) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, parent)])) : value;
const RAW = JSON.parse(await fs.readFile(path.join(here, '../scripts/fixtures/public-threads-contract.json'), 'utf8'));
const PT = expand(RAW);
const TOKEN = 'p'.repeat(48), owner = { authorization: `Bearer ${TOKEN}` };
const PAGE = PT.pageUrl, ORIGIN = new URL(PAGE).origin, OTHER_PAGE = `${ORIGIN}/pages/boards/sfedcba9876543210fedc/`, RELEASE = PT.releaseId, RELEASE_B = `release-${'b'.repeat(64)}`;
const V = { a: 'a'.repeat(64), b: 'b'.repeat(64), c: 'c'.repeat(64), d: 'd'.repeat(64) };
const RELAXED = { requestsPerIpMinute: 3000, postPerIpMinute: 100, postPerIpHour: 600, postPerVisitorMinute: 50, postPerVisitorHour: 300, postGlobalMinute: 1200, publicPostsGlobalHour: 1500, publicRootsPerVisitorPageDay: 100, listPerIpMinute: 6000 };
/** A distinct visitor secret and forwarded address per post, for tests that need many posts within one minute. */
const many = i => ({ secret: (i + 1).toString(16).padStart(64, '0'), headers: { 'x-forwarded-for': `198.51.${100 + (i >> 8)}.${i & 255}` } });
const visitorHash = secret => digest(`board-visitor:v1:${secret}`);

function setToken(t, value = TOKEN) {
  const original = process.env.BOARD_INBOX_EXPORT_TOKEN;
  t.after(() => { if (original === undefined) delete process.env.BOARD_INBOX_EXPORT_TOKEN; else process.env.BOARD_INBOX_EXPORT_TOKEN = original; });
  process.env.BOARD_INBOX_EXPORT_TOKEN = value;
}
async function makeApp(t, comments = {}, change = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'board-threads-check-'));
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await fs.rm(directory, { recursive: true, force: true }); });
  const root = path.join(directory, 'app'); await initializeApp(root, 'threads-app');
  const config = await readJson(path.join(root, 'board-app.json'));
  await fs.writeFile(path.join(root, 'board-app.json'), JSON.stringify({ ...config, port: 0, origins: [ORIGIN], comments: { enabled: true, limits: RELAXED, ...comments }, ...change }));
  const app = await loadApp(root);
  return { directory, root, app, cleanup };
}
async function publicApp(t, comments = {}, change = {}) {
  setToken(t);
  const made = await makeApp(t, comments, change);
  const server = await startApp(made.app); made.cleanup.push(server.close);
  const base = `http://127.0.0.1:${server.port}`;
  if (comments.publicThreads !== false && comments.enabled !== false) assert.equal((await register(base, RELEASE)).status, 200);
  return { ...made, server, base, restart: async () => { await server.close(); const next = await startApp(await loadApp(made.root)); made.cleanup.push(next.close); return { server: next, base: `http://127.0.0.1:${next.port}` }; } };
}
const register = (base, release, method = 'PUT', headers = owner) => fetch(`${base}/_board/comments/public-releases/${release}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(method === 'PUT' ? { body: '{}' } : {}) });
let keySeq = 0;
const post = (base, secret, body, headers = {}) => fetch(`${base}/_board/comments`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': headers['idempotency-key'] ?? `pt-key-${++keySeq}`, ...(secret ? { 'x-board-visitor': secret } : {}), ...headers }, body: JSON.stringify(body) });
const root = (text, extra = {}) => ({ text, pageUrl: PAGE, visibility: 'public', anchor: { selector: '#result', quote: '第二步', releaseId: RELEASE }, ...extra });
const reply = (parentId, text, extra = {}) => ({ text, pageUrl: PAGE, visibility: 'public', parentId, anchor: { releaseId: RELEASE }, ...extra });
async function created(response) { assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).comment; }
const listing = (base, query = `?page=${encodeURIComponent(PAGE)}&release=${RELEASE}`, headers = {}) => fetch(`${base}/_board/comments/public${query}`, { headers });
async function listed(base, page = PAGE) { const response = await listing(base, `?page=${encodeURIComponent(page)}&release=${RELEASE}`); assert.equal(response.status, 200); return { etag: response.headers.get('etag'), body: await response.json() }; }
const setState = (base, id, body, headers = owner) => fetch(`${base}/_board/comments/${id}/state`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const ownerReply = (base, id, key, body) => fetch(`${base}/_board/comments/${id}/replies`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...owner }, body: JSON.stringify(body) });
const ownerPost = (base, route, body) => fetch(`${base}/_board/comments/public/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...owner }, body: JSON.stringify(body) });
const exported = (base, query) => fetch(`${base}/_board/comments${query}`, { headers: owner }).then(async response => { assert.equal(response.status, 200); return response.json(); });
async function failure(response, status, code) { assert.equal(response.status, status, await response.clone().text()); const body = await response.json(); assert.equal(body.code, code, JSON.stringify(body)); return response; }

test('public-threads fixture: accepted public posts store exactly with a page tag, rejected ones return their code', async t => {
  const { base, server } = await publicApp(t);
  const tagKey = server.db.prepare("SELECT value FROM _board_runtime_meta WHERE key='public_tag_key'").get().value;
  const pageTag = secret => createHmac('sha256', tagKey).update(`${PAGE}\0${visitorHash(secret)}`).digest('hex').slice(0, 12);
  let parent;
  for (const [index, raw] of RAW.post.accepted.entries()) {
    const item = expand(raw, parent);
    const comment = await created(await post(base, PT.visitorSecret, item.body));
    assert.deepEqual(comment, { ...item.stored, externalId: comment.externalId, createdAt: comment.createdAt, tag: pageTag(PT.visitorSecret) }, item.name);
    if (index === 0) parent = comment.externalId;
  }
  for (const raw of RAW.post.rejected) {
    const item = expand(raw, parent);
    await failure(await post(base, item.visitor === false ? null : PT.visitorSecret, item.body), 400, item.code);
  }
  for (const selector of ['body', '#result', '#\\31 23', '#a\\ b', '#中文', 'body > main:nth-of-type(1) > p:nth-of-type(12)']) assert.equal(isPublicSelector(selector), true, selector);
  for (const selector of ['div', 'main p', '#a, #b', 'body > p', 'p:nth-of-type(1)', 'body > p:nth-of-type(0)', '#a b', '* ']) assert.equal(isPublicSelector(selector), false, selector);
});

test('public posting needs a registered release, an allowed page origin, the app switch and an unpaused page', async t => {
  const { base, root: appRoot, app, cleanup } = await publicApp(t);
  await failure(await post(base, V.a, root('未登记', { anchor: { quote: '第二步', releaseId: RELEASE_B } })), 403, 'public_not_allowed');
  await failure(await post(base, V.a, root('别的网站', { pageUrl: 'https://evil.example/page' })), 403, 'public_not_allowed');
  await failure(await listing(base, `?page=${encodeURIComponent(PAGE)}&release=${RELEASE_B}`), 404, 'public_disabled');
  await failure(await listing(base, `?page=${encodeURIComponent(PAGE)}`), 404, 'public_disabled');
  await failure(await listing(base, `?page=nope&release=${RELEASE}`), 400, 'invalid_input');
  // Owner registration refuses browsers and requires the token.
  await failure(await register(base, RELEASE_B, 'PUT', { ...owner, origin: ORIGIN }), 403, 'browser_forbidden');
  await failure(await register(base, RELEASE_B, 'PUT', { authorization: 'Bearer wrong' }), 401, 'unauthorized');
  assert.equal((await register(base, RELEASE_B)).status, 200);
  assert.equal((await post(base, V.a, root('已登记', { anchor: { quote: '第二步', releaseId: RELEASE_B } }))).status, 201);
  const unregistered = await register(base, RELEASE_B, 'DELETE');
  assert.deepEqual(await unregistered.json(), { deploymentId: (await (await fetch(`${base}/_board/health`)).json()).deploymentId, releaseId: RELEASE_B, registered: false, changed: true, pages: 0 });
  await failure(await listing(base, `?page=${encodeURIComponent(PAGE)}&release=${RELEASE_B}`), 404, 'public_disabled');
  // Pausing a page refuses new public posts and is visible in the listing.
  const paused = await ownerPost(base, 'pause', { page: PAGE, paused: true });
  assert.equal(paused.status, 200); assert.equal((await paused.json()).changed, true);
  await failure(await post(base, V.a, root('暂停中')), 403, 'public_paused');
  assert.equal((await listed(base)).body.paused, true);
  assert.equal((await ownerPost(base, 'pause', { page: PAGE, paused: false })).status, 200);
  assert.equal((await post(base, V.a, root('恢复后'))).status, 201);
  // The hard off switch.
  const config = JSON.parse(await fs.readFile(path.join(appRoot, 'board-app.json'), 'utf8'));
  await fs.writeFile(path.join(appRoot, 'board-app.json'), JSON.stringify({ ...config, comments: { ...config.comments, publicThreads: false } }));
  for (const close of cleanup.splice(0)) await close();
  const off = await startApp(await loadApp(appRoot)); cleanup.push(off.close);
  const offBase = `http://127.0.0.1:${off.port}`;
  assert.equal((await (await fetch(`${offBase}/_board/health`)).json()).publicThreads, 0);
  await failure(await post(offBase, V.a, root('关闭了')), 403, 'public_disabled');
  await failure(await listing(offBase), 404, 'public_disabled');
  assert.equal((await post(offBase, V.a, { text: '私密照常', pageUrl: PAGE })).status, 201, 'private comments are unaffected');
  assert.throws(() => commentSettings({ comments: { publicThreads: 'yes' } }), /publicThreads must be true or false/);
  void app;
});

test('a share turned private closes its page to every release: posts and listings through another share\'s release are refused until it is registered again', async t => {
  const { base } = await publicApp(t);
  const PAGE_B = OTHER_PAGE, put = (release, body) => fetch(`${base}/_board/comments/public-releases/${release}`, { method: 'PUT', headers: { 'content-type': 'application/json', ...owner }, body: JSON.stringify(body) });
  const remove = (release, body) => fetch(`${base}/_board/comments/public-releases/${release}`, { method: 'DELETE', headers: { 'content-type': 'application/json', ...owner }, body: JSON.stringify(body) });
  assert.equal((await put(RELEASE_B, { pages: [PAGE_B] })).status, 200);
  const onB = await created(await post(base, V.a, root('B 页的公开评论', { pageUrl: PAGE_B, anchor: { quote: '第二步', releaseId: RELEASE_B } })));
  assert.equal((await listed(base, PAGE_B)).body.threads[0].id, onB.externalId, 'release A can read page B while it is public (not bound to a page)');
  const before = (await listed(base, PAGE_B)).etag;
  // The plugin withdraws B with the share's page address: page B closes for release A too.
  const withdrawn = await remove(RELEASE_B, { pages: [PAGE_B + 'index.html'] });
  assert.deepEqual({ ...(await withdrawn.json()), deploymentId: undefined }, { deploymentId: undefined, releaseId: RELEASE_B, registered: false, changed: true, pages: 1 });
  await failure(await listing(base, `?page=${encodeURIComponent(PAGE_B)}&release=${RELEASE}`), 404, 'public_disabled');
  await failure(await listing(base, `?page=${encodeURIComponent(PAGE_B)}&release=${RELEASE}`, { 'if-none-match': before }), 404, 'public_disabled');
  await failure(await post(base, V.b, root('关了还想发', { pageUrl: PAGE_B })), 403, 'public_not_allowed');
  await failure(await post(base, V.b, reply(onB.externalId, '关了还想回复', { pageUrl: PAGE_B })), 403, 'public_not_allowed');
  // Other pages are unaffected; the closed page keeps its rows for the owner (moderation and export).
  assert.equal((await post(base, V.b, root('A 页照常'))).status, 201);
  const moderation = await (await fetch(`${base}/_board/comments/public/moderation`, { headers: owner })).json();
  assert.ok(moderation.threads.some(item => item.id === onB.externalId));
  // A later public release for that page reopens it; DELETE without a body still works; bad bodies are refused.
  const RELEASE_C = `release-${'c'.repeat(64)}`;
  assert.equal((await put(RELEASE_C, { pages: [PAGE_B] })).status, 200);
  assert.equal((await listed(base, PAGE_B)).body.threads.length, 1);
  assert.equal((await register(base, RELEASE_C, 'DELETE')).status, 200);
  await failure(await put(RELEASE_C, { pages: ['nope'] }), 400, 'invalid_input');
  await failure(await put(RELEASE_C, { pages: Array.from({ length: 9 }, (_, i) => `${ORIGIN}/p${i}/`) }), 400, 'invalid_input');
  await failure(await put(RELEASE_C, { other: true }), 400, 'invalid_input');
});

test('public names: the page labels are refused after NFKC, spacing and case (name_not_allowed); other punctuation is fine', async t => {
  const { base } = await publicApp(t);
  for (const name of ['作者', '作 者', 'ＡＩ助手', 'ai 助手', '作 者的ＡＩ助手', '訪客・3f9a12', '访客小王', '小王 · 访客·3f9a1c', 'abc‏def', 'x\u{E0041}']) {
    assert.equal(forbiddenPublicName(name), true, name);
    await failure(await post(base, V.a, root('名字测试', { authorName: name })), 400, 'name_not_allowed');
  }
  for (const name of ['迈克尔·杰克逊', '列夫·托尔斯泰', 'Author', '博主', '小王']) {
    assert.equal(forbiddenPublicName(name), false, name);
    assert.equal((await created(await post(base, V.a, root(`名字 ${name}`, { authorName: name })))).authorName, name);
  }
});

test('moderation listing: budgeted in UTF-8 bytes below the plugin cap; visible threads first, so hiding spam makes room', async t => {
  const { base } = await publicApp(t, { limits: { ...RELAXED, publicPostsPerPageDay: 1000, postPerPageDay: 5000, publicRootsPerVisitorPageDay: 100 } });
  const big = '评'.repeat(2000), quote = '论'.repeat(1000);
  const real = await created(await post(base, V.a, root('真正需要处理的讨论')));
  const spam = [];
  for (let i = 0; i < 100; i++) spam.push(await created(await post(base, many(i).secret, root(big, { anchor: { quote, releaseId: RELEASE } }), many(i).headers)));
  const first = spam[0];
  for (let i = 0; i < 20; i++) assert.equal((await post(base, many(200 + i).secret, reply(first.externalId, big), many(200 + i).headers)).status, 201);
  // Long page addresses fill the pages list too.
  for (let i = 0; i < 100; i++) assert.equal((await ownerPost(base, 'pause', { page: `${ORIGIN}/${'长'.repeat(200)}/${i}/`, paused: i % 2 === 0 })).status, 200);
  const read = async () => { const response = await fetch(`${base}/_board/comments/public/moderation`, { headers: owner }); const text = await response.text(); return { bytes: Buffer.byteLength(text), body: JSON.parse(text) }; };
  const full = await read();
  assert.ok(full.bytes <= 900_000, `${full.bytes} bytes`);
  assert.equal(full.body.total, 101); assert.equal(full.body.truncated, true); assert.ok(full.body.threads.length >= 20, String(full.body.threads.length));
  assert.ok(full.body.pages.length < 100, 'the pages list has its own budget'); assert.ok(full.body.pages.slice(0, 40).every(page => page.paused), 'paused pages come first');
  assert.equal(full.body.threads.some(item => item.id === real.externalId), false, 'the oldest visible thread does not fit yet');
  // Hiding the spam moves it behind what visitors can still see.
  for (const row of spam) assert.equal((await setState(base, row.externalId, { hidden: true })).status, 200);
  const after = await read();
  assert.ok(after.bytes <= 900_000);
  assert.equal(after.body.threads[0].id, real.externalId); assert.equal(after.body.threads[0].hidden, false);
  // One thread with many long replies keeps its newest messages within its own budget.
  const thread = after.body.threads.find(item => item.id === first.externalId) ?? (await read()).body.threads.find(item => item.id === first.externalId);
  if (thread) assert.equal(thread.replies.length + thread.omitted, 20);
});

test('replies: parents must be visible public roots on the same page; resolved and full threads refuse; nothing reveals a hidden parent', async t => {
  const { base } = await publicApp(t, { limits: { ...RELAXED, visitorRepliesPerThread: 3 } });
  const thread = await created(await post(base, V.a, root('主题')));
  const privateRow = await created(await post(base, V.a, { text: '私密', pageUrl: PAGE }));
  const otherPage = await created(await post(base, V.a, root('别的页面', { pageUrl: OTHER_PAGE })));
  const first = await created(await post(base, V.b, reply(thread.externalId, '回复一')));
  assert.equal(first.parentId, thread.externalId); assert.match(first.tag, /^[a-f0-9]{12}$/);
  for (const [id, label] of [[privateRow.externalId, 'private'], [otherPage.externalId, 'other page'], [first.externalId, 'nested'], ['00000000-0000-4000-8000-00000000dead', 'missing']])
    await failure(await post(base, V.b, reply(id, label)), 404, 'comment_not_found');
  const replayKey = 'pt-replay-reply';
  assert.equal((await post(base, V.c, reply(thread.externalId, '回复二'), { 'idempotency-key': replayKey })).status, 201);
  await created(await post(base, V.d, reply(thread.externalId, '回复三')));
  await failure(await post(base, V.b, reply(thread.externalId, '第四条')), 409, 'thread_full');
  assert.equal((await setState(base, first.externalId, { hidden: true })).status, 200);
  assert.equal((await post(base, V.b, reply(thread.externalId, '隐藏一条后可以'))).status, 201, 'hidden replies do not count toward the thread cap');
  assert.equal((await setState(base, thread.externalId, { resolved: true })).status, 200);
  await failure(await post(base, V.b, reply(thread.externalId, '已解决')), 409, 'thread_resolved');
  assert.equal((await setState(base, thread.externalId, { resolved: false, hidden: true })).status, 200);
  await failure(await post(base, V.b, reply(thread.externalId, '已隐藏')), 404, 'comment_not_found');
  const replay = await post(base, V.c, reply(thread.externalId, '回复二'), { 'idempotency-key': replayKey });
  assert.equal(replay.status, 200, 'a replay still returns the stored reply to its poster after the parent was hidden');
  assert.equal((await replay.json()).comment.parentId, thread.externalId);
});

test('public limits: replies count as posts; roots per visitor, posts per page and the global hour; hidden rows free the page allowance', async t => {
  const { base } = await publicApp(t, { limits: { ...RELAXED, postPerVisitorMinute: 4, publicRootsPerVisitorPageDay: 2, publicPostsPerPageDay: 6, postPerPageDay: 8 } });
  const a = await created(await post(base, V.a, root('一')));
  await created(await post(base, V.a, root('二')));
  await failure(await post(base, V.a, root('三')), 429, 'rate_limited');
  await created(await post(base, V.a, reply(a.externalId, 'r1')));
  await created(await post(base, V.a, reply(a.externalId, 'r2')));
  const limited = await failure(await post(base, V.a, reply(a.externalId, 'r3')), 429, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  await created(await post(base, V.b, reply(a.externalId, 'b1')));
  await created(await post(base, V.c, root('c1')));
  await failure(await post(base, V.d, root('第七条')), 429, 'rate_limited');
  assert.equal((await ownerPost(base, 'hide-visitor', { page: PAGE, tag: a.tag })).status, 200);
  assert.equal((await post(base, V.d, root('隐藏后可以'))).status, 201, 'hidden rows no longer count toward the page allowance');
  const { base: globalBase } = await publicApp(t, { limits: { ...RELAXED, publicPostsGlobalHour: 2 } });
  await created(await post(globalBase, V.a, root('g1'))); await created(await post(globalBase, V.b, root('g2')));
  await failure(await post(globalBase, V.c, root('g3')), 429, 'rate_limited');
  assert.equal((await post(globalBase, V.c, { text: '私密不受公开上限影响', pageUrl: PAGE })).status, 201);
  for (const key of ['listPerIpMinute', 'visitorRepliesPerThread', 'publicPostsPerPageDay', 'publicPostsGlobalHour', 'publicRootsPerVisitorPageDay']) assert.ok(COMMENT_LIMITS[key] > 0, key);
  assert.deepEqual([COMMENT_LIMITS.publicPostsPerPageDay, COMMENT_LIMITS.publicPostsGlobalHour, COMMENT_LIMITS.publicRootsPerVisitorPageDay, COMMENT_LIMITS.listPerIpMinute], [100, 150, 10, 600]);
});

test('listing: exact keys, unresolved first, hidden content never served, other pages and private rows absent', async t => {
  const { base } = await publicApp(t);
  const older = await created(await post(base, V.a, root('较早的讨论', { authorName: '小王' })));
  const newer = await created(await post(base, V.b, root('较新的讨论')));
  const r1 = await created(await post(base, V.c, reply(older.externalId, '访客回复', { authorName: '小李' })));
  const r2 = await created(await post(base, V.d, reply(older.externalId, '将被隐藏的回复')));
  assert.equal((await ownerReply(base, r1.externalId, 'ir-agent-to-reply', { text: 'AI 回复访客回复', authorKind: 'agent' })).status, 201);
  assert.equal((await ownerReply(base, older.externalId, 'ir-owner-root', { text: '作者回复' })).status, 201);
  assert.equal((await ownerReply(base, r2.externalId, 'ir-owner-hidden', { text: '附在隐藏回复上的作者回复' })).status, 201);
  await created(await post(base, V.a, { text: '私密评论', pageUrl: PAGE, anchor: { quote: '第二步' } }));
  await created(await post(base, V.a, root('别的页面', { pageUrl: OTHER_PAGE })));
  assert.equal((await setState(base, r2.externalId, { hidden: true })).status, 200);
  assert.equal((await setState(base, newer.externalId, { resolved: true })).status, 200);
  const { body } = await listed(base);
  assert.deepEqual(Object.keys(body), ['format', 'appKey', 'deploymentId', 'page', 'version', 'paused', 'total', 'truncated', 'threads']);
  assert.equal(body.page, PAGE); assert.equal(body.total, 2); assert.equal(body.truncated, false);
  assert.deepEqual(body.threads.map(thread => [thread.text, thread.resolved]), [['较早的讨论', false], ['较新的讨论', true]], 'unresolved first');
  const [thread] = body.threads;
  assert.deepEqual(Object.keys(thread), ['id', 'by', 'tag', 'name', 'text', 'createdAt', 'resolved', 'anchor', 'replies', 'omitted']);
  assert.deepEqual(thread.anchor, { selector: '#result', quote: '第二步' }, 'label and releaseId stay private');
  assert.deepEqual(thread.replies.map(item => [item.by, item.text, item.replyTo ?? null, item.name ?? null]), [['visitor', '访客回复', null, '小李'], ['agent', 'AI 回复访客回复', r1.externalId, null], ['owner', '作者回复', null, null]]);
  const text = JSON.stringify(body);
  for (const secret of ['将被隐藏的回复', '附在隐藏回复上的作者回复', '私密评论', '别的页面', visitorHash(V.a), V.a, 'pageUrl', 'releaseId', 'visitorHash', '127.0.0.1']) assert.equal(text.includes(secret), false, secret);
  for (const key of PT.listing.forbiddenKeys) assert.equal(text.includes(`"${key}"`), false, key);
  assert.equal((await setState(base, older.externalId, { hidden: true })).status, 200);
  const after = (await listed(base)).body;
  assert.deepEqual(after.threads.map(item => item.text), ['较新的讨论']);
  for (const secret of ['较早的讨论', '访客回复', 'AI 回复访客回复', '作者回复']) assert.equal(JSON.stringify(after).includes(secret), false, secret);
});

test('listing caps: 100 threads, the newest 60 messages per thread with omitted, 400,000 bytes, total and truncated; gzip when accepted', async t => {
  const limits = { ...RELAXED, visitorRepliesPerThread: 400, publicPostsPerPageDay: 1000, postPerPageDay: 5000, publicRootsPerVisitorPageDay: 100 };
  const { base } = await publicApp(t, { limits });
  const big = await created(await post(base, V.a, root('大讨论')));
  for (let i = 0; i < 64; i++) { const { secret, headers } = many(i); await created(await post(base, secret, reply(big.externalId, `回复 ${i}`), headers)); }
  for (let i = 0; i < 104; i++) { const { secret, headers } = many(100 + i); await created(await post(base, secret, root(`主题 ${i}`), headers)); }
  const { body } = await listed(base);
  assert.equal(body.threads.length, 100); assert.equal(body.total, 105); assert.equal(body.truncated, true);
  assert.equal(body.threads.some(item => item.id === big.externalId), false, 'the newest threads come first');
  const raw = await new Promise((resolve, reject) => { import('node:http').then(({ get }) => get(`${base}/_board/comments/public?page=${encodeURIComponent(PAGE)}&release=${RELEASE}`, { headers: { 'accept-encoding': 'gzip, br' } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ headers: response.headers, body: Buffer.concat(chunks) })); }).on('error', reject)); });
  assert.equal(raw.headers['content-encoding'], 'gzip'); assert.deepEqual(JSON.parse(gunzipSync(raw.body).toString()), body);
  const { base: bytesBase } = await publicApp(t, { limits });
  const older = await created(await post(bytesBase, V.a, root('早')));
  for (let i = 0; i < 64; i++) { const { secret, headers } = many(i); await created(await post(bytesBase, secret, reply(older.externalId, `${i} ${'长'.repeat(1990)}`), headers)); }
  const newer = await created(await post(bytesBase, V.b, root('晚')));
  for (let i = 0; i < 20; i++) { const { secret, headers } = many(300 + i); await created(await post(bytesBase, secret, reply(newer.externalId, `${i} ${'宽'.repeat(1990)}`), headers)); }
  const capped = (await listed(bytesBase)).body;
  assert.deepEqual(capped.threads.map(item => item.text), ['晚'], 'the older thread would pass 400,000 bytes');
  assert.equal(capped.total, 2); assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(capped.threads)) <= 400_000);
  assert.equal((await ownerPost(bytesBase, 'hide-visitor', { page: PAGE, tag: (await (await post(bytesBase, V.b, reply(newer.externalId, 'x'))).json()).comment.tag })).status, 200);
  assert.equal((await setState(bytesBase, newer.externalId, { hidden: true })).status, 200);
  const only = (await listed(bytesBase)).body;
  assert.deepEqual(only.threads.map(item => item.text), ['早']);
  assert.equal(only.threads[0].replies.length, 60); assert.equal(only.threads[0].omitted, 4);
  assert.equal(only.threads[0].replies[0].text.startsWith('4 '), true, 'the newest 60 messages are kept');
});

test('ETag: stable without changes, 304 without a body, a new tag after every kind of change and after a restart; one build per version', async t => {
  const { base, server, restart } = await publicApp(t);
  const first = await listing(base); const tag0 = first.headers.get('etag');
  assert.match(tag0, /^"p1\.[a-f0-9]{8}\.0"$/); assert.equal(first.headers.get('cache-control'), 'no-store');
  const again = await listing(base, undefined, { 'if-none-match': tag0 });
  assert.equal(again.status, 304); assert.equal(await again.text(), ''); assert.equal(again.headers.get('etag'), tag0);
  const tags = new Set([tag0]);
  const changed = async label => { const response = await listing(base); assert.equal(response.status, 200); const tag = response.headers.get('etag'); assert.equal(tags.has(tag), false, label); tags.add(tag); await response.arrayBuffer(); };
  const thread = await created(await post(base, V.a, root('一'))); await changed('post');
  const answer = await created(await post(base, V.b, reply(thread.externalId, '二'))); await changed('visitor reply');
  assert.equal((await ownerReply(base, thread.externalId, 'ir-etag-owner', { text: '作者' })).status, 201); await changed('owner reply');
  assert.equal((await setState(base, answer.externalId, { hidden: true })).status, 200); await changed('hide');
  assert.equal((await setState(base, answer.externalId, { hidden: false })).status, 200); await changed('unhide');
  assert.equal((await setState(base, thread.externalId, { resolved: true })).status, 200); await changed('resolve');
  assert.equal((await setState(base, thread.externalId, { resolved: false })).status, 200); await changed('reopen');
  assert.equal((await ownerPost(base, 'pause', { page: PAGE, paused: true })).status, 200); await changed('pause');
  assert.equal((await ownerPost(base, 'pause', { page: PAGE, paused: false })).status, 200); await changed('resume');
  assert.equal((await fetch(`${base}/_board/comments/${answer.externalId}/withdraw`, { method: 'POST', headers: { 'x-board-visitor': V.b } })).status, 200); await changed('withdraw');
  const unchanged = (await setState(base, thread.externalId, { resolved: false })).json();
  assert.equal((await unchanged).changed, false);
  const current = (await listing(base)).headers.get('etag'); assert.equal(tags.has(current), true, 'an unchanged state keeps the tag');
  // Many readers of one version: the body is built once.
  const before = server.stats.listingBuilds;
  for (let i = 0; i < 50; i++) { const response = await listing(base, undefined, { 'accept-encoding': i % 2 ? 'gzip' : 'identity' }); assert.equal(response.status, 200); await response.arrayBuffer(); }
  assert.equal(server.stats.listingBuilds, before, 'one build per (page, version)');
  const { base: restarted } = await restart();
  const after = (await listing(restarted)).headers.get('etag');
  assert.notEqual(after.split('.')[1], current.split('.')[1], 'a restart starts a new epoch');
});

test('listing limits and CORS: its own per-address window with Retry-After, If-None-Match preflight, ETag exposed, 304 and 429 keep CORS', async t => {
  const { base } = await publicApp(t, { limits: { ...RELAXED, listPerIpMinute: 3, requestsPerIpMinute: 4 } });
  const headers = { origin: ORIGIN };
  const preflight = await fetch(`${base}/_board/comments/public?page=x`, { method: 'OPTIONS', headers: { ...headers, 'access-control-request-method': 'GET', 'access-control-request-headers': 'if-none-match' } });
  assert.equal(preflight.status, 204); assert.ok(preflight.headers.get('access-control-allow-headers').split(', ').includes('If-None-Match'));
  const ok = await listing(base, undefined, headers);
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN); assert.equal(ok.headers.get('access-control-expose-headers'), 'Retry-After, ETag');
  const notModified = await listing(base, undefined, { ...headers, 'if-none-match': ok.headers.get('etag') });
  assert.equal(notModified.status, 304); assert.equal(notModified.headers.get('access-control-allow-origin'), ORIGIN);
  await listing(base, undefined, headers);
  const limited = await failure(await listing(base, undefined, headers), 429, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1); assert.equal(limited.headers.get('access-control-allow-origin'), ORIGIN);
  // The listing window is separate: other comment requests from this address still pass (the preflight above counted once).
  assert.equal((await post(base, V.a, { text: '照常发送', pageUrl: PAGE }, headers)).status, 201);
  const { base: disabledBase } = await publicApp(t, { enabled: false });
  await failure(await listing(disabledBase), 404, 'comments_disabled');
});

test('owner state route: refuses browsers and bad tokens, private rows and resolving replies; values are absolute; withdrawn rows stay hidden', async t => {
  const { base } = await publicApp(t);
  const thread = await created(await post(base, V.a, root('主题')));
  const answer = await created(await post(base, V.b, reply(thread.externalId, '回复')));
  const privateRow = await created(await post(base, V.a, { text: '私密', pageUrl: PAGE }));
  await failure(await setState(base, thread.externalId, { hidden: true }, { ...owner, origin: ORIGIN }), 403, 'browser_forbidden');
  await failure(await setState(base, thread.externalId, { hidden: true }, {}), 401, 'unauthorized');
  await failure(await setState(base, 'not-a-uuid', { hidden: true }), 404, 'comment_not_found');
  await failure(await setState(base, privateRow.externalId, { hidden: true }), 409, 'not_public');
  await failure(await setState(base, answer.externalId, { resolved: true }), 400, 'invalid_input');
  for (const bad of [{}, { hidden: 'yes' }, { hidden: true, extra: 1 }, []]) await failure(await setState(base, thread.externalId, bad), 400, 'invalid_input');
  const hide = await (await setState(base, thread.externalId, { hidden: true, resolved: true })).json();
  assert.deepEqual({ ...hide.state, updatedAt: undefined }, { externalId: thread.externalId, hidden: true, resolved: true, withdrawn: false, updatedAt: undefined }); assert.equal(hide.changed, true);
  assert.equal((await (await setState(base, thread.externalId, { hidden: true, resolved: true })).json()).changed, false);
  await failure(await fetch(`${base}/_board/comments/${answer.externalId}/withdraw`, { method: 'POST', headers: { 'x-board-visitor': V.a } }), 404, 'comment_not_found');
  const withdrawn = await fetch(`${base}/_board/comments/${answer.externalId}/withdraw`, { method: 'POST', headers: { 'x-board-visitor': V.b } });
  assert.equal(withdrawn.status, 200); assert.equal((await withdrawn.json()).withdrawn, true);
  assert.equal((await fetch(`${base}/_board/comments/${answer.externalId}/withdraw`, { method: 'POST', headers: { 'x-board-visitor': V.b } })).status, 200, 'withdrawing again is idempotent');
  await failure(await setState(base, answer.externalId, { hidden: false }), 409, 'withdrawn');
  const moderation = await (await fetch(`${base}/_board/comments/public/moderation`, { headers: owner })).json();
  assert.deepEqual(moderation.threads[0].replies.map(item => [item.text, item.hidden, item.withdrawn ?? false]), [['回复', true, true]]);
  assert.equal(moderation.threads[0].hidden, true); assert.deepEqual(moderation.releases, [RELEASE]);
  await failure(await fetch(`${base}/_board/comments/public/moderation`, { headers: { ...owner, origin: ORIGIN } }), 403, 'browser_forbidden');
  await failure(await fetch(`${base}/_board/comments/public/moderation`), 401, 'unauthorized');
});

test('owner replies: a visitor reply can be answered (replyTo), and a thread holds at most 20 owner and assistant replies', async t => {
  const { base } = await publicApp(t);
  const thread = await created(await post(base, V.a, root('主题')));
  const answer = await created(await post(base, V.b, reply(thread.externalId, '访客回复')));
  for (let i = 0; i < 10; i++) assert.equal((await ownerReply(base, thread.externalId, `ir-root-reply-${i}`, { text: `r${i}` })).status, 201);
  for (let i = 0; i < 10; i++) assert.equal((await ownerReply(base, answer.externalId, `ir-reply-${i}`, { text: `a${i}`, authorKind: 'agent' })).status, 201);
  await failure(await ownerReply(base, answer.externalId, 'ir-reply-21', { text: 'too many' }), 409, 'reply_limit');
  await failure(await ownerReply(base, thread.externalId, 'ir-reply-21b', { text: 'too many' }), 409, 'reply_limit');
  const { body } = await listed(base);
  assert.equal(body.threads[0].replies.filter(item => item.replyTo === answer.externalId).length, 10);
  const privateRow = await created(await post(base, V.a, { text: '私密', pageUrl: PAGE }));
  for (let i = 0; i < 20; i++) assert.equal((await ownerReply(base, privateRow.externalId, `ir-private-${i}`, { text: `p${i}` })).status, 201);
  await failure(await ownerReply(base, privateRow.externalId, 'ir-private-21', { text: 'x' }), 409, 'reply_limit');
});

test('export: without threads=1 replies are skipped with the cursor advanced; with threads=1 public fields appear exactly where they apply', async t => {
  const { base } = await publicApp(t);
  const thread = await created(await post(base, V.a, root('主题', { authorName: '小王' })));
  const replies = [];
  for (let i = 0; i < 3; i++) replies.push(await created(await post(base, V.b, reply(thread.externalId, `回复 ${i}`))));
  const privateRow = await created(await post(base, V.c, { text: '私密', pageUrl: PAGE, anchor: { quote: '第二步', selector: '#result', releaseId: RELEASE } }));
  assert.equal((await setState(base, replies[1].externalId, { hidden: true })).status, 200);
  assert.equal((await fetch(`${base}/_board/comments/${replies[2].externalId}/withdraw`, { method: 'POST', headers: { 'x-board-visitor': V.b } })).status, 200);
  assert.equal((await setState(base, thread.externalId, { resolved: true })).status, 200);
  const v1 = await exported(base, '?cursor=0&limit=100');
  LegacyInboxPageSchema.parse(v1);
  assert.deepEqual(v1.comments.map(item => item.text), ['主题', '私密']); assert.equal(v1.nextCursor, String(5));
  const v2 = await exported(base, '?cursor=0&limit=100&format=2');
  assert.deepEqual(Object.keys(v2), ['deploymentId', 'format', 'cursor', 'nextCursor', 'comments']);
  assert.deepEqual(v2.comments.map(item => Object.keys(item).filter(key => ['visibility', 'parentId', 'publicTag', 'hidden', 'resolved', 'withdrawn'].includes(key))), [[], []], 'public roots export like private rows without threads=1');
  const onlyReplies = await exported(base, '?cursor=1&limit=3&format=2');
  assert.deepEqual(onlyReplies.comments, []); assert.equal(onlyReplies.nextCursor, '4', 'a page made of replies is empty with an advanced cursor');
  const threads = await exported(base, '?cursor=0&limit=100&format=2&threads=1');
  assert.equal(threads.threads, 1);
  const pick = item => Object.fromEntries(Object.entries(item).filter(([key]) => ['visibility', 'parentId', 'publicTag', 'hidden', 'resolved', 'withdrawn'].includes(key)));
  assert.deepEqual(threads.comments.map(pick), [
    { visibility: 'public', publicTag: thread.tag, resolved: true },
    { visibility: 'public', parentId: thread.externalId, publicTag: replies[0].tag },
    { visibility: 'public', parentId: thread.externalId, publicTag: replies[1].tag, hidden: true },
    { visibility: 'public', parentId: thread.externalId, publicTag: replies[2].tag, hidden: true, withdrawn: true },
    {},
  ]);
  assert.equal(threads.comments[4].externalId, privateRow.externalId);
  assert.equal(JSON.stringify(threads).includes('public_tag_key'), false);
  // mine: the caller's own private comments and public thread roots (marked), never others' replies or withdrawn rows.
  const mine = await (await fetch(`${base}/_board/comments/mine?page=${encodeURIComponent(PAGE)}`, { headers: { 'x-board-visitor': V.a } })).json();
  assert.deepEqual(mine.threads.map(item => [item.text, item.visibility ?? 'private']), [['主题', 'public']]);
  const mineB = await (await fetch(`${base}/_board/comments/mine`, { headers: { 'x-board-visitor': V.b } })).json();
  assert.deepEqual(mineB.threads, [], 'visitor replies are not threads of their own');
});

test('page tags: an HMAC per page that the listing, the 201 body and the export agree on; different on another page; the key never leaves', async t => {
  const { base, server, directory, app, cleanup } = await publicApp(t);
  const here1 = await created(await post(base, V.a, root('这里')));
  const there = await created(await post(base, V.a, root('那里', { pageUrl: OTHER_PAGE })));
  assert.notEqual(here1.tag, there.tag, 'one visitor cannot be linked across pages by the tag');
  assert.notEqual(here1.tag, digest(`tag\0${visitorHash(V.a)}`).slice(0, 12), 'the page tag is not the inbox visitor tag');
  assert.equal((await listed(base)).body.threads[0].tag, here1.tag);
  const key = server.db.prepare("SELECT value FROM _board_runtime_meta WHERE key='public_tag_key'").get().value;
  for (const text of [JSON.stringify(await (await fetch(`${base}/_board/health`)).json()), JSON.stringify(await exported(base, '?cursor=0&format=2&threads=1')), JSON.stringify((await listed(base)).body)]) assert.equal(text.includes(key), false);
  const { backup, restore } = await import('./storage.mjs');
  const saved = await backup(app, path.join(directory, 'tags.sqlite'));
  await server.close();
  await restore(app, saved.file, saved.sha256);
  const restored = await startApp(app); cleanup.push(restored.close);
  const again = await created(await post(`http://127.0.0.1:${restored.port}`, V.a, root('恢复后')));
  assert.equal(again.tag, here1.tag, 'backup and restore keep the tag key');
});

test('spam flood: 250 public posts from one visitor, then pause and hide the visitor in two owner calls; the listing drops them at once', async t => {
  const { base, server } = await publicApp(t, { limits: { ...RELAXED, publicRootsPerVisitorPageDay: 100, publicPostsPerPageDay: 1000, postPerPageDay: 5000 } });
  const real = await created(await post(base, V.a, root('真正的讨论')));
  // 40 arrive over HTTP (the per-visitor minute allows 50); 210 more were accepted earlier the same way.
  let spam;
  for (let i = 0; i < 40; i++) spam = await created(await post(base, V.d, root(`广告 ${i}`), many(i).headers));
  const template = server.db.prepare('SELECT * FROM _board_comments WHERE external_id = ?').get(spam.externalId);
  const insert = server.db.prepare('INSERT INTO _board_comments (external_id,intent_key,payload_hash,text,author_name,page_url,anchor_json,created_at,visitor_hash,page_key,visibility,parent_seq,public_tag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (let i = 40; i < 250; i++) insert.run(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `spam-${i}`, 'x', `广告 ${i}`, null, template.page_url, template.anchor_json, new Date().toISOString(), template.visitor_hash, template.page_key, 'public', null, template.public_tag);
  server.db.prepare('UPDATE _board_comment_pages SET version = version + 1 WHERE page_key = ?').run(PAGE);
  const before = (await listed(base)).body;
  assert.equal(before.total, 251); assert.equal(before.threads.length, 100);
  const paused = await ownerPost(base, 'pause', { page: PAGE, paused: true }); assert.equal(paused.status, 200);
  const hidden = await (await ownerPost(base, 'hide-visitor', { page: PAGE, tag: spam.tag })).json();
  assert.equal(hidden.changed, 250);
  const after = (await listed(base)).body;
  assert.deepEqual(after.threads.map(item => item.id), [real.externalId]); assert.equal(after.paused, true);
  await failure(await post(base, V.d, root('还想发')), 403, 'public_paused');
  const unhide = await (await ownerPost(base, 'hide-visitor', { page: PAGE, tag: spam.tag, hidden: false })).json();
  assert.equal(unhide.changed, 250);
  await failure(await ownerPost(base, 'hide-visitor', { page: PAGE, tag: 'XYZ' }), 400, 'invalid_input');
  await failure(await fetch(`${base}/_board/comments/public/pause`, { method: 'POST', headers: { 'content-type': 'application/json', ...owner, origin: ORIGIN }, body: '{"page":"x","paused":true}' }), 403, 'browser_forbidden');
});

// ---------------------------------------------------------------------------
// Migration from the installed 77ca22a runtime, with its own code.

async function oldRuntime(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'board-old-runtime-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).trim();
  for (const name of ['cli.mjs', 'files.mjs', 'storage.mjs', 'comments.mjs', 'live.mjs', 'server.mjs', 'scaffold.mjs', 'ssh.mjs', 'remote.mjs', 'visitor.mjs'])
    await fs.writeFile(path.join(directory, name), execFileSync('git', ['show', `77ca22a:plugins/paseo-board/backend/${name}`], { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  return { server: await import(pathToFileURL(path.join(directory, 'server.mjs')).href), files: await import(pathToFileURL(path.join(directory, 'files.mjs')).href) };
}

test('migration: a schema-2 database written by the 77ca22a runtime becomes schema 3 with identical rows, bytes, exports and mine; the old runtime then refuses it', async t => {
  setToken(t);
  const old = await oldRuntime(t);
  const { app, root: appRoot } = await makeApp(t, { limits: { postPerIpMinute: 100, postPerVisitorMinute: 50 } });
  const config = JSON.parse(await fs.readFile(path.join(appRoot, 'board-app.json'), 'utf8'));
  const { listPerIpMinute: _a, visitorRepliesPerThread: _b, publicPostsGlobalHour: _c, publicRootsPerVisitorPageDay: _d, ...oldLimits } = config.comments.limits;
  await fs.writeFile(path.join(appRoot, 'board-app.json'), JSON.stringify({ ...config, comments: { enabled: true, limits: oldLimits } }));
  let server = await old.server.startApp(await old.files.loadApp(appRoot)), base = `http://127.0.0.1:${server.port}`;
  const ids = [];
  for (const [secret, body] of [[V.a, { text: '旧评论一', authorName: '小王', pageUrl: PAGE, anchor: { selector: '#result', quote: '第二步', releaseId: RELEASE } }], [V.b, { text: '旧评论二', pageUrl: PAGE }], [null, { text: '没有访客' }]]) {
    const response = await post(base, secret, body); assert.equal(response.status, 201); ids.push((await response.json()).comment.externalId);
  }
  for (const [index, id] of ids.slice(0, 2).entries()) assert.equal((await ownerReply(base, id, `ir-old-${index}`, { text: `回复 ${index}`, authorKind: index ? 'agent' : 'owner' })).status, 201);
  const snapshot = async target => ({ v1: await exported(target, '?cursor=0&limit=100'), v2: await exported(target, '?cursor=0&limit=100&format=2'), mineA: await (await fetch(`${target}/_board/comments/mine`, { headers: { 'x-board-visitor': V.a } })).json(), mineB: await (await fetch(`${target}/_board/comments/mine?page=${encodeURIComponent(PAGE)}`, { headers: { 'x-board-visitor': V.b } })).json() });
  const beforeData = await snapshot(base);
  const bytesBefore = server.db.prepare("SELECT value FROM _board_runtime_meta WHERE key='comments_bytes'").get().value;
  assert.equal(server.db.prepare("SELECT value FROM _board_runtime_meta WHERE key='comments_schema'").get().value, '2');
  await server.close();
  await fs.writeFile(path.join(appRoot, 'board-app.json'), JSON.stringify({ ...config, comments: { enabled: true, limits: config.comments.limits } }));
  server = await startApp(await loadApp(appRoot)); base = `http://127.0.0.1:${server.port}`;
  const meta = key => server.db.prepare('SELECT value FROM _board_runtime_meta WHERE key = ?').get(key)?.value;
  assert.equal(meta('comments_schema'), '3'); assert.equal(meta('comments_bytes'), bytesBefore);
  assert.equal(server.db.prepare('SELECT count(*) AS n FROM _board_comments').get().n, 3); assert.equal(server.db.prepare('SELECT count(*) AS n FROM _board_comment_replies').get().n, 2);
  assert.deepEqual(server.db.prepare('SELECT visibility, parent_seq, hidden, resolved FROM _board_comments').all().map(row => ({ ...row })), new Array(3).fill({ visibility: null, parent_seq: null, hidden: 0, resolved: 0 }));
  const afterData = await snapshot(base);
  assert.deepEqual(afterData, beforeData, 'exports and mine are identical after the upgrade');
  const health = await (await fetch(`${base}/_board/health`)).json(); assert.equal(health.comments, 2); assert.equal(health.publicThreads, 1);
  assert.equal((await register(base, RELEASE)).status, 200);
  assert.deepEqual((await listed(base)).body.threads, [], 'existing private rows never become public');
  assert.deepEqual((await exported(base, '?cursor=0&limit=100&format=2&threads=1')).comments, beforeData.v2.comments, 'threads=1 adds no keys to pre-upgrade rows');
  await server.close();
  await assert.rejects(old.server.startApp(await old.files.loadApp(appRoot)), /upgraded by a newer Board runtime/);
  void app;
});

test('a schema-3 database from an earlier build of this runtime gains the page close column at the next start, keeping its data', async t => {
  const { base, server, restart } = await publicApp(t);
  const thread = await created(await post(base, V.a, root('早期版本写入的讨论')));
  server.db.exec('ALTER TABLE _board_comment_pages DROP COLUMN closed');
  const next = await restart();
  assert.ok(next.server.db.prepare("SELECT name FROM pragma_table_info('_board_comment_pages')").all().some(row => row.name === 'closed'));
  assert.equal(next.server.db.prepare("SELECT value FROM _board_runtime_meta WHERE key='comments_schema'").get().value, '3');
  assert.deepEqual((await listed(next.base)).body.threads.map(item => item.id), [thread.externalId]);
});

// Opt-in: verify a read-only copy of a real backend database (prepared with `sqlite3 -readonly <db> "VACUUM INTO '<copy>'"`).
test('opt-in: a copied real database migrates to schema 3 without losing rows or bytes', { skip: !process.env.BOARD_PUBLIC_THREADS_COPY }, async t => {
  setToken(t);
  const copy = process.env.BOARD_PUBLIC_THREADS_COPY;
  const { app, cleanup } = await makeApp(t);
  await fs.mkdir(app.dataDir, { recursive: true });
  await fs.copyFile(copy, app.database);
  const before = new DatabaseSync(app.database, { readOnly: true });
  const counts = { comments: before.prepare('SELECT count(*) AS n FROM _board_comments').get().n, replies: before.prepare('SELECT count(*) AS n FROM _board_comment_replies').get().n, bytes: before.prepare("SELECT value FROM _board_runtime_meta WHERE key='comments_bytes'").get().value, ack: before.prepare("SELECT value FROM _board_runtime_meta WHERE key='export_ack'").get().value };
  const pages = before.prepare('SELECT DISTINCT page_key FROM _board_comments WHERE page_key IS NOT NULL').all().map(row => row.page_key);
  before.close();
  const server = await startApp(app); cleanup.push(server.close);
  const base = `http://127.0.0.1:${server.port}`;
  const meta = key => server.db.prepare('SELECT value FROM _board_runtime_meta WHERE key = ?').get(key)?.value;
  assert.equal(meta('comments_schema'), '3');
  assert.deepEqual({ comments: server.db.prepare('SELECT count(*) AS n FROM _board_comments').get().n, replies: server.db.prepare('SELECT count(*) AS n FROM _board_comment_replies').get().n, bytes: meta('comments_bytes'), ack: meta('export_ack') }, counts);
  assert.equal((await (await fetch(`${base}/_board/health`)).json()).publicThreads, 1);
  assert.equal((await register(base, RELEASE)).status, 200);
  for (const page of pages) { const response = await listing(base, `?page=${encodeURIComponent(page)}&release=${RELEASE}`); assert.equal(response.status, 200); assert.deepEqual((await response.json()).threads, []); }
  console.log(`MEASURE copied-database ${JSON.stringify({ ...counts, pages: pages.length })}`);
});
