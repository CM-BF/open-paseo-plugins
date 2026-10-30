// Original BotGroupTimelineItem outbox row/status structure, with durable host receipts.
import { useEffect, useRef, useState } from 'react';
import { CircleAlert, RefreshCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { invoke } from './bridge';
import type { GroupOutboxEntry, GroupOutboxInput, GroupOutboxPage } from '../shared/group-outbox';
import { Button } from '../vendor/renderer/components/ui/button';
import { GroupMessageAttachments } from './group-media-view';

export interface OutboxIntent { signature: string; clientMessageId: string; operationId: string; attempted?: boolean }
type Request = <T>(op: string, args: Record<string, unknown>) => Promise<T>;
/** A missing lookup is not proof of no attempt: enqueue replays the same durable identity. */
export async function acceptGroupOutbox(input: GroupOutboxInput, intent: OutboxIntent, request: Request = invoke) {
  if (intent.attempted) {
    try {
      const known = await request<{entry:GroupOutboxEntry}>('groups.outbox.reconcile', {groupId:input.groupId,clientMessageId:intent.clientMessageId});
      if (known.entry.groupId !== input.groupId || known.entry.clientMessageId !== input.clientMessageId) throw new Error('The host returned another queued message.');
      return known.entry;
    } catch (reason) { if ((reason as {code?:string}).code !== 'NOT_FOUND') throw reason; }
  }
  intent.attempted = true;
  const result = await request<{ accepted: true; entry: GroupOutboxEntry }>('groups.outbox.enqueue', { ...input, operationId: intent.operationId });
  if (!result.accepted || result.entry.groupId !== input.groupId || result.entry.clientMessageId !== input.clientMessageId) throw new Error('The host did not confirm this queued message.');
  return result.entry;
}
export function mergeOutbox(previous: GroupOutboxEntry[], incoming: GroupOutboxEntry[]) {
  const rows = new Map(previous.map(entry => [entry.clientMessageId, entry]));
  for (const entry of incoming) if (!rows.has(entry.clientMessageId) || rows.get(entry.clientMessageId)!.revision <= entry.revision) rows.set(entry.clientMessageId, entry);
  return [...rows.values()].sort((a, b) => a.sequence - b.sequence);
}
export function useGroupOutbox(groupId: string, onAccepted: () => void) {
  const [entries, setEntries] = useState<GroupOutboxEntry[]>([]), [error, setError] = useState(''), [before, setBefore] = useState<number|null>(null), [busy, setBusy] = useState(false);
  const alive = useRef(true), rows = useRef(entries), polling = useRef(false), lock = useRef(false), notify = useRef(onAccepted); rows.current = entries; notify.current = onAccepted;
  const intents = useRef(new Map<string, string>()), pageOpened = useRef(false);
  const merge = (incoming: GroupOutboxEntry[]) => {
    if (!alive.current) return;
    if (incoming.some(entry => entry.groupId !== groupId)) throw new Error('The host returned another group’s outbox.');
    if (incoming.some(entry => entry.status === 'sent' && rows.current.find(old => old.clientMessageId === entry.clientMessageId)?.status !== 'sent')) notify.current();
    setEntries(previous => mergeOutbox(previous, incoming));
  };
  const refresh = async () => {
    if (!alive.current || polling.current) return; polling.current = true;
    try {
      const value = await invoke<GroupOutboxPage>('groups.outbox.list', { groupId });
      if (!alive.current) return;
      merge(value.entries); if (!pageOpened.current) setBefore(value.nextBefore);
      // Old pending receipts may be outside the newest page. Query those exact IDs.
      for (const entry of rows.current) if (['queued', 'sending', 'unknown'].includes(entry.status) && !value.entries.some(item => item.clientMessageId === entry.clientMessageId)) {
        if (!alive.current) return;
        const result = await invoke<{entry:GroupOutboxEntry}>('groups.outbox.reconcile', { groupId, clientMessageId: entry.clientMessageId }); merge([result.entry]);
      }
      if (alive.current) setError('');
    } catch (reason) { if (alive.current) setError(String((reason as Error).message ?? reason)); }
    finally { polling.current = false; }
  };
  useEffect(() => { alive.current = true; void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => { alive.current = false; clearInterval(timer); }; }, [groupId]);
  const action = async (entry: GroupOutboxEntry, kind: 'retry'|'reconcile'|'discard'|'edit') => {
    if (lock.current) return null; lock.current = true; setBusy(true); setError('');
    const key = `${entry.clientMessageId}:${kind}`;
    if (!intents.current.has(key)) intents.current.set(key, crypto.randomUUID());
    try {
      const result = await invoke<{entry:GroupOutboxEntry}>('groups.outbox.' + kind, { groupId, clientMessageId: entry.clientMessageId, ...(kind !== 'reconcile' ? { operationId: intents.current.get(key) } : {}) });
      if (!alive.current) return null;
      merge([result.entry]); intents.current.delete(key); return result.entry;
    } catch (reason) { if (alive.current) setError(String((reason as Error).message ?? reason)); return null; }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  return { entries, error, before, busy, accept: (entry: GroupOutboxEntry) => { merge([entry]); void refresh(); }, refresh, action,
    async older() { if (!before || lock.current) return; lock.current = true; setBusy(true); try { const value = await invoke<GroupOutboxPage>('groups.outbox.list', { groupId, before }); if (alive.current) { merge(value.entries); pageOpened.current = true; setBefore(value.nextBefore); } } catch (reason) { if (alive.current) setError(String((reason as Error).message ?? reason)); } finally { lock.current = false; if (alive.current) setBusy(false); } },
  };
}
export function GroupOutboxRows({ outbox, groupId, readOnly, canEdit, onEdit }: { outbox: ReturnType<typeof useGroupOutbox>; groupId: string; readOnly: boolean; canEdit(entry:GroupOutboxEntry):boolean; onEdit(entry: GroupOutboxEntry): void }) {
  const { t } = useTranslation();
  const editable = (entry: GroupOutboxEntry) => entry.status === 'failed' && entry.recovery === 'retry';
  return <>
    {outbox.before !== null && <div className="mt-3 flex justify-center"><Button variant="secondary" size="sm" compact disabled={outbox.busy} onClick={() => void outbox.older()}>{t('paseoMedia.olderOutbox')}</Button></div>}
    {outbox.entries.filter(entry => entry.status !== 'sent' && entry.status !== 'discarded').map(entry => <div key={entry.clientMessageId} data-testid="bot-group-outbox" data-status={entry.status} aria-busy={entry.status === 'sending' || entry.status === 'queued'} className="mt-3.5 flex justify-end">
      <div className="flex min-w-0 max-w-[min(720px,calc(100%-120px))] flex-col items-end gap-1.5">
        <div className={`flex max-w-full flex-col gap-2 rounded-xl border border-[var(--msg-user-border)] bg-[var(--msg-user-bg)] px-3.5 py-2 text-15 leading-[1.6] text-[var(--msg-user-text)] ${entry.status === 'queued' || entry.status === 'sending' ? 'opacity-60' : ''}`}><p className="whitespace-pre-wrap break-words">{entry.input.text}</p><GroupMessageAttachments groupId={groupId} attachments={entry.attachments} align="right"/></div>
        {entry.status === 'queued' || entry.status === 'sending' ? <p role="status" className="select-none text-12 leading-[1.33] text-[var(--text-tertiary)]">{t(entry.status === 'queued' ? 'paseoMedia.queued' : 'bots.groupChat.outbox.sending')}</p> : <div role="alert" className="flex flex-wrap items-center justify-end gap-2"><span className="flex select-none items-center gap-1 text-12 leading-[1.33] text-[var(--text-danger)]"><CircleAlert size={13} aria-hidden className="shrink-0"/>{entry.error?.message || t('bots.groupChat.outbox.failed')}</span>
          {editable(entry) && <Button variant="secondary" size="sm" compact disabled={readOnly || outbox.busy || !canEdit(entry)} onClick={() => { if (canEdit(entry)) onEdit(entry); }}>{t('bots.groupChat.outbox.edit')}</Button>}
          {entry.recovery !== 'none' && <Button variant="secondary" size="sm" compact disabled={readOnly || outbox.busy} onClick={() => void outbox.action(entry, entry.recovery === 'reconcile' ? 'reconcile' : 'retry')}><RefreshCcw size={13}/>{t(entry.recovery === 'reconcile' ? 'paseoMedia.reconcile' : 'bots.retry')}</Button>}
        </div>}
      </div>
    </div>)}
  </>;
}
