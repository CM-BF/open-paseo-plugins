import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PASEO_HOME?.trim();
  return resolve(configured?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), ".paseo"));
}

/** Only the daemon's listen address is consumed; no authentication/config files are read. */
export function loopbackEndpoint(listen: unknown): { url: string; listen: string } {
  if (typeof listen !== "string") throw new Error("The local daemon has no listen address");
  const match = /^(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$/.exec(listen);
  const port = match ? Number(match[2]) : 0;
  if (!match || port < 1 || port > 65535) throw new Error("Issue triage requires a loopback Paseo daemon address");
  return { url: `ws://${match[1]}:${port}/ws`, listen: `${match[1]}:${port}` };
}

export async function readDaemonEndpoint(home: string): Promise<{ url: string; listen: string }> {
  const raw = await readFile(join(home, "paseo.pid"), "utf8");
  if (raw.length > 64 * 1024) throw new Error("The local daemon descriptor is unexpectedly large");
  let descriptor: unknown;
  try { descriptor = JSON.parse(raw); } catch { throw new Error("The local daemon descriptor is invalid"); }
  if (!descriptor || typeof descriptor !== "object") throw new Error("The local daemon descriptor is invalid");
  return loopbackEndpoint((descriptor as { listen?: unknown }).listen);
}

async function findCli(): Promise<string> {
  const candidates = [
    process.env.PASEO_CLI,
    "/Applications/Paseo.app/Contents/Resources/bin/paseo",
    join(homedir(), "Applications/Paseo.app/Contents/Resources/bin/paseo"),
    ...(process.env.PATH ?? "").split(":").filter(Boolean).map((directory) => join(directory, "paseo")),
  ];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installation. */ }
  }
  throw new Error("Paseo CLI is required to stop the triage worker");
}

/** The public SDK has no cancel operation. This targets the same local daemon only. */
export async function stopDaemonAgent(home: string, agentId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) throw new Error("Invalid triage agent identity");
  const { listen } = await readDaemonEndpoint(home);
  const cli = await findCli();
  try {
    await exec(cli, ["agent", "stop", agentId, "--home", home, "--host", listen, "--json"], {
      timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true,
    });
  } catch {
    // Do not include process environment, stderr, or daemon settings in public errors.
    throw new Error("Paseo could not confirm that the triage worker stopped");
  }
}
