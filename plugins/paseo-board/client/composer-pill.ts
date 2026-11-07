import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

interface ObservedAgent {
  id: string;
  workspaceId?: string | null;
  archivedAt?: string | null;
}

interface RegisteredPill {
  workspaceId: string;
  registration: PluginButtonRegistration;
}

/** One shortcut per agent, owned by this host's client contribution. */
export function contributeBoardPill(client: PluginClientContext): () => void {
  if (typeof client.addComposerPill !== "function") return () => undefined;

  const lifetime = new AbortController();
  const pills = new Map<string, RegisteredPill>();
  let unsubscribe: (() => void) | undefined;
  let release: (() => void) | undefined;

  function remove(agentId: string): void {
    const pill = pills.get(agentId);
    if (!pill) return;
    // Revoke retained actions before asking the host to remove the button.
    pills.delete(agentId);
    pill.registration.remove();
  }

  function stop(): void {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    unsubscribe?.();
    release?.();
    for (const agentId of pills.keys()) remove(agentId);
  }

  function observe(agent: ObservedAgent): void {
    if (lifetime.signal.aborted) return;
    const existing = pills.get(agent.id);
    if (!agent.workspaceId || agent.archivedAt) {
      remove(agent.id);
      return;
    }
    if (existing?.workspaceId === agent.workspaceId) return;
    remove(agent.id);

    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    let pill: RegisteredPill | undefined;
    const registration = client.addComposerPill({
      id: "board",
      workspaceId,
      agentId,
      button: {
        title: "打开 Board",
        icon: "PanelsTopLeft",
        label: "Board",
        behavior: {
          kind: "action",
          onPress() {
            if (lifetime.signal.aborted || !pill || pills.get(agentId) !== pill) return;
            client.openPanel("agent-board", { workspaceId, agentId });
          },
        },
      },
    });
    if (lifetime.signal.aborted) {
      registration.remove();
      return;
    }
    pill = { workspaceId, registration };
    pills.set(agentId, pill);
  }

  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        void subscription.release().catch(error => {
          console.error("[paseo-board] agent subscription release failed", error);
        });
      };
      if (lifetime.signal.aborted) {
        release();
        return;
      }
      const detach = subscription.subscribe({
        snapshot: ({ entries }) => {
          if (lifetime.signal.aborted) return;
          const present = new Set<string>();
          for (const { agent } of entries) {
            present.add(agent.id);
            observe(agent);
          }
          for (const agentId of pills.keys()) if (!present.has(agentId)) remove(agentId);
        },
        update: message => {
          if (lifetime.signal.aborted || message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else observe(update.agent);
        },
        error: error => {
          if (lifetime.signal.aborted) return;
          console.error("[paseo-board] agent observation failed", error);
          stop();
        },
      });
      // subscribe() may deliver its initial snapshot/error synchronously.
      if (lifetime.signal.aborted) detach();
      else unsubscribe = detach;
    })
    .catch(error => {
      if (lifetime.signal.aborted) return;
      console.error("[paseo-board] agent observation failed", error);
      stop();
    });

  return stop;
}
