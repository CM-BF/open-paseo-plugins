import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { serialize } from "node:v8";
import workerSource from "./assets/store-worker.txt";
import type { BoardChange, BoardChanges, BoardEventCursor, BoardSummary, CreateInput } from "../shared/contracts";
import type { BoardStore, BoardStoreApi } from "./store";
import { BoardStoreError, assertId, ensureDirectory } from "./store-format";
import { BoardEventHub } from "./board-events";
import { boardPartition, type StoreMethod } from "./store-worker-protocol";

interface Job { id: string; method: StoreMethod; args: unknown[]; boardId: string; bytes: number; resolve(value: any): void; reject(error: Error): void }
interface Slot { index: number; child?: ChildProcess; ready: boolean; queue: Job[]; bytes: number; active?: Job; timer?: ReturnType<typeof setTimeout>; starting?: Promise<void>; started: boolean; restarts: number[]; retryAt: number; recoveryTimer?: ReturnType<typeof setTimeout> }
export interface StorePoolOptions {
  workerDir?: string;
  workers?: number;
  maxPendingPerWorker?: number;
  maxPendingPerBoard?: number;
  maxBytesPerWorker?: number;
  timeoutMs?: number;
  /** Dependency injection for deterministic subprocess failure tests. */
  workerSource?: string;
}

/** Bounded process ownership, compact event index, and same-Board FIFO. */
export class BoardStorePool implements BoardStoreApi {
  readonly rootDir: string;
  readonly events = new BoardEventHub();
  private readonly slots: Slot[];
  private readonly options: Required<StorePoolOptions>;
  private readonly token = randomUUID();
  private initialization?: Promise<void>;
  private initialized = false;
  private stopping = false;
  private closing?: Promise<void>;
  private workerPath = "";
  private ownsLease = false;
  private leaseWrites = Promise.resolve();

  constructor(rootDir: string, options: StorePoolOptions = {}) {
    this.rootDir = resolve(rootDir);
    this.options = { workerDir: join(this.rootDir, "workers"), workers: Math.min(2, availableParallelism()), maxPendingPerWorker: 32, maxPendingPerBoard: 8, maxBytesPerWorker: 16_000_000, timeoutMs: 25000, workerSource, ...options };
    if (!Number.isInteger(this.options.workers) || this.options.workers < 1 || this.options.workers > 4) throw new RangeError("Board worker count must be between 1 and 4");
    for (const name of ["maxPendingPerWorker", "maxPendingPerBoard", "maxBytesPerWorker", "timeoutMs"] as const) {
      if (!Number.isSafeInteger(this.options[name]) || this.options[name] < 1) throw new RangeError(`Invalid ${name}`);
    }
    this.slots = Array.from({ length: this.options.workers }, (_, index) => ({ index, ready: false, queue: [], bytes: 0, started: false, restarts: [], retryAt: 0 }));
  }

  init(): Promise<void> {
    if (this.stopping) return Promise.reject(new BoardStoreError("worker_unavailable", "Board store is stopped"));
    return this.initialization ??= this.initialize().catch(async error => { await this.close(); throw error; });
  }
  private async initialize(): Promise<void> {
    await ensureDirectory(this.rootDir);
    await ensureDirectory(this.options.workerDir);
    if (this.stopping) throw new BoardStoreError("worker_unavailable", "Board store is stopped");
    await this.acquireLease();
    if (this.stopping) { await this.releaseLease(); throw new BoardStoreError("worker_unavailable", "Board store is stopped"); }
    const digest = createHash("sha256").update(this.options.workerSource).digest("hex");
    this.workerPath = join(this.options.workerDir, `board-store-${digest}.cjs`);
    try { await writeFile(this.workerPath, this.options.workerSource, { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await lstat(this.workerPath);
    if (stat.isSymbolicLink() || !stat.isFile() || await readFile(this.workerPath, "utf8") !== this.options.workerSource) throw new BoardStoreError("unsafe_path", "Worker artifact does not match this plugin");
    if (this.stopping) { await this.releaseLease(); throw new BoardStoreError("worker_unavailable", "Board store is stopped"); }
    await Promise.all(this.slots.map(slot => this.start(slot)));
    this.initialized = true;
    for (const slot of this.slots) this.dispatch(slot);
  }

  private async acquireLease(): Promise<void> {
    // Serialize stale-lease replacement itself. An inode check followed by unlink
    // is not a compare-and-swap: another coordinator could create its lease between
    // those calls. A crashed acquisition conservatively requires manual recovery
    // of this small lock directory; never race to reclaim the reclaim lock.
    const reclaim = join(this.rootDir, ".store-pool-reclaim");
    try { await mkdir(reclaim, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BoardStoreError("worker_busy", "Board ownership acquisition is locked; retry after the other startup finishes. If its process crashed, inspect the reclaim lock before removing it.");
      throw error;
    }
    try { await this.acquireLeaseLocked(); }
    finally { await rmdir(reclaim); }
  }
  private async acquireLeaseLocked(): Promise<void> {
    const path = join(this.rootDir, ".store-pool-owner.json");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(JSON.stringify({ token: this.token, pid: process.pid, children: [] })); await file.sync(); }
        finally { await file.close(); }
        this.ownsLease = true; return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new BoardStoreError("unsafe_path", "Invalid Board worker lease");
        let previous: { token: string; pid: number; children: number[] };
        try { previous = JSON.parse(await readFile(path, "utf8")); } catch { throw new BoardStoreError("worker_busy", "Board worker ownership cannot be verified"); }
        if (!previous || !Array.isArray(previous.children) || ![previous.pid, ...previous.children].every(pid => Number.isInteger(pid) && pid > 0 && !processExists(pid))) throw new BoardStoreError("worker_busy", "Another Board worker pool owns this storage");
        const current = await lstat(path);
        if (current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs) throw new BoardStoreError("worker_busy", "Board worker ownership changed");
        await unlink(path);
      }
    }
    throw new BoardStoreError("worker_busy", "Could not acquire Board storage ownership");
  }
  private saveLease(): Promise<void> {
    this.leaseWrites = this.leaseWrites.then(async () => {
      if (!this.ownsLease) return;
      const path = join(this.rootDir, ".store-pool-owner.json");
      const current = JSON.parse(await readFile(path, "utf8"));
      if (current.token !== this.token) throw new BoardStoreError("worker_busy", "Board worker ownership changed");
      const temporary = path + "." + this.token;
      await writeFile(temporary, JSON.stringify({ token: this.token, pid: process.pid, children: this.slots.flatMap(slot => slot.child?.pid ? [slot.child.pid] : []) }), { mode: 0o600 });
      await rename(temporary, path);
    });
    return this.leaseWrites;
  }

  private start(slot: Slot): Promise<void> {
    if (slot.starting) return slot.starting;
    if (slot.child) return slot.ready ? Promise.resolve() : Promise.reject(new BoardStoreError("worker_unavailable", "Worker is stopping"));
    if (this.stopping) return Promise.reject(new BoardStoreError("worker_unavailable", "Board store is stopped"));
    const now = Date.now();
    slot.restarts = slot.restarts.filter(at => now - at < 60000);
    if (slot.started && (slot.restarts.length >= 3 || now < slot.retryAt)) return Promise.reject(new BoardStoreError("worker_unavailable", "Board worker recovery is backing off; retry later"));
    if (slot.recoveryTimer) { clearTimeout(slot.recoveryTimer); slot.recoveryTimer = undefined; }
    const restart = slot.started;
    if (restart) slot.restarts.push(now);
    slot.starting = new Promise<void>((resolveReady, rejectReady) => {
      const child = fork(this.workerPath, [], { execArgv: ["--max-old-space-size=384"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"] });
      slot.child = child;
      let stderr = "";
      child.stderr?.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-2000); });
      const startup = setTimeout(() => { child.kill(); rejectReady(new BoardStoreError("worker_unavailable", "Board worker startup timed out")); }, this.options.timeoutMs);
      child.on("message", (message: any) => {
        if (slot.child !== child || this.stopping) return;
        if (message?.type === "ready") {
          clearTimeout(startup); slot.ready = true; slot.started = true;
          // A child may have committed just before losing IPC. Recover every owned
          // summary, including equal-revision seen receipts, and invalidate readers.
          if (restart) for (const summary of message.summaries as BoardSummary[]) this.events.accept({ summary, canvasRevision: message.canvasRevisions[summary.id], reason: "content" });
          else this.events.seed(message.summaries);
          resolveReady(); this.dispatch(slot);
        } else if (message?.type === "startup-error") {
          clearTimeout(startup); rejectReady(remoteError(message.error)); child.kill();
        } else if (message?.type === "commit") this.events.accept(message.notice);
        else if (message?.type === "result" && slot.active && slot.active.id === message.id) {
          const job = slot.active; slot.active = undefined; slot.bytes -= job.bytes;
          if (slot.timer) clearTimeout(slot.timer);
          if (message.error) job.reject(remoteError(message.error)); else job.resolve(message.value);
          this.dispatch(slot);
        }
      });
      child.once("error", error => { rejectReady(error); });
      child.once("close", () => {
        clearTimeout(startup); if (slot.timer) clearTimeout(slot.timer);
        const active = slot.active;
        slot.child = undefined; slot.ready = false; slot.active = undefined;
        const failure = new BoardStoreError("worker_unavailable", "Board worker exited; queued operations were not executed", { diagnostic: stderr });
        rejectReady(failure);
        if (active) active.reject(new BoardStoreError(active.method === "read" ? "worker_unavailable" : "outcome_unknown", "Board worker stopped before its response; inspect state or retry the identical durable request", { method: active.method, boardId: active.boardId }));
        for (const job of slot.queue.splice(0)) job.reject(failure);
        slot.bytes = 0;
        void this.saveLease().then(() => this.recoverWorker(slot)).catch(() => { void this.close(); });
      });
      void this.saveLease().then(() => {
        if (!this.stopping && child.connected) child.send({ type: "init", rootDir: this.rootDir, index: slot.index, count: this.slots.length, recover: restart });
        else child.kill();
      }).catch(error => { rejectReady(error); child.kill(); });
    }).finally(() => { slot.starting = undefined; });
    return slot.starting;
  }

  /** Recovery is triggered by a process exit, never by a periodic status query. */
  private recoverWorker(slot: Slot): void {
    if (this.stopping || !slot.started || slot.child || slot.recoveryTimer) return;
    const now = Date.now();
    slot.restarts = slot.restarts.filter(at => now - at < 60000);
    if (slot.restarts.length >= 3) return; // A broken executable must not spawn forever.
    const delay = [100, 500, 2000][slot.restarts.length];
    slot.retryAt = now + delay;
    slot.recoveryTimer = setTimeout(() => {
      slot.recoveryTimer = undefined;
      void this.start(slot).catch(() => { /* close triggers the next bounded attempt. */ });
    }, delay);
    (slot.recoveryTimer as unknown as { unref?: () => void }).unref?.();
  }

  private dispatch(slot: Slot): void {
    if (this.stopping || !this.initialized || !slot.ready || slot.active || !slot.child) return;
    const job = slot.queue.shift(); if (!job) return;
    slot.active = job;
    slot.timer = setTimeout(() => { slot.ready = false; slot.child?.kill("SIGKILL"); }, this.options.timeoutMs);
    const child = slot.child;
    child.send({ type: "call", id: job.id, method: job.method, args: job.args }, error => { if (error && slot.child === child) { slot.ready = false; child.kill("SIGKILL"); } });
  }
  private async call<T>(method: StoreMethod, boardId: string, args: unknown[]): Promise<T> {
    assertId(boardId);
    if (this.stopping) throw new BoardStoreError("worker_unavailable", "Board store is stopped");
    const slot = this.slots[boardPartition(boardId, this.slots.length)];
    const count = slot.queue.length + Number(!!slot.active);
    const own = slot.queue.filter(job => job.boardId === boardId).length + Number(slot.active?.boardId === boardId);
    if (count >= this.options.maxPendingPerWorker || own >= this.options.maxPendingPerBoard) throw new BoardStoreError("backpressure", "Board worker queue is full; retry the same request later");
    let bytes: number;
    try { bytes = serialize(args).byteLength; } catch { throw new BoardStoreError("invalid_input", "Board request is not serializable"); }
    if (slot.bytes + bytes > this.options.maxBytesPerWorker) throw new BoardStoreError("backpressure", "Board worker byte budget is full; retry the same request later");
    // Reserve capacity and freeze input before initialization or any queue wait.
    const frozen = structuredClone(args);
    const promise = new Promise<T>((resolve, reject) => { slot.queue.push({ id: randomUUID(), method, boardId, args: frozen, bytes, resolve, reject }); slot.bytes += bytes; });
    void this.init().then(async () => {
      if (!slot.child) await this.start(slot);
      this.dispatch(slot);
    }).catch(error => { for (const job of slot.queue.splice(0)) { slot.bytes -= job.bytes; job.reject(error); } });
    return promise;
  }

  private async readyIndex(): Promise<void> { await this.init(); await Promise.all(this.slots.map(slot => this.start(slot))); }
  async list(filter: { workspaceId?: string } = {}) { await this.readyIndex(); return this.events.snapshot(filter).boards; }
  async summarySnapshot(filter: { workspaceId?: string } = {}) { await this.readyIndex(); return this.events.snapshot(filter); }
  async changesSince(cursor?: BoardEventCursor, compact = false): Promise<BoardChanges> { await this.readyIndex(); return this.events.changesSince(cursor, compact); }
  hasChanges(cursor: BoardEventCursor): boolean { return this.events.hasChanges(cursor); }
  subscribe(listener: (change: BoardChange) => void) { return this.events.subscribe(listener); }
  read: BoardStore["read"] = id => this.call("read", id, [id]);
  create: BoardStore["create"] = raw => { const input: CreateInput = { ...raw, id: raw.id ?? randomUUID() }; return this.call("create", input.id!, [input]); };
  publish: BoardStore["publish"] = (...args) => this.call("publish", args[0].boardId, args);
  respond: BoardStore["respond"] = (...args) => this.call("respond", args[0].boardId, args);
  emit: BoardStore["emit"] = (...args) => this.call("emit", args[0].boardId, args);
  feed: BoardStore["feed"] = (...args) => this.call("feed", args[0].boardId, args);
  rename: BoardStore["rename"] = (...args) => this.call("rename", args[0].boardId, args);
  edit: BoardStore["edit"] = (...args) => this.call("edit", args[0].boardId, args);
  recordDecision: BoardStore["recordDecision"] = (...args) => this.call("recordDecision", args[0].boardId, args);
  saveState: BoardStore["saveState"] = (...args) => this.call("saveState", args[0].boardId, args);
  markUpdatesSeen: BoardStore["markUpdatesSeen"] = (...args) => this.call("markUpdatesSeen", args[0].boardId, args);
  addInteraction: BoardStore["addInteraction"] = (...args) => this.call("addInteraction", args[0].boardId, args);
  updateInteraction: BoardStore["updateInteraction"] = (...args) => this.call("updateInteraction", args[0], args);
  projectSideAgent: BoardStore["projectSideAgent"] = (...args) => this.call("projectSideAgent", args[0], args);
  updateExtraction: BoardStore["updateExtraction"] = (...args) => this.call("updateExtraction", args[0], args);
  diagnostics() { return this.slots.map(slot => ({ partition: slot.index, pid: slot.child?.pid, pending: slot.queue.length + Number(!!slot.active), bytes: slot.bytes, ready: slot.ready })); }

  close(): Promise<void> { return this.closing ??= this.closeNow(); }
  private async closeNow(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.slots.map(async slot => {
      if (slot.recoveryTimer) clearTimeout(slot.recoveryTimer);
      for (const job of slot.queue.splice(0)) { slot.bytes -= job.bytes; job.reject(new BoardStoreError("worker_unavailable", "Board store stopped before this operation started")); }
      const child = slot.child; if (!child) return;
      await new Promise<void>(resolveExit => {
        const force = setTimeout(() => child.kill("SIGKILL"), 1500);
        child.once("close", () => { clearTimeout(force); resolveExit(); });
        child.kill("SIGTERM");
      });
    }));
    await this.leaseWrites.catch(() => undefined);
    await this.releaseLease();
  }
  private async releaseLease(): Promise<void> {
    if (this.ownsLease) {
      const path = join(this.rootDir, ".store-pool-owner.json");
      try {
        const lease = JSON.parse(await readFile(path, "utf8"));
        if (lease.token === this.token) await unlink(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.ownsLease = false;
    }
  }
}

function remoteError(value: { code?: string; message?: string; details?: Record<string, unknown> }) {
  return new BoardStoreError(value.code ?? "request_failed", value.message ?? "Board worker failed", value.details ?? {});
}
function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
