import { createHash } from 'node:crypto';
import type { PaseoAgentCreateOptions } from '@getpaseo/client';

/** Structural copy of the public AgentQueuedInput/Receipt/Cancellation contract in
 * Paseo packages/protocol/src/messages.ts. Queue methods are not in SDK 0.13.2;
 * do not import unpublished types or treat method presence as a negotiated feature.
 * This adapter never implements a provider queue and has no send/steer/interrupt fallback.
 * The owning group/task service must serialize this object with its durable lane journal.
 */
export interface NativeInput {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  /** Reserved public attachment envelope. Unsupported kinds are rejected, never rendered as text. */
  attachments?: PaseoAgentCreateOptions['attachments'];
}
type InputIdentity = { agentId: string; clientMessageId: string };
export type QueuedInputReceipt = InputIdentity & (
  | { status: 'queued'; queueId: string }
  | { status: 'started'; turnId: string; queueId?: string }
  | { status: 'terminal'; turnId: string; outcome: 'completed' | 'failed' | 'cancelled'; queueId?: string }
  | { status: 'cancelled'; queueId: string }
  | { status: 'not_sent'; code: string }
  | { status: 'unknown'; queueId?: string; turnId?: string; code?: string }
);
export type QueuedInputCancelReceipt = InputIdentity & { operationId: string } & (
  | { status: 'cancelled'; queueId: string }
  | { status: 'started'; turnId: string; queueId?: string }
  | { status: 'not_sent'; code: string }
  | { status: 'unknown'; queueId?: string; turnId?: string; code?: string }
);
export type NativeTurnReceipt = { agentId: string; clientMessageId: string | null; turnId: string } & (
  | { status: 'unknown' }
  | { status: 'completed' | 'failed' | 'cancelled'; observedAt: string }
);
export interface NativeCreationReceipt {
  kind: 'agent' | 'workspace'; idempotencyKey: string; agentId: string | null; workspaceId: string | null;
  phase: string;
  initialPrompt?: { clientMessageId: string } & (
    | { status: 'pending' | 'out_of_band' }
    | { status: 'accepted'; turnId: string }
    | { status: 'not_sent'; error: string }
    | { status: 'unknown'; error?: string }
  );
}
export interface NativeTimelineEntry {
  turnId?: string;
  item: { type: string; text?: string; clientMessageId?: string; messageId?: string };
}
export interface NativeTimelinePage {
  entries: NativeTimelineEntry[]; error?: string | null; hasOlder: boolean; startCursor?: unknown;
}
export interface NativeCreationOptions {
  agentId: string; idempotencyKey: string; config: Record<string, unknown>; cwd: string;
  title?: string; background?: boolean; parent?: string; labels?: Record<string, string>;
  prompt: string; clientMessageId: string; requireInitialPromptReservation: true;
  images?: NativeInput['images']; attachments?: NativeInput['attachments'];
}
export interface NativeInputAgent {
  inputs?: {
    /** Native queue/add once per durable message identity; no ordinary send or steer. */
    enqueue(input: NativeInput, options: { messageId: string }): Promise<QueuedInputReceipt>;
    /** Journal/native read only. Must not load/resume a provider or dispatch a pending input. */
    get(input: { messageId: string }): Promise<QueuedInputReceipt>;
    cancel(input: { messageId: string; operationId: string }): Promise<QueuedInputCancelReceipt>;
    /** Durable read only, including a lost rejection ACK; never calls native queue/delete. */
    getCancellation(input: { messageId: string; operationId: string }): Promise<QueuedInputCancelReceipt>;
  };
  turns?: { get(input: { turnId: string }): Promise<NativeTurnReceipt> };
  timeline: { refetch(input: { limit: number; projection: 'projected'; cursor?: unknown; direction?: 'before' }): Promise<NativeTimelinePage> };
}
export interface NativeLanePublicApi {
  agents: {
    supportsInitialPromptReservation?: () => boolean;
    supportsTurnReceipts?: () => boolean;
    supportsQueuedInputs?: () => boolean;
    /** Future positive gate: existing reservation alone does not prohibit image-to-text fallback. */
    supportsInitialPromptImages?: () => boolean;
    create(input: NativeCreationOptions): Promise<unknown>;
    ref(agentId: string): NativeInputAgent;
  };
  creations?: { get(input: { kind: 'agent'; idempotencyKey: string }): Promise<NativeCreationReceipt | null> };
}
export interface NativeLaneInputIntent {
  agentId: string; messageId: string; input: NativeInput;
  admission: 'initial' | 'queue';
  /** Exact original create payload, frozen before any native request. No live config rebuild on replay. */
  creation?: Omit<NativeCreationOptions, 'agentId' | 'prompt' | 'clientMessageId' | 'requireInitialPromptReservation' | 'images' | 'attachments'>;
}
export type NativeLaneInputPhase = 'prepared' | 'dispatching' | 'queued' | 'started' | 'completed' | 'failed' | 'cancelled' | 'not-sent' | 'unknown';
export interface NativeLaneInputRecord {
  version: 1; intent: NativeLaneInputIntent; fingerprint: string; phase: NativeLaneInputPhase;
  queueId?: string; turnId?: string; workspaceId?: string; code?: string;
  /** Resource creation completed independently of whether its first prompt was accepted. */
  creationComplete?: boolean;
  cancellation?: { operationId: string; phase: 'dispatching' | 'cancelled' | 'started' | 'unknown' | 'not-sent'; code?: string };
}
export class NativeLaneInputError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const terminal = (phase: NativeLaneInputPhase) => ['completed', 'failed', 'cancelled', 'not-sent'].includes(phase);
const fail = (code: string, message: string): never => { throw new NativeLaneInputError(code, message); };
function fingerprint(intent: NativeLaneInputIntent): string {
  return createHash('sha256').update(JSON.stringify(intent, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex');
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function validateInput(input: NativeInput): void {
  if (!input || typeof input.text !== 'string' || (!input.text.trim() && !input.images?.length && !input.attachments?.length))
    fail('NATIVE_INPUT_INVALID', 'A native input must contain text or an attachment');
  for (const image of input.images ?? []) {
    if (!image || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)
      || typeof image.data !== 'string' || !image.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
      || Buffer.from(image.data, 'base64').toString('base64') !== image.data)
      fail('NATIVE_INPUT_INVALID', 'The image must have an explicit supported MIME type and canonical base64 bytes');
  }
}
/** Construct and persist this record before calling admit(). No work starts in the constructor. */
export function prepareNativeLaneInput(intent: NativeLaneInputIntent): NativeLaneInputRecord {
  if (!validId(intent.agentId) || !validId(intent.messageId) || !['initial', 'queue'].includes(intent.admission)
    || (intent.admission === 'initial' && (!intent.creation || !validId(intent.creation.idempotencyKey)))
    || (intent.admission === 'queue' && intent.creation))
    fail('NATIVE_INPUT_INVALID', 'The native input has no immutable creation or queue identity');
  validateInput(intent.input);
  return { version: 1, intent: structuredClone(intent), fingerprint: fingerprint(intent), phase: 'prepared' };
}

/** One immutable attempt; recovery only reads public receipts. No timers/background jobs. */
export class NativeLaneInput {
  private record: NativeLaneInputRecord;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly api: NativeLanePublicApi, record: NativeLaneInputRecord,
    private readonly persist: (record: NativeLaneInputRecord) => Promise<void>) {
    if (record.version !== 1 || record.fingerprint !== fingerprint(record.intent))
      fail('NATIVE_INPUT_INTENT_CHANGED', 'The persisted native input no longer matches its original intent');
    validateInput(record.intent.input);
    this.record = structuredClone(record);
  }
  current(): NativeLaneInputRecord { return structuredClone(this.record); }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(run); this.tail = next; return next;
  }
  private async save(patch: Partial<NativeLaneInputRecord>): Promise<void> {
    const next = { ...this.record, ...patch };
    await this.persist(structuredClone(next)); // Fail closed before dispatch; don't invent a successful local ACK.
    this.record = next;
  }
  private agent(): NativeInputAgent { return this.api.agents.ref(this.record.intent.agentId); }
  private identity(value: InputIdentity): void {
    if (value.agentId !== this.record.intent.agentId || value.clientMessageId !== this.record.intent.messageId)
      fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'The native receipt belongs to another input');
  }
  admit(signal?: AbortSignal): Promise<NativeLaneInputRecord> { return this.serial(async () => {
    if (this.record.phase !== 'prepared') return this.reconcileUnlocked();
    const { intent } = this.record;
    // Generic binary files have no official Codex UserInput variant. Do not stringify them.
    if (intent.input.attachments?.length) { await this.save({ phase: 'not-sent', code: 'ATTACHMENT_INPUT_UNAVAILABLE' }); return this.current(); }
    if (!this.api.agents.supportsTurnReceipts?.() || typeof this.agent().turns?.get !== 'function') { await this.save({ phase: 'not-sent', code: 'HOST_UPGRADE_REQUIRED' }); return this.current(); }
    if (intent.admission === 'initial') {
      if (!this.api.agents.supportsInitialPromptReservation?.() || typeof this.api.creations?.get !== 'function') {
        await this.save({ phase: 'not-sent', code: 'HOST_UPGRADE_REQUIRED' }); return this.current();
      }
      if (intent.input.images?.length && !this.api.agents.supportsInitialPromptImages?.()) {
        await this.save({ phase: 'not-sent', code: 'ATTACHMENT_INPUT_UNAVAILABLE' }); return this.current();
      }
    } else if (!this.api.agents.supportsQueuedInputs?.() || typeof this.agent().inputs?.enqueue !== 'function' || typeof this.agent().inputs?.get !== 'function') {
      await this.save({ phase: 'not-sent', code: 'HOST_UPGRADE_REQUIRED' }); return this.current();
    }
    await this.save({ phase: 'dispatching', code: undefined });
    if (signal?.aborted) { await this.save({ phase: 'not-sent', code: 'GROUP_STOPPED' }); return this.current(); }
    let response: QueuedInputReceipt | undefined;
    try {
      if (intent.admission === 'initial') {
        await this.api.agents.create({ ...structuredClone(intent.creation!), agentId: intent.agentId,
          prompt: intent.input.text, clientMessageId: intent.messageId, requireInitialPromptReservation: true,
          ...(intent.input.images ? { images: structuredClone(intent.input.images) } : {}) });
      } else response = await this.agent().inputs!.enqueue(structuredClone(intent.input), { messageId: intent.messageId });
    } catch (error) {
      if ((error as { code?: string })?.code === 'unsupported_capability') {
        await this.save({ phase: 'not-sent', code: 'HOST_UPGRADE_REQUIRED' }); return this.current();
      }
      await this.save({ phase: 'unknown', code: 'ADMISSION_OUTCOME_UNKNOWN' });
      // A lost ACK may already have a readable host receipt. This is a read, never another create/add.
      return this.reconcileUnlocked();
    }
    if (response) await this.applyQueueReceipt(response);
    else await this.readCreation();
    return this.observeTerminal();
  }); }
  reconcile(): Promise<NativeLaneInputRecord> { return this.serial(() => this.reconcileUnlocked()); }
  private async reconcileUnlocked(): Promise<NativeLaneInputRecord> {
    const cancellation = this.record.cancellation;
    if (cancellation && ['dispatching', 'unknown'].includes(cancellation.phase)
      && this.api.agents.supportsQueuedInputs?.() && typeof this.agent().inputs?.getCancellation === 'function')
      await this.applyCancellation(await this.agent().inputs!.getCancellation({ messageId: this.record.intent.messageId, operationId: cancellation.operationId }), cancellation.operationId);
    if (this.record.phase === 'prepared' || terminal(this.record.phase)) return this.current();
    if (this.record.intent.admission === 'initial') await this.readCreation();
    else {
      const inputs = this.agent().inputs;
      if (typeof inputs?.get !== 'function' || !this.api.agents.supportsQueuedInputs?.()) return this.current();
      await this.applyQueueReceipt(await inputs.get({ messageId: this.record.intent.messageId }));
    }
    return this.observeTerminal();
  }
  private async readCreation(): Promise<void> {
    if (!this.api.creations) return;
    const receipt = await this.api.creations.get({ kind: 'agent', idempotencyKey: this.record.intent.creation!.idempotencyKey });
    if (receipt && (receipt.kind !== 'agent' || receipt.idempotencyKey !== this.record.intent.creation!.idempotencyKey
      || (receipt.agentId !== null && receipt.agentId !== this.record.intent.agentId)))
      fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'The creation receipt belongs to a different lane');
    const input = receipt?.initialPrompt;
    if (!input) { await this.save({ phase: 'unknown', code: 'ADMISSION_OUTCOME_UNKNOWN' }); return; }
    if (input.clientMessageId !== this.record.intent.messageId) fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'The creation prompt identity changed');
    const workspaceId = receipt?.workspaceId ?? this.record.workspaceId;
    if (this.record.workspaceId && workspaceId !== this.record.workspaceId)
      fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'The creation receipt changed its workspace identity');
    if (receipt?.phase === 'completed' && receipt.agentId === this.record.intent.agentId && !this.record.creationComplete)
      await this.save({ creationComplete: true, workspaceId });
    if (input.status === 'accepted') {
      if (receipt?.agentId !== this.record.intent.agentId) fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'The accepted creation has no matching agent identity');
      this.checkTurn(input.turnId); await this.save({ phase: 'started', turnId: input.turnId, workspaceId, code: undefined });
    } else if (input.status === 'not_sent') {
      if (this.record.turnId) fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'An accepted first prompt cannot become not-sent');
      await this.save({ phase: 'not-sent', workspaceId, code: input.error });
    }
    else await this.save({ phase: 'unknown', workspaceId, code: input.status === 'pending' ? 'CREATION_INPUT_PENDING' : 'ADMISSION_OUTCOME_UNKNOWN' });
  }
  private checkTurn(turnId: string): void {
    if (!validId(turnId) || (this.record.turnId && this.record.turnId !== turnId))
      fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'The input was associated with a different native turn');
  }
  private async applyQueueReceipt(receipt: QueuedInputReceipt): Promise<void> {
    this.identity(receipt);
    if ('queueId' in receipt && receipt.queueId !== undefined
      && (!validId(receipt.queueId) || (this.record.queueId && this.record.queueId !== receipt.queueId)))
      fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'The native queue identity changed');
    if ('turnId' in receipt && receipt.turnId !== undefined) this.checkTurn(receipt.turnId);
    const queueId = 'queueId' in receipt ? receipt.queueId ?? this.record.queueId : this.record.queueId;
    switch (receipt.status) {
      case 'queued':
        if (!this.record.turnId) await this.save({ phase: 'queued', queueId, code: undefined });
        break;
      case 'started': case 'terminal':
        // Only turns.get provides this adapter's durable completion evidence.
        await this.save({ phase: 'started', queueId, turnId: receipt.turnId, code: undefined }); break;
      case 'cancelled':
        if (this.record.turnId) fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'A started input cannot become an unstarted queue cancellation');
        await this.save({ phase: 'cancelled', queueId, code: undefined }); break;
      case 'not_sent':
        if (this.record.queueId || this.record.turnId) fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'An accepted input cannot become not-sent');
        await this.save({ phase: 'not-sent', code: receipt.code }); break;
      case 'unknown':
        await this.save({ phase: 'unknown', queueId, turnId: receipt.turnId ?? this.record.turnId, code: receipt.code ?? 'ADMISSION_OUTCOME_UNKNOWN' }); break;
      default: fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'The host returned an unsupported queue receipt');
    }
  }
  private async observeTerminal(): Promise<NativeLaneInputRecord> {
    if (!this.record.turnId || terminal(this.record.phase)) return this.current();
    const turns = this.agent().turns;
    if (typeof turns?.get !== 'function' || !this.api.agents.supportsTurnReceipts?.()) return this.current();
    const receipt = await turns.get({ turnId: this.record.turnId });
    if (receipt.agentId !== this.record.intent.agentId || (receipt.clientMessageId !== null && receipt.clientMessageId !== this.record.intent.messageId))
      fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'The turn receipt belongs to another input');
    this.checkTurn(receipt.turnId);
    if (receipt.status !== 'unknown') {
      if (receipt.clientMessageId === null) return this.current();
      if (!['completed', 'failed', 'cancelled'].includes(receipt.status) || !validId(receipt.observedAt))
        fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'The host returned invalid terminal evidence');
      await this.save({ phase: receipt.status, code: undefined });
    }
    return this.current();
  }
  private async applyCancellation(receipt: QueuedInputCancelReceipt, operationId: string): Promise<void> {
    this.identity(receipt);
    if (receipt.operationId !== operationId)
      fail('NATIVE_INPUT_RECEIPT_MISMATCH', 'The cancellation receipt belongs to another operation');
    // A rejected cancellation says nothing about whether the original input was sent.
    if (receipt.status !== 'not_sent') await this.applyQueueReceipt(receipt);
    await this.save({ cancellation: { operationId, phase: receipt.status === 'not_sent' ? 'not-sent' : receipt.status,
      ...('code' in receipt ? { code: receipt.code } : {}) } });
  }
  /** Withdraw only a native pending item. A started turn is returned for the owner's exact stop flow. */
  cancel(operationId: string): Promise<NativeLaneInputRecord> { return this.serial(async () => {
    if (!validId(operationId)) fail('NATIVE_INPUT_INVALID', 'Cancellation requires an operation identity');
    const previous = this.record.cancellation;
    if (previous && previous.operationId !== operationId && previous.phase !== 'not-sent')
      fail('NATIVE_CANCEL_INTENT_CHANGED', 'Reconcile the original cancellation before replacing its identity');
    if (previous?.operationId === operationId) return this.reconcileUnlocked();
    if (this.record.phase === 'prepared') {
      await this.save({ phase: 'cancelled', cancellation: { operationId, phase: 'cancelled' } }); return this.current();
    }
    if (terminal(this.record.phase)) return this.current();
    if (this.record.intent.admission === 'initial') return this.reconcileUnlocked();
    const inputs = this.agent().inputs;
    if (typeof inputs?.cancel !== 'function' || typeof inputs?.getCancellation !== 'function' || !this.api.agents.supportsQueuedInputs?.()) {
      await this.save({ cancellation: { operationId, phase: 'not-sent', code: 'HOST_UPGRADE_REQUIRED' } }); return this.current();
    }
    await this.save({ cancellation: { operationId, phase: 'dispatching' } });
    let receipt: QueuedInputCancelReceipt;
    try { receipt = await inputs.cancel({ messageId: this.record.intent.messageId, operationId }); }
    catch (error) {
      if ((error as { code?: string })?.code === 'unsupported_capability') {
        await this.save({ cancellation: { operationId, phase: 'not-sent', code: 'HOST_UPGRADE_REQUIRED' } }); return this.current();
      }
      await this.save({ cancellation: { operationId, phase: 'unknown', code: (error as { code?: string })?.code ?? 'CANCELLATION_OUTCOME_UNKNOWN' } });
      return this.reconcileUnlocked();
    }
    await this.applyCancellation(receipt, operationId);
    return this.observeTerminal();
  }); }
  /** Read this completed turn's public projected answer (same-turn fragments may be merged),
   * even when a later human turn exists. This is not a raw original-message provenance API. */
  readReply(): Promise<string> { return this.serial(async () => {
    if (this.record.phase !== 'completed' || !this.record.turnId)
      fail('REPLY_NOT_CONFIRMED', 'No durable successful terminal is available for this input');
    const entries: NativeTimelineEntry[] = []; let cursor: unknown;
    for (let page = 0; page < 50; page++) {
      const result = await this.agent().timeline.refetch({ limit: 200, projection: 'projected',
        ...(cursor !== undefined ? { cursor, direction: 'before' as const } : {}) });
      if (result.error) fail('REPLY_NOT_CONFIRMED', 'The native timeline could not be read');
      entries.unshift(...result.entries);
      if (entries.some(entry => entry.item.type === 'user_message' && entry.item.clientMessageId === this.record.intent.messageId)) break;
      if (!result.hasOlder || result.startCursor === undefined || result.startCursor === null) break;
      cursor = result.startCursor;
    }
    const source = entries.filter(entry => entry.item.type === 'user_message' && entry.item.clientMessageId === this.record.intent.messageId);
    if (!source.length || source.some(entry => entry.turnId !== this.record.turnId))
      fail('REPLY_NOT_CONFIRMED', 'The exact input-to-turn link is missing from the native timeline');
    const reply = entries.filter(entry => entry.turnId === this.record.turnId && entry.item.type === 'assistant_message' && typeof entry.item.text === 'string').at(-1);
    if (!reply) return fail('REPLY_NOT_CONFIRMED', 'The completed owned turn has no confirmed assistant reply');
    return reply.item.text!;
  }); }
}
