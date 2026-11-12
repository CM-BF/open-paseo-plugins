// New-Side choice (空白 Side / 带主 agent 记录): visible choice, hotkeys, persistence,
// frozen retries, drafts drawer, canvas board.ask and geometry at 1024/420/320 px.
// Runs on a fresh fixture page (?fork=1) with cleared local storage.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runSideContextChecks({ assert, command, evaluate, until, frame, untilFrame, key, click, hostClick, hostLocation, openAt, sendText, noPopover, closePopover, canvasRect, input, popover, check, origin }) {
  const shots = process.env.BOARD_FORK_SCREENSHOT_DIR;
  const shoot = async name => { if (!shots) return; const shot = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(join(shots, name), Buffer.from(shot.data, 'base64')); };
  const raf = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const choice = '[data-testid="board-side-context"]', blank = `${choice.slice(0, -2)}-blank"]`, history = `${choice.slice(0, -2)}-owner-history"]`;
  const checked = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-checked')`);
  const lastCall = () => evaluate("hostFixture.calls.filter(item=>item.name==='board.interact').at(-1).input");
  const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent??null`);
  const prefKey = '@paseo:board-side-context:v1:["fixture-host","host-fixture"]';
  const fresh = async () => {
    await command('Page.navigate', { url: `${origin}/?fork=1` });
    await until('window.hostFixture?.ready >= 1');
    await until("document.querySelector('[data-testid=board-canvas-container]')");
    await frame('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  };
  const untilMarker = (id, status) => untilFrame(`document.querySelector('[data-board-markers]')?.shadowRoot?.querySelector(${JSON.stringify(`[data-board-interaction="${id}"]`)})?.dataset.status===${JSON.stringify(status)}`);
  const pendingIntent = async () => { await until('hostFixture.pending().length===1'); return evaluate('hostFixture.pending()[0]'); };
  const choose = async selector => { await hostClick(selector); await until(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-checked')==='true'`); };
  // Keyboard navigation needs real virtual key codes (the shared helper only sets them for Enter/Escape/Alt).
  const VK = { Tab: 9, ' ': 32, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
  const press = async (name, code = name, modifiers = 0) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, modifiers, windowsVirtualKeyCode: VK[name], ...(name === ' ' ? { text: ' ' } : {}) });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, modifiers: 0, windowsVirtualKeyCode: VK[name] });
  };
  const NOTE = '新 Side 会带上主 agent 最近的对话，仅作背景参考。', NOTE_EXISTING = '只有新建的 Side 带上记录；已有旁支不变。';
  const hint = () => evaluate(`[...document.querySelectorAll(${JSON.stringify(popover + ' span')})].map(s=>s.textContent).find(t=>t.includes('Option / Alt + Shift + Enter'))??null`);
  const activeId = () => evaluate(`document.activeElement===document.querySelector(${JSON.stringify(input)})?'input':document.activeElement?.getAttribute('data-testid')??document.activeElement?.tagName`);
  // Every send control is visible without scrolling: inside the popover, inside the viewport and the real hit target at its centre.
  // Measured without scrollIntoView (hostClick reveals controls first, which would hide a send row pushed below the fold).
  const sendControls = () => evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(popover)}),pr=p.getBoundingClientRect(),footer=p.querySelector('[data-testid="board-compose-actions"]');
    const scroller=[...p.querySelectorAll('div')].find(e=>getComputedStyle(e).overflow==='auto');
    return {popover:pr.toJSON(),viewport:{width:innerWidth,height:innerHeight},footerInScroller:!!(scroller&&footer&&scroller.contains(footer)),scroll:scroller?{scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight}:null,
      buttons:[...footer.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return {label:b.getAttribute('aria-label'),rect:r.toJSON(),visible:r.width>0&&r.top>=pr.top-0.5&&r.bottom<=pr.bottom+0.5&&r.left>=pr.left-0.5&&r.right<=pr.right+0.5&&r.bottom<=innerHeight&&r.right<=innerWidth&&(b===hit||b.contains(hit))}})}})()`);
  const assertSendRow = async (labels, context) => {
    const state = await sendControls();
    assert.ok(state.buttons.length > 0 && state.buttons.every(item => item.visible), `Every send control is visible without scrolling: ${JSON.stringify({ context, state })}`);
    assert.equal(state.footerInScroller, false, `The send row is a footer outside the scroller: ${JSON.stringify(context)}`);
    for (const label of labels) {
      const button = state.buttons.find(item => item.label === label);
      assert.ok(button?.visible, `${label} must be visible without scrolling: ${JSON.stringify({ context, state })}`);
    }
    return state;
  };

  await evaluate('localStorage.clear();sessionStorage.clear();true');
  await fresh();

  // Keyboard: a real radio group. One Tab stop (the checked option), arrows/Home/End move the selection and keep focus
  // in the group; Space (like a click) returns focus to the message input so the hotkeys keep working.
  await openAt(155, 170);
  await until(`document.activeElement===document.querySelector(${JSON.stringify(input)})`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll(${JSON.stringify(choice + ' [role=radio]')})].map(e=>[e.getAttribute('data-testid'),e.tabIndex,e.getAttribute('aria-checked')])`), [['board-side-context-blank', 0, 'true'], ['board-side-context-owner-history', -1, 'false']]);
  await press('Tab', 'Tab', 8);
  assert.equal(await activeId(), 'board-side-context-blank', 'Shift+Tab from the input lands on the checked option');
  await press('ArrowRight'); await until(`document.querySelector(${JSON.stringify(history)}).getAttribute('aria-checked')==='true'`);
  assert.equal(await activeId(), 'board-side-context-owner-history', 'ArrowRight moves selection and focus together');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll(${JSON.stringify(choice + ' [role=radio]')})].map(e=>e.tabIndex)`), [-1, 0]);
  await press('ArrowLeft'); await until(`document.querySelector(${JSON.stringify(blank)}).getAttribute('aria-checked')==='true'`);
  assert.equal(await activeId(), 'board-side-context-blank');
  await press('End'); await until(`document.querySelector(${JSON.stringify(history)}).getAttribute('aria-checked')==='true'`);
  await press('Home'); await until(`document.querySelector(${JSON.stringify(blank)}).getAttribute('aria-checked')==='true'`);
  await press('ArrowDown'); await until(`document.querySelector(${JSON.stringify(history)}).getAttribute('aria-checked')==='true'`);
  await press(' ', 'Space');
  await until(`document.activeElement===document.querySelector(${JSON.stringify(input)})`);
  assert.equal(await checked(history), 'true', 'Space on the checked option keeps it and returns focus to the input');
  assert.ok((await evaluate(`document.querySelector(${JSON.stringify(history)}).title`)).includes('不含工具输出和思考'), 'The full scope stays available on the option');
  await press('Tab', 'Tab', 8); await press('ArrowLeft'); await until(`document.querySelector(${JSON.stringify(blank)}).getAttribute('aria-checked')==='true'`);
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(prefKey)})`), null, 'Arrow selection writes the same preference as a click');
  await hostClick('[data-testid="board-draft-discard"]'); await noPopover();
  check('the new-Side choice is a keyboard radio group: one Tab stop on the checked option, arrows/Home/End move selection and focus, Space returns focus to the input');

  // Geometry: the choice row fits the pointer-local composer without moving the canvas or toolbar.
  for (const width of [1024, 420, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await raf();
    const bar = await hostLocation('[data-testid="board-toolbar"]');
    assert.equal(bar.height, 48); assert.equal(bar.width, width);
    const canvas = await canvasRect();
    await openAt(Math.min(155, canvas.width - 40), 170);
    await until(`document.querySelector(${JSON.stringify(history)})`);
    assert.equal(await checked(blank), 'true', 'A Board without a stored choice defaults to a blank Side');
    await choose(history);
    await until(`document.activeElement===document.querySelector(${JSON.stringify(input)})`);
    assert.deepEqual(await canvasRect(), canvas, `Toggling the choice must not move the canvas at ${width}px`);
    const layout = await evaluate(`(()=>{const p=document.querySelector(${JSON.stringify(popover)}),g=document.querySelector(${JSON.stringify(choice)});const box=e=>e.getBoundingClientRect().toJSON();return {popover:box(p),group:box(g),caption:box(g.firstElementChild),chips:[...g.querySelectorAll('[role=radio]')].map(box),overflow:p.scrollWidth-p.clientWidth,groupOverflow:g.scrollWidth-g.clientWidth}})()`);
    assert.ok(layout.chips.length === 2 && layout.chips.every(chip => chip.height >= 28), JSON.stringify(layout));
    assert.ok([layout.group, ...layout.chips].every(rect => rect.left >= layout.popover.left && rect.right <= layout.popover.right + 0.5), JSON.stringify({ width, layout }));
    assert.ok(layout.overflow <= 0 && layout.groupOverflow <= 0, JSON.stringify({ width, layout }));
    assert.ok(layout.popover.left >= canvas.x && layout.popover.right <= canvas.x + canvas.width + 0.5, JSON.stringify({ width, layout, canvas }));
    if (width === 1024) {
      const overlaps = (a, b) => a.top < b.bottom && b.top < a.bottom;
      assert.ok(overlaps(layout.caption, layout.chips[0]) && layout.chips[0].top === layout.chips[1].top, `Caption and both choices share one row at 1024px: ${JSON.stringify(layout)}`);
    }
    assert.ok((await text(popover)).includes(NOTE));
    assert.ok((await text(popover)).includes('新 Side（带主 agent 记录）'));
    // The visible note is one line where the popover is wide enough (1024 and 420 px).
    const noteHeight = await evaluate(`[...document.querySelectorAll(${JSON.stringify(popover + ' span')})].find(s=>s.textContent===${JSON.stringify(NOTE)}).getBoundingClientRect().height`);
    if (width !== 320) assert.ok(noteHeight <= 19, `The history note stays on one line at ${width}px: ${noteHeight}`);
    await sendText('Geometry question');
    const sendRow = await assertSendRow(['丢弃草稿', '加入待发送', '新建 Side 并发送', '主会话发送'], { width, side: false });
    assert.deepEqual(await hostLocation('[data-testid="board-toolbar"]'), bar);
    await shoot(`fork-choice-${width}.png`);
    console.log('MEASURE side-context ' + JSON.stringify({ width, canvas, popover: layout.popover, group: layout.group, chips: layout.chips, noteHeight, scroll: sendRow.scroll, send: sendRow.buttons.map(item => [item.label, Math.round(item.rect.top), Math.round(item.rect.bottom)]) }));
    await choose(blank);
    assert.deepEqual(await canvasRect(), canvas);
    await hostClick('[data-testid="board-draft-discard"]'); await noPopover();
    check(`at ${width}px the new-Side choice is one visible radio group inside the composer with a one-line note; every send button is visible without scrolling; toggling keeps focus, the 48px toolbar and the canvas rectangle unchanged`);
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await raf();

  // Default: blank, and the blank request stays byte-identical to the previous protocol.
  await openAt(155, 170);
  assert.equal(await checked(blank), 'true');
  assert.ok((await text(popover)).includes('新 Side（空白）'));
  assert.equal((await text(popover)).includes(NOTE), false, 'A blank choice shows no note');
  await sendText('Blank Side question'); await key('Enter', 'Enter', 1);
  const blankFork = await pendingIntent();
  const blankCall = await lastCall();
  assert.equal(blankCall.destination, 'side'); assert.equal('sideContext' in blankCall, false);
  await evaluate('hostFixture.accept()'); await untilMarker(blankFork, 'delivered');
  const firstSide = await evaluate('hostFixture.board().sideAgentId');
  await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('Blank Side question')`);
  assert.equal(await evaluate(`!!document.querySelector('[data-testid="board-side-provenance-${blankFork}"]')`), false, 'Blank Sides make no provenance claim');
  await closePopover();
  check('a fresh Board shows 空白 Side checked; Option/Alt+Enter creates a blank Side with an unchanged request and no provenance line');

  // History through the visible choice, then the Option/Alt+Shift+Enter hotkey.
  await openAt(680, 190);
  await choose(history);
  await until(`document.activeElement===document.querySelector(${JSON.stringify(input)})`);
  const notes = await text(popover);
  assert.ok(notes.includes(NOTE_EXISTING) && !notes.includes(NOTE), notes);
  assert.ok(notes.includes('新 Side（带主 agent 记录）'));
  assert.ok(await evaluate(`!!document.querySelector('${popover} [data-testid="board-compose-new-side"][aria-label="新建 Side 并发送"]')`));
  await sendText('History Side question'); await key('Enter', 'Enter', 9);
  const historyFork = await pendingIntent();
  const historyCall = await lastCall();
  assert.equal(historyCall.destination, 'new-side'); assert.equal(historyCall.sideContext, 'owner-history');
  await evaluate('hostFixture.accept()'); await untilMarker(historyFork, 'delivered');
  const historySide = await evaluate('hostFixture.board().sideAgentId');
  assert.notEqual(historySide, firstSide);
  const provenance = `[data-testid="board-side-provenance-${historyFork}"]`;
  await until(`document.querySelector(${JSON.stringify(provenance)})?.textContent==='带主 agent 记录 · 读取中'`);
  await evaluate(`hostFixture.updateInteraction(${JSON.stringify(historyFork)},{inheritedHistory:{sourceAgentId:'owner-fixture',capturedAt:new Date().toISOString(),messages:42,entries:60,omitted:true,ownerBusy:false,chars:98000,digest:'a'.repeat(64),state:'sent'},status:'answered',response:'The Side answered with the owner context.'})`);
  await until(`document.querySelector(${JSON.stringify(provenance)})?.textContent==='带主 agent 记录 · 最近 42 条消息 · 更早的未带上'`);
  check('choosing 带主 agent 记录 restores input focus; Option/Alt+Shift+Enter sends new-side with owner-history, and the thread header shows the provenance and omission');

  // The always-visible desktop discussion rail tags the history Side (not the blank one) and reads the full provenance.
  const railRow = id => `[data-testid="board-discussion-${id}"]`;
  await until(`document.querySelector(${JSON.stringify(railRow(historyFork))})?.textContent.includes('· 带记录')`);
  assert.ok((await evaluate(`document.querySelector(${JSON.stringify(railRow(historyFork))}).getAttribute('aria-label')`)).includes('带主 agent 记录 · 最近 42 条消息 · 更早的未带上'));
  assert.equal((await text(railRow(blankFork))).includes('带记录'), false);
  const railTag = await evaluate(`(()=>{const row=document.querySelector(${JSON.stringify(railRow(historyFork))}),line=[...row.querySelectorAll('span')].find(s=>s.textContent.includes('带记录'));return {row:row.getBoundingClientRect().toJSON(),line:line.getBoundingClientRect().toJSON(),overflow:line.scrollWidth-line.clientWidth}})()`);
  assert.ok(railTag.line.right <= railTag.row.right + 0.5 && railTag.overflow <= 0, JSON.stringify(railTag));
  await shoot('fork-rail-tag.png');
  check('the desktop discussion rail shows 带记录 for the history Side only, within its row, and its accessible label carries the full provenance');

  // The Side picker repeats the provenance for that Side.
  await hostClick(`${popover} button[aria-label="继续交流"]`);
  await until(`document.querySelector(${JSON.stringify(input)})`);
  await hostClick('[data-testid="board-side-agent-picker"] button');
  await until(`document.querySelector('[data-testid="board-side-agent-provenance-${historySide}"]')`);
  assert.equal(await text(`[data-testid="board-side-agent-provenance-${historySide}"]`), '带主 agent 记录 · 最近 42 条消息 · 更早的未带上');
  assert.equal(await evaluate(`!!document.querySelector('[data-testid="board-side-agent-provenance-${firstSide}"]')`), false);
  await evaluate(`hostFixture.updateInteraction(${JSON.stringify(historyFork)},{inheritedHistory:{sourceAgentId:'owner-fixture',capturedAt:new Date().toISOString(),messages:42,entries:60,omitted:true,ownerBusy:false,chars:98000,digest:'a'.repeat(64),state:'uncertain'}})`);
  await until(`document.querySelector('[data-testid="board-side-agent-provenance-${historySide}"]')?.textContent.startsWith('带主 agent 记录 · 未确认送达（这个 Side 可能没有拿到记录）')`);
  await command('Emulation.setDeviceMetricsOverride', { width: 1024, height: 800, deviceScaleFactor: 1, mobile: false }); await raf();
  await shoot('fork-provenance-1024.png');
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }); await raf();
  await hostClick('[data-testid="board-draft-discard"]');
  await closePopover();
  check('the Side picker lists the same provenance for a history Side (none for a blank one) and warns when its first send is unconfirmed');

  // An existing Side is never changed by the visible choice.
  await openAt(850, 300);
  assert.equal(await checked(history), 'true', 'The last choice stays visible for the next composer');
  assert.ok((await text(popover)).includes(NOTE_EXISTING));
  const sidesBefore = await evaluate("hostFixture.board().interactions.filter(item=>item.kind==='fork').length");
  await sendText('Existing Side keeps its own context');
  // Re-clicking the already-checked option (to make sure) must return focus to the input, so the hotkey still sends.
  await hostClick(history);
  await until(`document.activeElement===document.querySelector(${JSON.stringify(input)})`);
  assert.equal(await checked(history), 'true');
  await key('Enter', 'Enter', 1);
  const existingReply = await pendingIntent();
  const existingCall = await lastCall();
  assert.equal(existingCall.destination, 'side'); assert.equal(existingCall.sideContext, 'owner-history');
  await evaluate('hostFixture.accept()'); await untilMarker(existingReply, 'delivered');
  const reply = await evaluate(`hostFixture.board().interactions.find(item=>item.id===${JSON.stringify(existingReply)})`);
  assert.equal(reply.kind, 'reply'); assert.equal(reply.agentId, historySide); assert.equal('sideContext' in reply, false);
  assert.equal(await evaluate('hostFixture.board().sideAgentId'), historySide);
  assert.equal(await evaluate("hostFixture.board().interactions.filter(item=>item.kind==='fork').length"), sidesBefore);
  await closePopover();
  check('with a Side selected, re-clicking the checked option keeps focus on the input and Option/Alt+Enter still goes to that Side as a reply; the choice is stripped and no new Side is created');

  // With a Side and 带主 agent 记录 chosen (the remembered steady state), all five send controls stay visible without scrolling.
  for (const [width, height] of [[1440, 900], [1024, 800], [420, 800], [320, 800]]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await raf();
    const canvas = await canvasRect();
    await openAt(Math.min(155, canvas.width - 40), 170);
    assert.equal(await checked(history), 'true');
    assert.ok((await text(popover)).includes(NOTE_EXISTING));
    await sendText('Steady-state composer with a Side');
    const state = await assertSendRow(['丢弃草稿', '加入待发送', 'Side 发送', '新建 Side 并发送', '主会话发送'], { width, side: true });
    // The primary main send is never alone on a row: the send group (Side 发送 · 新建 Side 并发送 · 主会话发送) wraps together.
    const top = label => Math.round(state.buttons.find(item => item.label === label).rect.top);
    if (width >= 1024) assert.ok(top('Side 发送') === top('新建 Side 并发送') && top('新建 Side 并发送') === top('主会话发送'), JSON.stringify(state.buttons));
    assert.ok((await hostLocation(popover)).y + (await hostLocation(popover)).height <= height + 0.5);
    console.log('MEASURE side-context-steady ' + JSON.stringify({ width, popover: state.popover, scroll: state.scroll, send: state.buttons.map(item => [item.label, Math.round(item.rect.top), Math.round(item.rect.bottom)]) }));
    await shoot(`fork-composer-side-${width}.png`);
    await hostClick('[data-testid="board-draft-discard"]'); await noPopover();
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }); await raf();
  check('with a Side and 带主 agent 记录 chosen, 丢弃草稿 / 加入待发送 / Side 发送 / 新建 Side 并发送 / 主会话发送 are all visible without scrolling at 1440, 1024, 420 and 320 px');

  // The secondary 新建 Side 并发送 button; an uncertain send keeps its frozen choice on retry.
  await openAt(480, 190);
  await sendText('New Side from the button with history');
  await hostClick('[data-testid="board-compose-new-side"]');
  const buttonFork = await pendingIntent();
  const buttonCall = await lastCall();
  assert.equal(buttonCall.destination, 'new-side'); assert.equal(buttonCall.sideContext, 'owner-history');
  await evaluate('hostFixture.reject()');
  await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('Fixture delivery unavailable')`);
  assert.equal(await checked(history), 'true');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(history)}).disabled&&document.querySelector(${JSON.stringify(blank)}).disabled`), true, 'A frozen retry cannot change its choice');
  assert.ok((await text(popover)).includes('重试沿用原发送的选择'));
  assert.ok((await hint()).includes('新 Side（带主 agent 记录）'));
  // Change the preference elsewhere, then reopen the retry: its options and its hotkey hint both show the frozen choice.
  await hostClick('[data-testid="board-draft-dismiss"]'); await noPopover();
  await openAt(680, 190); await choose(blank); await hostClick('[data-testid="board-draft-discard"]'); await noPopover();
  await hostClick('[data-testid="board-drafts-open"]');
  await until("document.querySelectorAll('[data-fixture-modal] button[aria-label=\"继续编辑\"]').length===1");
  await hostClick('[data-fixture-modal] button[aria-label="继续编辑"]');
  await until(`document.querySelector(${JSON.stringify(input)})?.value==='New Side from the button with history'`);
  assert.equal(await checked(history), 'true'); assert.equal(await checked(blank), 'false');
  const retryHint = await hint();
  assert.ok(retryHint.includes('新 Side（带主 agent 记录）') && !retryHint.includes('新 Side（空白）'), retryHint);
  await shoot('fork-retry-hint.png');
  await until(`document.activeElement===document.querySelector(${JSON.stringify(input)})`);
  await key('Enter', 'Enter', 9);
  assert.equal(await pendingIntent(), buttonFork);
  assert.deepEqual(await lastCall(), buttonCall);
  await evaluate('hostFixture.accept()'); await untilMarker(buttonFork, 'delivered');
  assert.equal(await evaluate(`hostFixture.board().interactions.find(item=>item.id===${JSON.stringify(buttonFork)}).sideContext`), 'owner-history');
  await closePopover();
  // Restore the remembered choice for the following flows.
  await openAt(680, 190); await choose(history); await hostClick('[data-testid="board-draft-discard"]'); await noPopover();
  check('新建 Side 并发送 is available while a Side exists; a failed send keeps its frozen choice disabled, its hotkey hint shows that frozen choice even after the preference changed, and Option/Alt+Shift+Enter retries the exact request');

  // Grouped comments use the same visible choice in the drafts drawer.
  await openAt(300, 480); await sendText('First queued comment'); await key('Enter'); await noPopover();
  await openAt(620, 520); await sendText('Second queued comment'); await key('Enter'); await noPopover();
  await hostClick('[data-testid="board-comments-open"]');
  await until(`document.querySelector('[data-testid="board-batch-side-context-owner-history"]')?.getAttribute('aria-checked')==='true'`);
  await hostClick('[data-testid="board-comments-send-new-side"]');
  const batchFork = await pendingIntent();
  const batchCall = await lastCall();
  assert.equal(batchCall.destination, 'new-side'); assert.equal(batchCall.sideContext, 'owner-history'); assert.equal(batchCall.comments.length, 2);
  await until(`document.querySelector('[data-testid="board-comment-batch-${batchFork}"]')?.textContent.includes('新 Side · 带主 agent 记录')`);
  await shoot('fork-drafts-batch.png');
  await evaluate('hostFixture.accept()');
  await until(`!document.querySelector('[data-testid="board-comment-batch-${batchFork}"]')`);
  await until(`document.querySelector(${JSON.stringify(popover)})`);
  await closePopover();
  check('the drafts drawer shows the same choice; 新建 Side 并统一发送 freezes owner-history into the grouped request and its pending row');

  // A canvas board.ask({kind:'fork'}) opens the same composer with the choice visible.
  await click('#fork-ask');
  await until(`document.querySelector(${JSON.stringify(input)})?.value==='Ask a Side that knows the owner context'`);
  assert.equal(await checked(history), 'true');
  await key('Enter', 'Enter', 9);
  const askFork = await pendingIntent();
  const askCall = await lastCall();
  assert.equal(askCall.destination, 'new-side'); assert.equal(askCall.sideContext, 'owner-history'); assert.equal(askCall.text, 'Ask a Side that knows the owner context');
  await evaluate('hostFixture.accept()'); await untilMarker(askFork, 'delivered');
  await untilFrame("window.forkAskResults.length===1&&window.forkAskResults[0].status==='submitted'");
  await closePopover();
  check('canvas board.ask with kind fork opens the composer with the visible choice, and the hotkey creates the Side with owner history');

  // A history Side that failed before creation offers a fresh send with the same words and location.
  const sideBeforeFailure = await evaluate('hostFixture.board().sideAgentId');
  await openAt(760, 420); await sendText('History Side that fails before creation'); await key('Enter', 'Enter', 9);
  const failedFork = await pendingIntent();
  await evaluate('hostFixture.accept()'); await untilMarker(failedFork, 'delivered');
  await evaluate(`hostFixture.failCreation(${JSON.stringify(failedFork)},'读取主 agent 记录失败：timeline unavailable。没有创建 Side，也没有改成空白 Side；请重新发送（可改选「空白 Side」）。',${JSON.stringify(sideBeforeFailure)})`);
  await until(`document.querySelector('[data-testid="board-side-provenance-${failedFork}"]')?.textContent==='带主 agent 记录 · 未建立（没有创建 Side）'`);
  assert.ok((await text(popover)).includes('没有改成空白 Side'));
  await hostClick(`[data-testid="board-resend-${failedFork}"]`);
  await until(`document.querySelector(${JSON.stringify(input)})?.value==='History Side that fails before creation'`);
  await until(`document.activeElement===document.querySelector(${JSON.stringify(input)})`);
  assert.equal(await checked(history), 'true');
  await key('Enter', 'Enter', 9);
  const resent = await pendingIntent();
  const resentCall = await lastCall();
  assert.notEqual(resent, failedFork); assert.equal(resentCall.destination, 'new-side'); assert.equal(resentCall.sideContext, 'owner-history'); assert.equal(resentCall.text, 'History Side that fails before creation');
  await evaluate('hostFixture.accept()'); await untilMarker(resent, 'delivered');
  await closePopover();
  check('a history Side that failed before creation says so in its header, keeps no blank fallback, and 重新编辑发送 starts a fresh send with the same words and the visible choice');

  // A create whose result is pending reconciliation is not "never created": no fresh send is offered (it could duplicate the Side).
  await openAt(520, 420); await sendText('History Side whose create result is pending'); await key('Enter', 'Enter', 9);
  const limboFork = await pendingIntent();
  await evaluate('hostFixture.accept()'); await untilMarker(limboFork, 'delivered');
  await evaluate(`hostFixture.pendCreation(${JSON.stringify(limboFork)},'讨论分支创建结果待核对：create response lost',{sourceAgentId:'owner-fixture',capturedAt:new Date().toISOString(),messages:42,entries:60,omitted:false,ownerBusy:false,chars:9000,digest:'b'.repeat(64),state:'frozen'})`);
  await until(`document.querySelector('[data-testid="board-side-provenance-${limboFork}"]')?.textContent==='带主 agent 记录 · 创建结果待核对 · 42 条消息'`);
  assert.ok((await text(popover)).includes('讨论分支创建结果待核对'));
  await until(`document.querySelector('[data-testid="board-discussion-${limboFork}"]')?.textContent.includes('· 创建待核对')`);
  assert.equal(await evaluate(`!!document.querySelector('[data-testid="board-resend-${limboFork}"]')`), false, 'A pending create must not offer 重新编辑发送');
  assert.equal(await evaluate(`[...document.querySelectorAll(${JSON.stringify(popover + ' button')})].some(b=>b.getAttribute('aria-label')==='重新编辑发送')`), false);
  await shoot('fork-limbo-no-resend.png');
  await closePopover();
  check('a Side whose create result is pending shows 创建结果待核对 and offers no 重新编辑发送, so the user cannot create a duplicate Side');

  // A grouped history Side that failed before creation puts its comments back into the pending queue.
  await evaluate(`hostFixture.failCreation(${JSON.stringify(limboFork)},'superseded fixture state',${JSON.stringify(historySide)})`);
  await until(`!document.querySelector('[data-testid="board-discussion-${limboFork}"]')?.textContent.includes('记录')`);
  await openAt(300, 480); await sendText('Grouped comment A'); await key('Enter'); await noPopover();
  await openAt(620, 520); await sendText('Grouped comment B'); await key('Enter'); await noPopover();
  await hostClick('[data-testid="board-comments-open"]');
  await until(`document.querySelector('[data-testid="board-batch-side-context-owner-history"]')?.getAttribute('aria-checked')==='true'`);
  await hostClick('[data-testid="board-comments-send-new-side"]');
  const groupFork = await pendingIntent();
  const groupCall = await lastCall();
  assert.equal(groupCall.sideContext, 'owner-history'); assert.equal(groupCall.comments.length, 2);
  await evaluate('hostFixture.accept()');
  await until(`!document.querySelector('[data-testid="board-comment-batch-${groupFork}"]')`);
  await until(`document.querySelector(${JSON.stringify(popover)})`);
  await evaluate(`hostFixture.failCreation(${JSON.stringify(groupFork)},'主 agent 已归档或不可用，无法读取它的记录；没有创建 Side，也没有改成空白 Side。请重新发送（可改选「空白 Side」）。',${JSON.stringify(historySide)})`);
  await until(`document.querySelector('[data-testid="board-restore-comments-${groupFork}"]')`);
  assert.equal(await evaluate(`!!document.querySelector('[data-testid="board-resend-${groupFork}"]')`), false);
  await shoot('fork-restore-comments.png');
  await hostClick(`[data-testid="board-restore-comments-${groupFork}"]`);
  await until(`document.querySelector('[data-testid="board-comments-open"]')?.getAttribute('aria-label')==='待发送 2 条'`);
  await until(`document.querySelector('[data-testid="board-comments-send-new-side"]')`);
  const restoredText = await evaluate("[...document.querySelectorAll('span')].map(s=>s.textContent).filter(t=>/^[12]\\. Grouped comment [AB]$/.test(t))");
  assert.deepEqual(restoredText, ['1. Grouped comment A', '2. Grouped comment B']);
  // Send the restored group again, this time as a blank Side.
  await choose('[data-testid="board-batch-side-context-blank"]');
  await hostClick('[data-testid="board-comments-send-new-side"]');
  const regroupFork = await pendingIntent();
  const regroupCall = await lastCall();
  assert.notEqual(regroupFork, groupFork); assert.equal('sideContext' in regroupCall, false);
  assert.deepEqual(regroupCall.comments.map(item => item.text), ['Grouped comment A', 'Grouped comment B']);
  assert.deepEqual(regroupCall.comments.map(item => item.anchor?.rect), groupCall.comments.map(item => item.anchor?.rect));
  await evaluate('hostFixture.accept()');
  await until(`!document.querySelector('[data-testid="board-comment-batch-${regroupFork}"]')`);
  await until(`document.querySelector(${JSON.stringify(popover)})`);
  await closePopover();
  await openAt(155, 170); await choose(history); await hostClick('[data-testid="board-draft-discard"]'); await noPopover();
  check('a grouped history Side that failed before creation offers 放回待发送: its comments return to the pending queue with their locations and can be sent again (here as a blank Side)');

  // The choice is a per-Board local preference that survives a reload; blank removes it.
  assert.deepEqual(JSON.parse(await evaluate(`localStorage.getItem(${JSON.stringify(prefKey)})`)), { v: 1, choice: 'owner-history' });
  await fresh();
  await openAt(155, 170);
  assert.equal(await checked(history), 'true', 'A reload shows the last choice for this Board');
  await choose(blank);
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(prefKey)})`), null);
  assert.deepEqual(await evaluate("Object.keys(localStorage).filter(key=>key.startsWith('@paseo:board-side-context:'))"), []);
  await hostClick('[data-testid="board-draft-discard"]'); await noPopover();
  check('the last choice is remembered per host and Board across a reload; choosing 空白 Side removes the stored preference');

  // The non-web compatible composer (Hermes/mobile fallback) shows the same choice as tappable radios and keeps its send row visible.
  for (const width of [420, 320]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    // No canvas frame renders on the non-web platform, so there is no frame-ready receipt to wait for.
    await command('Page.navigate', { url: `${origin}/?fork=1&native-toolbar=1` });
    await until(`document.querySelector('button[aria-label="发消息"]')`);
    await hostClick('button[aria-label="发消息"]');
    await until(`document.querySelector(${JSON.stringify(history)})`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(history)}).tagName`), 'BUTTON');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(history)}).getAttribute('role')`), 'radio');
    await choose(history);
    await assertSendRow(['丢弃草稿', '加入待发送', '主会话发送'], { width, compat: true });
    assert.ok((await text(popover)).includes(NOTE_EXISTING) || (await text(popover)).includes(NOTE));
    await shoot(`fork-compat-composer-${width}.png`);
    await choose(blank);
    await hostClick('[data-testid="board-draft-discard"]'); await noPopover();
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await fresh();
  check('the non-web compatible composer at 420 and 320 px shows the same tappable choice with its one-line note, and every send control stays visible without scrolling');
}
