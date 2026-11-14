import { appKeyFor, createFakeCommentsBackend } from './comments-fake-backend.mjs';

// The owner's release panel against the real publication handlers and loopback fake comment backends.
// HTTPS addresses are mapped to the fakes by the host fetcher, so address checks see realistic hosts.
export async function createCommentsHostBackend() {
  const main = await createFakeCommentsBackend({ owner: 'host-owner', appId: 'host-comments' });
  const other = await createFakeCommentsBackend({ owner: 'other-owner', appId: 'host-other' });
  const routes = [['https://comments.example.test', main], ['https://comments.corp', main], ['https://other.example.test', other]];
  let down = false;
  const fetcher = async (url, init) => {
    if (down) throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    for (const [base, fake] of routes) if (url.startsWith(base + '/')) return fetch(fake.origin + url.slice(base.length), init);
    return fetch(url, init);
  };
  return { main, other, fetcher, connections: [], setDown: value => { down = value; }, close: () => Promise.all([main.close(), other.close()]) };
}

export async function runCommentsHostChecks({ assert, command, evaluate, until, click, replace, button, check, pageOrigin, comments, calls, repository, loadPage }) {
  const { main, other } = comments;
  const test = id => `[data-testid=${JSON.stringify(id)}]`;
  const contains = (selector, value) => `(document.querySelector(${JSON.stringify(selector)})?.textContent??'').includes(${JSON.stringify(value)})`;
  const has = selector => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const block = test('board-release-comments'), probe = test('board-release-comments-probe'), input = test('board-release-comments-origin');
  const count = name => calls.filter(item => item.name === name).length;
  const openRelease = async () => { await click('[data-testid="board-more-open"]'); await click(button('导出与发布')); await until("document.querySelector('[data-testid=board-release-panel]')"); };
  const recheck = async expected => { await click(test('board-release-comments-check')); await until(contains(probe, expected)); };
  const generate = () => click(button('生成固定版本并预览'));
  const OFF = '开启后，访客可以在发布页上选中文字，右键或点「评论」留言，并看到你的回复。评论保存在你部署的后端里。';
  const HELP = '评论发送到这个后端（需要 comments.enabled），并由本 Board 的「评论收件箱」自动同步。地址由你部署和决定；要在 board-app.json 的 origins 里加入发布网站的地址。';
  const NOT_CONNECTED = '这个后端还没有连接到本 Board 的评论收件箱，评论不会自动同步。';

  comments.connections.splice(0, comments.connections.length,
    { sourceId: 'disabled-source', deploymentId: 'dep-0', label: '停用的来源', endpoint: 'https://disabled.example.test/_board/comments', enabled: false, state: 'ready', eventId: 'evt-0' },
    { sourceId: 'comments-source', deploymentId: 'dep-1', label: '评论后端', endpoint: 'https://comments.example.test/_board/comments', enabled: true, state: 'ready', eventId: 'evt-1' });
  await loadPage(() => command('Page.navigate', { url: `${pageOrigin}/?drafts=1&board=comments-fixture` }));
  await openRelease();
  assert.ok(await evaluate(contains(block, '访客可以框选评论')) && await evaluate(contains(block, OFF)));
  assert.equal(await has(input), false);
  await click(test('board-release-comments-toggle'));
  await until(`document.querySelector(${JSON.stringify(input)})?.value==='https://comments.example.test'`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(input)}).getAttribute('aria-label')`), '评论后端地址');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(input)}).placeholder`), 'https://api.example.internal');
  for (const text of [HELP, '同一网站地址（发布网站）下的其他页面能读取访客浏览器里的匿名评论编号。GitHub 的 github.io 地址由同一用户或组织的所有仓库共享；企业版 Pages 可能由所有人共享。']) assert.ok(await evaluate(contains(block, text)), text);
  for (const text of [NOT_CONNECTED, '这是本机地址', '内部地址', OFF]) assert.equal(await evaluate(contains(block, text)), false, text);
  assert.ok(calls.some(item => item.name === 'board.inbox.connections' && item.input.boardId === 'comments-fixture' && typeof item.input.expectedCreatedAt === 'string'));
  check('Visitor comments: the toggle explains itself, then prefills the backend from the first ready, enabled inbox source with the exact help and shared-site texts');

  const deployment = main.deploymentId;
  await recheck(`后端可用：应用 host-comments · 部署 ${deployment}`);
  assert.ok(await evaluate(contains(probe, '首次发布后，再检查一次网站地址是否已加入 origins。')));
  main.setHealth({ clientIp: 'proxied-unconfigured' });
  await recheck('后端在代理后面，但没有信任代理传来的访客地址：所有访客会共享同一个频率限制。把代理的地址加入 board-app.json 的 comments.trustedProxies，然后重新部署。');
  main.setHealth({ clientIp: 'socket', comments: 0 });
  await recheck('后端没有开启评论：把 board-app.json 的 comments.enabled 设为 true，然后重新部署。');
  main.setHealth({ comments: undefined });
  await recheck('后端版本过旧，不支持访客评论线程：在应用目录运行 paseo-board-app update-runtime，然后重新部署。');
  comments.setDown(true);
  await recheck('连接不上这个后端：无法连接（connect ECONNREFUSED）');
  comments.setDown(false); main.setHealth({ comments: 2 });
  check('Visitor comments: 检查后端 shows the exact text for an available, proxied, disabled, outdated and unreachable backend');

  // Creation needs a passing check; the server re-checks, so a backend that changed after the panel's check is refused.
  await recheck('后端可用');
  main.setHealth({ comments: 0 });
  const created = count('board.release.create');
  await generate();
  await until(`document.body.textContent.includes('评论后端检查没有通过：后端没有开启评论：把 board-app.json 的 comments.enabled 设为 true，然后重新部署。请先点「检查后端」。')`);
  assert.equal(count('board.release.create'), created + 1); assert.equal((await repository.list('comments-fixture')).length, 0);
  main.setHealth({ comments: 2 });
  check('Visitor comments: release creation is refused unless the backend serves comment threads at that moment');

  await replace(input, 'http://127.0.0.1:9');
  await until(contains(block, '这是本机地址：只有在运行这个后端的电脑上打开页面才能评论。'));
  assert.ok(await evaluate(contains(block, NOT_CONNECTED + '请到「更多 → 评论收件箱 → 后端来源」连接（如果收件箱用的是同一后端的另一个地址，可以忽略）。')));
  assert.ok(await evaluate(contains(block, '这个评论后端看起来是内部地址（127.0.0.1）。它会写进公开网页的代码里，任何人都能看到；公司网络以外的访客也无法发送评论。')));
  await replace(input, 'https://comments.corp');
  await until(contains(block, '这个评论后端看起来是内部地址（comments.corp）'));
  assert.equal(await evaluate(contains(block, '这是本机地址')), false);
  const beforeInternal = count('board.release.create');
  await generate();
  await until(`document.body.textContent.includes('请先勾选「我确认把这个地址写进公开网页」。')`);
  assert.equal(count('board.release.create'), beforeInternal, 'An unconfirmed internal address never reaches the server');
  await click(test('board-release-comments-internal-ok'));
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(test('board-release-comments-internal-ok'))}).getAttribute('aria-checked')`), 'true');
  await generate();
  await until("document.querySelector('[data-testid=board-release-preview]')&&document.body.textContent.includes('访客评论：https://comments.corp')");
  const internalCreate = calls.filter(item => item.name === 'board.release.create').at(-1).input;
  assert.deepEqual(internalCreate.comments, { apiBase: 'https://comments.corp', appKey: appKeyFor('host-owner') });
  assert.deepEqual(internalCreate.apiOrigins, [], 'The comment backend is not added to the authored API origins');
  check('Visitor comments: loopback and not-connected notes; an internal address on a public site needs 我确认把这个地址写进公开网页 before the release is created');

  // Publish with comments, then change the panel's setting and update the share link from it.
  await replace(input, 'https://comments.example.test');
  await generate();
  await until("document.body.textContent.includes('访客评论：https://comments.example.test')&&document.querySelector('[data-testid=board-release-preview]')");
  assert.ok(await evaluate("document.body.textContent.includes('此版本允许访客框选文字评论，评论发送到 https://comments.example.test。访客浏览器会保存一个匿名编号，用来查看自己的评论和回复。')"));
  const published = (await repository.list('comments-fixture')).map(item => item.manifest).find(item => item.comments?.apiBase === 'https://comments.example.test');
  assert.equal(published.viewerVersion, 4);
  await click(button('读取 GitHub 账号')); await click(button('fixture-alice · github.com')); await click(button('fixture-alice/site'));
  await click(button('确认预览和数据，可发布此版本')); await click(button('一键发布'));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('已核实上线')", 12000);
  await until(`${contains(test('board-share-status'), '访客评论（https://comments.example.test）')}`, 12000);
  assert.equal(await has(test('board-share-comments-update')), false, 'The panel and the share agree');
  await recheck('把 https://fixture-alice.github.io 加入 board-app.json 的 origins，然后重新部署。');
  assert.equal(await evaluate(contains(probe, '首次发布后')), false);
  main.allowOrigin('https://fixture-alice.github.io');
  await click(test('board-release-comments-check'));
  await until(`${contains(probe, '后端可用')}&&!${contains(probe, '加入 board-app.json 的 origins')}`);
  check('Visitor comments: the selected release shows 访客评论 and the exact warning; the share card lists the setting; 检查后端 reports a share origin missing from the backend\'s origins until it is added');

  await replace(input, 'https://other.example.test');
  await until(`document.querySelector(${JSON.stringify(test('board-share-comments-update'))})`);
  assert.equal(await evaluate(contains(test('board-share-status'), '换成了另一个评论后端应用')), false, 'No app-change note before a check');
  other.allowOrigin('https://fixture-alice.github.io');
  await recheck('后端可用：应用 host-other');
  await until(contains(test('board-share-status'), '换成了另一个评论后端应用：访客将看不到之前的评论和回复。'));
  await click(test('board-share-comments-update'));
  await until(`document.querySelector('[data-testid=board-share-confirm]')&&document.body.textContent.includes('此次更新的访客评论：https://other.example.test')`);
  const update = calls.filter(item => item.name === 'board.release.share-update').at(-1).input;
  assert.deepEqual(update.comments, { apiBase: 'https://other.example.test', appKey: appKeyFor('other-owner') });
  await click(test('board-release-comments-toggle'));
  await until(`document.querySelector(${JSON.stringify(test('board-share-comments-update'))})`);
  await click(test('board-share-comments-update'));
  await until(`document.body.textContent.includes('此次更新的访客评论：关闭')`);
  assert.equal(calls.filter(item => item.name === 'board.release.share-update').at(-1).input.comments, false);
  const off = (await repository.list('comments-fixture')).map(item => item.manifest).find(item => !item.comments && item.title === published.title);
  assert.ok(off, 'The update turned visitor comments off'); assert.equal(off.viewerVersion, 2);
  await click(button('关闭窗口')); await until("!document.querySelector('[data-testid=board-release-panel]')");
  check('Visitor comments: a changed panel setting offers 用面板中的评论设置更新; another backend app shows the app-change note; the confirmation names the new address or 关闭');
}
