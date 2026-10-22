import type { PluginHookContext } from "@getpaseo/plugin/server";

/** The SDK the daemon hands to hooks and RPC handlers. */
export type PaseoApi = PluginHookContext["paseo"];

/**
 * Holds the PaseoApi captured from the first hook or RPC context: the server context itself does
 * not expose it, and the MCP bridge needs it outside any hook.
 */
export class Gate {
  private api: PaseoApi | null = null;
  private readonly waiters: Array<(api: PaseoApi) => void> = [];

  capture(api: PaseoApi | undefined): void {
    if (this.api || !api) return;
    this.api = api;
    for (const resolve of this.waiters.splice(0)) resolve(api);
  }

  get ready(): boolean {
    return this.api !== null;
  }

  get paseo(): PaseoApi | null {
    return this.api;
  }

  wait(timeoutMs: number): Promise<PaseoApi> {
    if (this.api) return Promise.resolve(this.api);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(done);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("The plugin has just started and has no connection to Paseo yet; try again in a few seconds."));
      }, timeoutMs);
      const done = (api: PaseoApi) => {
        clearTimeout(timer);
        resolve(api);
      };
      this.waiters.push(done);
    });
  }
}
