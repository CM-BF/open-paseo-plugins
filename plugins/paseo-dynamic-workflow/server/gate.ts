import type { PluginHookContext } from "@getpaseo/plugin/server";

/** The SDK the daemon hands to hooks and RPC handlers. */
export type PaseoApi = PluginHookContext["paseo"];

/**
 * Holds the PaseoApi captured from the first hook or RPC context: the server context itself does
 * not expose it, and the MCP bridge needs it outside any hook.
 */
export class Gate {
  private api: PaseoApi | null = null;
  private readonly waiters = new Map<(api: PaseoApi) => void, () => void>();
  private closed = false;

  capture(api: PaseoApi | undefined): void {
    if (this.closed || !api) return;
    this.api = api;
    for (const resolve of this.waiters.keys()) resolve(api);
    this.waiters.clear();
  }

  get ready(): boolean {
    return this.api !== null;
  }

  get paseo(): PaseoApi | null {
    return this.api;
  }

  wait(timeoutMs?: number): Promise<PaseoApi> {
    if (this.closed) return Promise.reject(new Error("The workflow plugin is stopping."));
    if (this.api) return Promise.resolve(this.api);
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.waiters.delete(done);
        reject(new Error("After a plugin reload, open the Dynamic workflows panel once to reconnect the workflow bridge to Paseo, then retry."));
      }, timeoutMs);
      (timer as unknown as { unref?: () => void } | undefined)?.unref?.();
      const done = (api: PaseoApi) => {
        if (timer) clearTimeout(timer);
        resolve(api);
      };
      this.waiters.set(done, () => { if (timer) clearTimeout(timer); reject(new Error("The workflow plugin stopped.")); });
    });
  }

  dispose(): void {
    this.closed = true;
    for (const reject of this.waiters.values()) reject();
    this.waiters.clear();
    this.api = null;
  }
}
