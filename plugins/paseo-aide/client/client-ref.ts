import type { PluginClientContext } from "@getpaseo/plugin/client";

/** The client context, for surfaces whose props carry no openSettings or openScreen. */
let current: PluginClientContext | null = null;

export function setClient(client: PluginClientContext | null): void {
  current = client;
}

export function getClient(): PluginClientContext | null {
  return current;
}
