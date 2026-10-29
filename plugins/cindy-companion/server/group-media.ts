import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GROUP_MEDIA_CHUNK_BYTES, GROUP_MEDIA_MAX_ATTACHMENTS, GROUP_MEDIA_MAX_BYTES, type GroupAttachment, type GroupMediaUpload } from '../shared/group-media';
import { isDangerousAttachmentName } from '../shared/vendor/attachmentSafety';
import { safeAttachmentFileName } from './vendor/attachmentFileName';
import { record, string, throwIpcError } from './errors';
import type { CompanionStore, SavedState } from './store';

export interface SavedGroupMedia {
  id: string; groupId: string; operationId: string; fingerprint: string; name: string; mimeType: string;
  size: number; sha256: string; phase: 'uploading' | 'sealed' | 'cancelled'; offset: number;
  chunks: string[]; refs: string[]; retained: boolean; cleaned?: boolean; attachment?: GroupAttachment;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const key = (groupId: string, operationId: string) => hash(JSON.stringify([groupId, operationId]));
const MAX_GROUP_BYTES = 1024 * 1024 * 1024;
const MAX_GROUP_UPLOADS = 1000;
export function mediaGroup(state: SavedState, groupId: string, readOnly = false) {
  const group = state.groups?.[groupId];
  if (!group || group.deletedAt) throwIpcError('NOT_FOUND', 'Group not found');
  if (group.mutation && !readOnly) throwIpcError('GROUP_BUSY', 'Group deletion is awaiting cleanup');
  return group;
}
function upload(state: SavedState, groupId: string, id: string) {
  mediaGroup(state, groupId); const item = state.groupMedia?.[id];
  if (!item || item.groupId !== groupId) throwIpcError('NOT_FOUND', 'Upload not found in this group');
  return item;
}
function identifier(value: unknown, name: string) { return string(value, name, 200); }
function offset(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) % GROUP_MEDIA_CHUNK_BYTES) throwIpcError('INVALID_PARAMS', 'Invalid media offset');
  return Number(value);
}
function project(item: SavedGroupMedia): GroupMediaUpload {
  return { uploadId: item.id, status: item.phase, nextOffset: item.offset, totalBytes: item.size, chunkBytes: GROUP_MEDIA_CHUNK_BYTES,
    ...(item.attachment ? { attachment: item.attachment } : {}) };
}
function rejectKeys(args: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(args).some(k => !allowed.includes(k))) throwIpcError('INVALID_PARAMS', 'Unsupported media parameter');
}
export function parseMediaInputs(input: unknown): Array<{ mediaId: string }> {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > GROUP_MEDIA_MAX_ATTACHMENTS) throwIpcError('INVALID_PARAMS', 'Too many attachments');
  const ids = input.map(raw => { const item = record(raw); rejectKeys(item, ['mediaId']); return { mediaId: identifier(item.mediaId, 'mediaId') }; });
  if (new Set(ids.map(item => item.mediaId)).size !== ids.length) throwIpcError('INVALID_PARAMS', 'Duplicate attachment');
  return ids;
}
/** Called inside the SAME store transaction as the message/outbox receipt. */
export function pinGroupMedia(state: SavedState, groupId: string, inputs: Array<{ mediaId: string }>, ref: string): GroupAttachment[] {
  return inputs.map(({ mediaId }) => {
    const item = upload(state, groupId, mediaId);
    if (item.phase !== 'sealed' || !item.attachment || (!item.retained && !item.refs.length)) throwIpcError('MEDIA_UNAVAILABLE', 'Attachment is not sealed or retained');
    if (!item.refs.includes(ref)) item.refs.push(ref);
    return structuredClone(item.attachment);
  });
}
export function releaseGroupMedia(state: SavedState, groupId: string, ref: string) {
  for (const item of Object.values(state.groupMedia ?? {})) if (item.groupId === groupId) {
    item.refs = item.refs.filter(value => value !== ref);
    if (!item.retained && !item.refs.length) item.phase = 'cancelled';
  }
}
export function adoptGroupMedia(state: SavedState, groupId: string, inputs: Array<{mediaId:string}>) {
  for (const {mediaId} of inputs) upload(state,groupId,mediaId).retained=false;
}
/** Failed outbox -> editable draft. Transfer the exact existing ref before releasing it. */
export function retainGroupMediaDraft(state:SavedState,groupId:string,inputs:Array<{mediaId:string}>,ref:string){
  for(const {mediaId} of inputs){const item=upload(state,groupId,mediaId);
    if(item.phase!=='sealed'||!item.refs.includes(ref))throwIpcError('MEDIA_UNAVAILABLE','The failed message no longer retains this attachment');
    item.retained=true;
  }
}
/** Only after the room deletion commits; the tombstone precedes byte removal. */
export function retireGroupMedia(state: SavedState, groupId: string) {
  for (const item of Object.values(state.groupMedia ?? {})) if(item.groupId===groupId){item.retained=false;item.refs=[];item.phase='cancelled';}
}

/** Chunked host transport for Cindy's immutable attachment/reference rules. All state is shared with messages. */
export class GroupMedia {
  private locks = new Map<string, Promise<unknown>>();
  private operations = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly store: CompanionStore) {}
  private admit<T>(run: () => Promise<T>) {
    if (this.closed) throwIpcError('PLUGIN_CLOSED', 'Media service is closing');
    const promise = Promise.resolve().then(run); this.operations.add(promise);
    void promise.finally(() => this.operations.delete(promise)).catch(() => {}); return promise;
  }
  private serial<T>(id: string, run: () => Promise<T>) {
    const next = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(run); this.locks.set(id, next);
    void next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => {}); return next;
  }
  async close() { this.closed = true; await Promise.allSettled([...this.operations]); }
  private async path(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throwIpcError('INVALID_PARAMS', 'Invalid media identity');
    const dir = join(this.store.root, 'group-media'); await this.store.safePath(dir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${id}.bin`); await this.store.safePath(path); return path;
  }
  begin(groupId: string, args: Record<string, unknown>) {
    return this.admit(async () => {
      rejectKeys(args, ['groupId', 'operationId', 'name', 'mimeType', 'size', 'sha256']);
      const operationId = identifier(args.operationId, 'operationId'), originalName = string(args.name, 'filename', 1020).trim();
      if (originalName.length > 255) throwIpcError('INVALID_PARAMS', 'Filename is too long');
      const name = safeAttachmentFileName(originalName), mimeType = string(args.mimeType, 'mimeType', 200).toLowerCase();
      if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)) throwIpcError('INVALID_PARAMS', 'Invalid media type');
      if(args.size===0)throwIpcError('MEDIA_EMPTY','Empty attachments are not supported');
      if (!Number.isSafeInteger(args.size) || Number(args.size) < 1 || Number(args.size) > GROUP_MEDIA_MAX_BYTES) throwIpcError('MEDIA_TOO_LARGE', 'Attachment must be between 1 byte and 100 MiB');
      const size = Number(args.size), sha256 = string(args.sha256, 'sha256', 64);
      if (!/^[a-f0-9]{64}$/.test(sha256)) throwIpcError('INVALID_PARAMS', 'Invalid content hash');
      const fingerprint = hash(JSON.stringify([originalName, mimeType, size, sha256]));
      return this.store.transaction(state => {
        mediaGroup(state, groupId); const request = key(groupId, operationId), priorId = state.groupMediaKeys?.[request];
        if (priorId) { const prior = upload(state, groupId, priorId); if (prior.fingerprint !== fingerprint) throwIpcError('IDEMPOTENCY_CONFLICT', 'Upload key belongs to different bytes'); return project(prior); }
        const owned = Object.values(state.groupMedia ?? {}).filter(item => item.groupId === groupId && !item.cleaned);
        if (owned.length >= MAX_GROUP_UPLOADS || owned.reduce((sum, item) => sum + item.size, 0) + size > MAX_GROUP_BYTES) throwIpcError('MEDIA_QUOTA', 'Group attachment storage quota reached');
        const id = randomUUID(), item: SavedGroupMedia = { id, groupId, operationId, fingerprint, name, mimeType, size, sha256, phase: 'uploading', offset: 0, chunks: [], refs: [], retained: true };
        (state.groupMedia ??= {})[id] = item; (state.groupMediaKeys ??= {})[request] = id; return project(item);
      });
    });
  }
  status(groupId: string, args: Record<string, unknown>) {
    return this.admit(async () => { rejectKeys(args, ['groupId', 'uploadId']); return project(upload(await this.store.snapshot(), groupId, identifier(args.uploadId, 'uploadId'))); });
  }
  write(groupId: string, args: Record<string, unknown>) {
    return this.admit(async () => {
      rejectKeys(args, ['groupId', 'uploadId', 'offset', 'data']); const id = identifier(args.uploadId, 'uploadId'), start = offset(args.offset);
      const encoded = string(args.data, 'chunk', GROUP_MEDIA_CHUNK_BYTES * 4 / 3), bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded || !bytes.length || bytes.length > GROUP_MEDIA_CHUNK_BYTES) throwIpcError('INVALID_PARAMS', 'Invalid base64 chunk');
      return this.serial(id, () => this.store.transaction(async state => {
        const item = upload(state, groupId, id), chunkHash = hash(bytes);
        if (item.phase === 'cancelled' || !item.retained) throwIpcError('MEDIA_CANCELLED', 'Upload was cancelled');
        if (start >= item.size || bytes.length !== Math.min(GROUP_MEDIA_CHUNK_BYTES, item.size - start)) throwIpcError('INVALID_PARAMS', 'Chunk has the wrong size');
        if (start < item.offset) { if (item.chunks[start / GROUP_MEDIA_CHUNK_BYTES] !== chunkHash) throwIpcError('IDEMPOTENCY_CONFLICT', 'Chunk differs from the accepted bytes'); return project(item); }
        if (item.phase !== 'uploading' || start !== item.offset) throwIpcError('MEDIA_OFFSET', 'Upload the next missing chunk');
        const handle = await open(await this.path(id), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        try {
          const stat = await handle.stat(); if (!stat.isFile() || stat.size < item.offset) throwIpcError('MEDIA_BYTES_MISSING', 'Previously received upload bytes are missing');
          // A crash may leave bytes beyond the durable cursor; those bytes were never acknowledged.
          await handle.truncate(item.offset);
          let written = 0;
          while (written < bytes.length) {
            const result = await handle.write(bytes, written, bytes.length - written, item.offset + written);
            if (!result.bytesWritten) throwIpcError('MEDIA_WRITE_FAILED', 'Upload write made no progress'); written += result.bytesWritten;
          }
          await handle.sync();
        } finally { await handle.close(); }
        item.offset += bytes.length; item.chunks.push(chunkHash); return project(item);
      }));
    });
  }
  complete(groupId: string, args: Record<string, unknown>) {
    return this.admit(async () => {
      rejectKeys(args, ['groupId', 'uploadId']); const id = identifier(args.uploadId, 'uploadId');
      return this.serial(id, () => this.store.transaction(async state => {
        const item = upload(state, groupId, id); if (item.phase === 'sealed') return project(item);
        if (item.phase === 'cancelled' || !item.retained) throwIpcError('MEDIA_CANCELLED', 'Upload was cancelled');
        if (item.offset !== item.size) throwIpcError('MEDIA_INCOMPLETE', 'Upload has missing chunks');
        const handle = await open(await this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW);
        let first = Buffer.alloc(0); const digest = createHash('sha256');
        try {
          const stat = await handle.stat(); if (!stat.isFile() || stat.size !== item.size) throwIpcError('MEDIA_BYTES_MISSING', 'Upload size changed');
          for (let start = 0; start < item.size; start += GROUP_MEDIA_CHUNK_BYTES) {
            const chunk = Buffer.alloc(Math.min(GROUP_MEDIA_CHUNK_BYTES, item.size - start)), result = await handle.read(chunk, 0, chunk.length, start);
            if (result.bytesRead !== chunk.length) throwIpcError('MEDIA_BYTES_MISSING', 'Upload was truncated');
            digest.update(chunk); if (!start) first = chunk.subarray(0, 16);
          }
        } finally { await handle.close(); }
        if (digest.digest('hex') !== item.sha256) throwIpcError('MEDIA_HASH_MISMATCH', 'Upload content hash does not match');
        let category: GroupAttachment['category'] = 'file';
        if (item.mimeType.startsWith('image/') && !isDangerousAttachmentName(item.name)) {
          const detected = first.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' :
            first[0] === 255 && first[1] === 216 && first[2] === 255 ? 'image/jpeg' :
            first.subarray(0, 4).toString() === 'RIFF' && first.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' :
            ['GIF87a','GIF89a'].includes(first.subarray(0, 6).toString()) ? 'image/gif' : null;
          if (!detected || detected !== item.mimeType) throwIpcError('MEDIA_TYPE_MISMATCH', 'Image bytes do not match a supported image type'); category = 'image';
        } else if (!isDangerousAttachmentName(item.name)) category = item.mimeType === 'application/pdf' ? 'pdf' : item.mimeType.startsWith('text/') ? 'text' : 'file';
        item.phase = 'sealed'; item.attachment = { mediaId: id, name: item.name, mimeType: item.mimeType, size: item.size, sha256: item.sha256, category }; return project(item);
      }));
    });
  }
  cancel(groupId: string, args: Record<string, unknown>) {
    return this.admit(async () => {
      rejectKeys(args, ['groupId', 'uploadId', 'operationId']); const id = identifier(args.uploadId, 'uploadId'), operation=key(groupId,identifier(args.operationId, 'operationId'));
      return this.serial(id, async () => {
        const retained = await this.store.transaction(state => { const item = upload(state, groupId, id);
          const prior=state.groupMediaCancelKeys?.[operation];if(prior&&prior!==id)throwIpcError('IDEMPOTENCY_CONFLICT','Cancel key belongs to another upload');
          // A later explicit outbox edit can grant this upload to a new draft.
          // Replaying an older cancel reconciles its cleanup, never revokes that grant.
          if(prior)return item.retained||item.refs.length>0;
          (state.groupMediaCancelKeys??={})[operation]=id;item.retained = false; if (!item.refs.length) item.phase = 'cancelled'; return item.refs.length > 0; });
        if (!retained) await this.collectOne(groupId,id);
        return { cancelled: true as const, retained };
      });
    });
  }
  private async collectOne(groupId:string,id:string){
    await this.store.transaction(async state=>{const item=state.groupMedia?.[id];if(!item||item.groupId!==groupId||item.phase!=='cancelled'||item.retained||item.refs.length||item.cleaned)return;
      await rm(await this.path(id),{force:true});item.cleaned=true;
    });
  }
  collect(groupId:string){return this.admit(async()=>{
    const state=await this.store.snapshot();
    for(const item of Object.values(state.groupMedia??{}))if(item.groupId===groupId&&item.phase==='cancelled'&&!item.cleaned)await this.serial(item.id,()=>this.collectOne(groupId,item.id));
  });}
  read(groupId: string, args: Record<string, unknown>) {
    return this.admit(async () => {
      rejectKeys(args, ['groupId', 'mediaId', 'offset', 'messageId']); const id = identifier(args.mediaId, 'mediaId'), start = offset(args.offset);
      return this.serial(id, async () => {
        const authorize=(state:SavedState)=>{const item=upload(state,groupId,id);
        if (item.phase !== 'sealed' || !item.attachment) throwIpcError('MEDIA_UNAVAILABLE', 'Attachment is not available');
        if (args.messageId !== undefined) {
          const messageId = identifier(args.messageId, 'messageId'), message = mediaGroup(state, groupId).messages.find(message => message.id === messageId && !message.deleted);
          if (!message?.attachments?.some(attachment => attachment.mediaId === id) || !item.refs.includes(`message:${messageId}`)) throwIpcError('NOT_FOUND', 'Attachment does not belong to this message');
        } else if (!item.retained && !item.refs.some(ref => ref.startsWith('outbox:'))) throwIpcError('NOT_FOUND', 'Upload is no longer retained');
        return item;};
        const item=authorize(await this.store.snapshot());
        if (start >= item.size) throwIpcError('INVALID_PARAMS', 'Offset is outside the attachment');
        const handle = await open(await this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW), bytes = Buffer.alloc(Math.min(GROUP_MEDIA_CHUNK_BYTES, item.size - start));
        try { if ((await handle.stat()).size!==item.size || (await handle.read(bytes, 0, bytes.length, start)).bytesRead !== bytes.length || hash(bytes) !== item.chunks[start / GROUP_MEDIA_CHUNK_BYTES]) throwIpcError('MEDIA_BYTES_MISSING', 'Attachment bytes changed'); } finally { await handle.close(); }
        // A group could be deleted while the file read was in progress.
        authorize(await this.store.snapshot());
        return { mediaId: id, offset: start, totalBytes: item.size, sha256: item.sha256, mimeType: item.mimeType, data: bytes.toString('base64'), nextOffset: start + bytes.length < item.size ? start + bytes.length : null };
      });
    });
  }
}
