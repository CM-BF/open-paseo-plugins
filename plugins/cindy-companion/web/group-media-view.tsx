// Cindy ComposerAttachments (56px tray) and BotGroupMessageAttachments (ordered image/file rows).
// Electron local paths are replaced with verified, group-scoped immutable bytes. See media-SOURCE.md.
import { useEffect, useRef, useState } from 'react';
import { Copy, Download, File, ImageOff, LoaderCircle, RefreshCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { isDangerousAttachmentName } from '../shared/vendor/attachmentSafety';
import { CHAT_LIGHTBOX_ICON_BUTTON_CLASS } from '../vendor/renderer/components/chat/chatChrome';
import { wheelZoomFactor, zoomAtPoint, type LightboxViewport } from '../vendor/renderer/components/chat/lightboxGestures';
import { MarkdownRenderer } from './adapters/memory-markdown';
import type { GroupAttachment } from '../shared/group-media';
import type { ComposerUpload } from './group-uploads';
import { readGroupMedia } from './group-media-rpc';
import { FileTypeTile } from '../vendor/renderer/components/ui/file-type-tile';
import { Button } from '../vendor/renderer/components/ui/button';
import { Spinner } from '../vendor/renderer/components/ui/spinner';

const imageType = (value: string) => /^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(value);
const previewText = (attachment:GroupAttachment) => !isDangerousAttachmentName(attachment.name) && (attachment.category === 'text' || /^(?:text\/|application\/(?:json|xml))/.test(attachment.mimeType));
const videoType = (value: string) => /^video\/(mp4|webm|ogg)$/i.test(value);
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
function useMedia(groupId: string, attachment: GroupAttachment | undefined, messageId?: string, load = false) {
  const [url, setUrl] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const alive = useRef(true), pending = useRef<Promise<string>|null>(null), blobUrl = useRef(''), savedBlob = useRef<Blob|null>(null), abort = useRef(new AbortController());
  const read = () => {
    if (blobUrl.current) return Promise.resolve(blobUrl.current);
    if (pending.current) return pending.current;
    if (!attachment) return Promise.reject(new Error('Attachment upload has not completed.'));
    setLoading(true); setError('');
    pending.current = readGroupMedia(groupId, attachment, messageId, abort.current.signal).then(blob => {
      if (!alive.current) throw new DOMException('Closed', 'AbortError');
      savedBlob.current = blob; const value = URL.createObjectURL(blob); blobUrl.current = value; setUrl(value); return value;
    }).catch(reason => { if (alive.current) setError(String(reason.message ?? reason)); throw reason; }).finally(() => { pending.current = null; if (alive.current) setLoading(false); });
    return pending.current;
  };
  useEffect(() => { alive.current = true; if (load) void read().catch(() => {}); return () => { alive.current = false; abort.current.abort(); if (blobUrl.current) URL.revokeObjectURL(blobUrl.current); }; }, []);
  return { url, error, loading, read, text:()=>savedBlob.current?.text() };
}
function MediaPreview({ name, mimeType, src, open, onClose, text, size, textFile }: { name:string; mimeType:string; src:string; open:boolean; onClose():void; text?:string; size:number; textFile:boolean }) {
  const { t } = useTranslation(); const [viewport, setViewport] = useState<LightboxViewport>({scale:1,tx:0,ty:0}), [error,setError] = useState('');
  const drag = useRef<{x:number;y:number}|null>(null);
  const reset = () => setViewport({scale:1,tx:0,ty:0});
  const download = <a href={src} download={name} aria-label={t('paseoMedia.download')} className={CHAT_LIGHTBOX_ICON_BUTTON_CLASS}><Download size={18}/></a>;
  const close = <Dialog.Close aria-label={t('paseoMedia.close')} className={CHAT_LIGHTBOX_ICON_BUTTON_CLASS}><X size={20}/></Dialog.Close>;
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose(); }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-[100] bg-[var(--overlay-lightbox)]"/><Dialog.Content aria-describedby={undefined} className="fixed inset-0 z-[101] flex items-center justify-center overflow-hidden p-10 outline-none" onClick={event=>{if(event.target===event.currentTarget)onClose()}} onEscapeKeyDown={event => event.stopPropagation()} onKeyDown={event=>{if(event.key==='0')reset();else if(event.key==='+'||event.key==='=')setViewport(value=>zoomAtPoint(value,{cx:0,cy:0},1.2,1,8));else if(event.key==='-')setViewport(value=>zoomAtPoint(value,{cx:0,cy:0},1/1.2,1,8));}}>
    <Dialog.Title className="sr-only">{name}</Dialog.Title>
    {textFile ? <div data-text-lightbox-card className="relative z-[1] flex cursor-auto flex-col overflow-hidden rounded-xl border border-[var(--msg-tool-card-border)] bg-[var(--msg-tool-card-bg)]" style={{width:'80vw',height:'80vh',maxWidth:1600,maxHeight:1200}}>
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--msg-tool-card-border)] px-5"><span className="flex min-w-0 items-center gap-2 text-14 text-[var(--msg-tool-card-text)]"><File size={16}/><span className="truncate font-medium">{name}</span><span className="shrink-0 text-12 text-[var(--msg-tool-card-chevron)]">· {bytes(size)}</span></span><div className="flex items-center gap-1 text-[var(--msg-tool-card-chevron)]">{download}<button type="button" className={CHAT_LIGHTBOX_ICON_BUTTON_CLASS} aria-label={t('chat.textLightbox.copyAll')} disabled={text===undefined} onClick={()=>{void (navigator.clipboard?.writeText(text??'')??Promise.reject(new Error('Clipboard access is not available in this view.'))).catch(reason=>setError(String(reason.message??reason)))}}><Copy size={18}/></button>{close}</div></div>
      {error&&<p role="alert" className="px-5 text-12 text-[var(--text-danger)]">{error}</p>}
      {text===undefined ? <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center text-[var(--msg-tool-card-text)]"><p>{t('chat.textLightbox.oversizeTitle')}</p><p className="text-13">{t('chat.textLightbox.oversizeBody',{size:bytes(size),limit:10})}</p>{download}</div> : /\.md(?:own)?$/i.test(name) ? <div className="flex-1 overflow-y-auto overflow-x-hidden text-14 leading-[1.6] text-[var(--msg-tool-card-text)]"><div className="mx-auto max-w-5xl px-6 py-5"><MarkdownRenderer content={text}/></div></div> : <pre className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-13 text-[var(--msg-tool-card-text)]">{text}</pre>}
    </div> : <><div className="absolute right-4 top-4 z-10 flex gap-1 rounded-full border border-[var(--lightbox-toolbar-border)] bg-[var(--lightbox-toolbar-bg)] p-1 text-[var(--lightbox-toolbar-fg)]">{download}{close}</div>
      {imageType(mimeType) && !isDangerousAttachmentName(name) ? <img src={src} alt={name} draggable={false} className="max-h-full max-w-full select-none object-contain" style={{transform:`translate(${viewport.tx}px,${viewport.ty}px) scale(${viewport.scale})`,cursor:viewport.scale>1?'grab':'zoom-in',touchAction:'none'}} onDoubleClick={()=>viewport.scale>1?reset():setViewport(value=>zoomAtPoint(value,{cx:0,cy:0},2,1,8))} onWheel={event=>{const rect=event.currentTarget.parentElement!.getBoundingClientRect();setViewport(value=>zoomAtPoint(value,{cx:event.clientX-rect.left-rect.width/2,cy:event.clientY-rect.top-rect.height/2},wheelZoomFactor(event.deltaY,event.deltaMode),1,8))}} onPointerDown={event=>{if(viewport.scale<=1)return;drag.current={x:event.clientX,y:event.clientY};event.currentTarget.setPointerCapture(event.pointerId)}} onPointerMove={event=>{if(!drag.current)return;const dx=event.clientX-drag.current.x,dy=event.clientY-drag.current.y;drag.current={x:event.clientX,y:event.clientY};setViewport(value=>({...value,tx:value.tx+dx,ty:value.ty+dy}))}} onPointerUp={()=>{drag.current=null}} onPointerCancel={()=>{drag.current=null}}/> : videoType(mimeType) && !isDangerousAttachmentName(name) ? <video src={src} controls className="max-h-full max-w-full"/> : <a href={src} download={name} className="text-15 text-[var(--lightbox-toolbar-fg)]">{t('paseoMedia.download')} · {name}</a>}
    </>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
function Attachment({ groupId, attachment, messageId, tray, localSrc }: { groupId:string; attachment:GroupAttachment; messageId?:string; tray?:boolean; localSrc?:string }) {
  const { t } = useTranslation(); const media = useMedia(groupId, attachment, messageId, !localSrc && attachment.category === 'image' && imageType(attachment.mimeType));
  const [open, setOpen] = useState(false), [content,setContent] = useState<string|undefined>(undefined); const src = localSrc || media.url;
  const preview = async () => { try { await media.read(); if(previewText(attachment)&&attachment.size<=10*1024*1024)setContent(await media.text());setOpen(true); } catch {} };
  return <>
    {attachment.category==='image' && imageType(attachment.mimeType) && !src && !tray ? <button type="button" disabled={media.loading} onClick={()=>void preview()} className="w-[280px] max-w-full"><div className="flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted p-4 text-muted-foreground">{media.loading?<LoaderCircle className="h-8 w-8 animate-spin text-[var(--text-tertiary)]"/>:<ImageOff className="h-8 w-8 text-[var(--text-tertiary)]"/>}<span className="text-xs font-medium">{t(media.loading?'chat.imageMissing.loading':'chat.imageMissing.unavailable')}</span><span className="max-w-full truncate text-11 text-[var(--text-tertiary)]">{attachment.name}</span></div></button> : attachment.category==='image' && imageType(attachment.mimeType) && src ? <button type="button" onClick={() => void preview()} aria-label={t('paseoMedia.preview', {name:attachment.name})} className={tray ? 'h-full w-full' : 'block w-fit max-w-full rounded-xl transition-opacity hover:opacity-90'}><img src={src} alt={attachment.name} draggable={false} className={tray ? 'h-full w-full rounded-lg object-cover' : 'max-h-[180px] max-w-[280px] rounded-xl object-contain'}/></button> : <button type="button" disabled={media.loading} onClick={() => void preview()} title={attachment.name} className={tray ? 'flex h-full w-full items-center gap-2 rounded-xl bg-[var(--surface-chip)] px-2 text-left' : 'flex h-7 max-w-[280px] items-center gap-1.5 rounded-full bg-[var(--surface-chip)] px-2.5 py-1.5 text-13 text-[var(--text-secondary)]'}>
      {tray ? <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-elevated)]"><FileTypeTile name={attachment.name} mimeType={attachment.mimeType}/></span> : media.loading ? <Spinner size={13}/> : <File size={13} className="shrink-0"/>}<span className="min-w-0 truncate">{attachment.name}{tray && <span className="block truncate text-11 text-[var(--text-secondary)]">{bytes(attachment.size)}</span>}</span>
    </button>}
    {media.error && <p role="alert" className="max-w-[280px] text-12 text-[var(--text-danger)]">{media.error}</p>}
    {open && <MediaPreview name={attachment.name} mimeType={attachment.mimeType} src={media.url} size={attachment.size} textFile={previewText(attachment)} text={content} open onClose={() => setOpen(false)}/>}
  </>;
}
export function GroupMessageAttachments({ groupId, attachments, messageId, align = 'left' }: { groupId:string; attachments:readonly GroupAttachment[]; messageId?:string; align?:'left'|'right' }) {
  if (!attachments.length) return null;
  // Preserve original ordering: images occupy their own rows, adjacent file chips wrap together.
  const rows:GroupAttachment[][] = [];
  for (const item of attachments) { if (imageType(item.mimeType) || !rows.length || imageType(rows.at(-1)![0].mimeType)) rows.push([item]); else rows.at(-1)!.push(item); }
  return <div data-testid="bot-group-message-attachments" className={`flex min-w-0 max-w-full flex-col gap-2 ${align === 'right' ? 'items-end' : 'items-start'}`}>{rows.map((row,index) => <div key={index} className={`flex min-w-0 max-w-full flex-wrap gap-1.5 ${align === 'right' ? 'justify-end' : ''}`}>{row.map(item => <Attachment key={item.mediaId} groupId={groupId} attachment={item} messageId={messageId}/>)}</div>)}</div>;
}
export function GroupComposerAttachments({ groupId, uploads, remove, retry }: { groupId:string; uploads:ComposerUpload[]; remove(id:string):Promise<void>; retry(id:string):void }) {
  const { t } = useTranslation();
  if (!uploads.length) return null;
  return <div className="scrollbar-hide flex items-center gap-2 overflow-x-auto pb-2 pl-0 pr-2 pt-2">{uploads.map(item => <div key={item.id} className="group relative shrink-0" style={item.preview || imageType(item.mimeType) && item.attachment ? {width:56,height:56} : {height:56,maxWidth:220}}>
    {item.attachment ? <Attachment groupId={groupId} attachment={item.attachment} tray localSrc={item.preview}/> : item.preview ? <img src={item.preview} alt={item.name} className="h-full w-full rounded-lg object-cover" draggable={false}/> : <div className="flex h-full w-full items-center gap-2 rounded-xl bg-[var(--surface-chip)] px-2"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-elevated)]"><FileTypeTile name={item.name} mimeType={item.mimeType}/></span><span className="min-w-0 truncate text-xs text-[var(--text-primary)]">{item.name}<span className="block text-11 text-[var(--text-secondary)]">{bytes(item.size)}</span></span></div>}
    {item.status !== 'sealed' && <span role={item.error ? 'alert' : 'status'} title={item.error} className="absolute inset-x-0 bottom-0 flex items-center justify-center rounded-b-lg bg-[var(--surface-elevated)] text-11 text-[var(--text-secondary)]">{item.status === 'failed' ? <button type="button" disabled={item.intent.cancelled} onClick={() => retry(item.id)} aria-label={t('bots.retry')}><RefreshCcw size={12}/></button> : <Spinner size={10}/>} {item.error ? t('bots.groupChat.outbox.failed') : t('paseoMedia.uploading', {percent:Math.round(item.progress * 100)})}</span>}
    <button type="button" disabled={item.status === 'cancelling'} onClick={() => void remove(item.id).catch(() => {})} aria-label={t('paseoMedia.remove', {name:item.name})} className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--file-remove-bg)] text-white opacity-0 transition-opacity hover:opacity-100 focus:opacity-100 group-hover:opacity-100"><X size={10}/></button>
    {item.error && <span className="sr-only" role="alert">{item.error}</span>}
  </div>)}</div>;
}
export function UploadLeaveDialog({ open, busy, error, stay, leave }: {open:boolean;busy:boolean;error:string;stay():void;leave():void}) {
  const {t} = useTranslation();
  return <Dialog.Root open={open} onOpenChange={value => { if (!value && !busy) stay(); }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"/><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-[var(--text-primary)]"><Dialog.Title className="text-15 font-medium">{t('paseoMedia.leaveTitle')}</Dialog.Title><Dialog.Description className="mt-2 text-13 text-[var(--text-secondary)]">{t('paseoMedia.leaveBody')}</Dialog.Description>{error && <p role="alert" className="mt-2 text-12 text-[var(--text-danger)]">{error}</p>}<div className="mt-4 flex justify-end gap-2"><Button variant="secondary" disabled={busy} onClick={stay}>{t('paseoMedia.stay')}</Button><Button loading={busy} onClick={leave}>{t('paseoMedia.cancelLeave')}</Button></div></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
