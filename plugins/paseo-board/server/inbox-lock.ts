/**
 * The sealed comment runner's lockdown (lockdown design 2026-11-13 §3.1, §3.3). Pure helpers: the exact argv,
 * settings and env of one `claude -p` run, the verification of its `system:init` report and the audit of its
 * stream. Nothing here reads visitor text; the argv never contains it.
 */
import { ROLE_ENV, budgetArg, childEnv, MODEL_RE, type ModelRoute } from "./kit/complete";
import { familyOf } from "../shared/assistant-models";

export const RUNNER_SERVER = "paseo_board";
export const INBOX_TOOL_NAMES = ["board_inbox_list", "board_inbox_read", "board_inbox_triage", "board_inbox_reply"] as const;
/** The only tools a run may have: the Board's four inbox tools through its own MCP server. */
export const ALLOWED_TOOLS: readonly string[] = INBOX_TOOL_NAMES.map(name => `mcp__${RUNNER_SERVER}__${name}`);
/** A belt behind `--tools ""` and the init check: built-in tools that must never run. */
export const DENY_BELT: readonly string[] = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch",
  "Task", "Agent", "Skill", "Workflow", "TodoWrite", "CronCreate", "CronDelete", "CronList", "Monitor", "SendMessage", "EnterWorktree",
  "ExitWorktree", "ScheduleWakeup", "RemoteTrigger", "PushNotification",
];
/**
 * The Claude Code built-in plugins a sealed run may report (seen in every 2.1.325 init; telemetry only sometimes).
 * Pinned by name: a built-in plugin can add context to the model that init does not show, so one this list does
 * not know (a newer CLI, a feature flag) fails the check until the plugin has been reviewed and updated.
 */
export const BUILTIN_PLUGINS: readonly string[] = ["cc-plugin-agents-md", "cc-plugin-telemetry", "cc-plugin-privacy", "cc-plugin-plugin-authoring"];
/** `permissions.denyInsteadOfPrompting` first shipped in 2.1.319. */
export const MIN_CLI_VERSION = "2.1.319";
export const RUNNER_ROLE = "paseo-board-inbox-runner";
export const TOOLSET_ENV = "PASEO_BOARD_TOOLSET";
export const TOOLSET = "inbox-assistant";
/** The preflight's stdin (§3.3): one short turn that should call nothing. */
export const PREFLIGHT_PROMPT = "预检：不要调用任何工具。";
/** Belts only (§3.1): present in the 2.1.325 strings; the init check is the gate. */
export const LOCK_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
  CLAUDE_CODE_DISABLE_WORKFLOWS: "1",
  CLAUDE_CODE_DISABLE_CRON: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  DISABLE_AUTOUPDATER: "1",
  // Cross-session messaging off: without it a run opens a local socket other sessions on this computer can write
  // to (init `messaging_socket_path`). Verified with 2.1.325; not part of the init check (inbound only, local only).
  CLAUDE_CODE_HARBOR_KITE: "0",
};

/** Flag settings (`--settings`): no hooks, connectors, memory or synced skills; only our MCP command; deny, never prompt. */
export function lockSettings(mcpCommand: string) {
  return {
    disableAllHooks: true,
    disableClaudeAiConnectors: true,
    autoMemoryEnabled: false,
    syncClaudeAiSkills: false,
    syncClaudeAiPlugins: false,
    allowedMcpServers: [{ serverCommand: [mcpCommand] }],
    permissions: { denyInsteadOfPrompting: true, disableBypassPermissionsMode: "disable", deny: [...DENY_BELT] },
  };
}
/** The single MCP server of a run: the Board's stable launcher, bound to the run's token, listing only the inbox tools. */
export function mcpConfig(mcpCommand: string, bindingToken: string): string {
  return JSON.stringify({ mcpServers: { [RUNNER_SERVER]: { type: "stdio", command: mcpCommand, args: [], env: { PASEO_BOARD_BINDING: bindingToken, [TOOLSET_ENV]: TOOLSET } } } });
}

export interface LockArgsInput {
  model: string; effort: "low" | "medium" | null; maxBudgetUsd: number; systemPrompt: string; mcpCommand: string; bindingToken: string;
}
/** The fixed argv after the route's command (§3.1). Throws on invalid input; never contains visitor text. */
export function lockArgs(input: LockArgsInput): string[] {
  if (!MODEL_RE.test(input.model)) throw new Error("bad_model");
  if (!Number.isFinite(input.maxBudgetUsd) || input.maxBudgetUsd < 0.001 || input.maxBudgetUsd > 100) throw new Error("bad_budget");
  if (!input.systemPrompt.trim()) throw new Error("bad_prompt");
  if (!input.mcpCommand.startsWith("/") || input.mcpCommand.includes("\u0000")) throw new Error("bad_mcp_command");
  if (!/^[a-f0-9]{48}$/.test(input.bindingToken)) throw new Error("bad_token");
  return [
    "-p",
    "--output-format", "stream-json", "--verbose",
    "--no-session-persistence",
    "--model", input.model,
    ...(input.effort ? ["--effort", input.effort] : []),
    "--max-budget-usd", budgetArg(input.maxBudgetUsd),
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", mcpConfig(input.mcpCommand, input.bindingToken),
    "--allowedTools", ALLOWED_TOOLS.join(","),
    "--disallowedTools", DENY_BELT.join(","),
    "--setting-sources", "",
    "--settings", JSON.stringify(lockSettings(input.mcpCommand)),
    "--disable-slash-commands",
    "--permission-mode", "dontAsk",
    "--system-prompt", input.systemPrompt,
  ];
}

/** The child env: the kit's env (plugin env minus stripped keys, plus the route env), without Paseo or binding variables. */
export function lockEnv(base: Readonly<Record<string, string | undefined>>, route: Pick<ModelRoute, "env">): Record<string, string> {
  const env = childEnv(base, route, RUNNER_ROLE);
  for (const key of Object.keys(env)) if (/^PASEO_/.test(key) && key !== ROLE_ENV || /_BINDING$/.test(key)) delete env[key];
  return Object.assign(env, LOCK_ENV);
}

/** `a.b.c` ≥ `x.y.z`, numerically; anything unparsable is false. */
export function versionAtLeast(version: unknown, minimum: string): boolean {
  if (typeof version !== "string") return false;
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(value)?.slice(1).map(Number);
  const have = parse(version), need = parse(minimum)!;
  if (!have) return false;
  for (let index = 0; index < 3; index++) if (have[index] !== need[index]) return have[index] > need[index];
  return true;
}
/** The model a run reports: the requested id (or a dated snapshot of it), or, for an alias, the alias's family. */
export function modelMatches(requested: string, reported: unknown): boolean {
  if (typeof reported !== "string" || !reported) return false;
  if (reported === requested || reported.startsWith(`${requested}-`) || reported.startsWith(`${requested}[`)) return true;
  if (/^(haiku|sonnet|opus)$/.test(requested)) return familyOf(reported) === requested;
  return false;
}

export type VerifyResult =
  | { ok: true; cliVersion: string; model: string }
  | { ok: false; kind: "violation" | "not-ready" | "unsupported"; findings: string[]; cliVersion: string | null; modelUnavailable?: boolean };

const clean = (value: unknown) => String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").slice(0, 60);
const names = (values: string[]) => values.slice(0, 8).map(clean).join("、") + (values.length > 8 ? ` 等 ${values.length} 个` : "");
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The fail-closed check of a run's `system:init` (§3.3): anything that could reach beyond the four inbox tools is
 * a violation; a missing or still connecting tool server is not-ready; an old CLI is unsupported. `apiKeySource`
 * is never read.
 */
export function verifyInit(init: unknown, expected: { cwd: string; model: string }): VerifyResult {
  const event = isObject(init) ? init : {};
  const cliVersion = typeof event.claude_code_version === "string" ? event.claude_code_version.slice(0, 40) : null;
  const violations: string[] = [], notReady: string[] = [];
  const tools = Array.isArray(event.tools) ? event.tools.filter((tool): tool is string => typeof tool === "string") : null;
  if (!tools) violations.push("没有工具清单");
  else {
    const extra = tools.filter(tool => !ALLOWED_TOOLS.includes(tool));
    if (extra.length) violations.push(`工具 ${names(extra)}`);
    const missing = ALLOWED_TOOLS.filter(tool => !tools.includes(tool));
    if (missing.length) notReady.push(`缺少 ${names(missing.map(tool => tool.replace(`mcp__${RUNNER_SERVER}__`, "")))}`);
  }
  const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers.filter(isObject) : null;
  if (!servers) violations.push("没有 MCP 服务清单");
  else {
    const extra = servers.map(server => server.name).filter(name => name !== RUNNER_SERVER).map(String);
    if (extra.length) violations.push(`MCP 服务 ${names(extra)}`);
    const own = servers.find(server => server.name === RUNNER_SERVER);
    if (!own) notReady.push("评论工具服务没有启动");
    else if (own.status !== "connected") notReady.push(`评论工具服务状态 ${clean(own.status)}`);
  }
  if (event.permissionMode !== "dontAsk") violations.push(`权限模式 ${clean(event.permissionMode ?? "缺失")}`);
  for (const [field, label] of [["slash_commands", "斜杠命令"], ["skills", "技能"]] as const) {
    const value = event[field];
    if (value !== undefined && (!Array.isArray(value) || value.length)) violations.push(`${label} ${Array.isArray(value) ? names(value.map(item => isObject(item) ? String(item.name ?? "?") : String(item))) : "无法识别"}`);
  }
  if (event.plugins !== undefined) {
    const plugins = Array.isArray(event.plugins) ? event.plugins : null;
    const known = (plugin: Record<string, unknown>) => plugin.path === "builtin" && typeof plugin.name === "string" && BUILTIN_PLUGINS.includes(plugin.name) && (plugin.source === undefined || plugin.source === `${plugin.name}@builtin`);
    const foreign = plugins ? plugins.filter(plugin => !isObject(plugin) || !known(plugin)).map(plugin => isObject(plugin) ? String(plugin.name ?? "?") : "?") : ["无法识别"];
    if (foreign.length) violations.push(`插件 ${names(foreign)}`);
  }
  if (event.output_style !== undefined && event.output_style !== "default") violations.push(`输出风格 ${clean(event.output_style)}`);
  if (event.cwd !== expected.cwd || event.original_cwd !== undefined && event.original_cwd !== expected.cwd) violations.push("工作目录不是这次运行的临时目录");
  if (violations.length) return { ok: false, kind: "violation", findings: violations.slice(0, 10), cliVersion };
  if (!versionAtLeast(cliVersion, MIN_CLI_VERSION)) return { ok: false, kind: "unsupported", findings: [`Claude Code ${cliVersion ?? "版本未知"}`], cliVersion };
  if (!modelMatches(expected.model, event.model)) return { ok: false, kind: "not-ready", findings: [`所选模型不可用：${clean(expected.model)}`], cliVersion, modelUnavailable: true };
  if (notReady.length) return { ok: false, kind: "not-ready", findings: notReady.slice(0, 10), cliVersion };
  return { ok: true, cliVersion: cliVersion!, model: String(event.model).slice(0, 100) };
}

export type StreamEvent =
  | { kind: "init"; event: Record<string, unknown> }
  | { kind: "system" }
  | { kind: "tools"; names: string[] }
  | { kind: "result"; isError: boolean; subtype: string; costUsd: number | null; numTurns: number | null; apiStatus: number | null; text: string }
  | { kind: "other"; type: string };
/** One stream-json line, classified (§3.3 auditEvent). Visitor text is never copied out of the event. */
export function auditEvent(value: unknown): StreamEvent {
  if (!isObject(value)) return { kind: "other", type: "invalid" };
  if (value.type === "system") return value.subtype === "init" ? { kind: "init", event: value } : { kind: "system" };
  if (value.type === "assistant") {
    const message = isObject(value.message) ? value.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    return { kind: "tools", names: content.filter(block => isObject(block) && block.type === "tool_use").map(block => clean((block as Record<string, unknown>).name)) };
  }
  if (value.type === "result") {
    const cost = typeof value.total_cost_usd === "number" && Number.isFinite(value.total_cost_usd) && value.total_cost_usd >= 0 ? value.total_cost_usd : null;
    return {
      kind: "result", isError: value.is_error === true, subtype: typeof value.subtype === "string" ? value.subtype.slice(0, 60) : "",
      costUsd: cost, numTurns: typeof value.num_turns === "number" ? value.num_turns : null,
      apiStatus: typeof value.api_error_status === "number" ? value.api_error_status : null,
      // Only for classification below; never stored or logged.
      text: typeof value.result === "string" ? value.result.slice(0, 500) : "",
    };
  }
  return { kind: "other", type: typeof value.type === "string" ? value.type.slice(0, 40) : "unknown" };
}

export type FailureCategory = "auth" | "model" | "rate" | "network" | "budget" | "api";
export const CATEGORY_TEXT: Readonly<Record<FailureCategory | "timeout" | "bad_output" | "cli_failed", string>> = {
  auth: "登录失败", model: "模型不可用", rate: "额度或频率限制", network: "网络错误", budget: "超出单次预算", api: "接口错误",
  timeout: "超时", bad_output: "输出无法读取", cli_failed: "Claude Code 异常退出",
};
/** A failed `result` → a category (§3.9 `{category}`); the API response body is never returned. */
export function classifyResult(result: Extract<StreamEvent, { kind: "result" }>): FailureCategory {
  const status = result.apiStatus ?? 0, text = result.text;
  if (/budget/i.test(result.subtype)) return "budget";
  if (status === 401 || status === 403 || /\b(auth|login|log in|api key|credential|oauth|unauthori[sz]ed|forbidden)\b/i.test(text)) return "auth";
  if (status === 404 || /\bmodel\b.*\b(not found|not exist|does not exist|invalid|unavailable|not available|not supported)\b/i.test(text)) return "model";
  if (status === 429 || status === 529 || /\b(rate.?limit|quota|overloaded|usage limit|credit|balance)\b/i.test(text)) return "rate";
  if (status >= 500 || /\b(network|ECONN\w*|ENOTFOUND|fetch failed|socket|timed? ?out|connection)\b/i.test(text)) return "network";
  return "api";
}
