// Negative teardown boundary: the real old runtime sends through its native view
// port while a trusted parent task queues delivery until a newer visit is mounted.
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
    // Establish an accepted baseline and then issue a second native wheel. The
    // second position is deliberately NOT awaited in the view store.
    const beforeStable=await view();await wheel(0,140);await untilFrame(`scrollY>${beforeStable.y+100}`);const stable=await saved();
    await wheel(0,125);await untilFrame(`scrollY>${stable.y+100}`);const latest=await view();
    const before=await evaluate('hostFixture.retirementMessages.length');
    const outboundBefore=await evaluate('hostFixture.retirementOutbound.length');
    await hostClick(`[data-testid="resume-retire-${kind}"]`);
    await until(`hostFixture.retirementOutbound.slice(${outboundBefore}).some(r=>r.message.view.y===${latest.y}&&r.afterAt)`);
    const outbound=await evaluate(`hostFixture.retirementOutbound.slice(${outboundBefore}).find(r=>r.message.view.y===${latest.y}&&r.afterAt)`);
    assert.equal(outbound.trustedPointer,true);assert.equal(outbound.trustedMessage,true);assert.equal(outbound.oldFrameRemoved,true);
    assert.equal(outbound.message.sessionId,outbound.oldSession);assert.ok(outbound.newSession);assert.notEqual(outbound.newSession,outbound.oldSession);
    assert.equal(outbound.currentSession,outbound.newSession,'The old runtime send is observed only after a replacement session exists');
    assert(outbound.receivedAt>=outbound.replacedAt);
    let observed=outbound;
    if(kind==='same'){
      assert.equal(typeof outbound.portClosedAt,'number','A new same-scope visit closes the old authenticated port before any queued report can overwrite its position');
      assert(outbound.portClosedAt<=outbound.receivedAt);
    }else{
      await until(`hostFixture.retirementMessages.slice(${before}).some(r=>r.message.view.y===${latest.y}&&r.afterAt)`);
      observed=await evaluate(`hostFixture.retirementMessages.slice(${before}).find(r=>r.message.view.y===${latest.y}&&r.afterAt)`);
      assert.equal(observed.trustedMessage,true);assert.equal(observed.oldPortMatched,true);assert.equal(observed.oldFrameRemoved,true);
      assert.equal(observed.boundSession,observed.oldSession);assert.equal(observed.boundHost,observed.oldHost);
      assert.equal(observed.currentSession,observed.newSession,'The genuine old-port message is delivered after the other-host session mounts');
      assert.equal(observed.afterPhase,'native-after-host-listener','Read the exact old-host store only after the actual production listener handles this same native event');
      equal(observed.oldMemoryAfter.view,latest,'The bounded old port saves only its own retired host position');
    }
    const expected=kind==='same'?stable:other;
    equal(observed.targetMemoryBefore.view,expected,'Prepared target scope baseline');
    equal(observed.targetMemoryAfter.view,expected,'Late old visit cannot overwrite the target scope record');
    await ready();await untilFrame(`Math.abs(scrollX-${expected.x})<=2&&Math.abs(scrollY-${expected.y})<=2`);equal(await view(),expected,'Replacement visit position');
    assert.equal(await evaluate("hostFixture.calls.filter(c=>c.name==='board.interact').length"),0);
    console.log('MEASURE retired-view-negative',JSON.stringify({kind,stable,latest,expected,outbound,observed}));
    check(kind==='same'?'a new same-scope visit closes the old native view port, so the old runtime’s real send cannot overwrite the new visit position':'a genuine queued old-host port message arrives after switching hosts and can save only its own host position, not the equal Board ID in the new host');
  }
}
