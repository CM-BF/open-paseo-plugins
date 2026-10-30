import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { observeTask, type TaskObservation } from '../shared/task-observer';
import type { TaskCardData } from '../shared/task-card';
import { useSettingsInvoke } from './data';

const empty: TaskObservation = { task: null, readError: '', mutationError: '', busy: false };
export function useCompanionTask(hostId: string, parentAgentId: string, data: TaskCardData) {
  const invoke = useSettingsInvoke(hostId);
  const scope = useMemo(() => ({ active: false, controller: null as ReturnType<typeof observeTask> | null }), [hostId, parentAgentId, data.parentAgentId, data.botId, data.taskId, data.receiptId]);
  const owner = useRef(scope); owner.current = scope;
  const [snapshot, setSnapshot] = useState({ scope, value: empty });
  const current = () => scope.active && owner.current === scope;
  useLayoutEffect(() => {
    scope.active = true; setSnapshot({ scope, value: empty });
    if (parentAgentId !== data.parentAgentId) {
      setSnapshot({ scope, value: { ...empty, readError: 'This task does not belong to this conversation.' } });
      return () => { scope.active = false; };
    }
    scope.controller = observeTask(data, async (op, args) => {
      if (!current()) throw new Error('The task view has closed.');
      const result = await invoke(op, args);
      if (!result.ok) throw new Error(result.message);
      return result.value;
    }, value => { if (current()) setSnapshot({ scope, value }); }, { current });
    return () => { scope.active = false; scope.controller?.dispose(); };
  }, [scope, invoke]);
  return {
    ...(snapshot.scope === scope ? snapshot.value : empty), current,
    refresh: () => { if (current()) scope.controller?.refresh(); },
    note: (text: string) => current() ? scope.controller?.note(text) : Promise.resolve(null),
    resume: () => current() ? scope.controller?.resume() : Promise.resolve(null),
    stop: () => current() ? scope.controller?.stop() : Promise.resolve(null),
    invoke: async (op: string, args: Record<string, unknown>) => {
      if (!current()) throw new Error('The task view has closed.');
      const result = await invoke(op, args);
      if (!current()) return null;
      if (!result.ok) throw new Error(result.message);
      return result.value;
    },
  };
}
