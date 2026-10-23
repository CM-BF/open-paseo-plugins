import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  briefNowRpc,
  cancelFollowupRpc,
  checkNowRpc,
  createFollowupRpc,
  modelsRpc,
  overviewRpc,
  pauseRpc,
  readFileRpc,
  saveConfigRpc,
  setupRpc,
  updateAlertRpc,
  writeFileRpc,
} from "../shared/rpc";
import { systemTimeZone } from "../shared/time";
import type { PaseoApi } from "./access";
import { defaultAssistantHome, paseoHome, statePaths } from "./paths";
import { AideService } from "./service";
import { describeError, log } from "./util";

export interface ContributeOptions {
  stateDir?: string;
}

export function contributeServer(server: PluginServerContext, options: ContributeOptions = {}) {
  const service = new AideService({ paths: statePaths(options.stateDir), paseoHome: paseoHome() });
  void service.start();
  const capture = (context: { paseo: PaseoApi }) => service.access.capture(context.paseo);

  const onRejection = (reason: unknown) => log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
  process.on("unhandledRejection", onRejection);

  server.on("agent.turn_started", (_event, context) => capture(context));
  server.on("agent.turn_ended", (event, context) => {
    capture(context);
    service.onTurnEnded(event.agent.id, event.timeline);
  });
  server.on("agent.permission_requested", async (event, context) => {
    capture(context);
    await service.onPermissionRequested(event.agent.id, event.request, context.paseo);
  });
  server.on("agent.permission_resolved", (_event, context) => {
    capture(context);
    service.outbox.kick();
  });
  server.on("agent.archived", (event, context) => {
    capture(context);
    service.onArchived(event.agent.id);
  });

  server.handle(overviewRpc, async (_input, context) => {
    capture(context);
    return service.overview(context.paseo);
  });
  server.handle(setupRpc, async (input, context) => {
    capture(context);
    return service.setup(input, context.paseo);
  });
  server.handle(saveConfigRpc, async (input, context) => {
    capture(context);
    await service.ready();
    return { config: service.saveConfig(input.config) };
  });
  server.handle(checkNowRpc, async (input, context) => {
    capture(context);
    await service.ready();
    return service.checkNow(input.focus);
  });
  server.handle(briefNowRpc, async (_input, context) => {
    capture(context);
    await service.ready();
    return service.queueBrief(null);
  });
  server.handle(updateAlertRpc, async (input, context) => {
    capture(context);
    await service.ready();
    return service.updateAlert(input.id, input.action, input.until);
  });
  server.handle(createFollowupRpc, async (input, context) => {
    capture(context);
    await service.ready();
    return service.createFollowup(input, "user");
  });
  server.handle(cancelFollowupRpc, async (input, context) => {
    capture(context);
    await service.ready();
    return { followup: service.cancelFollowup(input.id) };
  });
  server.handle(readFileRpc, async (input, context) => {
    capture(context);
    await service.ready();
    return service.readHomeFile(input.name);
  });
  server.handle(writeFileRpc, async (input, context) => {
    capture(context);
    await service.ready();
    return service.writeHomeFile(input.name, input.text);
  });
  server.handle(pauseRpc, async (input, context) => {
    capture(context);
    await service.ready();
    return service.pause(input.until);
  });
  server.handle(modelsRpc, async (_input, context) => {
    capture(context);
    return listModels(context.paseo);
  });

  return async () => {
    process.off("unhandledRejection", onRejection);
    await service.stop().catch((error) => log(`stop: ${describeError(error)}`));
  };
}

/** Models and permission modes of the providers that can run the assistant, for the setup form. */
async function listModels(paseo: PaseoApi) {
  const models: { value: string; label: string }[] = [];
  const modes: Record<string, { value: string; label: string }[]> = {};
  const available = await paseo.providers.listAvailable().catch(() => null);
  const providers = (available?.providers ?? [])
    .filter((provider) => provider.available && ["claude", "codex", "opencode"].includes(provider.provider))
    .map((provider) => provider.provider);
  await Promise.all(
    providers.map(async (provider) => {
      const [listed, listedModes] = await Promise.all([
        paseo.providers.listModels(provider).catch(() => null),
        paseo.providers.listModes(provider).catch(() => null),
      ]);
      for (const model of listed?.models ?? []) models.push({ value: `${provider}/${model.id}`, label: `${provider} · ${model.label ?? model.id}` });
      modes[provider] = (listedModes?.modes ?? []).map((mode) => ({ value: mode.id, label: mode.label ?? mode.id }));
    }),
  );
  return { models, modes, defaultHome: defaultAssistantHome(), timezone: systemTimeZone() };
}
