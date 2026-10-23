import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/safe-reload.mjs");
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

interface Invocation { cli: string; args: string[] }
async function fixture(homeName = "daemon home;$(touch never)") {
  const dir = await mkdtemp(join(tmpdir(), "dwf-safe-reload-"));
  dirs.push(dir);
  const home = join(dir, homeName);
  const runs = join(home, "paseo-dynamic-workflow/runs");
  await mkdir(runs, { recursive: true });
  const log = join(dir, "calls.jsonl");
  const cli = join(dir, "fake paseo");
  const legacyCli = join(dir, "legacy paseo");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const previous = fs.existsSync(process.env.TEST_CLI_LOG) ? fs.readFileSync(process.env.TEST_CLI_LOG, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
fs.appendFileSync(process.env.TEST_CLI_LOG, JSON.stringify({cli: process.argv[1], args}) + "\\n");
if (args[0] === "daemon" && args[1] === "status") {
  const second = previous.some((call) => call.args[0] === "daemon" && call.args[1] === "status");
  process.stdout.write(second && process.env.TEST_SECOND_STATUS ? process.env.TEST_SECOND_STATUS : process.env.TEST_STATUS);
} else if (args[0] === "plugin" && args[1] === "ls") {
  console.log(JSON.stringify({status: "running"}));
} else if (args[0] === "plugin" && args[1] === "reload") {
  console.log("fake reload");
} else {
  process.exitCode = 9;
}
`;
  for (const path of [cli, legacyCli]) { await writeFile(path, source); await chmod(path, 0o755); }
  const status = { home, listen: "127.0.0.1:6767", serverId: "srv_fixture", localDaemon: "running", connectedDaemon: "reachable" };
  async function calls(): Promise<Invocation[]> {
    try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  return {
    dir, home, runs, cli, legacyCli, status, calls,
    async record(value: unknown, id = "wf_fixture") {
      await mkdir(join(runs, id), { recursive: true });
      if (value !== undefined) await writeFile(join(runs, id, "run.json"), typeof value === "string" ? value : JSON.stringify(value));
    },
    run(args: string[] = [], overrides: Record<string, string | undefined> = {}) {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, PASEO_HOME: home, PASEO_HOST: "", PASEO_CLI: cli, PASEO_BIN: legacyCli, TEST_CLI_LOG: log, TEST_STATUS: JSON.stringify(status), TEST_SECOND_STATUS: "", ...overrides };
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
      return spawnSync(process.execPath, [script, ...args], { cwd: dir, env, encoding: "utf8", timeout: 10_000 });
    },
  };
}
const running = { version: 1, runId: "wf_fixture", parentAgentId: "agent-fixture", status: "running", meta: { name: "Fixture" } };
function reloads(calls: Invocation[]) { return calls.filter((call) => call.args[0] === "plugin" && call.args[1] === "reload"); }

it.each([["--allow", "--dry-run"], ["--allow"], ["--allow", "-x"], ["--host", "remote.example:6767"]])("rejects malformed arguments %j before invoking any CLI", async (...args) => {
  const f = await fixture();
  expect(f.run(args).status).toBe(2);
  expect(await f.calls()).toEqual([]);
});

it("blocks another agent's active run and leaves dry runs read-only", async () => {
  const f = await fixture();
  await f.record(running);
  expect(f.run().status).toBe(1);
  expect(reloads(await f.calls())).toEqual([]);
  expect(f.run(["--allow", "agent-fixture", "--dry-run"]).status).toBe(0);
  expect(reloads(await f.calls())).toEqual([]);
});

it("prefers PASEO_CLI and pins status, discovery and reload to the checked home as separate argv", async () => {
  const f = await fixture();
  await f.record(running);
  const result = f.run(["--allow", "agent-fixture"]);
  expect(result.status, result.stderr).toBe(0);
  const calls = await f.calls();
  expect(calls.every((call) => call.cli === f.cli)).toBe(true);
  expect(calls.filter((call) => call.args[0] === "daemon")).toHaveLength(2);
  expect(calls.every((call) => call.args.slice(-2).join("\0") === ["--home", f.home].join("\0"))).toBe(true);
  expect(reloads(calls).map((call) => call.args)).toEqual([["plugin", "reload", "paseo-dynamic-workflow", "--home", f.home]]);
});

it.each(["tilde", "default", "relative"])("resolves the %s home before asking the CLI and scanning runs", async (kind) => {
  const f = await fixture(kind === "default" ? ".paseo" : "daemon home");
  await f.record(running);
  const raw = kind === "tilde" ? "~/daemon home" : kind === "relative" ? "daemon home" : undefined;
  expect(f.run(["--dry-run"], { PASEO_HOME: raw }).status).toBe(1);
  const calls = await f.calls();
  expect(calls[0]?.args).toEqual(["daemon", "status", "--json", "--home", kind === "relative" ? await realpath(f.home) : f.home]);
  expect(reloads(calls)).toEqual([]);
});

it("supports PASEO_BIN compatibility without invoking a real CLI", async () => {
  const f = await fixture();
  expect(f.run(["--dry-run"], { PASEO_CLI: undefined }).status).toBe(0);
  expect((await f.calls()).every((call) => call.cli === f.legacyCli)).toBe(true);
});

it("fails rather than falling back when the selected PASEO_CLI cannot execute", async () => {
  const f = await fixture();
  expect(f.run([], { PASEO_CLI: join(f.dir, "missing-cli") }).status).toBe(1);
  expect(await f.calls()).toEqual([]);
});

it("refuses environment-selected endpoint targets before invoking any CLI", async () => {
  const f = await fixture();
  expect(f.run([], { PASEO_HOST: "ssh://remote.example" }).status).toBe(1);
  expect(await f.calls()).toEqual([]);
});

it.each(["invalid-json", "missing-home", "wrong-home", "missing-server", "missing-listen", "unreachable", "not-running"])("refuses %s daemon status without mutating", async (kind) => {
  const f = await fixture();
  const status: Record<string, unknown> = { ...f.status };
  if (kind === "missing-home") delete status.home;
  if (kind === "wrong-home") status.home = f.dir;
  if (kind === "missing-server") delete status.serverId;
  if (kind === "missing-listen") delete status.listen;
  if (kind === "unreachable") status.connectedDaemon = "unreachable";
  if (kind === "not-running") status.localDaemon = "stopped";
  const result = f.run([], { TEST_STATUS: kind === "invalid-json" ? "{" : JSON.stringify(status) });
  expect(result.status).toBe(1);
  expect(reloads(await f.calls())).toEqual([]);
});

it.each(["0.0.0.0:6767", "[::]:6767", "/tmp/fixture-daemon.sock"])("accepts the local instance's published %s listen address", async (listen) => {
  const f = await fixture();
  expect(f.run(["--dry-run"], { TEST_STATUS: JSON.stringify({ ...f.status, listen }) }).status).toBe(0);
  expect(reloads(await f.calls())).toEqual([]);
});

it("rechecks daemon identity before the final gate and refuses a replacement", async () => {
  const f = await fixture();
  expect(f.run([], { TEST_SECOND_STATUS: JSON.stringify({ ...f.status, serverId: "srv_replacement" }) }).status).toBe(1);
  expect(reloads(await f.calls())).toEqual([]);
});

it.each([undefined, "{", [], { ...running, status: "unknown" }, { ...running, runId: "wf_other" }, { ...running, parentAgentId: null }])("fails closed on an unreadable or invalid run record %#", async (record) => {
  const f = await fixture();
  await f.record(record);
  expect(f.run(["--allow", "agent-fixture"]).status).toBe(1);
  expect(reloads(await f.calls())).toEqual([]);
});

it("fails closed if the run directory is missing", async () => {
  const f = await fixture();
  await rm(f.runs, { recursive: true });
  expect(f.run().status).toBe(1);
  expect(reloads(await f.calls())).toEqual([]);
});
