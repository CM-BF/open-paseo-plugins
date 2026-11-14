#!/usr/bin/env node
// End-to-end local harness for published-page visitor comments (DESIGN §7 as amended by §11.14).
// Run: `npm run test:page-comments` (from plugins/paseo-board). BROWSER_PATH overrides the Chrome binary.
//
// Everything is local and temporary:
// - a real paseo-board-app backend, created with the launcher the plugin installs into its runtime
//   directory (built from server/assets/app-runtime.txt), started on a free 127.0.0.1 port;
// - the Board's static release, exported by the real publishing path with visitor comments enabled and
//   served from a different loopback origin (http://localhost:<port>), as GitHub Pages and an API host differ;
// - the real plugin server (contributeServer) in this process: release creation with the backend check,
//   inbox source, auto-sync, comment-assistant creation, wake deliveries and the reply outbox. A fake Paseo
//   SDK stands in for the daemon; its comment assistant answers wakes through the plugin's own MCP server
//   (bin/paseo-board-mcp → bridge socket → board_inbox_read / board_inbox_reply);
// - two private Chromium contexts (two visitors) driven over the DevTools pipe with trusted input.
// Nothing touches ~/.paseo, a daemon or any address beyond loopback, and nothing is installed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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
const until = async (read, label, ms = 10_000, every = 50) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms waiting for ${label}`);
    await sleep(every);
  }
};

// ---------------------------------------------------------------------------------------------------------
// step(): every step is recorded with its outcome; the first failure stops the run, cleanup always runs.
const results = [], measures = {};
async function step(name, run) {
  const started = Date.now();
  try {
    const value = await run();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS ${name} (${Date.now() - started} ms)`);
    return value;
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started });
    console.error(`FAIL ${name}`);
    throw error;
  }
}

// A clock for the inbox coordinator that real time drives and the harness can move forward (budget resume).
function warpClock() {
  let offset = 0, nextId = 0;
  const timers = new Map();
  const tick = setInterval(() => {
    const now = Date.now() + offset;
    const due = [...timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
    for (const [id, timer] of due) { timers.delete(id); try { timer.callback(); } catch (error) { console.error('timer', error); } }
  }, 20);
  return {
    now: () => Date.now() + offset,
    setTimer: (callback, ms) => { const id = ++nextId; timers.set(id, { at: Date.now() + offset + Math.max(0, ms), callback }); return id; },
    clearTimer: id => { timers.delete(id); },
    advance: ms => { offset += ms; },
    stop: () => clearInterval(tick),
  };
}

const temporary = await realpath(await mkdtemp(join(tmpdir(), 'pbc-e2e-')));
const paths = { data: join(temporary, 'data'), runtime: join(temporary, 'rt'), home: join(temporary, 'home'), app: join(temporary, 'app'), site: join(temporary, 'site'), profile: join(temporary, 'profile') };
const logs = [];
for (const method of ['log', 'warn', 'error']) {
  const original = console[method].bind(console);
  console[method] = (...args) => { logs.push(args.map(String).join(' ')); original(...args); };
}
const cleanup = [];
let token, backendOutput = '';

try {
  // -------------------------------------------------------------------------------------------------------
  // The real plugin server, bundled from source for this process.
  const { contributeServer, ReleaseRepository, PROMPT_MARKER } = await step('bundle the plugin server from source', async () => {
    const core = await build({ stdin: { contents: "export {contributeServer} from './server/contribute';export {ReleaseRepository} from './server/static-release';export {PROMPT_MARKER} from './server/prompts';", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, loader: { '.txt': 'text' }, logLevel: 'silent' });
    const file = join(temporary, 'plugin-server.cjs'); await writeFile(file, core.outputFiles[0].text);
    return createRequire(import.meta.url)(file);
  });

  // Page server first: its origin goes into the backend's CORS list. Initially it serves nothing.
  const site = { requests: [] };
  const pageServer = createServer(async (request, response) => {
    site.requests.push(request.url);
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    const file = join(paths.site, path.endsWith('/') ? `${path}index.html` : path);
    if (!file.startsWith(paths.site + '/')) { response.writeHead(400).end(); return; }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': extname(file) === '.html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' });
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise(resolve => { pageServer.closeAllConnections?.(); pageServer.close(resolve); }));
  const pageOrigin = `http://localhost:${pageServer.address().port}`;
  const shareKey = 's0123456789abcdef0123', pagePath = `/pages/boards/${shareKey}/`, pageUrl = pageOrigin + pagePath;

  const clock = warpClock(); cleanup.push(() => clock.stop());
  const limits = { syncIntervalMs: 300, wakeDebounceMs: 400, wakeMaxDelayMs: 1_500, wakeMaxPerHour: 4 };
  const handlers = new Map(), befores = new Map(), listeners = new Map();
  const server = {
    handle: (contract, handler) => { handlers.set(contract.name, { contract, handler }); },
    before: (name, hook) => { befores.set(name, hook); return () => befores.delete(name); },
    on: (name, hook) => { listeners.set(name, hook); return () => listeners.delete(name); },
  };
  const sdk = createFakePaseo({
    before: async (name, request) => (await befores.get(name)?.({ request }, { paseo: sdk.api })) ?? request,
    emit: async (name, event) => { await listeners.get(name)?.(event, { paseo: sdk.api }); },
  });
  const ownerModes = [{ id: 'default', label: 'Always Ask', colorTier: 'safe' }, { id: 'acceptEdits', label: 'Accept edits', colorTier: 'moderate' }, { id: 'plan', label: 'Plan', colorTier: 'planning' }, { id: 'bypassPermissions', label: 'Bypass permissions', colorTier: 'dangerous' }];
  sdk.addAgent('owner', { title: 'Board owner', provider: 'claude', model: 'sonnet', currentModeId: 'bypassPermissions', availableModes: ownerModes });
  /** A daemon-side RPC call: input and output are parsed with the shared contracts, as the host does. */
  const rpc = async (name, input) => {
    const entry = handlers.get(name); assert.ok(entry, `RPC ${name} is registered`);
    const parsed = await entry.contract.input.parseAsync(input);
    return entry.contract.output.parseAsync(await entry.handler(parsed, { paseo: sdk.api }));
  };
  const dispose = contributeServer(server, { rootDir: paths.data, runtimeDir: paths.runtime, home: paths.home, linkSkills: false, inboxAutomation: { clock, limits } });
  cleanup.push(() => dispose());

  // -------------------------------------------------------------------------------------------------------
  const boardHtml = `<style>body{margin:0;font:17px/1.6 Georgia,"Songti SC",serif;color:#1d1d1f;background:#fff}main{padding:24px 32px;max-width:760px}#scroller{height:110px;overflow:auto;border:1px solid #bbb;padding:8px;margin:16px 0}#scroller .tall{height:420px}.spacer{height:700px}</style>
<main>
<h1 id="title">月度报告</h1>
<section id="steps"><h2>步骤</h2><p id="step-two">首先，第二步的意思是先保存再提交。</p></section>
<div id="scroller"><p id="nested">嵌套区域里的说明文字。</p><div class="tall"></div></div>
<p><a id="link" href="#steps">回到步骤</a></p>
<input id="field" value="输入框里的文字"><div id="editable" contenteditable="true">可编辑的区域</div>
<div data-board-comments="off"><p id="optout">这里不接受评论。</p></div>
<div class="spacer"></div>
</main>
<script>window.ready=true</script>`;
  const board = await step('create a Board owned by the (fake) owner agent', async () => {
    const created = await rpc('board.create', { title: '页面评论演示', ownerAgentId: 'owner', html: boardHtml, data: {} });
    await access(join(paths.runtime, 'bin', 'paseo-board-app')); await access(join(paths.runtime, 'bin', 'paseo-board-mcp'));
    return created;
  });
  const scope = { boardId: board.id, expectedCreatedAt: board.createdAt };

  // -------------------------------------------------------------------------------------------------------
  const backend = await step('start a real paseo-board-app backend from the installed launcher on a free loopback port', async () => {
    const launcher = join(paths.runtime, 'bin', 'paseo-board-app');
    const init = await run(launcher, ['init', '--dir', paths.app, '--id', 'e2e-comments'], { cwd: temporary });
    assert.equal(init.code, 0, init.stderr);
    const configPath = join(paths.app, 'board-app.json'), config = JSON.parse(await readFile(configPath, 'utf8'));
    // Every request comes from 127.0.0.1, so the per-address limits are raised within their 10× bound.
    Object.assign(config, { port: 0, origins: [pageOrigin], comments: { enabled: true, limits: { postPerIpMinute: 100, postPerIpHour: 600, postPerVisitorMinute: 50, minePerVisitorMinute: 120 } } });
    await writeFile(configPath, JSON.stringify(config, null, 2));
    token = randomBytes(36).toString('base64url');
    assert.equal(token.length, 48);
    await writeFile(join(paths.app, '.env'), `BOARD_INBOX_EXPORT_TOKEN=${token}\n`, { mode: 0o600 });
    const env = { ...process.env }; delete env.BOARD_INBOX_EXPORT_TOKEN; delete env.BOARD_LIVE_TOKEN;
    const child = spawn(process.execPath, [join(paths.app, 'board-app.mjs'), 'start', '--dir', paths.app], { cwd: paths.app, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { backendOutput += chunk; }); child.stderr.on('data', chunk => { backendOutput += chunk; });
    cleanup.push(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000).then(() => child.kill('SIGKILL'))]); } });
    const listening = await until(() => backendOutput.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).find(line => line?.status === 'listening'), 'the backend to listen', 15_000);
    return { apiBase: `http://127.0.0.1:${listening.port}`, deploymentId: listening.deploymentId, database: join(dirname(paths.app), 'app-data', 'app.sqlite') };
  });
  const endpoint = `${backend.apiBase}/_board/comments`;

  const probe = await step('检查后端: the host probe sees comment threads, the app key and no missing page origin', async () => {
    const result = await rpc('board.comments.probe', { apiBase: backend.apiBase, pageOrigins: [pageOrigin] });
    assert.equal(result.reachable, true); assert.equal(result.comments, 'threads'); assert.match(result.appKey, /^[a-f0-9]{16}$/);
    assert.deepEqual(result.originProblems, []); assert.equal(result.deploymentId, backend.deploymentId); assert.equal(result.clientIp, 'socket');
    const wrongOrigin = await rpc('board.comments.probe', { apiBase: backend.apiBase, pageOrigins: ['https://cm-bf.github.io'] });
    assert.deepEqual(wrongOrigin.originProblems, ['把 https://cm-bf.github.io 加入 board-app.json 的 origins，然后重新部署。']);
    return result;
  });

  const release = await step('publish a static release with visitor comments and serve it from the page origin', async () => {
    await assert.rejects(rpc('board.release.create', { boardId: board.id, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, publicData: {}, comments: { apiBase: backend.apiBase, appKey: 'f'.repeat(16) } }), /评论后端检查没有通过/);
    const manifest = await rpc('board.release.create', { boardId: board.id, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, publicData: {}, comments: { apiBase: backend.apiBase, appKey: probe.appKey } });
    assert.equal(manifest.viewerVersion, 4); assert.deepEqual(manifest.comments, { apiBase: backend.apiBase, appKey: probe.appKey });
    assert.ok(manifest.warnings.includes(`此版本允许访客框选文字评论，评论发送到 ${backend.apiBase}。访客浏览器会保存一个匿名编号，用来查看自己的评论和回复。`));
    assert.deepEqual(manifest.apiOrigins ?? [], [], 'The comment backend is not added to the authored apiOrigins');
    await mkdir(join(paths.site, 'pages', 'boards'), { recursive: true });
    await new ReleaseRepository(join(paths.data, 'releases')).export(manifest.releaseId, { directory: join(paths.site, 'pages', 'boards', shareKey) });
    const html = await readFile(join(paths.site, 'pages', 'boards', shareKey, 'index.html'), 'utf8');
    assert.ok(html.includes(new URL(backend.apiBase).origin), 'The outer CSP connects to the comment backend');
    return { manifest, html };
  });

  // -------------------------------------------------------------------------------------------------------
  // The comment assistant: it reads only the wake JSON and acts only through its pre-approved MCP tools.
  const assistant = { wakes: [], toolCalls: [], toolResults: [], clients: new Map() };
  const replyFor = comment => comment.text.includes('第二步') ? '谢谢！第二步指的是先保存草稿，再点提交。' : `谢谢你的评论，我们会把「${(comment.anchor?.quote ?? '这段').slice(0, 20)}」写得更清楚。`;
  async function mcpFor(record) {
    if (assistant.clients.has(record.id)) return assistant.clients.get(record.id);
    const config = record.config.mcpServers.paseo_board;
    assert.equal(config.type, 'stdio'); assert.equal(config.command, join(paths.runtime, 'bin', 'paseo-board-mcp'));
    const client = new Client({ name: 'fake-comment-assistant', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: config.command, args: config.args ?? [], env: { ...record.env, ...config.env }, stderr: 'pipe' });
    transport.stderr?.on('data', chunk => logs.push(String(chunk)));
    await client.connect(transport, { timeout: 5000 });
    assistant.clients.set(record.id, client);
    cleanup.push(() => client.close().catch(() => undefined));
    return client;
  }
  async function tool(record, name, args) {
    const allowed = record.config.toolPolicy.preapproved.map(entry => entry.tool);
    assert.ok(allowed.includes(name), `${name} is pre-approved for the comment assistant`);
    assistant.toolCalls.push({ name, args });
    const result = await (await mcpFor(record)).callTool({ name, arguments: args });
    assistant.toolResults.push(JSON.stringify(result));
    if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text}`);
    return JSON.parse(result.content[0].text);
  }
  sdk.behaviour = record => record.title?.startsWith('评论助手') ? async ({ text }) => {
    const json = text.split('<board-inbox-wake-json>\n')[1]?.split('\n</board-inbox-wake-json>')[0];
    assert.ok(json, 'The wake carries its JSON block');
    const wake = JSON.parse(json);
    assistant.wakes.push({ text, wake });
    for (const item of wake.comments) {
      const read = await tool(record, 'board_inbox_read', { boardId: wake.boardId, expectedCreatedAt: wake.expectedCreatedAt, commentId: item.commentId });
      if (!item.canSeeReply) {
        await tool(record, 'board_inbox_triage', { boardId: wake.boardId, expectedCreatedAt: wake.expectedCreatedAt, expectedRevision: wake.inboxRevision, eventId: `triage-${item.commentId}`, commentId: item.commentId, expectedCommentRevision: read.comment.revision, status: 'reviewing', labels: [], note: '访客看不到回复，请用户决定。' });
        continue;
      }
      const reply = await tool(record, 'board_inbox_reply', { boardId: wake.boardId, expectedCreatedAt: wake.expectedCreatedAt, commentId: item.commentId, expectedCommentRevision: item.revision, eventId: `reply-${item.commentId}`, text: replyFor(read.comment) });
      assert.equal(reply.status, 'published', JSON.stringify({ status: reply.status, message: reply.message }));
    }
  } : undefined;

  const assistantId = await step('connect the backend source and confirm automatic handling: a dedicated comment assistant is created', async () => {
    await rpc('board.inbox.connect', { ...scope, expectedRevision: 0, eventId: 'connect-e2e', expectedConnectionEventId: null, sourceId: 'e2e-app', deploymentId: backend.deploymentId, label: '演示后端', endpoint, enabled: true, token });
    const options = await rpc('board.inbox.assistant-options', scope);
    assert.equal(options.ownerMissing, false); assert.equal(options.providerSupported, true); assert.equal(options.recommendedModeId, 'default');
    assert.deepEqual(options.modes.filter(mode => mode.selectable).map(mode => mode.id), ['default', 'acceptEdits']);
    const page = await rpc('board.inbox.list', { ...scope, limit: 10 });
    await assert.rejects(rpc('board.inbox.auto-enable', { ...scope, expectedRevision: page.revision, eventId: 'enable-bypass', replyMode: 'publish', modeId: 'bypassPermissions', acceptRisk: true }), /不能用这个权限模式自动处理评论/);
    const status = await rpc('board.inbox.auto-enable', { ...scope, expectedRevision: page.revision, eventId: 'enable-e2e', replyMode: 'publish', modeId: 'default', acceptRisk: false });
    assert.equal(status.wake.state, 'idle'); assert.equal(status.assistant.modeLabel, 'Always Ask'); assert.equal(status.assistant.tier, 'safe');
    assert.equal(sdk.created.length, 1);
    const [spec] = sdk.created, record = sdk.records.get(status.assistant.agentId);
    assert.equal(spec.title, '评论助手 · 页面评论演示'); assert.deepEqual(spec.labels, { 'paseo-board.id': board.id, 'paseo-board.role': 'inbox-assistant' });
    assert.equal(spec.config.modeId, 'default'); assert.equal(spec.config.provider, 'claude/sonnet');
    assert.deepEqual(spec.config.toolPolicy.preapproved.map(entry => `${entry.server}:${entry.tool}`), ['paseo_board:board_inbox_list', 'paseo_board:board_inbox_read', 'paseo_board:board_inbox_triage', 'paseo_board:board_inbox_reply']);
    for (const absent of ['workspace', 'parent', 'worktree', 'git', 'prompt', 'images', 'attachments']) assert.equal(spec[absent], undefined, absent);
    assert.ok(spec.cwd.startsWith(join(paths.data, 'inbox-assistants') + '/'));
    assert.deepEqual(await readdir(spec.cwd), []); assert.equal((await lstat(spec.cwd)).mode & 0o777, 0o700);
    // The plugin's own before("agent.create") injected its MCP server, a binding and the Board instructions; toolPolicy survived.
    assert.match(record.config.systemPrompt, /^You are the comment assistant for the Paseo Board "页面评论演示"/);
    assert.ok(record.config.systemPrompt.includes(PROMPT_MARKER), 'The Board instructions are appended');
    assert.equal(record.config.mcpServers.paseo_board.env.PASEO_BOARD_BINDING, record.env.PASEO_BOARD_BINDING);
    assert.deepEqual(record.config.toolPolicy, spec.config.toolPolicy);
    assert.match(record.env.PASEO_BOARD_BINDING, /^[a-f0-9]{48}$/);
    return status.assistant.agentId;
  });
  const assistantSends = () => sdk.sends.filter(send => send.id === assistantId);
  const inbox = (limit = 100) => rpc('board.inbox.list', { ...scope, limit });
  const autoStatus = () => rpc('board.inbox.auto-status', scope);

  // -------------------------------------------------------------------------------------------------------
  // Chromium over the DevTools pipe (same driver style as scripts/release-browser-test.mjs).
  const browserPath = process.env.BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const chrome = spawn(browserPath, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${paths.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--use-mock-keychain', '--window-size=1000,800', 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const cdp = { sequence: 0, buffer: '', commands: new Map(), contexts: new Map(), parents: new Map(), errors: [], dialogs: [], console: [], requests: [], epoch: 0 };
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
      else if (message.method === 'Network.requestWillBeSent') cdp.requests.push({ sessionId: message.sessionId, method: message.params.request.method, url: message.params.request.url });
      else if (message.method === 'Runtime.consoleAPICalled') cdp.console.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '));
      else if (message.method === 'Page.javascriptDialogOpening') { cdp.dialogs.push(message.params.message); void send('Page.handleJavaScriptDialog', { accept: false }, message.sessionId).catch(() => undefined); }
    }
  });
  cleanup.push(async () => {
    try { await send('Browser.close'); } catch { try { process.kill(-chrome.pid, 'SIGTERM'); } catch {} }
    if (chrome.exitCode === null) await new Promise(resolve => { const timer = setTimeout(() => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch {} resolve(); }, 3000); chrome.once('exit', () => { clearTimeout(timer); resolve(); }); });
    for (const entry of cdp.commands.values()) { clearTimeout(entry.timer); entry.reject(new Error('Browser closed')); } cdp.commands.clear();
  });
  const belongs = (sessionId, top) => { for (let current = sessionId; current; current = cdp.parents.get(current)) if (current === top) return true; return false; };

  /** One visitor: a separate browser context, so separate storage and identity. */
  async function openVisitor(name) {
    const { browserContextId } = await send('Target.createBrowserContext', {});
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const command = (method, params) => send(method, params, sessionId);
    for (const method of ['Runtime.enable', 'Page.enable', 'Network.enable']) await command(method);
    await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await command('Emulation.setFocusEmulationEnabled', { enabled: true });
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
      }, `${name}'s published canvas frame`, 10_000, 30);
    };
    visitor.frame = expression => evaluate(expression, visitor.frameContext);
    visitor.open = async url => { const afterEpoch = cdp.epoch; await command('Page.navigate', { url }); await visitor.findFrame(afterEpoch); };
    visitor.reload = async () => { const afterEpoch = cdp.epoch; await command('Page.reload'); await visitor.findFrame(afterEpoch); };
    visitor.mouse = async (type, x, y, extra = {}) => command('Input.dispatchMouseEvent', { type, x, y, ...extra });
    visitor.key = async (key, code, keyCode, modifiers = 0) => {
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    };
    visitor.ui = () => evaluate(`(()=>{const q=s=>document.querySelector('[data-pbc='+s+']'),shown=n=>Boolean(n)&&n.isConnected&&!n.hidden;const c=q('composer');return{float:shown(q('float')),composer:shown(c),badge:shown(q('badge'))?q('badge').textContent:null,panel:shown(q('panel'))?q('panel').textContent:null,toast:shown(q('toast'))?q('toast').textContent:null,focus:document.activeElement&&(document.activeElement.getAttribute('data-pbc')||document.activeElement.getAttribute('aria-label')||document.activeElement.tagName)}})()`);
    /** Viewport coordinates (outer page) of a text run inside the canvas frame. */
    visitor.textBox = async (selector, text) => {
      const offset = await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return{x:r.left,y:r.top}})()");
      const box = await visitor.frame(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);for(let n=w.nextNode();n;n=w.nextNode()){const i=n.data.indexOf(${JSON.stringify(text)});if(i<0)continue;const first=document.createRange(),last=document.createRange();first.setStart(n,i);first.setEnd(n,i+1);last.setStart(n,i+${text.length - 1});last.setEnd(n,i+${text.length});const a=first.getBoundingClientRect(),b=last.getBoundingClientRect();return{left:a.left,right:b.right,top:a.top,bottom:a.bottom,firstWidth:a.width,lastWidth:b.width}}throw new Error('text not found')})()`);
      await sleep(80);
      return { startX: offset.x + box.left + Math.min(2, box.firstWidth / 4), endX: offset.x + box.right - Math.min(2, box.lastWidth / 4), y: offset.y + (box.top + box.bottom) / 2, centerX: offset.x + (box.left + box.right) / 2 };
    };
    /** A real mouse drag across the text, like a visitor selecting it. */
    visitor.dragSelect = async (selector, text) => {
      await visitor.frame('getSelection().removeAllRanges(),true');
      const box = await visitor.textBox(selector, text);
      await visitor.mouse('mouseMoved', box.startX, box.y);
      await visitor.mouse('mousePressed', box.startX, box.y, { button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 6; i++) await visitor.mouse('mouseMoved', box.startX + (box.endX - box.startX) * i / 6, box.y, { button: 'left', buttons: 1 });
      await visitor.mouse('mouseReleased', box.endX, box.y, { button: 'left', buttons: 0, clickCount: 1 });
      assert.equal(await visitor.frame('getSelection().toString()'), text, `${name}'s drag selects exactly the text`);
      return box;
    };
    visitor.clickOuter = async selector => {
      const box = await until(() => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.hidden)return null;const r=n.getBoundingClientRect();return r.width?{x:r.left+r.width/2,y:r.top+r.height/2}:null})()`), selector);
      await visitor.mouse('mouseMoved', box.x, box.y);
      await visitor.mouse('mousePressed', box.x, box.y, { button: 'left', buttons: 1, clickCount: 1 });
      await visitor.mouse('mouseReleased', box.x, box.y, { button: 'left', buttons: 0, clickCount: 1 });
    };
    visitor.markers = async () => {
      const { root: documentRoot } = await send('DOM.getDocument', { depth: -1, pierce: true }, visitor.frameContext?.sessionId ?? sessionId), found = [];
      const collect = node => { if (node.nodeName === 'BUTTON') found.push(node); for (const child of node.children ?? []) collect(child); };
      const walk = node => {
        if (node.nodeName === 'PASEO-BOARD-COMMENT-MARKERS') for (const shadow of node.shadowRoots ?? []) collect(shadow);
        for (const child of [...(node.children ?? []), ...(node.contentDocument ? [node.contentDocument] : []), ...(node.shadowRoots ?? [])]) walk(child);
      };
      walk(documentRoot);
      return found.map(node => {
        const attributes = {}; for (let i = 0; i < (node.attributes ?? []).length; i += 2) attributes[node.attributes[i]] = node.attributes[i + 1];
        const at = /translate\((-?\d+)px,\s*(-?\d+)px\)/.exec(attributes.style ?? '');
        return { n: node.children?.[0]?.nodeValue, label: attributes['aria-label'], hidden: 'hidden' in attributes, unread: 'data-unread' in attributes, y: at ? Number(at[2]) : null };
      }).filter(marker => !marker.hidden);
    };
    visitor.storage = () => evaluate('JSON.stringify({local:Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])),session:Object.fromEntries(Object.keys(sessionStorage).map(k=>[k,sessionStorage.getItem(k)]))})');
    /** Polls on focus (at least 10 s apart on the page) until the badge reads as expected. */
    visitor.waitBadge = async (expected, ms = 45_000) => until(async () => {
      const state = await visitor.ui();
      if (state.badge === expected) return state;
      await evaluate("window.dispatchEvent(new Event('focus')),true");
      return undefined;
    }, `${name}'s badge "${expected}"`, ms, 1000);
    return visitor;
  }

  const firstText = '第二步看不懂 <img src=x onerror=alert(1)>';
  const visitor1 = await step('visitor 1 opens the shared page: no request to the backend before commenting', async () => {
    const visitor = await openVisitor('visitor 1');
    await visitor.open(pageUrl);
    await sleep(800);
    assert.deepEqual(cdp.requests.filter(request => request.url.startsWith(backend.apiBase)), [], 'A first-time visitor makes no request to the comment backend');
    assert.ok(cdp.requests.some(request => request.url === pageUrl), 'The page itself came from the page origin');
    assert.equal(await visitor.evaluate('location.origin'), pageOrigin);
    assert.notEqual(new URL(pageOrigin).origin, new URL(backend.apiBase).origin);
    return visitor;
  });

  const firstComment = await step('visitor 1 drags to select text in the canvas, right-clicks it and sends a comment with ⌘Enter', async () => {
    const box = await visitor1.dragSelect('#step-two', '第二步');
    await sleep(450);
    await visitor1.mouse('mouseMoved', box.centerX, box.y);
    await visitor1.mouse('mousePressed', box.centerX, box.y, { button: 'right', buttons: 2, clickCount: 1 });
    await visitor1.mouse('mouseReleased', box.centerX, box.y, { button: 'right', buttons: 0, clickCount: 1 });
    const state = await until(async () => { const value = await visitor1.ui(); return value.composer && value; }, 'the composer');
    assert.equal(state.focus, '评论', 'Focus is in the comment text');
    await visitor1.command('Input.insertText', { text: firstText });
    const sentAt = Date.now();
    await visitor1.key('Enter', 'Enter', 13, 4);
    await until(async () => { const value = await visitor1.ui(); return !value.composer && value.toast === '已发送' && value.badge === '我的评论 1'; }, 'the confirmed send');
    const [marker] = await until(async () => { const found = await visitor1.markers(); return found.length === 1 && found; }, 'the marker');
    assert.equal(marker.label, '我的评论 1：已发送，等待作者查看');
    const rows = backendRows();
    assert.equal(rows.length, 1); assert.equal(rows[0].text, firstText);
    const anchor = JSON.parse(rows[0].anchor_json);
    assert.deepEqual(Object.keys(anchor).sort(), ['end', 'label', 'prefix', 'quote', 'releaseId', 'selector', 'start', 'suffix']);
    assert.deepEqual({ quote: anchor.quote, selector: anchor.selector, prefix: anchor.prefix, suffix: anchor.suffix, label: anchor.label, releaseId: anchor.releaseId }, { quote: '第二步', selector: '#step-two', prefix: '首先，', suffix: '的意思是先保存再提交。', label: '步骤', releaseId: release.manifest.releaseId });
    assert.equal(anchor.end - anchor.start, 3); assert.equal(rows[0].page_url, pageUrl);
    return { sentAt, externalId: rows[0].external_id };
  });

  await step('the plugin auto-syncs it within seconds, with the rich anchor and visitor tag', async () => {
    const comment = await until(async () => (await inbox()).comments.find(item => item.externalId === firstComment.externalId), 'the import', 3_000, 25);
    measures.importMs = Date.now() - firstComment.sentAt;
    assert.equal(comment.text, firstText); assert.equal(comment.contentTrust, 'external-untrusted');
    assert.equal(comment.anchor.quote, '第二步'); assert.equal(comment.anchor.releaseId, release.manifest.releaseId); assert.match(comment.visitorTag, /^[a-f0-9]{12}$/);
    assert.equal(comment.pageUrl, pageUrl);
    const status = await autoStatus();
    const [source] = status.sync.sources;
    assert.ok(['idle', 'syncing'].includes(source.state), source.state); assert.equal(source.failures, 0); assert.equal(source.lastError, null);
    assert.equal(source.skipped, 0); assert.equal(source.sanitized, 0); assert.equal(source.repliesSupported === false, false);
  });

  await step('one wake goes only to the comment assistant: IDs only, no Board interaction, nothing to the owner', async () => {
    await until(() => assistant.wakes.length === 1 && sdk.idle().then(() => true), 'the first wake', 10_000);
    const [send] = assistantSends();
    assert.deepEqual(sdk.sends.map(item => item.id), [assistantId], 'Only the comment assistant was messaged');
    assert.equal(send.options.activeTurnBehavior, 'steer');
    assert.ok(send.text.startsWith(`[paseo-board board=${board.id} intent=inbox-`));
    assert.equal(assistant.wakes[0].wake.comments.length, 1); assert.equal(assistant.wakes[0].wake.comments[0].canSeeReply, true);
    for (const forbidden of ['第二步', '<img', firstText, pageOrigin, backend.apiBase, endpoint, token, '--json', 'PASEO_BOARD_CLI']) assert.equal(send.text.includes(forbidden), false, `The wake prompt contains no ${forbidden === token ? 'token' : JSON.stringify(forbidden)}`);
    const journalText = await readFile(join(paths.data, 'service.json'), 'utf8'), journal = JSON.parse(journalText);
    const deliveries = Object.values(journal.deliveries);
    assert.equal(deliveries.length, 1, 'Exactly one journaled delivery');
    assert.equal(deliveries[0].kind, 'inbox'); assert.equal(deliveries[0].targetAgentId, assistantId); assert.equal(deliveries[0].ownerAgentId, assistantId);
    assert.equal(deliveries[0].inbox.commentIds.length, 1); assert.equal(deliveries[0].outcome, 'completed');
    for (const forbidden of ['第二步看不懂', '<img', pageOrigin, token]) assert.equal(journalText.includes(forbidden), false, 'service.json holds no visitor text, page address or token');
    const current = await rpc('board.read', { boardId: board.id });
    assert.deepEqual(current.board.interactions, [], 'No Board interaction was created');
  });

  await step('the assistant reads the comment and replies through its MCP tools; the ledger records the reply', async () => {
    const comment = await until(async () => { const found = (await inbox()).comments.find(item => item.externalId === firstComment.externalId); return found?.replies?.length && found; }, 'the recorded reply');
    assert.equal(comment.status, 'resolved');
    assert.deepEqual(comment.replies.map(reply => ({ text: reply.text, authorKind: reply.authorKind, actor: reply.actor })), [{ text: '谢谢！第二步指的是先保存草稿，再点提交。', authorKind: 'agent', actor: { kind: 'agent', id: assistantId } }]);
    assert.deepEqual(assistant.toolCalls.map(call => call.name), ['board_inbox_read', 'board_inbox_reply']);
    assert.ok(assistant.toolResults[0].includes('第二步看不懂'), 'The assistant reads the text only as a tool result');
    assert.ok(assistant.toolResults[0].includes('external-untrusted'));
    const status = await autoStatus();
    assert.equal(status.wake.lastWakeResult, 'completed'); assert.equal(status.wake.state, 'idle'); assert.equal(status.wake.wakesLastHour, 1);
    assert.deepEqual(sdk.errors, []);
  });

  await step('visitor 1 sees 1 条新回复 after a focus poll; the panel shows 作者的 AI 助手回复 and renders text literally', async () => {
    await visitor1.waitBadge('我的评论 1 · 1 条新回复');
    measures.replyVisibleMs = Date.now() - firstComment.sentAt;
    const [marker] = await until(async () => { const found = await visitor1.markers(); return found[0]?.unread && found; }, 'the unread marker');
    assert.equal(marker.label, '我的评论 1：已回复');
    await visitor1.clickOuter('[data-pbc=badge]');
    const panel = (await until(async () => (await visitor1.ui()).panel, 'the thread panel'));
    for (const text of ['我的评论', '“第二步”', firstText, '已回复', '作者的 AI 助手回复', '谢谢！第二步指的是先保存草稿，再点提交。']) assert.ok(panel.includes(text), text);
    assert.equal(await visitor1.evaluate("document.querySelectorAll('[data-pbc=panel] img').length"), 0);
    assert.deepEqual(cdp.dialogs, [], 'No visitor markup executed');
    await visitor1.key('Escape', 'Escape', 27);
    await until(async () => !(await visitor1.ui()).panel, 'the panel to close');
  });

  const secondText = '嵌套区域这句话能再解释一下吗？';
  const visitor2 = await step('visitor 2 (another browser profile) selects text in a nested scroller, uses the floating 评论 button and sends', async () => {
    const visitor = await openVisitor('visitor 2');
    await visitor.open(pageUrl);
    await visitor.dragSelect('#nested', '嵌套区域');
    await until(async () => (await visitor.ui()).float, 'the floating button');
    await visitor.clickOuter('[data-pbc=float]');
    await until(async () => (await visitor.ui()).focus === '评论', 'the composer from the button');
    await visitor.command('Input.insertText', { text: secondText });
    await visitor.clickOuter('[data-pbc=send]');
    await until(async () => { const value = await visitor.ui(); return !value.composer && value.badge === '我的评论 1'; }, 'visitor 2 confirmed send');
    const rows = backendRows();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].visitor_hash, rows[1].visitor_hash, 'Two visitors have distinct anonymous identities');
    for (const row of rows) assert.match(row.visitor_hash, /^[a-f0-9]{64}$/);
    const secrets = await Promise.all([visitor1, visitor].map(async item => JSON.parse(JSON.parse(await item.storage()).local[`paseo-board-visitor:v2:${probe.appKey}`]).secret));
    assert.notEqual(secrets[0], secrets[1]);
    for (const secret of secrets) assert.equal(rows.some(row => Object.values(row).includes(secret)), false, 'The backend stores no visitor secret');
    measures.secondSentAt = Date.now();
    return visitor;
  });

  await step('visitor 2 gets their own reply; neither visitor sees the other\'s thread', async () => {
    await until(() => assistant.wakes.length === 2 && sdk.idle().then(() => true), 'the second wake');
    await visitor2.waitBadge('我的评论 1 · 1 条新回复');
    await visitor2.clickOuter('[data-pbc=badge]');
    const panel2 = await until(async () => (await visitor2.ui()).panel, 'visitor 2 panel');
    assert.ok(panel2.includes(secondText)); assert.ok(panel2.includes('谢谢你的评论，我们会把「嵌套区域」写得更清楚。'));
    assert.equal(panel2.includes('第二步'), false, 'Visitor 2 does not see visitor 1');
    await visitor2.key('Escape', 'Escape', 27);
    await visitor1.clickOuter('[data-pbc=badge]');
    const panel1 = await until(async () => (await visitor1.ui()).panel, 'visitor 1 panel');
    assert.equal(panel1.includes(secondText), false, 'Visitor 1 does not see visitor 2');
    await visitor1.key('Escape', 'Escape', 27);
    // The marker follows a nested scroll.
    const before = (await visitor2.markers())[0];
    await visitor2.frame("document.querySelector('#scroller').scrollTop=30,true");
    await until(async () => { const after = (await visitor2.markers())[0]; return after && Math.abs(after.y - (before.y - 30)) <= 1; }, 'the marker to follow the nested scroll');
  });

  await step('after a reload the marker and the replied thread come back for visitor 1', async () => {
    await visitor1.reload();
    const [marker] = await until(async () => { const found = await visitor1.markers(); return found.length === 1 && found; }, 'the marker after reload');
    assert.equal(marker.label, '我的评论 1：已回复');
    assert.equal((await visitor1.ui()).badge, '我的评论 1');
  });

  await step('the token never reaches the page, browser storage, the frame, prompts, tool results, auto-status or logs', async () => {
    const places = {
      'page HTML': release.html,
      'visitor 1 outer DOM': await visitor1.evaluate('document.documentElement.outerHTML'),
      'visitor 1 frame DOM': await visitor1.frame('document.documentElement.outerHTML'),
      'visitor 2 frame DOM': await visitor2.frame('document.documentElement.outerHTML'),
      'visitor 1 storage': await visitor1.storage(), 'visitor 2 storage': await visitor2.storage(),
      'agent prompts': JSON.stringify(sdk.sends), 'tool results': assistant.toolResults.join('\n'),
      'auto-status': JSON.stringify(await autoStatus()), 'inbox page': JSON.stringify(await inbox()),
      'plugin and MCP logs': logs.join('\n'), 'browser console': cdp.console.join('\n'), 'backend output': backendOutput,
      'service.json': await readFile(join(paths.data, 'service.json'), 'utf8'),
    };
    for (const [place, text] of Object.entries(places)) assert.equal(text.includes(token), false, `The token appears in ${place}`);
    for (const place of ['visitor 1 storage', 'visitor 2 storage']) {
      const { local } = JSON.parse(places[place]);
      assert.deepEqual(Object.keys(local).sort(), ['paseo-board-comments-hint:v1', `paseo-board-visitor:v2:${probe.appKey}`].sort(), `${place} keeps only the anonymous key and the hint`);
      assert.equal(JSON.stringify(local).includes('第二步') || JSON.stringify(local).includes('嵌套') || JSON.stringify(local).includes('谢谢'), false);
    }
    assert.equal(places['visitor 1 frame DOM'].includes(JSON.parse(JSON.parse(places['visitor 1 storage']).local[`paseo-board-visitor:v2:${probe.appKey}`]).secret), false, 'The visitor secret never reaches the canvas frame');
  });

  // -------------------------------------------------------------------------------------------------------
  const postAs = async (visitorSecret, key, body) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Board-Visitor': visitorSecret, Origin: pageOrigin }, body: JSON.stringify(body) });
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).comment;
  };
  const anchorFor = quote => ({ selector: '#step-two', quote, releaseId: release.manifest.releaseId });

  await step('automatic handling off: a new comment is imported and nobody is woken', async () => {
    const page = await inbox();
    await rpc('board.inbox.policy', { ...scope, expectedRevision: page.revision, eventId: 'auto-off', policy: { read: true, triage: true, auto: 'off' } });
    const wakes = assistant.wakes.length, sends = sdk.sends.length;
    const comment = await postAs('c'.repeat(64), 'pc-e2e-auto-off-0001', { text: '自动处理关闭时的评论', pageUrl, anchor: anchorFor('保存') });
    await until(async () => (await inbox()).comments.some(item => item.externalId === comment.externalId), 'the import with auto off', 3_000);
    // An odd but valid page normalizes on both sides and never blocks sync.
    const odd = await postAs('d'.repeat(64), 'pc-e2e-odd-0001', { text: '全角空格称呼和大写网址', authorName: '　', pageUrl: pageUrl.replace('http://localhost', 'HTTP://LOCALHOST') });
    const imported = await until(async () => (await inbox()).comments.find(item => item.externalId === odd.externalId), 'the odd import', 3_000);
    assert.equal(imported.authorName, undefined); assert.equal(imported.pageUrl, pageUrl);
    await sleep(limits.wakeMaxDelayMs + 1_000);
    assert.equal(assistant.wakes.length, wakes); assert.equal(sdk.sends.length, sends);
    const status = await autoStatus();
    assert.equal(status.wake.state, 'legacy-internal'); assert.ok(['idle', 'syncing'].includes(status.sync.sources[0].state)); assert.equal(status.sync.sources[0].lastError, null);
    assert.equal(status.sync.sources[0].skipped, 0); assert.equal(status.sync.sources[0].sanitized, 0);
  });

  await step('budget: two more wakes, then a visible budget pause; it resumes automatically and one wake lists every waiting comment', async () => {
    const page = await inbox();
    const enabled = await rpc('board.inbox.auto-enable', { ...scope, expectedRevision: page.revision, eventId: 'enable-again', replyMode: 'publish', modeId: 'default', acceptRisk: false });
    assert.equal(enabled.assistant.agentId, assistantId, 'The same assistant is reused'); assert.equal(sdk.created.length, 1);
    await sleep(limits.wakeMaxDelayMs + 500);
    assert.equal(assistant.wakes.length, 2, 'The backlog from while auto was off is not woken');
    const posted = [];
    for (const [index, quote] of ['第二步', '保存', '提交'].entries()) {
      posted.push(await postAs(String(index + 1).repeat(64).slice(0, 64).replace(/[^a-f0-9]/g, 'e'), `pc-e2e-budget-000${index}`, { text: `预算测试评论 ${index + 1}`, pageUrl, anchor: anchorFor(quote) }));
      if (index < 2) await until(() => assistant.wakes.length === 3 + index && sdk.idle().then(() => true), `budget wake ${index + 1}`);
    }
    const paused = await until(async () => { const status = await autoStatus(); return status.wake.state === 'paused' && status; }, 'the budget pause');
    assert.equal(paused.wake.pausedReason, 'budget'); assert.equal(paused.wake.wakesLastHour, 4); assert.equal(paused.wake.maxWakesPerHour, 4);
    assert.ok(paused.wake.resumesAt);
    posted.push(await postAs('f'.repeat(64), 'pc-e2e-budget-0003', { text: '预算测试评论 4', pageUrl, anchor: anchorFor('先保存') }));
    await until(async () => (await inbox()).comments.some(item => item.externalId === posted[3].externalId), 'the import while paused', 3_000);
    await sleep(limits.wakeMaxDelayMs);
    assert.equal(assistant.wakes.length, 4);
    // Move the coordinator's clock past the hour window; it resumes by itself.
    clock.advance(Date.parse(paused.wake.resumesAt) - clock.now() + 1_000);
    await until(() => assistant.wakes.length === 5 && sdk.idle().then(() => true), 'the automatic resume wake');
    const last = assistant.wakes[4].wake.comments.map(item => item.commentId);
    const ids = (await inbox()).comments.filter(item => posted.slice(2).some(row => row.externalId === item.externalId)).map(item => item.id);
    assert.deepEqual(last.sort(), ids.sort(), 'One wake lists both waiting comments');
    const status = await autoStatus();
    assert.ok(status.wake.lastBudgetPause, 'The panel can show the past pause'); assert.equal(status.wake.state, 'idle');
    for (const row of posted) {
      const comment = (await inbox()).comments.find(item => item.externalId === row.externalId);
      assert.equal(comment.replies?.length, 1, `reply for ${row.text}`);
    }
  });

  await step('an old plugin still reads the new runtime: the v1 export parses with the 4b94741 schema', async () => {
    const legacy = await fetch(`${endpoint}?cursor=0&limit=100`, { headers: { Authorization: `Bearer ${token}` } }).then(response => response.json());
    const parsed = LegacyInboxPageSchema.safeParse(legacy);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 3)));
    assert.equal(parsed.data.comments.length, backendRows().length);
    const replies = new DatabaseSync(backend.database, { readOnly: true });
    try { assert.equal(replies.prepare('SELECT count(*) AS n FROM _board_comment_replies').get().n, 6); } finally { replies.close(); }
  });

  await step('no browser errors and no failed fake-agent turns', async () => {
    assert.deepEqual(cdp.errors, []);
    assert.deepEqual(sdk.errors, []);
    assert.deepEqual(sdk.sends.filter(send => send.id === 'owner'), []);
  });

  function backendRows() {
    const db = new DatabaseSync(backend.database, { readOnly: true });
    try { return db.prepare('SELECT external_id, text, anchor_json, page_url, visitor_hash, page_key FROM _board_comments ORDER BY seq').all(); } finally { db.close(); }
  }
} catch (error) {
  process.exitCode = 1;
  console.error('Page comments e2e failed:', error);
} finally {
  for (const close of cleanup.reverse()) { try { await close(); } catch (error) { console.error('cleanup:', error?.message ?? error); } }
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const failed = results.filter(result => !result.ok).length;
  console.log(`\nPage comments e2e: ${results.length - failed}/${results.length} steps passed${failed || process.exitCode ? ' (FAILED)' : ''}.`);
  if (measures.importMs !== undefined) console.log(`MEASURE visitor send → plugin import: ${measures.importMs} ms; send → reply visible in the page: ${measures.replyVisibleMs ?? 'n/a'} ms (test sync interval ${300} ms, wake debounce 400 ms).`);
}

function run(command, args, options) {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}
