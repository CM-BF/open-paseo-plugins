/**
 * Sealed comment runs (lockdown design 2026-11-13 §3.1–§3.3): one headless `claude -p` process per batch,
 * launched with the plugin's own argv, settings, env, empty temp cwd and single MCP server. The run's binding is
 * armed only after the CLI's `system:init` passes `verifyInit`; a failed check kills the process group before
 * any comment can be read (stdin carries only the batch's IDs; the comment text is reachable only through an armed
 * binding). Bindings live in memory only, so an orphaned process cannot act after a restart.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxRunActions, InboxScope } from "../shared/inbox";
import type { ModelRoute } from "./kit/complete";
import { ALLOWED_TOOLS, CATEGORY_TEXT, PREFLIGHT_PROMPT, auditEvent, classifyResult, lockArgs, lockEnv, verifyInit, type FailureCategory, type StreamEvent, type VerifyResult } from "./inbox-lock";

/* ---------- bindings ---------- */
export interface RunnerBinding {
  token: string; scopeKey: string; scope: InboxScope; runId: string; actorId: string;
  commentIds: ReadonlySet<string>; armed: boolean; expiresAt: number;
  actions: InboxRunActions;
}
/** The stable inbox identity of a Board's runner, so the per-Board reply limits count across runs. */
export const runnerActorId = (scopeKey: string) => `paseo-board-inbox-runner:${scopeKey.slice(0, 16)}`;
export const isRunnerActor = (agentId: string) => agentId.startsWith("paseo-board-inbox-runner:");
/** In-memory registry of run tokens (§3.2). Never persisted. */
export class RunnerBindings {
  private readonly byToken = new Map<string, RunnerBinding>();
  constructor(private readonly now: () => number = Date.now) {}
  create(input: { scopeKey: string; scope: InboxScope; runId: string; commentIds: Iterable<string>; expiresAt: number }): RunnerBinding {
    const binding: RunnerBinding = { token: randomBytes(24).toString("hex"), scopeKey: input.scopeKey, scope: { boardId: input.scope.boardId, expectedCreatedAt: input.scope.expectedCreatedAt }, runId: input.runId, actorId: runnerActorId(input.scopeKey), commentIds: new Set(input.commentIds), armed: false, expiresAt: input.expiresAt, actions: { replied: 0, drafted: 0, triaged: 0, dismissed: 0 } };
    this.byToken.set(binding.token, binding);
    return binding;
  }
  /** The binding of a token, armed or not; an expired one is revoked. */
  get(token: string): RunnerBinding | undefined {
    const binding = this.byToken.get(token);
    if (binding && this.now() > binding.expiresAt) { this.byToken.delete(token); return undefined; }
    return binding;
  }
  arm(token: string): boolean { const binding = this.get(token); if (!binding) return false; binding.armed = true; return true; }
  revoke(token: string): void { this.byToken.delete(token); }
  /** The armed, unexpired binding of a scope's runner actor (at most one run per scope). */
  armedFor(scope: InboxScope, actorId: string): RunnerBinding | undefined {
    for (const binding of this.byToken.values()) {
      if (binding.actorId !== actorId || binding.scope.boardId !== scope.boardId || binding.scope.expectedCreatedAt !== scope.expectedCreatedAt) continue;
      if (this.now() > binding.expiresAt) { this.byToken.delete(binding.token); continue; }
      if (binding.armed) return binding;
    }
    return undefined;
  }
  clear(): void { this.byToken.clear(); }
  get size(): number { return this.byToken.size; }
}

/* ---------- process ---------- */
export interface StreamExit { code: number | null; signal: string | null; missing?: boolean }
export interface StreamProcess { kill(): void; exited: Promise<StreamExit> }
export interface StreamExecOptions { cwd: string; env: Readonly<Record<string, string>>; stdin: string; onLine(line: string): void; onBytes(total: number): void }
/** Injectable so tests can replay a recorded stream. */
export type StreamExec = (argv: readonly string[], options: StreamExecOptions) => StreamProcess;

function killGroup(child: ChildProcess): void {
  try { if (child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
}
/** spawn without a shell in its own process group; stdin is the prompt, stderr is ignored, stdout is read as lines. */
export const spawnStreamExec: StreamExec = (argv, options) => {
  let child: ChildProcess;
  try {
    child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, detached: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { kill: () => undefined, exited: Promise.resolve({ code: null, signal: null, missing: code === "ENOENT" || code === "EACCES" }) };
  }
  let missing = false, pending = "", bytes = 0;
  const exited = new Promise<StreamExit>(resolve => {
    let settled = false;
    const finish = (code: number | null, signal: string | null) => { if (settled) return; settled = true; if (pending.trim()) options.onLine(pending); pending = ""; resolve({ code, signal, ...(missing ? { missing: true } : {}) }); };
    child.on("error", (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" || error.code === "EACCES") missing = true; finish(null, null); });
    child.on("close", (code, signal) => finish(typeof code === "number" ? code : null, signal ?? null));
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk); options.onBytes(bytes);
    pending += chunk;
    for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) { const line = pending.slice(0, index); pending = pending.slice(index + 1); if (line.trim()) options.onLine(line); }
  });
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(options.stdin, "utf8");
  return { kill: () => killGroup(child), exited };
};

/* ---------- runs ---------- */
export type RunState = "done" | "failed" | "lockdown" | "not-ready" | "unsupported" | "timeout" | "interrupted";
export interface RunOutcome {
  state: RunState;
  /** Whether the binding was ever armed (the batch was offered to the model). */
  armed: boolean;
  cliVersion: string | null; model: string | null;
  findings: string[];
  /** A short, fixed Chinese reason; never CLI output or an API response body. */
  error: string | null;
  category: FailureCategory | "cli_missing" | "exit_before_init" | "init_timeout" | "timeout" | "too_large" | "tool_cap" | "bad_output" | "cli_failed" | "aborted" | "bad_input" | "route_args" | "token_expired" | null;
  modelUnavailable: boolean;
  deniedAttempts: string[]; toolUses: number;
  /**
   * The run's cost: the CLI's `total_cost_usd`, or, when a run that may have called the model (its init passed the
   * check, or the model wrote output) ended without reporting one (killed at a cap, timed out, aborted, crashed), its
   * `--max-budget-usd`: the CLI stops a run once it reaches that budget, so it bounds what the run can have spent.
   * Null only for a run that never reached the model.
   */
  costUsd: number | null;
  /** costUsd is the run's budget, not a reported cost. */
  costEstimated: boolean;
  /** From the moment the run held a host slot (time spent queued is not counted). */
  durationMs: number; actions: InboxRunActions;
}
export interface RunInput {
  scope: InboxScope; scopeKey: string; runId: string;
  route: ModelRoute; model: string; effort: "low" | "medium" | null; maxBudgetUsd: number;
  systemPrompt: string;
  /** The IDs-only prompt (stdin). Ignored for a preflight. */
  prompt: string; commentIds: string[];
  /** A preflight (§3.3): stdin `预检：不要调用任何工具。`, an unarmed binding with no comments, one short turn. */
  preflight?: boolean;
  maxToolCalls?: number;
  signal?: AbortSignal;
  /** Called once when init passed the check: the binding is armed (a preflight's stays unarmed). */
  onVerified?(check: Extract<VerifyResult, { ok: true }>): void;
}
export interface RunnerClock { now(): number; setTimer(callback: () => void, ms: number): unknown; clearTimer(handle: unknown): void }
export interface SealedRunnerOptions {
  bindings: RunnerBindings; mcpCommand: string;
  exec?: StreamExec; env?: Readonly<Record<string, string | undefined>>; clock?: RunnerClock; tmpRoot?: string;
  limits?: Partial<{ initTimeoutMs: number; runTimeoutMs: number; preflightTimeoutMs: number; outputBytes: number; maxConcurrent: number }>;
  log?(message: string): void;
}
const realClock: RunnerClock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => { const timer = setTimeout(callback, Math.max(0, ms)); (timer as { unref?: () => void }).unref?.(); return timer; },
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Launches sealed runs: at most `maxConcurrent` on the host at once, the rest queue. */
export class SealedRunner {
  private readonly clock: RunnerClock;
  private readonly limits: { initTimeoutMs: number; runTimeoutMs: number; preflightTimeoutMs: number; outputBytes: number; maxConcurrent: number };
  private readonly live = new Set<() => void>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private closed = false;
  constructor(private readonly o: SealedRunnerOptions) {
    this.clock = o.clock ?? realClock;
    this.limits = { initTimeoutMs: 30_000, runTimeoutMs: 300_000, preflightTimeoutMs: 90_000, outputBytes: 4 * 1024 * 1024, maxConcurrent: 2, ...o.limits };
  }
  /** Runs in flight (tests). */
  get running(): number { return this.live.size; }
  async run(input: RunInput): Promise<RunOutcome> {
    const queued = this.clock.now();
    while (this.active >= this.limits.maxConcurrent && !this.closed && !input.signal?.aborted) await new Promise<void>(resolve => this.waiting.push(resolve));
    if (this.closed || input.signal?.aborted) return outcome("interrupted", queued, this.clock.now(), { category: "aborted", error: "运行被停止" });
    this.active++;
    try { return await this.runOnce(input); }
    finally { this.active--; this.waiting.shift()?.(); }
  }
  /** Kills every live run's process group (plugin close); queued runs end as interrupted. */
  async close(): Promise<void> {
    this.closed = true;
    for (const stop of [...this.live]) stop();
    for (const resolve of this.waiting.splice(0)) resolve();
  }
  private async runOnce(input: RunInput): Promise<RunOutcome> {
    // The run's clock (its token's lifetime and durationMs) starts once it holds a host slot, not when it queued:
    // a run that waited behind others must not lose its token before its own time limit.
    const started = this.clock.now();
    // Only the executable: extra provider arguments (for example --append-system-prompt-file) could add context
    // the init check cannot see. The coordinator refuses such a route earlier; this is the belt (a start failure).
    if (input.route.command.length !== 1) return outcome("unsupported", started, this.clock.now(), { category: "route_args", findings: ["提供方命令带有额外参数"], error: "提供方命令带有额外参数，没有启动" });
    let cwd: string;
    try { cwd = await realpath(await mkdtemp(join(this.o.tmpRoot ?? tmpdir(), "paseo-board-run-"))); await chmod(cwd, 0o700); }
    catch { return outcome("failed", started, this.clock.now(), { category: "bad_input", error: "无法创建临时工作目录" }); }
    const preflight = Boolean(input.preflight);
    const timeoutMs = preflight ? this.limits.preflightTimeoutMs : this.limits.runTimeoutMs;
    const binding = this.o.bindings.create({ scopeKey: input.scopeKey, scope: input.scope, runId: input.runId, commentIds: preflight ? [] : input.commentIds, expiresAt: this.clock.now() + timeoutMs + 60_000 });
    try {
      let argv: string[];
      try { argv = [...input.route.command, ...lockArgs({ model: input.model, effort: input.effort, maxBudgetUsd: input.maxBudgetUsd, systemPrompt: input.systemPrompt, mcpCommand: this.o.mcpCommand, bindingToken: binding.token })]; }
      catch { return outcome("failed", started, this.clock.now(), { category: "bad_input", error: "运行参数无效" }); }
      const env = lockEnv(this.o.env ?? process.env, input.route);
      return await this.stream(argv, { cwd, env, stdin: preflight ? PREFLIGHT_PROMPT : input.prompt }, { input, binding, preflight, timeoutMs, started, cwd });
    } finally {
      this.o.bindings.revoke(binding.token);
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  private stream(argv: string[], spawnOptions: { cwd: string; env: Record<string, string>; stdin: string }, run: { input: RunInput; binding: RunnerBinding; preflight: boolean; timeoutMs: number; started: number; cwd: string }): Promise<RunOutcome> {
    const { input, binding, preflight } = run;
    const maxToolCalls = input.maxToolCalls ?? 6 + 4 * Math.max(1, input.commentIds.length);
    const st = {
      initSeen: false, offered: false, modelOutput: false, toolUses: 0, denied: [] as string[],
      verdict: null as Extract<VerifyResult, { ok: false }> | null,
      verified: null as Extract<VerifyResult, { ok: true }> | null,
      stopReason: null as null | "init_timeout" | "timeout" | "too_large" | "tool_cap" | "aborted" | "lockdown" | "token_expired",
      result: null as Extract<StreamEvent, { kind: "result" }> | null,
    };
    let proc: StreamProcess | undefined;
    const stop = (reason: NonNullable<typeof st.stopReason>) => { st.stopReason ??= reason; proc?.kill(); };
    const fail = (verdict: Extract<VerifyResult, { ok: false }>) => { st.verdict = verdict; binding.armed = false; this.o.bindings.revoke(binding.token); stop("lockdown"); };
    const check = (event: Record<string, unknown>) => {
      const verification = verifyInit(event, { cwd: run.cwd, model: input.model });
      if (!verification.ok) { fail(verification); return; }
      const first = !st.verified;
      st.verified = verification;
      // Arm only now: before this point every inbox call of the run is refused (§3.3 order of events). A token that
      // is already gone (it expired, for example across a sleep) cannot be armed: the batch was never offered.
      if (!preflight && !binding.armed) {
        if (!this.o.bindings.arm(binding.token)) { stop("token_expired"); return; }
        st.offered = true;
      }
      if (first) input.onVerified?.(verification);
    };
    const onLine = (line: string) => {
      let value: unknown;
      try { value = JSON.parse(line); } catch { return; }
      const event = auditEvent(value);
      if (event.kind !== "init" && event.kind !== "system") st.modelOutput = true;
      if (!st.initSeen) {
        if (event.kind === "init") { st.initSeen = true; check(event.event); }
        // Anything but a system message before init means the model ran unchecked: fail closed.
        else if (event.kind !== "system") fail({ ok: false, kind: "violation", findings: ["启动检查之前就有输出"], cliVersion: null });
        return;
      }
      if (event.kind === "init") { check(event.event); return; } // A second init is verified again.
      if (event.kind === "tools") {
        for (const name of event.names) {
          st.toolUses++;
          if (!ALLOWED_TOOLS.includes(name) && st.denied.length < 10 && !st.denied.includes(name)) st.denied.push(name.slice(0, 100));
        }
        if (st.toolUses > maxToolCalls) stop("tool_cap");
      } else if (event.kind === "result") st.result = event;
    };
    return new Promise<RunOutcome>(resolve => {
      const stopper = () => stop("aborted");
      this.live.add(stopper);
      input.signal?.addEventListener("abort", stopper, { once: true });
      const initTimer = this.clock.setTimer(() => { if (!st.initSeen) stop("init_timeout"); }, this.limits.initTimeoutMs);
      const runTimer = this.clock.setTimer(() => stop("timeout"), run.timeoutMs);
      proc = (this.o.exec ?? spawnStreamExec)(argv, { ...spawnOptions, onLine, onBytes: total => { if (total > this.limits.outputBytes) stop("too_large"); } });
      if (st.stopReason) proc.kill();
      void proc.exited.catch((): StreamExit => ({ code: null, signal: null })).then(exit => {
        this.clock.clearTimer(initTimer); this.clock.clearTimer(runTimer);
        this.live.delete(stopper); input.signal?.removeEventListener("abort", stopper);
        // An armed token that is gone before we revoke it expired while the process was live (for example across
        // a sleep): the model's later inbox calls were refused, so the run did not finish its batch.
        const expired = st.offered && !st.verdict && !this.o.bindings.get(binding.token);
        this.o.bindings.revoke(binding.token);
        // A run that may have reached the model but reported no cost is charged its budget (see RunOutcome.costUsd).
        const reported = st.result?.costUsd ?? null, charged = reported ?? (st.verified || st.modelOutput ? input.maxBudgetUsd : null);
        const at = this.clock.now(), done = (state: RunState, patch: Partial<RunOutcome> = {}) => resolve(outcome(state, run.started, at, {
          armed: st.offered, cliVersion: st.verified?.cliVersion ?? st.verdict?.cliVersion ?? null, model: st.verified?.model ?? null,
          deniedAttempts: st.denied, toolUses: st.toolUses, costUsd: charged, costEstimated: reported === null && charged !== null, actions: { ...binding.actions }, ...patch,
        }));
        const { verdict, result, stopReason } = st;
        if (exit.missing) return done("unsupported", { category: "cli_missing", error: "找不到 claude 命令" });
        if (stopReason === "aborted") return done("interrupted", { category: "aborted", error: "运行被停止" });
        if (stopReason === "token_expired") return done("interrupted", { category: "token_expired", error: "运行令牌在启动检查前过期，已中断" });
        if (verdict) return done(verdict.kind === "violation" ? "lockdown" : verdict.kind, { findings: verdict.findings, modelUnavailable: Boolean(verdict.modelUnavailable), error: verdict.kind === "violation" ? "锁定检查没通过" : verdict.findings[0] ?? null });
        if (!st.initSeen) {
          if (stopReason === "init_timeout") return done("not-ready", { category: "init_timeout", findings: ["30 秒内没有完成启动"], error: "启动超时" });
          if (exit.code !== 0) return done("unsupported", { category: "exit_before_init", error: `Claude Code 启动失败（退出码 ${exit.code ?? exit.signal ?? "?"}）` });
          return done("not-ready", { category: "bad_output", findings: ["没有收到启动报告"], error: "没有收到启动报告" });
        }
        if (stopReason === "timeout") return done(preflight ? "failed" : "timeout", { category: "timeout", error: preflight ? CATEGORY_TEXT.timeout : "运行超过 5 分钟，已停止" });
        if (stopReason === "too_large") return done("failed", { category: "too_large", error: "输出超过 4 MiB，已停止" });
        if (stopReason === "tool_cap") return done("failed", { category: "tool_cap", error: `工具调用超过 ${maxToolCalls} 次，已停止` });
        if (expired) return done("interrupted", { category: "token_expired", error: "运行令牌在运行中过期，已中断" });
        if (result?.isError) { const category = classifyResult(result); return done("failed", { category, error: CATEGORY_TEXT[category] }); }
        if (!result) return done("failed", { category: exit.code === 0 ? "bad_output" : "cli_failed", error: exit.code === 0 ? CATEGORY_TEXT.bad_output : CATEGORY_TEXT.cli_failed });
        done("done");
      });
    });
  }
}
function outcome(state: RunState, started: number, ended: number, patch: Partial<RunOutcome> = {}): RunOutcome {
  return { state, armed: false, cliVersion: null, model: null, findings: [], error: null, category: null, modelUnavailable: false, deniedAttempts: [], toolUses: 0, costUsd: null, costEstimated: false, actions: { replied: 0, drafted: 0, triaged: 0, dismissed: 0 }, ...patch, durationMs: Math.max(0, ended - started) };
}
