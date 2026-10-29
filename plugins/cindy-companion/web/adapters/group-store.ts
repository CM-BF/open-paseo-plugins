import { useEffect, useState } from 'react';
import { BridgeError, invoke, post } from '../bridge';
import type { GroupSnapshot, GroupMessage } from '../../shared/groups';

let creation: { signature: string; operationId: string } | null = null;
const api = {
  async createBotGroup(input: { name: string; botIds: string[] }) {
    const signature = JSON.stringify(input);
    if (creation?.signature !== signature) creation = { signature, operationId: crypto.randomUUID() };
    try {
      const result = await invoke<GroupSnapshot>('groups.create', { ...input, operationId: creation.operationId });
      creation = null;
      return { ok: true as const, groupId: result.group.id };
    } catch (error) {
      return { ok: false as const, errorCode: error instanceof BridgeError ? error.code : 'HOST_NOT_READY' };
    }
  },
};
export const botGroupApi = () => api;
export const refreshBotGroups = () => post('groups-changed');

export function mergeMessages(previous: GroupMessage[], next: GroupMessage[]) {
  const values = new Map(previous.map(message => [message.id, message]));
  for (const message of next) values.set(message.id, message);
  return [...values.values()].sort((a, b) => a.sequence - b.sequence);
}

/** A read started before a mutation must not roll an acknowledged round backwards. */
export function mergeGroupSnapshot(previous: GroupSnapshot | null, next: GroupSnapshot): GroupSnapshot {
  if (!previous) return next;
  const oldRound = previous.group.round, newRound = next.group.round;
  const round = oldRound && (!newRound || oldRound.updatedAt > newRound.updatedAt) ? oldRound : newRound;
  const group = previous.group.revision > next.group.revision ? previous.group : next.group;
  return { ...next, group: { ...group, round }, messages: mergeMessages(previous.messages, next.messages),
    hasOlder: previous.messages[0]?.sequence < (next.messages[0]?.sequence ?? Infinity) ? previous.hasOlder : next.hasOlder };
}

/** One read at a time, bounded recovery after errors, and no work after unmount. */
export function observeGroup(groupId: string, emit: (value: GroupSnapshot) => void, fail: (error: Error) => void,
  request: typeof invoke = invoke, timers = { set: setTimeout, clear: clearTimeout }) {
  let disposed = false, inFlight = false, again = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    if (disposed) return;
    if (inFlight) { again = true; return; }
    if (timer) timers.clear(timer);
    inFlight = true;
    const own = generation;
    try {
      const value = await request<GroupSnapshot>('groups.get', { groupId });
      if (!disposed && own === generation) emit(value);
    } catch (error) { if (!disposed && own === generation) fail(error instanceof Error ? error : new Error(String(error))); }
    finally {
      inFlight = false;
      if (!disposed) {
        if (again) { again = false; void refresh(); }
        else timer = timers.set(() => { void refresh(); }, 2000);
      }
    }
  };
  void refresh();
  return { refresh() { generation++; return refresh(); }, dispose() { disposed = true; if (timer) timers.clear(timer); } };
}

export function useGroup(groupId: string) {
  const [data, setData] = useState<GroupSnapshot | null>(null);
  const [error, setError] = useState('');
  const [observer, setObserver] = useState<ReturnType<typeof observeGroup> | null>(null);
  useEffect(() => {
    setData(null); setError('');
    const subscription = observeGroup(groupId, next => {
      setData(previous => mergeGroupSnapshot(previous, next));
      setError('');
    }, reason => setError(reason.message));
    setObserver(subscription);
    return () => subscription.dispose();
  }, [groupId]);
  return { data, setData, error, refresh: () => observer?.refresh() };
}
