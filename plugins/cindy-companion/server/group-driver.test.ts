import { expect, it, vi } from 'vitest';
import { NativeGroupDriver, prepareLaneDispatch, stopFailureCode, type GroupLane, type LaneDispatch } from './group-driver';
import type { Paseo } from './runtime';

function fake() {
  const listeners = new Set<() => void>(), streamListeners = new Set<(event?: any) => void>();
  const entries: any[] = [], writes: LaneDispatch[] = [];
  let found = true, snapshot: any = { status: 'idle', cwd: '/owned/group/workspace', pendingPermissions: [], activeTurn: null };
  let queue: any = { agentId:'a',clientMessageId:'m1',status:'queued',queueId:'q1' };
  let turn: any = { agentId:'a',clientMessageId:'m1',turnId:'turn',status:'unknown' };
  let cancellation: any = { agentId:'a',clientMessageId:'m1',operationId:'cancel',status:'unknown' };
  let creation: any = null;
  const notify = () => { for (const f of listeners) f(); for (const f of streamListeners) f({event:{type:'state'}}); };
  const timelineUnsubscribe = vi.fn(() => streamListeners.clear());
  const agent = {
    id:'a', get cwd(){return snapshot.cwd;},get archivedAt(){return snapshot.archivedAt;},get status(){return snapshot.status;},
    get activeTurn(){return snapshot.activeTurn;},get pendingPermissions(){return snapshot.pendingPermissions;},workspaceId:'w',
    refresh:vi.fn(async()=>found?{agent:snapshot}:null),current:()=>snapshot,
    subscribe:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},
    send:vi.fn(),sendIfIdle:vi.fn(),interrupt:vi.fn(),archive:vi.fn(),
    inputs:{enqueue:vi.fn(async(_input:unknown,options:{messageId:string})=>{queue={...queue,clientMessageId:options.messageId};return queue;}),
      get:vi.fn(async()=>queue),cancel:vi.fn(async(input:{messageId:string;operationId:string})=>{
        cancellation={...queue,operationId:input.operationId,status:'cancelled'};queue={...queue,status:'cancelled'};return cancellation;
      }),getCancellation:vi.fn(async()=>cancellation)},
    turns:{get:vi.fn(async()=>turn)},
    timeline:{subscribe:(f:(event:any)=>void)=>{streamListeners.add(f);return Object.assign(timelineUnsubscribe,{ready:Promise.resolve()});},
      refetch:vi.fn(async()=>({entries,error:null,hasOlder:false}))},
  };
  const api={agents:{ref:vi.fn(()=>agent),supportsInitialPromptReservation:vi.fn(()=>true),supportsTurnReceipts:vi.fn(()=>true),supportsQueuedInputs:vi.fn(()=>true),
    create:vi.fn(async(input:any)=>{found=true;snapshot={...snapshot,labels:input.labels};
      creation={kind:'agent',agentId:'a',workspaceId:'w',idempotencyKey:input.idempotencyKey,phase:'completed',initialPrompt:{status:'accepted',clientMessageId:input.clientMessageId,turnId:'turn'}};
      turn={...turn,clientMessageId:input.clientMessageId};entries.push({turnId:'turn',item:{type:'user_message',clientMessageId:input.clientMessageId,text:input.prompt}});return agent;})},
    creations:{get:vi.fn(async()=>creation)}};
  const lane:GroupLane={agentId:'a',operationId:'op',groupId:'g',roundId:'r',botId:'cindy',cwd:snapshot.cwd,title:'group',config:{provider:'codex/test'},phase:'ready',nativeInputVersion:1,dispatch:prepareLaneDispatch('m1')};
  const recordDispatch=async(receipt:LaneDispatch)=>{writes.push(structuredClone(receipt));lane.dispatch=structuredClone(receipt);};
  const input={prompt:'question',messageId:'m1',signal:new AbortController().signal,permission:vi.fn(),queued:vi.fn(async(_value:boolean)=>{}),recordDispatch};
  const update=(patch:object)=>{snapshot={...snapshot,...patch};notify();};
  const start=()=>{queue={...queue,status:'started',turnId:'turn'};entries.push({turnId:'turn',item:{type:'user_message',clientMessageId:queue.clientMessageId,text:'question'}});update({status:'running',activeTurn:{turnId:'turn'}});};
  const complete=(status='completed')=>{turn={...turn,status,observedAt:'2026-10-29T01:00:00Z'};entries.push({turnId:'turn',item:{type:'assistant_message',text:'owned final'}});update({status:'idle',activeTurn:null});};
  return {driver:new NativeGroupDriver(api as unknown as Paseo),api,agent,lane,input,writes,entries,listeners,streamListeners,timelineUnsubscribe,start,complete,update,
    missing(){found=false;lane.phase='creating';},queue(value:object){queue={...queue,...value};notify();},turn(value:object){turn={...turn,...value};notify();},
    cancellation(value:object){cancellation={...cancellation,...value};},creation(value:object){creation={...creation,...value};}};
}
it('persists immutable first input before reservation create, then observes that first turn without an extra enqueue',async()=>{
  const f=fake();f.missing();const create=f.api.agents.create.getMockImplementation()!;
  f.api.agents.create.mockImplementation(async options=>{expect(f.writes.at(-1)).toMatchObject({phase:'dispatching',native:{intent:{admission:'initial',creation:{config:{provider:'codex/test'}},input:{text:'question'}}}});return create(options);});
  expect(await f.driver.ensure(f.lane,f.input)).toEqual({workspaceId:'w'});f.lane.phase='ready';f.complete();
  expect(await f.driver.reply(f.lane,f.input)).toBe('owned final');
  expect(f.api.agents.create).toHaveBeenCalledOnce();expect(f.api.agents.create).toHaveBeenCalledWith(expect.objectContaining({prompt:'question',clientMessageId:'m1',requireInitialPromptReservation:true,background:true}));
  expect(f.agent.inputs.enqueue).not.toHaveBeenCalled();expect(f.agent.send).not.toHaveBeenCalled();
});
it('reads a lost initial creation ACK instead of recreating or queueing another first prompt',async()=>{
  const f=fake();f.missing();const create=f.api.agents.create.getMockImplementation()!;
  f.api.agents.create.mockImplementation(async options=>{await create(options);throw new Error('ACK lost');});
  await f.driver.ensure(f.lane,f.input);const restored=JSON.parse(JSON.stringify(f.lane)) as GroupLane;
  await f.driver.ensure(restored,f.input);expect(f.api.agents.create).toHaveBeenCalledOnce();expect(f.agent.inputs.enqueue).not.toHaveBeenCalled();
});
it('keeps a created lane after a definitely unsent first prompt and queues an explicit retry in that same session',async()=>{
 const f=fake();f.missing();const create=f.api.agents.create.getMockImplementation()!;
 f.api.agents.create.mockImplementation(async options=>{const value=await create(options);f.creation({initialPrompt:{status:'not_sent',clientMessageId:options.clientMessageId,error:'PROVIDER_QUEUE_UNAVAILABLE'}});return value;});
 await expect(f.driver.ensure(f.lane,f.input)).rejects.toMatchObject({code:'PROVIDER_QUEUE_UNAVAILABLE'});
 expect(f.lane.phase).toBe('ready');expect(f.lane.dispatch?.native).toMatchObject({creationComplete:true,phase:'not-sent'});
 const input={...f.input,messageId:'explicit-retry',prompt:'Explicit retry'};f.lane.dispatch=prepareLaneDispatch(input.messageId);
 await f.driver.ensure(f.lane,input);f.queue({status:'started',turnId:'retry-turn'});f.turn({clientMessageId:'explicit-retry',turnId:'retry-turn',status:'completed',observedAt:'2026-10-29T02:00:00Z'});
 f.entries.push({turnId:'retry-turn',item:{type:'user_message',clientMessageId:'explicit-retry',text:'Explicit retry'}},{turnId:'retry-turn',item:{type:'assistant_message',text:'Retry result'}});
 expect(await f.driver.reply(f.lane,input)).toBe('Retry result');expect(f.api.agents.create).toHaveBeenCalledOnce();expect(f.agent.inputs.enqueue).toHaveBeenCalledExactlyOnceWith({text:'Explicit retry'},{messageId:'explicit-retry'});
});
it('keeps legacy creation without immutable input explicitly unknown and never guesses a new first prompt',async()=>{
  const f=fake();f.missing();delete f.lane.nativeInputVersion;
  await expect(f.driver.ensure(f.lane,f.input)).rejects.toMatchObject({code:'ADMISSION_OUTCOME_UNKNOWN'});expect(f.api.agents.create).not.toHaveBeenCalled();
});
it('queues once on the same lane while another human turn is active, and does not call queued started',async()=>{
  const f=fake();f.update({status:'running',activeTurn:{turnId:'human'}});let done=false;
  const result=f.driver.reply(f.lane,f.input).then(text=>{done=true;return text;});
  await vi.waitFor(()=>expect(f.input.queued).toHaveBeenCalledWith(true));expect(done).toBe(false);expect(f.lane.dispatch).toMatchObject({phase:'queued'});expect(f.lane.dispatch?.turnId).toBeUndefined();
  f.start();f.complete();expect(await result).toBe('owned final');expect(f.agent.inputs.enqueue).toHaveBeenCalledOnce();expect(f.api.agents.create).not.toHaveBeenCalled();expect(f.agent.sendIfIdle).not.toHaveBeenCalled();expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it('returns only the completed owned answer after an unrelated human successor',async()=>{
  const f=fake();const result=f.driver.reply(f.lane,f.input);await vi.waitFor(()=>expect(f.input.queued).toHaveBeenCalledWith(true));
  f.start();f.complete();f.entries.push({turnId:'human-next',item:{type:'user_message',clientMessageId:'human',text:'private'}},{turnId:'human-next',item:{type:'assistant_message',text:'private answer'}});f.update({status:'running',activeTurn:{turnId:'human-next'}});
  expect(await result).toBe('owned final');await f.driver.stop(f.lane,f.input.recordDispatch);expect(f.agent.interrupt).not.toHaveBeenCalled();expect(f.agent.activeTurn).toEqual({turnId:'human-next'});
});
it('does not mistake idle and a visible answer for a durable completed turn',async()=>{
  const f=fake();let done=false;const result=f.driver.reply(f.lane,f.input).then(value=>{done=true;return value;});await vi.waitFor(()=>expect(f.input.queued).toHaveBeenCalledWith(true));
  f.start();f.entries.push({turnId:'turn',item:{type:'assistant_message',text:'not terminal'}});f.update({status:'idle',activeTurn:null});await vi.waitFor(()=>expect(f.agent.turns.get).toHaveBeenCalled());expect(done).toBe(false);
  f.complete();expect(await result).toBe('owned final');
});
it('requires successful terminal evidence and retains failed partial output without publishing it',async()=>{
  const f=fake(),result=f.driver.reply(f.lane,f.input);const rejected=expect(result).rejects.toMatchObject({code:'RUNTIME_ERROR'});
  await vi.waitFor(()=>expect(f.input.queued).toHaveBeenCalledWith(true));f.start();f.complete('failed');await rejected;expect(f.agent.timeline.refetch).not.toHaveBeenCalled();
});
it('reports permission only for the exact owned turn and removes observers after abort',async()=>{
  const f=fake(),controller=new AbortController(),result=f.driver.reply(f.lane,{...f.input,signal:controller.signal});const rejected=expect(result).rejects.toMatchObject({code:'GROUP_STOPPED'});
  await vi.waitFor(()=>expect(f.input.queued).toHaveBeenCalledWith(true));f.update({activeTurn:{turnId:'human'},pendingPermissions:[{id:'human'}]});f.start();
  await vi.waitFor(()=>expect(f.input.permission).toHaveBeenCalledWith(true));controller.abort();await rejected;
  expect(f.listeners.size).toBe(0);expect(f.timelineUnsubscribe).toHaveBeenCalledOnce();
});
it('requires public methods and negotiated capabilities without ordinary-send fallback',async()=>{
  const f=fake();f.api.agents.supportsQueuedInputs.mockReturnValue(false);
  await expect(f.driver.reply(f.lane,f.input)).rejects.toMatchObject({code:'HOST_UPGRADE_REQUIRED'});expect(f.agent.inputs.enqueue).not.toHaveBeenCalled();expect(f.agent.send).not.toHaveBeenCalled();
});
it('keeps provider queue rejection definitely not sent without stopping a human turn',async()=>{
  const f=fake();f.queue({status:'not_sent',code:'PROVIDER_QUEUE_UNAVAILABLE'});
  await expect(f.driver.reply(f.lane,f.input)).rejects.toMatchObject({code:'PROVIDER_QUEUE_UNAVAILABLE'});f.update({status:'running',activeTurn:{turnId:'human'}});
  await f.driver.stop(f.lane,f.input.recordDispatch);expect(f.lane.dispatch?.phase).toBe('not-sent');expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it('aborts after the persisted dispatch fence but before the native enqueue',async()=>{
  const f=fake(),controller=new AbortController();let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);let entered=false;
  const result=f.driver.reply(f.lane,{...f.input,signal:controller.signal,recordDispatch:async receipt=>{await f.input.recordDispatch(receipt);if(receipt.phase==='dispatching'){entered=true;await held;}}});const rejected=expect(result).rejects.toMatchObject({code:'GROUP_STOPPED'});
  await vi.waitFor(()=>expect(entered).toBe(true));controller.abort();release();await rejected;expect(f.lane.dispatch?.phase).toBe('not-sent');expect(f.agent.inputs.enqueue).not.toHaveBeenCalled();
});
it('retains unknown across serialized restart and never retries enqueue because native looks idle',async()=>{
  const f=fake();f.agent.inputs.enqueue.mockRejectedValue(new Error('ACK lost'));f.queue({status:'unknown'});
  await expect(f.driver.reply(f.lane,f.input)).rejects.toMatchObject({code:'ADMISSION_OUTCOME_UNKNOWN',dispatchOutcome:'unknown'});
  const restored=JSON.parse(JSON.stringify(f.lane));await expect(f.driver.reply(restored,f.input)).rejects.toMatchObject({code:'ADMISSION_OUTCOME_UNKNOWN'});expect(f.agent.inputs.enqueue).toHaveBeenCalledOnce();
});
it('withdraws the exact queued item and uses the saved cancellation receipt after lost ACK',async()=>{
  const f=fake(),controller=new AbortController(),result=f.driver.reply(f.lane,{...f.input,signal:controller.signal});const rejected=expect(result).rejects.toMatchObject({code:'GROUP_STOPPED'});
  await vi.waitFor(()=>expect(f.input.queued).toHaveBeenCalledWith(true));controller.abort();await rejected;
  f.agent.inputs.cancel.mockImplementation(async input=>{f.cancellation({status:'cancelled',queueId:'q1',operationId:input.operationId});throw new Error('ACK lost');});
  await f.driver.stop(f.lane,f.input.recordDispatch);await f.driver.stop(JSON.parse(JSON.stringify(f.lane)),f.input.recordDispatch);
  expect(f.agent.inputs.cancel).toHaveBeenCalledOnce();expect(f.agent.inputs.getCancellation).toHaveBeenCalledWith({messageId:'m1',operationId:f.lane.dispatch!.cancelMessageId});expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it.each([false,true])('preserves removal uncertainty through Stop and cleanup, then reads the actual turn (lost ACK: %s)',async lostAck=>{
  const f=fake(),controller=new AbortController();
  const pending=f.driver.reply(f.lane,{...f.input,signal:controller.signal});
  const stoppedReply=expect(pending).rejects.toMatchObject({code:'GROUP_STOPPED'});
  try { await vi.waitFor(()=>expect(f.input.queued).toHaveBeenCalledWith(true)); }
  finally { controller.abort(); await stoppedReply; }
  f.agent.inputs.cancel.mockImplementation(async input=>{
    const removed={agentId:'a',clientMessageId:'m1',operationId:input.operationId,status:'unknown',queueId:'q1',code:'QUEUE_ITEM_REMOVED'};
    f.cancellation(removed);f.queue({status:'unknown',code:'INPUT_NOT_OBSERVED'});
    if(lostAck)throw new Error('delete ACK lost');
    return removed;
  });
  await expect(f.driver.stop(f.lane,f.input.recordDispatch)).rejects.toMatchObject({code:'QUEUE_ITEM_REMOVED'});
  expect(stopFailureCode({code:'QUEUE_ITEM_REMOVED'})).toBe('QUEUE_ITEM_REMOVED');
  expect(stopFailureCode({code:'INPUT_NOT_OBSERVED'})).toBe('STOP_NOT_CONFIRMED');
  expect(f.lane.dispatch).toMatchObject({phase:'unknown',native:{phase:'unknown',cancellation:{phase:'unknown',code:'QUEUE_ITEM_REMOVED'}}});
  expect(f.lane.dispatch?.stopConfirmed).toBeUndefined();
  const restored=structuredClone(f.lane),stop=f.driver.stop.bind(f.driver);
  await expect(stop(restored,f.input.recordDispatch)).rejects.toMatchObject({code:'QUEUE_ITEM_REMOVED'});
  // Exercise archive's real stop gate with the owning service's persistence callback.
  vi.spyOn(f.driver,'stop').mockImplementation(lane=>stop(lane,f.input.recordDispatch));
  await expect(f.driver.archive(restored)).rejects.toMatchObject({code:'QUEUE_ITEM_REMOVED'});
  expect(f.agent.archive).not.toHaveBeenCalled();
  f.start();await expect(stop(restored,f.input.recordDispatch)).rejects.toMatchObject({code:'GROUP_STOP_REQUIRES_NATIVE'});
  expect(restored.dispatch).toMatchObject({phase:'accepted',turnId:'turn',native:{phase:'started'}});
  f.complete();await stop(restored,f.input.recordDispatch);
  expect(restored.dispatch?.native?.phase).toBe('completed');
  expect(f.agent.inputs.enqueue).toHaveBeenCalledOnce();expect(f.agent.inputs.cancel).toHaveBeenCalledOnce();
  expect(f.agent.inputs.getCancellation).toHaveBeenCalled();expect(f.agent.inputs.get).toHaveBeenCalled();
  expect(f.agent.interrupt).not.toHaveBeenCalled();expect(f.agent.archive).not.toHaveBeenCalled();
});
it('keeps legacy exact-stop behavior bound to the durable turn without touching a human successor',async()=>{
  const f=fake();f.lane.dispatch={messageId:'old',cancelMessageId:'cancel-fixed',phase:'accepted',turnId:'owned'};f.update({status:'running',activeTurn:{turnId:'human'}});
  await expect(f.driver.stop(f.lane)).rejects.toMatchObject({code:'GROUP_STOP_REQUIRES_NATIVE'});
  const cancelTurn=vi.fn(async()=>({status:'changed' as const}));Object.assign(f.agent,{cancelTurn});await f.driver.stop(f.lane);
  expect(cancelTurn).toHaveBeenCalledWith({expectedTurnId:'owned',messageId:'cancel-fixed'});expect(f.agent.interrupt).not.toHaveBeenCalled();
  f.update({cwd:'/other'});await expect(f.driver.stop(f.lane)).rejects.toMatchObject({code:'GROUP_LANE_MISMATCH'});
});
it('persists exact stop confirmation without forging terminal success, then permits a new same-lane queued input',async()=>{
 const f=fake(),controller=new AbortController(),input={...f.input,signal:controller.signal};f.queue({status:'started',turnId:'turn'});
 const pending=f.driver.reply(f.lane,input),rejected=expect(pending).rejects.toMatchObject({code:'GROUP_STOPPED'});
 await vi.waitFor(()=>expect(f.lane.dispatch?.phase).toBe('accepted'));controller.abort();await rejected;
 f.update({status:'running',activeTurn:{turnId:'human'}});const cancelTurn=vi.fn(async()=>({status:'changed' as const}));Object.assign(f.agent,{cancelTurn});
 await f.driver.stop(f.lane,f.input.recordDispatch);expect(f.lane.dispatch).toMatchObject({phase:'completed',stopConfirmed:true,native:{phase:'started'}});
 const restored=JSON.parse(JSON.stringify(f.lane));await f.driver.stop(restored,f.input.recordDispatch);expect(cancelTurn).toHaveBeenCalledOnce();
 const next={...f.input,messageId:'next-user-input',prompt:'Next queued prompt'};f.queue({status:'started',turnId:'next-turn'});f.turn({clientMessageId:next.messageId,turnId:'next-turn',status:'completed',observedAt:'2026-10-29T03:00:00Z'});
 f.entries.push({turnId:'next-turn',item:{type:'user_message',clientMessageId:next.messageId,text:next.prompt}},{turnId:'next-turn',item:{type:'assistant_message',text:'New own answer'}});
 expect(await f.driver.reply(restored,next)).toBe('New own answer');expect(f.agent.activeTurn).toEqual({turnId:'human'});expect(f.agent.interrupt).not.toHaveBeenCalled();expect(f.agent.inputs.enqueue).toHaveBeenCalledTimes(2);
});
it('does not confirm stopping a known native input from idle when its durable terminal is still unknown',async()=>{
 const f=fake(),controller=new AbortController();f.queue({status:'started',turnId:'turn'});
 const pending=f.driver.reply(f.lane,{...f.input,signal:controller.signal}),rejected=expect(pending).rejects.toMatchObject({code:'GROUP_STOPPED'});
 await vi.waitFor(()=>expect(f.lane.dispatch?.phase).toBe('accepted'));controller.abort();await rejected;
 f.update({status:'idle',activeTurn:null});await expect(f.driver.stop(f.lane,f.input.recordDispatch)).rejects.toMatchObject({code:'GROUP_STOP_REQUIRES_NATIVE'});expect(f.lane.dispatch?.stopConfirmed).toBeUndefined();
 f.complete('cancelled');await f.driver.stop(f.lane,f.input.recordDispatch);expect(f.lane.dispatch?.native?.phase).toBe('cancelled');
});
it('never automatically archives an idle native lane and retains uncertain creation cleanup',async()=>{
  const f=fake();f.lane.dispatch={messageId:'done',cancelMessageId:'cancel',phase:'completed',turnId:'owned'};
  await expect(f.driver.archive(f.lane)).rejects.toMatchObject({code:'GROUP_ARCHIVE_REQUIRES_NATIVE'});expect(f.agent.archive).not.toHaveBeenCalled();
  f.update({archivedAt:'native-archive'});await f.driver.archive(f.lane);f.missing();f.lane.dispatch=prepareLaneDispatch('never-sent');
  await expect(f.driver.archive(f.lane)).rejects.toMatchObject({code:'CLEANUP_NOT_CONFIRMED'});expect(f.agent.archive).not.toHaveBeenCalled();
});
