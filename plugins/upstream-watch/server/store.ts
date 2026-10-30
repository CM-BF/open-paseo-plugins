import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { stateSchema, type State } from "../shared/contracts";

export class Store {
  readonly ready: Promise<void>;
  private tail: Promise<void>;
  private state: State = {
    version: 1,
    watches: [],
    settings: { enabled: true, intervalHours: 24 },
  };

  constructor(readonly path: string) {
    this.ready = this.load();
    this.tail = this.ready;
  }

  private async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      this.state = stateSchema.parse(JSON.parse(text));
      if (this.state.watches.length > 100) throw new Error("too many watches");
    } catch {
      throw new Error(
        "Upstream Watch state is invalid. The original file was preserved; inspect it before continuing.",
      );
    }
  }

  async read(): Promise<State> {
    await this.ready;
    await this.tail;
    return structuredClone(this.state);
  }

  change<T>(fn: (draft: State) => T | Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => {
      await this.ready;
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      const next = stateSchema.parse(draft);
      if (next.watches.length > 100)
        throw new Error("At most 100 watches are supported.");
      await this.persist(next);
      this.state = next;
      return structuredClone(result);
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async persist(next: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
}
