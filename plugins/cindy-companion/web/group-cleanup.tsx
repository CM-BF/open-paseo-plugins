import { useTranslation } from 'react-i18next';
import type { GroupSummary } from '../shared/groups';
import { executionMessage } from '../shared/execution-notice';
import { Button } from '../vendor/renderer/components/ui/button';
import { post } from './bridge';

/** Cleanup is a read-only confirmation of the native session state, never an archive action. */
export function GroupCleanupNotice({ pending, busy, onConfirm }: {
  pending: GroupSummary['cleanupPending']; busy: boolean; onConfirm(): void;
}) {
  const { t, i18n } = useTranslation();
  if (!pending?.length) return null;
  return <section className="flex flex-col gap-2 text-12 text-[var(--text-secondary)]">
    {pending.map(item => <div key={item.agentId} className="flex flex-wrap items-center gap-2">
      <p role="status" className="min-w-0 break-words">{item.title} · {executionMessage(item.code, i18n.language)}</p>
      <Button variant="secondary" tone="quiet" size="sm" compact onClick={() => post('navigate-agent', { agentId: item.agentId })}>{t('paseoGroups.openTask')}</Button>
    </div>)}
    <div><Button variant="secondary" tone="quiet" size="sm" compact disabled={busy} onClick={onConfirm}>{t('paseoWork.confirmCleanup')}</Button></div>
  </section>;
}
