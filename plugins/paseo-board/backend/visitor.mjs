// Optional visitor UI. Import into an authored page; customize its markup/classes or replace it freely.
export function mountComments(element, { apiBase = '', pageUrl, anchor } = {}) {
  const document = element.ownerDocument, browser = document.defaultView || globalThis;
  const endpoint = new URL(`${apiBase.replace(/\/$/, '')}/_board/comments`, document.baseURI || globalThis.location?.href);
  if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('Comment API must use HTTP(S)');
  const form = document.createElement('form'); form.className = 'board-comments';
  const note = document.createElement('p'); note.textContent = '评论进入此 Board 的内部收件箱。姓名为自报；提交不会自动获得公开回复。';
  const author = document.createElement('input'); author.name = 'authorName'; author.maxLength = 160; author.setAttribute('aria-label', '你的称呼（可选，自报）'); author.placeholder = '你的称呼（可选，自报）';
  const text = document.createElement('textarea'); text.name = 'comment'; text.maxLength = 8000; text.required = true; text.setAttribute('aria-label', '评论'); text.placeholder = '写下评论';
  const send = document.createElement('button'); send.type = 'submit'; send.textContent = '提交评论';
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  form.append(note, author, text, send, status); element.append(form);
  const storageKey = `board-comment-intent:${endpoint.href}:${pageUrl || ''}:${JSON.stringify(anchor || {})}`;
  let pending, busy = false, destroyed = false;
  const persist = () => { try { if (pending) browser.sessionStorage?.setItem(storageKey, JSON.stringify(pending)); else browser.sessionStorage?.removeItem(storageKey); } catch {} };
  try {
    const stored = JSON.parse(browser.sessionStorage?.getItem(storageKey) || 'null');
    if (stored && /^[\da-f-]{36}$/.test(stored.key) && typeof stored.payload?.text === 'string' && stored.payload.text.length <= 8000) pending = stored;
  } catch {}
  function refresh() {
    text.readOnly = author.readOnly = Boolean(pending); send.disabled = busy;
    send.textContent = busy ? '正在提交…' : pending ? '重试这条评论' : '提交评论';
    if (pending) { text.value = pending.payload.text; author.value = pending.payload.authorName || ''; }
  }
  if (pending) { status.textContent = '上一条评论尚未确认送达。点击重试会复用原评论编号，避免重复提交。'; refresh(); }
  async function submit(event) {
    event.preventDefault(); if (busy || destroyed) return;
    if (!pending) {
      const content = text.value.trim(); if (!content || content.length > 8000 || author.value.length > 160) { status.textContent = '请输入1–8000字评论；称呼最多160字。'; return; }
      pending = { key: globalThis.crypto.randomUUID(), payload: { text: content, ...(author.value.trim() ? { authorName: author.value.trim() } : {}), ...(pageUrl ? { pageUrl } : {}), ...(anchor ? { anchor } : {}) } };
      persist();
    }
    busy = true; refresh(); status.textContent = '正在提交到内部收件箱…';
    try {
      const response = await fetch(endpoint.href, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': pending.key }, body: JSON.stringify(pending.payload) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (typeof result.comment?.externalId !== 'string' || result.comment.text !== pending.payload.text) throw new Error('未取得匹配的提交回执');
      pending = undefined; persist(); text.value = ''; author.value = ''; status.textContent = '已进入内部收件箱。是否由 agent 读取和处理由 Board 所有者决定。';
    } catch (error) { status.textContent = `尚未确认送达，原评论已保留。重试不会创建另一条评论。${error.message}`; }
    finally { busy = false; if (!destroyed) refresh(); }
  }
  form.addEventListener('submit', submit);
  return { form, destroy() { destroyed = true; form.removeEventListener('submit', submit); form.remove(); } };
}
