import type { PluginServerContext } from "@getpaseo/plugin/server";
import { VoiceService } from "./server/service";
import {
  applyConfigRpc,
  checkRpc,
  clearKeyRpc,
  macVoicesRpc,
  revertConfigRpc,
  sampleRpc,
  saveKeyRpc,
  speechPreviewRpc,
  statusRpc,
  voiceSettings,
} from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(voiceSettings);
  const service = new VoiceService();
  let stopped = false;

  const ready = (async () => {
    const current = await settings.read();
    if (current.status === "invalid") console.error("[gemini-voice] settings are invalid, using defaults:", current.error);
    const values = current.status === "ready" ? current.values : voiceSettings.schema.parse({});
    if (!stopped) await service.start(values);
  })().catch((error) => {
    console.error("[gemini-voice] failed to start", error);
  });

  const unsubscribe = settings.subscribe(async (next) => {
    if (next.status !== "ready") return;
    await ready;
    if (!stopped) await service.updateSettings(next.values);
  });

  server.handle(statusRpc, async () => {
    await ready;
    return service.status();
  });
  server.handle(saveKeyRpc, async ({ apiKey }) => service.saveKey(apiKey));
  server.handle(clearKeyRpc, () => service.clearKey());
  server.handle(checkRpc, () => service.check());
  server.handle(sampleRpc, () => service.sample());
  server.handle(speechPreviewRpc, async () => {
    await ready;
    return service.speechPreview();
  });
  server.handle(macVoicesRpc, () => service.macVoices());
  server.handle(applyConfigRpc, async () => {
    await ready;
    return service.applyConfig();
  });
  server.handle(revertConfigRpc, async () => {
    await ready;
    return service.revertConfig();
  });

  return async () => {
    stopped = true;
    unsubscribe();
    await ready;
    await service.stop();
  };
}
