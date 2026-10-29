// Original BotGroupSettingsDrawer field/row geometry; Paseo-supported group mutations.
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../vendor/renderer/components/ui/button';
import { Input } from '../vendor/renderer/components/ui/input';
import { FormField } from '../vendor/renderer/components/ui/form-field';
import { SegmentedControl } from '../vendor/renderer/components/ui/segmented-control';
import { useConfirmDialog } from '../vendor/renderer/components/ui/confirm-dialog-provider';
import { BotAvatar } from '../vendor/renderer/features/bots/BotAvatar';
import { BotGroupAvatarStack } from '../vendor/renderer/features/bots/BotGroupAvatars';
import { useBotProfiles } from './adapters/bot-store';
import { invoke, post } from './bridge';
import type { GroupSummary } from '../shared/groups';
import type { GroupPlanSettings } from '../shared/group-plans';
import type { WorkPlanController } from './work-plan';
import { WorkProjectDirectory } from './work-directory';
import { BotGroupOrganizerTag } from '../vendor/renderer/features/bots/BotGroupPlan';
import { GroupCleanupNotice } from './group-cleanup';
import { executionErrorText, executionMessage } from '../shared/execution-notice';

export function GroupSettings({ group, onClose, onChanged, planSettings, planControl, planError }: { group: GroupSummary; onClose(): void; onChanged(): void; planSettings?: GroupPlanSettings; planControl?: WorkPlanController; planError?: string }) {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  const bots = useBotProfiles();
  const [name, setName] = useState(group.name), [picking, setPicking] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), alive = useRef(true);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const savedName = useRef(group.name), draftName = useRef(name), revision = useRef(group.revision);
  draftName.current = name;
  revision.current = Math.max(revision.current, group.revision);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (draftName.current === savedName.current) setName(group.name);
    savedName.current = group.name;
  }, [group.name]);
  const deleting = group.mutation === 'deleting';
  const memberIds = group.members.map(member => member.botId);
  const addable = bots.filter(bot => bot.status === 'active' && bot.enabled && !memberIds.includes(bot.id));
  const mutate = (op: string, fields: Record<string, unknown>): Promise<boolean> => {
    if ((deleting && op !== 'groups.delete' && op !== 'groups.cleanup') || lock.current || !alive.current) return Promise.resolve(false);
    lock.current = true; setBusy(true); setError('');
    const request = (async () => {
      try {
        const result = await invoke<{ group?: GroupSummary }>(op, { groupId: group.id, ...(op === 'groups.cleanup' ? {} : { expectedRevision: revision.current }), ...fields });
        if (alive.current) {
          if (result.group) revision.current = result.group.revision;
          if (typeof fields.name === 'string') savedName.current = fields.name;
          setPicking(false); post('groups-changed'); onChanged();
        }
        return true;
      } catch (reason) { if (alive.current) setError(executionErrorText(reason)); return false; }
      finally { lock.current = false; inFlight.current = null; if (alive.current) setBusy(false); }
    })();
    inFlight.current = request;
    return request;
  };
  const saveName = async () => {
    if (deleting) return;
    const value = draftName.current.trim();
    if (!value) { setError(t('bots.groupChat.create.nameRequired')); return; }
    if (value === savedName.current) return;
    await mutate('groups.update', { name: value });
  };
  const close = async () => {
    if (inFlight.current && !await inFlight.current) return;
    if (!alive.current) return;
    if (deleting) { onClose(); return; }
    const value = draftName.current.trim();
    if (!value) { setError(t('bots.groupChat.create.nameRequired')); return; }
    if (value !== savedName.current && !await mutate('groups.update', { name: value })) return;
    if (alive.current) onClose();
  };
  useEffect(() => {
    const requested = () => { void close(); };
    window.addEventListener('cindy-request-close', requested);
    return () => window.removeEventListener('cindy-request-close', requested);
  });
  return <Dialog.Root open onOpenChange={open => { if (!open) void close(); }}><Dialog.Portal><Dialog.Overlay className="modal-scrim fixed inset-0 z-50"><Dialog.Content onPointerDownOutside={event => event.preventDefault()} aria-describedby={undefined}
    className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-[var(--border-default)] bg-[var(--surface)] outline-none">
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-default)] px-5"><Dialog.Title className="text-15 font-medium text-[var(--text-primary)]">{t('bots.groupChat.settings.title')}</Dialog.Title><button onClick={() => void close()} disabled={busy} aria-label={t('bots.close')} className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]"><X size={17}/></button></header>
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
      <div className="flex flex-col items-center gap-3 py-2"><BotGroupAvatarStack members={group.members} size="md"/><p className="text-12 text-[var(--text-tertiary)]">{t('bots.groupChat.memberCount', { count: group.members.length })}</p></div>
      <FormField label={t('bots.groupChat.nameLabel')}>{control => <Input {...control} size="md" value={name} maxLength={40} disabled={busy || deleting} onChange={setName} onBlur={() => { void saveName(); }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void saveName(); } }}/>}</FormField>
      <section className="flex flex-col gap-2"><h3 className="text-13 font-medium text-[var(--settings-section-title)]">{t('bots.groupChat.settings.members')}</h3><div className="overflow-hidden rounded-xl border border-[var(--border-default)]">
        {group.members.map(member => <div key={member.botId} className="flex min-h-11 items-center gap-2.5 border-b border-[var(--border-default)] px-3 py-2 text-13 text-[var(--text-primary)]"><BotAvatar bot={member} size="sm"/><span className="flex min-w-0 flex-1 items-center gap-2"><span className="min-w-0 truncate">{member.name}</span>{planSettings?.organizerBotId === member.botId && <BotGroupOrganizerTag/>}</span>{planSettings && planControl && planSettings.organizerBotId !== member.botId && member.status === 'active' && <Button type="button" variant="secondary" tone="quiet" size="xs" compact disabled={busy || deleting || Boolean(planControl.pending)} aria-label={t('bots.groupChat.settings.setOrganizerNamed', { name: member.name })} onClick={() => void planControl.settings(planSettings, { organizerBotId: member.botId })}>{t('bots.groupChat.settings.setOrganizer')}</Button>}<Button variant="secondary" tone="quiet" size="xs" compact disabled={busy || deleting || group.members.length <= 2} aria-label={t('bots.groupChat.settings.removeNamed', { name: member.name })} onClick={() => void mutate('groups.setMembers', { botIds: memberIds.filter(id => id !== member.botId) })}>{t('bots.groupChat.settings.remove')}</Button></div>)}
        <button disabled={busy || deleting || group.members.length >= 6} aria-expanded={picking} onClick={() => setPicking(value => !value)} className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left text-13 text-[var(--text-secondary)] enabled:hover:bg-[var(--surface-hover)] disabled:opacity-60"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-dashed border-[var(--text-tertiary)]"><Plus size={13}/></span>{t('bots.add')}</button>
        {picking && <div className="flex flex-col gap-0.5 border-t border-[var(--border-default)] p-1">{addable.length ? addable.map(bot => <button key={bot.id} disabled={busy || deleting} onClick={() => void mutate('groups.setMembers', { botIds: [...memberIds, bot.id] })} className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-13 text-[var(--text-primary)] enabled:hover:bg-[var(--model-item-hover)]"><BotAvatar bot={bot} size="sm"/><span className="min-w-0 flex-1 truncate">{bot.name}</span><Plus size={14}/></button>) : <p className="px-2.5 py-2 text-12 text-[var(--text-tertiary)]">{t('bots.groupChat.settings.noMoreBots')}</p>}</div>}
      </div>{planSettings && <p className="text-12 leading-normal text-[var(--text-tertiary)]">{t('bots.groupChat.settings.organizerNote')}</p>}</section>
      {planSettings && planControl && <WorkProjectDirectory groupId={group.id} settings={planSettings} control={planControl} disabled={deleting}/>}
      {planError && <p role="alert" className="text-12 text-[var(--error-fg)]">{executionMessage(planError, i18n.language)}</p>}
      <section className="flex flex-col gap-2" aria-labelledby="bot-group-settings-reply"><h3 id="bot-group-settings-reply" className="text-13 font-medium text-[var(--settings-section-title)]">{t('bots.groupChat.settings.replyMode')}</h3><SegmentedControl<'all' | 'mentioned'> aria-label={t('bots.groupChat.settings.replyMode')} value={group.replyMode} fullWidth disabled={busy || deleting} options={[
        { value: 'all', label: t('bots.groupChat.settings.replyModeAll') },
        { value: 'mentioned', label: t('bots.groupChat.settings.replyModeMentioned') },
      ]} onValueChange={value => { if (value !== group.replyMode) void mutate('groups.update', { replyMode: value }); }}/><p className="text-12 leading-normal text-[var(--text-tertiary)]">{t('bots.groupChat.settings.replyModeNote')}</p></section>
      {error && <p role="alert" className="text-12 text-[var(--error-fg)]">{executionMessage(error, i18n.language)}</p>}
      <GroupCleanupNotice pending={group.cleanupPending} busy={busy} onConfirm={() => void mutate('groups.cleanup', {})}/>
      <Button variant="secondary" onClick={async () => { if (await confirm({ title: t('bots.groupChat.settings.deleteConfirmTitle', { name: group.name }), description: t('bots.groupChat.settings.deleteNote'), confirmText: t('bots.groupChat.settings.delete'), confirmVariant: 'destructive' })) { if (alive.current && await mutate('groups.delete', {}) && alive.current) post('close'); } }} disabled={busy}>{t('bots.groupChat.settings.delete')}</Button>
    </div>
  </Dialog.Content></Dialog.Overlay></Dialog.Portal></Dialog.Root>;
}
