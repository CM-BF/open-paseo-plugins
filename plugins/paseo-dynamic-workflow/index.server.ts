import type { PluginServerContext } from "@getpaseo/plugin/server";
import { contributeServer } from "./server/contribute";

export default function contribute(server: PluginServerContext) {
  return contributeServer(server);
}
