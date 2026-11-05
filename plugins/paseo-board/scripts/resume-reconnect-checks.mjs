// A recovered event/compact connection can have the exact same cursor while a
// separate Board read remains failed. Exercise the real query/session lifecycle.
export async function runResumeReconnectChecks({assert,command,evaluate,until,untilFrame,hostClick,frame,check,origin}) {
  const count=name=>evaluate(`hostFixture.calls.filter(item=>item.name===${JSON.stringify(name)}).length`);
  const settled=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const ready=async()=>{
    await until("document.querySelector('iframe[data-board-id=host-fixture]')&&hostFixture.mainReady()?.ready");
    await untilFrame("Boolean(window.resumeBootToken&&document.querySelector('#resume-surface'))");
  };
  for (const transport of ['push','compact']) for (const cached of [false,true]) {
    const stage=`unchanged-${transport}-reconnect-${cached?'cached':'cold'}`;
    console.log('STAGE resume '+stage);
    const pageBefore=await evaluate('window.hostFixture?.pageInstance??null');
    await command('Page.navigate',{url:`${origin}/?resume=1&host=${stage}${transport==='compact'?'&push=off':''}`});
    await until(`window.hostFixture?.pageInstance&&hostFixture.pageInstance!==${JSON.stringify(pageBefore)}`);
    await evaluate(`hostFixture.resumeStage=${JSON.stringify(stage)}`);
    await until("document.querySelector('button[aria-label=\"打开 Host integration fixture\"]')&&document.querySelector('[data-testid=board-connection-status]')?.getAttribute('aria-label')==='实时同步：已同步'");
    let previousToken;
    if(cached){
      await hostClick('button[aria-label="打开 Host integration fixture"]');await ready();
      previousToken=await frame('window.resumeBootToken');
      await evaluate('hostFixture.readFails(true);void hostFixture.refetch();true');
    }else{
      assert.equal(await evaluate('hostFixture.cacheBoard()'),null);
      await evaluate('hostFixture.readFails(true)');
      await hostClick('button[aria-label="打开 Host integration fixture"]');
    }
    await until("hostFixture.boardQueryState()?.status==='error'&&hostFixture.boardQueryState()?.fetchStatus==='idle'");
    await settled();
    assert.equal(await evaluate('Boolean(hostFixture.cacheBoard())'),cached);
    if(cached)assert.equal(await frame('window.resumeBootToken'),previousToken,'A failed refetch must keep the cached canvas usable');
    const cursorBefore=await evaluate('hostFixture.eventCursor()');
    if(transport==='compact'){
      const checks=await count('board.check');
      await evaluate('hostFixture.checkFails(true)');
      await until(`hostFixture.calls.filter(item=>item.name==='board.check').length>${checks}`);
      await settled();
    }else await evaluate('hostFixture.eventDisconnect()');
    const failedReads=await count('board.read');
    if(transport==='compact')await evaluate('hostFixture.readFails(false);hostFixture.checkFails(false);true');
    else await evaluate('hostFixture.readFails(false);hostFixture.eventReconnect();true');
    await until("hostFixture.boardQueryState()?.status==='success'&&hostFixture.boardQueryState()?.fetchStatus==='idle'",15000);
    await ready();await settled();
    assert.deepEqual(await evaluate('hostFixture.eventCursor()'),cursorBefore,'Recovery must not depend on a new Board commit');
    assert.equal((await count('board.read'))-failedReads,1,'One successful connection recovery retries the settled failed Board exactly once');
    assert.equal(await evaluate('hostFixture.cacheBoard().revision'),await evaluate('hostFixture.resumeBoard().revision'));
    if(cached)assert.equal(await frame('window.resumeBootToken'),previousToken,'Recovery must patch the existing cached frame');
    const recoveredReads=await count('board.read');
    if(transport==='compact'){
      // Keep a later read failed while the compact connection itself is healthy:
      // idle cursor probes must not become a full-read retry loop.
      await evaluate('hostFixture.readFails(true);void hostFixture.refetch();true');
      await until("hostFixture.boardQueryState()?.status==='error'&&hostFixture.boardQueryState()?.fetchStatus==='idle'");
      const idleFailedReads=await count('board.read'),checks=await count('board.check');
      await until(`hostFixture.calls.filter(item=>item.name==='board.check').length>=${checks+2}`);
      await settled();
      assert.equal(await count('board.read'),idleFailedReads,'Healthy unchanged probes do not repeatedly retry a failed full read');
      await evaluate('hostFixture.readFails(false)');
    }else{
      const changes=await count('board.changes');
      await evaluate('hostFixture.eventReconnect();hostFixture.eventReconnect();true');
      await until(`hostFixture.calls.filter(item=>item.name==='board.changes').length>${changes}`);
      await settled();
      assert.equal(await count('board.read'),recoveredReads,'Already successful Boards do not refetch merely because the connection recovered again');
    }
    assert.equal(await count('board.interact'),0);
    check(`${transport} recovery with an unchanged cursor automatically reopens a failed ${cached?'cached':'initial'} Board read once, without sending or turning healthy checks into full reads`);
  }

  for (const transport of ['push','compact']) for (const cached of [false,true]) {
    const stage=`late-read-failure-${transport}-${cached?'cached':'cold'}`;
    console.log('STAGE resume '+stage);
    const pageBefore=await evaluate('window.hostFixture?.pageInstance??null');
    await command('Page.navigate',{url:`${origin}/?resume=1&host=${stage}${transport==='compact'?'&push=off':''}`});
    await until(`window.hostFixture?.pageInstance&&hostFixture.pageInstance!==${JSON.stringify(pageBefore)}`);
    await evaluate(`hostFixture.resumeStage=${JSON.stringify(stage)}`);
    await until("document.querySelector('button[aria-label=\"打开 Host integration fixture\"]')&&document.querySelector('[data-testid=board-connection-status]')?.getAttribute('aria-label')==='实时同步：已同步'");
    let previousToken;
    if(cached){await hostClick('button[aria-label="打开 Host integration fixture"]');await ready();previousToken=await frame('window.resumeBootToken');}
    await evaluate('hostFixture.holdFailureReads(true)');
    if(cached)await evaluate('void hostFixture.refetch();true');
    else await hostClick('button[aria-label="打开 Host integration fixture"]');
    await until('hostFixture.pendingFailureReads()===1');
    const firstReadCount=await count('board.read');
    await evaluate('hostFixture.rejectFailureReads()');
    // The ordinary bounded retry must already be the outstanding final attempt.
    await until(`hostFixture.pendingFailureReads()===1&&hostFixture.calls.filter(item=>item.name==='board.read').length===${firstReadCount+1}`);
    assert.equal(await evaluate('hostFixture.boardQueryState()?.fetchStatus'),'fetching');
    const cursorBefore=await evaluate('hostFixture.eventCursor()');
    if(transport==='compact'){
      const checks=await count('board.check');await evaluate('hostFixture.checkFails(true)');
      await until(`hostFixture.calls.filter(item=>item.name==='board.check').length>${checks}`);await settled();
      const failedChecks=await count('board.check');await evaluate('hostFixture.checkFails(false)');
      await until(`hostFixture.calls.filter(item=>item.name==='board.check').length>${failedChecks}`);await settled();
    }else{
      await evaluate('hostFixture.eventDisconnect()');const changes=await count('board.changes');
      await evaluate('hostFixture.eventReconnect()');
      await until(`hostFixture.calls.filter(item=>item.name==='board.changes').length>${changes}`);await settled();
    }
    assert.equal(await evaluate('hostFixture.pendingFailureReads()'),1,'The final old read remains held throughout successful connection recovery');
    assert.equal(await evaluate('hostFixture.boardQueryState()?.fetchStatus'),'fetching');
    if(cached)await until("document.querySelector('[data-testid=board-connection-status]')?.getAttribute('aria-label')==='实时同步：已同步'");
    const recoveredAt=await evaluate('performance.now()'),beforeRelease=await count('board.read');
    await evaluate('hostFixture.holdFailureReads(false);hostFixture.rejectFailureReads();true');
    await until("hostFixture.boardQueryState()?.status==='success'&&hostFixture.boardQueryState()?.fetchStatus==='idle'",15000);
    await ready();await settled();
    assert.ok(await evaluate(`hostFixture.failureReadMetrics.at(-1).finished>=${recoveredAt}`),'The last failed attempt actually finishes after transport recovery');
    assert.equal((await count('board.read'))-beforeRelease,1,'The recovery edge adds exactly one read after its previously pending request finally fails');
    assert.deepEqual(await evaluate('hostFixture.eventCursor()'),cursorBefore);
    if(cached)assert.equal(await frame('window.resumeBootToken'),previousToken);
    assert.equal(await count('board.interact'),0);
    check(`${transport} reconnects before the final ${cached?'cached':'initial'} read fails, then retries that late failure exactly once with an unchanged cursor`);
  }
}
