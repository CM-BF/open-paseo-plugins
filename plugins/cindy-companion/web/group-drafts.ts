import { useEffect, useRef, useState } from 'react';
import { invoke } from './bridge';
import type { GroupComposerDraft, GroupDraftSnapshot } from '../shared/group-drafts';

/** The parent owns this process-only Map, so changing iframe documents retains drafts. */
export function useGroupDraft(groupId: string, draft: GroupComposerDraft, restore: (draft: GroupComposerDraft) => void, rootId?: string) {
  const [ready, setReady] = useState(false), [error, setError] = useState('');
  const state = useRef({ generation: 0, sequence: 0, ready: false, disposed: false });
  const latest = useRef(draft), restoreRef = useRef(restore); latest.current = draft; restoreRef.current = restore;
  const scope = { groupId, ...(rootId ? { rootId } : {}) };
  const save = async () => {
    const owner = state.current;
    if (!owner.ready || owner.disposed) return;
    await invoke('paseo.groupDrafts.save', { ...scope, generation: owner.generation, sequence: ++owner.sequence, draft: latest.current });
  };
  useEffect(() => {
    const owner = { generation: 0, sequence: 0, ready: false, disposed: false }; state.current = owner;
    void invoke<GroupDraftSnapshot>('paseo.groupDrafts.get', scope).then(value => {
      if (owner.disposed) return;
      owner.generation = value.generation;
      if (value.draft) { latest.current = value.draft; restoreRef.current(value.draft); }
      owner.ready = true; setReady(true); setError('');
    }).catch(reason => { if (!owner.disposed) setError(String(reason.message ?? reason)); });
    return () => { void save().catch(() => {}); owner.disposed = true; };
  }, [groupId, rootId]);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => { void save().catch(reason => { if (!state.current.disposed) setError(String(reason.message ?? reason)); }); }, 300);
    return () => clearTimeout(timer);
  }, [draft, ready]);
  return { ready, error, save, replace(value: GroupComposerDraft) { latest.current = value; return save(); } };
}
