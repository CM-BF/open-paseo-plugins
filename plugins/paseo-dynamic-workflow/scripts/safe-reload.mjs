#!/usr/bin/env node
// Reloads the plugin only when no other agent's workflow run is active, because a reload ends
// every active run as interrupted and stops its children mid-work.
//
//   node scripts/safe-reload.mjs [--allow <agentId>]... [--dry-run]
//
// --allow names a launching agent whose active runs may be interrupted (your own test fixtures).
// Without it, any active run blocks the reload. The check and the reload are a few milliseconds
// apart; a run launched in between is still interrupted.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const PLUGIN_ID = "paseo-dynamic-workflow";
const USAGE = "usage: node scripts/safe-reload.mjs [--allow <agentId>]... [--dry-run]";
const RUN_STATUSES = new Set(["running", "stopping", "completed", "failed", "stopped", "interrupted"]);

function parseArgs(argv) {
  const allowed = new Set();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--allow" && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(argv[i + 1] ?? "")) allowed.add(argv[++i]);
    else if (argv[i] === "--dry-run") dryRun = true;
    else {
      console.error(`Invalid argument ${argv[i]}\n${USAGE}`);
      process.exit(2);
    }
  }
  return { allowed, dryRun };
}

function daemonStatus(cli, home) {
  const status = JSON.parse(execFileSync(cli, ["daemon", "status", "--json", "--home", home], { encoding: "utf8", timeout: 15_000 }));
  if (!status || typeof status.home !== "string" || !isAbsolute(status.home) || realpathSync(status.home) !== realpathSync(home)
      || status.localDaemon !== "running" || status.connectedDaemon !== "reachable" || typeof status.listen !== "string" || !status.listen.trim()
      || typeof status.serverId !== "string" || !status.serverId.trim()) {
    throw new Error("Cannot establish the selected local daemon's home, listen address and server ID; not reloading.");
  }
  return status;
}

function checkRuns(home, allowed) {
  const runs = join(home, PLUGIN_ID, "runs");
  const active = [];
  // An incomplete or unreadable snapshot cannot establish that reloading is safe.
  for (const entry of readdirSync(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) throw new Error(`Cannot inspect run entry ${entry.name}; not reloading.`);
    const record = JSON.parse(readFileSync(join(runs, entry.name, "run.json"), "utf8"));
    if (!record || record.version !== 1 || record.runId !== entry.name || !RUN_STATUSES.has(record.status)
        || typeof record.parentAgentId !== "string" || !record.parentAgentId.trim()) {
      throw new Error(`Invalid run record ${entry.name}; not reloading.`);
    }
    if (record.status === "running" || record.status === "stopping") active.push(record);
  }
  const blocking = active.filter((record) => !allowed.has(record.parentAgentId));
  for (const record of active) {
    console.log(`${allowed.has(record.parentAgentId) ? "allowed" : "BLOCKS"} ${record.runId} ${JSON.stringify(record.meta?.name)} ${record.status}, launched by ${record.parentAgentId}`);
  }
  if (blocking.length) throw new Error(`Not reloading: ${blocking.length} active run(s) of other agents would be interrupted. Wait for them to finish, or ask their owners.`);
}

function main() {
  const { allowed, dryRun } = parseArgs(process.argv.slice(2));
  if (process.env.PASEO_HOST?.trim()) throw new Error("safe-reload supports local daemon homes only. Unset PASEO_HOST and select PASEO_HOME; not reloading.");
  const rawHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const requestedHome = resolve(rawHome.replace(/^~(?=$|\/)/, homedir()));
  const desktopCli = "/Applications/Paseo.app/Contents/Resources/bin/paseo";
  const cli = process.env.PASEO_CLI?.trim() || process.env.PASEO_BIN?.trim()
    || (process.platform === "darwin" && existsSync(desktopCli) ? desktopCli : "paseo");
  const initial = daemonStatus(cli, requestedHome);
  const home = initial.home;
  const list = () => console.log(execFileSync(cli, ["plugin", "ls", PLUGIN_ID, "--json", "--home", home], { encoding: "utf8", timeout: 15_000 }).trim());
  list();
  if (!dryRun) {
    const current = daemonStatus(cli, home);
    if (current.home !== home || current.listen !== initial.listen || current.serverId !== initial.serverId) {
      throw new Error("The selected daemon changed during the check; not reloading.");
    }
  }
  checkRuns(home, allowed);
  if (dryRun) {
    console.log("Dry run: no active run blocks a reload.");
    return;
  }
  execFileSync(cli, ["plugin", "reload", PLUGIN_ID, "--home", home], { stdio: "inherit", timeout: 30_000 });
  list();
}

try { main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
