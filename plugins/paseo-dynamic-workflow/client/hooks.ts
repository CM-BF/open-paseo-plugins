import { useEffect, useState } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";

/** The current time, refreshed every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The client context, for surfaces (timeline rows) that receive no openPanel. */
let current: PluginClientContext | null = null;

export function setClient(client: PluginClientContext | null): void {
  current = client;
}

export function getClient(): PluginClientContext | null {
  return current;
}

/** Which run the panel shows first, set by the card's Details button. */
const requested = new Map<string, string>();
const listeners = new Set<(agentId: string, runId: string) => void>();

export function requestRun(agentId: string, runId: string): void {
  requested.set(agentId, runId);
  for (const listener of listeners) listener(agentId, runId);
}

/** An open panel follows Details presses on cards of its agent. */
export function onRunRequested(listener: (agentId: string, runId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function takeRequestedRun(agentId: string): string | undefined {
  const runId = requested.get(agentId);
  requested.delete(agentId);
  return runId;
}
