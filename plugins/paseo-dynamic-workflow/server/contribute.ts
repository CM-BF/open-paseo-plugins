import { mkdir } from "node:fs/promises";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getRunRpc, listRunsRpc, serviceStatusRpc, skipCallRpc, stopRunRpc, transcriptRpc } from "../shared/contracts";
import { CHILD_ENV, LABEL_RUN, PLUGIN_VERSION } from "../shared/ids";
import { DEFAULT_PREFERENCES, type Preferences, preferences } from "../shared/settings";
import { ProviderFamilies, transformCreate, transformSessionOpen } from "./agent-setup";
import { BindingStore } from "./bindings";
import { Bridge } from "./bridge";
import { Gate, type PaseoApi } from "./gate";
import { defaultStateDir, statePaths } from "./paths";
import { writeScripts } from "./scripts";
import { transcriptEntries } from "./transcript";
import { WorkflowService } from "./service";
import { describeError, log } from "./util";

export interface ContributeOptions {
  stateDir?: string;
}

export function contributeServer(server: PluginServerContext, options: ContributeOptions = {}) {
  const paths = statePaths(options.stateDir ?? defaultStateDir());
  const gate = new Gate();
  const families = new ProviderFamilies();
  const bindings = new BindingStore(paths.bindings);

  let settings: Preferences = DEFAULT_PREFERENCES;
  const settingsHandle = server.registerSettings(preferences);
  const applySettings = (state: Awaited<ReturnType<typeof settingsHandle.read>>) => {
    settings = state.status === "ready" ? { ...DEFAULT_PREFERENCES, ...state.values } : DEFAULT_PREFERENCES;
    if (state.status !== "ready") log(`settings are invalid (${state.error}); using defaults`);
  };
  const removeSettingsListener = settingsHandle.subscribe(applySettings);
  void settingsHandle.read().then(applySettings, (error) => log(`could not read settings: ${describeError(error)}`));

  const service = new WorkflowService({ paths, gate, settings: () => settings });
  const bridge = new Bridge({ service, bindings });
  const capture = (context: { paseo: PaseoApi }) => {
    const wasReady = gate.ready;
    gate.capture(context.paseo);
    if (!wasReady && gate.ready) service.notifier.kickAll();
  };

  const onRejection = (reason: unknown) =>
    log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  process.on("unhandledRejection", onRejection);

  let startup: "starting" | "ready" | "failed" = "starting";
  const started = (async () => {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await mkdir(paths.runs, { recursive: true, mode: 0o700 });
    await writeScripts(paths);
    await bindings.load();
    await service.recover();
    await bridge.start(paths.socket);
  })().then(
    () => {
      startup = "ready";
      log(`ready (state ${paths.root})`);
    },
    (error) => {
      startup = "failed";
      log(`startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    },
  );

  server.before("agent.create", async ({ request }, context) => {
    try {
      capture(context);
      if (request.env?.[CHILD_ENV] !== undefined) return undefined;
      await started;
      const family = await families.family(context.paseo, request.config.provider);
      // Until the shims exist, new agents get nothing that would point at them.
      const effective = startup === "ready" ? settings : { ...settings, injectIntoNewAgents: false };
      return transformCreate(request, family, effective, paths);
    } catch (error) {
      log(`agent.create: left the agent unchanged: ${describeError(error)}`);
      return undefined;
    }
  });

  server.before("agent.session_open", async ({ request }, context) => {
    try {
      capture(context);
      return await transformSessionOpen(request, bindings);
    } catch (error) {
      log(`agent.session_open: ${describeError(error)}`);
      return undefined;
    }
  });

  server.on("agent.turn_started", (_event, context) => capture(context));
  server.on("agent.turn_ended", (event, context) => {
    capture(context);
    service.notifier.kick(event.agent.id);
  });
  server.on("agent.permission_resolved", (event, context) => {
    capture(context);
    service.notifier.kick(event.agent.id);
  });
  server.on("agent.archived", (event, context) => {
    capture(context);
    service.onAgentArchived(event.agent.id);
  });

  server.handle(listRunsRpc, async (input, context) => {
    capture(context);
    await started;
    return { runs: await service.list(input.agentId, input.limit ?? 50) };
  });
  server.handle(getRunRpc, async (input, context) => {
    capture(context);
    await started;
    return { run: await service.detail(input.runId) };
  });
  server.handle(stopRunRpc, async (input, context) => {
    capture(context);
    await started;
    const message = await service.stop(input.runId, {});
    return { stopped: !message.includes("is not running"), message: message.split("\n")[0] ?? message };
  });
  server.handle(skipCallRpc, (input, context) => {
    capture(context);
    const skipped = service.skip(input.runId, input.callId);
    return { skipped, message: skipped ? "Skipping the agent; its agent() call returns null." : "That agent is not running." };
  });
  server.handle(transcriptRpc, async (input, context) => {
    capture(context);
    const handle = context.paseo.agents.ref(input.agentId);
    const fresh = await handle.refresh();
    // Only workflow children: the panel has no business reading other agents' timelines.
    if (!fresh || !fresh.agent.labels?.[LABEL_RUN]) throw new Error("Not a workflow agent on this host");
    const page = await handle.timeline.refetch({ direction: "tail", limit: 400, projection: "canonical" });
    const items = (page as { entries?: Array<{ item: Parameters<typeof transcriptEntries>[0][number] }> }).entries ?? [];
    return transcriptEntries(items.map((entry) => entry.item));
  });
  server.handle(serviceStatusRpc, async (_input, context) => {
    capture(context);
    await started;
    return {
      version: PLUGIN_VERSION,
      stateDir: paths.root,
      bridgeListening: bridge.listening,
      bridgeError: bridge.error,
      paseoReady: gate.ready,
      activeRuns: service.activeRuns,
      cliPath: paths.cli,
      mcpPath: paths.mcp,
    };
  });

  return async () => {
    process.off("unhandledRejection", onRejection);
    removeSettingsListener();
    await Promise.race([
      (async () => {
        await bridge.close();
        await service.dispose();
        await bindings.idle();
      })(),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  };
}
