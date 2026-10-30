import { invoke } from './bridge';
import { GROUP_MEDIA_CHUNK_BYTES, GROUP_MEDIA_MAX_BYTES, type GroupAttachment, type GroupMediaChunk, type GroupMediaUpload } from '../shared/group-media';

export type MediaRequest = <T>(op: string, args: Record<string, unknown>) => Promise<T>;
export interface UploadIntent { operationId: string; uploadId?: string; attachment?: GroupAttachment; cancelled?: boolean; cancelOperationId?: string; begin?: Record<string, unknown> }
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError'); };
export function encodeMediaBytes(bytes: Uint8Array) { let result = ''; for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(result); }
export async function hashMediaBytes(bytes: Uint8Array) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join(''); }

/** A retry keeps both upload identity and exact bytes; status resolves a lost chunk ACK. */
export async function uploadGroupFile(groupId: string, file: Blob & { name: string }, intent: UploadIntent, progress: (ratio: number) => void, signal?: AbortSignal, request: MediaRequest = invoke): Promise<GroupAttachment> {
  if (file.size > GROUP_MEDIA_MAX_BYTES) throw new Error('Files must be 100 MiB or smaller.');
  check(signal); const bytes = new Uint8Array(await file.arrayBuffer()); check(signal);
  const sha256 = await hashMediaBytes(bytes); check(signal);
  intent.begin = { groupId, operationId: intent.operationId, name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, sha256 };
  let upload = intent.uploadId ? await request<GroupMediaUpload>('groups.media.status', { groupId, uploadId: intent.uploadId })
    : await request<GroupMediaUpload>('groups.media.begin', intent.begin);
  intent.uploadId = upload.uploadId;
  const validate = () => {
    if (upload.totalBytes !== bytes.length || upload.chunkBytes !== GROUP_MEDIA_CHUNK_BYTES || !Number.isSafeInteger(upload.nextOffset) || upload.nextOffset < 0 || upload.nextOffset > bytes.length || (upload.nextOffset !== bytes.length && upload.nextOffset % GROUP_MEDIA_CHUNK_BYTES !== 0)) throw new Error('Invalid upload acknowledgement.');
    if (upload.status === 'cancelled') throw new Error('This upload was cancelled. Select the file again.');
  };
  validate(); check(signal);
  while (upload.status !== 'sealed' && upload.nextOffset < bytes.length) {
    check(signal); const offset = upload.nextOffset;
    try { upload = await request<GroupMediaUpload>('groups.media.write', { groupId, uploadId: intent.uploadId, offset, data: encodeMediaBytes(bytes.subarray(offset, offset + GROUP_MEDIA_CHUNK_BYTES)) }); }
    catch (error) {
      check(signal); const status = await request<GroupMediaUpload>('groups.media.status', { groupId, uploadId: intent.uploadId });
      if (status.nextOffset <= offset) throw error;
      upload = status;
    }
    validate(); check(signal); if (upload.nextOffset <= offset) throw new Error('Upload did not advance.'); progress(bytes.length ? upload.nextOffset / bytes.length : 1);
  }
  if (upload.status !== 'sealed') upload = await request<GroupMediaUpload>('groups.media.complete', { groupId, uploadId: intent.uploadId });
  check(signal); const attachment = upload.attachment;
  if (upload.status !== 'sealed' || !attachment || attachment.size !== bytes.length || attachment.sha256 !== sha256) throw new Error('Attachment was not confirmed.');
  intent.attachment = attachment; progress(1); return attachment;
}
export async function cancelGroupUpload(groupId: string, intent: UploadIntent, request: MediaRequest = invoke) {
  intent.cancelled = true;
  // begin may have been committed even when its ACK was lost. Reconcile the same
  // immutable upload identity before cancelling; never abandon an unknown upload.
  if (!intent.uploadId && intent.begin) intent.uploadId = (await request<GroupMediaUpload>('groups.media.begin', intent.begin)).uploadId;
  if (!intent.uploadId) return;
  intent.cancelOperationId ??= crypto.randomUUID();
  await request('groups.media.cancel', { groupId, uploadId: intent.uploadId, operationId: intent.cancelOperationId });
}
const readers: Promise<void>[] = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
let readerSequence = 0;
/** Loading a long history cannot allocate every image or flood the frame RPC budget. */
export async function readGroupMedia(groupId: string, attachment: GroupAttachment, messageId?: string, signal?: AbortSignal, request: MediaRequest = invoke): Promise<Blob> {
  check(signal);
  const slot = readerSequence++ % readers.length, previous = readers[slot];
  let release!: () => void;
  readers[slot] = new Promise<void>(resolve => { release = resolve; });
  try { await previous; check(signal); return await readMediaBytes(groupId, attachment, messageId, signal, request); }
  finally { release(); }
}
async function readMediaBytes(groupId: string, attachment: GroupAttachment, messageId?: string, signal?: AbortSignal, request: MediaRequest = invoke): Promise<Blob> {
  if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > GROUP_MEDIA_MAX_BYTES) throw new Error('Invalid attachment size.');
  const bytes = new Uint8Array(attachment.size); let offset = 0;
  do {
    check(signal); const chunk = await request<GroupMediaChunk>('groups.media.read', { groupId, mediaId: attachment.mediaId, offset, ...(messageId ? { messageId } : {}) }); check(signal);
    if (typeof chunk.data !== 'string' || chunk.data.length > GROUP_MEDIA_CHUNK_BYTES / 3 * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) throw new Error('Invalid attachment encoding.');
    const raw = Uint8Array.from(atob(chunk.data), value => value.charCodeAt(0));
    const end = offset + raw.length;
    if (chunk.mediaId !== attachment.mediaId || chunk.offset !== offset || chunk.totalBytes !== bytes.length || chunk.sha256 !== attachment.sha256 || chunk.mimeType !== attachment.mimeType || raw.length > GROUP_MEDIA_CHUNK_BYTES || end > bytes.length || (end < bytes.length && raw.length !== GROUP_MEDIA_CHUNK_BYTES) || chunk.nextOffset !== (end === bytes.length ? null : end)) throw new Error('Invalid attachment chunk.');
    bytes.set(raw, offset); offset = end;
  } while (offset < bytes.length);
  if (await hashMediaBytes(bytes) !== attachment.sha256) throw new Error('Attachment content did not match its saved fingerprint.');
  check(signal); return new Blob([bytes], { type: attachment.mimeType });
}
