import { homedir } from "node:os";
import { join } from "node:path";
import { PLUGIN_ID } from "../shared/contracts";

/** The daemon exports PASEO_HOME to plugin processes. */
export function paseoHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const value = env.PASEO_HOME?.trim();
  if (!value) return join(home, ".paseo");
  return value.replace(/^~(?=$|\/)/, home);
}

export function pluginDataDir(home = paseoHome()): string {
  return join(home, "plugin-data", PLUGIN_ID);
}
