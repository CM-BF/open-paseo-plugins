import { useEffect, useRef, useState } from 'react';
import type { GroupMessage } from '../shared/groups';
import type { GroupHistoryMessage, GroupHistorySnapshot } from '../shared/group-history';
import { invoke } from './bridge';
import { createHistoryIntents, historyError } from './group-history-rpc';

export function mergeHistoryMessages(previous: GroupHistoryMessage[], next: GroupHistoryMessage[]) {
  const rows = new Map(previous.map(message => [message.id, message]));
  for (const message of next) {
    const old = rows.get(message.id);
    if (!old || old.historyRevision <= message.historyRevision) rows.set(message.id, message);
  }
  return [...rows.values()].sort((a, b) => a.sequence - b.sequence);
}

export function observeHistory<T extends { revision: number }>(read: () => Promise<T>, emit: (data: T) => void,
  fail: (error: unknown) => void, timers = { set: setTimeout.bind(globalThis), clear: clearTimeout.bind(globalThis) }) {
  let disposed = false, inFlight = false, again = false, epoch = 0, revision = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const readNow = async () => {
    if (disposed) return;
    if (inFlight) { again = true; return; }
    if (timer) timers.clear(timer);
    inFlight = true; const own = epoch;
    try {
      const data = await read();
      if (!disposed && own === epoch && data.revision >= revision) { revision = data.revision; emit(data); }
    } catch (error) { if (!disposed && own === epoch) fail(error); }
    finally {
      inFlight = false;
      if (!disposed) {
        if (again) { again = false; void readNow(); }
        else timer = timers.set(() => void readNow(), 3000);
      }
    }
  };
  void readNow();
  return { refresh() { epoch++; void readNow(); }, dispose() { disposed = true; if (timer) timers.clear(timer); } };
}

export function useHistoryMutations(onChanged: () => void, language = 'en') {
  const [pending, setPending] = useState<string[]>([]), [error, setError] = useState('');
  const changed = useRef(onChanged); changed.current = onChanged;
  const alive = useRef(true), intents = useRef<ReturnType<typeof createHistoryIntents> | null>(null);
  if (!intents.current) intents.current = createHistoryIntents();
  useEffect(() => { alive.current = true; const owner = createHistoryIntents(); intents.current = owner;
    return () => { alive.current = false; owner.dispose(); }; }, []);
  const run = async <T,>(key: string, op: string, args: Record<string, unknown>): Promise<T | null> => {
    if (!alive.current) return null;
    setError(''); setPending(previous => [...new Set([...previous, key])]);
    try {
      const value = await intents.current!.run<T>(key, op, args);
      if (!alive.current) return null;
      changed.current(); return value;
    } catch (reason) { if (alive.current) setError(historyError(reason, language)); return null; }
    finally { if (alive.current) setPending(previous => previous.filter(value => value !== key)); }
  };
  return { run, pending, error, clearError: () => setError('') };
}

/** Drain every byte-bounded page for the immutable visible-ID request. No body is truncated. */
export async function readGroupHistory(groupId: string, messageIds: string[], request: typeof invoke = invoke,
  current: () => boolean = () => true): Promise<GroupHistorySnapshot> {
  let merged: GroupHistorySnapshot | undefined, beforeSequence: number | undefined;
  for (let page = 0; page <= messageIds.length; page++) {
    if (!current()) throw new Error('This conversation was closed.');
    const value = await request<GroupHistorySnapshot>('groups.history.get', { groupId, messageIds, ...(beforeSequence === undefined ? {} : { beforeSequence }) });
    if (!current()) throw new Error('This conversation was closed.');
    if (value.groupId !== groupId) throw new Error('The host returned history for another group.');
    merged = !merged ? value : { ...value, revision: Math.max(merged.revision, value.revision),
      messages: mergeHistoryMessages(merged.messages, value.messages), quoteSources: mergeHistoryMessages(merged.quoteSources, value.quoteSources),
      threads: [...new Map([...merged.threads, ...value.threads].map(thread => [thread.rootId, thread])).values()] };
    const next = value.nextBeforeSequence;
    if (next == null) {
      const returned = new Set(merged.messages.map(message => message.id));
      if (messageIds.some(id => !returned.has(id))) throw new Error('The host returned incomplete message history. Retry to load the missing messages.');
      return { ...merged, nextBeforeSequence: null };
    }
    if (!Number.isSafeInteger(next) || next < 1 || (beforeSequence !== undefined && next >= beforeSequence) || !value.messages.length)
      throw new Error('The host returned an invalid history continuation.');
    beforeSequence = next;
  }
  throw new Error('The host did not finish the requested history window.');
}

export function useGroupHistory(groupId: string, messages: GroupMessage[], language: string) {
  const [data, setData] = useState<GroupHistorySnapshot | null>(null), [error, setError] = useState('');
  const observer = useRef<ReturnType<typeof observeHistory<GroupHistorySnapshot>> | null>(null);
  const messageIds = useRef<string[]>([]);
  messageIds.current = messages.slice(-500).map(message => message.id);
  const idKey = messageIds.current.join('\u0000');
  useEffect(() => {
    setData(null); setError('');
    let active = true;
    const next = observeHistory(() => readGroupHistory(groupId, [...messageIds.current], invoke, () => active),
      value => { if (value.groupId !== groupId) { setError('The host returned history for another group.'); return; }
        setData(previous => previous ? { ...value, messages: mergeHistoryMessages(previous.messages, value.messages), quoteSources: mergeHistoryMessages(previous.quoteSources, value.quoteSources) } : value); setError(''); },
      reason => setError(historyError(reason, language)));
    observer.current = next;
    return () => { active = false; next.dispose(); if (observer.current === next) observer.current = null; };
  }, [groupId, language]);
  useEffect(() => { observer.current?.refresh(); }, [idKey]);
  return { data, error, refresh: () => observer.current?.refresh() };
}
