import { useEffect, useRef, useState } from 'react';
import { GROUP_MEDIA_MAX_ATTACHMENTS, GROUP_MEDIA_MAX_BYTES, type GroupAttachment } from '../shared/group-media';
import { cancelGroupUpload, uploadGroupFile, type UploadIntent } from './group-media-rpc';

export interface ComposerUpload { id: string; name: string; size: number; mimeType: string; file?: File; preview?: string; intent: UploadIntent; attachment?: GroupAttachment; status: 'queued'|'uploading'|'sealed'|'failed'|'cancelling'; progress: number; error?: string; abort?: AbortController; task?: Promise<void>; cancelTask?: Promise<void> }
export function useGroupUploads(groupId: string) {
  const items = useRef<ComposerUpload[]>([]), alive = useRef(true), active = useRef(0);
  const [uploads, setUploads] = useState<ComposerUpload[]>([]), [error, setError] = useState('');
  const publish = () => { if (alive.current) setUploads(items.current.map(item => ({ ...item }))); };
  const pump = () => {
    if (!alive.current) return;
    for (const item of items.current) {
      if (active.current >= 3) break;
      if (item.status !== 'queued' || !item.file) continue;
      item.status = 'uploading'; item.abort = new AbortController(); active.current++;
      item.task = uploadGroupFile(groupId, item.file, item.intent, value => { item.progress = value; publish(); }, item.abort.signal)
        .then(attachment => { item.attachment = attachment; item.status = 'sealed'; item.error = undefined; })
        .catch(reason => { if (item.status !== 'cancelling') { item.status = 'failed'; item.error = String(reason.message ?? reason); } })
        .finally(() => { active.current--; publish(); pump(); });
    }
    publish();
  };
  const remove = (id: string): Promise<void> => {
    const item = items.current.find(value => value.id === id); if (!item) return Promise.resolve();
    if (item.cancelTask) return item.cancelTask;
    item.status = 'cancelling'; item.abort?.abort(); publish();
    item.cancelTask = (async () => { await item.task;
      try {
      if (item.intent.begin || item.intent.uploadId) await cancelGroupUpload(groupId, item.intent);
      items.current = items.current.filter(value => value !== item); if (item.preview) URL.revokeObjectURL(item.preview); publish();
      } catch (reason) { item.status = 'failed'; item.error = String(reason.message ?? reason); publish(); throw reason; }
    })().finally(() => { item.cancelTask = undefined; });
    return item.cancelTask;
  };
  useEffect(() => { alive.current = true; return () => {
    alive.current = false;
    for (const item of items.current) {
      if (item.preview) URL.revokeObjectURL(item.preview);
      if (item.status !== 'sealed') { item.abort?.abort(); void item.task?.finally(() => cancelGroupUpload(groupId, item.intent)).catch(() => {}); }
    }
  }; }, [groupId]);
  return { uploads, error, clearError: () => setError(''),
    pending: uploads.some(item => item.status !== 'sealed'),
    attachments: uploads.flatMap(item => item.attachment && item.status === 'sealed' ? [item.attachment] : []),
    add(files: readonly File[]) {
      if (items.current.length + files.length > GROUP_MEDIA_MAX_ATTACHMENTS) { setError('A message can contain up to 20 attachments.'); return; }
      if (files.some(file => file.size > GROUP_MEDIA_MAX_BYTES)) { setError('Files must be 100 MiB or smaller.'); return; }
      for (const file of files) items.current.push({ id: crypto.randomUUID(), name: file.name, size: file.size, mimeType: file.type, file,
        preview: file.type.startsWith('image/') && file.type !== 'image/svg+xml' ? URL.createObjectURL(file) : undefined,
        intent: { operationId: crypto.randomUUID() }, status: 'queued', progress: 0 });
      setError(''); pump();
    },
    restore(attachments: GroupAttachment[]) {
      if (items.current.length) return;
      items.current = attachments.map(attachment => ({ id: attachment.mediaId, name: attachment.name, size: attachment.size, mimeType: attachment.mimeType,
        attachment, intent: { operationId: crypto.randomUUID(), uploadId: attachment.mediaId, attachment }, status: 'sealed', progress: 1 })); publish();
    },
    retry(id: string) { const item = items.current.find(value => value.id === id); if (item?.file && item.status === 'failed' && !item.intent.cancelled) { item.status = 'queued'; item.error = undefined; pump(); } },
    remove,
    async cancelPending() { for (const item of [...items.current]) if (item.status !== 'sealed') await remove(item.id); },
    accepted() { for (const item of items.current) if (item.preview) URL.revokeObjectURL(item.preview); items.current = []; publish(); },
  };
}
