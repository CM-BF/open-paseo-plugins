import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Write through a sibling temp file so readers never see a partial file. Mode stays 0600. */
export function writePrivateFileAtomic(path: string, content: string): void {
  const dir = dirname(path);
  ensurePrivateDir(dir);
  const temp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, content, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(raw) as unknown;
}
