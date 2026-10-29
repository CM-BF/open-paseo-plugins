import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";

export default function contribute(client: PluginClientContext): PluginCleanup;
