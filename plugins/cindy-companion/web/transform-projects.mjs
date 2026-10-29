// Keep the original linked-project JSX; add only CAS-error and owner lifetime guards.
export function transformBotProjects(source) {
  return source
    .replace("import { useBotTranslation } from './botPronounContext';", "import { useBotTranslation } from './botPronounContext';\nimport { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';")
    .replace('  const { t } = useBotTranslation();', '  const { t } = useBotTranslation();\n  const owner = getDataOwnerGeneration();\n  const alive = useRef(false);')
    .replace('  const load = useCallback(async () => {\n', '  const load = useCallback(async () => {\n    if (!alive.current || !isDataOwnerGenerationCurrent(owner)) return;\n')
    .replaceAll('token === generation.current', 'token === generation.current && alive.current && isDataOwnerGenerationCurrent(owner)')
    .replace('  }, [botId]);', '  }, [botId, owner]);')
    .replace('  useEffect(() => {\n    void load();', '  useEffect(() => {\n    alive.current = true;\n    void load();')
    .replace('return () => { generation.current++; unsubscribe(); };', 'return () => { alive.current = false; generation.current++; unsubscribe(); };')
    .replace('    if (inFlight.current) return;', '    if (inFlight.current || error || !alive.current || !isDataOwnerGenerationCurrent(owner)) return;')
    .replace('compact disabled={busy} aria-label', 'compact disabled={busy || error} aria-label')
    .replace('disabled={busy || !available.length}', 'disabled={busy || error || !available.length}')
    .replace('disabled={busy || !available.some', 'disabled={busy || error || !available.some');
}

export function extractLinkedProjectTypes(source) {
  const start = source.indexOf('/** Project references provide context');
  const end = source.indexOf('/** 一件任务最近内容');
  if (start < 0 || end <= start) throw new Error('The pinned linked-project type boundaries changed.');
  return '// Extracted original linked-project types; unrelated workbench task logic is not included.\n'
    + source.slice(start, end).trimEnd() + '\n';
}
