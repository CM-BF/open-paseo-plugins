// nonce → agent. The agent.create hook puts a fresh nonce in the MCP server's env (saved with the
// agent's config) and in the launch env; agent.session_open (reason=create) learns the agent id and
// records the pair. The shim sends the nonce with every call, so tools know which agent is calling.

import { readJson, SerialQueue, writeJson } from "./files";

export interface Binding {
  agentId: string;
  cwd: string;
  workspaceId: string | null;
  provider: string;
  boundAt: string;
}

type BindingsFile = { bindings: Record<string, Binding> };

function parse(value: unknown): BindingsFile {
  const out: Record<string, Binding> = {};
  const raw = (value as { bindings?: unknown })?.bindings;
  if (raw && typeof raw === "object") {
    for (const [nonce, b] of Object.entries(raw as Record<string, Partial<Binding>>)) {
      if (typeof b?.agentId === "string" && typeof b.cwd === "string") {
        out[nonce] = {
          agentId: b.agentId,
          cwd: b.cwd,
          workspaceId: typeof b.workspaceId === "string" ? b.workspaceId : null,
          provider: typeof b.provider === "string" ? b.provider : "",
          boundAt: typeof b.boundAt === "string" ? b.boundAt : new Date(0).toISOString(),
        };
      }
    }
  }
  return { bindings: out };
}

export class BindingStore {
  private readonly queue = new SerialQueue();
  private cache: BindingsFile | null = null;

  constructor(private readonly path: string) {}

  private async load(): Promise<BindingsFile> {
    if (!this.cache) this.cache = await readJson(this.path, { bindings: {} }, parse);
    return this.cache;
  }

  bind(nonce: string, binding: Omit<Binding, "boundAt">): Promise<void> {
    return this.queue.run(async () => {
      const file = await this.load();
      file.bindings[nonce] = { ...binding, boundAt: new Date().toISOString() };
      await writeJson(this.path, file);
    });
  }

  async get(nonce: string): Promise<Binding | null> {
    return (await this.load()).bindings[nonce] ?? null;
  }

  async byAgent(agentId: string): Promise<Binding | null> {
    const file = await this.load();
    return Object.values(file.bindings).find((b) => b.agentId === agentId) ?? null;
  }

  async count(): Promise<number> {
    return Object.keys((await this.load()).bindings).length;
  }

  /** Drops bindings of archived agents after a grace period. */
  prune(agentIds: ReadonlySet<string>): Promise<number> {
    return this.queue.run(async () => {
      const file = await this.load();
      let removed = 0;
      for (const [nonce, binding] of Object.entries(file.bindings)) {
        if (agentIds.has(binding.agentId)) {
          delete file.bindings[nonce];
          removed += 1;
        }
      }
      if (removed > 0) await writeJson(this.path, file);
      return removed;
    });
  }
}
