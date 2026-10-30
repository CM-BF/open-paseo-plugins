import { homedir } from "node:os";
import { join } from "node:path";
import { PLUGIN_ID } from "../shared/constants";

/** The daemon exports PASEO_HOME to plugin processes. */
export function paseoHome(): string {
  const value = process.env.PASEO_HOME?.trim();
  return value ? value.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".paseo");
}

/** Everything durable lives here, outside the plugin directory, so updates and reinstalls keep it. */
export function defaultStateDir(): string {
  return join(paseoHome(), PLUGIN_ID);
}

export interface StatePaths {
  root: string;
  memoryDir: string;
  projectsDir: string;
  projectsIndex: string;
  pending: string;
  skillsDir: string;
  archiveDir: string;
  ledger: string;
  ledgerBlobs: string;
  usage: string;
  sessionsDb: string;
  reviews: string;
  bindings: string;
  counters: string;
  socket: string;
  bin: string;
  lib: string;
  mcp: string;
  mcpScript: string;
}

export function statePaths(root: string): StatePaths {
  const memoryDir = join(root, "memory");
  const skillsDir = join(root, "skills");
  const bin = join(root, "bin");
  const lib = join(root, "lib");
  return {
    root,
    memoryDir,
    projectsDir: join(memoryDir, "projects"),
    projectsIndex: join(memoryDir, "projects.json"),
    pending: join(memoryDir, "pending.json"),
    skillsDir,
    archiveDir: join(skillsDir, ".archive"),
    ledger: join(skillsDir, ".ledger.jsonl"),
    ledgerBlobs: join(skillsDir, ".ledger-blobs"),
    usage: join(skillsDir, ".usage.json"),
    sessionsDb: join(root, "sessions.db"),
    reviews: join(root, "reviews.jsonl"),
    bindings: join(root, "bindings.json"),
    counters: join(root, "counters.json"),
    socket: join(root, "bridge.sock"),
    bin,
    lib,
    mcp: join(bin, "learning-loop-mcp"),
    mcpScript: join(lib, "mcp.mjs"),
  };
}
