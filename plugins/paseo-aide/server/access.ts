import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { PLUGIN_ID } from "../shared/ids";
import { describeError, log } from "./util";

/** The SDK the daemon hands to hooks and RPC handlers. */
export type PaseoApi = PluginHookContext["paseo"];

/**
 * Paseo access for work that starts on a timer. The plugin SDK hands its connection only to
 * hooks and RPC handlers, so a morning brief due after a quiet night could otherwise wait for the
 * next unrelated event. Until a hook or RPC supplies the plugin's own connection, this opens a
 * local one the way the `paseo` CLI does: the address in paseo.pid and the local credential.
 */
export class PaseoAccess {
  private hooked: PaseoApi | null = null;
  private local: { api: PaseoApi; client: DaemonClient } | null = null;
  private opening: Promise<PaseoApi> | null = null;
  private closed = false;

  constructor(private readonly home: string) {}

  capture(api: PaseoApi | undefined): void {
    if (this.closed || !api || this.hooked === api) return;
    this.hooked = api;
    const local = this.local;
    this.local = null;
    if (local) void closeLocal(local);
  }

  current(): PaseoApi | null {
    return this.hooked ?? this.local?.api ?? null;
  }

  async get(): Promise<PaseoApi> {
    if (this.closed) throw new Error("The aide plugin is stopping.");
    const current = this.current();
    if (current) return current;
    this.opening ??= this.openLocal().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async openLocal(): Promise<PaseoApi> {
    const lock = JSON.parse(await readFile(join(this.home, "paseo.pid"), "utf8")) as { listen?: unknown };
    const listen = typeof lock.listen === "string" ? lock.listen.trim().replace(/^tcp:\/\//, "") : "";
    if (!/^[\w.-]+:\d+$|^\[[\da-f:]+\]:\d+$/i.test(listen)) throw new Error("The Paseo daemon address is not a local TCP endpoint.");
    const token = (await readFile(join(this.home, "local-credential"), "utf8").catch(() => "")).trim();
    if (!token) throw new Error("The Paseo local credential is unavailable.");
    const client = new DaemonClient({
      url: `ws://${listen}/ws`,
      clientId: `${PLUGIN_ID}-scheduler`,
      clientType: "cli",
      localCredential: () => token,
      reconnect: { enabled: true },
      connectTimeoutMs: 5000,
    });
    try {
      await client.connect();
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    const api = createPaseoApi(client) as PaseoApi;
    if (this.closed || this.hooked) {
      void closeLocal({ api, client });
      if (this.hooked) return this.hooked;
      throw new Error("The aide plugin is stopping.");
    }
    this.local = { api, client };
    log("opened a local Paseo connection for scheduled work");
    return api;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.hooked = null;
    const local = this.local;
    this.local = null;
    if (local) await closeLocal(local);
  }
}

async function closeLocal(local: { api: PaseoApi; client: DaemonClient }): Promise<void> {
  try {
    await local.api.dispose();
  } catch (error) {
    log(`closing the local Paseo connection: ${describeError(error)}`);
  }
  await local.client.close().catch(() => undefined);
}
