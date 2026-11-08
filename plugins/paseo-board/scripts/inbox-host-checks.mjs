import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installInboxHostFixture } from './inbox-host-fixture.mjs';

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
    await evaluate(`(${installInboxHostFixture.toString()})(); true`);
    await evaluate(`window.inboxOriginalFrame=document.querySelector('iframe[data-board-id="host-fixture"]');true`);
    await frame("window.inboxHeap=crypto.randomUUID();document.querySelector('#field').value='Inbox keeps my canvas input';true");
    const heap = await frame('window.inboxHeap'), initialRect = await canvasRect();
    await click('#control'); await untilFrame('window.count===1');

    stage = 'more-entry-default-policy';
    await hostClick('[data-testid="board-more-open"]');
    await hostClick('[data-testid="board-inbox-open"]');
    await until(`document.querySelector(${JSON.stringify(panel)})||document.querySelector('[data-fixture-modal-error]')`);
    assert.equal(await evaluate("document.querySelector('[data-fixture-modal-error]')?.textContent"), undefined);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(modal)}).getAttribute('aria-label')`), '评论收件箱');
    assert.equal(await evaluate("document.querySelector('[data-fixture-modal-root]').dataset.fixtureModalRoot"), 'isolated');
    await waitButton('Agent 读取：未允许');
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-policy-triage]').disabled"), true);
    assert.equal(await count('board.inbox.policy'), 0);
    assert.deepEqual(await canvasRect(), initialRect);
    check('More opens the native comment inbox inside the isolated modal with agent read and triage disabled by default');

    stage = 'external-text-and-human-triage';
    const comment = '[data-testid="board-inbox-comment-comment-1"]';
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(comment)}).textContent.includes(inboxFixture.attack)`));
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(comment)}).querySelectorAll('img,script,b,em,a').length`), 0);
    assert.equal(await evaluate('window.inboxInjection'), undefined);
    await hostClick(`${comment} ${button('内部处理')}`);
    await type('内部标签', 'needs-review, 产品建议');
    await type('内部备注', '内部核对，尚未授权公开回复');
    await press('处理中');
    await until(`document.querySelector(${JSON.stringify(comment)}).textContent.includes('内部核对，尚未授权公开回复') && !document.querySelector(${JSON.stringify(field('内部备注'))})`);
    const triage = await evaluate("inboxFixture.state.calls.find(call=>call.name==='board.inbox.triage').input");
    assert.equal(triage.expectedCommentRevision, 1); assert.equal(triage.status, 'reviewing');
    assert.deepEqual(triage.labels, ['needs-review', '产品建议']);
    assert.deepEqual(await evaluate('inboxFixture.state.policy'), { read: false, triage: false });
    check('External HTML-looking text stays inert; human triage saves internal labels and notes while agent permissions remain off');

    stage = 'policy-concurrency';
    await evaluate('inboxFixture.state.holdPolicy=true;true');
    await press('Agent 读取：未允许');
    await until("inboxFixture.state.calls.some(call=>call.name==='board.inbox.policy')");
    const policyCount = await count('board.inbox.policy');
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-policy-read]').disabled"), true);
    await hostClick('[data-testid="board-inbox-policy-read"]');
    assert.equal(await count('board.inbox.policy'), policyCount);
    await evaluate('inboxFixture.releasePolicy();true');
    await press('Agent 内部处理：未允许');
    await waitButton('Agent 内部处理：已允许');
    assert.deepEqual(await evaluate('inboxFixture.state.policy'), { read: true, triage: true });
    await press('Agent 读取：已允许'); await waitButton('Agent 读取：未允许');
    assert.deepEqual(await evaluate('inboxFixture.state.policy'), { read: false, triage: false });
    assert.equal(await evaluate("document.querySelector('[data-testid=board-inbox-policy-triage]').disabled"), true);
    check('Human policy toggles serialize requests, and revoking read also revokes triage without waking an agent');

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
    await press('重试原配置'); await until(`document.querySelector(${JSON.stringify(sources)}).textContent.includes('来源配置已保存')`);
    await waitButton('同步一页评论');
    const requests = await evaluate("inboxFixture.state.calls.filter(call=>call.name==='board.inbox.connect').map(call=>call.input)");
    assert.deepEqual(requests[0], requests[1]); assert.equal(requests[0].expectedConnectionEventId, null);
    check('A failed source save preserves its fields and retries the exact original request and connection precondition');

    stage = 'source-conflict-and-sync-recovery';
    await press('编辑连接'); await evaluate('inboxFixture.replaceConnection();true');
    await type('来源名称', '旧窗口不能覆盖新配置');
    await press('保存来源'); await waitButton('重试原配置');
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(sources)}).textContent.includes('其他窗口修改')`));
    assert.equal(await evaluate('inboxFixture.state.connections[0].label'), '另一窗口的新来源');
    await press('清空表单'); await press('刷新来源状态'); await waitButton('同步一页评论');
    await evaluate('inboxFixture.state.nextSyncFailure=true;true');
    await press('同步一页评论'); await waitButton('同步一页评论');
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(sources)}).textContent.includes('游标未推进')`));
    assert.equal(await evaluate('inboxFixture.state.comments.length'), 1);
    await press('同步一页评论');
    await until(`document.querySelector(${JSON.stringify(sources)}).textContent.includes('已导入 1 条')`);
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
    await press('核对上次配置'); await waitButton('同步一页评论');
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
    await press('保存来源'); await waitButton('同步一页评论');
    await snap('sources-420');
    await press('评论与权限'); await waitButton('刷新收件箱');
    const second = '[data-testid="board-inbox-comment-comment-2"]';
    await activate(`${second} ${button('内部处理')}`); await type('内部备注', '窄屏内部处理'); await press('已处理');
    await until(`document.querySelector(${JSON.stringify(second)}).textContent.includes('窄屏内部处理')`);
    await snap('comments-420');
    await press('关闭窗口'); await until(`!document.querySelector(${JSON.stringify(modal)})`);
    assert.equal(await evaluate(`window.inboxOriginalFrame===document.querySelector('iframe[data-board-id="host-fixture"]')`), true);
    assert.equal(await frame('window.inboxHeap'), heap); assert.equal(await frame('window.boots'), 1);
    assert.equal(await frame("document.querySelector('#field').value"), 'Inbox keeps my canvas input');
    await click('#control'); await untilFrame('window.count===2');
    assert.equal(await submitCount(), 0);
    const unexpected = await evaluate("inboxFixture.state.calls.filter(call=>!['board.inbox.list','board.inbox.policy','board.inbox.triage','board.inbox.connections','board.inbox.connect','board.inbox.sync','board.inbox.reconcile'].includes(call.name))");
    assert.deepEqual(unexpected, []); assert.deepEqual(await evaluate('window.fixtureModalErrors||[]'), []);
    check('420px source and triage controls remain reachable; closing the inbox preserves the original canvas heap, input and listener with zero agent sends');
  } catch (error) {
    console.log('Inbox diagnostics:', JSON.stringify({ stage, state: await evaluate(`(()=>{const s=inboxFixture.state;return {...s,calls:s.calls.map(call=>({...call,input:{...call.input,...(call.input.token?{token:'[fixture token redacted]'}:{})}})),text:document.querySelector(${JSON.stringify(modal)})?.textContent,active:document.activeElement?.outerHTML.slice(0,200),modalErrors:window.fixtureModalErrors||[]}})()`) }));
    await snap(`failed-${stage}`); throw error;
  }
}
