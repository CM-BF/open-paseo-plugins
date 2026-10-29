/** Reproducible platform-only changes to the pinned original teammate creation dialog. */
export function transformBotRoster(source) {
  let code = source
    .replace("import { BotImportForm } from './BotImportForm';", "import { showHostSettingsNotice } from '@/features/bots/paseoHostStatus';")
    .replace('onCreated?: (bot: BotProfile) => void;', 'onCreated?: (bot: BotProfile) => void | Promise<void>;')
    .replace('  const [importing, setImporting] = useState(false);', '  const importing = false;')
    .replace('  const submitting = useRef(false);', '  const submitting = useRef(false);\n  const preparingPortrait = useRef(false);\n  const [portraitPreparing, setPortraitPreparing] = useState(false);')
    .replace("  const close = () => { if (onClose) onClose(); else navigate('/bots'); };", `  const close = () => { if (submitting.current || preparingPortrait.current) return; alive.current = false; if (onClose) onClose(); else navigate('/bots'); };
  useEffect(() => {
    window.addEventListener('cindy-request-close', close);
    return () => window.removeEventListener('cindy-request-close', close);
  });`)
    .replace('if (!name.trim() || duplicate || submitting.current || !portrait) return;', 'if (!name.trim() || duplicate || submitting.current || preparingPortrait.current || !portrait) return;')
    .replace('    try {\n      const bot', '    const owner = getDataOwnerGeneration();\n    try {\n      const bot')
    .replace('if (!alive.current) return;\n      if (onCreated) onCreated(bot); else navigate(`/bots/${bot.id}`);\n      onClose?.();', 'if (!alive.current || !isDataOwnerGenerationCurrent(owner)) return;\n      if (onCreated) await onCreated(bot);\n      else { navigate(`/bots/${bot.id}`); onClose?.(); }')
    .replace('if (alive.current) setError(t(cause instanceof', 'if (alive.current && isDataOwnerGenerationCurrent(owner)) setError(t(cause instanceof')
    .replace('if (alive.current) setCreating(false);', 'if (alive.current && isDataOwnerGenerationCurrent(owner)) setCreating(false);')
    .replace('<BotPortraitPicker value={portrait} disabled={creating} onChange={setPortrait} />', '<BotPortraitPicker value={portrait} disabled={creating} onChange={setPortrait} onPreparingChange={pending => { preparingPortrait.current = pending; setPortraitPreparing(pending); }} />')
    .replace('disabled={creating || !name.trim() || duplicate || !portrait}', 'disabled={creating || portraitPreparing || !name.trim() || duplicate || !portrait}')
    .replace("              navigate('/settings?tab=providers');", '              showHostSettingsNotice();')
    .replace("disabled={creating} onClick={() => setImporting(true)}>{t('bots.import.entry')}", "disabled title={t('paseoIntegration.importUnavailable')}>{t('bots.import.entry')}");
  const importStart = code.indexOf('    {importing ? <BotImportForm ');
  const formStart = code.indexOf('<form onSubmit=', importStart);
  if (importStart < 0 || formStart < 0) throw new Error('Pinned BotRosterView import branch changed');
  code = code.slice(0, importStart) + '    {' + code.slice(formStart);
  return code;
}
