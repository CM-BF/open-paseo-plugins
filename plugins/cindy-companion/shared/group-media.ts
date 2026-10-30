import type { BotGroupAttachmentCategory } from './vendor/botGroupChat';
/** Cindy main-group attachments adapted to a host-owned chunked store. No caller paths or URLs. */
export const GROUP_MEDIA_CHUNK_BYTES = 393216;
export const GROUP_MEDIA_MAX_BYTES = 100 * 1024 * 1024;
export const GROUP_MEDIA_MAX_ATTACHMENTS = 20;
export interface GroupAttachment {
  mediaId: string; name: string; mimeType: string; size: number; sha256: string;
  category: BotGroupAttachmentCategory;
}
export interface GroupMediaUpload {
  uploadId: string; status: 'uploading' | 'sealed' | 'cancelled';
  nextOffset: number; totalBytes: number; chunkBytes: number; attachment?: GroupAttachment;
}
export interface GroupMediaChunk {
  mediaId: string; offset: number; totalBytes: number; sha256: string; mimeType: string;
  data: string; nextOffset: number | null;
}
/** Standard settings.invoke envelopes.
 * groups.media.begin {groupId,operationId,name,mimeType,size,sha256} -> GroupMediaUpload
 * groups.media.write {groupId,uploadId,offset,data} -> GroupMediaUpload
 *   Fixed raw chunks; last may be shorter. Same offset/bytes replays, different bytes conflict.
 * groups.media.status {groupId,uploadId} -> GroupMediaUpload (read-only; never auto-uploads).
 * groups.media.complete {groupId,uploadId} -> GroupMediaUpload (sealed only after size/hash checks).
 *   Empty attachments are rejected as in Cindy's production media path (MEDIA_EMPTY).
 * groups.media.cancel {groupId,uploadId,operationId} -> {cancelled:true,retained:boolean}
 *   Releases only this upload; accepted message/outbox references remain readable.
 * groups.media.read {groupId,mediaId,offset,messageId?} -> GroupMediaChunk
 *   A messageId binds the exact frozen attachment; omitted means the caller's retained upload/outbox.
 * Byte transfer never executes file content. Main groups only; thread replies remain text-only.
 * Attachment display/acceptance is separate from native input support; no text-only fallback.
 */
