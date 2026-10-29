import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../vendor/renderer/components/ui/button';
import { Tip } from '../vendor/renderer/components/ui/tooltip';
import { botGroupPathBasename } from '../vendor/shared/botGroupWorkPresentation';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '../vendor/renderer/contexts/dataOwnerGeneration';
import type { GroupPlanSettings } from '../shared/group-plans';
import type { WorkPlanController } from './work-plan';
import { invoke } from './bridge';

type DirectoryListing = { path: string; parent: string | null; directories: { name: string; path: string }[]; truncated?: boolean };

/** Original Folder row; the public host lacks Electron's native directory dialog. */
export function WorkProjectDirectory({ groupId, settings, control, disabled = false }: { groupId: string; settings: GroupPlanSettings; control: WorkPlanController; disabled?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false), [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0), writing = useRef(false);
  const owner = getDataOwnerGeneration();
  const scope = useMemo(() => ({ active: false, owner }), [groupId, owner.dataOwnerId, owner.generation]);
  const current = () => scope.active && isDataOwnerGenerationCurrent(scope.owner);
  useLayoutEffect(() => {
    scope.active = true; setOpen(false); setListing(null); setLoading(false); setError('');
    return () => { scope.active = false; sequence.current++; };
  }, [scope]);
  const read = async (path?: string) => {
    if (disabled || !current() || writing.current) return;
    const own = ++sequence.current; setLoading(true); setError(''); setOpen(true);
    try {
      const result = await invoke<DirectoryListing>('groups.plans.directories', { groupId, ...(path ? { path } : {}) });
      if (current() && sequence.current === own) setListing(result);
    } catch (reason) { if (current() && sequence.current === own) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (current() && sequence.current === own) setLoading(false); }
  };
  const save = async (projectDir: string | null) => {
    if (disabled || !current() || writing.current || control.pending) return;
    writing.current = true;
    try { if (await control.settings(settings, { projectDir }) && current()) { sequence.current++; setOpen(false); setLoading(false); } }
    finally { writing.current = false; }
  };
  const busy = disabled || Boolean(control.pending);
  return <section className="flex flex-col gap-2" aria-labelledby="bot-group-settings-project">
    <h3 id="bot-group-settings-project" className="text-13 font-medium text-[var(--settings-section-title)]">{t('bots.groupChat.settings.projectDir')}</h3>
    <div className="overflow-hidden rounded-xl border border-[var(--border-default)]"><div data-testid="bot-group-project-dir" className="flex min-h-11 items-center gap-2.5 px-3 py-2 text-13 text-[var(--text-primary)]">
      <Folder size={16} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
      {settings.projectDir ? <Tip text={settings.projectDir}><span className="min-w-0 flex-1 truncate">{botGroupPathBasename(settings.projectDir)}</span></Tip> : <span className="min-w-0 flex-1 truncate text-[var(--text-tertiary)]">{t('bots.groupChat.settings.projectDirNone')}</span>}
      {settings.projectDir && <Button type="button" variant="secondary" tone="quiet" size="xs" compact disabled={busy} onClick={() => void save(null)}>{t('bots.groupChat.settings.projectDirClear')}</Button>}
      <Button type="button" variant="secondary" tone="quiet" size="xs" compact disabled={busy} loading={loading} onClick={() => void read(settings.projectDir ?? undefined)}>{t(settings.projectDir ? 'bots.groupChat.settings.projectDirChange' : 'bots.groupChat.settings.projectDirChoose')}</Button>
    </div>
    {open && <div data-testid="work-directory-browser" className="flex flex-col gap-2 border-t border-[var(--border-default)] p-3">
      <p className="break-all text-12 text-[var(--text-secondary)]">{listing?.path ?? t('paseoWork.directory.loading')}</p>
      <div className="max-h-60 overflow-y-auto">
        {listing?.parent && <button disabled={loading || busy} onClick={() => void read(listing.parent!)} className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-13 hover:bg-[var(--surface-hover)] disabled:opacity-50"><ArrowUp size={14}/>{t('paseoWork.directory.parent')}</button>}
        {listing?.directories.map(item => <button key={item.path} disabled={loading || busy} onClick={() => void read(item.path)} className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-13 hover:bg-[var(--surface-hover)] disabled:opacity-50"><Folder size={14}/><span className="min-w-0 flex-1 truncate">{item.name}</span><ChevronRight size={13}/></button>)}
      </div>
      {listing?.truncated && <p className="text-12 text-[var(--text-tertiary)]">{t('paseoWork.directory.truncated')}</p>}
      {error && <p role="alert" className="break-words text-12 text-[var(--error-fg)]">{error}</p>}
      <div className="flex items-center gap-2"><Button variant="cta" size="sm" compact disabled={!listing || loading || busy || Boolean(error)} onClick={() => listing && void save(listing.path)}>{t('paseoWork.directory.select')}</Button><Button variant="secondary" tone="quiet" size="sm" compact disabled={busy} onClick={() => { sequence.current++; setOpen(false); setLoading(false); }}>{t('common.cancel')}</Button></div>
    </div>}</div>
    <p className="text-12 leading-normal text-[var(--text-tertiary)]">{t('bots.groupChat.settings.projectDirNote')}</p>
  </section>;
}
