import type { PluginServerContext } from "@getpaseo/plugin/server";
import { contributeServer } from "./server/service";

export default function contribute(server: PluginServerContext) {
  return contributeServer(server);
}
