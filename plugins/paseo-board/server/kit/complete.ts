// A one-shot model call for plugins (Paseo has no `model.complete`): the headless Claude CLI, run the
// way Paseo launches a configured Claude-family provider. Adapted from the turn-check plugin
// (server/kit/complete.ts). This file is copied verbatim into every plugin of this repository that
// needs it; scripts/check-kit.mjs keeps the copies identical.
//
// Route: `paseo.config.get()` → providers[id] and its base providers[entry.extends ?? id]. The provider
// must be `claude` or extend it, and not be disabled. command = entry.command ?? base.command ?? ["claude"];
// env = {...base.env, ...entry.env}. A route whose env has a secret-looking key or a credential-shaped
// value is refused: the call would copy a credential into a second process.
//
// Call: spawn without a shell in its own process group; user content on stdin; a fresh empty 0700 temp
// cwd removed afterwards; the group is SIGKILLed at the timeout, once output passes the cap, or on abort.
// Fixed args: -p --output-format json --no-session-persistence --model <m> --strict-mcp-config
// --mcp-config <json> --disable-slash-commands --permission-mode dontAsk --max-budget-usd <b>
// --system-prompt <s> --tools "" [--allowedTools <mcp tools>]. With an empty MCP config the model has no
// tool at all (a judge); with one it has only those MCP tools (a worker such as a review run).

import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]/-]{0,99}$/;
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Variables that never reach the CLI: what Paseo strips before a provider launch, plus agent identity. */
export const STRIPPED_ENV = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "PASEO_NODE_ENV",
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  "ESBUILD_BINARY_PATH",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "NODE_CHANNEL_FD",
  "NODE_CHANNEL_SERIALIZATION_MODE",
  "NODE_UNIQUE_ID",
  "PASEO_AGENT_ID",
  "PASEO_AGENT_CWD",
] as const;

export const ROLE_ENV = "PASEO_PLUGIN_HELPER_ROLE";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_PARTS = new Set([
  "KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASS", "PAT", "AUTH", "COOKIE",
  "CREDENTIALS", "BEARER", "PRIVATE", "HEADER", "HEADERS",
]);
const CREDENTIAL_VALUE_RE = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@|\beyJ[A-Za-z0-9_-]{10,}\.)/;

export type RouteError = "route_unavailable" | "route_missing" | "route_not_claude" | "route_disabled" | "route_bad_command" | "route_bad_env" | "route_env_secret";

export interface ModelRoute {
  providerId: string;
  command: readonly [string, ...string[]];
  /** Opaque: never logged or returned. */
  env: Readonly<Record<string, string>>;
}

export type RouteResult = { ok: true; route: ModelRoute; label: string } | { ok: false; error: RouteError; label: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cleanArgv(value: unknown): readonly [string, ...string[]] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  for (const part of value as unknown[]) {
    if (typeof part !== "string" || part.length === 0 || part.length > 4096 || part.includes("\u0000")) return null;
  }
  const argv = value as string[];
  if (argv[0]!.startsWith("-")) return null;
  return [argv[0]!, ...argv.slice(1)];
}

function envOf(entry: Record<string, unknown> | null): Record<string, string> | null {
  const env = entry?.env;
  if (env === undefined || env === null) return {};
  if (!isObject(env)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key) || typeof value !== "string" || value.includes("\u0000")) return null;
    out[key] = value;
  }
  return out;
}

export function isSecretEnvKey(key: string): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  if (parts.some((part) => SECRET_PARTS.has(part))) return true;
  return parts.some((part) => /^(?:API|ACCESS|AUTH|SESSION|CLIENT)(?:KEY|TOKEN|SECRET)$/.test(part));
}

/** The route of `providerId` in a daemon config's `providers` record (pure). */
export function routeFrom(providers: unknown, providerId: string): RouteResult {
  if (!PROVIDER_ID_RE.test(providerId)) return { ok: false, error: "route_missing", label: providerId };
  const all = isObject(providers) ? providers : {};
  const entry = isObject(all[providerId]) ? (all[providerId] as Record<string, unknown>) : null;
  const parent = entry && typeof entry.extends === "string" ? entry.extends : null;
  const label = entry && typeof entry.label === "string" && entry.label ? entry.label : providerId;
  if (!entry && providerId !== "claude") return { ok: false, error: "route_missing", label };
  const baseId = providerId === "claude" ? "claude" : parent;
  if (baseId !== "claude") return { ok: false, error: "route_not_claude", label };
  const base = providerId === "claude" ? entry : isObject(all.claude) ? (all.claude as Record<string, unknown>) : null;
  if (entry?.enabled === false) return { ok: false, error: "route_disabled", label };
  const command = cleanArgv(entry?.command ?? base?.command ?? ["claude"]);
  if (!command) return { ok: false, error: "route_bad_command", label };
  const baseEnv = base === entry ? {} : envOf(base);
  const entryEnv = envOf(entry);
  if (baseEnv === null || entryEnv === null) return { ok: false, error: "route_bad_env", label };
  const env = { ...baseEnv, ...entryEnv };
  if (Object.entries(env).some(([key, value]) => isSecretEnvKey(key) || CREDENTIAL_VALUE_RE.test(value))) {
    return { ok: false, error: "route_env_secret", label };
  }
  return { ok: true, route: { providerId, command, env }, label };
}

/** The route as the daemon has it now (read on every call: providers reload). */
export async function resolveRoute(paseo: { config: { get(): Promise<{ config: { providers?: unknown } }> } }, providerId: string): Promise<RouteResult> {
  try {
    return routeFrom((await paseo.config.get()).config.providers, providerId);
  } catch {
    return { ok: false, error: "route_unavailable", label: providerId };
  }
}

export function routeErrorText(error: RouteError | CompleteError): string {
  const text: Record<string, string> = {
    route_unavailable: "the daemon configuration could not be read",
    route_missing: "that provider is not configured",
    route_not_claude: "the provider is not Claude-family (only Claude Code can run these calls)",
    route_disabled: "the provider is disabled",
    route_bad_command: "the provider command is invalid",
    route_bad_env: "the provider environment is invalid",
    route_env_secret: "the provider env holds credentials, which this plugin will not copy into another process",
    cli_missing: "the claude CLI was not found",
    timeout: "the call timed out",
    too_large: "the output was too large",
    aborted: "the call was stopped",
    not_started: "the call was stopped before it started",
    killed: "the CLI was killed",
    api_error: "the model API returned an error",
    cli_failed: "the CLI failed",
    bad_output: "the CLI output could not be read",
    bad_input: "the call arguments were invalid",
    failed: "the call failed",
  };
  return text[error] ?? error;
}

/** The child's environment: the plugin process env minus STRIPPED_ENV, then the provider env. */
export function childEnv(base: Readonly<Record<string, string | undefined>>, route: Pick<ModelRoute, "env">, role: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (typeof value === "string") env[key] = value;
  for (const key of STRIPPED_ENV) delete env[key];
  Object.assign(env, route.env);
  env[ROLE_ENV] = role;
  return env;
}

export function budgetArg(usd: number): string {
  return (Math.floor(usd * 10_000) / 10_000).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export interface CallArgsInput {
  model: string;
  maxBudgetUsd: number;
  systemPrompt: string;
  effort?: string;
  /** `{"mcpServers": {...}}`; default empty (no tools at all). */
  mcpConfig?: string;
  /** Exact MCP tool names the model may call without asking (e.g. mcp__learning__memory). */
  allowedTools?: readonly string[];
}

export function callArgs(input: CallArgsInput): string[] {
  if (typeof input.model !== "string" || !MODEL_RE.test(input.model)) throw new Error("bad_model");
  const budget = input.maxBudgetUsd;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0.001 || budget > 100) throw new Error("bad_budget");
  if (typeof input.systemPrompt !== "string" || !input.systemPrompt.trim()) throw new Error("bad_prompt");
  const effort = input.effort && /^[a-z]{2,10}$/.test(input.effort) ? ["--effort", input.effort] : [];
  const allowed = input.allowedTools?.length ? ["--allowedTools", input.allowedTools.join(",")] : [];
  return [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--model",
    input.model,
    ...effort,
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpConfig ?? '{"mcpServers":{}}',
    ...allowed,
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk",
    "--max-budget-usd",
    budgetArg(budget),
    "--system-prompt",
    input.systemPrompt,
  ];
}

export interface ExecOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  missing?: boolean;
  timedOut?: boolean;
  tooLarge?: boolean;
  aborted?: boolean;
  notStarted?: boolean;
  killed?: boolean;
}

export type Exec = (argv: readonly string[], options: ExecOptions) => Promise<ExecResult>;

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

export const defaultExec: Exec = (argv, options) =>
  new Promise<ExecResult>((resolve) => {
    const file = argv[0];
    if (typeof file !== "string" || !file) return resolve({ code: null, stdout: "", missing: true });
    if (options.signal?.aborted) return resolve({ code: null, stdout: "", aborted: true, notStarted: true });
    let child: ChildProcess;
    try {
      child = spawn(file, argv.slice(1), { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, detached: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return resolve(code === "ENOENT" || code === "EACCES" ? { code: null, stdout: "", missing: true } : { code: null, stdout: "" });
    }
    let stdout = "";
    let bytes = 0;
    let stopped: "timedOut" | "tooLarge" | "aborted" | null = null;
    let missing = false;
    let settled = false;
    const stop = (why: "timedOut" | "tooLarge" | "aborted") => {
      if (stopped) return;
      stopped = why;
      killGroup(child);
    };
    const timer = setTimeout(() => stop("timedOut"), options.timeoutMs);
    const onAbort = () => stop("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null, signal: NodeJS.Signals | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (missing) resolve({ code: null, stdout: "", missing: true });
      else if (stopped === "timedOut") resolve({ code: null, stdout: "", timedOut: true });
      else if (stopped === "tooLarge") resolve({ code: null, stdout: "", tooLarge: true });
      else if (stopped === "aborted") resolve({ code: null, stdout: "", aborted: true });
      else if (signal) resolve({ code: null, stdout, killed: true });
      else resolve({ code, stdout });
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > options.maxBytes) stop("tooLarge");
      else if (!stopped) stdout += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EACCES") missing = true;
      finish(null);
    });
    child.on("close", (code, signal) => finish(typeof code === "number" ? code : null, signal));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.stdin, "utf8");
  });

export interface Envelope {
  text: string;
  isError: boolean;
  apiStatus: number | null;
  costUsd: number | null;
  models: string[];
}

function envelopeOf(value: unknown): Envelope | null {
  if (!isObject(value) || value.type !== "result") return null;
  const cost = typeof value.total_cost_usd === "number" && Number.isFinite(value.total_cost_usd) && value.total_cost_usd >= 0 ? value.total_cost_usd : null;
  return {
    text: typeof value.result === "string" ? value.result : "",
    isError: value.is_error === true,
    apiStatus: typeof value.api_error_status === "number" ? value.api_error_status : null,
    costUsd: cost,
    models: isObject(value.modelUsage) ? Object.keys(value.modelUsage).filter((key) => MODEL_RE.test(key)).slice(0, 8) : [],
  };
}

/** The single JSON result on stdout (or its last result line after stray output); null when none. */
export function parseEnvelope(stdout: string): Envelope | null {
  const whole = typeof stdout === "string" ? stdout.trim() : "";
  if (!whole) return null;
  try {
    const envelope = envelopeOf(JSON.parse(whole));
    if (envelope) return envelope;
  } catch {
    // not one document
  }
  const lines = whole.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const envelope = envelopeOf(JSON.parse(line));
      if (envelope) return envelope;
    } catch {
      // keep looking
    }
  }
  return null;
}

export type CompleteError = "cli_missing" | "timeout" | "too_large" | "aborted" | "not_started" | "killed" | "api_error" | "cli_failed" | "bad_output" | "bad_input" | "failed";

export type CompleteResult =
  | { ok: true; text: string; costUsd: number | null; models: string[]; ms: number }
  | { ok: false; error: CompleteError; costUsd: number | null; apiStatus: number | null; models: string[]; ms: number };

const KILLED_EXIT = new Set([137, 143]);

export function classify(result: ExecResult, ms: number): CompleteResult {
  const fail = (error: CompleteError, envelope: Envelope | null = null): CompleteResult => ({
    ok: false,
    error,
    costUsd: envelope?.costUsd ?? null,
    apiStatus: envelope?.apiStatus ?? null,
    models: envelope?.models ?? [],
    ms,
  });
  if (result.missing) return fail("cli_missing");
  if (result.notStarted) return fail("not_started");
  if (result.timedOut) return fail("timeout");
  if (result.tooLarge) return fail("too_large");
  if (result.aborted) return fail("aborted");
  const envelope = parseEnvelope(result.stdout);
  if (!envelope && (result.killed || (result.code !== null && KILLED_EXIT.has(result.code)))) return fail("killed");
  if (!envelope) return fail(result.code === 0 ? "bad_output" : "cli_failed");
  if (envelope.isError) return fail("api_error", envelope);
  if (result.code !== 0) return fail("cli_failed", envelope);
  return { ok: true, text: envelope.text, costUsd: envelope.costUsd, models: envelope.models, ms };
}

export interface CompleteOptions extends CallArgsInput {
  route: ModelRoute;
  stdin: string;
  /** Identifies the caller in the child env (ROLE_ENV), e.g. "learning-loop-review". */
  role: string;
  timeoutMs?: number;
  maxBytes?: number;
  env?: Readonly<Record<string, string | undefined>>;
  exec?: Exec;
  signal?: AbortSignal;
  now?: () => number;
}

/** One CLI call. Never throws. */
export async function complete(options: CompleteOptions): Promise<CompleteResult> {
  const now = options.now ?? Date.now;
  const started = now();
  let args: string[];
  try {
    args = callArgs(options);
  } catch {
    return { ok: false, error: "bad_input", costUsd: null, apiStatus: null, models: [], ms: 0 };
  }
  const command = cleanArgv(options.route.command);
  if (!command) return { ok: false, error: "cli_missing", costUsd: null, apiStatus: null, models: [], ms: 0 };
  if (options.signal?.aborted) return { ok: false, error: "not_started", costUsd: null, apiStatus: null, models: [], ms: 0 };
  let cwd: string | null = null;
  try {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-helper-"));
    await fs.chmod(cwd, 0o700);
    const exec = options.exec ?? defaultExec;
    const result = await exec([...command, ...args], {
      cwd,
      env: childEnv(options.env ?? process.env, options.route, options.role),
      stdin: typeof options.stdin === "string" ? options.stdin : "",
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return classify(result, Math.max(0, now() - started));
  } catch {
    return { ok: false, error: "failed", costUsd: null, apiStatus: null, models: [], ms: Math.max(0, now() - started) };
  } finally {
    if (cwd !== null) await fs.rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The first JSON object in a model's text (a code fence or leading prose tolerated). */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) candidates.push(fence[1]!.trim());
  candidates.push(trimmed);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (isObject(value)) return value;
    } catch {
      // fall through to a brace scan
    }
    const start = candidate.indexOf("{");
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index += 1) {
      const ch = candidate[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(candidate.slice(start, index + 1));
            if (isObject(value)) return value;
          } catch {
            // keep scanning
          }
          break;
        }
      }
    }
  }
  return null;
}
