import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function log(message: string): void {
  console.log(`[paseo-dynamic-workflow] ${message}`);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function nowIso(): string {
  return new Date().toISOString();
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

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

export function preview(value: unknown, max: number): string {
  if (value === null || value === undefined) return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return truncate(text ?? String(value), max);
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Lets the process exit with the timer pending (React Native's typings make timers numbers). */
export function unref<T>(timer: T): T {
  (timer as { unref?: () => unknown }).unref?.();
  return timer;
}
