import type { BoardEventCursor } from "../shared/contracts";
import type { BoardLiveStatus } from "./board-events";

export interface BoardSyncVisibility {
  visible(): boolean;
  subscribe(listener: () => void): () => void;
}
const page = (globalThis as { document?: { hidden: boolean; addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void } }).document;
const browserVisibility: BoardSyncVisibility = {
  visible: () => !page?.hidden,
  subscribe(listener) {
    if (!page) return () => {};
    page.addEventListener("visibilitychange", listener);
    return () => page.removeEventListener("visibilitychange", listener);
  },
};

/** One completion-scheduled, constant-size probe per visible host; no overlapping requests. */
export class BoardCompactSync {
  private stopped = true;
  private flight = false;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private failures = 0;
  private generation = 0;
  private readonly visibility: BoardSyncVisibility;
  constructor(private readonly options: {
    cursor(): BoardEventCursor | undefined;
    check(cursor: BoardEventCursor): Promise<{ changed: boolean }>;
    recover(): Promise<void>;
    state(status: BoardLiveStatus, error?: unknown): void;
    visibility?: BoardSyncVisibility;
    intervalMs?: number;
  }) { this.visibility = options.visibility ?? browserVisibility; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false; this.generation++;
    this.unsubscribe = this.visibility.subscribe(() => {
      this.clearTimer();
      if (this.visibility.visible()) void this.tick();
    });
    void this.tick();
  }

  stop(): void {
    this.stopped = true; this.generation++;
    this.clearTimer(); this.unsubscribe?.(); this.unsubscribe = undefined;
  }

  private clearTimer(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }

  private async tick(): Promise<void> {
    if (this.stopped || this.flight || !this.visibility.visible()) return;
    this.flight = true;
    const generation = this.generation;
    const active = () => !this.stopped && generation === this.generation;
    try {
      const cursor = this.options.cursor();
      const changed = cursor ? (await this.options.check(cursor)).changed : true;
      if (!active() || !this.visibility.visible()) return;
      if (changed) {
        this.options.state(cursor ? "recovering" : "connecting");
        await this.options.recover();
      }
      if (!active()) return;
      this.failures = 0;
      this.options.state("checking");
    } catch (error) {
      if (!active()) return;
      this.failures++;
      this.options.state("disconnected", error);
    } finally {
      this.flight = false;
      if (!this.stopped && this.visibility.visible() && generation !== this.generation) {
        void this.tick();
      } else if (active() && this.visibility.visible()) {
        const delay = Math.min((this.options.intervalMs ?? 2000) * 2 ** Math.max(0, this.failures - 1), 30_000);
        this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, delay);
      }
    }
  }
}
