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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = "paseo-dynamic-workflow";
const argv = process.argv.slice(2);
const allowed = new Set();
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--allow" && argv[i + 1]) allowed.add(argv[++i]);
  else if (argv[i] === "--dry-run") dryRun = true;
  else {
    console.error(`unknown argument ${argv[i]}\nusage: node scripts/safe-reload.mjs [--allow <agentId>]... [--dry-run]`);
    process.exit(2);
  }
}

const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
const runs = join(home, PLUGIN_ID, "runs");
const active = [];
for (const id of existsSync(runs) ? readdirSync(runs) : []) {
  let record;
  try { record = JSON.parse(readFileSync(join(runs, id, "run.json"), "utf8")); } catch { continue; }
  if (record.status === "running" || record.status === "stopping") active.push(record);
}
const blocking = active.filter((record) => !allowed.has(record.parentAgentId));
for (const record of active) {
  console.log(`${blocking.includes(record) ? "BLOCKS" : "allowed"} ${record.runId} "${record.meta?.name}" ${record.status}, launched by ${record.parentAgentId}, started ${record.startedAt}`);
}
if (blocking.length) {
  console.error(`Not reloading: ${blocking.length} active run(s) of other agents would be interrupted. Wait for them to finish, or ask their owners.`);
  process.exit(1);
}

const candidates = [process.env.PASEO_BIN, "/Applications/Paseo.app/Contents/Resources/bin/paseo"].filter(Boolean);
const paseo = candidates.find((path) => existsSync(path)) ?? "paseo";
console.log(execFileSync(paseo, ["plugin", "ls", PLUGIN_ID, "--json"], { encoding: "utf8" }).trim());
if (dryRun) {
  console.log("Dry run: no active run blocks a reload.");
  process.exit(0);
}
execFileSync(paseo, ["plugin", "reload", PLUGIN_ID], { stdio: "inherit" });
console.log(execFileSync(paseo, ["plugin", "ls", PLUGIN_ID, "--json"], { encoding: "utf8" }).trim());
