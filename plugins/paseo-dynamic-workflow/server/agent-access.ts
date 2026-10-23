import { readFile } from "node:fs/promises";
import { z } from "zod";
import { describeError, log, writeAtomically } from "./util";

// Still version 1: MCP shims already running in older agents accept only version 1, and they
// ignore the optional ultracode list.
const AgentAccessFileSchema = z.object({
  version: z.literal(1),
  enabledAgentIds: z.array(z.string().min(1)),
  // Lenient like the MCP shim: anything that is not a list of ids means none.
  ultracodeAgentIds: z.unknown().optional(),
});

export interface AccessChange {
  enabled?: boolean;
  ultracode?: boolean;
}

/**
 * Opt-in is per agent; existing installations and unreadable files grant no access. Ultracode
 * is a per-agent standing opt-in to exhaustive orchestration and implies access: turning it on
 * enables the agent, and disabling the agent turns it off.
 */
export class AgentAccessStore {
  private enabledIds = new Set<string>();
  private ultracodeIds = new Set<string>();
  private loaded: Promise<void> | null = null;
  /** The file exists but could not be read: writing would silently drop every agent's opt-in. */
  private unreadable = false;
  private writes: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly file: string) {}

  load(): Promise<void> {
    this.loaded ??= readFile(this.file, "utf8").then((text) => {
      const parsed = AgentAccessFileSchema.parse(JSON.parse(text));
      this.enabledIds = new Set(parsed.enabledAgentIds);
      const listed = Array.isArray(parsed.ultracodeAgentIds) ? parsed.ultracodeAgentIds : [];
      this.ultracodeIds = new Set(listed.filter((id): id is string => typeof id === "string" && this.enabledIds.has(id)));
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return;
      this.unreadable = true;
      log(`could not read agent workflow access; all agents stay disabled until ${this.file} is fixed or removed: ${describeError(error)}`);
    });
    return this.loaded;
  }

  enabled(agentId: string): boolean {
    return this.enabledIds.has(agentId);
  }

  ultracode(agentId: string): boolean {
    return this.enabledIds.has(agentId) && this.ultracodeIds.has(agentId);
  }

  set(agentId: string, enabled: boolean): Promise<void> {
    return this.update(agentId, { enabled });
  }

  update(agentId: string, change: AccessChange): Promise<void> {
    const operation = this.writes.then(async () => {
      await this.load();
      if (this.stopped) throw new Error("The workflow plugin is stopping.");
      if (this.unreadable) throw new Error(`${this.file} is unreadable; fix or remove it, then reload the plugin. Saving now would drop every other agent's setting.`);
      if (!agentId.trim()) throw new Error("agentId is required");
      // Derive each update inside the queue, and expose it only after its write succeeds.
      const enabled = new Set(this.enabledIds);
      const ultracode = new Set(this.ultracodeIds);
      if (change.enabled === true || change.ultracode === true) enabled.add(agentId);
      if (change.enabled === false) enabled.delete(agentId);
      if (change.ultracode === true && enabled.has(agentId)) ultracode.add(agentId);
      if (change.ultracode === false || !enabled.has(agentId)) ultracode.delete(agentId);
      if (sameSet(enabled, this.enabledIds) && sameSet(ultracode, this.ultracodeIds)) return;
      const file = {
        version: 1,
        enabledAgentIds: [...enabled].sort(),
        ...(ultracode.size > 0 ? { ultracodeAgentIds: [...ultracode].sort() } : {}),
      };
      await writeAtomically(this.file, `${JSON.stringify(file, null, 1)}\n`);
      this.enabledIds = enabled;
      this.ultracodeIds = ultracode;
    });
    // Report this write's failure to its caller, while allowing a later save to recover.
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  idle(): Promise<void> {
    return this.writes;
  }

  dispose(): void {
    this.stopped = true;
  }
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}
