// Actual BoardHome/BoardView lifecycle with only the external host transport adapted.
// Native input generates scroll; source seeding and read gates do not fake view receipts.
export async function runResumeHostChecks({assert,command,evaluate,until,frame,untilFrame,key,clickPoint,hostClick,sendText,check,origin,scope='resume'}) {
  const frameSelector='iframe[data-board-id]';
  const stage=async name=>{console.log('STAGE resume '+name);await evaluate(`hostFixture.resumeStage=${JSON.stringify(name)}`);};
  const trace=async(phase,live)=>console.log('DIAG resume-view',JSON.stringify(await evaluate(`hostFixture.traceView(${JSON.stringify(phase)},${JSON.stringify(live??null)})`)));
  const currentId=()=>evaluate(`document.querySelector('${frameSelector}')?.dataset.boardId`);
  const ready=async id=>{await until(`document.querySelector('${frameSelector}')?.dataset.boardId===${JSON.stringify(id)}&&hostFixture.mainReady()?.ready`);await untilFrame("Boolean(window.resumeBootToken&&document.querySelector('#resume-surface'))");};
  const settled=()=>frame('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const current=()=>frame(`({x:scrollX,y:scrollY,innerX:document.querySelector('#resume-log').scrollLeft,innerY:document.querySelector('#resume-log').scrollTop,token:window.resumeBootToken,text:document.querySelector('#resume-status').textContent})`);
  const canvasRect=()=>evaluate(`document.querySelector('${frameSelector}').getBoundingClientRect().toJSON()`);
  const savedView=()=>evaluate(`hostFixture.raw.filter(m=>m.type==='view-state'&&m.boardId==='host-fixture').at(-1)?.view`);
  const noSend=()=>evaluate("hostFixture.calls.filter(c=>c.name==='board.interact').length");
  const seenCalls=()=>evaluate("hostFixture.calls.filter(c=>c.name==='board.updates-seen').length");
  const restoreAck=async (previous=0)=>{
    await until(`hostFixture.raw.filter(m=>m.type==='view-restored'&&m.boardId==='host-fixture'&&m.status==='restored').length>${previous}`);
    await settled();
  };
  const equalView=(actual,expected,label)=>{
    for(const name of ['x','y','innerX','innerY'])assert.ok(Math.abs(actual[name]-expected[name])<=2,`${label} ${name}: ${JSON.stringify({actual,expected})}`);
  };
  const wheel=async (deltaX,deltaY,inner=false)=>{
    const origin=await canvasRect();
    const target=await frame(`(()=>{
      const inner=${inner},log=document.querySelector('#resume-log'),viewport={width:innerWidth,height:innerHeight};
      const describe=node=>{const style=getComputedStyle(node);return {tag:node.tagName,id:node.id,overflowX:style.overflowX,overflowY:style.overflowY,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight};};
      const inspect=point=>{const hit=document.elementFromPoint(point.x,point.y);const chain=[];for(let node=hit;node instanceof Element;node=node.parentElement)chain.push(describe(node));const nested=chain.filter(item=>!['HTML','BODY'].includes(item.tag)&&(/auto|scroll|overlay/.test(item.overflowX)&&item.scrollWidth>item.clientWidth+1||/auto|scroll|overlay/.test(item.overflowY)&&item.scrollHeight>item.clientHeight+1));return {point,hit:hit?{tag:hit.tagName,id:hit.id}:null,chain,nested,viewport,stack:document.elementsFromPoint(point.x,point.y).slice(0,6).map(n=>({tag:n.tagName,id:n.id})),valid:!!hit&&!hit.closest('[data-board-overlay]')&&(inner?!!hit.closest('#resume-log'):!!hit.closest('#resume-surface')&&nested.length===0)};};
      if(inner){const r=log.getBoundingClientRect(),left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);return inspect({x:(left+right)/2,y:(top+bottom)/2});}
      const candidates=[{x:50,y:50},{x:50,y:Math.min(220,innerHeight/3)},{x:innerWidth/2,y:40},{x:innerWidth-40,y:40}].map(inspect);return candidates.find(item=>item.valid)||{valid:false,candidates};
    })()`);
    assert.ok(target.valid,`Native wheel must reach the intended ${inner?'nested log':'document'} scroller: ${JSON.stringify(target)}`);
    if(inner)assert.ok(target.nested.some(item=>item.id==='resume-log'));else assert.deepEqual(target.nested,[]);
    const x=origin.x+target.point.x,y=origin.y+target.point.y;
    assert.equal(await evaluate(`document.elementFromPoint(${x},${y})===document.querySelector('${frameSelector}')`),true,'The native wheel must hit the current visible canvas iframe');
    const before=await frame('window.resumeWheelEvents.length');
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
    await command('Input.dispatchMouseEvent',{type:'mouseWheel',x,y,deltaX,deltaY});
    await untilFrame(`window.resumeWheelEvents.length>${before}`);
    const event=await frame('window.resumeWheelEvents.at(-1)');assert.equal(event.trusted,true);
    console.log('MEASURE resume-wheel-target '+JSON.stringify({scroller:inner?'nested':'document',deltaX,deltaY,target,event}));
  };
  const input=async text=>{
    const origin=await canvasRect(),point=await frame(`(()=>{const r=document.querySelector('#resume-input').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await clickPoint(origin.x+point.x,origin.y+point.y);await sendText(text);
    await untilFrame(`document.querySelector('#resume-input').value===${JSON.stringify(text)}`);
    assert.ok(await frame("window.resumeInputEvents.some(e=>e.trusted&&e.target==='resume-input')"));
  };
  const switchAgent=label=>hostClick(`[data-testid="resume-${label}"]`);
  const open=title=>hostClick(`button[aria-label="打开 ${title}"]`);
  const waitIndex=()=>until("!document.querySelector('iframe[data-board-id]')&&document.querySelector('[data-testid=board-status-host-fixture]')");
  const metric=()=>evaluate(`({now:performance.now(),reads:hostFixture.readMetrics.length,bytes:hostFixture.readMetrics.reduce((n,r)=>n+r.bytes,0),ready:hostFixture.mainReady(),boots:hostFixture.resumeBoots.length})`);
  const reconnect=async()=>{
    const {runResumeReconnectChecks}=await import('./resume-reconnect-checks.mjs');
    await runResumeReconnectChecks({assert,command,evaluate,until,untilFrame,hostClick,frame,check,origin});
  };
  const retirement=async()=>{
    const {runResumeRetirementChecks}=await import('./resume-host-retirement.mjs');
    await runResumeRetirementChecks({assert,command,evaluate,until,untilFrame,frame,hostClick,check,origin,wheel});
  };
  // Independent browser scopes keep an earlier failure from hiding the
  // reconnect and obsolete-visit evidence; `resume` still runs the full flow.
  if(scope==='resume-reconnect'){await command('Page.bringToFront');await reconnect();return;}
  if(scope==='resume-retirement'){await command('Page.bringToFront');await retirement();return;}
  await command('Page.navigate',{url:`${origin}/?resume=1`});await command('Page.bringToFront');
  await waitIndex();await stage('cold-first-selection-and-native-scroll');
  const coldStart=await metric();await open('Host integration fixture');await ready('host-fixture');const coldEnd=await metric();
  const cold=await current();
  assert.equal(cold.x,0);assert.equal(cold.y,0);
  await wheel(550,600);await untilFrame('scrollX>500&&scrollY>550');
  await wheel(210,355,true);await untilFrame("document.querySelector('#resume-log').scrollLeft>150&&document.querySelector('#resume-log').scrollTop>300");
  await input('Native input survives while this frame is visible');
  await until("hostFixture.raw.some(m=>m.type==='view-state'&&m.view.x>500&&m.view.y>550&&m.view.scrolls.some(s=>s.selector==='#resume-log'&&s.x>150&&s.y>300))");
  const original=await current(),state=await savedView();
  assert.ok(state.scrolls.some(s=>s.selector==='#resume-log'&&s.x>150&&s.y>300));
  assert.ok(await frame('window.resumeWheelEvents.length>=2&&window.resumeWheelEvents.every(e=>e.trusted)'));
  await stage('agent-and-host-isolation');
  await switchAgent('B');await waitIndex();await open('Another project');await ready('another-board');
  await wheel(120,220);await untilFrame('scrollY>180');const otherAgent=await current();
  await until("hostFixture.raw.some(m=>m.type==='view-state'&&m.boardId==='another-board'&&m.view.y>180)");
  await switchAgent('Other-host');await waitIndex();await open('Host integration fixture');await ready('host-fixture');
  assert.equal((await current()).y,0,'A different host cannot inherit an equal Board ID reading position');
  assert.equal((await current()).innerY,0);
  check('real keyed agent and host entries keep their Board choices and reading positions isolated without clearing the QueryClient');

  // Change the inactive original Board, then hold its authoritative read. Its
  // cache must render and restore first, and the subsequent patch must reuse it.
  await stage('held-read-warm-restore');
  await evaluate("hostFixture.holdReads(true);hostFixture.resumeMutation('patch','Fresh inactive content');hostFixture.resumeUnread();true");
  const beforeSeen=await seenCalls();
  const acknowledgements=await evaluate("hostFixture.raw.filter(m=>m.type==='view-restored'&&m.boardId==='host-fixture'&&m.status==='restored').length");
  const warmStart=await metric();await switchAgent('A');await ready('host-fixture');const warmFirstReady=await metric();
  assert.equal(warmFirstReady.reads,warmStart.reads,'First warm ready is observed while every authoritative read is still held');
  await restoreAck(acknowledgements);const warmEnd=await metric();
  await until('hostFixture.pendingReads()>0');
  assert.equal(warmEnd.reads,warmStart.reads,'Warm readiness and view restoration precede completion of every held read');
  const warm=await current();equalView(warm,original,'Warm reopen');
  assert.equal(warm.text,'Initial authoritative content','The held read must not be required before the warm frame becomes usable');
  assert.notEqual(warm.token,original.token,'This adapter genuinely unmounts the previous iframe; do not claim its JS heap was retained');
  assert.equal(await frame("document.querySelector('#resume-input').value"),'','Ordinary author input state is not falsely claimed to survive a new iframe');
  const waitingFrame=await evaluate('hostFixture.mainReady()');
  const readsBeforeRelease=await evaluate('hostFixture.readMetrics.length');
  await evaluate('hostFixture.holdReads(false)');
  await untilFrame("document.querySelector('#resume-status').textContent==='Fresh inactive content'");
  await until(`hostFixture.readMetrics.length>${readsBeforeRelease}`);
  equalView(await current(),original,'Read reconciliation');
  assert.equal((await current()).token,warm.token,'Fresh inactive content must patch the warm frame rather than reboot it');
  assert.deepEqual(await evaluate('hostFixture.mainReady()'),waitingFrame);
  assert.equal(await seenCalls(),beforeSeen,'Resumption is not a visible unread receipt');
  assert.equal(await evaluate("hostFixture.updateRequests.filter(r=>r.update?.id==='resume-unread').length"),0,'Unread automatic focus must yield to the saved position');
  const complete=await metric();
  console.log('MEASURE resume-cold-warm '+JSON.stringify({coldFirstReadyMs:coldEnd.now-coldStart.now,warmFirstReadyMs:warmFirstReady.now-warmStart.now,warmRestoreMs:warmEnd.now-warmStart.now,coldReadCount:coldEnd.reads-coldStart.reads,coldReadBytes:coldEnd.bytes-coldStart.bytes,warmFirstReadyReads:warmFirstReady.reads-warmStart.reads,warmReadsBeforeRelease:warmEnd.reads-warmStart.reads,reconciliationReads:complete.reads-warmStart.reads,reconciliationBytes:complete.bytes-warmStart.bytes,coldFrame:coldEnd.ready,warmFirstReadyFrame:warmFirstReady.ready,warmRestoredFrame:warmEnd.ready,coldAuthorBoot:cold.token,warmAuthorBoot:warm.token,oldFrameActuallyUnmounted:true}));
  check('a warm cached Board restores both canvas axes and its nested scroll before a held read; fresh content then patches that same frame without unread jumps or automatic seen receipts');

  await stage('explicit-back-and-stale-tab');
  await switchAgent('B');await ready('another-board');await untilFrame(`Math.abs(scrollY-${otherAgent.y})<=2`);
  equalView(await current(),otherAgent,'Agent B return');
  await switchAgent('A');await ready('host-fixture');await untilFrame(`Math.abs(scrollY-${original.y})<=2`);
  await hostClick('button[aria-label="Boards"]');await waitIndex();
  await switchAgent('B');await ready('another-board');await switchAgent('A');await waitIndex();
  await hostClick('[data-testid="resume-reopen"]');await waitIndex();
  check('explicit Back stays on the Board index after agent switches and another keyed remount');
  const staleEcho=await evaluate('hostFixture.captureTabEcho()');assert.ok(staleEcho,'Capture the actual prior index state before selecting again');
  await open('Host integration fixture');await ready('host-fixture');await untilFrame(`Math.abs(scrollY-${original.y})<=2`);
  const stable=await current();await evaluate('hostFixture.staleTabRerender()');await settled();
  assert.equal(await currentId(),'host-fixture');assert.equal((await current()).token,stable.token);
  check('a stale host tab-state prop cannot replace the newly selected Board or rebuild its frame');

  await stage('full-page-reload');
  const pageBefore=await evaluate('hostFixture.pageInstance');
  await command('Page.reload',{ignoreCache:true});
  await until(`window.hostFixture?.pageInstance&&hostFixture.pageInstance!==${JSON.stringify(pageBefore)}`);
  await ready('host-fixture');await restoreAck();
  const reloaded=await current();equalView(reloaded,original,'Full reload');
  assert.notEqual(reloaded.token,stable.token);
  assert.equal(await seenCalls(),beforeSeen);assert.equal(await noSend(),0);
  check('a complete page reload recovers the selected Board and root/nested native-wheel reading position without sending or marking unread content seen');

  await switchAgent('B');await ready('another-board');
  await stage('inactive-same-revision-attention');
  const beforeAttention=await evaluate("hostFixture.resumeBoard().revision");
  await evaluate("hostFixture.resumeMutation('attention','resume-unread')");
  assert.equal(await evaluate("hostFixture.resumeBoard().revision"),beforeAttention);
  await switchAgent('A');await ready('host-fixture');
  await until("hostFixture.cacheBoard()?.seenUpdateIds.includes('resume-unread')");
  assert.equal(await evaluate('hostFixture.cacheBoard().revision'),beforeAttention);
  assert.equal(await seenCalls(),beforeSeen);
  check('an inactive same-revision attention event refreshes the returning Board from authoritative data without manufacturing a user seen receipt');

  await stage('old-read-completes-after-inactive-update');
  const oldReadCount=await evaluate('hostFixture.readMetrics.length');
  await evaluate("hostFixture.holdReads(true,true);void hostFixture.refetch();true");
  await until('hostFixture.pendingReads()>0');
  await switchAgent('B');await ready('another-board');
  await evaluate("hostFixture.resumeMutation('patch','New content after a held old response');hostFixture.holdReads(false);true");
  await until(`hostFixture.readMetrics.length>${oldReadCount}`);
  assert.ok(await evaluate(`hostFixture.readMetrics.slice(${oldReadCount}).some(r=>r.snapshotted&&r.boardId==='host-fixture'&&r.revision<hostFixture.resumeBoard().revision)`),'The race must actually deliver an earlier captured response');
  await switchAgent('A');await ready('host-fixture');
  await untilFrame("document.querySelector('#resume-status').textContent==='New content after a held old response'");
  assert.equal(await evaluate('hostFixture.cacheBoard().revision'),await evaluate('hostFixture.resumeBoard().revision'));
  assert.equal(await noSend(),0);
  check('an old read completing after unmount cannot clear a later inactive invalidation or hide its content on return');

  await stage('inactive-epoch-reset');
  const oldEpochReads=await evaluate('hostFixture.readMetrics.length');
  await evaluate("hostFixture.holdReads(true,true);void hostFixture.refetch();true");
  await until('hostFixture.pendingReads()>0');
  await switchAgent('B');await ready('another-board');
  const epochBoard=await evaluate("hostFixture.resumeMutation('epoch','New epoch authoritative document')");
  await evaluate('hostFixture.holdReads(false)');
  await until(`hostFixture.readMetrics.slice(${oldEpochReads}).some(r=>r.boardId==='host-fixture'&&r.snapshotted&&r.documentVersion<${epochBoard.canvas.documentVersion})`);
  await switchAgent('A');await ready('host-fixture');
  await untilFrame("document.querySelector('#resume-status').textContent==='New epoch authoritative document'");
  await until(`hostFixture.cacheBoard()?.canvas.documentVersion===${epochBoard.canvas.documentVersion}`);
  assert.equal(await evaluate('hostFixture.cacheBoard().revision'),1);
  assert.equal((await current()).y,0,'A saved view of an older document must not be restored onto its replacement');
  assert.equal((await current()).innerY,0);
  assert.equal(await noSend(),0);
  check('an epoch reset overrides a held old-epoch response and cached higher revision on return, while an older-document scroll record cannot move the new canvas');

  await stage('old-document-candidate-cannot-replace-new-initial-unread');
  await trace('before-pause',await current());
  await hostClick('button[aria-label="暂停跟随更新"]');
  await trace('after-pause',await current());
  await wheel(0,125);await untilFrame('scrollY>100');
  const pausedView=await current();await trace('after-native-wheel',pausedView);await until("JSON.parse(localStorage.getItem('@paseo:board-view:v1')).records.some(r=>r.kind==='view'&&r.hostId==='fixture-host'&&r.boardId==='host-fixture'&&r.follow===false)");
  await trace('before-switch-B',pausedView);await switchAgent('B');await ready('another-board');await trace('after-switch-B',await current());
  await switchAgent('A');await trace('A-mount-before-ready');await ready('host-fixture');await trace('A-ready-before-position-assertion',await current());
  try{await untilFrame(`Math.abs(scrollY-${pausedView.y})<=2`);}catch(error){await trace('A-position-timeout',await current());console.log('DIAG resume-view-history',JSON.stringify(await evaluate('hostFixture.viewDiagnostics')));throw error;}
  await trace('A-position-restored',await current());
  await until('document.querySelector(\'button[aria-label="继续跟随更新"]\')');
  const candidateRequests=await evaluate('hostFixture.updateRequests.length');
  await evaluate("hostFixture.resumeUnread('old-document-deferred-candidate')");
  await until("hostFixture.cacheBoard()?.updates.some(u=>u.id==='old-document-deferred-candidate')");
  const oldTotal=await evaluate('hostFixture.resumeBoard().updates.length');
  await until(`document.querySelector('[data-testid=board-update-position]')?.getAttribute('aria-label')?.includes('/${oldTotal}')`);await settled();
  assert.equal(await evaluate('hostFixture.updateRequests.length'),candidateRequests,'A live update accumulates while the restored follow preference is paused');
  equalView(await current(),pausedView,'Paused live update');
  const replacement=await evaluate("hostFixture.resumeReplaceWithUpdate('Replacement with its own unread place','new-document-initial-candidate')");
  await until(`hostFixture.cacheBoard()?.canvas.documentVersion===${replacement.canvas.documentVersion}`);await ready('host-fixture');
  await untilFrame("document.querySelector('#resume-status').textContent==='Replacement with its own unread place'");
  await until("hostFixture.updatePositions.some(p=>p.id==='new-document-initial-candidate'&&p.status==='focused')");
  const dispatched=await evaluate(`hostFixture.updateRequests.slice(${candidateRequests}).map(r=>r.update.id)`);
  console.log('MEASURE resume-document-candidates',JSON.stringify(await evaluate(`({
    requestCount:hostFixture.updateRequests.length-${candidateRequests},
    requests:hostFixture.updateRequests.slice(${candidateRequests}).slice(-16),
    positions:hostFixture.updatePositions.filter(p=>['old-document-deferred-candidate','new-document-initial-candidate'].includes(p.id)).slice(-16),
    activity:hostFixture.raw.filter(m=>m.type==='canvas-activity').slice(-24),
    ready:hostFixture.mainReady()
  })`)));
  assert.deepEqual(dispatched,['new-document-initial-candidate'],'Replacing the document restores default following and dispatches only its own newest unread candidate');
  assert.equal(await evaluate("hostFixture.resumeBoard().seenUpdateIds.includes('old-document-deferred-candidate')"),false);
  await until("hostFixture.resumeBoard().seenUpdateIds.includes('new-document-initial-candidate')");
  assert.equal(await noSend(),0);
  check('a restored paused follow preference accumulates a live old-document update; replacing the document follows only its new unread place without reviving the old candidate');

  if(scope==='resume-core')return;
  await reconnect();
  await retirement();
}
