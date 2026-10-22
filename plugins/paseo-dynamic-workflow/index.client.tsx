import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RunCard } from "./client/card";
import { setClient } from "./client/hooks";
import { RunsPanel } from "./client/panel";
import { SettingsScreen } from "./client/settings-screen";
import { CARD_KIND, CARD_VERSION, PANEL_ID } from "./shared/ids";
import { CardDataSchema } from "./shared/run-types";

export default function contribute(client: PluginClientContext) {
  setClient(client);
  const removers = [
    client.addTimelineRenderer({ kind: CARD_KIND, version: CARD_VERSION, schema: CardDataSchema, Component: RunCard }),
    client.addWorkspacePanel({ id: PANEL_ID, title: "Dynamic workflows", icon: "Workflow", context: "agent", Component: RunsPanel }),
    client.addCommandCenterItem({
      id: "show-dynamic-workflows",
      title: "Show dynamic workflow runs",
      icon: "Workflow",
      keywords: ["workflow", "workflows", "dynamic", "orchestration", "agents", "fan out"],
      context: "agent",
      onSelect({ openPanel }) {
        openPanel(PANEL_ID);
      },
    }),
    client.addSlashCommand({
      name: "dynamic-workflows",
      description: "Show this agent's dynamic workflow runs",
      argumentHint: "",
      context: "agent",
      onSubmit({ openPanel }) {
        openPanel(PANEL_ID);
      },
    }),
    client.addSettingsScreen({ id: "preferences", title: "Dynamic workflows", icon: "Workflow", Component: SettingsScreen }),
  ];
  return async () => {
    setClient(null);
    for (const remove of removers.reverse()) await remove();
  };
}
