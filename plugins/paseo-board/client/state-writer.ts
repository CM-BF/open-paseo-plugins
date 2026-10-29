import type { JsonData } from "../shared/contracts";

export interface StateWriter {
  schedule(state: JsonData): void;
  /** Drain writes. Failures go to onError and remain queued for a later attempt. */
  flush(): Promise<void>;
  /** Flush the last edit to the captured board, then ignore events from the old frame. */
  dispose(): void;
}

export function createStateWriter(save: (state: JsonData) => Promise<void>, onError: (error: unknown) => void): StateWriter {
  let pending: JsonData | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  async function drain(): Promise<boolean> {
    while (pending !== null && timer === null) {
      const state = pending;
      pending = null;
      try {
        await save(state);
      } catch (error) {
        // Preserve failed keys, but newer user edits win over the failed snapshot.
        pending = { ...state, ...(pending as JsonData | null) };
        onError(error);
        return false;
      }
    }
    return true;
  }

  function flush(): Promise<void> {
    clearTimer();
    if (running) return running;
    if (pending === null) return Promise.resolve();
    running = drain().then(success => {
      running = null;
      // A last edit may arrive after drain's loop finishes but before this callback.
      if (success && pending !== null && timer === null) return flush();
    }, error => { running = null; throw error; });
    return running;
  }

  function schedule(state: JsonData): void {
    if (disposed) return;
    try {
      // Frame states are JSON by contract; copying freezes the value at edit time.
      const snapshot = JSON.parse(JSON.stringify(state)) as JsonData;
      pending = { ...pending, ...snapshot };
    } catch (error) {
      onError(error);
      return;
    }
    clearTimer();
    timer = setTimeout(() => { timer = null; void flush(); }, 300);
  }

  return {
    schedule, flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      void flush();
    },
  };
}
