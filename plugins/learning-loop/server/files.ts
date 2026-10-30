import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

/** Writes through a temp file in the same directory and renames it over the target. */
export async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  await fs.writeFile(temp, content, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) });
  try {
    await fs.rename(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return (await fs.readFile(path, "utf8")).replace(/^﻿/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Reads a JSON document. A missing file yields the fallback; an unreadable or invalid one is
 * moved aside (`<name>.corrupt-<time>`) and the fallback is used, so bad data is kept, not lost.
 */
export async function readJson<T>(path: string, fallback: T, parse: (value: unknown) => T): Promise<T> {
  const raw = await readText(path);
  if (raw === null) return fallback;
  try {
    return parse(JSON.parse(raw));
  } catch (error) {
    const aside = `${path}.corrupt-${Date.now()}`;
    await fs.rename(path, aside).catch(() => undefined);
    console.error(`[learning-loop] ${path} was invalid and was moved to ${aside}: ${describeError(error)}`);
    return fallback;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function appendLine(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Serializes async work: one writer at a time per queue. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}
