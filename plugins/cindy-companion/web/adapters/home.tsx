// Cindy BotHomeComputerSetting's original row and dropdown classes; host information comes from Paseo.
import { ChevronRight, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../vendor/renderer/components/ui/dropdown-menu';
import { useSnapshot } from '../state';
export function BotHomeComputerSetting({ className = 'mt-3' }: { bot: {id:string;name:string}; className?: string }) {
  const { t, i18n } = useTranslation();
  const home = useSnapshot()?.home;
  if (!home) return null;
  return <div className={className}><div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"><DropdownMenu><DropdownMenuTrigger asChild><button type="button" data-testid="bot-home-computer-row" className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left text-14 text-[var(--text-primary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"><Monitor size={18} className="shrink-0 text-[var(--text-secondary)]"/><span className="min-w-0 flex-1">{t('bots.cloud.homeLabel')}</span><span className="min-w-0 max-w-48 truncate text-13 text-[var(--text-secondary)]">{home.name}</span><ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]"/></button></DropdownMenuTrigger><DropdownMenuContent align="end" className="min-w-56 max-w-80"><DropdownMenuItem disabled>{home.name}</DropdownMenuItem><DropdownMenuItem disabled className="whitespace-normal">{i18n.language==='zh-CN' ? '此主机尚不支持迁移伙伴。' : 'Moving this companion to another computer is not supported yet.'}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div></div>;
}
