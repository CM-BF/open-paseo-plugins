// The publishing panel's 评论可见范围 (public-threads DESIGN §5.5.1 as amended by §12) against the real publication
// handlers, the loopback fake comment backend and recorded release registrations. Runs after the visitor-comment checks.
export async function runPublicReleaseHostChecks({ assert, evaluate, until, click, replace, button, check, comments, calls, repository, loadPage, command, pageOrigin }) {
  const { main } = comments;
  const test = id => `[data-testid=${JSON.stringify(id)}]`;
  const contains = (selector, value) => `(document.querySelector(${JSON.stringify(selector)})?.textContent??'').includes(${JSON.stringify(value)})`;
  const has = selector => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  const checked = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-checked')`);
  const block = test('board-release-comments'), probe = test('board-release-comments-probe'), input = test('board-release-comments-origin');
  const openRelease = async () => { await click('[data-testid="board-more-open"]'); await click(button('导出与发布')); await until("document.querySelector('[data-testid=board-release-panel]')"); };
  const closeRelease = async () => { await click(button('关闭窗口')); await until("!document.querySelector('[data-testid=board-release-panel]')"); };
  const recheck = async expected => { await click(test('board-release-comments-check')); await until(contains(probe, expected)); };
  const generate = () => click(button('生成固定版本并预览'));
  const WARNING = '公开评论任何打开这个页面的人都能看到，包括评论内容、回复和访客自己填写的称呼。页面打开时就会连接评论后端读取评论。不当内容需要你在「评论收件箱」的「公开讨论」里隐藏。';
  const NEEDS_INBOX = '公开评论需要先把这个后端连接到本 Board 的评论收件箱（更多 → 评论收件箱 → 后端来源），这样你才能隐藏不当评论或标为已解决。';
  // The inbox is connected to another deployment only: public mode must refuse (identity, not URL).
  comments.connections.splice(0, comments.connections.length, { sourceId: 'other-source', deploymentId: 'another-deployment', label: '其他后端', endpoint: 'https://comments.example.test/_board/comments', enabled: true, state: 'ready', eventId: 'evt-x' });
  comments.registered.length = 0;
  await loadPage(() => command('Page.navigate', { url: `${pageOrigin}/?drafts=1&board=public-comments-fixture` }));
  await openRelease();
  await click(test('board-release-comments-toggle'));
  await until(`document.querySelector(${JSON.stringify(input)})`);
  await replace(input, 'https://comments.example.test');
  assert.ok(await evaluate(contains(test('board-release-comments-visibility'), '评论可见范围')));
  assert.equal(await checked(test('board-release-comments-visibility-private')), 'true', 'The default is 仅自己可见');
  assert.equal(await checked(test('board-release-comments-visibility-public')), 'false');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(test('board-release-comments-visibility-public'))}).getAttribute('aria-label')`), '公开：所有访客互相可见（像 Google 文档）');
  assert.ok(await evaluate(contains(block, '每位访客只看得到自己的评论和你的回复。')));
  assert.equal(await has(test('board-release-comments-public-warning')), false, 'No public warning while 仅自己可见 is selected');
  check('评论可见范围: two options with 仅自己可见 selected by default and its helper text; no public warning');

  await click(test('board-release-comments-visibility-public'));
  await until(`document.querySelector(${JSON.stringify(test('board-release-comments-visibility-public'))}).getAttribute('aria-checked')==='true'`);
  assert.ok(await evaluate(contains(test('board-release-comments-public-warning'), WARNING)));
  assert.equal(await evaluate(contains(block, '每位访客只看得到自己的评论和你的回复。')), false);
  await recheck(`后端可用：应用 host-comments · 部署 ${main.deploymentId}`);
  await until(contains(test('board-release-comments-public-inbox'), NEEDS_INBOX));
  const before = calls.filter(item => item.name === 'board.release.create').length;
  await generate();
  await until(`document.body.textContent.includes(${JSON.stringify(NEEDS_INBOX)})&&!document.querySelector('[data-testid=board-release-preview]')`);
  assert.equal(calls.filter(item => item.name === 'board.release.create').length, before, 'The panel refuses before calling the server');
  main.setHealth({ publicThreads: 0 });
  await recheck('后端关闭了公开评论：把 board-app.json 里的 comments.publicThreads 删掉或设为 true，然后重新部署。');
  main.setHealth({ publicThreads: undefined });
  await recheck('后端版本过旧，不支持公开评论：在应用目录运行 paseo-board-app update-runtime，然后重新部署。');
  main.setHealth({ publicThreads: 1, clientIp: 'proxied-unconfigured' });
  await recheck('后端在代理后面');
  assert.ok(await evaluate(contains(test('board-release-comments-visibility'), '后端在代理后面，但没有信任代理传来的访客地址')), 'The proxy note sits next to the public warning');
  main.setHealth({ clientIp: 'socket' });
  check('公开: the exact public warning, the inbox requirement by deployment identity, and the probe lines for a backend that turned public comments off or is too old');

  // A source of the same deployment at another address is enough; creation registers the release on that backend.
  comments.connections.splice(0, comments.connections.length, { sourceId: 'public-source', deploymentId: main.deploymentId, label: '评论后端（本机地址）', endpoint: 'https://inbox-address.example.test/_board/comments', enabled: true, state: 'ready', eventId: 'evt-p' });
  await closeRelease(); await openRelease();
  await until(`document.querySelector(${JSON.stringify(input)})?.value==='https://comments.example.test'`).catch(async () => { await click(test('board-release-comments-toggle')); await replace(input, 'https://comments.example.test'); });
  if (await checked(test('board-release-comments-visibility-public')) !== 'true') await click(test('board-release-comments-visibility-public'));
  await recheck('后端可用');
  assert.equal(await has(test('board-release-comments-public-inbox')), false);
  await generate();
  await until("document.querySelector('[data-testid=board-release-preview]')&&document.body.textContent.includes('访客评论：https://comments.example.test · 公开')", 12000);
  assert.ok(await evaluate("document.body.textContent.includes('此版本允许访客框选文字评论，并公开显示：任何打开页面的人都能看到所有访客的评论和回复。评论发送到 https://comments.example.test，页面打开时会从这里读取公开评论。访客浏览器会保存一个匿名编号，用来标出自己的评论。')"));
  const create = calls.filter(item => item.name === 'board.release.create').at(-1).input;
  assert.deepEqual(create.comments, { apiBase: 'https://comments.example.test', appKey: comments.appKey, visibility: 'public' });
  const manifest = (await repository.list('public-comments-fixture')).map(item => item.manifest).find(item => item.comments?.visibility === 'public');
  assert.equal(manifest.viewerVersion, 5);
  assert.deepEqual(comments.registered, [{ deploymentId: main.deploymentId, releaseId: manifest.releaseId, on: true }]);
  await closeRelease();
  check('公开: with an inbox source of the same deployment the release is created as viewer 5, says 访客评论 … · 公开 with the public warning, and is registered on that backend');
}
