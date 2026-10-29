// Extracted from Cindy BotGroupComposer's division tag and + menu item; no send policy lives here.
import { Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DropdownMenuItem } from '../vendor/renderer/components/ui/dropdown-menu';
import { Tip } from '../vendor/renderer/components/ui/tooltip';
import { MENU_ITEM_CLASS } from '../vendor/renderer/features/cc-agent/sidebar/menuStyles';
import { cn } from '../vendor/renderer/lib/utils';

export function WorkDivisionTag({ onRemove }: { onRemove(): void }) {
  const { t } = useTranslation();
  const removeDivisionLabel = t('bots.groupChat.composer.removeDivision');
  return <div className="flex"><span data-testid="bot-group-division-tag" className="inline-flex h-6 select-none items-center gap-1 rounded-full bg-[var(--surface-chip)] pl-2 pr-0.5 text-12 font-medium text-[var(--text-primary)]">
    <Users size={12} aria-hidden className="text-[var(--text-secondary)]" />
    {t('bots.groupChat.composer.divisionTag')}
    <Tip text={removeDivisionLabel}><button type="button" aria-label={removeDivisionLabel} onClick={onRemove}
      className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--button-primary-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"><X size={12} /></button></Tip>
  </span></div>;
}

export function WorkDivisionMenuItem({ blocked, writtenSteps, onSelect }: { blocked: boolean; writtenSteps: boolean; onSelect(): void }) {
  const { t } = useTranslation();
  return <DropdownMenuItem disabled={blocked} className={cn(MENU_ITEM_CLASS, 'h-auto items-start gap-2.5 py-2')} onSelect={onSelect}>
    <Users size={16} aria-hidden className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
    <span className="flex min-w-0 flex-col gap-0.5"><span>{t('bots.groupChat.composer.division')}</span>
      <span className="text-12 leading-[1.33] text-[var(--cmd-palette-item-meta)]">{t(blocked ? 'bots.groupChat.composer.divisionBusy' : writtenSteps ? 'bots.groupChat.composer.divisionDescriptionSteps' : 'bots.groupChat.composer.divisionDescription')}</span>
    </span>
  </DropdownMenuItem>;
}
