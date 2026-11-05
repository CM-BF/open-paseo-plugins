// Actual BoardView/composer/sandbox integration with adapted Paseo transport.
// Fixture fault controls are explicit; they are not evidence of native delivery.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function runBatchCommentChecks(t) {
  const { assert, send, command, evaluate, until, frame, untilFrame, key, click, hostClick, hostLocation, openAuthoredReference, sendText, submitCount, noPopover, closePopover, canvasRect, input, popover, check, origin } = t;
  const shelf = '[data-testid="board-drafts"]';
  const stageButton = '[data-testid="board-comment-stage"]';
  const sendMain = '[data-testid="board-comments-send-main"]';
  const runId = `${Date.now()}-${process.pid}`;
  const evidenceDir = process.env.BOARD_BATCH_SCREENSHOT_DIR ? join(process.env.BOARD_BATCH_SCREENSHOT_DIR, `batch-${runId}`) : undefined;
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true });
  const screenshots = [];
  let stage = 'initial';
  let twoTabDiagnostic;
  const digest = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
  const same = (actual, expected, message) => assert.equal(digest(actual), digest(expected), message);
  const stable = () => evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const afterNavigation = async expression => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try { if (await evaluate(`Boolean(${expression})`)) return; }
      catch (error) {
        if (!/Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed/.test(String(error))) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`New page readiness timeout: ${expression}`);
  };
  const drafts = () => evaluate('hostFixture.drafts().drafts');
  const batches = () => evaluate('hostFixture.batches().batches');
  const queued = async () => (await drafts()).filter(item => item.queuedAt !== undefined).sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
  const latestRequest = () => evaluate("hostFixture.calls.filter(item=>item.name==='board.interact').at(-1)?.input");
  const queueRow = id => `[data-testid="board-queued-comment-${id}"]`;
  const batchRow = id => `[data-testid="board-comment-batch-${id}"]`;
  const retryButton = id => `[data-testid="board-comments-retry-${id}"]`;
  const enterStage = async name => { stage = name; await evaluate(`hostFixture.batchStage=${JSON.stringify(name)}`); };
  const screenshot = async name => {
    if (!evidenceDir) return;
    const result = await command('Page.captureScreenshot', { format: 'png' });
    const path = join(evidenceDir, `${name}.png`);
    await writeFile(path, Buffer.from(result.data, 'base64')); screenshots.push(path);
  };
  const rememberFrame = async () => {
    await evaluate(`window.batchOriginalFrame=document.querySelector('iframe[data-board-id="host-fixture"]');true`);
    return frame('window.batchHeapToken??=crypto.randomUUID()');
  };
  const unchangedFrame = async token => {
    assert.equal(await evaluate(`window.batchOriginalFrame===document.querySelector('iframe[data-board-id="host-fixture"]')`), true, 'Comment controls must retain the actual iframe');
    assert.equal(await frame('window.batchHeapToken'), token, 'Comment controls must retain the canvas JavaScript heap');
  };
  const openShelf = async () => {
    if (await evaluate(`!!document.querySelector(${JSON.stringify(shelf)})`)) return;
    const direct = await evaluate(`!!document.querySelector('[data-testid="board-comments-open"]')`);
    await hostClick(direct ? '[data-testid="board-comments-open"]' : '[data-testid="board-drafts-open"]');
    await until(`document.querySelector(${JSON.stringify(shelf)})`);
  };
  const closeShelf = async () => {
    if (!await evaluate(`!!document.querySelector(${JSON.stringify(shelf)})`)) return;
    await hostClick('button[aria-label="关闭窗口"]');
    await until(`!document.querySelector(${JSON.stringify(shelf)})`);
  };
  const replaceInput = async text => {
    await hostClick(input);
    assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(input)})`), true);
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0 });
    await sendText(text);
    await until(`document.querySelector(${JSON.stringify(input)})?.value===${JSON.stringify(text)}`);
  };
  const stageAt = async (selector, text) => {
    const before = await submitCount();
    await openAuthoredReference(selector);
    await sendText(text);
    await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('已附选区截图')`, 18000);
    await until(`(()=>{const image=document.querySelector(${JSON.stringify(popover + ' img')});return image?.complete&&image.naturalWidth>0})()`);
    const saved = (await drafts()).find(item => item.open && item.compose.text === text);
    assert.ok(saved?.compose.anchor?.image?.data, 'The real capture must be persisted before staging');
    await hostClick(stageButton); await noPopover();
    const result = (await queued()).find(item => item.id === saved.id);
    assert.ok(result, 'The explicit Stage action must retain the actual captured draft');
    same(result.compose.anchor, saved.compose.anchor, 'Staging must not replace the reference or pixels');
    assert.equal(await submitCount(), before, 'Staging a comment never sends an RPC');
    return result;
  };
  const reload = async (online = true) => {
    const previous = await evaluate('hostFixture.pageInstance');
    await command('Page.reload', { ignoreCache: true });
    await afterNavigation(`window.hostFixture?.pageInstance&&hostFixture.pageInstance!==${JSON.stringify(previous)}&&${online ? 'hostFixture.mainReady()?.ready' : 'true'}`);
    if (!online) await until(`document.querySelector('[data-testid="board-offline-drafts"]')`);
    await stable();
  };
  const freshScope = async name => {
    const previous = await evaluate('hostFixture.pageInstance');
    await command('Page.navigate', { url: `${origin}/?drafts=1&batch=1&host=${encodeURIComponent(name)}` });
    await afterNavigation(`window.hostFixture?.pageInstance&&hostFixture.pageInstance!==${JSON.stringify(previous)}&&hostFixture.mainReady()?.ready`);
    await stable();
    assert.equal(await submitCount(), 0); assert.equal((await drafts()).length, 0);
  };
  const reachable = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`);
    await stable();
    const result = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {visible:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,hit:e===hit||e.contains(hit),rect:r.toJSON()}})()`);
    assert.ok(result.visible && result.hit, `Control must have a reachable visible hit target: ${selector} ${JSON.stringify(result)}`);
  };

  try {
    await enterStage('core-stage-edit-delete');
    const originalToken = await rememberFrame();
    const first = await stageAt('#point', '把这里的说明写得更明确');
    const second = await stageAt('#words', '调整这一段的顺序');
    const third = await stageAt('#side-remount-reference', '补充这里的边界情况');
    assert.equal(new Set([first, second, third].map(item => JSON.stringify(item.compose.anchor.rect))).size, 3);
    assert.equal(await submitCount(), 0);
    await openShelf();
    await hostClick(`${queueRow(second.id)} button[aria-label="编辑"]`);
    await until(`document.querySelector(${JSON.stringify(input)})`);
    const editedText = '先给结论，再补充这一段的解释';
    await replaceInput(editedText); await hostClick(stageButton); await noPopover();
    const edited = (await queued()).find(item => item.id === second.id);
    assert.equal(edited.compose.text, editedText); assert.equal(edited.queuedAt, second.queuedAt);
    same(edited.compose.anchor, second.compose.anchor, 'Editing a staged comment preserves its original reference');
    await openShelf(); await hostClick(`${queueRow(third.id)} button[aria-label="删除"]`);
    await until(`!document.querySelector(${JSON.stringify(queueRow(third.id))})`);
    assert.equal((await queued()).length, 2); await closeShelf();
    const replacement = await stageAt('#side-remount-reference', '这里需要一个具体例子');
    assert.notEqual(replacement.id, third.id);
    await unchangedFrame(originalToken); assert.equal(await submitCount(), 0);
    check('three real captures can be staged, edited and deleted without agent delivery or a canvas rebuild');

    await enterStage('authored-comment-stage');
    await click('#batch-authored-comment');
    await until(`document.querySelector(${JSON.stringify(input)})?.value==='Review this authored section'`);
    await until(`document.querySelector(${JSON.stringify(stageButton)})`);
    const authoredText = '把这个作者提供的 Comment 也放进同一组';
    await replaceInput(authoredText); await hostClick(stageButton); await noPopover();
    await untilFrame('window.batchAskResults.length===1');
    assert.equal(await frame('window.batchAskResults[0].status'), 'queued');
    assert.deepEqual(await frame('window.batchAskErrors'), []);
    assert.equal(await submitCount(), 0);
    const staged = await queued();
    assert.equal(staged.length, 4);
    assert.equal(staged.filter(item => item.compose.anchor?.image?.data).length, 3);
    assert.equal(staged.find(item => item.compose.text === authoredText).compose.anchor.selector, '#batch-authored-target');
    check('a trusted authored Comment button accepts a DOM element reference and resolves queued only after explicit staging, with zero sends');

    await enterStage('reload-and-compact');
    await openShelf(); await closeShelf(); await reload();
    same(await queued(), staged, 'Full reload preserves every staged revision, text and captured image');
    assert.equal(await submitCount(), 0);
    const afterReloadToken = await rememberFrame();
    await command('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: false });
    await stable(); const compactCanvas = await canvasRect();
    await openShelf();
    for (const item of staged) for (const label of ['编辑', '删除']) await reachable(`${queueRow(item.id)} button[aria-label="${label}"]`);
    for (const selector of [sendMain, '[data-testid="board-comments-send-side"]']) await reachable(selector);
    await screenshot('420-queue-controls');
    await hostClick(`${queueRow(second.id)} button[aria-label="编辑"]`);
    await until(`document.querySelector(${JSON.stringify(input)})?.value===${JSON.stringify(editedText)}`);
    await hostClick(stageButton); await noPopover();
    await unchangedFrame(afterReloadToken); same(await canvasRect(), compactCanvas, 'Queue and compact editor controls overlay the canvas');
    await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await stable(); await unchangedFrame(afterReloadToken);
    check('full page reload preserves the queue; 420px edit/delete/send controls remain reachable while the original canvas heap survives');

    await enterStage('send-group-markers-and-response');
    const ready = await queued();
    const expectedComments = ready.map(item => ({ id: item.id, text: item.compose.text.trim(), ...(item.compose.anchor ? { anchor: item.compose.anchor } : {}) }));
    await evaluate("hostFixture.mode('accept')"); await openShelf(); await hostClick(sendMain);
    await until('hostFixture.board().interactions.length===1&&hostFixture.batches().batches.length===0&&hostFixture.drafts().drafts.length===0');
    const accepted = await latestRequest();
    assert.equal(await submitCount(), 1); assert.equal(accepted.kind, 'change'); assert.equal(accepted.destination, 'main');
    assert.equal(accepted.anchor, undefined); assert.equal(accepted.sourceInteractionId, undefined);
    same(accepted.comments, expectedComments, 'One Send All RPC carries all ordered frozen comments and pixels');
    assert.equal(await evaluate(`document.querySelectorAll('[data-testid="board-discussion-list"] button').length`), 1);
    const response = '这一组已一起处理；每个位置的修改与剩余说明都在这里。';
    await evaluate(`hostFixture.updateInteraction(${JSON.stringify(accepted.intentId)},{status:'answered',response:${JSON.stringify(response)}});hostFixture.refetch()`);
    await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes(${JSON.stringify(response)})`);
    const markers = await evaluate('hostFixture.markers()');
    assert.equal(markers.length, 4); assert.ok(markers.every(marker => marker.interactionId === accepted.intentId));
    for (const marker of markers) {
      await closePopover();
      const selector = `[data-board-interaction="${marker.id}"]`;
      await untilFrame(`document.querySelector('[data-board-markers]')?.shadowRoot?.querySelector(${JSON.stringify(selector)})?.dataset.status==='answered'`);
      await click(selector);
      await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes(${JSON.stringify(response)})`);
      await until(`document.querySelector('[data-testid="board-sent-comment-${marker.commentId}"]')`);
    }
    await screenshot('desktop-group-response'); await unchangedFrame(afterReloadToken);
    assert.equal(await submitCount(), 1);
    check('one explicit Send All yields one ordered RPC and one discussion row; each location marker opens the same group and shared response');

    await freshScope('batch-held'); await enterStage('held-outbox-reload-and-retry');
    const heldFirst = await stageAt('#point', '冻结发送的第一个位置');
    await stageAt('#side-remount-reference', '冻结发送的第二个位置');
    await openShelf(); await hostClick(sendMain);
    await until('hostFixture.pending().length===1');
    const frozenRequest = await latestRequest(), frozenBatch = (await batches())[0];
    assert.equal(await submitCount(), 1);
    const newerText = '另一个窗口留下的新版本，旧回执不能删除';
    const concurrent = await evaluate(`hostFixture.reviseDraft(${JSON.stringify(heldFirst.id)},${JSON.stringify(newerText)})`);
    assert.equal(concurrent.ok, true); assert.notEqual(concurrent.draft.revision, heldFirst.revision);
    same((await batches())[0], frozenBatch, 'A later source revision cannot mutate an in-flight outbox');
    await reload(); assert.equal(await submitCount(), 1);
    same((await batches())[0], frozenBatch, 'Page loss retains the immutable original batch');
    const fresh = await stageAt('#words', '发送以后新加的第三条评论');
    await openShelf();
    await until(`document.querySelector(${JSON.stringify(retryButton(frozenRequest.intentId))})`);
    await screenshot('unknown-outbox-retained');
    await evaluate("hostFixture.mode('accept')"); await hostClick(retryButton(frozenRequest.intentId));
    await until('hostFixture.batches().batches.length===0&&hostFixture.board().interactions.length===1');
    assert.equal(await submitCount(), 2); same(await latestRequest(), frozenRequest, 'Retry reuses the complete original intent and payload');
    const remaining = await queued();
    assert.equal(remaining.length, 2);
    assert.equal(remaining.find(item => item.id === heldFirst.id)?.compose.text, newerText);
    assert.equal(remaining.find(item => item.id === fresh.id)?.compose.text, fresh.compose.text);
    await reload(); assert.equal(await submitCount(), 2); same(await queued(), remaining, 'Receipt cleanup cannot consume newer or unrelated drafts');
    check('held delivery survives reload without automatic sends; an exact same-intent retry preserves newer revisions and newly added comments');

    await freshScope('batch-lost'); await enterStage('lost-ack-authoritative-recovery');
    await stageAt('#point', '服务器已接收但客户端丢了回执');
    await openShelf(); await evaluate("hostFixture.readFails(true);hostFixture.mode('lost-response')"); await hostClick(sendMain);
    await until('hostFixture.board().interactions.length===1');
    const lostRequest = await latestRequest();
    await until('hostFixture.batches().batches.length===1');
    await reload(false); assert.equal(await submitCount(), 1);
    const lostBatch = (await batches())[0]; assert.equal(lostBatch.intentId, lostRequest.intentId);
    same(lostBatch.comments, lostRequest.comments, 'Offline recovery retains the exact already accepted comments');
    await evaluate('hostFixture.readFails(false);hostFixture.refetch()');
    await until('hostFixture.mainReady()?.ready&&hostFixture.batches().batches.length===0&&hostFixture.drafts().drafts.length===0');
    assert.equal(await submitCount(), 1); assert.equal(await evaluate('hostFixture.board().interactions.length'), 1);
    check('a lost acknowledgement stays recoverable while offline; authoritative acceptance clears only its originals without another RPC');

    await freshScope('batch-storage'); await enterStage('outbox-storage-failures');
    await stageAt('#point', '持久化失败时必须留在待发送列表'); await openShelf();
    const storageDrafts = await queued();
    for (const failureName of ['QuotaExceededError', 'SecurityError']) {
      await evaluate(`window.batchOriginalSetItem=Storage.prototype.setItem;window.batchWriteFailures=0;Storage.prototype.setItem=function(k,v){if(this===localStorage&&String(k).startsWith('@paseo:board-comment-batches:')){window.batchWriteFailures++;throw new DOMException('Owned batch storage fixture',${JSON.stringify(failureName)})}return window.batchOriginalSetItem.call(this,k,v)};true`);
      try {
        await hostClick(sendMain);
        await until('window.batchWriteFailures>0');
        await until(`document.querySelector(${JSON.stringify(shelf)})?.textContent.includes('尚未保存在本机')`);
        assert.equal(await submitCount(), 0); assert.equal((await batches()).length, 0);
        same(await queued(), storageDrafts, 'A failed durable outbox write must preserve every queued comment');
      } finally { await evaluate('Storage.prototype.setItem=window.batchOriginalSetItem;delete window.batchOriginalSetItem'); }
    }
    await screenshot('storage-refusal'); await stable(); assert.equal(await submitCount(), 0);
    check('quota and storage access failures stop Send All before any RPC and preserve the source comments');

    await freshScope('batch-text-limit'); await enterStage('combined-text-limit');
    await stageAt('#point', '甲'.repeat(15000));
    await openAuthoredReference('#words'); await sendText('乙'.repeat(10000));
    await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('已附选区截图')`, 18000);
    await hostClick(stageButton);
    await until(`document.querySelector(${JSON.stringify(popover)})?.textContent.includes('超过限制')`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(input)}).value.length`), 10000);
    assert.equal((await queued()).length, 1); assert.equal(await submitCount(), 0);
    check('the combined text bound refuses the extra comment without losing its current input or sending existing comments');

    await freshScope('batch-legacy'); await enterStage('legacy-enter');
    const legacyToken = await rememberFrame(); await evaluate("hostFixture.mode('accept')");
    await openAuthoredReference('#point'); await sendText('仍然可以直接按 Enter 发一条');
    await key('Enter', 'Enter');
    await until('hostFixture.board().interactions.length===1');
    const single = await latestRequest();
    assert.equal(await submitCount(), 1); assert.equal(single.comments, undefined); assert.equal(single.destination, 'main');
    assert.equal(single.text, '仍然可以直接按 Enter 发一条'); await unchangedFrame(legacyToken);
    check('ordinary Enter retains the single-comment send path and keeps the canvas alive');

    await freshScope('batch-two-tabs'); await enterStage('two-tabs-one-batch');
    await stageAt('#point', '两个窗口看到同一份待发送评论'); await openShelf();
    // Creating a target activates it and pauses background rAF even with timer
    // throttling disabled. Every real click must activate its own page first.
    twoTabDiagnostic = { harnessRevision: 'two-tab-path-1', failure: null, states: [], trace: [] };
    const tracedCommand = (tab, invoke) => async (method, params = {}, phase = method) => {
      const entry = { tab, phase, method, expression: params.expression?.slice(0,1200), input: method.startsWith('Input.') ? params : undefined, at: Date.now(), status: 'pending' };
      twoTabDiagnostic.trace.push(entry);
      if (twoTabDiagnostic.trace.length > 80) twoTabDiagnostic.trace.shift();
      try { const result = await invoke(method, params); entry.status = 'completed'; return result; }
      catch (error) { entry.status = 'failed'; entry.error = String(error); twoTabDiagnostic.failure ??= { ...entry }; throw error; }
      finally { entry.elapsedMs = Date.now() - entry.at; }
    };
    const makeTab = (name, invoke) => {
      const cdp = tracedCommand(name, invoke);
      const read = async (expression, phase = 'read') => {
        const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, phase);
        if (result.exceptionDetails) {
          const error = `${name} ${phase}: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`;
          twoTabDiagnostic.failure ??= { tab: name, phase, expression: expression.slice(0,1200), error };
          throw new Error(error);
        }
        return result.result.value;
      };
      const observe = async (expression, phase) => {
        const deadline = Date.now() + 10000;
        do {
          if (await read(`(async()=>Boolean(${expression}))()`, phase)) return;
          await new Promise(resolve => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        const error = `${name} ${phase} observation timed out: ${expression}`;
        twoTabDiagnostic.failure ??= { tab: name, phase, expression: expression.slice(0,1200), error };
        throw new Error(error);
      };
      const foreground = async phase => {
        await cdp('Page.bringToFront', {}, `${phase}:activate`);
        await observe(`document.visibilityState==='visible'&&document.hasFocus()`, `${phase}:visible-focused`);
      };
      const clickOnce = async (selector, phase) => {
        await foreground(phase);
        await read(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`, `${phase}:reveal`);
        await read(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Foreground animation frame timeout')),3000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true)}))})`, `${phase}:layout`);
        const point = await read(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(document.visibilityState!=='visible'||!document.hasFocus()||!r.width||!r.height||x<0||x>=innerWidth||y<0||y>=innerHeight||e.disabled||(e!==hit&&!e.contains(hit)))throw new Error('Foreground click must hit its enabled visible control');return{x,y}})()`, `${phase}:hit-test`);
        await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, `${phase}:move`);
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 }, `${phase}:press`);
        await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }, `${phase}:release`);
      };
      return { cdp, read, observe, foreground, clickOnce };
    };
    const firstTab = makeTab('root', command);
    const browserCommand = tracedCommand('browser', send);
    let secondTarget, secondTab;
    const lockName = 'paseo-board-comment-batch:' + JSON.stringify(['batch-two-tabs', 'host-fixture']);
    const snapshotTabs = async phase => {
      for (const [name, tab] of [['root', firstTab], ['second', secondTab]]) {
        if (!tab) continue;
        const state = await tab.read(`(async()=>({visibility:document.visibilityState,focused:document.hasFocus(),active:{tag:document.activeElement?.tagName,id:document.activeElement?.id,testId:document.activeElement?.getAttribute('data-testid')},page:window.hostFixture?.pageInstance,ready:window.hostFixture?.mainReady(),uiEvents:window.hostFixture?.uiEvents.slice(-8),outboxes:window.hostFixture?.batches().batches.length,rpcs:window.hostFixture?.calls.filter(c=>c.name==='board.interact').length,locks:await navigator.locks.query()}))()`, `${phase}:state`).catch(error => ({ error: String(error) }));
        twoTabDiagnostic.states.push({ phase, tab: name, ...state });
      }
      if (twoTabDiagnostic.states.length > 12) twoTabDiagnostic.states.splice(0,twoTabDiagnostic.states.length-12);
    };
    try {
      secondTarget = await browserCommand('Target.createTarget', { url: `${origin}/?drafts=1&batch=1&host=batch-two-tabs` }, 'create-second');
      const attached = await browserCommand('Target.attachToTarget', { targetId: secondTarget.targetId, flatten: true }, 'attach-second');
      secondTab = makeTab('second', (method, params) => send(method, params, attached.sessionId));
      await secondTab.cdp('Runtime.enable'); await secondTab.cdp('Page.enable');
      await secondTab.cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
      await secondTab.foreground('second-ready');
      await secondTab.observe('window.hostFixture?.mainReady()?.ready&&document.querySelector("[data-testid=board-comments-open]")', 'second-ready');
      await secondTab.clickOnce('[data-testid="board-comments-open"]', 'second-open-shelf');
      await secondTab.observe(`document.querySelector(${JSON.stringify(sendMain)})`, 'second-shelf-ready');
      await snapshotTabs('both-queues-ready');
      await firstTab.read(`window.batchLockHeld=false;void navigator.locks.request(${JSON.stringify(lockName)},()=>new Promise(resolve=>{window.batchLockHeld=true;window.releaseBatchLock=resolve}));true`, 'hold-lock');
      await firstTab.observe('window.batchLockHeld', 'held-lock-ready');
      await firstTab.clickOnce(sendMain, 'root-send-all');
      await secondTab.clickOnce(sendMain, 'second-send-all');
      // Both genuine clicks must wait on the same native lock before releasing it.
      await firstTab.observe(`(await navigator.locks.query()).pending.filter(item=>item.name===${JSON.stringify(lockName)}).length===2`, 'both-submits-waiting');
      await snapshotTabs('both-submits-waiting');
      await firstTab.read('window.releaseBatchLock();true', 'release-lock');
      await firstTab.observe('hostFixture.batches().batches.length===1', 'shared-outbox-ready');
      await secondTab.observe(`document.querySelector(${JSON.stringify(shelf)})?.textContent.includes('这些评论已在另一窗口发送')||hostFixture.calls.some(item=>item.name==='board.interact')`, 'second-settled');
      await firstTab.observe(`document.querySelector(${JSON.stringify(shelf)})?.textContent.includes('这些评论已在另一窗口发送')||hostFixture.calls.some(item=>item.name==='board.interact')`, 'root-settled');
      const firstCalls = await firstTab.read("hostFixture.calls.filter(item=>item.name==='board.interact').length", 'root-rpc-count');
      const secondCalls = await secondTab.read("hostFixture.calls.filter(item=>item.name==='board.interact').length", 'second-rpc-count');
      assert.equal(firstCalls + secondCalls, 1, 'Two actual tabs must prepare only one native request for the same source revisions');
      const firstBatches = await firstTab.read('hostFixture.batches().batches', 'root-outbox');
      same(firstBatches, await secondTab.read('hostFixture.batches().batches', 'second-outbox'), 'Both tabs must see one immutable shared outbox');
      assert.equal(firstBatches.length, 1);
      await snapshotTabs('one-rpc-confirmed');
      check('two real tabs clicking Send All against the same queued revisions create one shared outbox and only one RPC');
    } catch (error) {
      twoTabDiagnostic.failure ??= { error: String(error) };
      await snapshotTabs('failed');
      throw error;
    } finally {
      const hadFailure = !!twoTabDiagnostic.failure;
      const cleanup = async (phase, action) => {
        try { await action(); }
        catch (error) { (twoTabDiagnostic.cleanupErrors ??= []).push({ phase, error: String(error) }); }
      };
      await cleanup('release-lock', () => firstTab.read('window.releaseBatchLock?.();true', 'cleanup-release-lock'));
      if (secondTarget) await cleanup('close-second', () => browserCommand('Target.closeTarget', { targetId: secondTarget.targetId }, 'cleanup-close-second'));
      await cleanup('restore-root', () => firstTab.foreground('restore-root'));
      if (!hadFailure && twoTabDiagnostic.cleanupErrors?.length) throw new Error(`Two-tab cleanup failed: ${JSON.stringify(twoTabDiagnostic.cleanupErrors)}`);
    }

    await freshScope('batch-lock-edit'); await enterStage('waiting-lock-rejects-unreviewed-edits');
    const reviewed = await stageAt('#point', '点击统一发送时看到的原始评论'); await openShelf();
    const editLockName = 'paseo-board-comment-batch:' + JSON.stringify(['batch-lock-edit', 'host-fixture']);
    await evaluate(`window.batchLockHeld=false;void navigator.locks.request(${JSON.stringify(editLockName)},()=>new Promise(resolve=>{window.batchLockHeld=true;window.releaseBatchLock=resolve}))`);
    try {
      await until('window.batchLockHeld'); await hostClick(sendMain);
      await evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+10000;const poll=async()=>{const state=await navigator.locks.query();if(state.pending.some(item=>item.name===${JSON.stringify(editLockName)}))return resolve(true);if(performance.now()>deadline)return reject(new Error('The clicked submit must be waiting on the native lock'));setTimeout(poll,20)};poll()})`);
      const changed = await evaluate(`hostFixture.reviseDraft(${JSON.stringify(reviewed.id)},'锁等待期间来自另一个窗口的新内容')`);
      assert.equal(changed.ok, true);
      await evaluate('window.releaseBatchLock()');
      await until(`document.querySelector(${JSON.stringify(shelf)})?.textContent.includes('待发送评论已在另一窗口更新')`);
      assert.equal(await submitCount(), 0); assert.equal((await batches()).length, 0);
      assert.equal((await queued())[0].compose.text, '锁等待期间来自另一个窗口的新内容');
      check('a source revision changed while Send All waits for its lock is retained for review and produces neither an outbox nor an RPC');
    } finally { await evaluate('window.releaseBatchLock?.()'); }
    await enterStage('complete');
    if (evidenceDir) await writeFile(join(evidenceDir, 'receipt.json'), JSON.stringify({ status: 'passed', runId, screenshots, twoTab: twoTabDiagnostic, boundary: 'Actual BoardView and sandbox; adapted Paseo transport, not primary-daemon acceptance.' }, null, 2) + '\n');
  } catch (error) {
    const diagnostic = await evaluate(`(()=>{const trim=(v)=>JSON.parse(JSON.stringify(v,(k,x)=>k==='data'&&typeof x==='string'&&x.length>1000?'[image '+x.length+' characters]':x));return {stage:hostFixture.batchStage,page:hostFixture.pageInstance,ready:hostFixture.mainReady(),drafts:trim(hostFixture.drafts()),batches:trim(hostFixture.batches()),interactions:trim(hostFixture.board().interactions),sends:trim(hostFixture.calls.filter(c=>c.name==='board.interact')),uiEvents:hostFixture.uiEvents.slice(-12),popover:document.querySelector('[data-testid="board-local-popover"]')?.textContent?.slice(0,2500),shelf:document.querySelector('[data-testid="board-drafts"]')?.textContent?.slice(0,2500),modalError:document.querySelector('[data-fixture-modal-error]')?.textContent}})()`).catch(failure => ({ stage, diagnosticError: failure.message }));
    console.error('Batch diagnostics:', JSON.stringify(diagnostic).slice(0,18000));
    if (twoTabDiagnostic) console.error('Batch two-tab diagnostics:', JSON.stringify(twoTabDiagnostic).slice(0,30000));
    if (evidenceDir) {
      await screenshot(`FAILED-${stage}`).catch(() => {});
      await writeFile(join(evidenceDir, 'receipt.json'), JSON.stringify({ status: 'failed', stage, runId, error: error.stack || String(error), diagnostic, twoTab: twoTabDiagnostic, screenshots }, null, 2) + '\n');
    }
    throw error;
  }
}
