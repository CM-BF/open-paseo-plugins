import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { catalogRpc, configureRpc, diagnosticRpc, intakeRpc, itemActionRpc, overviewRpc, scanRpc } from "./shared/rpc";
import { PLUGIN_ID } from "./shared/types";
import { GitHubClient } from "./server/github";
import { prepareWorkspace, TriageService } from "./server/service";
import { Store } from "./server/store";
import { PaseoWorker } from "./server/worker";

export default function contribute(server: PluginServerContext) {
  const home = resolve(process.env.PASEO_HOME || join(homedir(), ".paseo"));
  const store = new Store(join(home, "plugin-data", PLUGIN_ID));
  const worker = new PaseoWorker(home, prepareWorkspace(store.directory));
  const service = new TriageService(store, new GitHubClient(), worker);
  server.handle(overviewRpc, async () => service.overview());
  server.handle(configureRpc, async ({ config }) => service.configure(config));
  server.handle(scanRpc, async () => service.scanNow());
  server.handle(itemActionRpc, async ({ key, action, note }) => service.action(key, action, note));
  server.handle(intakeRpc, async ({ repo, number }) => service.intake(repo, number));
  server.handle(diagnosticRpc, async ({ action }) => service.diagnostic(action));
  server.handle(catalogRpc, async () => worker.catalog());
  service.start();
  console.log("Owner issue triage 0.1.0 initialized; persistent queue ready.");
  return () => service.close();
}
