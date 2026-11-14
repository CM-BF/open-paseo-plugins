import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { appKeyFor, createFakeCommentsBackend } from './comments-fake-backend.mjs';

// Public comment threads (viewer 5) in the real exported viewer, driven by trusted Chromium input
// (public-threads DESIGN §9.4 as amended by §12). The backend is the loopback fake of the page <-> backend contract.
const sha256 = value => createHash('sha256').update(value).digest('hex');
const SECRETS = { a: 'a'.repeat(64), b: 'b'.repeat(64), c: 'c'.repeat(64), d: 'd'.repeat(64) };

export async function createPublicFixture({ buildRelease, options, origin }) {
  const owner = 'public-owner', appKey = appKeyFor(owner);
  const backend = await createFakeCommentsBackend({ allowedOrigins: [origin], owner, appId: 'public-a' });
  const page = (lead, live = false, many = 0) => `<style>body{margin:0;font:17px/1.7 Georgia,"Songti SC",serif;color:#1d1d1f;background:#fff}main{padding:24px 32px;max-width:900px}#fixed{position:sticky;top:0;background:#203040;color:#fff;padding:6px 32px;z-index:5}.vw{width:100vw;height:4px;background:#ccc}#scroller{height:120px;overflow:auto;border:1px solid #bbb;padding:8px;margin:16px 0}#scroller .tall{height:420px}.spacer{height:1600px}.far{margin-top:40px}</style>
<div id="fixed">固定标题栏</div>
<main>
<div class="vw" id="vw"></div>
<h1 id="title">公开讨论演示</h1>
<p id="lead">${lead}</p>
<p id="second">第二段落用来测试对齐，这里有足够多的文字让卡片在右侧排列。</p>
<div id="scroller"><p id="nested">滚动区域里的说明文字在这里。</p><div class="tall"></div></div>
<p><a id="link" href="#title">回到标题的链接文字</a></p>
${live ? '<p id="clock">0</p>' : ''}
${Array.from({ length: many }, (_, i) => `<p id="p${i}">段落 ${i} 的内容文字，供大量评论定位使用。</p>`).join('')}
<div class="spacer"></div>
<p id="far" class="far">页面很靠后的一段文字，用来测试远处的评论。</p>
<div style="height:600px"></div>
</main>
<script>window.publicFrameMessages=[];window.addEventListener('message',event=>publicFrameMessages.push(event.data));${live ? "let n=0;setInterval(()=>{document.querySelector('#clock').textContent=String(++n)},50);" : ''}window.ready=true;</script>`;
  const source = html => ({ ...options.board, canvas: { ...options.board.canvas, html, patches: [], data: {} } });
  const comments = { apiBase: backend.apiBase, appKey, visibility: 'public' };
  const release = buildRelease({ ...options, board: source(page('首先，第二步的意思是先保存，然后第三步再提交，最后第四步检查结果。')), publicData: {}, apiOrigins: [], comments });
  const changed = buildRelease({ ...options, board: source(page('这一段已经改写，不再包含原来的引用。')), publicData: {}, apiOrigins: [], comments });
  const heavy = buildRelease({ ...options, board: source(page('首先，第二步的意思是先保存。', true, 200)), publicData: {}, apiOrigins: [], comments });
  // 30 short paragraphs with two threads each: more cards than the page can hold next to their passages.
  const crowded = buildRelease({ ...options, board: source(page('首先，第二步的意思是先保存。', false, 30)), publicData: {}, apiOrigins: [], comments });
  return { backend, appKey, release, changed, heavy, crowded, close: () => backend.close() };
}

/** Seeds through the real HTTP contract, as visitors would. */
async function seed(backend, pageUrl, releaseId, secret, body, key) {
  const response = await fetch(backend.apiBase + '/_board/comments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key ?? `seed-${sha256(JSON.stringify(body) + secret).slice(0, 24)}`, 'x-board-visitor': secret }, body: JSON.stringify({ pageUrl, visibility: 'public', ...body, anchor: { ...(body.anchor ?? {}), releaseId } }) });
  if (response.status !== 201 && response.status !== 200) throw new Error(`seed failed ${response.status} ${await response.text()}`);
  return (await response.json()).comment;
}

export async function runPublicChecks({ assert, command, frameCommand, evaluate, frame, open, reload, origin, files, publicThreads: fixture, check, contextWhere, shots }) {
  const { backend, release } = fixture;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (read, label, ms = 8000) => {
    const deadline = Date.now() + ms;
    for (;;) { const value = await read().catch(() => undefined); if (value) return value; if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`); await sleep(40); }
  };
  const pagePath = '/public/', pageUrl = origin + pagePath, releaseId = release.manifest.releaseId;
  files.set(pagePath, release.files['index.html']);
  const viewport = (width, height, mobile = false) => command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  const listings = () => backend.requests.filter(request => request.method === 'GET' && request.path.endsWith('/_board/comments/public'));
  const ui = () => evaluate(`(()=>{const q=s=>document.querySelector('[data-pbc='+s+']'),shown=n=>Boolean(n)&&!n.hidden&&n.isConnected;const rail=q('rail');return{mode:rail&&rail.getAttribute('data-mode'),rail:shown(rail),toggle:shown(q('toggle'))?q('toggle').textContent:null,iframe:document.querySelector('iframe').getBoundingClientRect().width,cards:Array.from(document.querySelectorAll('[data-pbc=card]')).filter(n=>n.isConnected&&n.offsetParent).map(n=>{const r=n.getBoundingClientRect();return{id:n.getAttribute('data-thread'),top:Math.round(r.top),bottom:Math.round(r.bottom),active:n.hasAttribute('data-active'),hover:n.hasAttribute('data-hover'),text:n.textContent}}),status:shown(q('problem'))?q('problem').textContent:null,head:rail?rail.querySelector('.pbc-head').textContent:null,focus:document.activeElement&&(document.activeElement.getAttribute('data-pbc')||document.activeElement.tagName)}})()`);
  const passage = (selector, text) => frame(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode()){const i=node.data.indexOf(${JSON.stringify(text)});if(i>=0){const r=document.createRange();r.setStart(node,i);r.setEnd(node,i+${text.length});const b=r.getBoundingClientRect();return{top:b.top,left:b.left,right:b.right,bottom:b.bottom,x:b.left+Math.min(4,b.width/2),y:(b.top+b.bottom)/2}}}throw new Error('text not found')})()`);
  const anchorFor = async (selector, text) => frame(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),i=el.textContent.indexOf(${JSON.stringify(text)});return{selector:${JSON.stringify(selector)},quote:${JSON.stringify(text)},start:i,end:i+${text.length}}})()`);
  const mouse = async (x, y, type = 'click') => {
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    if (type === 'move') return;
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  // Cards slide for 150 ms after an activation or a filter change: click only once the target stopped moving.
  const boxOf = selector => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||!n.isConnected||n.hidden)return null;const r=n.getBoundingClientRect();if(!r.width)return null;return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  const clickOuter = async selector => {
    const box = await until(async () => { const first = await boxOf(selector); if (!first) return null; await sleep(60); const second = await boxOf(selector); return second && second.x === first.x && second.y === first.y ? second : null; }, selector);
    await mouse(box.x, box.y);
  };
  const key = async (key, code, keyCode, modifiers = 0) => { await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers }); await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers }); };
  const typeText = async text => { for (const char of text) await command('Input.dispatchKeyEvent', { type: 'char', text: char }); };
  // PBC_SHOTS_DIR=<dir> saves screenshots of the main states (for manual review).
  const shot = async name => { if (!process.env.PBC_SHOTS_DIR) return; await mkdir(process.env.PBC_SHOTS_DIR, { recursive: true }); const { data } = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(`${process.env.PBC_SHOTS_DIR}/${name}.png`, Buffer.from(data, 'base64')); };
  const frameHighlights = () => frame(`(()=>{if(!window.CSS||!CSS.highlights)return null;const out={};for(const [name,h] of CSS.highlights)out[name]=h.size;return out})()`);

  // Seed: three passages in one paragraph and one far below; visitor A, B; a reply; owner and assistant replies.
  await viewport(1280, 800);
  await open(pagePath);
  const anchors = { two: await anchorFor('#lead', '第二步'), three: await anchorFor('#lead', '第三步'), four: await anchorFor('#lead', '第四步'), far: await anchorFor('#far', '很靠后的一段文字') };
  const t1 = await seed(backend, pageUrl, releaseId, SECRETS.a, { text: '第二步看不懂，能解释一下吗？', authorName: '小王', anchor: anchors.two });
  const t2 = await seed(backend, pageUrl, releaseId, SECRETS.b, { text: '第三步写得很好', anchor: anchors.three });
  const t3 = await seed(backend, pageUrl, releaseId, SECRETS.c, { text: '<img src=x onerror=alert(1)> 名字里有‮evil‬', anchor: anchors.four, authorName: 'A‮bc' }).catch(() => null);
  const t3b = t3 ?? await seed(backend, pageUrl, releaseId, SECRETS.c, { text: '<img src=x onerror=alert(1)> 文本里有‮evil‬', anchor: anchors.four });
  const t4 = await seed(backend, pageUrl, releaseId, SECRETS.d, { text: '最后一段的评论', anchor: anchors.far });
  const r1 = await seed(backend, pageUrl, releaseId, SECRETS.b, { text: '我也看不懂', parentId: t1.externalId, anchor: {} });
  backend.publicReply(r1.externalId, '第二步是指先保存草稿。', 'agent');
  backend.publicReply(t1.externalId, '已改写这一段。', 'owner');
  assert.equal(t3, null, 'The fake refuses a public name with a bidi control, as the backend does');

  // 1–2. Viewer 5; one listing request at load; a focus poll after 3 s sends If-None-Match and gets 304.
  assert.equal(release.manifest.viewerVersion, 5);
  backend.requests.length = 0;
  await open(pagePath);
  await until(async () => (await ui()).cards.length >= 4, 'four cards');
  await sleep(300);
  assert.equal(listings().length, 1, 'exactly one listing request at load');
  assert.deepEqual(backend.requests.filter(request => request.method !== 'OPTIONS').map(request => request.method + ' ' + request.path), ['GET /_board/comments/public'], 'no health, POST or mine on load');
  const firstCards = await evaluate("Array.from(document.querySelectorAll('[data-pbc=card]')).map(n=>n.getAttribute('data-thread')).join(',')");
  await sleep(3100); await evaluate("window.dispatchEvent(new Event('focus'))");
  await until(async () => listings().length === 2, 'the focus poll');
  assert.match(listings()[1].headers['if-none-match'] ?? '', /^"p1\.fake\.\d+"$/);
  await sleep(300);
  assert.equal(await evaluate("Array.from(document.querySelectorAll('[data-pbc=card]')).map(n=>n.getAttribute('data-thread')).join(',')"), firstCards);
  check('public page: viewer 5 makes one listing request at load (no health, POST or mine), and a later poll sends If-None-Match and keeps the cards on 304');

  // 3. Docked at 1280 × 800: the canvas narrows to 944 px, a 100vw element inside follows, the rail is beside it.
  let state = await ui();
  assert.equal(state.mode, 'docked'); assert.equal(state.rail, true); assert.equal(state.iframe, 944); assert.equal(state.toggle, null);
  assert.ok(await frame("document.querySelector('#vw').getBoundingClientRect().width<=944"));
  await shot('rail-1280');
  check('docked at 1280 × 800: the canvas is 944 px wide, a 100vw element stays inside it, and the rail sits beside it');

  // 4. Alignment: cards do not overlap, follow passage order, and the first card sits at its passage.
  state = await ui();
  const ordered = state.cards.slice().sort((a, b) => a.top - b.top);
  for (let i = 1; i < ordered.length; i++) assert.ok(ordered[i - 1].bottom + 8 <= ordered[i].top + 1, JSON.stringify(ordered));
  const two = await passage('#lead', '第二步'), cardTwo = state.cards.find(card => card.id === t1.externalId);
  assert.ok(Math.abs(cardTwo.top - (two.top - 4)) <= 8, JSON.stringify({ card: cardTwo.top, passage: two.top }));
  assert.deepEqual(ordered.map(card => card.id).slice(0, 3), [t1.externalId, t2.externalId, t3b.externalId], 'cards follow the passage order');
  check('alignment: cards follow their passages in order without overlapping, and the first card sits at its passage');

  // 5. Highlights are CSS highlights painted by the frame; hovering a card emphasises its passage and the reverse.
  const painted = await frameHighlights();
  assert.ok(painted && painted['pbc-open'] >= 3, JSON.stringify(painted));
  const three = await passage('#lead', '第三步');
  await mouse(three.x, three.y, 'move');
  await until(async () => (await ui()).cards.find(card => card.id === t2.externalId)?.hover, 'card hover from the highlight');
  await mouse(three.x, three.y);
  await until(async () => (await ui()).cards.find(card => card.id === t2.externalId)?.active, 'the third card to become active');
  assert.equal(await frame("document.hasFocus()"), true, 'clicking a highlight keeps focus in the page');
  assert.ok((await frameHighlights())['pbc-active'] >= 1);
  await sleep(250); await shot('rail-1280-active');
  check('highlights: CSS highlights cover each passage; hovering a passage marks its card, clicking it activates the card without moving focus out of the page');
  await sleep(250);
  state = await ui();
  const settled = state.cards.slice().sort((a, b) => a.top - b.top);
  for (let i = 1; i < settled.length; i++) assert.ok(settled[i - 1].bottom + 8 <= settled[i].top + 1, JSON.stringify(settled));
  assert.ok(Math.abs(state.cards.find(card => card.id === t2.externalId).top - (three.top - 4)) <= 8, 'the active card sits at its passage; earlier cards moved up');

  // 6. Rendering: owner and assistant badges, replyTo, literal markup and visible bidi markers.
  await clickOuter(`[data-pbc=card][data-thread="${t1.externalId}"] .pbc-text`);
  await until(async () => (await ui()).cards.find(card => card.id === t1.externalId)?.active, 'the first card to become active');
  const t1Text = (await ui()).cards.find(card => card.id === t1.externalId).text;
  for (const text of ['小王 · 访客·', '我也看不懂', '作者的 AI 助手', '回复 访客·', '第二步是指先保存草稿。', '作者', '已改写这一段。']) assert.ok(t1Text.includes(text), text + ' in ' + t1Text);
  const t3Card = (await ui()).cards.find(card => card.id === t3b.externalId).text;
  assert.ok(t3Card.includes('<img src=x onerror=alert(1)>') && t3Card.includes('[U+202E]evil[U+202C]'), t3Card);
  assert.equal(await evaluate("document.querySelectorAll('[data-pbc=rail] img,[data-pbc=rail] script').length"), 0);
  assert.equal(await evaluate("[...document.querySelectorAll('[data-pbc=card] .pbc-chip')].filter(n=>n.dataset.kind==='agent').map(n=>getComputedStyle(n).backgroundColor)[0]"), 'rgb(91, 60, 196)');
  check('cards: the author and the author\'s AI assistant have distinct badges, replies name whom they answer, and visitor markup and bidi controls render literally');

  // 7. A visitor reply: exact POST, an immediate poll, 「我」, and the draft survives a refused send.
  const before = backend.requests.length;
  await clickOuter(`[data-pbc=card][data-thread="${t1.externalId}"] [data-pbc=reply-open]`);
  await until(() => evaluate("document.activeElement&&document.activeElement.getAttribute('aria-label')==='回复这条讨论'"), 'the reply box to take focus');
  await typeText('补充一个问题');
  assert.equal(await evaluate("document.querySelector('[data-pbc=reply-box] .pbc-small').textContent"), '显示为：匿名访客（发送后显示编号）');
  await key('Enter', 'Enter', 13, 4);
  await until(async () => (await ui()).cards.find(card => card.id === t1.externalId)?.text.includes('补充一个问题'), 'the reply in the card');
  const replyPost = backend.requests.slice(before).find(request => request.method === 'POST' && request.path.endsWith('/_board/comments'));
  assert.deepEqual(JSON.parse(replyPost.body), { text: '补充一个问题', pageUrl, anchor: { releaseId }, visibility: 'public', parentId: t1.externalId });
  assert.match(replyPost.headers['idempotency-key'], /^pr-[\da-f-]{36}$/); assert.match(replyPost.headers['x-board-visitor'], /^[a-f0-9]{64}$/);
  await until(() => Promise.resolve(backend.requests.slice(before).some(request => request.method === 'GET' && request.path.endsWith('/public') && request.at > replyPost.at)), 'an immediate poll after the reply');
  await until(async () => (await ui()).cards.find(card => card.id === t1.externalId)?.text.includes('我'), '「我」 on the own reply');
  const stored = await evaluate(`({visitor:localStorage.getItem(${JSON.stringify('paseo-board-visitor:v2:' + fixture.appKey)}),public:localStorage.getItem(${JSON.stringify('paseo-board-public:v1:' + fixture.appKey)}),keys:Object.keys(localStorage)})`);
  assert.match(JSON.parse(stored.visitor).secret, /^[a-f0-9]{64}$/); assert.match(JSON.parse(stored.public).tags[Object.keys(JSON.parse(stored.public).tags)[0]], /^[a-f0-9]{12}$/);
  for (const value of [stored.visitor, stored.public]) for (const text of ['补充一个问题', '第二步看不懂']) assert.equal(value.includes(text), false, 'localStorage holds no comment text');
  for (const name of stored.keys) assert.match(name, /^paseo-board-(visitor:v2|public:v1):|^paseo-board-comments-(hint|rail):v1$|^paseo-board-release:/, name);
  // The thread is resolved before the next poll: the reply is refused with the exact text and the draft is kept.
  await clickOuter(`[data-pbc=card][data-thread="${t1.externalId}"] [data-pbc=reply-open]`);
  await until(() => evaluate("document.activeElement&&document.activeElement.getAttribute('aria-label')==='回复这条讨论'"), 'the reply box again');
  await typeText('还有一个');
  backend.publicState(t1.externalId, { resolved: true });
  await key('Enter', 'Enter', 13, 4);
  await until(() => evaluate("document.body.textContent.includes('作者已把这条讨论标为已解决，不能再回复。')"), 'the thread_resolved text');
  assert.equal(await evaluate(`JSON.parse(sessionStorage.getItem(${JSON.stringify('paseo-board-comments:p1:' + fixture.appKey + ':' + pageUrl)})).drafts['r:${t1.externalId}']`), '还有一个');
  backend.publicState(t1.externalId, { resolved: false });
  check('replies: the POST carries visibility, parentId and only the release in its anchor with a pr- key; a poll follows at once; 「我」 marks the own reply; localStorage keeps no text; a refused reply keeps its draft');

  // 8. Filter: resolved threads leave the rail and the highlights under 未解决, and come back collapsed under 全部.
  backend.publicState(t4.externalId, { resolved: true });
  await open(pagePath);
  await until(async () => (await ui()).cards.length === 3, 'three unresolved cards');
  assert.ok((await ui()).head.includes('未解决 3') && (await ui()).head.includes('全部 4'));
  await sleep(200);
  assert.deepEqual(await frameHighlights().then(h => [h['pbc-open'], h['pbc-resolved']]), [3, 0]);
  await clickOuter('[data-pbc=filter-all]');
  await until(async () => (await ui()).cards.length === 4, 'four cards under 全部');
  const resolvedCard = (await ui()).cards.find(card => card.id === t4.externalId);
  assert.ok(resolvedCard.text.startsWith('已解决') || resolvedCard.text.includes('已解决'), resolvedCard.text);
  // The far passage is below the fold: scroll the page and its card follows.
  await frame("document.querySelector('#far').scrollIntoView({block:'center'}),true");
  await until(async () => { const card = (await ui()).cards.find(item => item.id === t4.externalId); return card && card.top > 0 && card.bottom < 800; }, 'the far card to scroll into view with its passage');
  const far = await passage('#far', '很靠后的一段文字'), farCard = (await ui()).cards.find(card => card.id === t4.externalId);
  assert.ok(Math.abs(farCard.top - (far.top - 4)) <= 8, JSON.stringify({ card: farCard.top, passage: far.top }));
  await clickOuter(`[data-pbc=card][data-thread="${t4.externalId}"]`);
  await until(async () => (await ui()).cards.find(card => card.id === t4.externalId)?.active, 'the resolved card to open');
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-pbc=card][data-thread="${t4.externalId}"] [data-pbc=reply-open]'))`), false);
  assert.ok((await ui()).cards.find(card => card.id === t4.externalId).text.includes('作者已把这条讨论标为已解决。'));
  await sleep(200);
  assert.equal((await frameHighlights())['pbc-resolved'], 1);
  await clickOuter('[data-pbc=filter-open]');
  check('filter: 未解决 hides resolved threads and their highlights; 全部 shows them collapsed and read-only');

  // 9. A new public comment from a selection: composer, the public note, identity line, exact POST, the card opens with 「我」.
  await frame("scrollTo(0,0),true"); await sleep(200);
  await frame("(()=>{const el=document.querySelector('#second'),node=el.firstChild,i=node.data.indexOf('测试对齐');getSelection().setBaseAndExtent(node,i,node,i+4);return true})()");
  const selected = await passage('#second', '测试对齐');
  await mouse(selected.x + 10, selected.y, 'move');
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: selected.x + 10, y: selected.y, button: 'right', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: selected.x + 10, y: selected.y, button: 'right', clickCount: 1 });
  await until(() => evaluate("Boolean(document.querySelector('[data-pbc=composer]'))"), 'the composer');
  const composerText = await evaluate("document.querySelector('[data-pbc=composer]').textContent");
  assert.ok(composerText.includes('公开评论：打开这个页面的人都能看到你的评论和称呼（不填称呼时显示匿名编号）。发送后可以撤回，但已经看到的人可能保留了副本。作者和作者的 AI 助手也会收到。'), composerText);
  assert.equal(await evaluate("document.querySelector('[data-pbc=composer] input').value"), '', 'the public name starts empty');
  await typeText('对齐的说明可以更具体一些');
  await evaluate("(()=>{const i=document.querySelector('[data-pbc=composer] input');i.focus();return true})()");
  await typeText('读者甲');
  await until(async () => (await evaluate("document.querySelector('[data-pbc=identity]').textContent")).startsWith('将公开显示为：读者甲 · 访客·'), 'the identity line');
  const postsBefore = backend.requests.length;
  await key('Enter', 'Enter', 13, 4);
  await until(() => evaluate("!document.querySelector('[data-pbc=composer]')"), 'the composer to close after sending');
  const rootPost = backend.requests.slice(postsBefore).find(request => request.method === 'POST' && request.path.endsWith('/_board/comments'));
  const rootBody = JSON.parse(rootPost.body);
  assert.deepEqual({ ...rootBody, anchor: undefined }, { text: '对齐的说明可以更具体一些', authorName: '读者甲', pageUrl, visibility: 'public', anchor: undefined });
  assert.deepEqual([rootBody.anchor.selector, rootBody.anchor.quote, rootBody.anchor.releaseId], ['#second', '测试对齐', releaseId]); assert.match(rootPost.headers['idempotency-key'], /^pc-/);
  const created = backend.publicRows().find(row => row.text === '对齐的说明可以更具体一些');
  await until(async () => { const card = (await ui()).cards.find(item => item.id === created.externalId); return card?.active && card.text.includes('我') && card.text.includes('读者甲 · 访客·'); }, 'the new card to be active with 我');
  check('new public comment: the composer explains that it is public and can be withdrawn, shows how the name will appear, posts visibility public with the release, and opens the card marked 我');

  // 10. Withdrawal of an own comment.
  await clickOuter(`[data-pbc=card][data-thread="${created.externalId}"] [data-pbc=withdraw]`);
  await until(() => evaluate("document.body.textContent.includes('撤回后，其他人不会再看到这条评论；已经看到的人可能保留了副本。确定撤回？')"), 'the withdraw confirmation');
  await clickOuter(`[data-pbc=card][data-thread="${created.externalId}"] [data-pbc=withdraw-confirm]`);
  await until(async () => !(await ui()).cards.some(card => card.id === created.externalId), 'the withdrawn card to disappear');
  assert.equal(backend.publicRows().find(row => row.externalId === created.externalId).withdrawn, true);
  check('withdraw: 撤回 asks first, then the backend hides the visitor\'s own comment and the card disappears');

  // 11. Privacy: the frame never receives comment text, names, tags or the secret.
  const secret = JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify('paseo-board-visitor:v2:' + fixture.appKey)})`)).secret;
  const frameSeen = await frame("JSON.stringify(window.publicFrameMessages||[])");
  for (const text of ['第二步看不懂', '小王', '补充一个问题', secret, '作者的 AI 助手']) assert.equal(frameSeen.includes(text), false, text);
  assert.ok(frameSeen.includes('comment-highlights'), 'the probe saw the highlight messages');
  check('privacy: the canvas frame receives anchors and thread IDs only, never comment text, names or the visitor secret');

  // 12. Orphans: the page changed; threads whose passage is gone are listed under 原文已修改 and can still be replied to.
  files.set('/public-changed/', fixture.changed.files['index.html']);
  const changedUrl = origin + '/public-changed/';
  for (const row of backend.publicRows().filter(item => item.pageKey === pageUrl && !item.parentId && !item.hidden)) await seed(backend, changedUrl, fixture.changed.manifest.releaseId, SECRETS.a, { text: row.text.slice(0, 40), anchor: row.anchor ? { selector: row.anchor.selector, quote: row.anchor.quote } : { quote: 'x' } }, `orphan-${row.externalId}`);
  await open('/public-changed/');
  await until(async () => (await evaluate("document.querySelector('[data-pbc=orphans-toggle]')?.textContent||''")).startsWith('原文已修改（'), 'the orphan section');
  await clickOuter('[data-pbc=orphans-toggle]');
  await until(() => evaluate("document.body.textContent.includes('页面改版后找不到这些评论引用的文字。')"), 'the orphan explanation');
  assert.ok(await evaluate("document.querySelector('[data-pbc=orphans] .pbc-quote')?.textContent.startsWith('“')"), 'orphan cards show their quote');
  await shot('rail-orphans');
  check('orphans: passages missing after a page change are listed under 原文已修改 with their quotes, outside the aligned column');

  // 13. 900 × 800: a toggleable overlay that does not narrow the page; Esc closes it and focus returns to the toggle.
  await viewport(900, 800);
  await open(pagePath);
  await until(async () => (await ui()).toggle?.startsWith('评论 '), 'the toggle');
  state = await ui();
  assert.equal(state.mode, 'overlay'); assert.equal(state.rail, false); assert.equal(state.iframe, 900);
  await clickOuter('[data-pbc=toggle]');
  await until(async () => (await ui()).rail, 'the overlay');
  assert.equal((await ui()).iframe, 900, 'the overlay does not narrow the page');
  await until(async () => (await ui()).cards.length >= 3, 'overlay cards');
  await shot('overlay-900');
  await key('Escape', 'Escape', 27);
  await until(async () => { const value = await ui(); return !value.rail && value.focus === 'toggle'; }, 'Esc to close the overlay and focus the toggle');
  check('900 × 800: the rail is an overlay opened from the toggle that never narrows the page; Esc closes it and returns focus to the toggle');

  // 14. Keyboard in the overlay: arrows move between cards, Enter activates and reveals, Esc deactivates, Esc closes.
  await clickOuter('[data-pbc=toggle]');
  await until(async () => (await ui()).rail, 'the overlay again');
  await until(() => evaluate("document.activeElement&&document.activeElement.getAttribute('data-pbc')==='card'"), 'focus on the first card');
  const firstFocus = await evaluate("document.activeElement.getAttribute('data-thread')");
  await key('ArrowDown', 'ArrowDown', 40);
  const secondFocus = await evaluate("document.activeElement.getAttribute('data-thread')");
  assert.notEqual(secondFocus, firstFocus);
  await key('Enter', 'Enter', 13);
  await until(async () => (await ui()).cards.find(card => card.id === secondFocus)?.active, 'Enter to activate');
  await key('Escape', 'Escape', 27);
  await until(async () => !(await ui()).cards.some(card => card.active), 'Esc to deactivate');
  await key('Escape', 'Escape', 27);
  await until(async () => { const value = await ui(); return !value.rail && value.focus === 'toggle'; }, 'Esc again to close');
  check('keyboard: one tabbable card, arrows move in passage order, Enter activates, Esc deactivates and then closes the overlay');

  // 15. A phone (390 × 844, touch): no rail; 评论 n opens a bottom sheet; tapping a highlight opens it at that thread.
  await viewport(390, 844, true);
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await open(pagePath);
  await until(async () => (await ui()).toggle?.startsWith('评论 '), 'the phone toggle');
  assert.equal((await ui()).mode, 'sheet'); assert.equal((await ui()).rail, false);
  await until(async () => (await frameHighlights())?.['pbc-open'] >= 3, 'the phone highlights');
  const tap = await passage('#lead', '第二步');
  const opened = async () => { const value = await ui(); return value.rail && value.mode === 'sheet' && value.cards.find(card => card.id === t1.externalId)?.active; };
  for (let attempt = 0; attempt < 3 && !(await opened()); attempt++) {
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tap.x + 2, y: tap.y }] });
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until(opened, 'the sheet open at the tapped thread', 2500).catch(() => undefined);
  }
  if (!(await opened())) throw new Error(`The sheet did not open at the tapped thread: ${JSON.stringify({ tap, ui: await ui(), selection: await frame('getSelection().toString()') })}`);
  assert.equal(await evaluate("document.querySelector('[data-pbc=rail]').getAttribute('role')"), 'dialog');
  await sleep(200); await shot('sheet-390');
  await key('Escape', 'Escape', 27);
  await key('Escape', 'Escape', 27);
  await until(async () => { const value = await ui(); return !value.rail && value.focus === 'toggle'; }, 'Esc to close the sheet');
  check('390 × 844 touch: no rail, a 评论 n button, tapping a highlight opens the bottom sheet at that thread, Esc closes it and returns focus');
  // Review fix: a passage low on the screen is not covered by the sheet its tap opens (the page scrolls it up).
  backend.publicState(t4.externalId, { resolved: false });
  await open(pagePath);
  await until(async () => (await frameHighlights())?.['pbc-open'] >= 4, 'the far highlight on the phone');
  await frame("(()=>{const el=document.querySelector('#far');scrollTo(0,el.getBoundingClientRect().top+scrollY-560);return true})()");
  await sleep(300);
  const low = await passage('#far', '很靠后的一段文字');
  assert.ok(low.top > 844 * 0.3, `the passage starts where a 75vh sheet would cover it: ${JSON.stringify(low)}`);
  const farOpened = async () => { const value = await ui(); return value.rail && value.mode === 'sheet' && value.cards.find(card => card.id === t4.externalId)?.active; };
  for (let attempt = 0; attempt < 3 && !(await farOpened()); attempt++) {
    const at = await passage('#far', '很靠后的一段文字');
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x + 2, y: at.y }] });
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until(farOpened, 'the sheet open at the far thread', 2500).catch(() => undefined);
  }
  if (!(await farOpened())) throw new Error(`The sheet did not open at the far thread: ${JSON.stringify(await ui())}`);
  await sleep(500);
  const sheetTop = await evaluate("document.querySelector('[data-pbc=rail]').getBoundingClientRect().top"), lifted = await passage('#far', '很靠后的一段文字');
  assert.ok(lifted.top >= 0 && lifted.bottom <= sheetTop, `the tapped passage stays visible above the sheet: ${JSON.stringify({ lifted, sheetTop })}`);
  await shot('sheet-390-far');
  await key('Escape', 'Escape', 27); await key('Escape', 'Escape', 27);
  await until(async () => !(await ui()).rail, 'the sheet to close');
  backend.publicState(t4.externalId, { resolved: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  check('390 × 844 touch: tapping a highlight low on the screen scrolls its passage above the bottom sheet instead of covering it');

  // 16. Errors: busy with Retry-After, and a backend that turned public comments off.
  await viewport(1280, 800);
  backend.failNext('GET', '/_board/comments/public', { status: 429, headers: { 'Retry-After': '1' } });
  await open(pagePath);
  await until(() => evaluate("document.querySelector('[data-pbc=problem]')?.textContent==='评论服务繁忙，稍后自动重试。'"), 'the busy text');
  backend.failNext('GET', '/_board/comments/public', { status: 404, code: 'public_disabled' });
  await open(pagePath);
  await until(() => evaluate("document.querySelector('[data-pbc=problem]')?.textContent==='评论服务关闭了公开评论。'"), 'the turned-off text');
  check('errors: 429 shows the busy text and retries after Retry-After; a backend without public comments says so');

  // 17. Performance: 200 threads with a live-updating element; scrolling has no long task and at most one position message per frame.
  files.set('/public-heavy/', fixture.heavy.files['index.html']);
  const heavyUrl = origin + '/public-heavy/', heavyRelease = fixture.heavy.manifest.releaseId;
  for (let i = 0; i < 200; i++) await seed(backend, heavyUrl, heavyRelease, (i + 1).toString(16).padStart(64, '0'), { text: `评论 ${i}`, anchor: { selector: `#p${i}`, quote: `段落 ${i} 的内容` } }, `heavy-seed-${i}`);
  await open('/public-heavy/');
  await until(async () => (await evaluate("document.querySelectorAll('[data-pbc=card]').length")) >= 100, 'the heavy page cards', 15000);
  await frame("window.longTasks=[];new PerformanceObserver(list=>{for(const entry of list.getEntries())window.longTasks.push(Math.round(entry.duration))}).observe({type:'longtask',buffered:false});true");
  await evaluate("window.positionFrames=[];window.addEventListener('message',e=>{if(e.data&&e.data.type==='comment-positions')positionFrames.push(performance.now())});true");
  const middle = { x: 400, y: 400 };
  for (let i = 0; i < 60; i++) await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: middle.x, y: middle.y, deltaX: 0, deltaY: 120 });
  await sleep(600);
  const longTasks = await frame('window.longTasks'), framesSeen = await evaluate('window.positionFrames');
  assert.deepEqual(longTasks.filter(duration => duration > 50), [], JSON.stringify(longTasks));
  for (let i = 1; i < framesSeen.length; i++) assert.ok(framesSeen[i] - framesSeen[i - 1] > 4, 'at most one position message per frame');
  console.log(`MEASURE public-heavy ${JSON.stringify({ threads: 200, longTasks, positionMessages: framesSeen.length })}`);
  check('performance: 200 threads with a live element scroll without long tasks and with at most one position message per frame');

  // 18. Review fixes on a crowded page: 60 threads, two per paragraph, more than fit beside their passages.
  files.set('/public-crowded/', fixture.crowded.files['index.html']);
  const crowdedUrl = origin + '/public-crowded/', crowdedRelease = fixture.crowded.manifest.releaseId;
  for (let i = 0; i < 30; i++) for (const [k, quote] of [[0, `段落 ${i} 的内容`], [1, '定位使用']]) await seed(backend, crowdedUrl, crowdedRelease, (300 + i * 2 + k).toString(16).padStart(64, '0'), { text: `拥挤 ${i}-${k}`, anchor: { selector: `#p${i}`, quote } }, `crowded-${i}-${k}`);
  await viewport(1280, 800);
  await open('/public-crowded/');
  await until(async () => (await evaluate("document.querySelectorAll('[data-pbc=card]').length")) >= 60, 'the crowded cards', 15000);
  await sleep(700);
  const cardRect = text => evaluate(`(()=>{const n=[...document.querySelectorAll('[data-pbc=card]')].find(c=>c.querySelector('.pbc-text')?.textContent===${JSON.stringify(text)});if(!n)return null;const r=n.getBoundingClientRect();return{top:Math.round(r.top),bottom:Math.round(r.bottom),id:n.getAttribute('data-thread')}})()`);
  const bodyScroll = () => evaluate("document.querySelector('[data-pbc=body]').scrollTop");
  const firstPassage = await passage('#p0', '段落 0 的内容'), firstCrowded = await cardRect('拥挤 0-0');
  assert.ok(firstCrowded && Math.abs(firstCrowded.top - (firstPassage.top - 4)) <= 8, `the first card sits at its passage: ${JSON.stringify({ firstCrowded, firstPassage })}`);
  await shot('crowded-1280-top');
  const railMiddle = await evaluate("(()=>{const r=document.querySelector('[data-pbc=body]').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
  let pageMoved = false, lastCrowded = null;
  for (let i = 0; i < 80; i++) {
    await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: railMiddle.x, y: railMiddle.y, deltaX: 0, deltaY: 300 });
    await sleep(40);
    if (!pageMoved && await frame('scrollY') > 0) pageMoved = true;
    lastCrowded = await cardRect('拥挤 29-1');
    if (lastCrowded && lastCrowded.bottom <= 800 && lastCrowded.top >= 44 && await frame('Math.round(scrollY)>=Math.round(document.documentElement.scrollHeight-innerHeight)-1')) break;
  }
  await sleep(300); lastCrowded = await cardRect('拥挤 29-1');
  assert.ok(pageMoved, 'the wheel over the rail scrolls the page');
  assert.ok(lastCrowded && lastCrowded.bottom <= 800 && lastCrowded.top >= 44, `the last card can be reached: ${JSON.stringify(lastCrowded)}`);
  assert.equal(await bodyScroll(), 0, 'the rail body itself never scrolls');
  await shot('crowded-1280-end');
  for (let i = 0; i < 80 && (await frame('scrollY')) > 0; i++) { await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: railMiddle.x, y: railMiddle.y, deltaX: 0, deltaY: -600 }); await sleep(30); }
  for (let i = 0; i < 10; i++) { await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: railMiddle.x, y: railMiddle.y, deltaX: 0, deltaY: -600 }); await sleep(20); }
  await sleep(400);
  assert.equal(await frame('scrollY'), 0);
  const backFirst = await cardRect('拥挤 0-0'), backPassage = await passage('#p0', '段落 0 的内容');
  assert.ok(Math.abs(backFirst.top - (backPassage.top - 4)) <= 8, `back at the top the first card is at its passage again: ${JSON.stringify({ backFirst, backPassage })}`);
  check('crowded page: the first card stays at its passage; the wheel over the rail scrolls the page and then the rail past its end, so the last of 60 cards is reachable; scrolling back realigns');

  // Keyboard focus moves the rail with the page instead of scrolling the rail body (which would separate cards from passages).
  await evaluate("document.querySelector('[data-pbc=card][tabindex=\"0\"]').focus(),true");
  await key('End', 'End', 35);
  await sleep(500);
  const focusedState = () => evaluate("(()=>{const n=document.activeElement,r=n.getBoundingClientRect();return{pbc:n.getAttribute('data-pbc'),text:n.querySelector('.pbc-text')?.textContent,top:Math.round(r.top),bottom:Math.round(r.bottom)}})()");
  const atEnd = await focusedState();
  assert.equal(atEnd.text, '拥挤 29-1'); assert.ok(atEnd.top >= 44 && atEnd.bottom <= 800, JSON.stringify(atEnd)); assert.equal(await bodyScroll(), 0);
  await key('Home', 'Home', 36);
  await sleep(600);
  const atHome = await focusedState(), homePassage = await passage('#p0', '段落 0 的内容');
  assert.equal(atHome.text, '拥挤 0-0'); assert.equal(await bodyScroll(), 0);
  assert.ok(Math.abs(atHome.top - (homePassage.top - 4)) <= 8, `the first card is visible beside its passage: ${JSON.stringify({ atHome, homePassage })}`);
  // Arrow keys through the middle: every focused card is on screen and the rail body stays put.
  for (let i = 0; i < 25; i++) await key('ArrowDown', 'ArrowDown', 40);
  await sleep(500);
  const midway = await focusedState();
  assert.ok(midway.top >= 44 && midway.bottom <= 800, JSON.stringify(midway)); assert.equal(await bodyScroll(), 0);
  check('keyboard: End, Home and the arrows move focus over 60 cards without scrolling the rail body; the page and rail follow so the focused card is visible and stays beside its passage');

  // 19. A long thread: the open card fits the rail and scrolls inside, so 回复 can always be reached.
  await open(pagePath);
  for (let i = 0; i < 30; i++) await seed(backend, pageUrl, releaseId, (500 + i).toString(16).padStart(64, '0'), { text: `长讨论回复 ${i}：${'很长的内容'.repeat(12)}`, parentId: t2.externalId, anchor: {} }, `long-thread-${i}`);
  await open(pagePath);
  await until(async () => (await ui()).cards.some(card => card.id === t2.externalId), 'the long thread');
  await clickOuter(`[data-pbc=card][data-thread="${t2.externalId}"] .pbc-text`);
  await until(async () => (await ui()).cards.find(card => card.id === t2.externalId)?.active, 'the long thread to open');
  await sleep(400);
  const longCard = await evaluate(`(()=>{const n=document.querySelector('[data-pbc=card][data-thread="${t2.externalId}"]');n.scrollTop=n.scrollHeight;const r=n.getBoundingClientRect(),b=n.querySelector('[data-pbc=reply-open]').getBoundingClientRect();return{top:Math.round(r.top),bottom:Math.round(r.bottom),button:Math.round(b.bottom),scrolls:n.scrollHeight>n.clientHeight}})()`);
  assert.ok(longCard.scrolls && longCard.top >= 44 && longCard.bottom <= 800 && longCard.button <= 800, JSON.stringify(longCard));
  await shot('long-thread-1280');
  check('a long thread: the open card stays inside the rail and scrolls on its own, so 回复 is always reachable');

  // 20. A click on plain page text, or on the rail's empty space, closes the open card.
  const plain = await passage('#second', '第二段落用来');
  await mouse(plain.x, plain.y);
  await until(async () => !(await ui()).cards.some(card => card.active), 'a click in the page to close the open card');
  await clickOuter(`[data-pbc=card][data-thread="${t1.externalId}"] .pbc-text`);
  await until(async () => (await ui()).cards.find(card => card.id === t1.externalId)?.active, 'the first card to open again');
  await sleep(300);
  const empty = await evaluate("(()=>{const b=document.querySelector('[data-pbc=body]').getBoundingClientRect();for(let y=b.bottom-12;y>b.top+12;y-=10){const e=document.elementFromPoint(b.left+b.width/2,y);if(e&&!e.closest('[data-pbc=card],[data-pbc=group],button,textarea,input'))return{x:Math.round(b.left+b.width/2),y:Math.round(y)}}return null})()");
  assert.ok(empty, 'the rail has empty space');
  await mouse(empty.x, empty.y);
  await until(async () => !(await ui()).cards.some(card => card.active), 'a click on empty rail space to close the open card');
  check('a click on plain page text or on empty rail space closes the open card, as in Google Docs');

  // 21. Replying from the keyboard keeps focus in the thread.
  await clickOuter(`[data-pbc=card][data-thread="${t1.externalId}"] .pbc-text`);
  await until(async () => (await ui()).cards.find(card => card.id === t1.externalId)?.active, 'the first card to open');
  await clickOuter(`[data-pbc=card][data-thread="${t1.externalId}"] [data-pbc=reply-open]`);
  await until(() => evaluate("document.activeElement?.getAttribute('data-pbc')==='reply-text'"), 'the reply box');
  await typeText('键盘发送的回复');
  await key('Enter', 'Enter', 13, 4);
  await until(async () => (await ui()).cards.find(card => card.id === t1.externalId)?.text.includes('键盘发送的回复'), 'the keyboard reply');
  await sleep(200);
  assert.equal(await evaluate("document.activeElement?.getAttribute('data-pbc')"), 'reply-open', 'focus returns to the thread\'s 回复 button, not the page body');
  check('a reply sent with ⌘/Ctrl+Enter returns focus to the thread\'s 回复 button');

  // 22. The owner resolves a thread while a reply is being written: the card stays, says why, and keeps the draft.
  await clickOuter(`[data-pbc=card][data-thread="${t1.externalId}"] [data-pbc=reply-open]`);
  await until(() => evaluate("document.activeElement?.getAttribute('data-pbc')==='reply-text'"), 'the reply box again');
  await typeText('我正在写一条很长的回复');
  backend.publicState(t1.externalId, { resolved: true });
  await sleep(3100); await evaluate("window.dispatchEvent(new Event('focus'))");
  await until(() => evaluate(`document.querySelector('[data-pbc=card][data-thread="${t1.externalId}"] [data-pbc=unsent-draft]')?.textContent==='我正在写一条很长的回复'`), 'the unsent draft in the resolved card', 12000);
  const resolvedOpen = (await ui()).cards.find(card => card.id === t1.externalId);
  assert.ok(resolvedOpen.active && resolvedOpen.text.includes("作者已把这条讨论标为已解决。") && resolvedOpen.text.includes("你还没发送的回复"), resolvedOpen.text);
  assert.equal(await evaluate("document.querySelector('[data-pbc=toast]').textContent"), '作者刚把这条讨论标为已解决，你的回复没有发送；草稿还留在卡片里。');
  assert.equal(await evaluate("document.activeElement?.getAttribute('data-pbc')"), 'card', 'focus stays on the card, not the page body');
  await shot('resolved-while-typing');
  await clickOuter(`[data-pbc=card][data-thread="${t1.externalId}"] [data-pbc=drop-draft]`);
  await until(() => evaluate(`!document.querySelector('[data-pbc=card][data-thread="${t1.externalId}"] [data-pbc=unsent-draft]')`), 'the draft to go');
  await key('Escape', 'Escape', 27);
  await until(async () => !(await ui()).cards.some(card => card.id === t1.externalId), 'the resolved card to leave 未解决 once closed');
  backend.publicState(t1.externalId, { resolved: false });
  check('resolved while typing: the open card stays under 未解决 until closed, says the thread was resolved, keeps the unsent reply visible and focus on the card');

  // 23. Names: the page labels are refused before anything is sent or saved; a transliterated name with · is fine.
  await sleep(3100); await evaluate("window.dispatchEvent(new Event('focus'))");
  await until(async () => (await ui()).cards.some(card => card.id === t1.externalId), 'the reopened thread');
  await clickOuter(`[data-pbc=card][data-thread="${t1.externalId}"] .pbc-text`);
  await until(async () => (await ui()).cards.find(card => card.id === t1.externalId)?.active, 'the thread to open for a name check');
  await clickOuter(`[data-pbc=card][data-thread="${t1.externalId}"] [data-pbc=reply-open]`);
  await until(() => evaluate("document.activeElement?.getAttribute('data-pbc')==='reply-text'"), 'the reply box for a name check');
  await typeText('名字测试');
  await clickOuter(`[data-pbc=card][data-thread="${t1.externalId}"] [data-pbc=rename]`);
  await until(() => evaluate("document.activeElement?.getAttribute('data-pbc')==='reply-name'"), 'the name field');
  await typeText('访 客小王');
  assert.equal(await evaluate("document.querySelector('[data-pbc=reply-identity]').textContent"), '称呼里不能有「作者」「AI 助手」「访客」这些字样，也不能有看不见的格式字符。');
  const postsBeforeName = backend.requests.filter(request => request.method === 'POST').length;
  await evaluate("document.querySelector('[data-pbc=reply-text]').focus(),true");
  await key('Enter', 'Enter', 13, 4);
  await sleep(300);
  assert.equal(backend.requests.filter(request => request.method === 'POST').length, postsBeforeName, 'nothing is sent');
  assert.notEqual(JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify('paseo-board-public:v1:' + fixture.appKey)})`) || '{}').name, '访 客小王', 'the refused name is not saved');
  await evaluate("(()=>{const i=document.querySelector('[data-pbc=reply-name]');i.value='迈克尔·杰克逊';i.dispatchEvent(new Event('input'));document.querySelector('[data-pbc=reply-text]').focus();return true})()");
  assert.ok((await evaluate("document.querySelector('[data-pbc=reply-identity]').textContent")).startsWith('显示为：迈克尔·杰克逊 · 访客·'));
  await key('Enter', 'Enter', 13, 4);
  await until(async () => (await ui()).cards.find(card => card.id === t1.externalId)?.text.includes('迈克尔·杰克逊'), 'the reply with a transliterated name');
  check('names: a name with 作者, AI 助手 or 访客 (even spaced) is refused in Chinese before sending or saving; 迈克尔·杰克逊 is accepted');

  // 24. Reading the page counts as activity: a click in the page tells the shell (it keeps polling every 10 s).
  await open(pagePath);
  await evaluate("window.activityMessages=0;window.addEventListener('message',e=>{if(e.data&&e.data.type==='comment-activity')activityMessages++});true");
  const somewhere = await passage('#title', '公开讨论演示');
  await mouse(somewhere.x, somewhere.y);
  await until(() => evaluate('window.activityMessages>=1'), 'an activity message from the page');
  check('activity: clicks inside the page reach the shell, so a reader is not treated as idle');

  // 25. Polish P4: the share's version archive <stable>/v/<this release's hex>/ and an explicit index.html show the
  // stable page's discussion (same listing key, same cards); an archive of another release keeps its own address.
  const pageParam = request => new URLSearchParams(request.search).get('page');
  const archivePath = `${pagePath}v/${releaseId.slice(8)}/`, otherArchive = `${pagePath}v/${'0'.repeat(64)}/`;
  for (const path of [archivePath, `${pagePath}index.html`, otherArchive]) files.set(path, release.files['index.html']);
  const cardIds = async () => (await ui()).cards.map(card => card.id).sort().join(',');
  await open(pagePath);
  await until(async () => (await ui()).cards.length >= 3, 'the stable page cards');
  await sleep(300);
  const stableCards = await cardIds();
  for (const path of [archivePath, `${pagePath}index.html`]) {
    backend.requests.length = 0;
    await open(path);
    await until(async () => (await cardIds()) === stableCards, `the stable discussion at ${path}`);
    assert.equal(pageParam(listings()[0]), pageUrl, `${path} lists the stable page's threads`);
  }
  backend.requests.length = 0;
  await open(otherArchive);
  await until(() => Promise.resolve(listings().length >= 1), 'the listing of an unrelated archive');
  assert.equal(pageParam(listings()[0]), origin + otherArchive, 'only this release\'s own version archive maps to the stable page');
  check('version archive: <stable>/v/<own release hex>/ and index.html list and show the stable page\'s threads; another hex keeps its own address');

  // 26. Polish P2 + P4: a comment sent from the version archive is filed under the stable page, its selection is cleared,
  // and scrolling never offers 「评论」 again for the passage just commented.
  await open(archivePath);
  await until(async () => (await cardIds()) === stableCards, 'the archive cards');
  const select = (selector, text) => frame(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),node=el.firstChild,i=node.data.indexOf(${JSON.stringify(text)});getSelection().setBaseAndExtent(node,i,node,i+${text.length});return true})()`);
  const floatShown = () => evaluate("(()=>{const f=document.querySelector('[data-pbc=float]');return Boolean(f)&&!f.hidden})()");
  const wheel = async (deltaY = 120) => { await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY }); };
  await frame('scrollTo(0,0),true'); await sleep(200);
  await select('#second', '足够多的文字');
  await until(floatShown, 'the 评论 button for the selection');
  await clickOuter('[data-pbc=float]');
  await until(() => evaluate("Boolean(document.querySelector('[data-pbc=composer]'))"), 'the composer from the 评论 button');
  await typeText('从版本页发出的评论');
  const archivePosts = backend.requests.length;
  await key('Enter', 'Enter', 13, 4);
  await until(() => evaluate("!document.querySelector('[data-pbc=composer]')"), 'the archive comment to be sent');
  const archivePost = backend.requests.slice(archivePosts).find(request => request.method === 'POST' && request.path.endsWith('/_board/comments'));
  assert.equal(JSON.parse(archivePost.body).pageUrl, pageUrl, 'a comment from the version archive is filed under the stable page');
  await until(async () => (await frame('getSelection().toString()')) === '', 'the page selection to be cleared after sending');
  for (let i = 0; i < 3; i++) { await wheel(i % 2 ? -120 : 120); await sleep(120); }
  await sleep(700);
  assert.equal(await floatShown(), false, 'after sending, scrolling does not offer 评论 for the commented passage again');
  const archiveRow = backend.publicRows().find(row => row.text === '从版本页发出的评论');
  await open(pagePath);
  await until(async () => (await ui()).cards.some(card => card.id === archiveRow.externalId), 'the archive comment on the stable page');
  check('send: a comment from the version archive is posted for the stable page and appears there; the selection is cleared and scrolling shows no 评论 button for it');

  // 27. Polish P2: after 取消 the selection stays, but scrolling does not bring 「评论」 back for it; a new selection does.
  await frame('scrollTo(0,0),true'); await sleep(200);
  await select('#lead', '最后第四步');
  await until(floatShown, 'the 评论 button for a second selection');
  await clickOuter('[data-pbc=float]');
  await until(() => evaluate("Boolean(document.querySelector('[data-pbc=composer]'))"), 'the composer for the second selection');
  await clickOuter('[data-pbc=cancel]');
  await until(() => evaluate("!document.querySelector('[data-pbc=composer]')"), 'the composer to close on 取消');
  assert.equal(await frame('getSelection().toString()'), '最后第四步', 'cancelling keeps the selection');
  for (let i = 0; i < 3; i++) { await wheel(i % 2 ? -120 : 120); await sleep(120); }
  await sleep(700);
  assert.equal(await floatShown(), false, 'after 取消, scrolling does not offer 评论 for the same selection');
  await select('#lead', '第三步再提交');
  await until(floatShown, 'the 评论 button for a new selection');
  await frame('getSelection().removeAllRanges(),true');
  await until(async () => !(await floatShown()), 'the button to go with the selection');
  check('cancel: the selection stays but scrolling never brings the 评论 button back for it; selecting other text offers it again');

  // 28. Polish P1: a reply that arrives while its thread's card is open is read there: no 新 chip, and no unread count
  // on 评论 n once the card and the overlay are closed (also after a reload).
  await viewport(900, 800);
  await open(pagePath);
  await until(async () => (await ui()).toggle?.startsWith('评论 '), 'the overlay toggle');
  await clickOuter('[data-pbc=toggle]');
  await until(async () => (await ui()).cards.some(card => card.id === t1.externalId), 'the own thread in the overlay');
  await clickOuter(`[data-pbc=card][data-thread="${t1.externalId}"] .pbc-text`);
  await until(async () => (await ui()).cards.find(card => card.id === t1.externalId)?.active, 'the own thread to open');
  await seed(backend, pageUrl, releaseId, SECRETS.d, { text: '打开着的讨论里来了新回复', parentId: t1.externalId, anchor: {} }, 'open-card-reply');
  await sleep(3100); await evaluate("window.dispatchEvent(new Event('focus'))");
  await until(async () => (await ui()).cards.find(card => card.id === t1.externalId)?.text.includes('打开着的讨论里来了新回复'), 'the reply in the open card', 12000);
  await sleep(200);
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-pbc=card][data-thread="${t1.externalId}"] .pbc-chip[data-kind=new]'))`), false, 'no 新 chip in the open card');
  await key('Escape', 'Escape', 27);
  await until(async () => !(await ui()).cards.some(card => card.active), 'Esc to close the card');
  await key('Escape', 'Escape', 27);
  await until(async () => !(await ui()).rail, 'Esc to close the overlay');
  const afterClose = (await ui()).toggle;
  assert.ok(afterClose.startsWith('评论 ') && !afterClose.includes('新回复'), `the toggle counts no new reply: ${afterClose}`);
  await open(pagePath);
  await until(async () => (await ui()).toggle?.startsWith('评论 '), 'the toggle after a reload');
  assert.equal((await ui()).toggle.includes('新回复'), false, `still read after a reload: ${(await ui()).toggle}`);
  await viewport(1280, 800);
  check('a reply that arrives in the open card is read there: no 新 chip, and 评论 n shows no new reply after closing or reloading');
  return { ids: { t1, t2, t3: t3b, t4, r1 } };
}
