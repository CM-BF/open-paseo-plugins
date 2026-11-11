import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { loadApp } from '../backend/files.mjs';
import { initializeApp } from '../backend/scaffold.mjs';
import { startApp } from '../backend/server.mjs';

// A real backend behind a transparent counting proxy, so the checks see every poll exactly as the browser sends it.
// Everything is on loopback; the backend, the page and the visitor profile are all temporary.
export async function createLiveFixture({ buildRelease, options, origin, temporary, LiveDataPublisher }) {
  const token = 'l'.repeat(48), channel = `c${'a'.repeat(32)}`, burstChannel = `c${'b'.repeat(32)}`, unknownChannel = `c${'e'.repeat(32)}`;
  const previousToken = process.env.BOARD_LIVE_WRITE_TOKEN;
  process.env.BOARD_LIVE_WRITE_TOKEN = token;
  const root = join(await realpath(temporary), 'live-app'); await mkdir(root); await initializeApp(root, 'live-browser');
  const config = JSON.parse(await readFile(join(root, 'board-app.json'), 'utf8'));
  await writeFile(join(root, 'board-app.json'), JSON.stringify({ ...config, port: 0, origins: [origin] }));
  const app = await loadApp(root);
  let backend = await startApp(app), down = false;
  const log = [];
  const proxy = http.createServer((request, response) => {
    if (down) { request.socket.destroy(); return; }
    const entry = { t: Date.now(), method: request.method, url: request.url, headers: { ...request.headers }, status: 0, responseHeaders: {} };
    log.push(entry);
    const upstream = http.request({ host: '127.0.0.1', port: backend.port, method: request.method, path: request.url, headers: request.headers }, reply => {
      entry.status = reply.statusCode; entry.responseHeaders = { ...reply.headers };
      response.writeHead(reply.statusCode, reply.headers); reply.pipe(response);
    });
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
  const health = await (await fetch(`http://127.0.0.1:${backend.port}/_board/health`)).json();
  const html = `<style>body{font:16px system-ui;margin:24px}</style><main id="label"></main>
<script>
window.boots=(window.boots||0)+1;window.firstData=board.getData();window.firstContext=board.getContext();
window.watchLog=[];window.objLog=[];window.dataLog=[];window.eventCount=0;
board.watch('/live/label',(value,meta)=>{watchLog.push({value,meta});document.querySelector('#label').textContent=value===undefined?'':value});
board.watch('/live/obj',value=>objLog.push(value));
board.onData(value=>dataLog.push(value));
window.addEventListener('board:data',()=>window.eventCount++);
window.ready=true;
</script>`;
  const source = { ...options.board, canvas: { ...options.board.canvas, html, patches: [], data: { secret: 'PRIVATE_CANVAS_DATA' } } };
  const paths = ['/live/items', '/live/label', '/live/obj'];
  const publicData = { frozen: 'kept', live: { label: 'frozen label', items: [0], obj: { x: 0 } } };
  const buildFor = channelId => buildRelease({ ...options, board: source, publicData, apiOrigins: [proxyOrigin], live: { origin: proxyOrigin, channelId, paths } });
  const release = buildFor(channel), unavailableRelease = buildFor(unknownChannel);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const url = target => `http://127.0.0.1:${backend.port}/_board/live/${target}`;
  const digestOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const put = async (seq, value, target = channel) => {
    const response = await fetch(url(target), { method: 'PUT', headers, body: JSON.stringify({ deploymentId: health.deploymentId, seq, digest: digestOf(value), value }) });
    if (response.status !== 200) throw new Error(`PUT seq ${seq} failed: ${response.status} ${await response.text()}`);
  };
  const clear = async seq => { const response = await fetch(`${url(channel)}?seq=${seq}`, { method: 'DELETE', headers }); if (response.status !== 200) throw new Error(`DELETE failed: ${response.status}`); };
  /** Drives the real read budget over its limit from Node, bypassing the proxy so the page's own polls stay countable. */
  const burst = durationMs => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 64 }), end = Date.now() + durationMs;
    // Whole documents spend the budget fast, but only single-cost polls fill the last few points: a 1-point poll fits in any remainder.
    const unchanged = `?v=${health.deploymentId.slice(0, 8)}.1`;
    const one = index => new Promise(resolve => {
      const request = http.get({ host: '127.0.0.1', port: backend.port, path: `/_board/live/${burstChannel}${index % 2 ? unchanged : ''}`, agent, headers: { 'accept-encoding': 'identity' } }, reply => { reply.resume(); reply.on('end', resolve); reply.on('error', resolve); });
      request.on('error', resolve);
    });
    return (async () => { while (Date.now() < end) await Promise.all(Array.from({ length: 64 }, (_, index) => one(index))); agent.destroy(); })();
  };
  const close = async () => {
    await backend.close(); await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections?.(); });
    if (previousToken === undefined) delete process.env.BOARD_LIVE_WRITE_TOKEN; else process.env.BOARD_LIVE_WRITE_TOKEN = previousToken;
  };
  return {
    token, channel, burstChannel, unknownChannel, release, unavailableRelease, proxyOrigin, log, health, put, clear, burst, close, LiveDataPublisher,
    setDown: value => { down = value; if (value) proxy.closeAllConnections?.(); },
    restart: async () => { await backend.close(); backend = await startApp(app); return Date.now(); },
    healthUrl: () => `http://127.0.0.1:${backend.port}`,
  };
}

export async function runLiveChecks({ assert, frame, evaluate, open, openAt, setHidden, nestedBanner, live, check, pagePort }) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (read, label, ms = 12000) => {
    const deadline = Date.now() + ms;
    for (;;) { const value = await read().catch(() => undefined); if (value) return value; if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`); await sleep(40); }
  };
  const banner = () => evaluate("({text:document.querySelector('[data-live]').textContent,hidden:document.querySelector('[data-live]').hidden})");
  const bannerMatching = (pattern, ms) => until(async () => { const value = await banner(); return !value.hidden && pattern.test(value.text) ? value : undefined; }, `banner ${pattern}`, ms);
  const bannerGone = ms => until(async () => (await banner()).hidden, 'banner to clear', ms);
  const polls = since => live.log.slice(since).filter(entry => entry.method === 'GET' && entry.url.startsWith(`/_board/live/${live.channel}`));
  const values = (label, extra = {}) => ({ '/live/label': label, '/live/items': [1, 2], '/live/obj': { x: 1, y: 2 }, ...extra });

  await live.put(1, values('first'));
  const tokenFree = JSON.stringify([live.release.files, live.unavailableRelease.files]);
  assert.equal(tokenFree.includes(live.token), false, 'The write token must not reach a release');
  assert.equal(tokenFree.includes('PRIVATE_CANVAS_DATA'), false);
  await open('/live/');
  assert.deepEqual(await frame('window.firstData.live'), { label: 'first', items: [1, 2], obj: { x: 1, y: 2 } });
  assert.equal(await frame('window.firstData.frozen'), 'kept');
  assert.deepEqual(await frame('window.firstContext.live.state'), 'live');
  assert.equal(await frame("document.querySelector('#label').textContent"), 'first');
  assert.equal((await banner()).hidden, true);
  check('live page: the boot gate applies the first document before authored code');

  const manifestRequest = live.log.find(entry => entry.url.startsWith(`/_board/live/${live.channel}`));
  assert.equal(manifestRequest.headers.origin, await evaluate('location.origin'), 'Polls carry the real page origin');
  assert.equal(manifestRequest.headers.authorization, undefined); assert.equal(manifestRequest.headers.cookie, undefined); assert.equal(manifestRequest.headers.referer, undefined);
  assert.equal(manifestRequest.url, `/_board/live/${live.channel}`);

  await live.put(2, values('second', { '/outside/secret': 'must stay out' }));
  await until(() => frame("window.watchLog.length>=2"), 'the update to reach the page');
  assert.deepEqual(await frame("board.getData().live.label"), 'second');
  assert.equal(await frame('board.getData().outside'), undefined, 'A path outside the release is ignored');
  assert.deepEqual(await frame('window.watchLog[1].meta'), { path: '/live/label', exists: true, boardRevision: 1, canvasRevision: 3 });
  assert.equal(await frame('window.dataLog.length'), 1); assert.equal(await frame('window.eventCount'), 1);
  assert.equal(await frame('window.objLog.length'), 1, 'An unchanged object must not fire its watcher');
  assert.equal(await frame('window.boots'), 1, 'The update needs no reload');
  check('live page: getData, watch, onData and board:data update with no reload, and only frozen paths are accepted');

  await live.put(3, { '/live/items': [1, 2], '/live/label': 'second', '/live/obj': { y: 2, x: 1 } });
  await until(() => frame('board.getContext().canvasRevision===4'), 'the reordered document to arrive');
  assert.equal(await frame('window.watchLog.length'), 2); assert.equal(await frame('window.objLog.length'), 1); assert.equal(await frame('window.dataLog.length'), 1); assert.equal(await frame('window.eventCount'), 1);
  check('live page: a key reorder is not a change and fires nothing');

  let mark = live.log.length;
  await sleep(7000);
  const idle = polls(mark);
  assert.ok(idle.length >= 1, 'The page keeps polling while idle');
  for (const poll of idle) { assert.equal(poll.status, 204, JSON.stringify(poll)); assert.match(poll.url, /\?v=/); assert.match(poll.responseHeaders['board-live'], /f=1/); }
  assert.deepEqual(live.log.filter(entry => entry.method === 'OPTIONS'), [], 'Polls must not preflight');
  check('live page: an idle page is 204-only traffic with no preflight');

  await setHidden(true); await sleep(500); mark = live.log.length; await sleep(7000);
  assert.equal(live.log.length, mark, 'A hidden tab sends zero requests');
  await setHidden(false);
  await until(async () => polls(mark).length > 0, 'one poll when the tab returns', 3000);
  check('live page: a hidden tab polls zero times at the server and checks once on return');

  await live.put(1, { '/big': 'x'.repeat(59000) }, live.burstChannel);
  mark = live.log.length;
  const bursting = live.burst(14000);
  const direct = await evaluate(`(async()=>{const deadline=Date.now()+8000;while(Date.now()<deadline){const r=await fetch(${JSON.stringify(`${live.proxyOrigin}/_board/live/${live.channel}`)},{cache:'no-store'});if(r.status===429)return{status:r.status,retryAfter:r.headers.get('retry-after')};await new Promise(r=>setTimeout(r,30))}return{status:'none'}})()`);
  assert.equal(direct.status, 429, JSON.stringify(direct));
  assert.match(String(direct.retryAfter), /^\d+$/, 'Retry-After must be readable by page JavaScript through CORS');
  check(`live backend: a real 429 exposes Retry-After to browser JavaScript (${direct.retryAfter} s)`);
  const viewer429 = await until(async () => polls(mark).filter(entry => entry.status === 429 && entry.url.includes('?v=')).at(-1), 'a viewer poll to hit the 429', 16000);
  await bursting;
  await until(async () => polls(live.log.indexOf(viewer429) + 1).some(entry => entry.status === 204 || entry.status === 200), 'the page to poll again after the 429', 70000);
  const after = polls(live.log.indexOf(viewer429) + 1)[0], waited = after.t - viewer429.t;
  assert.ok(waited >= Number(viewer429.responseHeaders['retry-after']) * 1000 - 300, `The page must honour Retry-After (${viewer429.responseHeaders['retry-after']} s), waited ${waited} ms`);
  check('live page: the viewer honours a real 429 Retry-After');

  const restartedAt = await live.restart();
  // The burst raised the backend's advertised period; a reload picks up the restarted backend's own.
  await open('/live/');
  await until(async () => polls(mark).some(entry => entry.t > restartedAt && entry.responseHeaders['board-live']?.includes('f=g')), 'a post-restart grace poll', 15000);
  assert.equal((await banner()).hidden, true, 'f=g shows no banner');
  check('live page: restart grace f=g shows no staleness banner');

  const refusedOrigin = `http://localhost:${pagePort}`;
  await openAt(`${refusedOrigin}/live/`);
  assert.deepEqual(await frame('window.firstData.live'), { label: 'frozen label', items: [0], obj: { x: 0 } }, 'An origin the backend refuses starts from frozen data');
  await bannerMatching(/^连接不上数据源，显示的是发布时的内容，正在重试。$/, 35000);
  const publisher = new live.LiveDataPublisher(join(process.env.TMPDIR ?? '/tmp', `live-probe-${process.pid}`), { subscribe: () => () => undefined, projectPublic: async (_id, createdAt) => ({ createdAt, canvasRevision: 1, body: '{}', digest: '0'.repeat(64), bytes: 2, overLimit: false, withheld: [], pathBytes: {} }) });
  const owner = await publisher.get({ boardId: 'probe', expectedCreatedAt: new Date().toISOString(), probeOrigin: live.proxyOrigin, pageOrigins: [refusedOrigin, `http://127.0.0.1:${pagePort}`] });
  assert.deepEqual(owner.originProblems, [`把 ${refusedOrigin} 加入 board-app.json 的 origins，然后重新部署。`]);
  await publisher.close();
  check('live page: a refused origin shows the network banner while the owner probe reports the exact origin to allow');

  await until(async () => Date.now() - restartedAt > 46000, 'the grace period to end', 60000);
  await open('/live/');
  await bannerMatching(/^发布者暂时没有推送更新，数据截至 .+，可能不是最新。$/, 10000);
  assert.equal(await frame('board.getData().live.label'), 'second', 'The last good data stays on screen while stale');
  check('live page: a publisher with no heartbeat after the grace period reads stale immediately');
  await live.put(4, values('fresh again'));
  await until(() => frame("board.getData().live.label==='fresh again'"), 'the fresh document after staleness', 12000);
  await bannerGone(12000);
  check('live page: a fresh push clears the staleness banner');

  await open('/live/');
  assert.equal(await frame('window.firstData.live.label'), 'fresh again');
  mark = live.log.length;
  live.setDown(true);
  const downAt = Date.now();
  await open('/live/');
  assert.equal(await frame('window.firstData.live.label'), 'fresh again', 'The last good document survives a reload with the backend down');
  assert.equal(await frame('window.firstContext.live.state'), 'live');
  const network = await bannerMatching(/^连接不上数据源，显示的是 .+ 的数据，正在重试。$/, 40000);
  assert.ok(Date.now() - downAt >= 25000, `The network banner must wait about 30 s, saw ${Date.now() - downAt} ms: ${network.text}`);
  check('live page: the last good document survives a reload with the backend down, and the network banner appears after the threshold');
  live.setDown(false);
  await bannerGone(50000);
  check('live page: the network banner clears when the backend returns');

  await open('/live-unavailable/');
  await bannerMatching(/^实时数据暂不可用，显示的是发布时的内容。$/, 8000);
  check('live page: an unknown channel shows the unavailable banner over frozen content');

  await open('/live/');
  await until(() => frame("board.getData().live.label==='fresh again'"), 'the live document before clearing', 12000);
  await live.clear(9);
  await bannerMatching(/^发布者已停止公开这些数据，显示的是发布时的内容。$/, 12000);
  assert.equal(await frame('board.getData().live.label'), 'frozen label', 'A 410 restores the frozen data');
  assert.deepEqual(await frame('board.getContext().live.state'), 'revoked');
  await until(() => frame("window.watchLog.at(-1).value==='frozen label'"), 'the watch callback for the cleared value', 3000);
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(`paseo-board-live:${live.channel}`)})`), null, 'A 410 removes the local copy');
  mark = live.log.length;
  await sleep(6000);
  assert.equal(polls(mark).length, 0, 'After a 410 the page stops its normal polling');
  await open('/live/');
  assert.equal(await frame('window.firstData.live.label'), 'frozen label', 'A reload after 410 stays on frozen data');
  check('live page: a real 410 drops the overlay, deletes the local copy and leaves only the slow poll');

  await live.put(11, values('re-enabled'));
  await open('/live/');
  assert.equal(await frame('window.firstData.live.label'), 're-enabled', 'A page resumes after re-enable');
  check('live page: a re-enabled channel resumes on the next visit');

  await open('/live-preview');
  await until(async () => /^预览不连接实时数据，显示发布时的内容。$/.test(await nestedBanner()), 'the preview banner', 8000);
  mark = live.log.length; await sleep(1500);
  assert.equal(polls(mark).length, 0, 'The isolated preview never polls');
  check('live page: the opaque preview shows its banner and never polls');

  assert.deepEqual(live.log.filter(entry => entry.method === 'OPTIONS'), [], 'No poll ever preflighted');
  assert.equal(JSON.stringify(live.log).includes(live.token), false, 'The write token never crossed the proxy on a browser request');
}
