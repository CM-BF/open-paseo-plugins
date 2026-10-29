type Read = { op: 'routines.list' | 'routines.history'; args: Record<string, unknown> };
const pending = (value: unknown): boolean => Array.isArray(value) && value.some(row => row && typeof row === 'object' && (
  row.manualPending === true || row.activity === 'queued' || row.activity === 'running' || row.status === 'queued' || row.status === 'running'
));

/** Original onChanged consumers refresh only while the host reports pending work. */
export function createRoutineRefresh(request: (op: string, args: Record<string, unknown>) => Promise<unknown>, delay = 3000) {
  const listeners = new Set<() => void>();
  const reads = new Map<string, Read>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  let generation = 0;
  const key = (read: Read) => JSON.stringify([read.op, read.args.botId, read.args.id]);
  const changed = () => { for (const listener of listeners) listener(); };
  function schedule() {
    if (timer || polling || !listeners.size || !reads.size) return;
    timer = setTimeout(() => { timer = null; void poll(); }, delay);
  }
  function track<T>(op: Read['op'], args: Read['args'], value: T): T {
    const read = { op, args };
    if (pending(value)) reads.set(key(read), read); else reads.delete(key(read));
    if (!reads.size && timer) { clearTimeout(timer); timer = null; }
    schedule(); return value;
  }
  async function poll() {
    polling = true;
    const current = generation;
    try {
      // Keep bridge concurrency bounded even if several routines are in flight.
      for (const read of [...reads.values()]) {
        if (current !== generation || !listeners.size) return;
        try {
          const value = await request(read.op, read.args);
          if (current !== generation || !listeners.size) return;
          track(read.op, read.args, value);
        } catch { /* Existing UI load handlers surface errors; pending work remains pending. */ }
      }
      if (current === generation && listeners.size) changed();
    } finally { polling = false; schedule(); }
  }
  return {
    track, changed,
    accepted(botId: string, id: string, result: { accepted?: boolean; status?: string }) {
      if (result?.accepted && ['queued', 'running', 'unknown'].includes(result.status ?? '')) {
        track('routines.history', { botId, id }, [{ manualPending: true }]);
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener); schedule();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { generation++; reads.clear(); if (timer) clearTimeout(timer); timer = null; }
      };
    },
  };
}
