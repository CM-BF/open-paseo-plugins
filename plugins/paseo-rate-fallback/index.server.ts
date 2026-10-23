import type { PluginServerContext, PluginHookContext } from "@getpaseo/plugin/server";
import { dirname, join } from "node:path";
import { createDaemonAdapter } from "./server/daemon";
import { FallbackController, FALLBACK_MODEL, FALLBACK_THINKING } from "./server/controller";
import { StateStore } from "./server/store";
import { ForkStore } from "./server/fork-store";
import { ForkController } from "./server/fork-controller";
import { statusRpc, configureRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const store = new StateStore();
  store.loadSync();
  const forks = new ForkStore(join(dirname(store.path), "forks.json"));
  forks.loadSync();
  const adapter = createDaemonAdapter();
  const controller = new FallbackController(adapter, store);
  let paseo: PluginHookContext["paseo"] | undefined;
  const cross = new ForkController(adapter, forks, () => store.state.enabled, async (id, notice) => {
    if (!paseo) return;
    await paseo.agents.ref(id).timeline.append({
      type: "plugin", id: `provider-transfer-${notice.mainAgentId}-${notice.fallbackAgentId}`,
      kind: "provider-transfer", version: 1, data: { ...notice },
    });
  });
  const run = (promise: Promise<void>) => { void promise.catch((error) => console.error("[rate-fallback]", error)); };
  server.handle(statusRpc, (_input, context) => {
    paseo = context.paseo;
    return {
      enabled: store.state.enabled, fallbackModel: FALLBACK_MODEL, fallbackThinking: FALLBACK_THINKING,
      agents: [...Object.values(store.state.agents).map((entry) => ({
        agentId: entry.agentId, mainModel: entry.main.model ?? "默认模型",
        mainProvider: "codex", fallbackAgentId: null, transferKind: "model" as const,
        mainThinking: entry.main.thinkingOptionId, phase: entry.phase,
        resetAt: entry.resetAt, lastError: entry.lastError,
      })), ...Object.values(forks.state.agents).map((entry) => ({
        agentId: entry.mainAgentId, mainProvider: entry.mainProvider, mainModel: entry.mainModel ?? "默认模型",
        mainThinking: entry.mainThinking, fallbackAgentId: entry.fallbackAgentId, transferKind: "fork" as const,
        phase: entry.phase, resetAt: entry.resetAt, lastError: entry.lastError,
      }))], error: cross.error ?? controller.error,
    };
  });
  server.handle(configureRpc, async ({ enabled }, context) => {
    paseo = context.paseo;
    await controller.configure(enabled);
    await cross.tick();
    return { enabled: store.state.enabled };
  });
  server.on("agent.turn_started", ({ agent }, context) => {
    paseo = context.paseo;
    controller.started(agent.id);
    run(cross.started(agent.id));
  });
  server.on("agent.turn_ended", ({ agent, turnId, outcome }, context) => {
    paseo = context.paseo;
    if (agent.provider === "codex") run(controller.endedTurn(agent.id, turnId, outcome));
    run(cross.endedTurn(agent.id, turnId, outcome));
  });
  server.on("agent.archived", ({ agent }, context) => {
    paseo = context.paseo;
    run(controller.archived(agent.id));
    run(cross.archived(agent.id));
  });
  const timer = setInterval(() => { run(controller.tick()); run(cross.tick()); }, 15_000);
  run(controller.tick());
  run(cross.tick());
  console.log("[rate-fallback] ready; fallback", FALLBACK_MODEL, FALLBACK_THINKING);
  return async () => { clearInterval(timer); await cross.close(); await controller.close(); };
}
