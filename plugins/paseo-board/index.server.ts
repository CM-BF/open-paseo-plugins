import type { PluginServerContext } from "@getpaseo/plugin/server";
import { contributeServer } from "./server/contribute";

// Keep a hoisted synchronous default function for the Paseo plugin compiler.
export default function contribute(server: PluginServerContext) {
  return contributeServer(server);
}
