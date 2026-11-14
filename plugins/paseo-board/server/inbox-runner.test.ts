import { describe, expect, it } from "vitest";
import { stat } from "node:fs/promises";
import { PREFLIGHT_PROMPT } from "./inbox-lock";
import { RunnerBindings, SealedRunner, runnerActorId, type RunInput, type StreamExec, type StreamExecOptions, type StreamExit } from "./inbox-runner";

const MCP = "/opt/paseo/paseo-board/bin/paseo-board-mcp";
const scope = { boardId: "board-a", expectedCreatedAt: "2026-11-13T07:00:00.000Z" };
const TOOLS = ["mcp__paseo_board__board_inbox_list", "mcp__paseo_board__board_inbox_read", "mcp__paseo_board__board_inbox_triage", "mcp__paseo_board__board_inbox_reply"];
type IO = { argv: readonly string[]; options: StreamExecOptions; emit(value: unknown): void; killed: Promise<void>; token: string };
/** A fake `claude -p`: replays a scripted stream-json conversation; kill() ends it like SIGKILL. */
function scripted(script: (io: IO) => Promise<StreamExit | void>) {
  const calls: Array<{ argv: readonly string[]; options: StreamExecOptions; killed: boolean }> = [];
  const exec: StreamExec = (argv, options) => {
    let resolveKill!: () => void;
    const killed = new Promise<void>(resolve => { resolveKill = resolve; });
    const call = { argv, options, killed: false };
    calls.push(call);
    const token = JSON.parse(argv[argv.indexOf("--mcp-config") + 1]).mcpServers.paseo_board.env.PASEO_BOARD_BINDING;
    let bytes = 0;
    const io: IO = { argv, options, token, killed, emit: value => { if (call.killed) return; const line = JSON.stringify(value); bytes += Buffer.byteLength(line) + 1; options.onBytes(bytes); if (!call.killed) options.onLine(line); } };
    const exited = Promise.race([
      Promise.resolve().then(() => script(io)).then(exit => exit ?? { code: 0, signal: null }),
      killed.then(() => ({ code: null, signal: "SIGKILL" })),
    ]);
    return { kill: () => { call.killed = true; resolveKill(); }, exited };
  };
  return { exec, calls };
}
const init = (io: IO, patch: Record<string, unknown> = {}) => ({ type: "system", subtype: "init", cwd: io.options.cwd, original_cwd: io.options.cwd, tools: TOOLS, mcp_servers: [{ name: "paseo_board", status: "connected" }], model: io.argv[io.argv.indexOf("--model") + 1], permissionMode: "dontAsk", slash_commands: [], skills: [], plugins: [], output_style: "default", claude_code_version: "2.1.325", ...patch });
const toolUse = (...names: string[]) => ({ type: "assistant", message: { content: names.map((name, index) => ({ type: "tool_use", id: `toolu_${index}`, name, input: {} })) } });
const result = (patch: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0031, num_turns: 3, result: "done", ...patch });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe("sealed runner (lockdown design §3.1–§3.3)", () => {
  const route = { providerId: "claude", command: ["claude"] as [string], env: {} };
  const input = (patch: Partial<RunInput> = {}): RunInput => ({ scope, scopeKey: "k".repeat(64), runId: "inbox-aaaaaaaa-1-2", route, model: "claude-haiku-5-5", effort: "low", maxBudgetUsd: 0.02, systemPrompt: "You are the comment assistant.", prompt: "[ids only]", commentIds: ["comment-1", "comment-2"], ...patch });
  const runner = (exec: StreamExec, bindings = new RunnerBindings(), limits = {}) => new SealedRunner({ bindings, mcpCommand: MCP, exec, env: { HOME: "/h", PASEO_BOARD_BINDING: "owner-token" }, limits: { initTimeoutMs: 200, runTimeoutMs: 2_000, ...limits } });

  it("arms the binding only after init passes, scopes it to the batch, and revokes it at exit", async () => {
    const bindings = new RunnerBindings();
    const seen: Array<{ armed: boolean | undefined; at: string }> = [];
    const { exec, calls } = scripted(async io => {
      seen.push({ armed: bindings.get(io.token)?.armed, at: "spawn" });
      io.emit({ type: "system", subtype: "status" });
      io.emit(init(io));
      seen.push({ armed: bindings.get(io.token)?.armed, at: "after-init" });
      const binding = bindings.get(io.token)!;
      expect([...binding.commentIds]).toEqual(["comment-1", "comment-2"]);
      expect(binding).toMatchObject({ scope, runId: "inbox-aaaaaaaa-1-2", actorId: runnerActorId("k".repeat(64)) });
      expect(bindings.armedFor(scope, binding.actorId)).toBe(binding);
      binding.actions.replied++;
      io.emit(toolUse("mcp__paseo_board__board_inbox_read", "mcp__paseo_board__board_inbox_reply"));
      io.emit(result());
    });
    const verified: unknown[] = [];
    const outcome = await runner(exec, bindings).run(input({ onVerified: check => verified.push(check) }));
    expect(seen).toEqual([{ armed: false, at: "spawn" }, { armed: true, at: "after-init" }]);
    expect(verified).toEqual([{ ok: true, cliVersion: "2.1.325", model: "claude-haiku-5-5" }]);
    expect(outcome).toMatchObject({ state: "done", armed: true, cliVersion: "2.1.325", model: "claude-haiku-5-5", costUsd: 0.0031, toolUses: 2, deniedAttempts: [], actions: { replied: 1, drafted: 0, triaged: 0, dismissed: 0 }, error: null });
    expect(bindings.size).toBe(0);
    // The process got the prompt on stdin, the locked env, and a private temp cwd that is gone afterwards.
    const { argv, options } = calls[0];
    expect(argv.slice(0, 3)).toEqual(["claude", "-p", "--output-format"]);
    expect(options.stdin).toBe("[ids only]");
    expect(options.env).not.toHaveProperty("PASEO_BOARD_BINDING");
    expect(options.env).toMatchObject({ HOME: "/h", PASEO_PLUGIN_HELPER_ROLE: "paseo-board-inbox-runner", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" });
    expect(options.cwd).toMatch(/\/paseo-board-run-[^/]+$/);
    await expect(stat(options.cwd)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("kills the group and never arms when init reports a violation; the batch is never offered", async () => {
    const bindings = new RunnerBindings();
    const { exec, calls } = scripted(async io => {
      io.emit(init(io, { tools: [...TOOLS, "Bash"], mcp_servers: [{ name: "paseo_board", status: "connected" }, { name: "learning", status: "connected" }] }));
      expect(bindings.get(io.token)).toBeUndefined();
      await io.killed;
      io.emit(toolUse("mcp__paseo_board__board_inbox_read"));
    });
    const outcome = await runner(exec, bindings).run(input());
    expect(calls[0].killed).toBe(true);
    expect(outcome).toMatchObject({ state: "lockdown", armed: false, findings: ["工具 Bash", "MCP 服务 learning"], error: "锁定检查没通过", toolUses: 0 });
    // Output before init is treated the same way.
    const early = await runner(scripted(async io => { io.emit(toolUse("Bash")); await io.killed; }).exec).run(input());
    expect(early).toMatchObject({ state: "lockdown", findings: ["启动检查之前就有输出"], armed: false });
  });

  it("re-verifies a second init and stops a run whose tool surface changed", async () => {
    const bindings = new RunnerBindings();
    const outcome = await runner(scripted(async io => { io.emit(init(io)); io.emit(init(io, { skills: ["x"] })); expect(bindings.get(io.token)).toBeUndefined(); await io.killed; }).exec, bindings).run(input());
    expect(outcome).toMatchObject({ state: "lockdown", armed: true, findings: ["技能 x"] });
  });

  it("times out without init (not-ready), reports a non-zero exit before init as unsupported, and a missing CLI", async () => {
    const hang = scripted(async io => { await io.killed; });
    expect(await runner(hang.exec).run(input())).toMatchObject({ state: "not-ready", category: "init_timeout", findings: ["30 秒内没有完成启动"] });
    expect(hang.calls[0].killed).toBe(true);
    expect(await runner(scripted(async () => ({ code: 1, signal: null })).exec).run(input())).toMatchObject({ state: "unsupported", category: "exit_before_init", error: "Claude Code 启动失败（退出码 1）" });
    expect(await runner(scripted(async () => ({ code: null, signal: null, missing: true })).exec).run(input())).toMatchObject({ state: "unsupported", category: "cli_missing" });
    expect(await runner(scripted(async io => { io.emit(init(io, { claude_code_version: "2.1.300" })); await io.killed; }).exec).run(input())).toMatchObject({ state: "unsupported", findings: ["Claude Code 2.1.300"] });
    expect(await runner(scripted(async io => { io.emit(init(io, { model: "claude-opus-5-5" })); await io.killed; }).exec).run(input())).toMatchObject({ state: "not-ready", modelUnavailable: true, findings: ["所选模型不可用：claude-haiku-5-5"] });
  });

  it("kills at the tool-call cap, records denied tool names and the run timeout", async () => {
    const capped = scripted(async io => { io.emit(init(io)); for (let index = 0; index < 20; index++) io.emit(toolUse("Bash", "mcp__paseo_board__board_inbox_list")); await io.killed; });
    const outcome = await runner(capped.exec).run(input({ commentIds: ["c1"] }));
    expect(outcome).toMatchObject({ state: "failed", category: "tool_cap", error: "工具调用超过 10 次，已停止", deniedAttempts: ["Bash"], toolUses: 12 });
    expect(capped.calls[0].killed).toBe(true);
    const slow = scripted(async io => { io.emit(init(io)); await io.killed; });
    expect(await runner(slow.exec, new RunnerBindings(), { runTimeoutMs: 100 }).run(input())).toMatchObject({ state: "timeout", armed: true, error: "运行超过 5 分钟，已停止" });
    const huge = scripted(async io => { io.emit(init(io)); io.emit({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(5_000) }] } }); await io.killed; });
    expect(await runner(huge.exec, new RunnerBindings(), { outputBytes: 4_000 }).run(input())).toMatchObject({ state: "failed", category: "too_large" });
  });

  it("records the result cost and maps an API failure to a category without its body", async () => {
    const failed = await runner(scripted(async io => { io.emit(init(io)); io.emit(result({ is_error: true, api_error_status: 401, result: "Invalid API key sk-ant-secret", total_cost_usd: 0 })); return { code: 1, signal: null }; }).exec).run(input());
    expect(failed).toMatchObject({ state: "failed", category: "auth", error: "登录失败", costUsd: 0 });
    expect(JSON.stringify(failed)).not.toContain("sk-ant-secret");
  });

  it("runs a preflight with the fixed stdin, no comments and a binding that is never armed", async () => {
    const bindings = new RunnerBindings();
    const checks: unknown[] = [];
    const { exec, calls } = scripted(async io => {
      io.emit(init(io));
      const binding = bindings.get(io.token)!;
      expect(binding.armed).toBe(false); expect(binding.commentIds.size).toBe(0);
      io.emit(result({ total_cost_usd: 0.0004 }));
    });
    const outcome = await runner(exec, bindings).run(input({ preflight: true, maxBudgetUsd: 0.1, onVerified: check => checks.push(check) }));
    expect(outcome).toMatchObject({ state: "done", armed: false, costUsd: 0.0004, cliVersion: "2.1.325" });
    expect(checks).toHaveLength(1);
    expect(calls[0].options.stdin).toBe(PREFLIGHT_PROMPT);
    expect(calls[0].argv[calls[0].argv.indexOf("--max-budget-usd") + 1]).toBe("0.1");
  });

  it("kills live runs on close: an orphan's binding is gone and queued runs never start", async () => {
    const bindings = new RunnerBindings();
    let token = "";
    const { exec, calls } = scripted(async io => { token = io.token; io.emit(init(io)); await io.killed; });
    const sealed = runner(exec, bindings, { maxConcurrent: 1 });
    const first = sealed.run(input());
    const second = sealed.run(input({ runId: "inbox-aaaaaaaa-3-3" }));
    while (!token) await tick();
    expect(bindings.get(token)?.armed).toBe(true); expect(calls).toHaveLength(1);
    await sealed.close();
    expect(await first).toMatchObject({ state: "interrupted", armed: true });
    expect(await second).toMatchObject({ state: "interrupted" });
    expect(calls).toHaveLength(1); expect(calls[0].killed).toBe(true);
    expect(bindings.get(token)).toBeUndefined();
    const aborted = new AbortController();
    const abortable = runner(scripted(async io => { io.emit(init(io)); aborted.abort(); await io.killed; }).exec).run(input({ signal: aborted.signal }));
    expect(await abortable).toMatchObject({ state: "interrupted" });
  });

  it("expires a binding at its deadline", () => {
    let now = 1_000;
    const bindings = new RunnerBindings(() => now);
    const binding = bindings.create({ scopeKey: "k".repeat(64), scope, runId: "r", commentIds: ["c"], expiresAt: 2_000 });
    bindings.arm(binding.token);
    expect(bindings.armedFor(scope, binding.actorId)).toBe(binding);
    now = 2_001;
    expect(bindings.armedFor(scope, binding.actorId)).toBeUndefined(); expect(bindings.get(binding.token)).toBeUndefined();
  });
});
