import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { networkInterfaces } from "node:os";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { createHostClient } from "@getpaseo/client/node";
import { z } from "zod";

const exec = promisify(execFile);
const statusSchema = z.object({
  home: z.string(),
  listen: z.string().min(1),
  serverId: z.string().min(1),
});
export function localEndpoint(listen: string): string {
  if (isAbsolute(listen)) return listen;
  const match = /^(\[[\da-f:]+\]|[\w.-]+):(\d+)$/.exec(listen);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)
    throw new Error("Invalid local daemon endpoint");
  const address = match[1].replace(/^\[|\]$/g, "");
  if (["localhost", "0.0.0.0", "127.0.0.1"].includes(address))
    return `127.0.0.1:${match[2]}`;
  if (["::", "::1"].includes(address)) return `[::1]:${match[2]}`;
  if (
    Object.values(networkInterfaces())
      .flat()
      .some((entry) => entry?.address === address)
  )
    return listen;
  throw new Error("Refusing a non-local daemon endpoint");
}
async function cliPath(): Promise<string> {
  if (process.env.PASEO_CLI_PATH) return process.env.PASEO_CLI_PATH;
  const desktop = "/Applications/Paseo.app/Contents/Resources/bin/paseo";
  if (
    process.platform === "darwin" &&
    (await access(desktop).then(
      () => true,
      () => false,
    ))
  )
    return desktop;
  return "paseo";
}

/** The public Node client owns one local connection, available before any UI/hook context exists. */
export class LocalPaseo {
  private pending?: Promise<PaseoApi>;
  private closeConnection?: () => Promise<void>;
  private ensureConnection?: () => Promise<void>;
  private disposed = false;
  constructor(private readonly home: string) {}

  get(): Promise<PaseoApi> {
    if (this.disposed) return Promise.reject(new Error("插件已停止"));
    if (!this.pending) {
      this.pending = this.connect().catch(() => {
        this.pending = undefined;
        throw new Error(
          "无法连接本机 Paseo。请确认 CLI 可用；自动建议尚未创建。",
        );
      });
    }
    return this.pending
      .then(async (api) => {
        await this.ensureConnection?.();
        return api;
      })
      .catch(async (error) => {
        await this.closeConnection?.();
        this.pending = undefined;
        throw error;
      });
  }
  private async connect(): Promise<PaseoApi> {
    const result = await exec(
      await cliPath(),
      ["daemon", "status", "--home", this.home, "--json"],
      {
        timeout: 10_000,
        maxBuffer: 256_000,
        windowsHide: true,
      },
    );
    const status = statusSchema.parse(JSON.parse(result.stdout));
    if ((await realpath(status.home)) !== (await realpath(this.home)))
      throw new Error("Daemon home mismatch");
    if (this.disposed) throw new Error("插件已停止");
    // Only the selected local home is resolved by the CLI; do not infer a remote default host.
    const client = createHostClient(localEndpoint(status.listen), {
      appVersion: "0.13.2",
      clientId: "upstream-watch-scheduler",
      connectTimeoutMs: 10_000,
    });
    const api = createPaseoApi(client);
    const close = async () => {
      await api.dispose();
      await client.close();
    };
    this.closeConnection = close;
    this.ensureConnection = async () => {
      if (this.disposed) throw new Error("插件已停止");
      await client.connect();
      if (
        this.disposed ||
        client.getLastServerInfoMessage()?.serverId !== status.serverId
      )
        throw new Error("Daemon identity changed");
    };
    try {
      await this.ensureConnection();
      return api;
    } catch (error) {
      await close();
      throw error;
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.pending?.catch(() => undefined);
    await this.closeConnection?.();
  }
}
