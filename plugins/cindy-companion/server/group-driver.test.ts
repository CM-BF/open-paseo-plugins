import { expect, it, vi } from 'vitest';
import { NativeGroupDriver, type GroupLane } from './group-driver';
import type { Paseo } from './runtime';

function fake() {
  const listeners = new Set<() => void>(); const streamListeners = new Set<(event: any) => void>();
  const entries: any[] = []; let snapshot: any = { status: 'idle', cwd: '/owned/group/workspace', pendingPermissions: [], activeTurn: null };
  const timelineUnsubscribe = vi.fn(() => streamListeners.clear());
  const agent = {
    id: 'a', get cwd() { return snapshot.cwd; }, get archivedAt() { return snapshot.archivedAt; },
    get status() { return snapshot.status; }, get activeTurn() { return snapshot.activeTurn; },
    get pendingPermissions() { return snapshot.pendingPermissions; }, workspaceId: 'w',
    refresh: vi.fn(async () => ({ agent: snapshot })),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    send: vi.fn(),
    sendIfIdle: vi.fn(async (_text: string, options: { messageId: string }) => {
      entries.push({ item: { type: 'user_message', text: 'request', clientMessageId: options.messageId } });
      snapshot.status = 'running'; snapshot.activeTurn = { id: 'turn' }; for (const fn of listeners) fn();
      for (const fn of streamListeners) fn({ event: { type: 'turn_started', turnId: 'turn', provider: 'codex' } });
      return {status:'accepted' as const,turnId:'turn'};
    }),
    timeline: { subscribe: (fn: (event: any) => void) => { streamListeners.add(fn); return Object.assign(timelineUnsubscribe, { ready: Promise.resolve() }); },
      refetch: vi.fn(async () => ({ entries, error: null, hasOlder: false })) },
    interrupt: vi.fn(async () => { snapshot.status = 'idle'; snapshot.activeTurn = null; for (const fn of listeners) fn(); }),
    archive: vi.fn(async () => { snapshot.archivedAt = 'now'; }),
  };
  const paseo = { agents: { ref: vi.fn(() => agent), create: vi.fn(async () => agent) } } as unknown as Paseo;
  const lane: GroupLane = { agentId: 'a', operationId: 'op', groupId: 'g', roundId: 'r', botId: 'cindy', cwd: snapshot.cwd, title: 'group', config: {}, phase: 'ready' };
  const update = (patch: object) => { snapshot = { ...snapshot, ...patch }; for (const fn of listeners) fn(); };
  const complete = (text = 'final answer') => { entries.push({ turnId: 'turn', item: { type: 'assistant_message', text: 'progress' } }, { turnId: 'turn', item: { type: 'assistant_message', text } }); update({ status: 'idle', activeTurn: null }); for (const fn of streamListeners) fn({ event: { type: 'turn_completed', turnId: 'turn', provider: 'codex' } }); };
  return { driver: new NativeGroupDriver(paseo), lane, agent, entries, update, complete, listeners, timelineUnsubscribe, streamListeners };
}
it('uses an established public timeline observation and binds the final reply to the exact clientMessageId', async () => {
  const f = fake(); const signal = new AbortController();
  const reply = f.driver.reply(f.lane, { prompt: 'question', messageId: 'm1', signal: signal.signal, permission: () => {} });
  await vi.waitFor(() => expect(f.agent.sendIfIdle).toHaveBeenCalled()); f.complete();
  expect(await reply).toBe('final answer'); expect(f.listeners.size).toBe(0); expect(f.timelineUnsubscribe).toHaveBeenCalledOnce();
});
it('does not attribute a reply after an unrelated user input to the accepted group request', async () => {
  const f = fake();
  const reply = f.driver.reply(f.lane, { prompt: 'question', messageId: 'm1', signal: new AbortController().signal, permission: () => {} });
  const rejection = expect(reply).rejects.toMatchObject({ code: 'REPLY_NOT_CONFIRMED' });
  await vi.waitFor(() => expect(f.agent.sendIfIdle).toHaveBeenCalled());
  f.entries.push({ item: { type: 'user_message', clientMessageId: 'foreign', text: 'other user request' } }); f.complete(); await rejection;
});
it('does not mistake the stale idle snapshot after send acknowledgement for turn completion', async () => {
  const f = fake(); let done = false;
  f.agent.sendIfIdle.mockImplementation(async (_text, options) => { f.entries.push({ item: { type: 'user_message', clientMessageId: options.messageId, text: 'request' } }); return{status:'accepted',turnId:'turn'}; });
  const result = f.driver.reply(f.lane, { prompt: 'question', messageId: 'm1', signal: new AbortController().signal, permission: () => {} }).then(value => { done = true; return value; });
  await vi.waitFor(() => expect(f.agent.refresh).toHaveBeenCalledTimes(2));
  expect(done).toBe(false); expect(f.agent.timeline.refetch).not.toHaveBeenCalled();
  for (const fn of f.streamListeners) fn({ event: { type: 'turn_started', turnId: 'turn', provider: 'codex' } });
  f.complete(); expect(await result).toBe('final answer');
});
it('requires the observed turn to complete successfully even when an assistant message and idle snapshot exist', async () => {
  const f = fake();
  const result = f.driver.reply(f.lane, { prompt: 'question', messageId: 'm1', signal: new AbortController().signal, permission: () => {} });
  const rejected = expect(result).rejects.toMatchObject({ code: 'RUNTIME_ERROR' });
  await vi.waitFor(() => expect(f.agent.sendIfIdle).toHaveBeenCalled());
  f.entries.push({ turnId: 'turn', item: { type: 'assistant_message', text: 'partial output' } }); f.update({ status: 'idle', activeTurn: null });
  for (const fn of f.streamListeners) fn({ event: { type: 'turn_failed', turnId: 'turn', provider: 'codex', error: 'native failed' } });
  await rejected;
});
it('keeps the same turn pending during permission and settles after the native response, without dispatching again', async () => {
  const f = fake(); const permission = vi.fn(); let done = false;
  const reply = f.driver.reply(f.lane, { prompt: 'question', messageId: 'm1', signal: new AbortController().signal, permission }).then(value => { done = true; return value; });
  await vi.waitFor(() => expect(f.agent.sendIfIdle).toHaveBeenCalled()); f.update({ pendingPermissions: [{ id: 'p' }] });
  await Promise.resolve(); expect(done).toBe(false); expect(permission).toHaveBeenCalledWith(true);
  f.update({ pendingPermissions: [] }); f.complete(); expect(await reply).toBe('final answer');
  expect(permission).toHaveBeenCalledWith(false); expect(f.agent.sendIfIdle).toHaveBeenCalledOnce();
});
it('cancellation removes listeners and prevents a late completion from returning a result', async () => {
  const f = fake(); const controller = new AbortController();
  const reply = f.driver.reply(f.lane, { prompt: 'question', messageId: 'm1', signal: controller.signal, permission: () => {} });
  const rejection = expect(reply).rejects.toMatchObject({ code: 'GROUP_STOPPED' });
  await vi.waitFor(() => expect(f.agent.sendIfIdle).toHaveBeenCalled()); controller.abort(); await rejection;
  f.complete(); expect(f.listeners.size).toBe(0); expect(f.timelineUnsubscribe).toHaveBeenCalledOnce();
});
it('never uses unguarded interrupt; exact cancellation is bound to the durable owned turn', async () => {
  const f = fake(); f.update({ status: 'running', activeTurn: { turnId: 'human-next' } });
  f.lane.dispatch={messageId:'m',cancelMessageId:'cancel-fixed',phase:'accepted',turnId:'owned'};
  await expect(f.driver.stop(f.lane)).rejects.toMatchObject({code:'GROUP_STOP_REQUIRES_NATIVE'});
  const cancelTurn=vi.fn(async()=>({status:'changed' as const}));Object.assign(f.agent,{cancelTurn});
  await f.driver.stop(f.lane);expect(cancelTurn).toHaveBeenCalledWith({expectedTurnId:'owned',messageId:'cancel-fixed'});
  expect(f.agent.interrupt).not.toHaveBeenCalled();expect(f.agent.archive).not.toHaveBeenCalled();
  await expect(f.driver.archive(f.lane)).rejects.toMatchObject({code:'GROUP_ARCHIVE_REQUIRES_NATIVE'});
  f.update({cwd:'/somebody-else'});await expect(f.driver.stop(f.lane)).rejects.toMatchObject({code:'GROUP_LANE_MISMATCH'});
});
it('requires atomic idle admission for a visible task and never falls back to ordinary send',async()=>{
 const f=fake();Object.assign(f.agent,{sendIfIdle:undefined});await expect(f.driver.reply(f.lane,{prompt:'task',messageId:'new',signal:new AbortController().signal,permission:()=>{},requireIdleAdmission:true})).rejects.toMatchObject({code:'HOST_UPGRADE_REQUIRED'});expect(f.agent.send).not.toHaveBeenCalled();
 const busy=vi.fn(async()=>({status:'busy' as const}));Object.assign(f.agent,{sendIfIdle:busy});
 await expect(f.driver.reply(f.lane,{prompt:'task',messageId:'other',signal:new AbortController().signal,permission:()=>{},requireIdleAdmission:true})).rejects.toMatchObject({code:'TASK_BUSY'});expect(f.agent.send).not.toHaveBeenCalled();expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it('binds atomic accepted receipt to the completed native turn',async()=>{
 const f=fake();const sendIfIdle=vi.fn(async(_text:string,options:{messageId:string})=>{f.entries.push({item:{type:'user_message',clientMessageId:options.messageId,text:'task'}});for(const fn of f.streamListeners)fn({event:{type:'turn_started',turnId:'turn',provider:'codex'}});return{status:'accepted' as const,turnId:'turn'};});Object.assign(f.agent,{sendIfIdle});
 const reply=f.driver.reply(f.lane,{prompt:'task',messageId:'new',signal:new AbortController().signal,permission:()=>{},requireIdleAdmission:true});await vi.waitFor(()=>expect(sendIfIdle).toHaveBeenCalledOnce());f.complete();expect(await reply).toBe('final answer');expect(f.agent.send).not.toHaveBeenCalled();
});
it('separates a pre-dispatch feature rejection from a lost atomic-send acknowledgement',async()=>{
 const f=fake(),sendIfIdle=vi.fn().mockRejectedValueOnce(Object.assign(new Error('unsupported'),{code:'unsupported_capability'})).mockRejectedValueOnce(new Error('agent_request_outcome_unknown'));
 Object.assign(f.agent,{sendIfIdle});const input={prompt:'task',messageId:'stable-id',signal:new AbortController().signal,permission:()=>{},requireIdleAdmission:true};
 const unsupported=await f.driver.reply(f.lane,input).catch(error=>error);expect(unsupported.code).toBe('unsupported_capability');expect(unsupported.dispatchOutcome).toBeUndefined();
 await expect(f.driver.reply(f.lane,input)).rejects.toMatchObject({message:'agent_request_outcome_unknown',dispatchOutcome:'unknown'});
 expect(f.agent.send).not.toHaveBeenCalled();expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it('rejects a user turn that starts after the idle snapshot without steering or stopping it',async()=>{
 const f=fake();const saved:any[]=[];
 f.agent.sendIfIdle.mockImplementation(async()=>{f.update({status:'running',activeTurn:{turnId:'human'}});return{status:'busy'} as never;});
 await expect(f.driver.reply(f.lane,{prompt:'group',messageId:'race',signal:new AbortController().signal,permission:()=>{},recordDispatch:async receipt=>{saved.push(structuredClone(receipt));}})).rejects.toMatchObject({code:'GROUP_LANE_BUSY'});
 expect(saved.map(r=>r.phase)).toEqual(['dispatching','not-sent']);await f.driver.stop(f.lane);
 expect(f.agent.activeTurn).toEqual({turnId:'human'});expect(f.agent.send).not.toHaveBeenCalled();expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it('keeps provider unavailability as definitely not sent and never mistakes it for a successful receipt',async()=>{
 const f=fake();f.agent.sendIfIdle.mockResolvedValue({status:'unavailable'} as never);
 await expect(f.driver.reply(f.lane,{prompt:'group',messageId:'provider',signal:new AbortController().signal,permission:()=>{}})).rejects.toMatchObject({code:'PROVIDER_ADMISSION_UNAVAILABLE'});
 expect(f.lane.dispatch).toMatchObject({phase:'not-sent',code:'PROVIDER_ADMISSION_UNAVAILABLE'});
 f.update({status:'running',activeTurn:{turnId:'human'}});await f.driver.stop(f.lane);expect(f.agent.interrupt).not.toHaveBeenCalled();expect(f.agent.send).not.toHaveBeenCalled();
});
it('persists dispatch intent before sending and can safely abort while that write is pending',async()=>{
 const f=fake(),controller=new AbortController();let release!:()=>void;const blocked=new Promise<void>(yes=>release=yes);let entered=false;
 const reply=f.driver.reply(f.lane,{prompt:'group',messageId:'write-first',signal:controller.signal,permission:()=>{},recordDispatch:async receipt=>{if(receipt.phase==='dispatching'){entered=true;await blocked;}}});
 const rejection=expect(reply).rejects.toMatchObject({code:'GROUP_STOPPED'});await vi.waitFor(()=>expect(entered).toBe(true));expect(f.agent.sendIfIdle).not.toHaveBeenCalled();controller.abort();release();await rejection;
 expect(f.lane.dispatch?.phase).toBe('not-sent');await f.driver.stop(f.lane);expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it('retains unknown send acknowledgements across a serialized restart even if the native agent looks idle',async()=>{
 const f=fake();f.agent.sendIfIdle.mockRejectedValue(new Error('lost acknowledgement'));
 await expect(f.driver.reply(f.lane,{prompt:'group',messageId:'unknown',signal:new AbortController().signal,permission:()=>{}})).rejects.toMatchObject({dispatchOutcome:'unknown'});
 const reopened=JSON.parse(JSON.stringify(f.lane)) as GroupLane;
 await expect(f.driver.stop(reopened)).rejects.toMatchObject({code:'ADMISSION_OUTCOME_UNKNOWN'});
 await expect(f.driver.reply(reopened,{prompt:'group',messageId:'unknown',signal:new AbortController().signal,permission:()=>{}})).rejects.toMatchObject({code:'ADMISSION_OUTCOME_UNKNOWN'});
 expect(f.agent.sendIfIdle).toHaveBeenCalledTimes(1);expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it('does not cancel a later human turn when history attribution fails after the owned terminal event',async()=>{
 const f=fake();const reply=f.driver.reply(f.lane,{prompt:'group',messageId:'own',signal:new AbortController().signal,permission:()=>{}});const rejected=expect(reply).rejects.toMatchObject({code:'REPLY_NOT_CONFIRMED'});
 await vi.waitFor(()=>expect(f.agent.sendIfIdle).toHaveBeenCalled());
 f.agent.timeline.refetch.mockImplementation(async()=>{f.entries.push({item:{type:'user_message',clientMessageId:'human-new',text:'Human input'}});f.update({status:'running',activeTurn:{turnId:'human-new'}});return{entries:f.entries,error:null,hasOlder:false};});
 f.complete();await rejected;expect(f.lane.dispatch).toMatchObject({phase:'completed',turnId:'turn'});await f.driver.stop(f.lane);
 expect(f.agent.interrupt).not.toHaveBeenCalled();expect(f.agent.activeTurn).toEqual({turnId:'human-new'});
});
it('reuses the cancellation operation after a lost acknowledgement and never falls back to interrupt',async()=>{
 const f=fake();f.lane.dispatch={messageId:'request',cancelMessageId:'cancel-stable',phase:'accepted',turnId:'owned'};f.update({status:'running',activeTurn:{turnId:'human'}});
 const cancelTurn=vi.fn().mockRejectedValueOnce(new Error('lost cancel ACK')).mockResolvedValue({status:'changed'});Object.assign(f.agent,{cancelTurn});
 await expect(f.driver.stop(f.lane)).rejects.toThrow('lost cancel ACK');await f.driver.stop(JSON.parse(JSON.stringify(f.lane)));
 expect(cancelTurn.mock.calls.map(call=>call[0])).toEqual([{expectedTurnId:'owned',messageId:'cancel-stable'},{expectedTurnId:'owned',messageId:'cancel-stable'}]);expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it('never archives from an idle snapshot and only reconciles a real native archive',async()=>{
 const f=fake();f.lane.dispatch={messageId:'done',cancelMessageId:'cancel',phase:'completed',turnId:'owned'};
 await expect(f.driver.archive(f.lane)).rejects.toMatchObject({code:'GROUP_ARCHIVE_REQUIRES_NATIVE'});expect(f.agent.archive).not.toHaveBeenCalled();
 f.update({archivedAt:'native-archive'});await f.driver.archive(f.lane);expect(f.agent.archive).not.toHaveBeenCalled();expect(f.agent.interrupt).not.toHaveBeenCalled();
});
it('keeps missing creation uncertain during cleanup even when its prompt was never dispatched',async()=>{
 const f=fake();f.lane.phase='creating';f.lane.dispatch={messageId:'not-sent',cancelMessageId:'cancel',phase:'prepared'};f.agent.refresh.mockResolvedValue(null as never);
 await f.driver.stop(f.lane);await expect(f.driver.archive(f.lane)).rejects.toMatchObject({code:'CLEANUP_NOT_CONFIRMED'});expect(f.agent.archive).not.toHaveBeenCalled();
 f.lane.phase='ready';await f.driver.archive(f.lane);expect(f.agent.archive).not.toHaveBeenCalled();
});
