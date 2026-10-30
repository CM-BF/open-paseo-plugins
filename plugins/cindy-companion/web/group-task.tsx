import { useLayoutEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupMessage } from '../shared/groups';
import { projectTaskCard, taskCardSchema } from '../shared/task-card';
import { observeTask, type TaskObservation } from '../shared/task-observer';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '../vendor/renderer/contexts/dataOwnerGeneration';
import { Button } from '../vendor/renderer/components/ui/button';
import { CompanionTaskCard } from './companion-task-card';
import { invoke, post } from './bridge';

/** A task is shown only at its persisted group message, never in a synthetic task list. */
export function GroupTaskCard({ groupId, message }: { groupId: string; message: GroupMessage }) {
  const { t } = useTranslation();
  const owner = getDataOwnerGeneration();
  const scope = useMemo(() => ({ active: false, owner, observer: null as ReturnType<typeof observeTask> | null }), [groupId, message.id, message.authorBotId, message.taskId, message.taskParentSessionId, message.taskResult?.id, owner.dataOwnerId, owner.generation]);
  const [state, setState] = useState<TaskObservation>({ task: null, readError: '', mutationError: '', busy: false });
  const current = () => scope.active && isDataOwnerGenerationCurrent(scope.owner);
  const parsed = taskCardSchema.safeParse({ botId: message.authorBotId, taskId: message.taskId, parentAgentId: message.taskParentSessionId, ...(message.taskResult ? { receiptId: message.taskResult.id } : {}) });
  useLayoutEffect(() => {
    scope.active = true; setState({ task: null, readError: '', mutationError: '', busy: false });
    if (!parsed.success) { setState(value => ({ ...value, readError: t('paseoTasks.unavailable') })); return () => { scope.active = false; }; }
    scope.observer = observeTask(parsed.data, invoke, value => { if (current()) setState(value); }, { groupId, current });
    return () => { scope.active = false; scope.observer?.dispose(); };
  }, [scope]);
  if (!state.task) return <div className="my-2 w-full min-w-0 max-w-[560px] rounded-lg bg-[var(--surface)] px-3 py-2.5 text-12 text-[var(--text-secondary)]">
    <p role={state.readError ? 'alert' : 'status'}>{state.readError || t('paseoTasks.loading')}</p>
    {state.readError && <Button variant="secondary" tone="quiet" size="sm" onClick={() => { if (current()) scope.observer?.refresh(); }}>{t('bots.retry')}</Button>}
  </div>;
  const receipt = message.taskResult ? state.task.results.find(value => value.id === message.taskResult!.id) : undefined;
  const view = projectTaskCard(state.task, receipt);
  return <>
    <CompanionTaskCard view={view} inset actions={{
      open: () => { if (current() && state.task?.childSessionId) post('navigate-agent', { agentId: state.task.childSessionId }); },
      resume: async () => { if (current()) await scope.observer?.resume(); },
      stop: async () => { if (current()) await scope.observer?.stop(); },
      note: async text => { const result = current() ? await scope.observer?.note(text) : null; return { delivery: result ? 'queued' : 'unknown' }; },
      openFile: async path => {
        if (!current() || !parsed.success) return;
        await invoke('paseo.openTaskArtifact', { ...parsed.data, groupId, path });
      },
    }}/>
    {state.readError && <p role="alert" className="text-11 text-[var(--error-fg)]">{state.readError}</p>}
    {!receipt && ['stopping', 'pausing'].includes(state.task.control) && <p role="status" className="text-11 text-[var(--text-secondary)]">{t('paseoTasks.stopping')}</p>}
  </>;
}
