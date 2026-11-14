import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { installInboxHostFixture } from './inbox-host-fixture.mjs';

// The provider's model list as daemon 0.16.0-beta.2 reports it for `claude` (paseo.providers.listModels).
const DAEMON_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' }, { id: 'claude-opus-5', label: 'Opus 5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' }, { id: 'claude-opus-4-6', label: 'Opus 4.6' }, { id: 'claude-haiku-5-5', label: 'Haiku 5.5' }, { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
/** The server's and the panel's own code (server/inbox-assistant.ts, client/inbox-status.ts), checked against the RPC contract. */
async function serverCode() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = await build({ stdin: { contents: "export { assistantModelChoices, recommendedModelId, NO_CLAUDE_REFUSAL, violationRefusal } from './server/inbox-assistant.ts'; export { InboxAssistantOptionsSchema, PUBLIC_DIRECT_TEXT } from './shared/inbox.ts'; export { modelButtonLabel, capLine } from './client/inbox-status.ts';", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
function assistantOptions(code, patch = {}) {
  const models = code.assistantModelChoices(DAEMON_MODELS);
  return code.InboxAssistantOptionsSchema.parse({ refusal: null, providerId: 'claude', providerLabel: 'claude', models, recommendedModelId: code.recommendedModelId(models), priceTableDate: '2026-11', firstTime: true, current: null, legacy: null, ...patch });
}

export async function runInboxHostChecks({ assert, command, evaluate, until, frame, untilFrame, key, click, hostClick, hostLocation, sendText, submitCount, canvasRect, check }) {
  const modal = '[data-fixture-modal]', panel = '[data-testid="board-inbox-panel"]', sources = '[data-testid="board-inbox-sources"]';
  const button = label => `button[aria-label=${JSON.stringify(label)}]`;
  const field = label => `[aria-label=${JSON.stringify(label)}]`;
  let compact = false;
  const count = name => evaluate(`inboxFixture.state.calls.filter(call=>call.name===${JSON.stringify(name)}).length`);
  const waitButton = label => until(`document.querySelector(${JSON.stringify(button(label))}) && !document.querySelector(${JSON.stringify(button(label))}).disabled`);
  const activate = async selector => { if (compact) await revealByWheel(selector); await hostClick(selector); };
  const press = async label => { await waitButton(label); await activate(button(label)); };
  const type = async (label, text) => {
    const selector = field(label);
    await activate(selector);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, commands: ['selectAll'] });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0, windowsVirtualKeyCode: 65 });
    assert.ok(await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});return input.selectionStart===0&&input.selectionEnd===input.value.length})()`), `Native select-all must select the existing ${label}`);
    await sendText(text);
    await until(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);
  };
  const settle = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const geometry = selector => evaluate(`(()=>{
    const node=document.querySelector(${JSON.stringify(selector)}),r=node.getBoundingClientRect(),chain=[];
    let visible={left:0,top:0,right:innerWidth,bottom:innerHeight};
    for(let parent=node.parentElement;parent;parent=parent.parentElement){
      const style=getComputedStyle(parent),box=parent.getBoundingClientRect();
      if(/auto|scroll|hidden|clip/.test(style.overflowY)){
        visible={left:Math.max(visible.left,box.left+parent.clientLeft),top:Math.max(visible.top,box.top+parent.clientTop),right:Math.min(visible.right,box.left+parent.clientLeft+parent.clientWidth),bottom:Math.min(visible.bottom,box.top+parent.clientTop+parent.clientHeight)};
        chain.push({testId:parent.dataset.testid,rect:box.toJSON(),scrollTop:parent.scrollTop,scrollHeight:parent.scrollHeight,clientHeight:parent.clientHeight});
      }
    }
    const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    return {rect:r.toJSON(),visible,chain,hit:hit?.outerHTML.slice(0,180),matches:node===hit||node.contains(hit),inside:r.top>=visible.top+8&&r.bottom<=visible.bottom-8};
  })()`);
  const revealByWheel = async selector => {
    await until(`document.querySelector(${JSON.stringify(selector)})`);
    const before=await geometry(selector);
    for(let step=0;step<12;step++){
      const view=await geometry(selector);
      if(view.inside&&view.matches){ console.log('MEASURE inbox-native-scroll',JSON.stringify({selector,before,after:view,steps:step}));return; }
      const point={x:(view.visible.left+view.visible.right)/2,y:(view.visible.top+view.visible.bottom)/2};
      const desired=view.rect.top+view.rect.height/2-point.y;
      await command('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await command('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:Math.sign(desired||1)*Math.max(60,Math.min(250,Math.abs(desired))),modifiers:0});
      await settle();
    }
    assert.fail(`Native wheel could not reveal inbox control: ${JSON.stringify({selector,before,after:await geometry(selector)})}`);
  };
  const snap = async name => {
    if (!process.env.BOARD_INBOX_SCREENSHOT_DIR) return;
    await mkdir(process.env.BOARD_INBOX_SCREENSHOT_DIR, { recursive: true });
    const result = await command('Page.captureScreenshot', { format: 'png' });
    const path = join(process.env.BOARD_INBOX_SCREENSHOT_DIR, `${name}.png`);
    await writeFile(path, Buffer.from(result.data, 'base64')); console.log(`ARTIFACT inbox-screenshot ${path}`);
  };
  let stage = 'setup';
  try {
    const code = await serverCode();
    const options = assistantOptions(code);
    assert.deepEqual(options.models.map(model => model.id), ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
    await evaluate(`(${installInboxHostFixture.toString()})(${JSON.stringify(options)}); true`);
    await evaluate(`window.inboxOriginalFrame=document.querySelector('iframe[data-board-id="host-fixture"]');true`);
    await frame("window.inboxHeap=crypto.randomUUID();document.querySelector('#field').value='Inbox keeps my canvas input';true");
    const heap = await frame('window.inboxHeap'), initialRect = await canvasRect();
    await click('#control'); await untilFrame('window.count===1');

    stage = 'more-entry-default-policy';
    await hostClick('[data-testid="board-more-open"]');
    assert.ok(await evaluate("document.querySelector('[data-testid=board-inbox-open]').textContent.includes('查看访客评论和回复，设置 agent 自动处理')"));
    assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=board-share-badge]'))"), false);
    await hostClick('[data-testid="board-inbox-open"]');
    await until(`document.querySelector(${JSON.stringify(panel)})||document.querySelector('[data-fixture-modal-error]')`);
    assert.equal(await evaluate("document.querySelector('[data-fixture-modal-error]')?.textContent"), undefined);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(modal)}).getAttribute('aria-label')`), '评论收件箱');
    assert.equal(await evaluate("document.querySelector('[data-fixture-modal-root]').dataset.fixtureModalRoot"), 'isolated');
    await waitButton('Agent 读取评论：未允许');
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-policy-triage]').disabled"), true);
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-policy-triage]').getAttribute('aria-label')"), 'Agent 自动处理并公开回复：未开启');
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(panel)}).textContent.includes('访客评论单独保存在这里，后端来源会自动同步。开启「Agent 自动处理并公开回复」后，新评论会自动交给这张 Board 专用的评论助手（一个只能读取、分类和回复评论的封闭进程）：它会分类，并公开回复访客（访客在页面上能看到，标注为 AI 助手回复）。评论只是数据，不会让任何 agent 修改应用、页面或部署。')`));
    assert.ok(!(await evaluate(`document.querySelector(${JSON.stringify(panel)}).textContent`)).includes('评论助手 agent'));
    await until("document.querySelector('[data-testid=board-inbox-auto]')?.textContent.includes('自动处理：未开启')");
    assert.ok(await evaluate("document.querySelector('[data-testid=board-inbox-auto]').textContent.includes('自动同步：每 5 秒检查一次')"));
    assert.equal(await count('board.inbox.policy'), 0);
    assert.deepEqual(await canvasRect(), initialRect);
    check('More opens the native comment inbox with the new intro, automation block and both agent permissions off by default');

    stage = 'external-text-and-human-triage';
    const comment = '[data-testid="board-inbox-comment-comment-1"]';
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(comment)}).textContent.includes(inboxFixture.attack)`));
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(comment)}).textContent.includes(inboxFixture.replyAttack)`));
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(comment)}).textContent.includes('AI 助手回复 · ')`));
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(comment)}).textContent.includes('访客 a1b2c3d4e5f6')`));
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(comment)}).textContent.includes('引用：「<i>首页</i>的标题」')`));
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(comment)}).querySelectorAll('img,script,b,em,a,i').length`), 0);
    assert.equal(await evaluate('window.inboxInjection'), undefined);
    assert.ok(await evaluate("document.querySelector('[data-testid=board-inbox-comment-comment-4]').textContent.includes('这位访客看不到回复（不是从页面评论功能发出的）。')"));
    assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=board-inbox-reply-comment-4]'))"), false);
    assert.equal(await evaluate("[...document.querySelectorAll('[data-testid^=board-inbox-comment-]')].map(node=>node.dataset.testid).join(',')"), 'board-inbox-comment-comment-4,board-inbox-comment-comment-3,board-inbox-comment-comment-1');
    // Bidi override controls in visitor text are shown as visible markers, never applied.
    assert.ok(await evaluate("document.querySelector('[data-testid=board-inbox-comment-comment-3]').textContent.includes('页面上的图表看不清 [U+202E]evil[U+202C]')"));
    assert.equal(await evaluate("/[\\u202A-\\u202E\\u2066-\\u2069]/.test(document.querySelector('[data-testid=board-inbox-comment-comment-3]').textContent)"), false);
    await hostClick(`${comment} ${button('内部处理')}`);
    await type('内部标签', 'needs-review, 产品建议');
    await type('内部备注', '内部核对，尚未授权公开回复');
    await press('处理中');
    await until(`document.querySelector(${JSON.stringify(comment)}).textContent.includes('内部核对，尚未授权公开回复') && !document.querySelector(${JSON.stringify(field('内部备注'))})`);
    const triage = await evaluate("inboxFixture.state.calls.find(call=>call.name==='board.inbox.triage').input");
    assert.equal(triage.expectedCommentRevision, 1); assert.equal(triage.status, 'reviewing');
    assert.deepEqual(triage.labels, ['needs-review', '产品建议']);
    assert.deepEqual(await evaluate('inboxFixture.state.policy'), { read: false, triage: false });
    check('External HTML-looking comments and replies stay inert, newest first, bidi controls show as markers; human triage saves internal labels and notes while agent permissions remain off');

    stage = 'human-reply-unknown-retry-and-guard';
    await hostClick('[data-testid="board-inbox-reply-comment-1"]');
    await type('公开回复', '谢谢反馈，标题已经改好。');
    await evaluate("inboxFixture.state.nextReplyFailure='unknown';true");
    await press('发送回复');
    await until(`document.querySelector(${JSON.stringify(comment)}).textContent.includes('送达结果未知，回复原文已保留。点「重试」会用同一编号，不会重复发送。')`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(field('公开回复'))}).disabled`), true);
    await press('重试');
    await until(`document.querySelector(${JSON.stringify(panel)}).textContent.includes('已发送。访客页面会在十几秒内显示。')`);
    const replies = await evaluate("inboxFixture.state.calls.filter(call=>call.name==='board.inbox.reply').map(call=>call.input)");
    assert.equal(replies.length, 2); assert.equal(replies[0].eventId, replies[1].eventId); assert.equal(replies[0].text, replies[1].text);
    assert.equal(replies[0].allowSensitive, undefined);
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(comment)}).textContent.includes('作者回复 · ')`));
    await hostClick('[data-testid="board-inbox-reply-comment-1"]');
    await type('公开回复', '令牌是 fixture-secret');
    await evaluate("inboxFixture.state.nextReplyFailure='guard';true");
    await press('发送回复');
    await until(`document.querySelector(${JSON.stringify(comment)}).textContent.includes('回复看起来包含私密信息（令牌）。仍然发送？')`);
    await press('仍然发送');
    await until(`!document.querySelector(${JSON.stringify(field('公开回复'))})`);
    const override = await evaluate("inboxFixture.state.calls.filter(call=>call.name==='board.inbox.reply').slice(-2).map(call=>call.input)");
    assert.equal(override[0].eventId, override[1].eventId); assert.equal(override[1].allowSensitive, true); assert.equal(override[0].allowSensitive, undefined);
    const draftCard = '[data-testid="board-inbox-comment-comment-3"]';
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(draftCard)}).textContent.includes('AI 草稿（待你审核）')`));
    await hostClick(`${draftCard} ${button('发布')}`);
    await until(`document.querySelector(${JSON.stringify(draftCard)}).textContent.includes('AI 助手回复 · ') && !document.querySelector(${JSON.stringify(draftCard)}).textContent.includes('AI 草稿（待你审核）')`);
    assert.equal(await evaluate("inboxFixture.state.calls.find(call=>call.name==='board.inbox.reply-pending').input.action"), 'publish');
    check('A human reply retries an unknown result with the same eventId and text, confirms a guard refusal explicitly, and publishes an AI draft');

    stage = 'policy-concurrency-and-confirm';
    await evaluate('inboxFixture.state.holdPolicy=true;true');
    await press('Agent 读取评论：未允许');
    await until("inboxFixture.state.calls.some(call=>call.name==='board.inbox.policy')");
    const policyCount = await count('board.inbox.policy');
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-policy-read]').disabled"), true);
    await hostClick('[data-testid="board-inbox-policy-read"]');
    assert.equal(await count('board.inbox.policy'), policyCount);
    await evaluate('inboxFixture.releasePolicy();true');
    // Fail closed: a host without a usable Claude route shows the server's refusal and cannot confirm.
    await evaluate(`inboxFixture.setAssistantOptions(${JSON.stringify(assistantOptions(code, { refusal: code.NO_CLAUDE_REFUSAL, providerId: null, providerLabel: null, models: [], recommendedModelId: null }))});true`);
    await press('Agent 自动处理并公开回复：未开启');
    await until(`document.querySelector('[data-testid=board-inbox-auto-dialog]')?.textContent.includes(${JSON.stringify(code.NO_CLAUDE_REFUSAL)})`);
    assert.equal(await evaluate("document.querySelectorAll('[data-testid=board-inbox-auto-dialog] [data-testid^=board-inbox-auto-model-]').length"), 0);
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-triage-confirm]').disabled"), true);
    await hostClick('[data-testid="board-inbox-auto-dialog"] button[aria-label="取消"]');
    await until("!document.querySelector('[data-testid=board-inbox-auto-dialog]')");
    assert.equal(await count('board.inbox.auto-enable'), 0);
    await evaluate(`inboxFixture.setAssistantOptions(${JSON.stringify(options)});true`);
    await press('Agent 自动处理并公开回复：未开启');
    await until("document.querySelector('[data-testid=board-inbox-auto-model-claude-haiku-5-5]')");
    const dialog = await evaluate("document.querySelector('[data-testid=board-inbox-auto-dialog]').textContent");
    for (const line of [
      '开启「Agent 自动处理并公开回复」？',
      '新评论会交给这张 Board 专用的评论助手。它不是 Paseo 里的 agent：每批评论单独启动一次 Claude Code，处理完就结束，不保留对话。回复在访客的页面上可见，标注为 AI 助手回复。',
      '评论可能包含诱导内容。评论助手只能读取、分类和回复这一批评论：没有命令、文件、网络和其他插件的工具，也不加载你的 Claude Code 设置、CLAUDE.md 和记忆。每次启动都会先检查这一点，检查不通过就不处理。',
      '每张 Board 每小时最多处理 12 批，每天花费到上限后暂停。开启前已有的评论不会自动处理。',
      '费用按 Claude API 标价估算（价格表 2026-11）；使用 Claude 订阅时计入订阅额度。实际花费通常更低（有缓存）。',
      code.capLine(0.5),
    ]) assert.ok(dialog.includes(line), line);
    for (const gone of ['权限模式', '我了解风险', '将创建一个新的评论助手 agent', '会先请你批准']) assert.ok(!dialog.includes(gone), gone);
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-testid=board-inbox-auto-dialog] [data-testid^=board-inbox-auto-model-]')].map(node=>node.textContent)"), options.models.map(model => code.modelButtonLabel(model, model.id === options.recommendedModelId)));
    assert.match(options.models.map(model => code.modelButtonLabel(model, model.id === options.recommendedModelId))[0], /^Haiku 5\.5（推荐，最便宜） · 约 \$0\.00\d\d–0\.00\d\d\/条$/);
    // The cheapest priced model and, the first time, review mode are preselected.
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-auto-model-claude-haiku-5-5]').getAttribute('aria-selected')"), 'true');
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-auto-mode-review]').getAttribute('aria-selected')"), 'true');
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-triage-confirm]').disabled"), false);
    await snap('inbox-auto-dialog-recommended');
    // 「公开讨论里的 AI 回复直接发布（我了解风险）」: only with 直接公开回复, unticked, with the plain warning once ticked.
    const direct = code.PUBLIC_DIRECT_TEXT, dialogText = () => evaluate("document.querySelector('[data-testid=board-inbox-auto-dialog]').textContent");
    assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=board-inbox-auto-public-direct]'))"), false);
    await hostClick('[data-testid="board-inbox-auto-mode-publish"]');
    await until("document.querySelector('[data-testid=board-inbox-auto-public-direct]')");
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-auto-public-direct]').getAttribute('aria-label')"), direct.label);
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-auto-public-direct]').getAttribute('aria-selected')"), 'false');
    assert.ok((await dialogText()).includes(direct.off)); assert.ok(!(await dialogText()).includes(direct.warning));
    await hostClick('[data-testid="board-inbox-auto-public-direct"]');
    await until(`document.querySelector('[data-testid=board-inbox-auto-dialog]').textContent.includes(${JSON.stringify(direct.warning)})`);
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-auto-public-direct]').getAttribute('aria-selected')"), 'true');
    await snap('inbox-auto-dialog-public-direct');
    // The server's preflight refuses: the check is shown while it runs, then its exact text; nothing is enabled.
    const violation = code.violationRefusal(['工具 Bash', 'MCP 服务 learning']);
    await evaluate(`inboxFixture.state.holdEnable=true;inboxFixture.state.nextEnableRefusal=${JSON.stringify(violation)};true`);
    await press('确认开启');
    // The ticked box goes with 直接公开回复 (this attempt is refused below, so nothing is stored).
    await until("inboxFixture.state.calls.some(call=>call.name==='board.inbox.auto-enable')");
    assert.deepEqual(await evaluate("(({replyMode,publicDirect})=>({replyMode,publicDirect}))(inboxFixture.state.calls.filter(call=>call.name==='board.inbox.auto-enable').at(-1).input)"), { replyMode: 'publish', publicDirect: true });
    await until("document.querySelector('[data-testid=board-inbox-triage-confirm]')?.getAttribute('aria-label')==='正在做锁定检查…'");
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-triage-confirm]').disabled"), true);
    await evaluate('inboxFixture.releaseEnable();true');
    await until(`document.querySelector('[data-testid=board-inbox-auto-dialog]')?.textContent.includes(${JSON.stringify(violation)})`);
    assert.equal(await evaluate("inboxFixture.state.policy.auto ?? 'off'"), 'off');
    assert.equal(await evaluate('inboxFixture.state.publicDirect'), false);
    await snap('inbox-auto-dialog-lockdown-refused');
    // Back to 回复先给我审核: the box disappears and is not sent, even though it was ticked.
    await hostClick('[data-testid="board-inbox-auto-mode-review"]');
    await until("!document.querySelector('[data-testid=board-inbox-auto-public-direct]')");
    await hostClick('[data-testid="board-inbox-auto-model-claude-sonnet-5-5"]');
    await until("document.querySelector('[data-testid=board-inbox-auto-dialog]').textContent.includes('每天最多 $5，到上限后暂停到第二天。')");
    await press('确认开启');
    await waitButton('Agent 自动处理并公开回复：已开启（回复需你审核）');
    const enable = await evaluate("inboxFixture.state.calls.filter(call=>call.name==='board.inbox.auto-enable').at(-1).input");
    assert.equal(enable.modelId, 'claude-sonnet-5-5'); assert.equal(enable.replyMode, 'review'); assert.equal(enable.effort, 'low');
    assert.ok(!('modeId' in enable) && !('acceptRisk' in enable) && !('publicDirect' in enable), JSON.stringify(enable));
    await until(`document.querySelector('[data-testid=board-inbox-auto]').textContent.includes('评论助手：Sonnet 5.5 · 每批新会话 · 锁定检查 ${String(new Date(2026, 10, 14, 9, 12).getHours()).padStart(2, '0')}:12 通过（Claude Code 2.1.325）')`);
    assert.ok(await evaluate("document.querySelector('[data-testid=board-inbox-auto]').textContent.includes('花费：最近一小时 $0 · 今天 $0.0005 / 上限 $5（按 API 价格估算）')"));
    const directBlock = '[data-testid="board-inbox-public-direct"]';
    await until(`document.querySelector(${JSON.stringify(directBlock)})?.textContent.includes(${JSON.stringify(direct.reviewOnly)})`);
    assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=board-inbox-public-direct-toggle]'))"), false);
    await press('回复方式：先给我审核'); await waitButton('回复方式：直接公开');
    assert.deepEqual(await evaluate('inboxFixture.state.policy'), { read: true, triage: true, auto: 'publish' });
    // In 直接公开 mode the automation block offers the opt-in, off by default; turning it on shows the warning.
    await until(`document.querySelector(${JSON.stringify(directBlock)})?.textContent.includes(${JSON.stringify(direct.off)})`);
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-public-direct-toggle]').getAttribute('aria-selected')"), 'false');
    await hostClick('[data-testid="board-inbox-public-direct-toggle"]');
    await until(`document.querySelector(${JSON.stringify(directBlock)})?.textContent.includes(${JSON.stringify(direct.warning)}) && document.querySelector(${JSON.stringify(directBlock)}).textContent.includes(${JSON.stringify(direct.on)})`);
    assert.equal(await evaluate("inboxFixture.state.calls.filter(call=>call.name==='board.inbox.auto-set').at(-1).input.publicDirect"), true);
    await snap('inbox-auto-public-direct-on');
    await hostClick('[data-testid="board-inbox-public-direct-toggle"]');
    await until(`document.querySelector(${JSON.stringify(directBlock)})?.textContent.includes(${JSON.stringify(direct.off)})`);
    assert.equal(await evaluate("inboxFixture.state.calls.filter(call=>call.name==='board.inbox.auto-set').at(-1).input.publicDirect"), false);
    await press('Agent 自动处理并公开回复：已开启（直接回复）');
    await until(`document.querySelector(${JSON.stringify(panel)}).textContent.includes('已关闭。')`);
    assert.ok(!(await evaluate(`document.querySelector(${JSON.stringify(panel)}).textContent`)).includes('归档它'));
    assert.deepEqual(await evaluate('inboxFixture.state.policy'), { read: true, triage: false, auto: 'off' });
    await press('Agent 读取评论：已允许'); await waitButton('Agent 读取评论：未允许');
    assert.deepEqual(await evaluate('inboxFixture.state.policy'), { read: false, triage: false, auto: 'off' });
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-policy-triage]').disabled"), true);
    check('Policy toggles serialize; automatic handling turns on only through the confirm dialog after the server\'s lockdown preflight, and turning read off revokes everything');
    check('The dialog offers the provider\'s priced models cheapest first with estimates and the daily cap, preselects Haiku 5.5 and review mode, shows the check in progress and the exact refusal, and never offers a permission mode');
    check('「公开讨论里的 AI 回复直接发布（我了解风险）」 appears only with 直接公开, unticked, with its plain warning, is sent only when ticked in that mode, and toggles from the automation block');

    stage = 'automation-lines-and-buttons';
    const auto = '[data-testid="board-inbox-auto"]';
    const showAuto = async (patch, text) => {
      await evaluate(`inboxFixture.setAuto(${JSON.stringify(patch)});true`);
      await press('刷新收件箱');
      await until(`document.querySelector(${JSON.stringify(auto)})?.textContent.includes(${JSON.stringify(text)})`);
    };
    await evaluate("inboxFixture.state.policy={read:true,triage:true,auto:'publish'};true");
    const sealed = { kind: 'sealed', modelId: 'claude-haiku-5-5', modelLabel: 'Haiku 5.5', effort: 'low', providerId: 'claude', lastCheck: { at: '2026-11-14T01:12:00.000Z', ok: true, cliVersion: '2.1.325', findings: [] }, costLastHourUsd: 0.0031, costTodayUsd: 0.0125, dailyCapUsd: 0.5, avgCostPerCommentUsd: 0.0016 };
    await showAuto({ assistant: sealed, wake: { state: 'batching', pendingComments: 3, nextWakeAt: new Date(Date.now() + 2500).toISOString() } }, '自动处理：3 条新评论，约 ');
    await showAuto({ assistant: sealed, wake: { state: 'checking' } }, '正在做锁定检查…');
    await showAuto({ assistant: sealed, wake: { state: 'paused', pausedReason: 'budget', resumesAt: '2026-11-08T13:42:00.000Z', pendingComments: 4 } }, '自动处理已暂停：一小时内已处理 12 批');
    await showAuto({ assistant: sealed, wake: { state: 'paused', pausedReason: 'cost', resumesAt: '2026-11-15T00:00:00.000Z' } }, '自动处理已暂停：今天的花费已到上限 $0.5，明天 0 点自动恢复。');
    // A lockdown pause is resumed only through the dialog (a fresh preflight).
    await showAuto({ assistant: { ...sealed, lastCheck: { ...sealed.lastCheck, ok: false, findings: ['MCP 服务 paseo'] } }, wake: { state: 'paused', pausedReason: 'lockdown', findings: ['工具 mcp__paseo__create_agent', 'MCP 服务 paseo'] } }, '自动处理已暂停：评论助手启动时没通过锁定检查（工具 mcp__paseo__create_agent；MCP 服务 paseo），这批评论没有交给它。');
    await waitButton('重新开启…');
    assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=board-inbox-auto-resume]'))"), false);
    // After the v1 migration: setup, the one-time legacy notice and its dismissal.
    await showAuto({ assistant: null, legacy: { agentId: '7622667a-0000-4000-8000-000000000001', retiredAt: '2026-11-14T00:00:00.000Z' }, wake: { state: 'setup', pausedReason: 'setup' } }, '自动处理：需要重新开启（新版会先做锁定检查）');
    assert.ok(await evaluate("document.querySelector('[data-testid=board-inbox-legacy]').textContent.includes('旧的评论助手（Paseo agent 7622667a）启动时会继承其他插件和 Claude Code 用户设置给的工具和权限，已停用，不会再收到评论，也不能再回复访客。要继续自动处理，请重新开启（会先做锁定检查）。旧助手还在 Paseo 里，是否归档由你决定。')"));
    await waitButton('重新开启…');
    assert.equal(await evaluate("Boolean(document.querySelector('[data-testid=board-inbox-auto-resume]'))"), false);
    await snap('inbox-auto-legacy-setup');
    await hostClick('[data-testid="board-inbox-legacy-dismiss"]');
    await until("!document.querySelector('[data-testid=board-inbox-legacy]')");
    assert.equal(await evaluate("inboxFixture.state.calls.filter(call=>call.name==='board.inbox.auto-set').at(-1).input.dismissLegacyNotice"), true);
    const runs = [
      { runId: 'inbox-x-3-3', at: '2026-11-14T01:40:00.000Z', endedAt: null, state: 'running', model: 'claude-haiku-5-5', cliVersion: '2.1.325', commentIds: ['c3'], firstSeq: 3, lastSeq: 3, actions: { replied: 0, drafted: 0, triaged: 0, dismissed: 0 }, deniedAttempts: [], costUsd: null, durationMs: null, error: null, findings: [] },
      { runId: 'inbox-x-1-2', at: '2026-11-14T01:30:00.000Z', endedAt: '2026-11-14T01:30:09.000Z', state: 'done', model: 'claude-haiku-5-5', cliVersion: '2.1.325', commentIds: ['c1', 'c2'], firstSeq: 1, lastSeq: 2, actions: { replied: 1, drafted: 0, triaged: 1, dismissed: 0 }, deniedAttempts: ['Bash', 'WebFetch'], costUsd: 0.0031, durationMs: 8600, error: null, findings: [] },
    ];
    await showAuto({ assistant: sealed, runs, reviewing: 1, sync: { sources: [{ sourceId: 'seed-source', label: '访客反馈', state: 'blocked', lastAttemptAt: null, lastSuccessAt: null, nextAttemptAt: null, lastImportAt: null, failures: 1, lastError: '后端没有开启评论导出（HTTP 404）。', repliesSupported: null, skipped: 2, sanitized: 0 }] }, wake: { state: 'running', runningComments: 1, skipped: { otherBoard: 1, unattributed: 1 } }, replies: { sending: 1, drafts: 0, failed: 1, items: [] } }, '自动同步需要处理：后端没有开启评论导出（HTTP 404）。');
    for (const text of ['自动处理：评论助手正在处理 1 条评论', '评论助手：Haiku 5.5 · 每批新会话 · 锁定检查', '花费：最近一小时 $0.0031 · 今天 $0.013 / 上限 $0.5（按 API 价格估算） · 平均每条 $0.0016', '处理中 1 条', '处理 2 条（回复 1，草稿 0，分类 1）· $0.0031 · 9 秒', '评论助手在处理这批评论时试图使用不存在的工具（Bash、WebFetch），已被拒绝。这些评论可能含有诱导内容，建议看一下。', '回复：1 条发送中 · 0 条待审核 · 1 条失败', '已跳过 2 条格式不符的评论', '2 条评论来自其他 Board 的页面或无法确定来源，不会自动处理。']) assert.ok(await evaluate(`document.querySelector(${JSON.stringify(auto)}).textContent.includes(${JSON.stringify(text)})`), text);
    for (const gone of ['清除卡住的唤醒', '重新创建评论助手', 'Always Ask']) assert.ok(!(await evaluate(`document.querySelector(${JSON.stringify(auto)}).textContent`)).includes(gone), gone);
    await snap('inbox-auto-runs');
    await showAuto({ assistant: sealed, wake: { state: 'idle' } }, '自动处理：等待新评论');
    await press('暂停自动处理');
    await until(`document.querySelector(${JSON.stringify(auto)}).textContent.includes('自动处理已暂停。新评论仍会同步。')`);
    await press('恢复自动处理'); await waitButton('暂停自动处理');
    const sets = await evaluate("inboxFixture.state.calls.filter(call=>call.name==='board.inbox.auto-set').map(call=>call.input)");
    assert.equal(sets.at(-2).wakePaused, true); assert.equal(sets.at(-1).resumeWake, true);
    await hostClick('[data-testid="board-inbox-auto-sync-toggle"]');
    await until(`document.querySelector(${JSON.stringify(auto)}).textContent.includes('自动同步已暂停')`);
    await press('恢复自动同步');
    await hostClick('[data-testid="board-inbox-archive"]');
    await until(`document.querySelector(${JSON.stringify(auto)}).textContent.includes('把 1 条已解决或已忽略的评论移出收件箱？它们会保存在这台电脑的归档文件里，不再显示。')`);
    await press('归档');
    await until("!document.querySelector('[data-testid=board-inbox-comment-comment-4]')");
    await evaluate("inboxFixture.setAuto(null);inboxFixture.state.policy={read:false,triage:false,auto:'off'};true");
    await press('刷新收件箱'); await waitButton('Agent 读取评论：未允许');
    check('The automation block shows each sealed-runner state, the run log, cost, denied-tool notice, lockdown and setup re-enable, the legacy notice, sync pause and archive with exact Chinese text');

    stage = 'connect-failure-exact-retry';
    await press('后端来源'); await until(`document.querySelector(${JSON.stringify(sources)})`);
    await waitButton('刷新来源状态');
    await type('来源 ID', 'app-source'); await type('部署 ID', 'app-deployment'); await type('来源名称', '内部应用');
    await type('评论导出接口', 'https://app.example.invalid/_board/comments');
    await type('评论导出令牌', 'fixture-only-32-character-export-token');
    await evaluate("inboxFixture.state.nextConnectFailure='known';true");
    await press('保存来源'); await waitButton('重试原配置');
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(sources)}).textContent.includes('配置未保存')`));
    for (const label of ['来源 ID', '部署 ID', '来源名称', '评论导出接口', '评论导出令牌']) assert.equal(await evaluate(`document.querySelector(${JSON.stringify(field(label))}).disabled`), true);
    await press('重试原配置'); await until(`document.querySelector(${JSON.stringify(sources)}).textContent.includes('来源已保存，会自动同步。只有开启「Agent 自动处理并公开回复」后，新评论才会交给评论助手。')`);
    await waitButton('立即同步');
    const requests = await evaluate("inboxFixture.state.calls.filter(call=>call.name==='board.inbox.connect').map(call=>call.input)");
    assert.deepEqual(requests[0], requests[1]); assert.equal(requests[0].expectedConnectionEventId, null);
    check('A failed source save preserves its fields and retries the exact original request and connection precondition');

    stage = 'source-conflict-and-sync-recovery';
    await press('编辑连接'); await evaluate('inboxFixture.replaceConnection();true');
    await type('来源名称', '旧窗口不能覆盖新配置');
    await press('保存来源'); await waitButton('重试原配置');
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(sources)}).textContent.includes('其他窗口修改')`));
    assert.equal(await evaluate('inboxFixture.state.connections[0].label'), '另一窗口的新来源');
    await press('清空表单'); await press('刷新来源状态'); await waitButton('立即同步');
    await until(`document.querySelector(${JSON.stringify(sources)}).textContent.includes('自动同步：')`);
    await evaluate('inboxFixture.state.nextSyncFailure=true;true');
    await press('立即同步'); await waitButton('立即同步');
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(sources)}).textContent.includes('游标未推进')`));
    assert.equal(await evaluate("inboxFixture.state.comments.some(c=>c.id==='comment-2')"), false);
    await press('立即同步');
    await until(`document.querySelector(${JSON.stringify(sources)}).textContent.includes('已导入 1 条，重复 0 条。')`);
    await press('评论与权限'); await until("document.querySelector('[data-testid=board-inbox-comment-comment-2]')");
    assert.ok(await evaluate("document.querySelector('[data-testid=board-inbox-comment-comment-2]').textContent.includes('同步恢复后收到的第二条访客评论')"));
    check('Stale source edits preserve another window’s configuration; failed synchronization remains retryable and imports comments visibly');

    stage = 'unknown-connect-reconcile';
    await press('后端来源'); await waitButton('编辑连接'); await press('编辑连接');
    await type('来源名称', '待核对的连接');
    await evaluate("inboxFixture.state.nextConnectFailure='unknown';true");
    await press('保存来源'); await waitButton('重试原配置');
    await press('清空表单'); await press('刷新来源状态'); await waitButton('核对上次配置');
    const pendingEvent = await evaluate('inboxFixture.state.connections[0].eventId');
    await press('核对上次配置'); await waitButton('立即同步');
    assert.equal(await evaluate("inboxFixture.state.calls.find(call=>call.name==='board.inbox.reconcile').input.eventId"), pendingEvent);
    assert.equal(await evaluate('inboxFixture.state.connections[0].state'), 'ready');
    check('An unknown source configuration result remains visible as pending and reconciles its exact event through the human UI');

    stage = 'compact-controls-and-canvas';
    await command('Emulation.setDeviceMetricsOverride', { width: 420, height: 800, deviceScaleFactor: 1, mobile: false });
    compact = true;
    await settle();
    await press('停用来源'); await waitButton('启用来源');
    await press('启用来源'); await waitButton('停用来源');
    await press('编辑连接');
    await type('来源名称', '窄屏仍可编辑');
    await press('保存来源'); await waitButton('立即同步');
    await snap('sources-420');
    await press('评论与权限'); await waitButton('刷新收件箱');
    const second = '[data-testid="board-inbox-comment-comment-2"]';
    await activate(`${second} ${button('内部处理')}`); await type('内部备注', '窄屏内部处理'); await press('已处理');
    await until(`document.querySelector(${JSON.stringify(second)}).textContent.includes('窄屏内部处理')`);
    await activate(`[data-testid="board-inbox-reply-comment-2"]`); await type('公开回复', '窄屏也能回复'); await press('发送回复');
    await until(`document.querySelector(${JSON.stringify(second)}).textContent.includes('窄屏也能回复')`);
    await snap('comments-420');
    await press('关闭窗口'); await until(`!document.querySelector(${JSON.stringify(modal)})`);
    assert.equal(await evaluate(`window.inboxOriginalFrame===document.querySelector('iframe[data-board-id="host-fixture"]')`), true);
    assert.equal(await frame('window.inboxHeap'), heap); assert.equal(await frame('window.boots'), 1);
    assert.equal(await frame("document.querySelector('#field').value"), 'Inbox keeps my canvas input');
    await click('#control'); await untilFrame('window.count===2');
    assert.equal(await submitCount(), 0);
    const unexpected = await evaluate("inboxFixture.state.calls.filter(call=>!['board.inbox.list','board.inbox.policy','board.inbox.triage','board.inbox.connections','board.inbox.connect','board.inbox.sync','board.inbox.reconcile','board.inbox.auto-status','board.inbox.auto-set','board.inbox.assistant-options','board.inbox.auto-enable','board.inbox.reply','board.inbox.reply-pending','board.inbox.archive'].includes(call.name))");
    assert.deepEqual(unexpected, []); assert.deepEqual(await evaluate('window.fixtureModalErrors||[]'), []);
    check('420px source, triage and reply controls remain reachable; closing the inbox preserves the original canvas heap, input and listener with zero agent sends');

    stage = 'toolbar-attention';
    await command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
    compact = false; await settle();
    await evaluate("inboxFixture.setAuto({wake:{state:'paused',pausedReason:'budget',resumesAt:'2026-11-08T13:42:00.000Z'}});true");
    await hostClick('[data-testid="board-more-open"]'); await hostClick('[data-testid="board-inbox-open"]');
    await until(`document.querySelector(${JSON.stringify(panel)})`);
    await press('关闭窗口'); await until(`!document.querySelector(${JSON.stringify(modal)})`);
    await until("document.querySelector('[data-testid=board-share-badge]')");
    await hostClick('[data-testid="board-more-open"]');
    assert.ok(await evaluate("document.querySelector('[data-testid=board-inbox-open]').textContent.includes('自动处理已暂停或同步出错，点开查看')"));
    await hostClick('[data-testid="board-more-open"]');
    await evaluate("inboxFixture.setAuto(null);true");
    check('The 更多 dot and inbox menu detail report a paused automatic handling');
  } catch (error) {
    console.log('Inbox diagnostics:', JSON.stringify({ stage, state: await evaluate(`(()=>{const s=inboxFixture.state;return {...s,calls:s.calls.map(call=>({...call,input:{...call.input,...(call.input.token?{token:'[fixture token redacted]'}:{})}})),text:document.querySelector(${JSON.stringify(modal)})?.textContent,active:document.activeElement?.outerHTML.slice(0,200),modalErrors:window.fixtureModalErrors||[]}})()`) }));
    await snap(`failed-${stage}`); throw error;
  }
}
