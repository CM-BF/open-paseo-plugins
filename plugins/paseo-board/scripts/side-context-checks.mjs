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

  await evaluate('localStorage.clear();sessionStorage.clear();true');
  await fresh();

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
    assert.ok((await text(popover)).includes('冻结主 agent 当前对话（含 Board 回复和工具名，不含工具输出和思考）'));
    assert.ok((await text(popover)).includes('新 Side（带主 agent 记录）'));
    assert.deepEqual(await hostLocation('[data-testid="board-toolbar"]'), bar);
    await shoot(`fork-choice-${width}.png`);
    console.log('MEASURE side-context ' + JSON.stringify({ width, canvas, popover: layout.popover, group: layout.group, chips: layout.chips }));
    await choose(blank);
    assert.deepEqual(await canvasRect(), canvas);
    await hostClick('[data-testid="board-draft-discard"]'); await noPopover();
    check(`at ${width}px the new-Side choice is one visible radio group inside the composer; toggling keeps focus, the 48px toolbar and the canvas rectangle unchanged`);
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  await raf();

  // Default: blank, and the blank request stays byte-identical to the previous protocol.
  await openAt(155, 170);
  assert.equal(await checked(blank), 'true');
  assert.ok((await text(popover)).includes('新 Side（空白）'));
  assert.equal((await text(popover)).includes('冻结主 agent 当前对话'), false);
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
  assert.ok(notes.includes('冻结主 agent 当前对话') && notes.includes('「Side 发送」进入已有旁支，不受此项影响'), notes);
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

  // The Side picker repeats the provenance for that Side.
  await hostClick(`${popover} button[aria-label="继续交流"]`);
  await until(`document.querySelector(${JSON.stringify(input)})`);
  await hostClick('[data-testid="board-side-agent-picker"] button');
  await until(`document.querySelector('[data-testid="board-side-agent-provenance-${historySide}"]')`);
  assert.equal(await text(`[data-testid="board-side-agent-provenance-${historySide}"]`), '带主 agent 记录 · 最近 42 条消息 · 更早的未带上');
  assert.equal(await evaluate(`!!document.querySelector('[data-testid="board-side-agent-provenance-${firstSide}"]')`), false);
  await evaluate(`hostFixture.updateInteraction(${JSON.stringify(historyFork)},{inheritedHistory:{sourceAgentId:'owner-fixture',capturedAt:new Date().toISOString(),messages:42,entries:60,omitted:true,ownerBusy:false,chars:98000,digest:'a'.repeat(64),state:'uncertain'}})`);
  await until(`document.querySelector('[data-testid="board-side-agent-provenance-${historySide}"]')?.textContent.includes('未确认送达（这个 Side 可能没有拿到记录）')`);
  await command('Emulation.setDeviceMetricsOverride', { width: 1024, height: 800, deviceScaleFactor: 1, mobile: false }); await raf();
  await shoot('fork-provenance-1024.png');
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }); await raf();
  await hostClick('[data-testid="board-draft-discard"]');
  await closePopover();
  check('the Side picker lists the same provenance for a history Side (none for a blank one) and warns when its first send is unconfirmed');

  // An existing Side is never changed by the visible choice.
  await openAt(850, 300);
  assert.equal(await checked(history), 'true', 'The last choice stays visible for the next composer');
  assert.ok((await text(popover)).includes('「Side 发送」进入已有旁支，不受此项影响'));
  const sidesBefore = await evaluate("hostFixture.board().interactions.filter(item=>item.kind==='fork').length");
  await sendText('Existing Side keeps its own context'); await key('Enter', 'Enter', 1);
  const existingReply = await pendingIntent();
  const existingCall = await lastCall();
  assert.equal(existingCall.destination, 'side'); assert.equal(existingCall.sideContext, 'owner-history');
  await evaluate('hostFixture.accept()'); await untilMarker(existingReply, 'delivered');
  const reply = await evaluate(`hostFixture.board().interactions.find(item=>item.id===${JSON.stringify(existingReply)})`);
  assert.equal(reply.kind, 'reply'); assert.equal(reply.agentId, historySide); assert.equal('sideContext' in reply, false);
  assert.equal(await evaluate('hostFixture.board().sideAgentId'), historySide);
  assert.equal(await evaluate("hostFixture.board().interactions.filter(item=>item.kind==='fork').length"), sidesBefore);
  await closePopover();
  check('with a Side selected, Option/Alt+Enter still goes to that Side as a reply; the choice is stripped and no new Side is created');

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
  await hostClick(`${popover} button[aria-label="重试原发送"]`);
  assert.equal(await pendingIntent(), buttonFork);
  assert.deepEqual(await lastCall(), buttonCall);
  await evaluate('hostFixture.accept()'); await untilMarker(buttonFork, 'delivered');
  assert.equal(await evaluate(`hostFixture.board().interactions.find(item=>item.id===${JSON.stringify(buttonFork)}).sideContext`), 'owner-history');
  await closePopover();
  check('新建 Side 并发送 is available while a Side exists; a failed send keeps its frozen choice disabled and retries the exact request');

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
}
