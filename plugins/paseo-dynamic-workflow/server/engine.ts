import { Worker } from "node:worker_threads";
import { clearTimeout, setTimeout } from "node:timers";
import type { AgentCall, Usage } from "../shared/run-types";
import { EFFORTS, type AgentOptions, type AgentOutcome, type AgentProgress, type AgentTask, type ParentContext } from "./agent-runner";
import { compileSchema, SchemaError } from "./json-schema";
import { callKey, type ResumeCache, type RunFiles, type RunRecord } from "./run-store";
import { PRELUDE, WORKER_SOURCE } from "./worker-source";
import { describeError, log, nowIso, preview, truncate, unref } from "./util";

export const MAX_ITEMS = 4096;
const RESULT_PREVIEW_CHARS = 20_000;
const CALL_PREVIEW_CHARS = 2_000;
const MAX_LOGS = 300;
const HEARTBEAT_MS = 10_000;
const STUCK_MS = 120_000;
const CLEANUP_WAIT_MS = 1000;

/** What the engine needs from the agent runner (tests pass a fake). */
export interface Runner {
  run(task: AgentTask, progress: AgentProgress): Promise<AgentOutcome>;
}

export interface EngineOptions {
  record: RunRecord;
  files: RunFiles;
  body: string;
  args: unknown;
  parent: ParentContext;
  cache: ResumeCache | null;
  runner: Runner;
  concurrency: number;
  maxAgents: number;
  agentTimeoutMs: number;
  archiveWhenDone: boolean;
  resolveWorkflow(ref: unknown, record: RunRecord): Promise<{ name: string; body: string; filename: string }>;
  onChange(engine: RunEngine): void;
  onFinished(engine: RunEngine): Promise<void> | void;
  /** Tests shorten the stuck-script watchdog. */
  watchdog?: { heartbeatMs: number; stuckMs: number };
}

interface ErrorReply {
  name: string;
  message: string;
  hard?: boolean;
}

class HardStop extends Error {
  override name = "WorkflowStopped";
}

/** One running workflow: its worker, its agent calls, and the record that describes them. */
export class RunEngine {
  readonly record: RunRecord;
  readonly files: RunFiles;
  private readonly options: EngineOptions;
  private worker: Worker | null = null;
  private readonly runAbort = new AbortController();
  private readonly callAborts = new Map<string, AbortController>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly queue: Array<{ start(): void; cancel(): void }> = [];
  private active = 0;
  private callSeq = 0;
  private liveAgents = 0;
  private lastPong = Date.now();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private settled = false;
  private usageFinalized = false;
  /** Set by stop(): the script's own failure (its agent() calls throw) still ends the run as stopped. */
  private stopReason: string | null = null;
  private readonly done: Promise<void>;
  private resolveDone: () => void = () => undefined;

  constructor(options: EngineOptions) {
    this.options = options;
    this.record = options.record;
    this.files = options.files;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  get runId(): string {
    return this.record.runId;
  }

  get finished(): Promise<void> {
    return this.done;
  }

  get isActive(): boolean {
    return !this.settled;
  }

  start(): void {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        prelude: PRELUDE,
        body: this.options.body,
        filename: `${this.record.meta.name}.workflow.js`,
        argsJson: this.options.args === undefined ? null : JSON.stringify(this.options.args),
        budgetTotal: this.record.budgetTotal,
        maxItems: MAX_ITEMS,
        maxRequests: Math.max(MAX_ITEMS, this.options.maxAgents),
      },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
      stdout: true,
      stderr: true,
    });
    this.worker = worker;
    worker.on("message", (message) => this.onMessage(message));
    worker.on("error", (error) => void this.finish("failed", `The script crashed: ${describeError(error)}`));
    worker.on("exit", (code) => {
      if (!this.settled && this.record.status === "running") {
        void this.finish("failed", `The script runtime exited unexpectedly (code ${code})`);
      }
    });
    const { heartbeatMs, stuckMs } = this.options.watchdog ?? { heartbeatMs: HEARTBEAT_MS, stuckMs: STUCK_MS };
    this.heartbeat = unref(
      setInterval(() => {
        if (this.settled) return;
        if (Date.now() - this.lastPong > stuckMs) {
          void this.finish("failed", `The script did not yield for ${Math.round(stuckMs / 1000)}s: it is probably stuck in a synchronous loop. Await agent() inside loops.`);
          return;
        }
        worker.postMessage({ t: "ping" });
      }, heartbeatMs),
    );
    void this.files.journal({ type: "run_started", at: this.record.startedAt, runId: this.runId, resumedFrom: this.record.resumedFrom });
  }

  /** Stops the run: queued calls fail, running children are archived, the worker ends. */
  async stop(reason: string): Promise<boolean> {
    if (this.settled || this.record.status !== "running") return false;
    this.stopReason = reason;
    this.record.status = "stopping";
    this.changed();
    await this.finish("stopped", reason);
    return true;
  }

  skip(callId: string): boolean {
    const call = this.record.calls.find((entry) => entry.callId === callId);
    const controller = this.callAborts.get(callId);
    if (!call || !controller || isTerminalCall(call.status)) return false;
    controller.abort("skipped by the user");
    return true;
  }

  /** The plugin is shutting down: record the run as interrupted; children are archived on the next start. */
  async interrupt(): Promise<void> {
    if (this.settled) return;
    this.runAbort.abort("the plugin stopped");
    for (const controller of this.callAborts.values()) controller.abort("the plugin stopped");
    await this.finish("interrupted", "The plugin stopped (reload, disable or daemon shutdown) while the run was active. Resume it with resumeFromRunId.");
  }

  private onMessage(message: { t: string; id?: number; op?: string; json?: string; ok?: boolean; error?: ErrorReply & { stack?: string | null } }): void {
    if (this.settled) return;
    if (message.t === "pong") {
      this.lastPong = Date.now();
      return;
    }
    if (message.t === "event") {
      const payload = safeParse(message.json) as Record<string, unknown> | null;
      if (!payload) return;
      if (message.op === "phase" && typeof payload.title === "string") this.addPhase(payload.title, true);
      if (message.op === "log" && typeof payload.message === "string") {
        this.addLog(payload.group ? `[${String(payload.group)}] ${payload.message}` : payload.message);
      }
      return;
    }
    if (message.t === "request" && typeof message.id === "number") {
      const id = message.id;
      const work =
        message.op === "agent"
          ? this.agentCall(safeParse(message.json) as AgentRequest)
          : message.op === "workflow"
            ? this.workflowCall(safeParse(message.json) as { ref: unknown; args: unknown })
            : Promise.reject(new Error(`unknown request ${message.op}`));
      work.then(
        (value) => this.reply(id, { ok: true, json: JSON.stringify(value === undefined ? null : value) }),
        (error) => this.reply(id, { ok: false, error: toReply(error) }),
      );
      return;
    }
    if (message.t === "done") {
      if (message.ok) void this.complete(message.json ?? "null");
      else void this.finish("failed", scriptError(message.error, this.record.meta.name));
    }
  }

  private reply(id: number, payload: { ok: true; json: string } | { ok: false; error: ErrorReply }): void {
    if (this.settled) return;
    try {
      this.worker?.postMessage({ t: "reply", id, ...payload });
    } catch (error) {
      log(`could not reply to the script of ${this.runId}: ${describeError(error)}`);
    }
  }

  private async workflowCall(request: { ref: unknown; args: unknown }): Promise<unknown> {
    if (this.runAbort.signal.aborted) throw new HardStop("The workflow was stopped");
    const source = await this.options.resolveWorkflow(request.ref, this.record);
    this.addLog(`Running nested workflow "${source.name}"`);
    return source;
  }

  private async agentCall(request: AgentRequest): Promise<unknown> {
    if (this.runAbort.signal.aborted) throw new HardStop("The workflow was stopped");
    const opts = normalizeOptions(request.opts ?? {});
    const prompt = request.prompt;
    const phase = typeof request.phase === "string" && request.phase ? request.phase : null;
    const callId = `a${++this.callSeq}`;
    const label = opts.label?.trim() || defaultLabel(prompt);
    const key = callKey(prompt, request.opts ?? {});
    if (phase) this.addPhase(phase, false);

    const cached = this.options.cache?.take(key);
    if (cached?.hit) {
      const call = this.newCall(callId, label, phase, "cached");
      call.startedAt = call.queuedAt;
      call.endedAt = call.queuedAt;
      call.resultPreview = preview(cached.value, CALL_PREVIEW_CHARS);
      call.worktree = cached.worktree;
      this.record.calls.push(call);
      void this.files.journal({ type: "agent_completed", at: nowIso(), callId, key, label, result: cached.value, cached: true, worktree: cached.worktree });
      this.changed();
      return cached.value;
    }

    if (this.liveAgents >= this.options.maxAgents) {
      throw new Error(`The run reached its agent cap (${this.options.maxAgents} agents); no more agent() calls can start`);
    }
    this.checkBudget();
    this.liveAgents++;

    const call = this.newCall(callId, label, phase, "queued");
    this.record.calls.push(call);
    this.changed();
    const controller = new AbortController();
    this.callAborts.set(callId, controller);
    const work = (async () => {
      const acquired = await this.acquire(controller.signal);
      if (!acquired) return { ok: false as const, error: "skipped by the user", skipped: true, worktree: null };
      try {
        if (this.runAbort.signal.aborted) throw new HardStop("The workflow was stopped");
        if (controller.signal.aborted) return { ok: false as const, error: "skipped by the user", skipped: true, worktree: null };
        this.checkBudget();
        call.status = "starting";
        call.startedAt = nowIso();
        this.changed();
        return await this.options.runner.run(
          {
            runId: this.runId,
            callId,
            workflowName: this.record.meta.name,
            label,
            phase,
            prompt,
            opts,
            parent: this.options.parent,
            signal: controller.signal,
            timeoutMs: this.options.agentTimeoutMs,
            archiveWhenDone: this.options.archiveWhenDone,
          },
          {
            creating: async (info) => {
              call.agentId = info.agentId;
              this.changed();
              await this.files.saveRecord(this.record);
            },
            started: (info) => {
              if (this.settled) return;
              call.status = "running";
              call.agentId = info.agentId;
              call.provider = info.provider;
              call.model = info.model;
              call.worktree = info.worktree;
              this.changed();
            },
            status: (status) => {
              if (this.settled) return;
              call.status = status;
              this.changed();
            },
            usage: (usage) => this.addUsage(call, usage),
            repaired: () => {
              if (this.settled) return;
              call.repairs++;
              this.changed();
            },
          },
        );
      } finally {
        this.release();
      }
    })();
    this.inFlight.add(work);
    let outcome: Awaited<typeof work>;
    try {
      outcome = await work;
    } catch (error) {
      if (!this.settled) {
        call.endedAt = nowIso();
        call.status = this.runAbort.signal.aborted ? "skipped" : "failed";
        call.error = describeError(error);
        void this.files.journal({ type: "agent_failed", at: call.endedAt, callId, key, label, error: call.error });
        this.changed();
      }
      throw error;
    } finally {
      this.inFlight.delete(work);
      this.callAborts.delete(callId);
    }
    if (this.settled) throw new HardStop("The workflow was stopped");
    call.endedAt = nowIso();
    call.worktree = outcome.worktree ?? call.worktree;
    if (outcome.ok) {
      call.status = "completed";
      call.resultPreview = preview(outcome.value, CALL_PREVIEW_CHARS);
      void this.files.journal({ type: "agent_completed", at: call.endedAt, callId, key, label, result: outcome.value, cached: false, worktree: call.worktree });
      if (outcome.worktree && outcome.worktree.changed !== false) {
        const description = outcome.worktree.changed ? "left changes" : "kept a worktree whose changes could not be inspected";
        this.addLog(`Agent "${label}" ${description} on branch ${outcome.worktree.branch} (${outcome.worktree.path})`);
      }
      this.changed();
      return outcome.value;
    }
    call.status = outcome.skipped ? "skipped" : "failed";
    call.error = outcome.error;
    void this.files.journal({ type: "agent_failed", at: call.endedAt, callId, key, label, error: outcome.error });
    if (this.runAbort.signal.aborted) {
      this.changed();
      throw new HardStop("The workflow was stopped");
    }
    if ("throws" in outcome && outcome.throws) {
      this.changed();
      throw new Error(outcome.error);
    }
    this.addLog(`Agent "${label}" ${outcome.skipped ? "was skipped" : `failed: ${outcome.error}`}; agent() returned null`);
    this.changed();
    return null;
  }

  private newCall(callId: string, label: string, phase: string | null, status: AgentCall["status"]): AgentCall {
    return {
      callId,
      label,
      phase,
      status,
      agentId: null,
      provider: null,
      model: null,
      queuedAt: nowIso(),
      startedAt: null,
      endedAt: null,
      resultPreview: null,
      error: null,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      worktree: null,
      repairs: 0,
    };
  }

  private checkBudget(): void {
    const total = this.record.budgetTotal;
    if (total !== null && this.record.usage.outputTokens >= total) {
      throw new Error(`The token budget is spent (${this.record.usage.outputTokens} of ${total} output tokens); agent() calls throw from here on`);
    }
  }

  private acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.active < this.options.concurrency) {
      this.active++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const entry = {
        start: () => {
          signal.removeEventListener("abort", entry.cancel);
          this.active++;
          resolve(true);
        },
        cancel: () => {
          signal.removeEventListener("abort", entry.cancel);
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          resolve(false);
        },
      };
      this.queue.push(entry);
      signal.addEventListener("abort", entry.cancel, { once: true });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next.start();
  }

  private addUsage(call: AgentCall, usage: Usage): void {
    if (this.usageFinalized) return;
    call.usage = sumUsage(call.usage, usage);
    this.record.usage = sumUsage(this.record.usage, usage);
    try {
      this.worker?.postMessage({ t: "spent", value: this.record.usage.outputTokens });
    } catch {
      // The worker already ended.
    }
    this.changed();
  }

  private addPhase(title: string, journal: boolean): void {
    if (!this.record.phaseOrder.includes(title)) this.record.phaseOrder.push(title);
    if (journal) void this.files.journal({ type: "phase", at: nowIso(), title });
    this.changed();
  }

  private addLog(message: string): void {
    const at = nowIso();
    this.record.logs.push({ at, message: truncate(message, 2000) });
    if (this.record.logs.length > MAX_LOGS) this.record.logs.splice(0, this.record.logs.length - MAX_LOGS);
    void this.files.journal({ type: "log", at, message: truncate(message, 2000) });
    this.changed();
  }

  private changed(): void {
    this.options.onChange(this);
  }

  private async complete(json: string): Promise<void> {
    if (this.settled) return;
    await this.files.writeResult(json).catch((error) => log(`could not write the result of ${this.runId}: ${describeError(error)}`));
    if (this.settled) return;
    this.record.resultPreview = truncate(json, RESULT_PREVIEW_CHARS);
    const leftover = [...this.callAborts.values()];
    if (leftover.length > 0) {
      this.addLog(`${leftover.length} agent() call(s) were still running when the script returned; they were stopped (await every agent() call)`);
      for (const controller of leftover) controller.abort("the script returned before this agent finished");
    }
    await this.finish("completed", null);
  }

  private async finish(requested: RunRecord["status"], requestedError: string | null): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    const stopped = this.stopReason !== null && requested !== "interrupted";
    const status = stopped ? "stopped" : requested;
    const error = stopped ? this.stopReason : requestedError;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.runAbort.abort(error ?? status);
    for (const controller of this.callAborts.values()) controller.abort(error ?? status);
    for (const entry of this.queue.splice(0)) entry.cancel();
    const worker = this.worker;
    this.worker = null;
    const terminated = worker?.terminate().catch(() => undefined);
    for (const call of this.record.calls) {
      if (!isTerminalCall(call.status)) {
        call.status = "skipped";
        call.endedAt = nowIso();
        call.error = call.error ?? `run ${status}`;
      }
    }
    this.record.status = status;
    this.record.error = error;
    this.record.endedAt = nowIso();
    // Give cooperative child cleanup a short window; an unavailable provider must not hold Stop open.
    let cancelWait: (() => void) | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.inFlight, ...(terminated ? [terminated] : [])]),
        new Promise((resolve) => {
          const timer = unref(setTimeout(resolve, CLEANUP_WAIT_MS));
          cancelWait = () => clearTimeout(timer);
        }),
      ]);
    } finally {
      cancelWait?.();
    }
    this.usageFinalized = true;
    await this.files.journal({ type: "run_finished", at: this.record.endedAt, status, error });
    this.options.onChange(this);
    try {
      await this.options.onFinished(this);
    } catch (error) {
      log(`could not finish ${this.runId}: ${describeError(error)}`);
    } finally {
      this.resolveDone();
    }
  }
}

interface AgentRequest {
  prompt: string;
  opts: Record<string, unknown>;
  phase: string | null;
}

export function isTerminalCall(status: AgentCall["status"]): boolean {
  return status === "completed" || status === "cached" || status === "failed" || status === "skipped";
}

function normalizeOptions(raw: Record<string, unknown>): AgentOptions {
  const options: AgentOptions = {};
  const string = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new TypeError(`agent() opts.${key} must be a string`);
    return value;
  };
  const label = string("label");
  if (label) options.label = truncate(label, 120);
  const model = string("model");
  if (model) options.model = model;
  const provider = string("provider");
  if (provider) options.provider = provider;
  const agentType = string("agentType");
  if (agentType) options.agentType = agentType;
  const effort = string("effort");
  if (effort) {
    if (!(EFFORTS as readonly string[]).includes(effort)) {
      throw new TypeError(`agent() opts.effort must be one of ${EFFORTS.join(", ")}`);
    }
    options.effort = effort;
  }
  const isolation = string("isolation");
  if (isolation) {
    if (isolation !== "worktree") throw new TypeError("agent() opts.isolation must be 'worktree'");
    options.isolation = "worktree";
  }
  const cwd = string("cwd");
  if (cwd) {
    if (!cwd.startsWith("/")) throw new TypeError("agent() opts.cwd must be an absolute path");
    options.cwd = cwd;
  }
  if (raw.schema !== undefined && raw.schema !== null) {
    try {
      options.schema = compileSchema(raw.schema);
    } catch (error) {
      if (error instanceof SchemaError) throw new TypeError(error.message);
      throw error;
    }
  }
  return options;
}

function defaultLabel(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.replace(/\s+/g, " ") ?? "agent";
  return truncate(line, 48);
}

function sumUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6,
  };
}

function toReply(error: unknown): ErrorReply {
  if (error instanceof HardStop) return { name: error.name, message: error.message, hard: true };
  if (error instanceof Error) return { name: error.name === "Error" ? "Error" : error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function safeParse(json: string | undefined): unknown {
  if (typeof json !== "string") return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** The error plus the script frames of its stack (`name.workflow.js:LINE:COL`). */
function scriptError(error: (ErrorReply & { stack?: string | null }) | undefined, name: string): string {
  if (!error) return "The script failed";
  const head = `${error.name}: ${error.message}`;
  const frames = (error.stack ?? "")
    .split("\n")
    .filter((line) => line.includes(`${name}.workflow.js:`))
    .slice(0, 3)
    .map((line) => line.trim());
  return frames.length ? `${head}\n${frames.join("\n")}` : head;
}
