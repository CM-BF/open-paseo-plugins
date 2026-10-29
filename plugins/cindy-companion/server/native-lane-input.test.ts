import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  NativeLaneInput, prepareNativeLaneInput, type NativeCreationReceipt, type NativeInputAgent,
  type NativeLaneInputIntent, type NativeLaneInputRecord, type NativeLanePublicApi,
  type NativeTimelineEntry, type NativeTurnReceipt, type QueuedInputCancelReceipt, type QueuedInputReceipt,
} from './native-lane-input';

type CancelWithoutOperation = { [S in QueuedInputCancelReceipt['status']]: Omit<Extract<QueuedInputCancelReceipt,{status:S}>, 'operationId'> }[QueuedInputCancelReceipt['status']];
const identity = { agentId: 'owned-agent', clientMessageId: 'owned-input' };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function intent(admission: 'initial' | 'queue' = 'queue'): NativeLaneInputIntent {
  return { agentId: identity.agentId, messageId: identity.clientMessageId, admission, input: { text: 'Continue the same conversation' },
    ...(admission === 'initial' ? { creation: { idempotencyKey: 'immutable-create-key', cwd: '/owned/plan-workdir',
      config: { provider: 'codex/test', systemPrompt: 'original personality' }, title: 'Same lane', background: true } } : {}) };
}
function host() {
  let queueReceipt: QueuedInputReceipt = { ...identity, status: 'queued', queueId: 'native-queue-item' };
  let turnReceipt: NativeTurnReceipt = { ...identity, turnId: 'owned-turn', status: 'unknown' };
  let creation: NativeCreationReceipt | null = { kind: 'agent', idempotencyKey: 'immutable-create-key', agentId: identity.agentId,
    workspaceId: 'same-workspace', phase: 'completed', initialPrompt: { status: 'accepted', clientMessageId: identity.clientMessageId, turnId: 'owned-turn' } };
  let cancellation: QueuedInputCancelReceipt = { ...identity, operationId: 'cancel-fixed', status: 'cancelled', queueId: 'native-queue-item' };
  let cancellationRead: QueuedInputCancelReceipt = { ...identity, operationId: 'cancel-fixed', status: 'unknown' };
  let entries: NativeTimelineEntry[] = [];
  const agent = {
    inputs: { enqueue: vi.fn(async () => queueReceipt), get: vi.fn(async () => queueReceipt), cancel: vi.fn(async (input: { messageId: string; operationId: string }) => ({ ...cancellation, operationId: input.operationId })),
      getCancellation: vi.fn(async () => cancellationRead) },
    turns: { get: vi.fn(async () => turnReceipt) },
    timeline: { refetch: vi.fn(async () => ({ entries, hasOlder: false, error: null })) },
  } satisfies NativeInputAgent;
  const api = {
    agents: { supportsInitialPromptReservation: vi.fn(() => true), supportsTurnReceipts: vi.fn(() => true),
      supportsQueuedInputs: vi.fn(() => true), supportsInitialPromptImages: vi.fn(() => false),
      create: vi.fn(async () => agent), ref: vi.fn(() => agent) },
    creations: { get: vi.fn(async () => creation) },
  } satisfies NativeLanePublicApi;
  return { api, agent, queue(value: QueuedInputReceipt) { queueReceipt = value; }, turn(value: NativeTurnReceipt) { turnReceipt = value; },
    creation(value: NativeCreationReceipt | null) { creation = value; }, cancel(value: CancelWithoutOperation) { cancellation = { ...value, operationId: 'cancel-fixed' } as QueuedInputCancelReceipt; },
    cancellation(value: QueuedInputCancelReceipt) { cancellationRead = value; },
    timeline(value: NativeTimelineEntry[]) { entries = value; } };
}
async function journal(input = intent()) {
  const directory = await mkdtemp(join(tmpdir(), 'cindy-native-input-')); dirs.push(directory);
  const path = join(directory, 'input.json');
  const save = vi.fn(async (record: NativeLaneInputRecord) => {
    await writeFile(`${path}.tmp`, JSON.stringify(record)); await rename(`${path}.tmp`, path);
  });
  const read = async () => JSON.parse(await readFile(path, 'utf8')) as NativeLaneInputRecord;
  const prepared = prepareNativeLaneInput(input); await save(prepared); save.mockClear();
  return { path, save, read, open: async (api: NativeLanePublicApi) => new NativeLaneInput(api, await read(), save) };
}
const complete = (): NativeTurnReceipt => ({ ...identity, turnId: 'owned-turn', status: 'completed', observedAt: '2026-10-29T01:00:00.000Z' });

it('persists the whole first input before create and recovers lost ACK from creation receipt after actual fs reopen', async () => {
  const h = host(), j = await journal(intent('initial'));
  h.api.agents.create.mockImplementation(async () => {
    expect(await j.read()).toMatchObject({ phase: 'dispatching', intent: { input: { text: 'Continue the same conversation' }, creation: { config: { systemPrompt: 'original personality' } } } });
    throw new Error('create ACK lost');
  });
  expect(await (await j.open(h.api)).admit()).toMatchObject({ phase: 'started', turnId: 'owned-turn', workspaceId: 'same-workspace' });
  expect(h.api.agents.create).toHaveBeenCalledWith({ agentId: identity.agentId, idempotencyKey: 'immutable-create-key',
    cwd: '/owned/plan-workdir', config: { provider: 'codex/test', systemPrompt: 'original personality' },
    title: 'Same lane', background: true, prompt: 'Continue the same conversation', clientMessageId: identity.clientMessageId,
    requireInitialPromptReservation: true });
  await (await j.open(h.api)).admit();
  expect(h.api.agents.create).toHaveBeenCalledOnce(); expect(h.agent.inputs.enqueue).not.toHaveBeenCalled();
  expect(h.api.creations.get).toHaveBeenCalledWith({ kind: 'agent', idempotencyKey: 'immutable-create-key' });
});

it.each(['missing', 'pending', 'out_of_band'] as const)('does not equate completed creation with prompt admission (%s)', async kind => {
  const h = host(), j = await journal(intent('initial'));
  h.creation({ kind: 'agent', idempotencyKey: 'immutable-create-key', agentId: identity.agentId, workspaceId: 'w', phase: 'completed',
    ...(kind === 'missing' ? {} : { initialPrompt: { status: kind, clientMessageId: identity.clientMessageId } }) });
  const input = await j.open(h.api);
  expect((await input.admit()).phase).toBe('unknown'); await input.reconcile();
  expect(h.agent.turns.get).not.toHaveBeenCalled(); expect(h.agent.inputs.enqueue).not.toHaveBeenCalled(); expect(h.api.agents.create).toHaveBeenCalledOnce();
});

it('queues once across concurrent admission and fs reopen, without treating queued as a started turn', async () => {
  const h = host(), j = await journal(), input = await j.open(h.api);
  const values = await Promise.all([input.admit(), input.admit()]);
  expect(values.every(value => value.phase === 'queued' && !value.turnId)).toBe(true);
  expect(h.agent.inputs.enqueue).toHaveBeenCalledOnce(); expect(h.agent.turns.get).not.toHaveBeenCalled();
  await (await j.open(h.api)).admit(); expect(h.agent.inputs.enqueue).toHaveBeenCalledOnce();
  expect(h.agent.inputs.get).toHaveBeenCalledWith({ messageId: identity.clientMessageId });
});

it('keeps unknown admission after lost enqueue ACK, then reads the real queued and started identities without replay', async () => {
  const h = host(), j = await journal();
  h.agent.inputs.enqueue.mockRejectedValue(new Error('transport disconnected'));
  h.queue({ ...identity, status: 'unknown' });
  expect((await (await j.open(h.api)).admit()).phase).toBe('unknown');
  await (await j.open(h.api)).admit(); expect(h.agent.inputs.enqueue).toHaveBeenCalledOnce();
  h.queue({ ...identity, status: 'queued', queueId: 'real-queue-id' });
  expect(await (await j.open(h.api)).reconcile()).toMatchObject({ phase: 'queued', queueId: 'real-queue-id' });
  h.queue({ ...identity, status: 'started', queueId: 'real-queue-id', turnId: 'owned-turn' });
  h.turn(complete());
  expect(await (await j.open(h.api)).reconcile()).toMatchObject({ phase: 'completed', queueId: 'real-queue-id', turnId: 'owned-turn' });
  expect(h.agent.inputs.enqueue).toHaveBeenCalledOnce(); expect(h.api.agents.create).not.toHaveBeenCalled();
});

it('reads only the completed owned reply even after a human successor and unrelated reply exist', async () => {
  const h = host(), j = await journal();
  h.queue({ ...identity, status: 'started', turnId: 'owned-turn' }); h.turn(complete());
  h.timeline([
    { turnId: 'owned-turn', item: { type: 'user_message', clientMessageId: identity.clientMessageId, text: 'original request' } },
    { turnId: 'owned-turn', item: { type: 'assistant_message', text: 'owned progress' } },
    { turnId: 'owned-turn', item: { type: 'assistant_message', text: 'owned final' } },
    { turnId: 'later-human-turn', item: { type: 'user_message', clientMessageId: 'human', text: 'private follow-up' } },
    { turnId: 'later-human-turn', item: { type: 'assistant_message', text: 'must not be published to the group' } },
  ]);
  const input = await j.open(h.api); await input.admit(); expect(await input.readReply()).toBe('owned final');
  expect(h.agent.timeline.refetch).toHaveBeenCalledWith({limit:200,projection:'projected'});
});

it('requires durable turn evidence even when the queue summary and visible final text say completed', async () => {
  const h = host(), j = await journal();
  h.queue({ ...identity, status: 'terminal', outcome: 'completed', turnId: 'owned-turn' });
  h.turn({ ...identity, clientMessageId: null, status: 'unknown', turnId: 'owned-turn' });
  const input = await j.open(h.api); expect((await input.admit()).phase).toBe('started');
  await expect(input.readReply()).rejects.toMatchObject({ code: 'REPLY_NOT_CONFIRMED' });
  await (await j.open(h.api)).admit(); expect(h.agent.inputs.enqueue).toHaveBeenCalledOnce();
});

it('rejects another client identity or an ambiguous second native turn for the same input', async () => {
  const h = host(), j = await journal();
  h.queue({ ...identity, status: 'started', turnId: 'owned-turn' });
  const input = await j.open(h.api); await input.admit();
  h.queue({ ...identity, status: 'started', turnId: 'different-turn' });
  await expect(input.reconcile()).rejects.toMatchObject({ code: 'NATIVE_INPUT_RECEIPT_MISMATCH' });
  h.queue({ ...identity, status: 'started', turnId: 'owned-turn' }); h.turn({ ...complete(), clientMessageId: 'other-input' });
  await expect(input.reconcile()).rejects.toMatchObject({ code: 'NATIVE_INPUT_RECEIPT_MISMATCH' });
  expect(input.current().phase).toBe('started');
});

it('forwards exact native image bytes and refuses unsupported files without changing the prompt into a text fallback', async () => {
  const h = host(), image = { data: 'AQIDBA==', mimeType: 'image/png' };
  const withImage = intent(); withImage.input.images = [image];
  const j = await journal(withImage); await (await j.open(h.api)).admit();
  expect(h.agent.inputs.enqueue).toHaveBeenCalledWith(withImage.input, { messageId: identity.clientMessageId });
  expect((await j.read()).intent.input.images).toEqual([image]);
  const fileHost = host(), withFile = intent();
  withFile.input.attachments = [{ type: 'uploaded_file', id: 'file', fileName: 'file.pdf', size: 10, path: '/owned/file.pdf', mimeType: 'application/pdf' }];
  const files = await journal(withFile);
  expect(await (await files.open(fileHost.api)).admit()).toMatchObject({ phase: 'not-sent', code: 'ATTACHMENT_INPUT_UNAVAILABLE', intent: { input: { attachments: withFile.input.attachments } } });
  expect(fileHost.agent.inputs.enqueue).not.toHaveBeenCalled(); expect(fileHost.api.agents.create).not.toHaveBeenCalled();
});

it('does not mistake the existing first-prompt reservation for strict image support', async () => {
  const h = host(), input = intent('initial'); input.input.images = [{ data: 'AQIDBA==', mimeType: 'image/png' }];
  const j = await journal(input);
  expect(await (await j.open(h.api)).admit()).toMatchObject({ phase: 'not-sent', code: 'ATTACHMENT_INPUT_UNAVAILABLE' });
  expect(h.api.agents.create).not.toHaveBeenCalled();
  expect(() => prepareNativeLaneInput({ ...intent(), input: { text: 'image', images: [{ data: 'not base64', mimeType: 'image/png' }] } })).toThrow();
});

it('preserves image bytes in the first immutable creation only when the host explicitly guarantees strict images', async () => {
  const h = host(), input = intent('initial'); input.input.images = [{ data: 'AQIDBA==', mimeType: 'image/png' }];
  h.api.agents.supportsInitialPromptImages.mockReturnValue(true);
  const j = await journal(input); await (await j.open(h.api)).admit();
  expect(h.api.agents.create).toHaveBeenCalledWith(expect.objectContaining({ prompt: input.input.text, images: input.input.images }));
  expect(h.agent.inputs.enqueue).not.toHaveBeenCalled();
});

it('fails before dispatch when the connected capability is missing or the SDK has no new methods', async () => {
  const h = host(), j = await journal(); h.api.agents.supportsQueuedInputs.mockReturnValue(false);
  expect(await (await j.open(h.api)).admit()).toMatchObject({ phase: 'not-sent', code: 'HOST_UPGRADE_REQUIRED' });
  expect(h.agent.inputs.enqueue).not.toHaveBeenCalled();
  const initial = await journal(intent('initial'));
  const old = { ...h.api, agents: { ...h.api.agents, supportsInitialPromptReservation: undefined } };
  expect(await (await initial.open(old)).admit()).toMatchObject({ phase: 'not-sent' }); expect(h.api.agents.create).not.toHaveBeenCalled();
});

it('never invokes the provider when writing dispatching fails', async () => {
  const h = host(), j = await journal();
  const input = new NativeLaneInput(h.api, await j.read(), async () => { throw new Error('disk unavailable'); });
  await expect(input.admit()).rejects.toThrow('disk unavailable'); expect(h.agent.inputs.enqueue).not.toHaveBeenCalled();
  expect((await j.read()).phase).toBe('prepared');
});

it('recovers a settlement disk failure from the saved dispatching record without enqueueing again', async () => {
  const h = host(), j = await journal();
  const input = new NativeLaneInput(h.api, await j.read(), async record => {
    if (record.phase === 'queued') throw new Error('settlement disk failure');
    await j.save(record);
  });
  await expect(input.admit()).rejects.toThrow('settlement disk failure'); expect((await j.read()).phase).toBe('dispatching');
  expect((await (await j.open(h.api)).admit()).phase).toBe('queued'); expect(h.agent.inputs.enqueue).toHaveBeenCalledOnce();
});

it('withdraws only the addressed pending input and replays lost cancellation ACK by reading, not another delete', async () => {
  const h = host(), j = await journal(), input = await j.open(h.api); await input.admit();
  h.agent.inputs.cancel.mockRejectedValueOnce(new Error('cancel ACK lost'));
  h.queue({ ...identity, status: 'unknown', queueId: 'native-queue-item' });
  expect(await input.cancel('cancel-fixed')).toMatchObject({ phase: 'unknown', cancellation: { operationId: 'cancel-fixed', phase: 'unknown' } });
  h.queue({ ...identity, status: 'cancelled', queueId: 'native-queue-item' });
  expect((await (await j.open(h.api)).cancel('cancel-fixed')).phase).toBe('cancelled');
  expect(h.agent.inputs.cancel).toHaveBeenCalledOnce(); expect(h.agent.inputs.cancel).toHaveBeenCalledWith({ messageId: identity.clientMessageId, operationId: 'cancel-fixed' });
});

it.each([false,true])('keeps a removed row unknown across fs reopen and observes its real turn without another add/delete (lost ACK: %s)',async lostAck=>{
  const h=host(),j=await journal(),input=await j.open(h.api);await input.admit();
  const removed:QueuedInputCancelReceipt={...identity,operationId:'cancel-fixed',status:'unknown',queueId:'native-queue-item',code:'QUEUE_ITEM_REMOVED'};
  h.cancel(removed);h.cancellation(removed);h.queue({...identity,status:'unknown',queueId:'native-queue-item',code:'INPUT_NOT_OBSERVED'});
  if(lostAck)h.agent.inputs.cancel.mockRejectedValueOnce(new Error('delete ACK lost'));
  expect(await input.cancel('cancel-fixed')).toMatchObject({phase:'unknown',cancellation:{phase:'unknown',code:'QUEUE_ITEM_REMOVED'}});
  expect(await j.read()).toMatchObject({phase:'unknown',cancellation:{phase:'unknown',code:'QUEUE_ITEM_REMOVED'}});
  const restored=await j.open(h.api);
  expect((await restored.cancel('cancel-fixed')).phase).toBe('unknown');
  h.queue({...identity,status:'started',queueId:'native-queue-item',turnId:'owned-turn'});
  expect(await restored.reconcile()).toMatchObject({phase:'started',turnId:'owned-turn'});
  h.turn(complete());
  expect((await(await j.open(h.api)).reconcile()).phase).toBe('completed');
  expect(h.agent.inputs.enqueue).toHaveBeenCalledOnce();expect(h.agent.inputs.cancel).toHaveBeenCalledOnce();
  expect(h.agent.inputs.getCancellation).toHaveBeenCalledWith({messageId:identity.clientMessageId,operationId:'cancel-fixed'});
  expect(h.agent.inputs.get).toHaveBeenCalledWith({messageId:identity.clientMessageId});
});

it('does not call a failed withdrawal not-sent input, nor interrupt a started/human successor turn', async () => {
  const h = host(), j = await journal(), input = await j.open(h.api); await input.admit();
  h.cancel({ ...identity, status: 'not_sent', code: 'cancel_unavailable' });
  expect(await input.cancel('cancel-fixed')).toMatchObject({ phase: 'queued', cancellation: { phase: 'not-sent' } });
  await input.cancel('cancel-fixed'); expect(h.agent.inputs.cancel).toHaveBeenCalledOnce();
  h.cancel({ ...identity, status: 'cancelled', queueId: 'native-queue-item' });
  expect((await input.cancel('explicit-new-cancel')).phase).toBe('cancelled'); expect(h.agent.inputs.cancel).toHaveBeenCalledTimes(2);
  const startedHost = host(), startedJournal = await journal(), started = await startedJournal.open(startedHost.api); await started.admit();
  startedHost.cancel({ ...identity, status: 'started', turnId: 'owned-turn' });
  expect(await started.cancel('stop-owned')).toMatchObject({ phase: 'started', turnId: 'owned-turn', cancellation: { phase: 'started' } });
  // The boundary has no ordinary interrupt/stop method: the owning service handles exact-turn cancellation separately.
});

it('rejects changed persisted prompt/config under the same immutable intent fingerprint', async () => {
  const h = host(), j = await journal(intent('initial')), saved = await j.read();
  saved.intent.creation!.config.systemPrompt = 'changed after ACK loss';
  expect(() => new NativeLaneInput(h.api, saved, j.save)).toThrow('original intent'); expect(h.api.agents.create).not.toHaveBeenCalled();
});

it('recovers a rejected cancellation ACK using its exact durable read without relabelling or deleting the input', async () => {
  const h = host(), j = await journal(), input = await j.open(h.api); await input.admit();
  h.agent.inputs.cancel.mockRejectedValueOnce(new Error('rejection ACK lost'));
  h.cancellation({ ...identity, operationId: 'cancel-fixed', status: 'not_sent', code: 'RUNTIME_UNAVAILABLE' });
  expect(await input.cancel('cancel-fixed')).toMatchObject({ phase: 'queued', cancellation: { operationId: 'cancel-fixed', phase: 'not-sent', code: 'RUNTIME_UNAVAILABLE' } });
  const restored = await j.open(h.api); await restored.cancel('cancel-fixed');
  expect(h.agent.inputs.cancel).toHaveBeenCalledOnce();
  expect(h.agent.inputs.getCancellation).toHaveBeenCalledWith({ messageId: identity.clientMessageId, operationId: 'cancel-fixed' });
  expect(h.agent.inputs.enqueue).toHaveBeenCalledOnce();
});

it('rejects a cancellation receipt with a different operation identity', async () => {
  const h = host(), j = await journal(), input = await j.open(h.api); await input.admit();
  h.agent.inputs.cancel.mockRejectedValueOnce(new Error('lost ACK'));
  h.cancellation({ ...identity, operationId: 'someone-else', status: 'cancelled', queueId: 'native-queue-item' });
  await expect(input.cancel('cancel-fixed')).rejects.toMatchObject({ code: 'NATIVE_INPUT_RECEIPT_MISMATCH' });
  expect(h.agent.inputs.cancel).toHaveBeenCalledOnce();
});
it('keeps a definitely unsupported cancellation separate from the already queued original input',async()=>{
 const h=host(),j=await journal(),input=await j.open(h.api);await input.admit();
 h.agent.inputs.cancel.mockRejectedValueOnce(Object.assign(new Error('Connection capability changed'),{code:'unsupported_capability'}));
 expect(await input.cancel('cancel-fixed')).toMatchObject({phase:'queued',cancellation:{operationId:'cancel-fixed',phase:'not-sent',code:'HOST_UPGRADE_REQUIRED'}});
 await(await j.open(h.api)).cancel('cancel-fixed');expect(h.agent.inputs.cancel).toHaveBeenCalledOnce();expect(h.agent.inputs.enqueue).toHaveBeenCalledOnce();
});
