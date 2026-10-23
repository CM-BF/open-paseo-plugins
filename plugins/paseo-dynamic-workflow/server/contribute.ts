import { mkdir } from "node:fs/promises";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getAgentAccessRpc, getCallRpc, getRunRpc, listRunsRpc, serviceStatusRpc, setAgentAccessRpc, skipCallRpc, stopRunRpc, transcriptRpc } from "../shared/contracts";
import { CHILD_ENV, ENABLE_ENV, LABEL_RUN, PLUGIN_VERSION } from "../shared/ids";
import { DEFAULT_PREFERENCES, type Preferences, preferences } from "../shared/settings";
import { AgentAccessStore } from "./agent-access";
import { MCP_FAMILIES, ProviderFamilies, transformCreate, transformSessionOpen } from "./agent-setup";
import { BindingStore } from "./bindings";
import { Bridge } from "./bridge";
import { Gate, type PaseoApi } from "./gate";
import { defaultStateDir, statePaths } from "./paths";
import { writeScripts } from "./scripts";
import { transcriptEntries } from "./transcript";
import { ServiceError, WorkflowService } from "./service";
import { describeError, log, unref, writeAtomically } from "./util";
import { compactRunDetail } from "./views";

export interface ContributeOptions {
  stateDir?: string;
}

export function contributeServer(server: PluginServerContext, options: ContributeOptions = {}) {
  const paths = statePaths(options.stateDir ?? defaultStateDir());
  const gate = new Gate();
  const families = new ProviderFamilies();
  const bindings = new BindingStore(paths.bindings);
  const access = new AgentAccessStore(paths.agentAccess);

  let settings: Preferences = DEFAULT_PREFERENCES;
  let stopping = false;
  const settingsHandle = server.registerSettings(preferences);
  const applySettings = (state: Awaited<ReturnType<typeof settingsHandle.read>>) => {
    settings = state.status === "ready" ? { ...DEFAULT_PREFERENCES, ...state.values } : DEFAULT_PREFERENCES;
    if (state.status !== "ready") log(`settings are invalid (${state.error}); using defaults`);
  };
  // The MCP shim reads the size guideline from disk, so it also works while the bridge restarts.
  let guidanceWritten: string | null = null;
  let guidanceWrites: Promise<void> = Promise.resolve();
  const writeGuidance = () => {
    const size = settings.workflowSize;
    guidanceWrites = guidanceWrites.then(async () => {
      if (stopping || guidanceWritten === size) return;
      await mkdir(paths.root, { recursive: true, mode: 0o700 });
      await writeAtomically(paths.guidance, `${JSON.stringify({ version: 1, workflowSize: size })}\n`, 0o600);
      guidanceWritten = size;
    }).catch((error) => log(`could not write workflow guidance: ${describeError(error)}`));
  };
  const onSettings = (state: Awaited<ReturnType<typeof settingsHandle.read>>) => {
    applySettings(state);
    writeGuidance();
  };
  const removeSettingsListener = settingsHandle.subscribe(onSettings);
  void settingsHandle.read().then(onSettings, (error) => log(`could not read settings: ${describeError(error)}`));

  const service = new WorkflowService({ paths, gate, settings: () => settings });
  const bridge = new Bridge({ service, bindings, access, workflowSize: () => settings.workflowSize });
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
    await access.load();
    if (stopping) return;
    await service.recover();
    if (stopping) return;
    await bridge.start(paths.socket);
  })().then(
    () => {
      if (stopping) return;
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
      await started;
      if (stopping || startup !== "ready") return undefined;
      const family = await families.family(context.paseo, request.config.provider);
      if (stopping || startup !== "ready") return undefined;
      return transformCreate(request, family, settings, paths);
    } catch (error) {
      log(`agent.create: left the agent unchanged: ${describeError(error)}`);
      return undefined;
    }
  });

  server.before("agent.session_open", async ({ request }, context) => {
    try {
      capture(context);
      await started;
      const transformed = await transformSessionOpen(request, bindings);
      if (!stopping && startup === "ready" && request.reason === "create"
        && request.env[ENABLE_ENV] === "1" && request.env[CHILD_ENV] === undefined) {
        await access.set(request.agentId, true).catch((error) => log(`could not enable workflows for ${request.agentId}: ${describeError(error)}`));
      }
      return transformed;
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

  const agentAccess = async (agentId: string, context: { paseo: PaseoApi }) => {
    capture(context);
    await started;
    if (stopping || startup !== "ready") throw new ServiceError("not_ready", "The workflow plugin is not ready.");
    const fresh = await context.paseo.agents.ref(agentId).refresh();
    if (!fresh || fresh.agent.archivedAt) throw new ServiceError("unknown_agent", `Agent ${agentId} was not found on this host.`);
    const providerFamily = await families.family(context.paseo, fresh.agent.provider);
    return {
      enabled: access.enabled(agentId), ultracode: access.ultracode(agentId), cliPath: paths.cli, providerFamily,
      isWorkflowChild: Boolean(fresh.agent.labels?.[LABEL_RUN]),
      hasMcpBinding: providerFamily !== null && MCP_FAMILIES.has(providerFamily) && bindings.hasAgent(agentId),
    };
  };
  server.handle(getAgentAccessRpc, async (input, context) => agentAccess(input.agentId, context));
  server.handle(setAgentAccessRpc, async (input, context) => {
    const current = await agentAccess(input.agentId, context);
    if (input.enabled === undefined && input.ultracode === undefined) throw new ServiceError("invalid_request", "Set enabled, ultracode or both.");
    if ((input.enabled || input.ultracode) && current.isWorkflowChild) throw new ServiceError("recursive_workflow", "Workflow children cannot enable workflow tools; use workflow() in the orchestration script.");
    if (stopping || startup !== "ready") throw new ServiceError("not_ready", "The workflow plugin is stopping.");
    await access.update(input.agentId, {
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.ultracode !== undefined ? { ultracode: input.ultracode } : {}),
    });
    return { ...current, enabled: access.enabled(input.agentId), ultracode: access.ultracode(input.agentId) };
  });

  server.handle(listRunsRpc, async (input, context) => {
    capture(context);
    await started;
    return { runs: await service.list(input.agentId, input.limit ?? 50) };
  });
  server.handle(getRunRpc, async (input, context) => {
    capture(context);
    await started;
    const run = await service.detail(input.runId);
    return { run: run && input.compact ? compactRunDetail(run) : run };
  });
  server.handle(getCallRpc, async (input, context) => {
    capture(context);
    await started;
    const run = await service.detail(input.runId);
    return { call: run?.calls.find((call) => call.callId === input.callId) ?? null };
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
    stopping = true;
    access.dispose();
    service.notifier.pause();
    process.off("unhandledRejection", onRejection);
    removeSettingsListener();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([
      (async () => {
        await started;
        await bridge.close();
        await service.dispose();
        await bindings.idle();
        await access.idle();
        await guidanceWrites;
      })(),
      new Promise((resolve) => { timer = unref(setTimeout(resolve, 5000)) as unknown as ReturnType<typeof setTimeout>; }),
    ]); } finally {
      gate.dispose();
      if (timer) clearTimeout(timer);
    }
  };
}
