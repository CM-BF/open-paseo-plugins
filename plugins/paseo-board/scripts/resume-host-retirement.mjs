// Negative consumer boundary: a real old-runtime view begins native port
// dispatch, then a test observer remounts before the production consumer runs.
// Native wheel establishes the stable view; a trusted pointer task requests a
// test-only scoped child scroll and real runtime capture. This is not an actual
// daemon rapid-scroll check or a claim that dispatch began after frame removal.
export async function runResumeRetirementChecks({assert,command,evaluate,until,untilFrame,frame,hostClick,check,origin,wheel}) {
  const ready=async()=>{await until("hostFixture.mainReady()?.ready&&document.querySelector('iframe[data-board-id=host-fixture]')");await untilFrame('Boolean(window.resumeBootToken)');};
  const open=async()=>{if(await evaluate("Boolean(document.querySelector('button[aria-label=\"打开 Host integration fixture\"]'))"))await hostClick('button[aria-label="打开 Host integration fixture"]');await ready();};
  const view=()=>frame('({x:scrollX,y:scrollY,token:resumeBootToken})');
  const equal=(a,b,label)=>{assert(Math.abs(a.x-b.x)<=2&&Math.abs(a.y-b.y)<=2,`${label}: ${JSON.stringify({actual:a,expected:b})}`);};
  const saved=async()=>{const value=await view();await until(`hostFixture.traceView('retirement-setup').currentMemory?.view.y===${value.y}`);return value;};
  const pageBefore=await evaluate('window.hostFixture?.pageInstance??null');
  await command('Page.navigate',{url:`${origin}/?resume=1&host=retirement-host`});
  await until(`window.hostFixture?.pageInstance&&hostFixture.pageInstance!==${JSON.stringify(pageBefore)}`);
  await evaluate("hostFixture.resumeStage='queued-old-visit-generation-negative'");
  await open();
  // Prime the separate host so its replacement frame can mount synchronously
  // from the normal cache in the controlled pointer task below.
  await hostClick('[data-testid="resume-Other-host"]');await open();
  await wheel(0,270);await untilFrame('scrollY>=250');const other=await saved();
  await hostClick('[data-testid="resume-A"]');await ready();
  for(const kind of ['same','other-host']){
    if(kind==='other-host'){await hostClick('[data-testid="resume-A"]');await ready();}
    // The dedicated pointer task arms a child scroll/capture. Once that exact
    // native message starts dispatch, the observer remounts synchronously before
    // the production consumer slot. No scheduling delay or retry is involved.
    const beforeStable=await view();await wheel(0,140);await untilFrame(`scrollY>${beforeStable.y+100}`);const stable=await saved();
    const latest={...stable,y:stable.y+125};
    const before=await evaluate('hostFixture.retirementMessages.length');
    const outboundBefore=await evaluate('hostFixture.retirementOutbound.length');
    await hostClick(`[data-testid="resume-retire-${kind}"]`);
    await until(`hostFixture.retirementMessages.slice(${before}).some(r=>r.message.view.y===${latest.y}&&r.afterAt)`);
    const observed=await evaluate(`hostFixture.retirementMessages.slice(${before}).find(r=>r.message.view.y===${latest.y}&&r.afterAt)`);
    await until(`hostFixture.retirementOutbound.slice(${outboundBefore}).some(r=>r.message.view.y===${latest.y}&&r.afterAt)`);
    const outbound=await evaluate(`hostFixture.retirementOutbound.slice(${outboundBefore}).find(r=>r.message.view.y===${latest.y}&&r.afterAt)`);
    assert.equal(observed.trustedPointer,true);assert.equal(outbound.trustedMessage,true);assert.equal(observed.trustedMessage,true);
    assert.equal(observed.oldPortMatched,true);assert.equal(observed.oldFrameConnectedAtDispatch,true);assert.equal(observed.oldFrameRemoved,true);
    assert.equal(observed.sessionAtDispatch,observed.oldSession,'The real event starts dispatch while the old session is mounted');
    assert.equal(observed.boundSession,observed.oldSession);assert.equal(observed.boundHost,observed.oldHost);
    assert.equal(outbound.message.sessionId,observed.oldSession);assert.ok(observed.newSession);assert.notEqual(observed.newSession,observed.oldSession);
    assert.equal(observed.currentSession,observed.newSession,'The replacement exists before native dispatch reaches the production consumer slot');
    assert.equal(observed.afterPhase,'native-after-production-consumer-slot','The final store is read by the later native observer, not a manually invoked callback');
    const childScroll=outbound.retirementScroll;
    assert.equal(childScroll?.requestId,observed.scrollRequestId,'The real report belongs to this scoped pointer-task scroll');
    assert.equal(childScroll.parentMatched,true);assert.equal(childScroll.boardId,'host-fixture');assert.equal(childScroll.sessionId,observed.oldSession);
    equal(childScroll.before,stable,'The child still has the accepted native-wheel baseline at pointer-task entry');
    equal(childScroll.after,latest,'The scoped fixture command scrolls the actual old document');
    assert.equal(childScroll.before.token,stable.token);assert.equal(childScroll.after.token,stable.token);
    equal(observed.memoryBefore.view,stable,'The retiring pointer task starts with the accepted baseline');
    equal(observed.memoryAtDispatch.view,stable,'The production store still has the baseline before the matching native event is consumed');
    equal(outbound.message.view,childScroll.after,'The unchanged runtime sends the actual scrolled position');
    assert.deepEqual(observed.message,outbound.message,'The native event independently proves the exact send intent reached the authenticated port');
    assert(childScroll.startedAtAbsolute>=observed.atAbsolute,'The test-only child scroll starts after the trusted parent pointer task');
    assert(childScroll.finishedAtAbsolute>=childScroll.startedAtAbsolute);
    assert(outbound.sendIntentAtAbsolute>=childScroll.finishedAtAbsolute,'The old runtime enters native send after the real child scroll');
    assert(outbound.sendIntentAtAbsolute<=observed.nativeDispatchStartedAbsolute,'Native dispatch of the same payload proves the send occurred after its intent; intent alone is not send completion');
    assert(observed.nativeDispatchStartedAbsolute<=observed.replacedAtAbsolute);
    assert(observed.replacedAtAbsolute<=observed.afterAtAbsolute,'The later native observer reads stores after the replacement and production-consumer slot');
    if(kind==='same'){
      assert.equal(typeof observed.portClosedAt,'number','A new same-scope visit closes the old authenticated port');
      assert.equal(typeof observed.productionListenerRemovedAt,'number','The same-scope replacement removes the production listener before its slot in this native dispatch');
      assert(observed.productionListenerRemovedAt>=observed.nativeDispatchStarted&&observed.productionListenerRemovedAt<=observed.portClosedAt);
      assert(observed.portClosedAt<=observed.replacedAt);
    }else{
      assert.equal(observed.productionListenerRemovedAt,undefined,'Cross-host departure retains the original native listener and changes its mutable reader');
      equal(observed.oldMemoryAfter.view,latest,'The bounded old port saves only its own retired host position');
    }
    const expected=kind==='same'?stable:other;
    equal(observed.targetMemoryBefore.view,expected,'Prepared target scope baseline');
    equal(observed.targetMemoryAfter.view,expected,'Late old visit cannot overwrite the target scope record');
    await ready();await untilFrame(`Math.abs(scrollX-${expected.x})<=2&&Math.abs(scrollY-${expected.y})<=2`);equal(await view(),expected,'Replacement visit position');
    assert.equal(await evaluate("hostFixture.calls.filter(c=>c.name==='board.interact').length"),0);
    console.log('MEASURE retired-view-negative',JSON.stringify({kind,stable,latest,expected,outbound,observed}));
    check(kind==='same'?'native view dispatch begins on the old visit, then same-scope remount removes its production listener before consumption and preserves the new position':'native old-host view dispatch begins, then cross-host remount precedes the unchanged consumer and the real message saves only its retired host position');
  }
}
