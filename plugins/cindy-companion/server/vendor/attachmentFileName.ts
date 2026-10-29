// Extracted unchanged from Cindy botGroupAttachments.ts; see MEDIA_OUTBOX_PROVENANCE.json.
/** A name that is safe as the last segment of a path on every platform. */
export function safeAttachmentFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return (cleaned || 'attachment').slice(0, 120);
}

