import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appKeyFor, createFakeCommentsBackend, loadContractFixture } from './comments-fake-backend.mjs';

// Visitor text-selection comments in the real exported viewer, driven by trusted Chromium input.
// The comment backends are loopback fakes of the page<->backend contract (scripts/comments-fake-backend.mjs).
export async function createCommentsFixture({ buildRelease, options, origin, live, directory }) {
  const owner = 'comments-owner', appKey = appKeyFor(owner);
  const backend = await createFakeCommentsBackend({ allowedOrigins: [origin], owner, appId: 'comments-a' });
  // Another address of the same app (path prefix, shared data): visitors keep their identity and threads.
  const moved = await createFakeCommentsBackend({ allowedOrigins: [origin], owner, appId: 'comments-a', prefix: '/api', state: backend.state });
  const other = await createFakeCommentsBackend({ allowedOrigins: [origin], owner: 'someone-else', appId: 'comments-other' });
  const mount = (await readFile(join(directory, '..', 'backend', 'visitor.mjs'), 'utf8')).replace(/^export function mountComments/m, 'function mountComments')
    // The release builder reads CSS-like url( patterns as resources; the helper's URL constructor is not one.
    .replace(/new URL\(/g, 'new (URL)(');
  const page = result => `<style>body{margin:0;font:17px/1.6 Georgia,serif;color:#1d1d1f;background:#fff}main{padding:24px 32px;max-width:760px}#scroller{height:110px;overflow:auto;border:1px solid #bbb;padding:8px;margin:16px 0}#scroller .tall{height:420px}.spacer{height:900px}</style>
<main>
<section id="intro"><h2>结果</h2><p id="result">${result}</p></section>
<p id="plain">Plain words for keyboard selection and extension here.</p>
<div id="scroller"><p id="nested">Nested scroller quote target text.</p><div class="tall"></div></div>
<p id="links"><a id="link" href="https://example.com/docs">Documentation link text</a></p>
<input id="field" value="input text value"><textarea id="area">textarea text value</textarea>
<div id="editable" contenteditable="true">editable region text</div>
<div id="optout" data-board-comments="off"><p id="optout-text">Opted out paragraph text.</p></div>
<div id="authored-menu"><p id="authored-text">Authored context menu paragraph.</p></div>
<button id="api-probe" type="button">Probe API</button><div id="comments-form"></div>
<div class="spacer"></div>
</main>
<script>
window.frameMessages=[];window.addEventListener('message',event=>frameMessages.push(JSON.stringify(event.data)));
window.menuLog=[];window.addEventListener('contextmenu',event=>menuLog.push({prevented:event.defaultPrevented,id:event.target.id||(event.target.parentElement&&event.target.parentElement.id)}));
document.querySelector('#authored-menu').addEventListener('contextmenu',event=>{event.preventDefault();window.authoredMenu=(window.authoredMenu||0)+1});
${mount}
window.mounted=mountComments(document.querySelector('#comments-form'),{apiBase:${JSON.stringify(backend.origin)},pageUrl:'https://example.com/authored',request:board.request,storage:{getItem:()=>null,setItem(){},removeItem(){}}});
document.querySelector('#api-probe').onclick=()=>{window.apiProbe=board.request(${JSON.stringify(backend.origin)}+'/_board/health').then(r=>r.json()).then(v=>v.appKey,e=>'error:'+e.message)};
window.ready=true;
</script>`;
  const source = html => ({ ...options.board, canvas: { ...options.board.canvas, html, patches: [], data: {} } });
  const build = (html, comments, extra = {}) => buildRelease({ ...options, board: source(html), publicData: {}, apiOrigins: [backend.origin], comments, ...extra });
  const comments = { apiBase: backend.apiBase, appKey };
  const release = build(page('首先，第二步的意思'), comments);
  const changed = build(page('这一段已经改写，不再包含原来的引用。'), comments);
  const viaMoved = build(page('首先，第二步的意思'), { apiBase: moved.apiBase, appKey });
  const otherApp = build(page('首先，第二步的意思'), { apiBase: other.apiBase, appKey });
  const liveHtml = `<style>body{font:16px system-ui;margin:24px}</style><main><p id="live-text">Live and comments together on one page.</p><output id="live-state"></output></main><script>window.liveState=board.getContext().live.state;window.ready=true;</script>`;
  const liveRelease = buildRelease({ ...options, board: source(liveHtml), publicData: { live: { label: 'frozen' } }, apiOrigins: [live.proxyOrigin], live: { origin: live.proxyOrigin, channelId: live.unknownChannel, paths: ['/live/label'] }, comments });
  return {
    backend, moved, other, appKey, release, changed, viaMoved, otherApp, liveRelease, fixture: loadContractFixture(),
    close: () => Promise.all([backend.close(), moved.close(), other.close()]),
  };
}

export async function runCommentsChecks({ assert, command, frameCommand, evaluate, frame, open, reload, click, setHidden, files, origin, comments, check }) {
  const { backend, moved, other, release } = comments;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (read, label, ms = 8000) => {
    const deadline = Date.now() + ms;
    for (;;) { const value = await read().catch(() => undefined); if (value) return value; if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`); await sleep(40); }
  };
  const pagePath = '/comments/', pageUrl = origin + pagePath;
  const ui = () => evaluate(`(()=>{const q=s=>document.querySelector('[data-pbc='+s+']'),shown=n=>Boolean(n)&&n.isConnected&&!n.hidden;const c=q('composer');return{float:shown(q('float')),composer:shown(c),sheet:Boolean(c&&c.classList.contains('pbc-sheet')),badge:shown(q('badge'))?q('badge').textContent:null,panel:shown(q('panel'))?q('panel').textContent:null,hint:shown(q('hint')),toast:shown(q('toast'))?q('toast').textContent:null,focus:document.activeElement&&(document.activeElement.getAttribute('data-pbc')||document.activeElement.getAttribute('aria-label')||document.activeElement.tagName),composerText:c?c.textContent:null,textarea:c?c.querySelector('textarea').value:null,send:c?{label:c.querySelector('[data-pbc=send]').textContent,disabled:c.querySelector('[data-pbc=send]').disabled}:null}})()`);
  const outerBox = selector => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,left:r.left,top:r.top,right:r.right,bottom:r.bottom}})()`);
  const mouse = async (x, y, button = 'left', modifiers = 0) => {
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1, modifiers });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1, modifiers });
  };
  const clickOuter = async selector => { const box = await until(() => outerBox(selector), selector); await mouse(box.x, box.y); };
  const key = async (key, code, keyCode, modifiers = 0, commands) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers, ...(commands ? { commands } : {}) });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const escape = () => key('Escape', 'Escape', 27);
  const sendKeys = () => key('Enter', 'Enter', 13, 2);
  const find = (selector, text) => `(()=>{const el=document.querySelector(${JSON.stringify(selector)}),walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode()){const i=node.data.indexOf(${JSON.stringify(text)});if(i>=0){const r=document.createRange();r.setStart(node,i);r.setEnd(node,i+${text.length});return{node,i,r}}}throw new Error('text not found')})()`;
  const select = (selector, text) => frame(`(()=>{const f=${find(selector, text)};getSelection().setBaseAndExtent(f.node,f.i,f.node,f.i+${text.length});return getSelection().toString()})()`);
  const rect = (selector, text) => frame(`(()=>{const f=${find(selector, text)},rects=f.r.getClientRects(),a=rects[0],b=rects[rects.length-1];return{x:(a.left+a.right)/2,y:(a.top+a.bottom)/2,left:a.left,top:a.top,right:b.right,bottom:b.bottom,lastTop:b.top}})()`);
  const clearSelection = () => frame('getSelection().removeAllRanges(),true');
  const lastMenu = () => frame('window.menuLog[window.menuLog.length-1]||null');
  const markers = async () => {
    const { root } = await frameCommand('DOM.getDocument', { depth: -1, pierce: true }), found = [];
    const collect = node => { if (node.nodeName === 'BUTTON') found.push(node); for (const child of node.children ?? []) collect(child); };
    const walk = node => {
      if (node.nodeName === 'PASEO-BOARD-COMMENT-MARKERS') for (const shadow of node.shadowRoots ?? []) collect(shadow);
      for (const child of [...(node.children ?? []), ...(node.contentDocument ? [node.contentDocument] : []), ...(node.shadowRoots ?? [])]) walk(child);
    };
    walk(root);
    return found.map(node => {
      const attributes = {}; for (let i = 0; i < (node.attributes ?? []).length; i += 2) attributes[node.attributes[i]] = node.attributes[i + 1];
      const at = /translate\((-?\d+)px,\s*(-?\d+)px\)/.exec(attributes.style ?? '');
      return { n: node.children?.[0]?.nodeValue, label: attributes['aria-label'], hidden: 'hidden' in attributes, unread: 'data-unread' in attributes, x: at ? Number(at[1]) : null, y: at ? Number(at[2]) : null };
    });
  };
  const visibleMarkers = async () => (await markers()).filter(marker => !marker.hidden);
  const mineRequests = (server = backend) => server.requests.filter(request => request.method === 'GET' && request.path.endsWith('/_board/comments/mine'));
  const posts = (server = backend) => server.requests.filter(request => request.method === 'POST' && request.path.endsWith('/_board/comments'));
  const visitorRecord = () => evaluate(`localStorage.getItem(${JSON.stringify('paseo-board-visitor:v2:' + comments.appKey)})`);
  const waitInactive = () => until(() => evaluate('!navigator.userActivation.isActive'), 'transient user activation to expire', 9000);
  const focusFrameAt = async () => { const box = await rect('#plain', 'Plain'); await mouse(box.left - 12, box.y); await clearSelection(); };

  // 1. A first-time visitor's page load makes no request at all; the hint is the only new UI.
  backend.requests.length = 0;
  await open(pagePath + '?from=test');
  await sleep(1500);
  assert.deepEqual(backend.requests, [], 'A first-time visitor sends nothing before commenting');
  assert.deepEqual(await ui().then(state => ({ float: state.float, composer: state.composer, badge: state.badge, hint: state.hint })), { float: false, composer: false, badge: null, hint: true });
  assert.equal(await evaluate("document.querySelector('[data-pbc=hint]').textContent.includes('选中文字即可评论')"), true);
  assert.equal(await visitorRecord(), null);
  assert.equal(await frame("(()=>{try{localStorage.length;return 'readable'}catch{return 'denied'}})()"), 'denied', 'The canvas frame has no storage of its own');
  check('comments page: a first-time visitor makes no request before sending, and only the hint appears');

  // 2. The passive floating button follows the selection and needs no user activation.
  await focusFrameAt();
  await waitInactive();
  assert.equal(await select('#result', '第二步'), '第二步');
  await until(async () => (await ui()).float, 'the floating button');
  const quoteBox = await rect('#result', '第二步'), floatBox = await outerBox('[data-pbc=float]');
  assert.ok(floatBox.bottom <= quoteBox.top + 2 && Math.abs(floatBox.x - quoteBox.right) < 60, JSON.stringify({ floatBox, quoteBox }));
  assert.equal(await evaluate("document.querySelector('[data-pbc=float]').getAttribute('aria-label')"), '评论选中的文字');
  await clearSelection();
  await until(async () => !(await ui()).float, 'the button to hide on collapse');
  await select('#result', '第二步'); await until(async () => (await ui()).float, 'the floating button again');
  await frame('window.scrollBy(0,40),true');
  await until(async () => !(await ui()).float, 'the button to hide on scroll', 2000);
  await frame('window.scrollTo(0,0),true');
  await until(async () => (await ui()).float, 'the button after scrolling settles');
  await escape();
  await until(async () => !(await ui()).float, 'the button to hide on Esc', 2000);
  await sleep(600); assert.equal((await ui()).float, false, 'Esc keeps the button hidden for the same selection');
  for (const [selector, text, setup] of [['#field', 'input', "document.querySelector('#field').focus();document.querySelector('#field').select()"], ['#area', 'textarea', "document.querySelector('#area').focus();document.querySelector('#area').select()"], ['#editable', 'editable', null], ['#optout-text', 'Opted', null]]) {
    if (setup) await frame(`${setup},true`); else await select(selector, text);
    await sleep(700); assert.equal((await ui()).float, false, `No comment button for ${selector}`);
    await frame('document.activeElement&&document.activeElement.blur&&document.activeElement.blur(),true'); await clearSelection();
  }
  check('comments page: the passive 评论 button appears after selecting text, hides on collapse, scroll and Esc, and never for inputs, textareas, contenteditable or opted-out regions');

  // 3. Right-click opens the composer only inside an earlier selection; everything else keeps the native menu.
  const right = async (x, y, modifiers = 0) => { const before = await frame('window.menuLog.length'); await mouse(x, y, 'right', modifiers); await until(() => frame(`window.menuLog.length>${before}`), 'a contextmenu event'); return lastMenu(); };
  const plain = await rect('#plain', 'Plain words');
  await clearSelection();
  assert.equal((await right(plain.x, plain.y)).prevented, false, 'Nothing selected');
  const link = await rect('#link', 'Documentation');
  await select('#link', 'Documentation link'); assert.equal((await right(link.x, link.y)).prevented, false, 'A link keeps its menu');
  await frame("document.querySelector('#area').focus(),document.querySelector('#area').select(),true");
  const area = await frame("(()=>{const r=document.querySelector('#area').getBoundingClientRect();return{x:r.left+10,y:r.top+10}})()");
  assert.equal((await right(area.x, area.y)).prevented, false, 'A textarea keeps its menu');
  await frame('document.activeElement.blur(),true');
  const editable = await rect('#editable', 'editable');
  await select('#editable', 'editable region'); assert.equal((await right(editable.x, editable.y)).prevented, false, 'contenteditable keeps its menu');
  const optout = await rect('#optout-text', 'Opted');
  await select('#optout-text', 'Opted out'); assert.equal((await right(optout.x, optout.y)).prevented, false, 'An opted-out region keeps its menu');
  await select('#result', '第二步'); assert.equal((await right(plain.x, plain.y)).prevented, false, 'Outside the selection keeps the menu');
  assert.equal((await ui()).composer, false);
  // macOS selects the word or link under the pointer before contextmenu: that selection is not "earlier".
  await frame("window.macSelect=event=>{if(event.button!==2)return;const t=event.target.closest('p,a')||event.target;const r=document.createRange();r.selectNodeContents(t);getSelection().removeAllRanges();getSelection().addRange(r)};window.addEventListener('mousedown',macSelect,true);true");
  await clearSelection();
  assert.equal((await right(plain.x, plain.y)).prevented, false, 'A word macOS selects on right-click is not a comment target');
  await clearSelection();
  assert.equal((await right(link.x, link.y)).prevented, false, 'Neither is a link macOS selects on right-click');
  await frame("window.removeEventListener('mousedown',macSelect,true),true");
  assert.equal((await ui()).composer, false);
  await select('#result', '第二步'); await sleep(450);
  assert.equal((await right(quoteBox.x, quoteBox.y, 8)).prevented, false, 'Shift + right-click keeps the browser menu');
  const authored = await rect('#authored-text', 'Authored');
  await select('#authored-text', 'Authored context'); const authoredBefore = await frame('window.authoredMenu||0');
  assert.equal((await right(authored.x, authored.y)).prevented, true); assert.equal(await frame('window.authoredMenu'), authoredBefore + 1);
  await sleep(200); assert.equal((await ui()).composer, false, 'An authored contextmenu handler owns its region');
  check('comments page: right-click keeps the native menu with nothing selected, on links, textareas, contenteditable, opted-out regions, outside the selection, for a word macOS selects on right-click, with Shift, and inside an authored contextmenu handler');

  // 4. Right-click inside an earlier selection opens the composer directly; Esc keeps the draft, 取消 asks.
  await select('#result', '第二步'); await sleep(450);
  assert.equal((await right(quoteBox.x, quoteBox.y)).prevented, true);
  await until(async () => (await ui()).composer, 'the composer');
  let state = await ui();
  assert.equal(state.focus, '评论'); assert.equal(state.float, false);
  for (const text of ['“第二步”', '评论只发给页面作者，可能由作者的 AI 助手处理；回复只在这个浏览器里对你可见。', '⌘/Ctrl + Enter 发送 · Esc 收起（保留草稿）', 'Shift + 右键：浏览器菜单']) assert.ok(state.composerText.includes(text), text);
  assert.equal(await evaluate("document.querySelector('[data-pbc=composer]').getAttribute('role')"), 'dialog');
  assert.equal(await evaluate("document.querySelector('[data-pbc=composer] textarea').placeholder"), '写下你的评论…');
  assert.equal(await evaluate("document.querySelector('[data-pbc=composer] input').placeholder"), '称呼（可选）');
  await command('Input.insertText', { text: '草稿内容' });
  await escape();
  await until(async () => !(await ui()).composer, 'Esc to close the composer');
  assert.equal(await evaluate('document.activeElement.tagName'), 'IFRAME', 'Focus returns to the canvas');
  await select('#result', '第二步'); await sleep(450); await right(quoteBox.x, quoteBox.y);
  await until(async () => (await ui()).textarea === '草稿内容', 'the kept draft');
  await clickOuter('[data-pbc=cancel]');
  await until(() => evaluate("!document.querySelector('[data-pbc=discard]').hidden"), 'the discard question');
  assert.ok((await ui()).composerText.includes('放弃这条评论？'));
  await clickOuter('[data-pbc=discard] button:last-child');
  state = await ui(); assert.equal(state.composer, true); assert.equal(state.textarea, '草稿内容');
  check('comments page: right-click inside an earlier selection opens the composer directly with focus in the text; Esc keeps the draft and returns focus to the canvas; 取消 asks before discarding');

  // 5. Sending: the payload is frozen before the request; a lost response is retried with the same key and payload.
  await evaluate("(()=>{const t=document.querySelector('[data-pbc=composer] textarea');t.select();return true})()");
  await command('Input.insertText', { text: '第二步看不懂' });
  await clickOuter('[data-pbc=composer] input'); await command('Input.insertText', { text: ' 小王 ' });
  // Chrome may resend a POST once by itself when a reused connection closes; lose that attempt too.
  backend.failNext('POST', '/_board/comments', 'lost'); backend.failNext('POST', '/_board/comments', 'lost');
  await clickOuter('[data-pbc=composer] textarea'); await sendKeys();
  await until(async () => (await ui()).send?.label === '重试', 'the unconfirmed state');
  state = await ui();
  assert.ok(state.composerText.includes('没有确认送达，评论已保留。') && state.composerText.includes('浏览器或网络阻止了连接到评论服务'), state.composerText);
  const attempts = posts().length;
  assert.ok(attempts >= 1 && attempts <= 2, String(attempts)); assert.equal(backend.comments().length, 1, 'The lost response was handled by the backend');
  assert.equal(await evaluate("document.querySelector('[data-pbc=composer] textarea').readOnly"), true, 'A pending comment cannot change before its retry');
  await clickOuter('[data-pbc=send]');
  await until(async () => !(await ui()).composer, 'the confirmed send');
  state = await ui();
  assert.equal(state.toast, '已发送'); assert.equal(state.badge, '我的评论 1'); assert.equal(state.hint, false);
  const [first, ...retries] = posts();
  assert.equal(retries.length, attempts);
  for (const retry of retries) { assert.equal(retry.headers['idempotency-key'], first.headers['idempotency-key']); assert.equal(retry.body, first.body); }
  assert.match(first.headers['idempotency-key'], /^pc-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(first.headers['x-board-visitor'], /^[a-f0-9]{64}$/); assert.equal(first.headers.origin, origin); assert.equal(first.headers.cookie, undefined); assert.equal(first.headers.referer, undefined);
  const rich = comments.fixture.post.accepted.find(item => item.name === 'rich anchor from a page');
  assert.deepEqual(JSON.parse(first.body), { ...rich.body, authorName: '小王', pageUrl, anchor: { ...rich.body.anchor, releaseId: release.manifest.releaseId } }, 'The page posts the fixture shape: rich anchor, page URL without query or hash');
  assert.deepEqual(Object.keys(JSON.parse(first.body).anchor), Object.keys(rich.body.anchor));
  assert.equal(backend.comments().length, 1, 'The retry was a replay, not a second comment');
  assert.ok(backend.requests.some(request => request.method === 'OPTIONS' && request.path === '/_board/comments'), 'The POST is a real CORS preflighted request');
  assert.equal(backend.requests.filter(request => request.path === '/_board/health').length, 1, 'One health check per page load');
  check('comments page: ⌘/Ctrl+Enter posts Idempotency-Key, X-Board-Visitor and the fixture-shaped rich anchor; a lost response is retried with the same key and payload and becomes one comment');

  // 6. The marker sits at the end of the quote; the secret never reaches the canvas frame.
  await until(async () => (await visibleMarkers()).length === 1, 'the first marker');
  let [marker] = await visibleMarkers();
  assert.equal(marker.n, '1'); assert.equal(marker.label, '我的评论 1：已发送，等待作者查看'); assert.equal(marker.unread, false);
  assert.ok(Math.abs(marker.x - Math.round(quoteBox.right + 1)) <= 2 && Math.abs(marker.y - Math.round(quoteBox.lastTop - 9)) <= 2, JSON.stringify({ marker, quoteBox }));
  const secret = JSON.parse(await visitorRecord()).secret;
  assert.match(secret, /^[a-f0-9]{64}$/);
  const frameMessages = await frame('window.frameMessages.join("\\n")');
  assert.equal(frameMessages.includes(secret), false); assert.ok(frameMessages.includes('comment-threads')); assert.equal(frameMessages.includes('第二步看不懂'), false, 'The frame receives no comment text');
  assert.equal((await frame('document.documentElement.innerHTML')).includes(secret), false);
  check('comments page: the marker sits at the end of the quote, and neither the visitor secret nor comment text reaches the canvas frame');

  // 7. Replies arrive on focus; reply text is rendered literally.
  const [stored] = backend.comments();
  backend.addReply(stored.externalId, '<img src=x onerror="window.pwned=1">谢谢！第二步指的是按周汇总。', 'agent');
  const minesBefore = mineRequests().length;
  await evaluate("window.dispatchEvent(new Event('focus')),true");
  await until(async () => (await ui()).badge === '我的评论 1 · 1 条新回复', 'the new-reply badge');
  assert.equal(mineRequests().length, minesBefore + 1);
  const mine = mineRequests().at(-1);
  assert.equal(mine.headers['x-board-visitor'], secret); assert.equal(new URL('http://x' + mine.path + mine.search).searchParams.get('page'), pageUrl);
  await until(async () => (await visibleMarkers())[0]?.unread, 'the unread marker');
  assert.equal((await visibleMarkers())[0].label, '我的评论 1：已回复');
  await clickOuter('[data-pbc=badge]');
  await until(async () => (await ui()).panel, 'the thread panel');
  state = await ui();
  for (const text of ['我的评论', '“第二步”', '第二步看不懂', '已回复', '作者的 AI 助手回复', '<img src=x onerror="window.pwned=1">谢谢！第二步指的是按周汇总。', '1 条新回复', '清除本机的评论身份']) assert.ok(state.panel.includes(text), text);
  assert.equal(await evaluate("document.querySelectorAll('[data-pbc=panel] img').length"), 0);
  await sleep(200); assert.equal(await evaluate('window.pwned'), undefined); assert.equal(await frame('window.pwned'), undefined);
  assert.equal(state.badge, '我的评论 1', 'Opening the panel marks the replies seen');
  await until(async () => !(await visibleMarkers())[0]?.unread, 'the marker ring to clear');
  await escape(); await until(async () => !(await ui()).panel, 'Esc to close the panel');
  assert.equal(await evaluate("document.activeElement.getAttribute('data-pbc')"), 'badge');
  check('comments page: a focus event polls the visitor\'s own threads; the badge shows 1 条新回复, the panel labels 作者的 AI 助手回复 and renders reply text literally (no script runs)');

  // 8. Storage holds only the anonymous key and the hint flag; thread text lives in sessionStorage.
  const localKeys = JSON.parse(await evaluate('JSON.stringify(Object.keys(localStorage).filter(k=>/comment|visitor/.test(k)))'));
  assert.deepEqual(localKeys.sort(), [`paseo-board-comments-hint:v1`, `paseo-board-visitor:v2:${comments.appKey}`].sort());
  assert.equal(await evaluate("Object.values(localStorage).some(v=>v.includes('第二步')||v.includes('谢谢'))"), false);
  const record = JSON.parse(await visitorRecord());
  assert.deepEqual(Object.keys(record).sort(), ['name', 'pages', 'secret', 'seen']); assert.equal(record.name, '小王');
  for (const text of ['第二步', 'http', '谢谢']) assert.equal(JSON.stringify(record).includes(text), false, text);
  assert.ok((await evaluate(`sessionStorage.getItem(${JSON.stringify(`paseo-board-comments:v2:${comments.appKey}:${pageUrl}`)})`)).includes('第二步看不懂'));
  check('comments page: localStorage keeps only the anonymous visitor key and the hint flag, with no comment, reply, quote or URL; the thread cache is in sessionStorage');

  // 9. A forged frame message cannot open the composer or panel without user activation.
  await waitInactive();
  await frame(`(()=>{const id=/"sessionId":"([a-f0-9]+)"/.exec(document.querySelector('script').textContent)[1],rid=/"releaseId":"(release-[a-f0-9]+)"/.exec(document.querySelector('script').textContent)[1];
    parent.postMessage({channel:'paseo-board-release-v1',releaseId:rid,sessionId:id,type:'comment-target',trigger:'menu',anchor:{selector:'#plain',quote:'Plain'},rect:{x:40,y:40,width:30,height:16}},'*');
    parent.postMessage({channel:'paseo-board-release-v1',releaseId:rid,sessionId:id,type:'comment-open',id:${JSON.stringify(stored.externalId)}},'*');return true})()`);
  await until(async () => (await ui()).float, 'the passive button for a forged target');
  state = await ui(); assert.equal(state.composer, false); assert.equal(state.panel, null);
  check('comments page: without user activation a forged menu target only shows the passive button and a forged marker activation opens nothing');

  // 10. Reload: markers return from the cache and the visitor's threads; a nested scroller keeps its marker attached.
  await reload();
  await until(async () => (await visibleMarkers()).length === 1, 'the marker after reload');
  assert.equal((await ui()).badge, '我的评论 1');
  await until(async () => mineRequests().length > minesBefore + 1, 'the poll after reload');
  await focusFrameAt(); await select('#nested', 'Nested scroller quote'); await until(async () => (await ui()).float, 'the button in the scroller');
  await clickOuter('[data-pbc=float]');
  await until(async () => (await ui()).focus === '评论', 'the composer from the button');
  await command('Input.insertText', { text: '嵌套区域的评论' });
  await clickOuter('[data-pbc=send]');
  await until(async () => (await visibleMarkers()).length === 2, 'the second marker');
  const nestedMarker = async () => (await markers()).find(item => item.n === '2');
  const beforeScroll = await nestedMarker();
  await frame("document.querySelector('#scroller').scrollTop=30,true");
  await until(async () => Math.abs((await nestedMarker()).y - (beforeScroll.y - 30)) <= 1, 'the marker to follow the nested scroll');
  await frame("document.querySelector('#scroller').scrollTop=300,true");
  await until(async () => (await nestedMarker()).hidden, 'the marker to hide when its text scrolls out of the scroller');
  await frame("document.querySelector('#scroller').scrollTop=0,true");
  await until(async () => !(await nestedMarker()).hidden, 'the marker to return');
  check('comments page: markers return after a reload from the session cache and the visitor\'s threads; a marker in a nested scroller follows it and hides when clipped');

  // 11. Keyboard: mouse-drag selection, Shift+ArrowRight, the ContextMenu key, typing, ⌘/Ctrl+Enter.
  const drag = await rect('#plain', 'Plain words');
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.left + 1, y: drag.y });
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.left + 1, y: drag.y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.right - 1, y: drag.y, button: 'left', buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.right - 1, y: drag.y, button: 'left', clickCount: 1 });
  const dragged = await frame('getSelection().toString()');
  assert.ok(dragged.length >= 9, dragged);
  await key('ArrowRight', 'ArrowRight', 39, 8, ['moveRightAndModifySelection']);
  const extended = await frame('getSelection().toString()');
  assert.equal(extended.length, dragged.length + 1, JSON.stringify({ dragged, extended }));
  await key('ContextMenu', 'ContextMenu', 93);
  await until(async () => (await ui()).focus === '评论', 'the composer from the ContextMenu key');
  assert.equal((await ui()).composerText.includes('Shift + 右键'), false);
  await command('Input.insertText', { text: '键盘评论' }); await sendKeys();
  await until(async () => !(await ui()).composer, 'the keyboard send');
  assert.equal(await evaluate('document.activeElement.tagName'), 'IFRAME');
  assert.equal(JSON.parse(posts().at(-1).body).anchor.quote, extended);
  await until(async () => (await ui()).badge === '我的评论 3', 'three threads');
  check('comments page: a mouse-drag selection extended with Shift+ArrowRight opens the composer from the ContextMenu key with focus in the text, sends with ⌘/Ctrl+Enter and returns focus to the canvas');

  // 12. 在页面中定位 scrolls the passage into view; 再评论这段 reuses the anchor; a dropped request is retried from the panel.
  await clickOuter('[data-pbc=badge]'); await until(async () => (await ui()).panel, 'the panel');
  const plainThread = backend.comments().find(row => row.anchor.selector === '#plain').externalId;
  await frame('window.scrollTo(0,700),true');
  await until(async () => (await rect('#plain', 'Plain')).bottom < 0, 'the passage scrolled away');
  await clickOuter(`[data-pbc=thread][data-thread="${plainThread}"] .pbc-row button:first-child`);
  await until(async () => !(await ui()).panel, 'the panel to close for reveal');
  await until(async () => { const box = await rect('#plain', 'Plain'), height = await frame('innerHeight'); return box.top >= 0 && box.bottom <= height; }, 'the passage scrolled into view');
  await frame('window.scrollTo(0,0),true');
  await clickOuter('[data-pbc=badge]'); await until(async () => (await ui()).panel, 'the panel');
  await clickOuter('[data-pbc=thread][data-thread="' + stored.externalId + '"] .pbc-row button:last-child');
  await until(async () => (await ui()).composerText?.includes('“第二步”') && (await ui()).focus === '评论', 'the composer for the same passage');
  await command('Input.insertText', { text: '再说一点' });
  backend.failNext('POST', '/_board/comments', 'drop'); backend.failNext('POST', '/_board/comments', 'drop');
  await clickOuter('[data-pbc=send]');
  await until(async () => (await ui()).send?.label === '重试', 'the dropped request');
  assert.ok((await ui()).composerText.includes('浏览器或网络阻止了连接到评论服务（可能需要允许访问本地网络，或只能在公司网络内评论）。'));
  await escape(); await until(async () => !(await ui()).composer, 'Esc with a pending comment');
  assert.equal((await ui()).badge, '我的评论 4');
  await clickOuter('[data-pbc=badge]'); await until(async () => (await ui()).panel?.includes('没有确认送达'), 'the pending entry');
  await clickOuter('[data-pbc=pending] button');
  await until(async () => (await ui()).badge === '我的评论 4' && !(await ui()).panel?.includes('没有确认送达'), 'the retried comment');
  const again = JSON.parse(posts().at(-1).body).anchor;
  assert.deepEqual({ selector: again.selector, quote: again.quote, start: again.start, end: again.end, releaseId: again.releaseId }, { selector: '#result', quote: '第二步', start: 3, end: 6, releaseId: release.manifest.releaseId });
  await escape();
  check('comments page: 在页面中定位 brings the passage into view; 再评论这段 reuses the anchor; a blocked request is kept, explained, and retried from the panel with the same key');

  // 13. Polling cadence: at least 10 s apart, nothing while hidden, Retry-After honoured with the busy text.
  await reload();
  await until(async () => mineRequests().length > 0 && Date.now() - mineRequests().at(-1).at < 3000, 'the poll after reload');
  const polledAt = mineRequests().at(-1).at, count = mineRequests().length;
  await sleep(800); await evaluate("window.dispatchEvent(new Event('focus')),true"); await sleep(600);
  assert.equal(mineRequests().length, count, 'A focus right after a poll does not poll again');
  await setHidden(true);
  await sleep(Math.max(0, polledAt + 10500 - Date.now()));
  await evaluate("window.dispatchEvent(new Event('focus')),true"); await sleep(800);
  assert.equal(mineRequests().length, count, 'A hidden page does not poll');
  backend.failNext('GET', '/_board/comments/mine', { status: 429, headers: { 'Retry-After': '30' } });
  await setHidden(false);
  await until(async () => mineRequests().length === count + 1, 'one poll when the page is visible again', 4000);
  const busyAt = mineRequests().at(-1).at;
  await clickOuter('[data-pbc=badge]');
  await until(async () => (await ui()).panel?.includes('评论服务繁忙，稍后自动重试。'), 'the busy text in the panel');
  await escape();
  await sleep(Math.max(0, busyAt + 10500 - Date.now()));
  await evaluate("window.dispatchEvent(new Event('focus')),true"); await sleep(800);
  assert.equal(mineRequests().length, count + 1, 'Retry-After holds back even a focus poll');
  check('comments page: polls are at least 10 s apart, stop while hidden, resume on return, and a 429 shows the busy text and honours Retry-After');

  // 14. Changed page text makes a thread an orphan: listed in the panel, not on the page.
  files.set(pagePath, comments.changed.files['index.html']);
  try {
    await reload();
    await until(async () => (await ui()).badge?.startsWith('我的评论 4'), 'the threads on the changed page');
    await until(async () => (await markers()).filter(item => item.hidden).length >= 2, 'the orphaned markers to hide');
    await clickOuter('[data-pbc=badge]');
    await until(async () => (await ui()).panel?.includes('原文已修改，页面上找不到这段文字'), 'the orphan note');
    assert.equal(await evaluate(`document.querySelector('[data-thread="${stored.externalId}"]').textContent.includes('在页面中定位')`), false);
    await escape();
  } finally { files.set(pagePath, release.files['index.html']); }
  check('comments page: when the page text changed, the thread stays in the panel as 原文已修改 and has no marker');

  // 15. Identity follows the app key: another address of the same app keeps threads; a different app disables sending.
  files.set(pagePath, comments.viaMoved.files['index.html']);
  try {
    moved.requests.length = 0;
    await reload();
    await until(async () => mineRequests(moved).length > 0, 'a poll at the moved address');
    assert.ok(mineRequests(moved)[0].path.startsWith('/api/'), 'The path prefix is used');
    assert.equal(mineRequests(moved)[0].headers['x-board-visitor'], secret);
    await until(async () => (await visibleMarkers()).length >= 2, 'the markers at the moved address');
    assert.ok((await ui()).badge.startsWith('我的评论 4'));
  } finally { files.set(pagePath, release.files['index.html']); }
  files.set('/comments-other/', comments.otherApp.files['index.html']);
  other.requests.length = 0;
  await open('/comments-other/');
  await sleep(1200); assert.deepEqual(other.requests, [], 'No request on a page without this visitor\'s threads');
  await focusFrameAt(); await select('#plain', 'Plain words'); await until(async () => (await ui()).float, 'the button');
  await clickOuter('[data-pbc=float]'); await until(async () => (await ui()).focus === '评论', 'the composer');
  await command('Input.insertText', { text: '不会发送' }); await clickOuter('[data-pbc=send]');
  await until(async () => (await ui()).composerText?.includes('评论服务暂时不可用（地址指向了其他服务，或后端版本过旧）。'), 'the unavailable text');
  assert.equal((await ui()).send.disabled, true); assert.equal(posts(other).length, 0);
  check('comments page: an API base with a path prefix at another address of the same app keeps the visitor\'s threads; a backend reporting another app key disables sending');

  // 16. 清除本机的评论身份 removes the key and the session cache.
  await open(pagePath);
  await until(async () => (await ui()).badge?.startsWith('我的评论'), 'the badge');
  await clickOuter('[data-pbc=badge]'); await until(async () => (await ui()).panel, 'the panel');
  await clickOuter('[data-pbc=forget]');
  await until(async () => (await ui()).panel?.includes('清除后，这个浏览器将看不到你之前在这个评论服务留下的评论和回复。确定清除？'), 'the confirmation');
  await clickOuter('[data-pbc=forget-confirm]');
  await until(async () => (await ui()).badge === null, 'the badge to disappear');
  assert.equal(await visitorRecord(), null);
  assert.equal(await evaluate(`Object.keys(sessionStorage).some(k=>k.startsWith(${JSON.stringify('paseo-board-comments:v2:' + comments.appKey)}))`), false);
  await until(async () => (await markers()).length === 0, 'the markers to clear');
  check('comments page: 清除本机的评论身份 removes the visitor key and the session cache');

  // 17. Authored backend flows keep working inside a comments release.
  backend.requests.length = 0;
  await frame("document.querySelector('#comments-form textarea').value='Authored form comment';document.querySelector('#comments-form button').click();true");
  await until(async () => posts().length === 1, 'the authored form POST');
  assert.equal(posts()[0].headers['x-board-visitor'], undefined); assert.match(posts()[0].headers['idempotency-key'], /^[\da-f-]{36}$/);
  await until(() => frame("document.querySelector('#comments-form [role=status]').textContent.includes('已进入内部收件箱')"), 'the authored receipt');
  await click('#api-probe');
  assert.equal(await until(() => frame('window.apiProbe'), 'board.request'), comments.appKey);
  check('comments page: authored board.request and mountComments still work inside a comments release');

  return { markers, ui, select, until, clickOuter, mouse, rect, waitInactive, escape };
}

/** Preview, live + comments and touch, after the main flow (they change the viewport or the visited page). */
export async function runCommentsExtraChecks({ assert, command, evaluate, frame, open, contextWhere, comments, check, helpers }) {
  const { backend } = comments, { until, clickOuter, mouse, rect, select, waitInactive, escape } = helpers;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Preview: the opaque host preview shows the UI but never contacts the backend.
  const before = backend.requests.length;
  await open('/comments-preview');
  await select('#result', '第二步');
  const shell = await until(() => contextWhere("Boolean(document.querySelector('[data-pbc=float]')&&!document.querySelector('[data-pbc=float]').hidden)"), 'the preview button');
  const at = await evaluate("(()=>{const r=document.querySelector('[data-pbc=float]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()", shell);
  const offset = await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return{x:r.left,y:r.top}})()");
  await mouse(offset.x + at.x, offset.y + at.y);
  await until(() => evaluate("Boolean(document.querySelector('[data-pbc=composer]'))", shell), 'the preview composer');
  assert.equal(await evaluate("document.querySelector('[data-pbc=send]').disabled", shell), true);
  assert.ok((await evaluate("document.querySelector('[data-pbc=composer]').textContent", shell)).includes('预览不连接评论后端，发布后才能发送。'));
  assert.equal(await evaluate("document.querySelector('[data-pbc=badge]').hidden", shell), true);
  await sleep(300); assert.equal(backend.requests.length, before, 'The preview never contacts the comment backend');
  check('comments preview: the opaque host preview opens the composer with sending disabled and the preview text, and never contacts the backend');

  // Live + comments in one viewer 4 page: both run; the badge stays clear of the live banner.
  await open('/comments-live/');
  assert.equal(await frame('window.liveState'), 'unavailable');
  await until(() => evaluate("!document.querySelector('[data-live]').hidden"), 'the live banner');
  await select('#live-text', 'Live and comments'); await until(async () => (await helpers.ui()).float, 'the button on the live page');
  await clickOuter('[data-pbc=float]'); await until(async () => (await helpers.ui()).focus === '评论', 'the composer on the live page');
  await command('Input.insertText', { text: '实时页面上的评论' }); await clickOuter('[data-pbc=send]');
  await until(async () => (await helpers.ui()).badge === '我的评论 1', 'the badge on the live page');
  const overlap = await evaluate("(()=>{const a=document.querySelector('[data-pbc=badge]').getBoundingClientRect(),b=document.querySelector('[data-live]').getBoundingClientRect();return a.right>b.left&&b.right>a.left&&a.bottom>b.top&&b.bottom>a.top})()");
  assert.equal(overlap, false, 'The badge never covers the live banner');
  assert.equal(await until(async () => (await helpers.markers()).filter(item => !item.hidden).length === 1, 'the live-page marker'), true);
  check('live + comments: a viewer 4 page runs live polling and comments together without script errors, and the badge stays clear of the live banner');

  // Touch: a long-press, then a selection, shows the button without activation; a tap opens a sheet above the keyboard.
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 760, deviceScaleFactor: 2, mobile: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  try {
    await open('/comments/');
    const word = await rect('#plain', 'Plain');
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: word.x, y: word.y }] });
    await sleep(700);
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await waitInactive();
    await select('#plain', 'Plain words');
    await until(async () => (await helpers.ui()).float, 'the touch button');
    const button = await evaluate("(()=>{const r=document.querySelector('[data-pbc=float]').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,top:r.top}})()");
    const words = await rect('#plain', 'Plain words');
    assert.ok(button.top >= words.bottom, 'On touch the button sits below the selection, away from the native callout');
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: button.x, y: button.y }] });
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until(async () => (await helpers.ui()).sheet, 'the bottom sheet');
    const sheet = await evaluate("(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>420});visualViewport.dispatchEvent(new Event('resize'));const n=document.querySelector('[data-pbc=composer]');return{bottom:n.style.bottom,rect:n.getBoundingClientRect().bottom,inner:innerHeight}})()");
    assert.equal(sheet.bottom, `${sheet.inner - 420}px`); assert.ok(sheet.rect <= 420.5, JSON.stringify(sheet));
    await escape();
  } finally {
    await command('Emulation.setTouchEmulationEnabled', { enabled: false });
    await command('Emulation.clearDeviceMetricsOverride');
  }
  check('comments touch: after a long-press, a selection shows the passive button below it without activation; a tap opens the bottom sheet, which stays above a smaller visual viewport');
}
