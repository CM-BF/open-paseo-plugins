import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadApp } from '../backend/files.mjs';
import { initializeApp } from '../backend/scaffold.mjs';
import { startApp } from '../backend/server.mjs';

// The owner panel against the real publisher, real projection and a real local backend.
// The Board is the adapted host fixture; GitHub stays the adapter in release-host-test.mjs.
// The backend is reached as an HTTPS origin mapped to loopback, because the real share
// handlers refuse a loopback live origin on a public site.
export async function createLiveHostBackend({ temporary, pageOrigin, currentBoard, setBoard, LiveDataPublisher, projectLive }) {
  const token = 'h'.repeat(48), previousToken = process.env.BOARD_LIVE_WRITE_TOKEN;
  process.env.BOARD_LIVE_WRITE_TOKEN = token;
  const root = join(await realpath(temporary), 'live-host-app'); await mkdir(root); await initializeApp(root, 'live-host');
  const config = JSON.parse(await readFile(join(root, 'board-app.json'), 'utf8'));
  await writeFile(join(root, 'board-app.json'), JSON.stringify({ ...config, port: 0, origins: [pageOrigin] }));
  const backend = await startApp(await loadApp(root));
  const loopbackOrigin = `http://127.0.0.1:${backend.port}`, origin = 'https://live.example.test', listeners = new Set(), outputs = [], directory = join(temporary, 'live-plugin');
  let mode = 'ok';
  const fetcher = (url, init) => {
    if (mode === 'down') return Promise.reject(new TypeError('fixture backend unreachable'));
    if (mode === 'reject' && init?.method === 'PUT') return Promise.resolve(new Response('{"error":"unauthorized"}', { status: 401 }));
    return fetch(String(url).replace(origin, loopbackOrigin), init);
  };
  const store = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async projectPublic(boardId, expected, marks) {
      const board = currentBoard();
      if (board?.id !== boardId) return null;
      return { createdAt: board.createdAt, canvasRevision: board.canvas.revision, ...(board.createdAt === expected ? projectLive(board.canvas.data, marks) : { bytes: 0, overLimit: false, withheld: [], pathBytes: {} }) };
    },
  };
  const publisher = new LiveDataPublisher(directory, store, { fetcher });
  await publisher.start();
  return {
    origin, loopbackOrigin, token, directory, publisher,
    rpc: async (name, input) => { const value = await (name === 'board.live.get' ? publisher.get(input) : publisher.set(input)); outputs.push(value); return value; },
    outputs,
    notify: board => { setBoard(board); for (const listener of listeners) listener({ summary: { id: board.id, createdAt: board.createdAt }, canvasRevision: board.canvas.revision }); },
    setMode: value => { mode = value; },
    read: async channelId => { const response = await fetch(`${loopbackOrigin}/_board/live/${channelId}`, { headers: { 'accept-encoding': 'identity' } }); return { status: response.status, body: response.status === 200 ? await response.json() : undefined }; },
    channelFiles: async () => { const names = (await readdir(join(directory, 'live-data'))).filter(name => name.endsWith('.json') && !name.endsWith('.journal.json')); return Promise.all(names.map(name => readFile(join(directory, 'live-data', name), 'utf8'))); },
    close: async () => { await publisher.close(); await backend.close(); if (previousToken === undefined) delete process.env.BOARD_LIVE_WRITE_TOKEN; else process.env.BOARD_LIVE_WRITE_TOKEN = previousToken; },
  };
}

export async function runLiveHostChecks({ assert, command, evaluate, until, click, replace, button, check, pageOrigin, live, calls, repository, jobs, loadPage }) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const test = id => `[data-testid=${JSON.stringify(id)}]`;
  const panel = test('board-live-panel'), confirmButton = test('board-live-confirm'), ack = test('board-live-ack'), statusBox = test('board-live-status');
  const field = path => test(`board-live-field-${path}`), subtree = path => test(`board-live-subtree-${path}`);
  const live_ = { live: { score: 1, label: 'visible label' }, meta: { note: 'nested' }, PRIVATE_DATA: 'PRIVATE_LIVE_SECRET' };
  const count = name => calls.filter(item => item.name === name).length;
  const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
  const disabled = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).disabled`);
  const checked = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked')==='true'`);
  const contains = (selector, value) => `document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(value)})`;
  const openLive = async () => { await click('[data-testid="board-more-open"]'); await click(test('board-live-open')); await until(`document.querySelector(${JSON.stringify(panel)})`); };
  const openRelease = async () => { await click('[data-testid="board-more-open"]'); await click(button('导出与发布')); await until("document.querySelector('[data-testid=board-release-panel]')"); };
  const closeModal = () => click(button('关闭窗口'));
  const setData = async value => { await evaluate(`hostFixture.setCanvasData(${JSON.stringify(value)});true`); live.notify(await evaluate('hostFixture.board()')); };
  const lastSet = () => calls.filter(item => item.name === 'board.live.set').at(-1).input;

  await loadPage(() => command('Page.navigate', { url: `${pageOrigin}/?drafts=1&board=live-fixture` }));
  await setData(live_);
  await evaluate('new Promise(resolve=>setTimeout(resolve,50))');
  const setsAtStart = count('board.live.set');
  await openRelease();
  assert.equal(await disabled(test('board-release-live-toggle')), true);
  assert.ok(await evaluate(contains(test('board-release-live'), '尚未连接后端')));
  await closeModal(); await until("!document.querySelector('[data-testid=board-release-panel]')");
  await openLive();
  assert.equal(await evaluate("document.querySelector('[data-fixture-modal]').getAttribute('aria-label')"), '实时公开数据');
  assert.equal(await disabled(confirmButton), true);
  assert.equal(count('board.live.set'), setsAtStart, 'Opening the panel never writes');
  check('With no channel the release switch is disabled with its reason; More opens the isolated live panel with confirm locked and no write');

  await click(field('/live/score'));
  await click(field('/meta'));
  await until(`${contains(test('board-live-preview'), '"/live/score": 1')}&&${contains(test('board-live-preview'), '路径名本身也会公开')}`);
  const firstPreview = await text(test('board-live-preview'));
  assert.ok(firstPreview.includes('/meta：这里是对象或含对象的数组'), firstPreview);
  assert.ok(!firstPreview.includes('PRIVATE_LIVE_SECRET'), 'Unmarked data never appears in the preview');
  assert.ok(!firstPreview.includes('nested'), 'A withheld object is not previewed');
  assert.equal(await disabled(ack), true, 'Consent needs a probed backend');
  await replace(test('board-live-origin'), live.loopbackOrigin);
  await click(test('board-live-probe'));
  await until(`${contains(panel, '部署 ID：')}&&${contains(panel, '仅本机可见，仅用于测试')}`);
  await replace(test('board-live-origin'), live.origin);
  await click(test('board-live-probe'));
  await until(`${contains(panel, '部署 ID：')}&&!${contains(panel, '仅本机可见，仅用于测试')}`);
  await until(`!document.querySelector(${JSON.stringify(ack)}).disabled`);
  await replace(test('board-live-token'), live.token);
  await click(subtree('/meta'));
  await until(`${contains(test('board-live-preview'), '"/meta"')}&&${contains(test('board-live-preview'), 'nested')}`);
  assert.equal(await disabled(confirmButton), true, 'The confirm button needs the consent tick');
  await click(ack); await until(`!document.querySelector(${JSON.stringify(confirmButton)}).disabled`);
  await click(subtree('/meta'));
  await until(`document.querySelector(${JSON.stringify(ack)}).getAttribute('aria-checked')==='false'&&document.querySelector(${JSON.stringify(confirmButton)}).disabled`);
  await click(subtree('/meta'));
  await until(`${contains(test('board-live-preview'), 'nested')}&&!document.querySelector(${JSON.stringify(ack)}).disabled`);
  assert.equal(await checked(ack), false, 'Changing the public set clears the earlier consent');
  assert.equal(count('board.live.set'), setsAtStart, 'Nothing is sent before explicit consent');
  check('Consent gating: exact server preview, withheld objects until the subtree tick, confirm locked without probe, token and tick, and any change of the set clears consent');

  await click(ack); await until(`!document.querySelector(${JSON.stringify(confirmButton)}).disabled`);
  await click(confirmButton);
  await until(contains(statusBox, '实时公开中'), 15000);
  const upsert = lastSet();
  assert.equal(upsert.action, 'upsert'); assert.equal(upsert.acknowledgedPublic, true); assert.equal(upsert.tokenSent, true); assert.equal(upsert.expectedEventId, null); assert.equal(upsert.token, undefined);
  assert.deepEqual(upsert.marks.map(mark => [mark.path, mark.subtree]).sort(), [['/live/score', false], ['/meta', true]]);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(test('board-live-token'))}).value`), '', 'The token leaves the field after it is sent');
  const channelId = live.outputs.at(-1).channel.channelId;
  const served = await live.read(channelId);
  assert.equal(served.status, 200); assert.deepEqual(served.body.values, { '/live/score': 1, '/meta': { note: 'nested' } });
  assert.ok(!JSON.stringify(served.body).includes('PRIVATE_LIVE_SECRET') && !JSON.stringify(served.body).includes('visible label'));
  assert.ok(await evaluate(contains(statusBox, '最后推送 #1')));
  check('Confirming connects the real backend: the exact marked values are served, unmarked data stays home and the token field is cleared');

  await closeModal(); await until(`!document.querySelector(${JSON.stringify(panel)})`);
  await setData({ ...live_, live: { ...live_.live, score: 2 } });
  for (let attempt = 0; attempt < 200 && (await live.read(channelId)).body?.values['/live/score'] !== 2; attempt++) await sleep(50);
  assert.equal((await live.read(channelId)).body.values['/live/score'], 2);
  await openLive(); await until(contains(statusBox, '最后推送 #2'));
  assert.ok(await evaluate(contains(statusBox, '对应 canvas 版本 r')));
  assert.ok(await evaluate(contains(panel, '公开字段已确认')), 'A confirmed channel with no edits has nothing to re-confirm');
  check('A later value write reaches the backend without another confirmation, and status reports its version');
  await closeModal(); await until(`!document.querySelector(${JSON.stringify(panel)})`);

  await openRelease();
  await until(`!document.querySelector(${JSON.stringify(test('board-release-live-toggle'))}).disabled`);
  await click(test('board-release-live-toggle'));
  await until(contains(test('board-release-live'), '路径已固定在此版本里'));
  assert.ok(await evaluate(contains(test('board-release-live'), live.origin)));
  await replace('[data-testid="board-release-data"]', '{"live":{"score":0}}');
  await until(contains(test('board-release-live'), '发布时内容会在后端不可用时显示'));
  await replace('input[aria-label="发布名称"]', 'Live release fixture');
  await click(button('生成固定版本并预览'));
  await until(`${contains('body', 'Live release fixture · 固定版本')}&&document.querySelector('[data-testid=board-release-preview]')&&${contains('body', '已固定的实时数据')}`);
  const created = calls.filter(item => item.name === 'board.release.create').at(-1).input;
  assert.equal(created.liveData, true); assert.equal(created.live, undefined);
  const liveRelease = (await repository.list('live-fixture')).find(item => item.manifest.title === 'Live release fixture');
  assert.equal(liveRelease.manifest.viewerVersion, 3);
  assert.deepEqual(liveRelease.manifest.live, { origin: live.origin, channelId, paths: ['/live/score', '/meta'] });
  assert.ok(liveRelease.manifest.apiOrigins.includes(live.origin));
  assert.ok(!JSON.stringify(liveRelease).includes(live.token), 'The write token is absent from every release file');
  check('The release switch sends only a boolean; the server fixes channel, origin and paths into a viewer 3 release with no token in any file');

  // The GitHub adapter does not run the loopback publish refusal; publication-rpc.test.ts covers it.
  await click(button('读取 GitHub 账号')); await click(button('fixture-alice · github.com')); await click(button('fixture-alice/site'));
  await click(button('确认预览和数据，可发布此版本')); await click(button('一键发布'));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('已核实上线')", 12000);
  await closeModal(); await until("!document.querySelector('[data-testid=board-release-panel]')");

  await openLive();
  await until(`${contains(statusBox, 'fixture-alice.github.io')}`);
  assert.ok(await evaluate(contains(statusBox, '把 https://fixture-alice.github.io 加入 board-app.json 的 origins')), 'The owner panel reports a share page the backend would refuse');
  check('The owner panel reports a shared page origin the backend refuses, with the exact fix');
  await click(field('/live/label'));
  await until(`${contains(test('board-live-preview'), 'visible label')}&&!document.querySelector(${JSON.stringify(ack)}).disabled`);
  assert.equal(await checked(ack), false);
  await click(ack); await click(confirmButton);
  await until(`${contains(panel, '公开字段已确认')}&&${contains(statusBox, '实时公开中')}`, 15000);
  assert.equal(lastSet().tokenSent, undefined, 'Widening at the same backend keeps the saved token');
  await closeModal(); await until(`!document.querySelector(${JSON.stringify(panel)})`);

  await openRelease();
  await until(`${contains(test('board-share-status'), '+/live/label')}&&document.querySelector(${JSON.stringify(test('board-share-live-adopt'))})`);
  await click(test('board-share-live-adopt'));
  await until("document.querySelector('[data-testid=\"board-share-confirm\"]')&&document.querySelector('[data-testid=board-release-preview]')", 15000);
  const adopt = calls.filter(item => item.name === 'board.release.share-update').at(-1).input;
  assert.equal(adopt.liveMode, 'current');
  assert.ok((await evaluate(`document.querySelector('[data-testid="board-share-confirm"]').parentElement.textContent`)).includes('此次更新采用当前实时配置'));
  const publishes = count('board.pages.publish');
  await click('[data-testid="board-share-confirm"]');
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('已核实上线')", 12000);
  assert.equal(count('board.pages.publish'), publishes + 1);
  const adopted = (await repository.list('live-fixture')).find(item => item.manifest.live?.paths.includes('/live/label'));
  assert.deepEqual(adopted.manifest.live.paths, ['/live/label', '/live/score', '/meta']);
  assert.equal([...jobs.values()].filter(job => job.repository === 'fixture-alice/site').at(-1).releaseId, adopted.manifest.releaseId);
  check('A widened channel appears as share drift even with no authored change; adopting rebuilds with the current paths through the normal preview and confirm');
  await closeModal(); await until("!document.querySelector('[data-testid=board-release-panel]')");

  await openLive();
  await click(test('board-live-pause'));
  await until(contains(statusBox, '已暂停推送'));
  const beforePause = (await live.read(channelId)).body.seq;
  await setData({ ...live_, live: { ...live_.live, score: 3 } });
  await sleep(1200);
  assert.equal((await live.read(channelId)).body.seq, beforePause, 'A paused channel pushes nothing');
  await click(test('board-live-resume'));
  await until(contains(statusBox, '实时公开中'), 15000);
  for (let attempt = 0; attempt < 200 && (await live.read(channelId)).body?.values['/live/score'] !== 3; attempt++) await sleep(50);
  assert.equal((await live.read(channelId)).body.values['/live/score'], 3);
  check('Pause stops pushing while the backend keeps its copy; resume catches up to the current value');

  live.setMode('reject');
  await setData({ ...live_, live: { ...live_.live, score: 4 } });
  await until(contains(statusBox, '已停止推送，需要你处理'), 15000);
  await closeModal(); await until(`!document.querySelector(${JSON.stringify(panel)})`);
  await until("document.querySelector('[data-testid=\"board-share-badge\"]')");
  await click('[data-testid="board-more-open"]');
  assert.ok(await evaluate(contains(test('board-live-open'), '已停止推送，需要你处理')));
  await click('[data-testid="board-more-open"]');
  live.setMode('ok');
  check('A blocked channel raises the existing 更多 dot and explains itself in the menu');
  await openLive();
  await until(`!document.querySelector(${JSON.stringify(ack)}).disabled`);
  await replace(test('board-live-token'), live.token);
  await click(ack); await click(confirmButton);
  await until(contains(statusBox, '实时公开中'), 15000);
  assert.equal(lastSet().tokenSent, true);
  await closeModal(); await until(`!document.querySelector(${JSON.stringify(panel)})&&!document.querySelector('[data-testid="board-share-badge"]')`, 15000);
  check('After a human re-confirms a blocked channel it publishes again and the dot clears');

  await openLive();
  await click(test('board-live-revoke'));
  await until(contains(statusBox, '已停止公开'), 15000);
  assert.equal((await live.read(channelId)).status, 410);
  for (const file of await live.channelFiles()) assert.ok(!file.includes(live.token), 'A confirmed revoke wipes the token');
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(test('board-live-pause'))})`), false);
  await until(`!document.querySelector(${JSON.stringify(ack)}).disabled`);
  await click(ack);
  assert.equal(await disabled(confirmButton), true, 'Re-enabling needs the token again');
  await click(ack);
  check('Revoke clears the backend to 410 and wipes the token; re-enabling requires the token and fresh consent');

  await replace(test('board-live-token'), live.token);
  await until(`!document.querySelector(${JSON.stringify(ack)}).disabled`);
  await click(ack); await click(confirmButton);
  await until(contains(statusBox, '实时公开中'), 15000);
  assert.equal((await live.read(channelId)).status, 200, 'Re-enable continues on the same channel');
  live.setMode('down');
  await click(test('board-live-revoke'));
  await until(`document.querySelector(${JSON.stringify(test('board-live-stop-local'))})`, 15000);
  assert.ok(await evaluate(contains(panel, '正在清除后端副本')));
  assert.equal((await live.read(channelId)).status, 200, 'While the backend is unreachable its copy really remains');
  await click(test('board-live-stop-local'));
  await until(`${contains(statusBox, '已停止公开')}&&${contains(statusBox, '后端副本未清除')}`, 15000);
  for (const file of await live.channelFiles()) assert.ok(!file.includes(live.token), 'Stopping locally wipes the token');
  assert.equal((await live.read(channelId)).status, 200, 'The panel states the copy may remain because it does');
  live.setMode('ok');
  check('When the backend cannot be reached, 仅本机停止 ends retries, wipes the token and states honestly that the copy remains');

  const setsBeforeReload = count('board.live.set');
  await loadPage(() => command('Page.reload', { ignoreCache: true }));
  await openLive(); await until(contains(statusBox, '已停止公开'));
  assert.equal(count('board.live.set'), setsBeforeReload, 'Reload never writes');
  await command('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.ok(await evaluate("(()=>{const p=document.querySelector('[role=dialog]').getBoundingClientRect(),panel=document.querySelector('[data-testid=board-live-panel]').getBoundingClientRect();return p.width>0&&p.left>=0&&p.right<=innerWidth&&panel.right<=p.right+1})()"));
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await closeModal(); await until(`!document.querySelector(${JSON.stringify(panel)})`);
  assert.ok(!JSON.stringify(live.outputs).includes(live.token), 'No RPC output ever carried the token');
  assert.ok(!(await evaluate('document.documentElement.outerHTML')).includes(live.token), 'The token is absent from the page');
  check('Reload writes nothing, the panel fits a compact viewport, and no RPC output or page state carries the token');
}
