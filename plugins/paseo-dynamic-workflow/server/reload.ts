import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { paseoHome } from "./paths";
import { describeError } from "./util";

const execFileAsync = promisify(execFile);

/** The plugin API has no agent restart; the Paseo CLI does (`paseo agent reload`). */
function paseoCli(): string | null {
  const candidates = [process.env.PASEO_BIN, "/Applications/Paseo.app/Contents/Resources/bin/paseo"].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path)) ?? null;
}

export async function reloadAgent(agentId: string, cli: string | null = paseoCli()): Promise<{ reloaded: boolean; message: string }> {
  if (!cli) return { reloaded: false, message: "The Paseo CLI was not found on this host; reload the agent from its menu." };
  try {
    await execFileAsync(cli, ["agent", "reload", agentId, "--json", "--home", paseoHome()], { timeout: 60_000 });
    return { reloaded: true, message: "Reloaded: the agent's tool list and instructions now match its switches." };
  } catch (error) {
    return { reloaded: false, message: `Could not reload: ${describeError(error).split("\n")[0]}. Reload the agent from its menu.` };
  }
}
