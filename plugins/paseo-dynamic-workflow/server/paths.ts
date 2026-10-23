import { homedir } from "node:os";
import { join } from "node:path";
import { CLI_NAME, MCP_SHIM_NAME, PLUGIN_ID } from "../shared/ids";

/** The daemon exports PASEO_HOME to plugin processes. */
export function paseoHome(): string {
  const value = process.env.PASEO_HOME?.trim();
  return value ? value.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".paseo");
}

/** Everything durable for one daemon. Plugin updates and removal leave it in place. */
export function defaultStateDir(): string {
  return join(paseoHome(), PLUGIN_ID);
}

export interface StatePaths {
  root: string;
  socket: string;
  bindings: string;
  agentAccess: string;
  /** Scale guidance for the MCP shim: { version: 1, workflowSize }. */
  guidance: string;
  outbox: string;
  runs: string;
  bin: string;
  lib: string;
  cli: string;
  mcp: string;
  cliScript: string;
  mcpScript: string;
  reference: string;
  /** Read-only copies of the built-in workflows, so agents can read their args and users can copy them. */
  builtins: string;
}

export function statePaths(root: string): StatePaths {
  const bin = join(root, "bin");
  const lib = join(root, "lib");
  return {
    root,
    socket: join(root, "bridge.sock"),
    bindings: join(root, "bindings.json"),
    agentAccess: join(root, "agent-access.json"),
    guidance: join(root, "guidance.json"),
    outbox: join(root, "outbox.json"),
    runs: join(root, "runs"),
    bin,
    lib,
    cli: join(bin, CLI_NAME),
    mcp: join(bin, MCP_SHIM_NAME),
    cliScript: join(lib, "cli.mjs"),
    mcpScript: join(lib, "mcp.mjs"),
    reference: join(root, "REFERENCE.md"),
    builtins: join(root, "workflows"),
  };
}

export interface RunPaths {
  dir: string;
  run: string;
  journal: string;
  script: string;
  result: string;
}

export function runPaths(paths: StatePaths, runId: string): RunPaths {
  const dir = join(paths.runs, runId);
  return {
    dir,
    run: join(dir, "run.json"),
    journal: join(dir, "journal.jsonl"),
    script: join(dir, "script.js"),
    result: join(dir, "result.json"),
  };
}
