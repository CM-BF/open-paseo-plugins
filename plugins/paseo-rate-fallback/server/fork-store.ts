import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const forkEntrySchema = z.object({
  mainAgentId: z.string(), mainProvider: z.string(), mainModel: z.string().nullable(),
  mainThinking: z.string().nullable(), workspaceId: z.string(), cwd: z.string(),
  operationId: z.string(), fallbackAgentId: z.string().nullable(),
  phase: z.enum(["forking", "fallback", "blocked", "returning", "paused"]),
  resetAt: z.number().nullable(), nextCheckAt: z.number(), lastError: z.string().nullable(),
  fallbackSent: z.boolean(), returnSent: z.boolean(),
  fallbackMessageId: z.string(), returnMessageId: z.string(),
});
export type ForkEntry = z.infer<typeof forkEntrySchema>;
const schema = z.object({ version: z.literal(1), agents: z.record(z.string(), forkEntrySchema) })
  .refine(({ agents }) => {
    const backups = new Set<string>();
    const operations = new Set<string>();
    for (const [id, entry] of Object.entries(agents)) {
      if (id !== entry.mainAgentId || id === entry.fallbackAgentId ||
          (["fallback", "blocked", "returning"].includes(entry.phase) && entry.fallbackAgentId === null) ||
          operations.has(entry.operationId)) return false;
      operations.add(entry.operationId);
      if (entry.fallbackAgentId !== null) {
        if (backups.has(entry.fallbackAgentId) || entry.fallbackAgentId in agents) return false;
        backups.add(entry.fallbackAgentId);
      }
    }
    return true;
  }, "Saved fork ownership must identify one source, operation and distinct backup");

/** Kept separate from the existing model-switch journal so older installations load unchanged. */
export class ForkStore {
  state: z.infer<typeof schema> = { version: 1, agents: {} };
  private writes = Promise.resolve();
  constructor(readonly path: string) {}

  loadSync(): void {
    try { this.state = schema.parse(JSON.parse(readFileSync(this.path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  save(): Promise<void> {
    const content = JSON.stringify(this.state, null, 2);
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.writes = write;
    return write;
  }
}
