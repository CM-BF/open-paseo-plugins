import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StateSchema, type State } from "../shared/types";

function requireFields(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || fields.some((field) => !Object.hasOwn(value, field))) throw new Error("Incomplete saved triage state");
}
/** Defaults initialize new state, but cannot silently repair a truncated dedup ledger. */
function readState(raw: unknown): State {
  requireFields(raw, ["version", "createdAt", "enabledAt", "owner", "config", "scan", "items", "claims"]);
  if (!Array.isArray(raw.items)) throw new Error("Invalid item ledger");
  for (const item of raw.items) {
    requireFields(item, ["key", "snapshot", "status", "processedFingerprint", "run", "history", "attempts", "claimed"]);
    if (item.run) requireFields(item.run, ["id", "agentId", "fingerprint", "snapshot", "phase", "settings", "startedAt"]);
  }
  const state = StateSchema.parse(raw);
  if (new Set(state.items.map((item) => item.key)).size !== state.items.length) throw new Error("Duplicate issue identities");
  const agentIds = state.items.flatMap((item) => [...item.history, ...(item.run ? [item.run] : [])].map((run) => run.agentId));
  if (new Set(agentIds).size !== agentIds.length) throw new Error("Duplicate run identities");
  if (state.config.enabled && !state.owner) throw new Error("Enabled intake has no pinned identity");
  return state;
}

/** A single writer per daemon data directory. Invalid state fails closed instead of losing dedup keys. */
export class Store {
  state: State;
  error: string | null = null;
  private token = randomUUID();
  private locked = false;
  private file: string;
  private lock: string;
  constructor(readonly directory: string, now = Date.now()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, "state.json");
    this.lock = join(directory, "writer.lock");
    this.acquire();
    try {
      this.state = existsSync(this.file)
        ? readState(JSON.parse(readFileSync(this.file, "utf8")))
        : StateSchema.parse({ createdAt: new Date(now).toISOString() });
      this.save();
    } catch {
      this.close();
      throw new Error("Triage state could not be read or validated. Preserved the original file; restore it before enabling intake.");
    }
  }
  assertHealthy(): void {
    if (this.error) throw new Error(this.error);
    try {
      if (!this.locked || JSON.parse(readFileSync(this.lock, "utf8")).token !== this.token) throw new Error("Writer lease changed");
    } catch {
      this.error = "Triage writer ownership changed. Intake is stopped; inspect the writer lock before reloading.";
      throw new Error(this.error);
    }
  }
  save(): void {
    this.assertHealthy();
    if (!this.locked) throw new Error("Triage store is closed.");
    try {
      const validated = StateSchema.parse(this.state);
      const temporary = `${this.file}.${this.token}.tmp`;
      const fd = openSync(temporary, "w", 0o600);
      try { writeFileSync(fd, `${JSON.stringify(validated, null, 2)}\n`); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, this.file);
      const dir = openSync(this.directory, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch {
      this.error = "Persistent state write failed. Intake is stopped until storage is repaired and the plugin is reloaded.";
      throw new Error(this.error);
    }
  }
  close(): void {
    if (!this.locked) return;
    try {
      const record = JSON.parse(readFileSync(this.lock, "utf8"));
      if (record.token === this.token) unlinkSync(this.lock);
    } finally { this.locked = false; }
  }
  private acquire(): void {
    // Serialize stale-lock inspection and replacement. A crashed recovery guard fails closed;
    // it is never guessed stale and removed by a racing contender.
    const guard = `${this.lock}.acquire`;
    let guardFd: number;
    try { guardFd = openSync(guard, "wx", 0o600); }
    catch { throw new Error("Triage writer acquisition is active or was interrupted. Inspect writer.lock.acquire before recovery."); }
    try {
      writeFileSync(guardFd, JSON.stringify({ pid: process.pid, token: this.token }));
      fsyncSync(guardFd);
      if (existsSync(this.lock)) {
        let pid: number;
        try { pid = JSON.parse(readFileSync(this.lock, "utf8")).pid; } catch { throw new Error("Triage writer lock is invalid; inspect it before recovery."); }
        if (!Number.isInteger(pid) || pid <= 0) throw new Error("Triage writer lock is invalid.");
        try { process.kill(pid, 0); throw new Error("Another triage writer is active."); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          unlinkSync(this.lock);
        }
      }
      const fd = openSync(this.lock, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.token })); fsyncSync(fd); }
      finally { closeSync(fd); }
      this.locked = true;
    } finally { closeSync(guardFd); unlinkSync(guard); }
  }
}
