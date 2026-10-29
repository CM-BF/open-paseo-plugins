import { useLayoutEffect, useMemo, useState } from 'react';
import { executionErrorText } from '../../shared/execution-notice';
import type { GroupPlanSnapshot, GroupPlanSettings, GroupWorkPlan, GroupPlanRequest } from '../../shared/group-plans';
import type { BotGroupTrackedMention } from '../../shared/vendor/botGroupMentions';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '../../vendor/renderer/contexts/dataOwnerGeneration';
import { BridgeError, invoke, post } from '../bridge';

export type WorkPlanAction = 'start' | 'continue' | 'retry' | 'stop' | 'dismiss' | 'edit' | 'note' | 'revise';

/** Poll the durable projection, with one read in flight and no post-disposal callbacks. */
export function observeGroupPlans(groupId: string, emit: (value: GroupPlanSnapshot) => void, fail: (error: Error) => void,
  request: typeof invoke = invoke, timers = { set: setTimeout, clear: clearTimeout }, isCurrent = () => true) {
  let disposed = false, inFlight = false, again = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    if (disposed || !isCurrent()) return;
    if (inFlight) { again = true; return; }
    if (timer) timers.clear(timer);
    const own = generation;
    inFlight = true;
    try {
      const value = await request<GroupPlanSnapshot>('groups.plans.list', { groupId });
      if (!disposed && isCurrent() && own === generation) emit(value);
    } catch (reason) {
      if (!disposed && isCurrent() && own === generation) fail(reason instanceof Error ? reason : new Error(String(reason)));
    } finally {
      inFlight = false;
      if (!disposed && isCurrent()) {
        if (again) { again = false; void read(); }
        else timer = timers.set(() => { void read(); }, 2_000);
      }
    }
  };
  void read();
  return { refresh() { generation++; return read(); }, dispose() { disposed = true; if (timer) timers.clear(timer); } };
}

export function mergePlanSnapshot(previous: GroupPlanSnapshot | null, next: GroupPlanSnapshot): GroupPlanSnapshot {
  if (!previous) return next;
  const old = new Map(previous.plans.map(plan => [plan.id, plan]));
  return { ...next, plans: next.plans.map(plan => (old.get(plan.id)?.revision ?? -1) > plan.revision ? old.get(plan.id)! : plan),
    settings: previous.settings.revision > next.settings.revision ? previous.settings : next.settings };
}

/** The original card's actions commit only host receipts; Stop acceptance is never a completion. */
export function useGroupPlans(groupId: string) {
  const owner = getDataOwnerGeneration();
  const scope = useMemo(() => ({ groupId, owner, active: false, busy: false,
    retry: null as { signature: string; operationId: string; expectedRevision?: number } | null,
    observer: null as ReturnType<typeof observeGroupPlans> | null }), [groupId, owner.dataOwnerId, owner.generation]);
  const [data, setData] = useState<GroupPlanSnapshot | null>(null);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [pending, setPending] = useState<{ planId: string; action: WorkPlanAction | 'settings' | 'create' | 'cancelRequest' } | null>(null);
  const current = () => scope.active && isDataOwnerGenerationCurrent(scope.owner);
  useLayoutEffect(() => {
    scope.active = true; setData(null); setError(''); setReadError(''); setPending(null);
    scope.observer = observeGroupPlans(groupId, value => {
      if (current()) { setData(old => mergePlanSnapshot(old, value)); setReadError(''); }
    }, reason => { if (current()) setReadError(reason.message); }, invoke, undefined, current);
    return () => { scope.active = false; scope.observer?.dispose(); };
  }, [scope]);
  const acceptPlan = (plan: GroupWorkPlan) => setData(old => old ? {
    ...old, plans: old.plans.some(value => value.id === plan.id)
      ? old.plans.map(value => value.id === plan.id && value.revision <= plan.revision ? plan : value)
      : [...old.plans, plan],
  } : old);
  const action = async (plan: GroupWorkPlan, action: WorkPlanAction, fields: Record<string, unknown> = {}) => {
    if (!current() || scope.busy || plan.groupId !== groupId) return null;
    scope.busy = true; setPending({ planId: plan.id, action }); setError('');
    // Polling changes the projection, not the user's unresolved intent. Keep the first
    // revision and ID until the same action is acknowledged, including an accepted lost ACK.
    const input = { ...fields, groupId, planId: plan.id };
    const signature = JSON.stringify({ action, input });
    if (scope.retry?.signature !== signature) scope.retry = { signature, operationId: crypto.randomUUID(), expectedRevision: plan.revision };
    try {
      const result = await invoke<{ accepted?: true; plan?: GroupWorkPlan; request?: GroupPlanRequest; delivery?: 'queued' | 'started' }>(
        `groups.plans.${action}`, { ...input, expectedRevision: scope.retry.expectedRevision, operationId: scope.retry.operationId });
      if (!current()) return null;
      scope.retry = null;
      if (result.plan) acceptPlan(result.plan);
      if (result.request) setData(old => old ? { ...old, requests: [...(old.requests ?? []).filter(value => value.id !== result.request!.id), result.request!] } : old);
      scope.observer?.refresh(); post('groups-changed');
      return result;
    } catch (reason) {
      if (current()) {
        // This explicit precondition rejection occurs before any write. An explicit
        // retry may use the refreshed revision; an uncertain transport outcome may not.
        if (reason instanceof BridgeError && reason.code === 'PRECONDITION_FAILED') scope.retry = null;
        setError(executionErrorText(reason)); scope.observer?.refresh();
      }
      return null;
    } finally { scope.busy = false; if (current()) setPending(null); }
  };
  const settings = async (previous: GroupPlanSettings, fields: Partial<Omit<GroupPlanSettings, 'revision'>>) => {
    if (!current() || scope.busy) return false;
    scope.busy = true; setPending({ planId: '', action: 'settings' }); setError('');
    try {
      const result = await invoke<{ settings: GroupPlanSettings }>('groups.plans.settings', { ...fields, groupId, expectedRevision: previous.revision });
      if (!current()) return false;
      setData(old => old ? { ...old, settings: result.settings,
        plans: old.plans.map(plan => ({ ...plan, autoContinue: result.settings.autoContinue })) } : old);
      scope.observer?.refresh(); return true;
    } catch (reason) { if (current()) setError(executionErrorText(reason)); return false; }
    finally { scope.busy = false; if (current()) setPending(null); }
  };
  const createPlan = async (request: string, trackedMentions: BotGroupTrackedMention[]) => {
    if (!current() || scope.busy) return null;
    scope.busy = true; setPending({ planId: '', action: 'create' }); setError('');
    const input = { groupId, request, trackedMentions };
    const signature = JSON.stringify({ action: 'create', input });
    if (scope.retry?.signature !== signature) scope.retry = { signature, operationId: crypto.randomUUID() };
    try {
      const result = await invoke<{ plan?: GroupWorkPlan; accepted?: true; request?: GroupPlanRequest }>('groups.plans.create', { ...input, operationId: scope.retry.operationId });
      if (!current()) return null;
      scope.retry = null;
      if (result.plan) acceptPlan(result.plan);
      if (result.request) setData(old => old ? { ...old, requests: [...(old.requests ?? []).filter(value => value.id !== result.request!.id), result.request!] } : old);
      scope.observer?.refresh(); post('groups-changed'); return result;
    } catch (reason) { if (current()) setError(executionErrorText(reason)); return null; }
    finally { scope.busy = false; if (current()) setPending(null); }
  };
  const cancelRequest = async (requestId: string) => {
    if (!current() || scope.busy) return null;
    scope.busy = true; setPending({ planId: '', action: 'cancelRequest' }); setError('');
    try {
      const result = await invoke<{ accepted: true; request: GroupPlanRequest }>('groups.plans.cancelRequest', { groupId, requestId });
      if (!current()) return null;
      setData(old => old ? { ...old, requests: (old.requests ?? []).map(value => value.id === result.request.id ? result.request : value) } : old);
      scope.observer?.refresh(); return result;
    } catch (reason) { if (current()) setError(executionErrorText(reason)); return null; }
    finally { scope.busy = false; if (current()) setPending(null); }
  };
  return { data, error: error || readError, pending, action, settings, createPlan, cancelRequest, refresh: () => { if (current()) scope.observer?.refresh(); } };
}
