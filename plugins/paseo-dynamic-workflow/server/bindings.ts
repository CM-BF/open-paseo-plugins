import { readFile } from "node:fs/promises";
import { describeError, log, SerialWriter } from "./util";

export interface Binding {
  agentId: string;
  boundAt: string;
}

/**
 * Maps the nonce saved in an agent's MCP server env to that agent. Codex starts stdio MCP servers
 * with a whitelisted env, so the server cannot rely on PASEO_AGENT_ID.
 */
export class BindingStore {
  private bindings: Record<string, Binding> = {};
  private readonly writer: SerialWriter;
  private loaded: Promise<void> | null = null;

  constructor(private readonly file: string) {
    this.writer = new SerialWriter(file);
  }

  load(): Promise<void> {
    this.loaded ??= readFile(this.file, "utf8")
      .then((text) => {
        const parsed = JSON.parse(text) as { bindings?: Record<string, Binding> };
        this.bindings = { ...(parsed.bindings ?? {}), ...this.bindings };
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") log(`could not read ${this.file}: ${describeError(error)}`);
      });
    return this.loaded;
  }

  get(nonce: string): Binding | undefined {
    return this.bindings[nonce];
  }

  async bind(nonce: string, agentId: string): Promise<void> {
    await this.load();
    const existing = this.bindings[nonce];
    if (existing && existing.agentId !== agentId) {
      log(`binding already belongs to agent ${existing.agentId}; not rebinding it to ${agentId}`);
      return;
    }
    this.bindings[nonce] = { agentId, boundAt: new Date().toISOString() };
    await this.writer.write(`${JSON.stringify({ version: 1, bindings: this.bindings }, null, 1)}\n`);
  }

  idle(): Promise<void> {
    return this.writer.idle();
  }
}
