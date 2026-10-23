import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PLUGIN_ID } from "../shared/ids";

/** The daemon exports PASEO_HOME to plugin processes. */
export function paseoHome(): string {
  const value = process.env.PASEO_HOME?.trim();
  return value ? expandHome(value) : join(homedir(), ".paseo");
}

export function expandHome(path: string): string {
  return path.replace(/^~(?=$|\/)/, homedir());
}

/** An absolute home folder from user input; "~/Aide" and relative names resolve under $HOME. */
export function resolveHome(input: string): string {
  const expanded = expandHome(input.trim());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(homedir(), expanded);
}

export function defaultAssistantHome(): string {
  return join(homedir(), "Aide");
}

export interface StatePaths {
  root: string;
  state: string;
  activity: string;
}

/** Durable state for one daemon. Plugin updates and removal leave it in place. */
export function statePaths(root = join(paseoHome(), PLUGIN_ID)): StatePaths {
  return { root, state: join(root, "state.json"), activity: join(root, "activity.jsonl") };
}
