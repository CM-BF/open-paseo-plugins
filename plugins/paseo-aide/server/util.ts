import { randomBytes } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PLUGIN_ID } from "../shared/ids";

export function log(message: string): void {
  console.log(`[${PLUGIN_ID}] ${message}`);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shortId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export async function writeAtomically(file: string, text: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, text, { mode });
  await rename(temporary, file);
}

/** Serializes writes to one file; the latest text wins. */
export class SerialWriter {
  private chain: Promise<void> = Promise.resolve();
  private latest: string | null = null;

  constructor(private readonly file: string) {}

  write(text: string): Promise<void> {
    this.latest = text;
    this.chain = this.chain.then(async () => {
      const next = this.latest;
      if (next === null) return;
      this.latest = null;
      await writeAtomically(this.file, next).catch((error) => log(`could not write ${this.file}: ${describeError(error)}`));
    });
    return this.chain;
  }

  idle(): Promise<void> {
    return this.chain;
  }
}

/** Appends lines in order without losing any to concurrent callers. */
export class SerialAppender {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  append(line: string): Promise<void> {
    this.chain = this.chain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await appendFile(this.file, `${line}\n`, { mode: 0o600 }).catch((error) => log(`could not append to ${this.file}: ${describeError(error)}`));
    });
    return this.chain;
  }

  idle(): Promise<void> {
    return this.chain;
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

/** Lets the process exit with the timer pending. */
export function unref<T>(timer: T): T {
  (timer as { unref?: () => unknown }).unref?.();
  return timer;
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => unref(setTimeout(resolve, ms)));
}
