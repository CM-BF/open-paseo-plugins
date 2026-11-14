#!/usr/bin/env node
// End-to-end local harness for public comment threads, Google-Docs style (public-threads DESIGN §9.6 as amended
// by §12). Run: `npm run test:page-comments` runs it after the private-comments harness; BROWSER_PATH overrides
// the Chrome binary; PUBLIC_THREADS_SHOTS=<dir> saves screenshots of the rail and the sheet.
//
// Everything is local and temporary, as in scripts/page-comments-e2e.mjs: a real paseo-board-app backend created
// with the launcher the plugin installs (schema 3), the Board's public release served from another loopback origin,
// the real plugin server in this process (release creation and registration, inbox source, import, public-state
// outbox), and three private Chromium contexts (visitors A and B on desktops, C on a phone) driven over the DevTools
// pipe with trusted input. The sealed comment runner handles public threads too: a stand-in for `claude -p` is
// launched by the plugin's own SealedRunner with the lock argv and acts only through the MCP server in its
// --mcp-config (the plugin's real launcher → bridge socket → the runner path), as in scripts/page-comments-e2e.mjs.
// Nothing touches ~/.paseo, a daemon or any address beyond loopback; nothing is installed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFakePaseo } from './fixtures/fake-paseo-sdk.mjs';
import { LegacyInboxPageSchema } from './fixtures/legacy-inbox-page.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (read, label, ms = 15_000, every = 60) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting for ${label}`);
    await sleep(every);
  }
};
const results = [], measures = { visible: [], hidden: [], natural: [] };
async function step(name, work) {
  const started = Date.now();
  try { const value = await work(); results.push({ name, ok: true }); console.log(`PASS ${name} (${Date.now() - started} ms)`); return value; }
  catch (error) { results.push({ name, ok: false }); console.error(`FAIL ${name}`); throw error; }
}

const temporary = await realpath(await mkdtemp(join(tmpdir(), 'pbc-public-e2e-')));
const paths = { data: join(temporary, 'data'), runtime: join(temporary, 'rt'), home: join(temporary, 'home'), app: join(temporary, 'app'), site: join(temporary, 'site'), profile: join(temporary, 'profile') };
const shotsDir = process.env.PUBLIC_THREADS_SHOTS;
const logs = [], cleanup = [];
for (const method of ['log', 'warn', 'error']) { const original = console[method].bind(console); console[method] = (...args) => { logs.push(args.map(String).join(' ')); original(...args); }; }
let token, backendOutput = '';

try {
  const { contributeServer, ReleaseRepository, PREFLIGHT_PROMPT } = await step('bundle the plugin server from source', async () => {
    const core = await build({ stdin: { contents: "export {contributeServer} from './server/contribute';export {ReleaseRepository} from './server/static-release';export {PREFLIGHT_PROMPT} from './server/inbox-lock';", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.txt': 'text' }, logLevel: 'silent' });
    const file = join(temporary, 'plugin-server.cjs'); await writeFile(file, core.outputFiles[0].text);
    return createRequire(import.meta.url)(file);
  });

  const site = { requests: [] };
  const pageServer = createServer(async (request, response) => {
    site.requests.push(request.url);
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    const file = join(paths.site, path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(paths.site + '/')) { response.writeHead(400).end(); return; }
    try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': extname(file) === '.html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' }); response.end(body); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { pageServer.closeAllConnections?.(); pageServer.close(resolve); }));
  const pageOrigin = `http://localhost:${pageServer.address().port}`, publicUrl = `${pageOrigin}/public/`, privateUrl = `${pageOrigin}/private/`;

  // The stand-in for `claude -p` (see the file header): a locked init, then each comment of its batch through the
  // board_inbox_* tools. A public comment first gets a hostile turn that repeats a private comment (the inbox refuses
  // it); every comment then gets a plain reply.
  const PRIVATE_SECRET = '私密：我的手机号是 13900000000，只想让作者知道';
  const runner = { calls: [], runs: [], errors: [] };
  function fakeClaude(argv, options) {
    const call = { argv: [...argv], stdin: options.stdin, preflight: options.stdin === PREFLIGHT_PROMPT, killed: false };
    runner.calls.push(call);
    let killResolve, bytes = 0;
    const killed = new Promise(resolve => { killResolve = resolve; });
    const emit = value => { if (call.killed) return; const line = JSON.stringify(value); bytes += line.length + 1; options.onBytes(bytes); options.onLine(line); };
    const flag = name => argv[argv.indexOf(name) + 1];
    const config = JSON.parse(flag('--mcp-config')).mcpServers;
    const work = (async () => {
      emit({ type: 'system', subtype: 'init', cwd: options.cwd, original_cwd: options.cwd, tools: flag('--allowedTools').split(','), mcp_servers: Object.keys(config).map(name => ({ name, status: 'connected' })), model: flag('--model'), permissionMode: flag('--permission-mode'), slash_commands: [], skills: [], plugins: [], output_style: 'default', claude_code_version: '2.1.325' });
      if (call.preflight) { emit({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0004, num_turns: 1, result: '好的' }); return { code: 0, signal: null }; }
      const wake = JSON.parse(options.stdin.split('<board-inbox-wake-json>\n')[1].split('\n</board-inbox-wake-json>')[0]);
      const run = { stdin: options.stdin, wake, reads: [], results: [], outcomes: [], replies: [] };
      runner.runs.push(run);
      const [[server, spec]] = Object.entries(config);
      const client = new Client({ name: 'fake-claude', version: '1.0.0' });
      const transport = new StdioClientTransport({ command: spec.command, args: spec.args ?? [], env: { ...options.env, ...spec.env }, stderr: 'pipe' });
      transport.stderr?.on('data', chunk => logs.push(String(chunk)));
      await client.connect(transport, { timeout: 5000 });
      try {
        const tool = async (name, args) => {
          emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `toolu_${runner.runs.length}_${run.results.length}`, name: `mcp__${server}__${name}`, input: args }] } });
          const result = await client.callTool({ name, arguments: args });
          run.results.push(JSON.stringify(result));
          if (result.isError) throw new Error(result.content?.[0]?.text);
          return JSON.parse(result.content[0].text);
        };
        const base = { boardId: wake.boardId, expectedCreatedAt: wake.expectedCreatedAt };
        for (const item of wake.comments) {
          const read = (await tool('board_inbox_read', { ...base, commentId: item.commentId })).comment;
          run.reads.push(read);
          const reply = text => tool('board_inbox_reply', { ...base, commentId: item.commentId, expectedCommentRevision: read.revision, eventId: `reply-${item.commentId}-${text.length}`, text }).then(result => result.status, error => `refused: ${error.message}`);
          if (item.visibility === 'public') run.outcomes.push(await reply(runner.hostile ?? `有访客私下说：“${PRIVATE_SECRET}”`));
          const text = item.visibility === 'public' ? `AI 助手（第 ${runner.runs.length} 批）：第二步是指先保存草稿，之后还能修改。` : '谢谢，我们会单独联系你。';
          run.replies.push(text); run.outcomes.push(await reply(text));
        }
      } finally { await client.close().catch(() => undefined); }
      emit({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.003, num_turns: 3, result: '已处理' });
      return { code: 0, signal: null };
    })().catch(error => { runner.errors.push(String(error?.stack ?? error)); return { code: 1, signal: null }; });
    return { kill: () => { call.killed = true; killResolve(); }, exited: Promise.race([work, killed.then(() => ({ code: null, signal: 'SIGKILL' }))]) };
  }

  const handlers = new Map(), befores = new Map(), listeners = new Map();
  const server = { handle: (contract, handler) => { handlers.set(contract.name, { contract, handler }); }, before: (name, hook) => { befores.set(name, hook); return () => befores.delete(name); }, on: (name, hook) => { listeners.set(name, hook); return () => listeners.delete(name); } };
  const sdk = createFakePaseo({ before: async (name, request) => (await befores.get(name)?.({ request }, { paseo: sdk.api })) ?? request, emit: async (name, event) => { await listeners.get(name)?.(event, { paseo: sdk.api }); } });
  sdk.addAgent('owner', { title: 'Board owner', provider: 'claude', model: 'sonnet', currentModeId: 'default', availableModes: [] });
  // The Claude provider's model list as the daemon reports it (paseo.providers.listModels('claude')).
  sdk.providerModels.set('claude', [{ provider: 'claude', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { provider: 'claude', id: 'claude-haiku-5-5', label: 'Haiku 5.5' }]);
  const rpc = async (name, input) => {
    const entry = handlers.get(name); assert.ok(entry, `RPC ${name} is registered`);
    const parsed = await entry.contract.input.parseAsync(input);
    return entry.contract.output.parseAsync(await entry.handler(parsed, { paseo: sdk.api }));
  };
  const dispose = contributeServer(server, { rootDir: paths.data, runtimeDir: paths.runtime, home: paths.home, linkSkills: false, inboxAutomation: { limits: { syncIntervalMs: 300, wakeDebounceMs: 400, wakeMaxDelayMs: 1_500 } }, inboxRunner: { exec: fakeClaude, env: { HOME: paths.home, PATH: process.env.PATH ?? '' } } });
  cleanup.push(() => dispose());

  const boardHtml = (lead) => `<style>body{margin:0;font:17px/1.7 Georgia,"Songti SC",serif;color:#1d1d1f;background:#fff}main{padding:28px 40px;max-width:820px}h1{font-size:30px}.spacer{height:900px}</style>
<main>
<h1 id="title">季度计划说明</h1>
<p id="intro">${lead}</p>
<p id="details">第二部分介绍预算安排：人员费用占一半，设备费用占三成，其余用于培训和差旅。</p>
<p id="risks">风险提示：如果供应商延期，整体进度会推迟两周左右。</p>
<div class="spacer"></div>
<p id="end">附录：联系人和更多资料。</p>
</main>
<script>window.frameSeen=[];window.addEventListener('message',event=>{try{frameSeen.push(JSON.stringify(event.data))}catch{}});window.ready=true</script>`;
  const board = await step('create a Board owned by the (fake) owner agent', async () => {
    const created = await rpc('board.create', { title: '公开讨论演示', ownerAgentId: 'owner', html: boardHtml('首先，第二步的意思是先保存草稿，然后再提交审核。'), data: {} });
    await access(join(paths.runtime, 'bin', 'paseo-board-app'));
    return created;
  });
  const other = await rpc('board.create', { title: '另一张 Board', ownerAgentId: 'owner', html: '<p>别的内容</p>', data: {} });
  const scope = { boardId: board.id, expectedCreatedAt: board.createdAt };

  const backend = await step('start a real paseo-board-app backend (schema 3) from the installed launcher on a free loopback port', async () => {
    const launcher = join(paths.runtime, 'bin', 'paseo-board-app');
    const init = await run(launcher, ['init', '--dir', paths.app, '--id', 'e2e-public'], { cwd: temporary });
    assert.equal(init.code, 0, init.stderr);
    const configPath = join(paths.app, 'board-app.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
    // Every request comes from 127.0.0.1: the per-address limits are raised within their 10× bound.
    Object.assign(config, { port: 0, origins: [pageOrigin], comments: { enabled: true, limits: { requestsPerIpMinute: 3000, listPerIpMinute: 6000, postPerIpMinute: 100, postPerIpHour: 600, postPerVisitorMinute: 50, postPerVisitorHour: 300, publicRootsPerVisitorPageDay: 100, minePerVisitorMinute: 120 } } });
    await writeFile(configPath, JSON.stringify(config, null, 2));
    token = randomBytes(36).toString('base64url');
    await writeFile(join(paths.app, '.env'), `BOARD_INBOX_EXPORT_TOKEN=${token}\n`, { mode: 0o600 });
    const env = { ...process.env }; delete env.BOARD_INBOX_EXPORT_TOKEN;
    const child = spawn(process.execPath, [join(paths.app, 'board-app.mjs'), 'start', '--dir', paths.app], { cwd: paths.app, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { backendOutput += chunk; }); child.stderr.on('data', chunk => { backendOutput += chunk; });
    cleanup.push(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000).then(() => child.kill('SIGKILL'))]); } });
    const listening = await until(async () => backendOutput.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(line => line?.status === 'listening'), 'the backend to listen');
    return { apiBase: `http://127.0.0.1:${listening.port}`, deploymentId: listening.deploymentId, database: join(dirname(paths.app), 'app-data', 'app.sqlite') };
  });
  const endpoint = `${backend.apiBase}/_board/comments`, owner = { Authorization: `Bearer ${token}` };

  const probe = await step('检查后端: the probe reports comment threads and public threads available', async () => {
    const result = await rpc('board.comments.probe', { apiBase: backend.apiBase, pageOrigins: [pageOrigin] });
    assert.equal(result.comments, 'threads'); assert.equal(result.publicThreads, 'available'); assert.deepEqual(result.originProblems, []);
    return result;
  });

  const exportTo = async (manifest, dir) => { await mkdir(paths.site, { recursive: true }); await rm(join(paths.site, dir), { recursive: true, force: true }); await new ReleaseRepository(join(paths.data, 'releases')).export(manifest.releaseId, { directory: join(paths.site, dir) }); };
  const release = await step('a public release needs the inbox connected; then it is viewer 5, registered on the backend, and served from the page origin', async () => {
    const comments = { apiBase: backend.apiBase, appKey: probe.appKey, visibility: 'public' };
    const create = (target, extra = {}) => rpc('board.release.create', { boardId: target.id, expectedCanvasBase: { revision: target.canvas.revision, documentVersion: target.canvas.documentVersion }, publicData: {}, comments, ...extra });
    await assert.rejects(create(board), /公开评论需要先把这个后端连接到本 Board 的评论收件箱（更多 → 评论收件箱 → 后端来源），这样你才能隐藏不当评论或标为已解决。/);
    await rpc('board.inbox.connect', { ...scope, expectedRevision: 0, eventId: 'connect-public', expectedConnectionEventId: null, sourceId: 'public-app', deploymentId: backend.deploymentId, label: '公开评论后端', endpoint, enabled: true, token });
    await assert.rejects(create(other), /公开评论需要先把这个后端连接到本 Board 的评论收件箱/, 'Another Board without its own source is refused');
    const manifest = await create(board);
    assert.equal(manifest.viewerVersion, 5); assert.deepEqual(manifest.comments, comments);
    assert.ok(manifest.warnings.includes(`此版本允许访客框选文字评论，并公开显示：任何打开页面的人都能看到所有访客的评论和回复。评论发送到 ${backend.apiBase}，页面打开时会从这里读取公开评论。访客浏览器会保存一个匿名编号，用来标出自己的评论。`));
    const moderation = await fetch(`${endpoint}/public/moderation`, { headers: owner }).then(response => response.json());
    assert.deepEqual(moderation.releases, [manifest.releaseId], 'The release is registered on the backend');
    await exportTo(manifest, 'public');
    const privateManifest = await rpc('board.release.create', { boardId: board.id, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, publicData: {}, title: '私密版本', comments: { apiBase: backend.apiBase, appKey: probe.appKey } });
    assert.equal(privateManifest.viewerVersion, 4);
    await exportTo(privateManifest, 'private');
    return manifest;
  });

  // -------------------------------------------------------------------------------------------------------
  const browserPath = process.env.BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const chrome = spawn(browserPath, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${paths.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--use-mock-keychain', '--window-size=1280,900', 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const cdp = { sequence: 0, buffer: '', commands: new Map(), contexts: new Map(), parents: new Map(), errors: [], dialogs: [], requests: [], responses: [], epoch: 0 };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++cdp.sequence, timer = setTimeout(() => { cdp.commands.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 15_000);
    cdp.commands.set(id, { resolve, reject, timer });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  chrome.stdio[4].on('data', chunk => {
    cdp.buffer += chunk.toString(); let end;
    while ((end = cdp.buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(cdp.buffer.slice(0, end)); cdp.buffer = cdp.buffer.slice(end + 1);
      if (message.id && cdp.commands.has(message.id)) { const entry = cdp.commands.get(message.id); cdp.commands.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
      else if (message.method === 'Target.attachedToTarget') {
        const child = message.params.sessionId; cdp.parents.set(child, message.sessionId);
        void send('Runtime.enable', {}, child).then(() => send('Page.enable', {}, child)).then(() => send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, child)).catch(error => cdp.errors.push(String(error)));
      }
      else if (message.method === 'Runtime.executionContextCreated') { const context = message.params.context; if (context.auxData?.isDefault) cdp.contexts.set(`${message.sessionId}:${context.auxData.frameId}`, { id: context.id, frameId: context.auxData.frameId, sessionId: message.sessionId, epoch: ++cdp.epoch }); }
      else if (message.method === 'Runtime.executionContextDestroyed') { for (const [key, context] of cdp.contexts) if (context.sessionId === message.sessionId && context.id === message.params.executionContextId) cdp.contexts.delete(key); }
      else if (message.method === 'Runtime.executionContextsCleared') { for (const [key, context] of cdp.contexts) if (context.sessionId === message.sessionId) cdp.contexts.delete(key); }
      else if (message.method === 'Runtime.exceptionThrown') cdp.errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      else if (message.method === 'Network.requestWillBeSent') cdp.requests.push({ sessionId: message.sessionId, method: message.params.request.method, url: message.params.request.url, headers: message.params.request.headers });
      else if (message.method === 'Network.responseReceived') cdp.responses.push({ sessionId: message.sessionId, url: message.params.response.url, status: message.params.response.status });
      else if (message.method === 'Page.javascriptDialogOpening') { cdp.dialogs.push(message.params.message); void send('Page.handleJavaScriptDialog', { accept: false }, message.sessionId).catch(() => undefined); }
    }
  });
  cleanup.push(async () => {
    try { await send('Browser.close'); } catch { try { process.kill(-chrome.pid, 'SIGTERM'); } catch {} }
    if (chrome.exitCode === null) await new Promise(resolve => { const timer = setTimeout(() => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch {} resolve(); }, 3000); chrome.once('exit', () => { clearTimeout(timer); resolve(); }); });
    for (const entry of cdp.commands.values()) { clearTimeout(entry.timer); entry.reject(new Error('Browser closed')); } cdp.commands.clear();
  });
  const belongs = (sessionId, top) => { for (let current = sessionId; current; current = cdp.parents.get(current)) if (current === top) return true; return false; };

  /** One visitor: a separate browser context (own storage and identity) with its own viewport. */
  async function openVisitor(name, { width, height, mobile = false }) {
    const { browserContextId } = await send('Target.createBrowserContext', {});
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const command = (method, params) => send(method, params, sessionId);
    for (const method of ['Runtime.enable', 'Page.enable', 'Network.enable']) await command(method);
    await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    if (mobile) await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const evaluate = async (expression, context) => {
      const result = await send('Runtime.evaluate', { expression, contextId: context?.id, awaitPromise: true, returnByValue: true }, context?.sessionId ?? sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const visitor = { name, sessionId, command, evaluate, frameContext: undefined };
    visitor.findFrame = async (afterEpoch = 0) => {
      visitor.frameContext = undefined;
      visitor.frameContext = await until(async () => {
        for (const context of [...cdp.contexts.values()]) {
          if (context.epoch <= afterEpoch || !belongs(context.sessionId, sessionId)) continue;
          try { if (await evaluate('window.board?.getContext?.().published===true&&window.ready===true', context)) return context; } catch {}
        }
        return undefined;
      }, `${name}'s canvas frame`, 10_000, 30);
    };
    visitor.frame = expression => evaluate(expression, visitor.frameContext);
    visitor.open = async url => { const afterEpoch = cdp.epoch; await command('Page.navigate', { url }); await visitor.findFrame(afterEpoch); };
    visitor.mouse = (type, x, y, extra = {}) => command('Input.dispatchMouseEvent', { type, x, y, ...extra });
    visitor.key = async (key, code, keyCode, modifiers = 0) => { await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers }); await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers }); };
    visitor.type = text => command('Input.insertText', { text });
    visitor.ui = () => evaluate(`(()=>{const q=s=>document.querySelector('[data-pbc='+s+']'),shown=n=>Boolean(n)&&!n.hidden&&n.isConnected;const rail=q('rail');return{mode:rail&&rail.getAttribute('data-mode'),rail:shown(rail),toggle:shown(q('toggle'))?q('toggle').textContent:null,composer:shown(q('composer')),status:shown(q('problem'))?q('problem').textContent:null,cards:Array.from(document.querySelectorAll('[data-pbc=card]')).filter(n=>n.isConnected&&n.offsetParent).map(n=>({id:n.getAttribute('data-thread'),active:n.hasAttribute('data-active'),text:n.textContent})),focus:document.activeElement&&(document.activeElement.getAttribute('data-pbc')||document.activeElement.getAttribute('aria-label')||document.activeElement.tagName)}})()`);
    visitor.card = async id => (await visitor.ui()).cards.find(card => card.id === id);
    visitor.textBox = async (selector, text) => {
      const offset = await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return{x:r.left,y:r.top}})()");
      const box = await visitor.frame(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);for(let n=w.nextNode();n;n=w.nextNode()){const i=n.data.indexOf(${JSON.stringify(text)});if(i<0)continue;const first=document.createRange(),last=document.createRange();first.setStart(n,i);first.setEnd(n,i+1);last.setStart(n,i+${text.length - 1});last.setEnd(n,i+${text.length});const a=first.getBoundingClientRect(),b=last.getBoundingClientRect();return{left:a.left,right:b.right,top:a.top,bottom:a.bottom,firstWidth:a.width,lastWidth:b.width}}throw new Error('text not found')})()`);
      return { startX: offset.x + box.left + Math.min(2, box.firstWidth / 4), endX: offset.x + box.right - Math.min(2, box.lastWidth / 4), y: offset.y + (box.top + box.bottom) / 2, centerX: offset.x + (box.left + box.right) / 2 };
    };
    visitor.dragSelect = async (selector, text) => {
      await visitor.frame('getSelection().removeAllRanges(),true');
      const box = await visitor.textBox(selector, text);
      await visitor.mouse('mouseMoved', box.startX, box.y);
      await visitor.mouse('mousePressed', box.startX, box.y, { button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 6; i++) await visitor.mouse('mouseMoved', box.startX + (box.endX - box.startX) * i / 6, box.y, { button: 'left', buttons: 1 });
      await visitor.mouse('mouseReleased', box.endX, box.y, { button: 'left', buttons: 0, clickCount: 1 });
      assert.equal(await visitor.frame('getSelection().toString()'), text);
      return box;
    };
    const boxOf = selector => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.hidden||!n.isConnected)return null;const r=n.getBoundingClientRect();return r.width?{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}:null})()`);
    visitor.click = async selector => {
      const box = await until(async () => { const a = await boxOf(selector); if (!a) return null; await sleep(60); const b = await boxOf(selector); return b && a.x === b.x && a.y === b.y ? b : null; }, `${name}: ${selector}`);
      await visitor.mouse('mouseMoved', box.x, box.y);
      await visitor.mouse('mousePressed', box.x, box.y, { button: 'left', buttons: 1, clickCount: 1 });
      await visitor.mouse('mouseReleased', box.x, box.y, { button: 'left', buttons: 0, clickCount: 1 });
    };
    /** Polls on focus (the page polls at most every 3 s on focus) until `read` is truthy. */
    visitor.waitFor = (read, label, ms = 30_000) => until(async () => { const value = await read(); if (value) return value; await evaluate("window.dispatchEvent(new Event('focus')),true"); return undefined; }, `${name}: ${label}`, ms, 700);
    visitor.listings = () => cdp.requests.filter(request => belongs(request.sessionId, sessionId) && request.method === 'GET' && request.url.startsWith(`${endpoint}/public?`));
    visitor.storage = () => evaluate('JSON.stringify({local:Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])),session:Object.fromEntries(Object.keys(sessionStorage).map(k=>[k,sessionStorage.getItem(k)]))})');
    visitor.shot = async name => { if (!shotsDir) return; await mkdir(shotsDir, { recursive: true }); const { data } = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(join(shotsDir, `${name}.png`), Buffer.from(data, 'base64')); console.log(`ARTIFACT ${join(shotsDir, `${name}.png`)}`); };
    return visitor;
  }
  const listingOf = () => fetch(`${endpoint}/public?page=${encodeURIComponent(publicUrl)}&release=${release.releaseId}`).then(async response => ({ etag: response.headers.get('etag'), body: await response.json() }));
  const inboxComments = async () => (await rpc('board.inbox.list', { ...scope, limit: 100 })).comments;
  const syncNow = async () => { const state = await rpc('board.inbox.list', { ...scope, limit: 1 }); return rpc('board.inbox.sync', { ...scope, expectedRevision: state.revision, eventId: `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, sourceId: 'public-app' }); };

  const [A, B, C] = await step('three visitors open the public page (A 1440×900 docked, B 1024×800 overlay, C a 390×844 phone): one listing each, then 304', async () => {
    const visitors = [await openVisitor('A', { width: 1440, height: 900 }), await openVisitor('B', { width: 1024, height: 800 }), await openVisitor('C', { width: 390, height: 844, mobile: true })];
    for (const visitor of visitors) await visitor.open(publicUrl);
    await sleep(800);
    for (const visitor of visitors) assert.equal(visitor.listings().length, 1, `${visitor.name} made one listing request at load`);
    assert.equal(cdp.requests.filter(request => request.url.includes('/_board/health') || request.url.includes('/_board/comments/mine') || request.method === 'POST' && request.url.startsWith(endpoint)).length, 0, 'no health, mine or POST at load');
    assert.deepEqual(await Promise.all(visitors.map(async visitor => (await visitor.ui()).mode)), ['docked', 'overlay', 'sheet']);
    await sleep(3100);
    for (const visitor of visitors) await visitor.evaluate("window.dispatchEvent(new Event('focus')),true");
    await until(async () => visitors.every(visitor => visitor.listings().length === 2), 'the second polls');
    await sleep(300);
    const etag = (await listingOf()).etag;
    for (const visitor of visitors) { const headers = visitor.listings()[1].headers; assert.equal(headers['If-None-Match'] ?? headers['if-none-match'], etag, `${visitor.name} revalidates with the ETag`); }
    const statuses = cdp.responses.filter(response => response.url.startsWith(`${endpoint}/public?`)).map(response => response.status);
    assert.ok(statuses.includes(304), JSON.stringify(statuses));
    return visitors;
  });

  const thread = await step('A selects text, right-clicks, writes as 小A and sends with ⌘Enter; B and C see it within one poll, A\'s card says 我', async () => {
    const box = await A.dragSelect('#intro', '第二步的意思');
    await sleep(450);
    await A.mouse('mouseMoved', box.centerX, box.y);
    await A.mouse('mousePressed', box.centerX, box.y, { button: 'right', buttons: 2, clickCount: 1 });
    await A.mouse('mouseReleased', box.centerX, box.y, { button: 'right', buttons: 0, clickCount: 1 });
    await until(async () => (await A.ui()).composer, 'the composer');
    await A.type('第二步具体要保存到哪里？');
    await A.evaluate("document.querySelector('[data-pbc=composer] input').focus(),true");
    await A.type('小A');
    const sentAt = Date.now();
    await A.key('Enter', 'Enter', 13, 4);
    await until(async () => !(await A.ui()).composer, 'the send');
    const listing = (await listingOf()).body;
    assert.equal(listing.threads.length, 1);
    const [root] = listing.threads;
    assert.equal(root.name, '小A'); assert.deepEqual(root.anchor.quote, '第二步的意思');
    await until(async () => { const card = await A.card(root.id); return card?.active && card.text.includes('我') && card.text.includes('小A · 访客·'); }, 'A sees its card active with 我');
    for (const visitor of [B]) {
      await visitor.waitFor(async () => { const card = await visitor.card(root.id); return card ? card : (await visitor.ui()).toggle === '评论 1'; }, 'the new thread');
    }
    measures.visible.push(Date.now() - sentAt);
    await C.waitFor(async () => (await C.ui()).toggle === '评论 1', 'the phone toggle 评论 1');
    await B.click('[data-pbc=toggle]');
    await until(async () => (await B.card(root.id))?.text.includes('小A · 访客·' + root.tag.slice(0, 6)), 'B sees 小A with the tag');
    assert.equal((await B.card(root.id)).text.includes('我'), false, 'B does not see 我 on A\'s comment');
    assert.ok(await B.frame("CSS.highlights.get('pbc-open').size===1"), 'B\'s page highlights the passage');
    await A.shot('rail-1440'); await B.shot('rail-1024');
    return root;
  });

  const replyB = await step('B replies anonymously in A\'s thread; A sees 访客·xxxx, B sees 我, C sees it in the sheet', async () => {
    await B.click(`[data-pbc=card][data-thread="${thread.id}"] .pbc-text`);
    await until(async () => (await B.card(thread.id))?.active, 'B activates the card');
    await B.click(`[data-pbc=card][data-thread="${thread.id}"] [data-pbc=reply-open]`);
    await until(() => B.evaluate("document.activeElement&&document.activeElement.getAttribute('aria-label')==='回复这条讨论'"), 'B\'s reply box');
    await B.type('我也想知道，是本地还是云端？');
    const sentAt = Date.now();
    await B.key('Enter', 'Enter', 13, 4);
    await until(async () => (await B.card(thread.id))?.text.includes('我也想知道'), 'B\'s reply in its card');
    const reply = (await listingOf()).body.threads[0].replies.find(item => item.text.startsWith('我也想知道'));
    assert.ok(reply && !reply.name);
    await until(async () => { const text = (await B.card(thread.id)).text; return text.includes(`访客·${reply.tag.slice(0, 6)}我`); }, 'B sees 我 on its reply');
    await A.waitFor(async () => { await A.click(`[data-pbc=card][data-thread="${thread.id}"] .pbc-text`).catch(() => undefined); return (await A.card(thread.id))?.text.includes(`访客·${reply.tag.slice(0, 6)}`); }, 'A sees B\'s reply');
    measures.visible.push(Date.now() - sentAt);
    assert.equal((await A.card(thread.id)).text.includes(`访客·${reply.tag.slice(0, 6)}我`), false);
    return reply;
  });

  const replyC = await step('C taps the highlight on the phone: the sheet opens at the thread; C replies as 小C; Esc closes and returns focus', async () => {
    await C.waitFor(async () => (await C.frame("CSS.highlights.get('pbc-open')?.size")) === 1, 'C\'s highlight');
    const box = await C.textBox('#intro', '第二步的意思');
    const opened = async () => { const ui = await C.ui(); return ui.rail && ui.mode === 'sheet' && (await C.card(thread.id))?.active; };
    for (let attempt = 0; attempt < 3 && !(await opened()); attempt++) {
      await C.command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.centerX, y: box.y }] });
      await C.command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await until(opened, 'the sheet', 2500).catch(() => undefined);
    }
    assert.ok(await opened(), 'The sheet opened at the tapped thread');
    await C.click(`[data-pbc=card][data-thread="${thread.id}"] [data-pbc=reply-open]`);
    await until(() => C.evaluate("document.activeElement&&document.activeElement.getAttribute('aria-label')==='回复这条讨论'"), 'C\'s reply box');
    await C.type('我是在手机上看的，也有同样的问题。');
    await C.click(`[data-pbc=card][data-thread="${thread.id}"] [data-pbc=rename]`);
    await until(() => C.evaluate("document.activeElement&&document.activeElement.getAttribute('aria-label')==='称呼（可选，会公开显示）'"), 'C\'s name field');
    await C.type('小C');
    await C.click(`[data-pbc=card][data-thread="${thread.id}"] [data-pbc=reply-send]`);
    await until(async () => (await C.card(thread.id))?.text.includes('小C · 访客·'), 'C\'s reply in the sheet');
    await C.shot('sheet-390');
    await C.key('Escape', 'Escape', 27); await C.key('Escape', 'Escape', 27);
    await until(async () => { const ui = await C.ui(); return !ui.rail && ui.focus === 'toggle'; }, 'Esc closes the sheet and focuses 评论');
    return (await listingOf()).body.threads[0].replies.find(item => item.name === '小C');
  });

  await step('the plugin imports the root and both replies linked to their thread; the thread view shows one thread with two visitor replies', async () => {
    await until(async () => (await syncNow(), (await inboxComments()).length === 3), 'the import');
    const comments = await inboxComments();
    const root = comments.find(item => item.externalId === thread.id), replies = comments.filter(item => item.externalId !== thread.id);
    assert.equal(root.visibility, 'public'); assert.equal(root.parentCommentId, undefined); assert.equal(root.publicTag, thread.tag);
    for (const reply of replies) { assert.equal(reply.visibility, 'public'); assert.equal(reply.parentCommentId, root.id); assert.deepEqual(reply.publicState, { hidden: false, resolved: false }); }
    const view = await rpc('board.inbox.public-threads', scope);
    assert.equal(view.sources[0].threads.length, 1); assert.equal(view.sources[0].threads[0].replies.filter(item => item.by === 'visitor').length, 2);
    assert.equal(view.sources[0].threads[0].commentId, root.id);
    const list = await rpc('board.inbox.list', { ...scope, limit: 100 });
    assert.equal(list.sources[0].skipped ?? 0, 0, 'nothing quarantined');
  });

  await step('the author replies from the inbox and the assistant\'s reply reaches B\'s reply: all three visitors see distinct 作者 and 作者的 AI 助手 badges', async () => {
    const root = (await inboxComments()).find(item => item.externalId === thread.id);
    const human = await rpc('board.inbox.reply', { ...scope, commentId: root.id, expectedCommentRevision: root.revision, eventId: 'owner-public-reply', text: '保存在你的个人空间里，之后可以再提交。', resolve: false });
    assert.equal(human.status, 'published');
    // The assistant's own path makes a draft for public comments (unit-tested); here its reply is the owner route with authorKind agent.
    const response = await fetch(`${endpoint}/${replyB.id}/replies`, { method: 'POST', headers: { ...owner, 'content-type': 'application/json', 'idempotency-key': 'ir-agent-public-0001' }, body: JSON.stringify({ text: '云端：保存后在任何设备上都能继续编辑。', authorKind: 'agent' }) });
    assert.equal(response.status, 201);
    for (const visitor of [A, B]) await visitor.waitFor(async () => { const text = (await visitor.card(thread.id))?.text ?? ''; return text.includes('作者已') || text.includes('作者的 AI 助手') && text.includes('保存在你的个人空间里'); }, 'both badges');
    for (const visitor of [A, B]) {
      const text = (await visitor.card(thread.id)).text;
      assert.ok(text.includes(`作者的 AI 助手回复 访客·${replyB.tag.slice(0, 6)}`), text);
      assert.ok(text.includes('作者') && text.includes('保存在你的个人空间里'), text);
    }
    const chips = await A.evaluate("[...document.querySelectorAll('[data-pbc=card][data-active] .pbc-chip')].map(n=>n.dataset.kind)");
    assert.ok(chips.includes('owner') && chips.includes('agent'));
  });

  // The sealed comment runner in public threads (merge of the sealed runner and public threads).
  const visitorPost = (visitor, key, body) => fetch(`${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-board-visitor': visitor.repeat(64), origin: pageOrigin }, body: JSON.stringify(body) }).then(async response => { const text = await response.text(); assert.equal(response.status, 201, text); return JSON.parse(text).comment; });
  const autoStatus = () => rpc('board.inbox.auto-status', scope);
  const settled = async (count, label) => until(async () => runner.runs.length >= count && runner.calls.every(call => call.preflight || runner.runs.some(run => run.stdin === call.stdin)) && (await autoStatus()).wake.state === 'idle' && (await autoStatus()).runs.every(run => !['starting', 'running'].includes(run.state)), label, 20_000, 100);
  const QUOTE_REFUSAL = '回复里有一段和私密或已隐藏评论相同（连续 16 个字以上）。公开讨论里所有访客都能看到回复，请换一种说法。';

  await step('the owner turns on automatic handling: the sealed runner\'s preflight passes through the plugin\'s real MCP launcher, and replies in public discussions stay drafts by default', async () => {
    const options = await rpc('board.inbox.assistant-options', scope);
    assert.equal(options.refusal, null); assert.equal(options.recommendedModelId, 'claude-haiku-5-5');
    const page = await rpc('board.inbox.list', { ...scope, limit: 1 });
    const status = await rpc('board.inbox.auto-enable', { ...scope, expectedRevision: page.revision, eventId: 'enable-public-e2e', replyMode: 'publish', modelId: 'claude-haiku-5-5' });
    assert.equal(status.assistant.kind, 'sealed'); assert.equal(status.publicDirect, false); assert.equal(status.wake.state, 'idle');
    assert.equal(runner.calls.filter(call => call.preflight).length, 1); assert.equal(runner.runs.length, 0, 'the backlog is never handed to the runner');
  });

  const runnerReply = await step('one visitor\'s private comment and public reply go to separate runs; the public run reads only the thread\'s visible messages, cannot repeat the private comment, and its reply is a draft until the author publishes it for every visitor', async () => {
    const before = runner.runs.length;
    await visitorPost('9', 'pc-runner-private-0001', { text: PRIVATE_SECRET, pageUrl: privateUrl, anchor: { selector: '#details', quote: '人员费用' } });
    const posted = await visitorPost('9', 'pr-runner-public-0001', { text: '第二步保存以后，别人能看到我的草稿吗？', pageUrl: publicUrl, visibility: 'public', parentId: thread.id, anchor: { releaseId: release.releaseId } });
    await settled(before + 2, 'two runs');
    const [privateRun, publicRun] = runner.runs.slice(before);
    assert.deepEqual([privateRun.wake.comments.map(item => item.visibility), publicRun.wake.comments.map(item => item.visibility)], [['private'], ['public']]);
    assert.ok(publicRun.stdin.includes('A comment with visibility "public" is part of a public discussion'));
    for (const text of [PRIVATE_SECRET, '第二步保存以后']) assert.equal(publicRun.stdin.includes(text) || privateRun.stdin.includes(text), false, 'stdin holds IDs only');
    const [view] = publicRun.reads;
    const root = (await inboxComments()).find(item => item.externalId === thread.id);
    assert.equal(view.visibility, 'public'); assert.equal(view.parentCommentId, root.id);
    assert.equal(view.thread.root.text, '第二步具体要保存到哪里？');
    const messages = view.thread.replies.map(item => `${item.kind}:${item.text}`);
    for (const expected of ['visitor:我也想知道，是本地还是云端？', 'owner:保存在你的个人空间里，之后可以再提交。', 'visitor:第二步保存以后，别人能看到我的草稿吗？']) assert.ok(messages.includes(expected), `${expected} in ${JSON.stringify(messages)}`);
    for (const result of publicRun.results) assert.equal(result.includes('13900000000'), false, 'the public run never sees the private comment');
    assert.equal(privateRun.reads[0].visibility, 'private'); assert.equal('thread' in privateRun.reads[0], false);
    assert.equal(publicRun.outcomes[0].startsWith('refused: ') && publicRun.outcomes[0].includes(QUOTE_REFUSAL), true, publicRun.outcomes[0]);
    assert.deepEqual([privateRun.outcomes, publicRun.outcomes.slice(1)], [['published'], ['draft']]);
    // The draft is not on the page until the author publishes it.
    assert.equal(JSON.stringify((await listingOf()).body).includes(publicRun.replies[0]), false);
    const comment = (await inboxComments()).find(item => item.externalId === posted.externalId);
    assert.equal(comment.pendingReply.state, 'draft');
    const published = await rpc('board.inbox.reply-pending', { ...scope, eventId: 'publish-runner-draft', commentId: comment.id, key: comment.pendingReply.key, action: 'publish' });
    assert.equal(published.status, 'published');
    for (const visitor of [A, B]) await visitor.waitFor(async () => (await visitor.card(thread.id))?.text.includes(publicRun.replies[0]), 'the published AI reply');
    assert.ok((await A.card(thread.id)).text.includes(`作者的 AI 助手回复 访客·${posted.tag.slice(0, 6)}`));
    const status = await autoStatus();
    assert.deepEqual(status.runs.slice(0, 2).map(run => [run.state, run.actions.replied, run.actions.drafted]), [['done', 0, 1], ['done', 1, 0]]);
    assert.deepEqual(runner.errors, []);
    return posted;
  });

  await step('a public reply the author hides before it is imported never wakes the runner', async () => {
    await rpc('board.inbox.auto-set', { ...scope, syncPaused: true });
    await sleep(600);
    const before = runner.runs.length;
    const hidden = await visitorPost('8', 'pr-runner-hidden-0001', { text: '这条回复会被作者先隐藏起来', pageUrl: publicUrl, visibility: 'public', parentId: thread.id, anchor: { releaseId: release.releaseId } });
    const result = await rpc('board.inbox.public-state', { ...scope, eventId: 'hide-before-import', sourceId: 'public-app', externalId: hidden.externalId, hidden: true, known: { hidden: false, resolved: false, parentId: thread.id, publicTag: hidden.tag } });
    assert.equal(result.status, 'applied');
    await rpc('board.inbox.auto-set', { ...scope, syncPaused: false });
    await until(async () => (await inboxComments()).some(item => item.externalId === hidden.externalId), 'the import');
    await sleep(2_500);
    assert.equal(runner.runs.length, before, 'no run for a hidden comment');
    const imported = (await inboxComments()).find(item => item.externalId === hidden.externalId);
    assert.equal(imported.status, 'new'); assert.equal(imported.publicState.hidden, true);
    const status = await autoStatus();
    assert.equal(status.wake.state, 'idle'); assert.equal(status.wake.pendingComments, 0);
  });

  await step('a visitor reply withdrawn after its import (the export never carries it again) is read from the backend before the next run: not in the runner\'s thread, not quotable, and shown as withdrawn in the inbox', async () => {
    const WITHDRAWN = '我住在海淀区某某路 88 号，电话 13700000000，这条我待会儿撤回';
    let before = runner.runs.length;
    const mine = await visitorPost('6', 'pr-runner-withdraw-0001', { text: WITHDRAWN, pageUrl: publicUrl, visibility: 'public', parentId: thread.id, anchor: { releaseId: release.releaseId } });
    await settled(before + 1, 'the run for the reply');
    const withdrawn = await fetch(`${endpoint}/${mine.externalId}/withdraw`, { method: 'POST', headers: { 'x-board-visitor': '6'.repeat(64), origin: pageOrigin } });
    assert.equal(withdrawn.status, 200, await withdrawn.text());
    await syncNow();
    assert.equal((await inboxComments()).find(item => item.externalId === mine.externalId).publicState.withdrawn, undefined, 'no export carries the withdrawal');
    before = runner.runs.length;
    runner.hostile = `有人提到：${WITHDRAWN}`;
    try {
      await visitorPost('5', 'pr-runner-after-withdraw-0001', { text: '第二步保存以后能撤销吗？', pageUrl: publicUrl, visibility: 'public', parentId: thread.id, anchor: { releaseId: release.releaseId } });
      await settled(before + 1, 'the next run');
    } finally { delete runner.hostile; }
    const run = runner.runs.at(-1);
    const texts = run.reads[0].thread.replies.map(item => item.text);
    assert.ok(texts.includes('第二步保存以后能撤销吗？'), JSON.stringify(texts));
    for (const result of run.results) assert.equal(result.includes('13700000000'), false, 'the runner never sees the withdrawn reply');
    assert.ok(run.outcomes[0].includes(QUOTE_REFUSAL), run.outcomes[0]);
    assert.equal(run.outcomes[1], 'draft');
    const after = (await inboxComments()).find(item => item.externalId === mine.externalId);
    assert.deepEqual(after.publicState, { hidden: true, resolved: false, withdrawn: true });
    assert.deepEqual(runner.errors, []);
  });

  await step('with 「公开讨论里的 AI 回复直接发布（我了解风险）」 on, the runner\'s public reply reaches every visitor without the author\'s confirmation; turning automatic handling off stops further runs', async () => {
    const on = await rpc('board.inbox.auto-set', { ...scope, publicDirect: true });
    assert.equal(on.publicDirect, true);
    const before = runner.runs.length;
    await visitorPost('9', 'pr-runner-direct-0001', { text: '那第三步呢？', pageUrl: publicUrl, visibility: 'public', parentId: thread.id, anchor: { releaseId: release.releaseId } });
    await settled(before + 1, 'the run');
    const run = runner.runs.at(-1);
    assert.ok(run.outcomes[0].includes(QUOTE_REFUSAL), run.outcomes[0]);
    assert.ok(['published', 'sending'].includes(run.outcomes[1]), run.outcomes[1]);
    for (const visitor of [A, B]) await visitor.waitFor(async () => (await visitor.card(thread.id))?.text.includes(run.replies[0]), 'the direct AI reply');
    assert.equal(JSON.stringify((await listingOf()).body).includes('13900000000'), false);
    const page = await rpc('board.inbox.list', { ...scope, limit: 1 });
    await rpc('board.inbox.policy', { ...scope, expectedRevision: page.revision, eventId: 'auto-off-public-e2e', policy: { read: true, triage: false, auto: 'off' } });
    await until(async () => (await autoStatus()).wake.state === 'off', 'automatic handling off');
    const count = runner.runs.length;
    await visitorPost('9', 'pr-runner-after-off-0001', { text: '关掉以后还会回复吗？', pageUrl: publicUrl, visibility: 'public', parentId: thread.id, anchor: { releaseId: release.releaseId } });
    await until(async () => (await inboxComments()).some(item => item.text === '关掉以后还会回复吗？'), 'the import');
    await sleep(2_000);
    assert.equal(runner.runs.length, count, 'no run after automatic handling was turned off');
    assert.deepEqual(runner.errors, []);
  });

  await step('the owner hides B\'s reply: gone for A, B and C within one poll (with the assistant reply attached to it), not in the raw listing; showing it brings it back', async () => {
    const before = (await listingOf()).etag;
    const result = await rpc('board.inbox.public-state', { ...scope, eventId: 'hide-b', sourceId: 'public-app', externalId: replyB.id, hidden: true });
    assert.equal(result.status, 'applied'); assert.equal(result.message, '已更新，访客页面会在十几秒内看到变化。');
    const hiddenAt = Date.now();
    const raw = await listingOf();
    assert.notEqual(raw.etag, before);
    for (const text of ['我也想知道', '云端：保存后']) assert.equal(JSON.stringify(raw.body).includes(text), false, text);
    for (const visitor of [A, B]) await visitor.waitFor(async () => !((await visitor.card(thread.id))?.text ?? '我也想知道').includes('我也想知道'), 'the reply to disappear');
    measures.hidden.push(Date.now() - hiddenAt);
    assert.equal((await A.card(thread.id)).text.includes('云端：保存后'), false, 'the assistant reply attached to the hidden reply is gone too');
    await rpc('board.inbox.public-state', { ...scope, eventId: 'show-b', sourceId: 'public-app', externalId: replyB.id, hidden: false });
    await A.waitFor(async () => (await A.card(thread.id))?.text.includes('我也想知道'), 'the reply to come back');
  });

  await step('不处理 on C\'s reply hides it for everyone; moving it back to 处理中 shows it again', async () => {
    await syncNow();
    const reply = (await inboxComments()).find(item => item.externalId === replyC.id);
    const page = await rpc('board.inbox.list', { ...scope, limit: 1 });
    await rpc('board.inbox.triage', { ...scope, expectedRevision: page.revision, eventId: 'dismiss-c', commentId: reply.id, expectedCommentRevision: reply.revision, status: 'dismissed', labels: [], note: '' });
    await until(async () => !JSON.stringify((await listingOf()).body).includes('我是在手机上看的'), 'the backend to hide it');
    await A.waitFor(async () => !((await A.card(thread.id))?.text ?? '我是在手机上看的').includes('我是在手机上看的'), 'C\'s reply to disappear for A');
    const again = (await inboxComments()).find(item => item.externalId === replyC.id);
    assert.deepEqual(again.publicState, { hidden: true, resolved: false, hiddenBy: 'dismiss' });
    const page2 = await rpc('board.inbox.list', { ...scope, limit: 1 });
    await rpc('board.inbox.triage', { ...scope, expectedRevision: page2.revision, eventId: 'review-c', commentId: again.id, expectedCommentRevision: again.revision, status: 'reviewing', labels: [], note: '' });
    await until(async () => JSON.stringify((await listingOf()).body).includes('我是在手机上看的'), 'the backend to show it again');
  });

  await step('resolving A\'s thread removes it from 未解决 everywhere; 全部 shows it collapsed; B\'s reply attempt is refused; reopening restores it', async () => {
    await rpc('board.inbox.public-state', { ...scope, eventId: 'resolve-a', sourceId: 'public-app', externalId: thread.id, resolved: true });
    await A.waitFor(async () => !(await A.card(thread.id)), 'A\'s card to leave 未解决');
    await A.click('[data-pbc=filter-all]');
    await until(async () => (await A.card(thread.id))?.text.includes('已解决'), 'collapsed under 全部');
    assert.equal(await A.frame("CSS.highlights.get('pbc-resolved').size"), 1);
    const refused = await fetch(`${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'pr-refused-0001', 'x-board-visitor': 'b'.repeat(64), origin: pageOrigin }, body: JSON.stringify({ text: '还能回复吗', pageUrl: publicUrl, visibility: 'public', parentId: thread.id, anchor: { releaseId: release.releaseId } }) });
    assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'thread_resolved');
    await rpc('board.inbox.public-state', { ...scope, eventId: 'reopen-a', sourceId: 'public-app', externalId: thread.id, resolved: false });
    await A.click('[data-pbc=filter-open]');
    await A.waitFor(async () => (await A.card(thread.id)) && !(await A.card(thread.id)).text.startsWith('已解决'), 'the reopened thread');
  });

  await step('markup and bidi controls from a visitor render literally for everyone, with no dialog', async () => {
    const response = await fetch(`${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'pc-literal-0001', 'x-board-visitor': 'd'.repeat(64), origin: pageOrigin }, body: JSON.stringify({ text: '<img src=x onerror=alert(1)> 预算‮evil‬', pageUrl: publicUrl, visibility: 'public', anchor: { selector: '#details', quote: '人员费用', releaseId: release.releaseId } }) });
    assert.equal(response.status, 201);
    for (const visitor of [A, B]) await visitor.waitFor(async () => (await visitor.ui()).cards.some(card => card.text.includes('<img src=x onerror=alert(1)> 预算[U+202E]evil[U+202C]')), 'the literal comment');
    assert.equal(await A.evaluate("document.querySelectorAll('[data-pbc=rail] img').length"), 0);
    assert.deepEqual(cdp.dialogs, []);
  });

  await step('without forced polls: a new comment reaches the other visitors on their regular 10-second poll (the honest delay)', async () => {
    // The other steps dispatch focus events to poll at once (waitFor); here nothing does, so this is what a reader sees.
    const toggleB = (await B.ui()).toggle;
    const response = await fetch(`${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'pc-natural-0001', 'x-board-visitor': 'f'.repeat(64), origin: pageOrigin }, body: JSON.stringify({ text: '自然轮询看到的评论', pageUrl: publicUrl, visibility: 'public', anchor: { selector: '#risks', quote: '整体进度', releaseId: release.releaseId } }) });
    assert.equal(response.status, 201);
    const sentAt = Date.now();
    await Promise.all([
      until(async () => (await A.ui()).cards.some(card => card.text.includes('自然轮询看到的评论')), 'A on its regular poll', 20_000, 100).then(() => measures.natural.push(Date.now() - sentAt)),
      until(async () => { const now = (await B.ui()).toggle; return now && now !== toggleB; }, 'B on its regular poll', 20_000, 100).then(() => measures.natural.push(Date.now() - sentAt)),
    ]);
    for (const ms of measures.natural) assert.ok(ms <= 15_000, `seen within one regular poll: ${ms} ms`);
  });

  await step('a 30-post flood from one visitor: the owner pauses the page and hides that visitor in two calls; everyone loses the posts within one poll', async () => {
    let tag;
    for (let i = 0; i < 30; i++) {
      const response = await fetch(`${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `pc-spam-${String(i).padStart(4, '0')}`, 'x-board-visitor': 'e'.repeat(64), origin: pageOrigin, 'x-forwarded-for': `198.51.100.${i}` }, body: JSON.stringify({ text: `广告 ${i}`, pageUrl: publicUrl, visibility: 'public', anchor: { selector: '#risks', quote: '风险提示', releaseId: release.releaseId } }) });
      const body = await response.text(); assert.equal(response.status, 201, body); tag = JSON.parse(body).comment.tag;
    }
    await A.waitFor(async () => (await A.ui()).cards.some(card => card.text.includes('这里还有') || card.text.includes('广告')), 'the flood on A\'s rail');
    const paused = await rpc('board.inbox.public-page', { ...scope, eventId: 'pause-public', sourceId: 'public-app', page: publicUrl, paused: true });
    assert.equal(paused.status, 'applied');
    const hidden = await rpc('board.inbox.public-hide-visitor', { ...scope, eventId: 'hide-spammer', sourceId: 'public-app', page: publicUrl, tag, hidden: true });
    assert.equal(hidden.status, 'applied'); assert.equal(hidden.changed, 30);
    for (const visitor of [A, B]) await visitor.waitFor(async () => !(await visitor.ui()).cards.some(card => card.text.includes('广告')), 'the flood to disappear');
    const refused = await fetch(`${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'pc-spam-after', 'x-board-visitor': 'e'.repeat(64), origin: pageOrigin }, body: JSON.stringify({ text: '还想发', pageUrl: publicUrl, visibility: 'public', anchor: { selector: '#risks', quote: '风险提示', releaseId: release.releaseId } }) });
    assert.equal(refused.status, 403); assert.equal((await refused.json()).code, 'public_paused');
    await A.waitFor(async () => (await A.ui()).status === '作者暂停了新的公开评论。', 'A sees the pause');
    await rpc('board.inbox.public-page', { ...scope, eventId: 'resume-public', sourceId: 'public-app', page: publicUrl, paused: false });
  });

  await step('the page changes: A\'s thread moves to 原文已修改 for everyone (after reload) and can still be replied to', async () => {
    const before = (await rpc('board.read', { boardId: board.id })).board;
    await rpc('board.publish', { boardId: board.id, expectedRevision: before.revision, canvasBase: { revision: before.canvas.revision, documentVersion: before.canvas.documentVersion }, eventId: 'change-intro', patch: { id: 'change-intro', selector: '#intro', operation: 'replace', html: '<p id="intro">这一段已经改写，不再包含原来的引用。</p>' } });
    const current = (await rpc('board.read', { boardId: board.id })).board;
    const manifest = await rpc('board.release.create', { boardId: board.id, expectedCanvasBase: { revision: current.canvas.revision, documentVersion: current.canvas.documentVersion }, publicData: {}, comments: { apiBase: backend.apiBase, appKey: probe.appKey, visibility: 'public' } });
    assert.notEqual(manifest.releaseId, release.releaseId);
    await exportTo(manifest, 'public');
    for (const visitor of [A, B]) {
      await visitor.open(publicUrl);
      if (visitor === B) await B.click('[data-pbc=toggle]');
      await until(async () => (await visitor.evaluate("document.querySelector('[data-pbc=orphans-toggle]')?.textContent||''")).startsWith('原文已修改（'), `${visitor.name}'s orphan section`);
    }
    await A.click('[data-pbc=orphans-toggle]');
    await until(async () => (await A.card(thread.id))?.text.startsWith('“第二步的意思”'), 'the orphan card with its quote');
  });

  await step('privacy: the listing has no secret, visitor hash, address or page URL; storage holds identity only; the frames saw no comment text; the token is nowhere', async () => {
    const text = JSON.stringify((await listingOf()).body);
    const db = new DatabaseSync(backend.database, { readOnly: true });
    const hashes = db.prepare('SELECT DISTINCT visitor_hash FROM _board_comments WHERE visitor_hash IS NOT NULL').all().map(row => row.visitor_hash);
    db.close();
    for (const hash of hashes) assert.equal(text.includes(hash), false);
    for (const word of ['127.0.0.1', 'pageUrl', 'releaseId', 'visitorHash', token]) assert.equal(text.includes(word), false, word);
    for (const visitor of [A, B, C]) {
      const storage = JSON.parse(await visitor.storage());
      for (const key of Object.keys(storage.local)) assert.match(key, /^paseo-board-(visitor:v2|public:v1):|^paseo-board-comments-(hint|rail):v1$|^paseo-board-release:/, key);
      for (const value of Object.values(storage.local)) for (const word of ['第二步具体要保存到哪里', '我也想知道', '我是在手机上看的']) assert.equal(value.includes(word), false, word);
      const secret = JSON.parse(storage.local[Object.keys(storage.local).find(key => key.startsWith('paseo-board-visitor:v2:'))] ?? '{}').secret;
      const seen = await visitor.frame('JSON.stringify(window.frameSeen)');
      for (const word of ['第二步具体要保存到哪里', '我也想知道', '小A', '小C', token, ...(secret ? [secret] : [])]) assert.equal(seen.includes(word), false, `${visitor.name}'s frame saw ${word.slice(0, 12)}`);
      const html = await visitor.evaluate('document.documentElement.outerHTML');
      assert.equal(html.includes(token), false);
    }
    assert.equal(logs.join('\n').includes(token), false, 'the token is not in the logs');
  });

  await step('the private page is unaffected: viewer 4 shows only the visitor\'s own threads; mine has no other visitor\'s rows; old exports still parse and skip replies', async () => {
    await A.open(privateUrl);
    await sleep(800);
    assert.equal(await A.evaluate("Boolean(document.querySelector('[data-pbc=rail]'))"), false, 'the private viewer has no rail');
    const mine = await fetch(`${endpoint}/mine?page=${encodeURIComponent(privateUrl)}`, { headers: { 'x-board-visitor': 'b'.repeat(64) } }).then(response => response.json());
    assert.deepEqual(mine.threads, []);
    const legacy = await fetch(`${endpoint}?cursor=0&limit=100`, { headers: owner }).then(response => response.json());
    assert.equal(LegacyInboxPageSchema.safeParse(legacy).success, true);
    const db = new DatabaseSync(backend.database, { readOnly: true });
    const replyIds = db.prepare('SELECT external_id FROM _board_comments WHERE parent_seq IS NOT NULL').all().map(row => row.external_id);
    db.close();
    assert.ok(replyIds.length >= 2);
    for (const id of replyIds) assert.equal(legacy.comments.some(row => row.externalId === id), false, 'v1 never exports visitor replies');
  });

  await step('no browser errors and no dialogs; nothing was sent to the owner agent', async () => {
    assert.deepEqual(cdp.errors, []); assert.deepEqual(cdp.dialogs, []);
    assert.deepEqual(sdk.sends.filter(item => item.id === 'owner'), []);
  });
} catch (error) {
  process.exitCode = 1;
  console.error('Public threads e2e failed:', error);
  if (backendOutput) console.error('Backend output (tail):', backendOutput.slice(-2000));
} finally {
  for (const close of cleanup.reverse()) { try { await close(); } catch (error) { console.error('cleanup:', error?.message ?? error); } }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const failed = results.filter(result => !result.ok).length;
  console.log(`\nPublic threads e2e: ${results.length - failed}/${results.length} steps passed${failed || process.exitCode ? ' (FAILED)' : ''}.`);
  if (measures.visible.length) console.log(`MEASURE send → visible in another context with a forced (focus) poll: ${measures.visible.join(', ')} ms; hide → gone (forced): ${measures.hidden.join(', ')} ms.`);
  if (measures.natural.length) console.log(`MEASURE send → visible on the regular 10 s poll, nothing forced: ${measures.natural.join(', ')} ms.`);
}

function run(command, args, options) {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}
