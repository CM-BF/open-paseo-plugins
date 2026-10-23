import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const entrySchema = z.object({
  agentId: z.string(),
  main: z.object({ model: z.string().nullable(), thinkingOptionId: z.string().nullable() }),
  phase: z.enum(["switching", "fallback", "blocked", "restoring"]),
  resetAt: z.number().nullable(), nextCheckAt: z.number(), lastError: z.string().nullable(),
  pendingResume: z.boolean(), messageId: z.string(),
});
export type FallbackEntry = z.infer<typeof entrySchema>;
const stateSchema = z.object({
  version: z.literal(1), enabled: z.boolean(), agents: z.record(z.string(), entrySchema),
}).refine((state) => Object.entries(state.agents).every(([key, entry]) => key === entry.agentId),
  "Saved agent key must match its agentId");
export type FallbackState = z.infer<typeof stateSchema>;

export class StateStore {
  state: FallbackState = { version: 1, enabled: true, agents: {} };
  private writes = Promise.resolve();
  constructor(readonly path = join(process.env.PASEO_HOME || join(homedir(), ".paseo"),
    "plugin-data", "paseo-rate-fallback", "state.json")) {}

  async load(): Promise<void> {
    this.loadSync();
  }

  loadSync(): void {
    try { this.state = stateSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
