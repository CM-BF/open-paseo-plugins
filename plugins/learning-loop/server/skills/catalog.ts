import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SerialQueue, writeJson } from "../files";
import type { SkillLibrary } from "./library";

/** Only this owner writes the optional, versioned read-only interchange file. */
export class LearnedCatalog {
  readonly path: string;
  private readonly queue = new SerialQueue();
  constructor(root: string, private readonly library: SkillLibrary, private readonly enabled: () => boolean) {
    this.path = join(root, "exports", "learned-catalog.v1.json");
  }
  publish(): Promise<void> {
    return this.queue.run(async () => {
      if (!this.enabled()) { await rm(this.path, { force: true }); return; }
      const snapshot = await this.library.catalogSnapshot();
      if (!this.enabled()) { await rm(this.path, { force: true }); return; }
      await writeJson(this.path, snapshot);
    });
  }
}
