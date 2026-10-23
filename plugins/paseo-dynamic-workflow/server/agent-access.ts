import { readFile } from "node:fs/promises";
import { z } from "zod";
import { describeError, log, writeAtomically } from "./util";

const AgentAccessFileSchema = z.object({
  version: z.literal(1),
  enabledAgentIds: z.array(z.string().min(1)),
});

/** Opt-in is per agent; existing installations and unreadable files grant no access. */
export class AgentAccessStore {
  private enabledIds = new Set<string>();
  private loaded: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly file: string) {}

  load(): Promise<void> {
    this.loaded ??= readFile(this.file, "utf8").then((text) => {
      this.enabledIds = new Set(AgentAccessFileSchema.parse(JSON.parse(text)).enabledAgentIds);
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") log(`could not read agent workflow access; all agents stay disabled: ${describeError(error)}`);
    });
    return this.loaded;
  }

  enabled(agentId: string): boolean {
    return this.enabledIds.has(agentId);
  }

  set(agentId: string, enabled: boolean): Promise<void> {
    const operation = this.writes.then(async () => {
      await this.load();
      if (this.stopped) throw new Error("The workflow plugin is stopping.");
      if (!agentId.trim()) throw new Error("agentId is required");
      if (this.enabled(agentId) === enabled) return;
      // Derive each update inside the queue, and expose it only after its write succeeds.
      const next = new Set(this.enabledIds);
      if (enabled) next.add(agentId);
      else next.delete(agentId);
      await writeAtomically(this.file, `${JSON.stringify({ version: 1, enabledAgentIds: [...next].sort() }, null, 1)}\n`);
      this.enabledIds = next;
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
